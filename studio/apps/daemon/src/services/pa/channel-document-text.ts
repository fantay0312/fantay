import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SaxesParser } from 'saxes';
import { fromBufferPromise } from 'yauzl';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PA_ATTACHMENT_BYTES, type PaImageInput } from '../../integrations/pa-channel-transport.js';

export type PaDocumentFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx';
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_XML_BYTES = 24 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;
const MAX_PDF_PAGES = 150;
const MAX_EXCERPT = 16_000;

export function paDocumentFormat(name: string, bytes: Buffer): PaDocumentFormat | null {
  if (bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
  const extension = /\.(docx|xlsx|pptx)$/i.exec(name)?.[1]?.toLowerCase();
  return extension && bytes.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')) ? extension as PaDocumentFormat : null;
}

type XmlEvents = {
  open?(name: string, attrs: Record<string, string>): void;
  close?(name: string): void;
  text?(value: string): void;
};
const localName = (name: string) => name.split(':').at(-1)!;
function visitXml(xml: string, events: XmlEvents): void {
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Error('Office XML cannot contain a document type'); });
  parser.on('opentag', tag => events.open?.(localName(tag.name), tag.attributes));
  parser.on('closetag', tag => events.close?.(localName(tag.name)));
  parser.on('text', value => events.text?.(value));
  parser.write(xml).close();
}

const OFFICE_PARTS = /^(?:word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml|ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml)|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml))$/u;

async function readOfficeParts(bytes: Buffer, signal: AbortSignal): Promise<Map<string, string>> {
  const zip = await fromBufferPromise(bytes, { validateEntrySizes: true, strictFileNames: true });
  const parts = new Map<string, string>();
  let total = 0;
  try {
    if (zip.entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('Office archive has too many entries');
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      if (!OFFICE_PARTS.test(entry.fileName)) continue;
      if (parts.has(entry.fileName) || entry.uncompressedSize > MAX_PART_BYTES || total + entry.uncompressedSize > MAX_XML_BYTES)
        throw new Error('Office XML exceeds the extraction limit');
      const stream = await zip.openReadStreamPromise(entry);
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const chunks: string[] = [];
      for await (const chunk of stream) {
        signal.throwIfAborted();
        total += chunk.length;
        if (total > MAX_XML_BYTES) throw new Error('Office XML exceeds the extraction limit');
        chunks.push(decoder.decode(chunk, { stream: true }));
      }
      chunks.push(decoder.decode());
      parts.set(entry.fileName, chunks.join(''));
    }
    return parts;
  } finally { zip.close(); }
}

/** Text runs become paragraphs. Tabs, explicit breaks and table cells retain their boundaries. */
function paragraphText(xml: string): string {
  const text: string[] = [];
  let inText = false;
  visitXml(xml, {
    open(name) {
      if (name === 't') inText = true;
      if (name === 'tab') text.push('\t');
      if (name === 'br' || name === 'cr') text.push('\n');
    },
    close(name) {
      if (name === 't') inText = false;
      if (name === 'p' || name === 'tr') text.push('\n');
      if (name === 'tc') text.push('\t');
    },
    text(value) { if (inText) text.push(value); },
  });
  return text.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function relationships(xml: string | undefined, directory: string, allowed: RegExp): Map<string, string> {
  const entries = new Map<string, string>();
  if (xml) visitXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship' || !attrs.Id || !attrs.Target || attrs.TargetMode?.toLowerCase() === 'external') return;
      const target = path.posix.resolve('/' + directory, attrs.Target).slice(1);
      if (allowed.test(target)) entries.set(attrs.Id, target);
    },
  });
  return entries;
}

function workbookStrings(xml: string | undefined): string[] {
  const strings: string[] = [];
  let active = false, entry = '';
  if (xml) visitXml(xml, {
    open(name) { if (name === 'si') entry = ''; if (name === 't') active = true; },
    close(name) { if (name === 't') active = false; if (name === 'si') strings.push(entry); },
    text(value) { if (active) entry += value; },
  });
  return strings;
}

function worksheetText(xml: string, strings: string[]): string {
  const rows: string[] = [];
  let cells: string[] = [], ref = '', type = '', value = '', formula = '', reading: 'v' | 't' | 'f' | null = null;
  visitXml(xml, {
    open(name, attrs) {
      if (name === 'row') cells = [];
      if (name === 'c') { ref = attrs.r ?? ''; type = attrs.t ?? ''; value = ''; formula = ''; }
      if (name === 'v' || name === 't' || name === 'f') reading = name;
    },
    close(name) {
      if (name === reading) reading = null;
      if (name === 'c') {
        const cell = type === 's' ? strings[Number(value)] ?? '' : type === 'b' ? (value === '1' ? 'TRUE' : 'FALSE') : value || (formula ? '=' + formula : '');
        if (cell.trim()) cells.push(ref ? `${ref}: ${cell}` : cell);
      }
      if (name === 'row' && cells.length) rows.push(cells.join(' | '));
    },
    text(text) { if (reading === 'f') formula += text; else if (reading) value += text; },
  });
  return rows.join('\n');
}

function officeText(format: Exclude<PaDocumentFormat, 'pdf'>, parts: Map<string, string>): string {
  if (format === 'docx') {
    if (!parts.has('word/document.xml')) return '';
    return ['word/document.xml', ...[...parts.keys()].filter(key => /^word\/(?!document\.xml)/.test(key)).sort()]
      .map(key => paragraphText(parts.get(key)!)).filter(Boolean).join('\n\n');
  }
  const entries: Array<{ path: string; label?: string }> = [];
  const presentation = format === 'pptx';
  const section = presentation ? 'ppt' : 'xl';
  const packageName = presentation ? 'presentation' : 'workbook';
  if (!parts.has(`${section}/${packageName}.xml`)) return '';
  const allowed = presentation ? /^ppt\/slides\/slide\d+\.xml$/ : /^xl\/worksheets\/sheet\d+\.xml$/;
  const links = relationships(parts.get(`${section}/_rels/${packageName}.xml.rels`), section, allowed);
  visitXml(parts.get(`${section}/${packageName}.xml`)!, {
    open(name, attrs) {
      if (name !== (presentation ? 'sldId' : 'sheet')) return;
      const relationshipId = Object.entries(attrs).find(([key]) => key.includes(':') && localName(key) === 'id')?.[1];
      const target = relationshipId ? links.get(relationshipId) : undefined;
      if (target && parts.has(target)) entries.push({ path: target, ...(attrs.name ? { label: attrs.name } : {}) });
    },
  });
  if (!entries.length) entries.push(...[...parts.keys()].filter(key => allowed.test(key))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0])).map(key => ({ path: key })));
  const strings = workbookStrings(parts.get('xl/sharedStrings.xml'));
  return entries.map((entry, index) => {
    const text = presentation ? paragraphText(parts.get(entry.path)!) : worksheetText(parts.get(entry.path)!, strings);
    return text ? `[${entry.label ?? (presentation ? 'Slide ' : 'Sheet ') + (index + 1)}]\n${text}` : '';
  }).filter(Boolean).join('\n\n');
}

async function withPdf<T>(data: Buffer, signal: AbortSignal, run: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
  signal.throwIfAborted();
  const loading = getDocument({
    data: new Uint8Array(data), useSystemFonts: false, disableFontFace: true, useWorkerFetch: false,
    cMapUrl: path.join(root, 'cmaps') + path.sep, cMapPacked: true,
    standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep, useWasm: false, verbosity: 0, maxImageSize: 16_000_000,
  });
  const abort = () => { void loading.destroy().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await run(await loading.promise);
  } finally {
    signal.removeEventListener('abort', abort);
    await loading.destroy().catch(() => {});
  }
}

function pdfText(data: Buffer, signal: AbortSignal): Promise<string> {
  return withPdf(data, signal, async pdf => {
    const pages: string[] = [];
    let size = 0;
    for (let number = 1; number <= Math.min(pdf.numPages, MAX_PDF_PAGES) && size < MAX_EXCERPT; number++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const reader = page.streamTextContent().getReader();
      let text = '';
      try {
        while (size + text.length < MAX_EXCERPT) {
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
          }
        }
      } finally { await reader.cancel().catch(() => {}); page.cleanup(); }
      if (text.trim()) {
        const part = `[Page ${number}]\n${text.trim()}`;
        pages.push(part);
        size += part.length;
      }
    }
    return pages.join('\n\n');
  });
}

export function renderPaPdfScan(bytes: Buffer, pages: number, byteLimit: number, signal: AbortSignal): Promise<PaImageInput[]> {
  if (pages <= 0 || byteLimit <= 0) return Promise.resolve([]);
  return withPdf(bytes, signal, async pdf => {
    type RenderOptions = Parameters<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>[0];
    type Surface = { canvas: NonNullable<RenderOptions['canvas']> & { toBuffer(format: 'image/png'): Buffer }; context: NonNullable<RenderOptions['canvasContext']> };
    const factory = pdf.canvasFactory as { create(w: number, h: number): Surface; destroy(surface: Surface): void };
    const images: PaImageInput[] = [];
    let remaining = Math.min(byteLimit, PA_ATTACHMENT_BYTES);
    for (let number = 1; number <= Math.min(pdf.numPages, pages, 2); number++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      const size = Math.max(natural.width, natural.height);
      if (!Number.isFinite(size) || size <= 0) continue;
      const viewport = page.getViewport({ scale: Math.min(2, 1300 / size) });
      const surface = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const paint = page.render({ canvas: surface.canvas, canvasContext: surface.context, viewport, annotationMode: 0 });
      const cancel = () => paint.cancel();
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await paint.promise;
        const png = surface.canvas.toBuffer('image/png');
        if (png.length > remaining) break;
        remaining -= png.length;
        images.push({ mediaType: 'image/png', data: png.toString('base64') });
      } finally {
        signal.removeEventListener('abort', cancel);
        factory.destroy(surface);
        page.cleanup();
      }
    }
    return images;
  });
}

export async function extractPaDocument(format: PaDocumentFormat, bytes: Buffer, signal: AbortSignal): Promise<string> {
  const text = format === 'pdf' ? await pdfText(bytes, signal) : officeText(format, await readOfficeParts(bytes, signal));
  return text.replace(/\0/g, '').slice(0, MAX_EXCERPT).trim();
}
