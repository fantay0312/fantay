import type { PaEntity } from '@open-design/contracts';
import { PA_ATTACHMENT_BYTES, type PaImageInput, type PaInboundAttachment } from '../../integrations/pa-channel-transport.js';
import { redactPaCredentials } from '../personal-agent-gateway.js';
import { paAudioFormat } from '../personal-agent-voice.js';
import { extractPaDocument, paDocumentFormat, renderPaPdfScan, type PaDocumentFormat } from './channel-document-text.js';

type DocumentPart = { name: string; excerpt: string };
type PendingPart = { name: string; data: string; format: PaDocumentFormat | 'audio'; pcmSampleRate?: number };
export interface PaChannelAttachments extends PaEntity { channelId: string; images: PaImageInput[]; text: string; pending?: PendingPart[] | undefined }
const textExtensions = /\.(txt|md|csv|tsv|json|jsonl|xml|log|srt|vtt|yaml|yml|html|css|js|ts|py)$/i;

function imageType(data: Buffer): PaImageInput['mediaType'] | null {
  if (data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export function preparePaChannelAttachments(attachments: readonly PaInboundAttachment[]) {
  const images: PaImageInput[] = [];
  const documents: DocumentPart[] = [];
  const pending: PendingPart[] = [];
  let imageBytes = 0;
  for (const attachment of attachments.slice(0, 4)) {
    const bytes = Buffer.from(attachment.data);
    if (!bytes.length || bytes.length > PA_ATTACHMENT_BYTES) continue;
    const mediaType = imageType(bytes);
    if (mediaType && images.length < 2 && imageBytes + bytes.length <= PA_ATTACHMENT_BYTES) {
      imageBytes += bytes.length;
      images.push({ mediaType, data: bytes.toString('base64') });
      continue;
    }
    const rawName = attachment.name?.split(/[\\/]/u).at(-1)?.slice(0, 150) ?? '';
    const format = paDocumentFormat(rawName, bytes) ??
      (attachment.audio || /\.(wav|ogg|opus|webm|mp[34]|m4a|flac|aac|amr|silk)$/i.test(rawName) ||
        ['silk', 'wav', 'ogg', 'flac', 'amr', 'mp3', 'aac'].includes(paAudioFormat(bytes) ?? '') ? 'audio' : null);
    if (format) {
      pending.push({ name: rawName || (format === 'audio' ? '语音消息' : 'attachment.' + format), data: bytes.toString('base64'), format,
        ...(attachment.pcmSampleRate === undefined ? {} : { pcmSampleRate: attachment.pcmSampleRate }) });
      continue;
    }
    if (!textExtensions.test(rawName)) continue;
    try {
      const excerpt = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
      if (excerpt && !excerpt.includes('\0')) documents.push({ name: rawName, excerpt: redactPaCredentials(excerpt.slice(0, 3500)) });
    } catch { /* Binary files aren't passed as text. */ }
  }
  return { images, text: documents.length ? JSON.stringify(documents) : '', ...(pending.length ? { pending } : {}) };
}

export async function resolvePaChannelAttachments(
  attachments: PaChannelAttachments, signal: AbortSignal,
  transcribe: (bytes: Buffer, signal: AbortSignal, pcmSampleRate?: number) => Promise<{ text: string }>,
): Promise<{ text: string; voice: string; images: PaImageInput[]; failures: string[] }> {
  const documents: DocumentPart[] = attachments.text ? JSON.parse(attachments.text) as DocumentPart[] : [];
  const voice: string[] = [], failures: string[] = [];
  const images = [...attachments.images];
  for (const part of attachments.pending ?? []) {
    signal.throwIfAborted();
    const bytes = Buffer.from(part.data, 'base64');
    try {
      if (part.format === 'audio') {
        const { text } = await transcribe(bytes, signal, part.pcmSampleRate);
        if (text.trim()) voice.push(redactPaCredentials(text.trim()));
        else failures.push(part.name);
      } else {
        const excerpt = await extractPaDocument(part.format, bytes, signal);
        if (excerpt) documents.push({ name: part.name, excerpt: redactPaCredentials(excerpt) });
        else if (part.format === 'pdf') {
          const remaining = PA_ATTACHMENT_BYTES - images.reduce((total, image) => total + Buffer.byteLength(image.data, 'base64'), 0);
          const rendered = await renderPaPdfScan(bytes, 2 - images.length, remaining, signal);
          if (rendered.length) {
            documents.push({ name: part.name, excerpt: `无可提取的文字层。已附上前 ${rendered.length} 页的图像。` });
            images.push(...rendered);
          } else failures.push(part.name);
        } else failures.push(part.name);
      }
    } catch { signal.throwIfAborted(); failures.push(part.name); }
  }
  // Keep valid JSON and distribute the remaining context across attachments.
  const perDocument = Math.floor(32000 / Math.max(1, documents.length));
  return {
    text: documents.length ? JSON.stringify(documents.map(doc => ({ ...doc, excerpt: doc.excerpt.slice(0, perDocument) }))) : '',
    voice: voice.join('\n').slice(0, 24000), images, failures,
  };
}
