/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — capture helpers shared by the ⚡ dialog, the canvas composer and page-wide
 * paste/drop: upload files (with size, duration, poster and dominant colours measured in the
 * browser), capture links, add notes and quotes. Every write goes through `workbench.ops` or the
 * capture route, so receipts and 撤销 behave like any other edit.
 */
import type { WorkbenchMedia, WorkbenchOp } from '@open-design/contracts';
import { workbenchApi } from '../api';
import { reportError, workbench } from '../store';
import { dismissToast, toast } from '../../ui/toast';
import { titleFromText } from './library';

export type Say = (zh: string, en: string) => string;

export interface CaptureTarget { spaceId?: string | null; tags?: string[] }

/** dataTransfer type for cards dragged inside the page (rail drop targets read it). */
export const ITEM_DRAG_TYPE = 'application/x-fantay-workbench-items';

export const FILE_ACCEPT = 'image/*,video/*,audio/*,application/pdf,.pdf';

export function acceptable(file: File): boolean {
  return /^(image|video|audio)\//.test(file.type) || file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function isInternalDrag(dt: DataTransfer | null): boolean {
  return Boolean(dt && [...dt.types].includes(ITEM_DRAG_TYPE));
}

export function draggedIds(dt: DataTransfer | null): string[] {
  if (!dt) return [];
  try {
    const value = JSON.parse(dt.getData(ITEM_DRAG_TYPE) || '[]') as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,，、#\s]+/).map(tag => tag.trim()).filter(Boolean))];
}

// ── Measuring media in the browser ──────────────────────────────────

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
  Promise.race([promise, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

const toHex = (r: number, g: number, b: number) => `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Dominant colours (most prominent first) from a downscaled frame: 3-bit buckets, near ones merged. */
export function dominantColors(source: CanvasImageSource, width: number, height: number, count = 5): string[] {
  if (!width || !height) return [];
  const side = 48;
  const scale = Math.min(1, side / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  try {
    ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) < 128) continue;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n += 1; bucket.r += r; bucket.g += g; bucket.b += b;
      buckets.set(key, bucket);
    }
    const ranked = [...buckets.values()].sort((a, b) => b.n - a.n).map(v => [v.r / v.n, v.g / v.n, v.b / v.n] as const);
    const picked: Array<readonly [number, number, number]> = [];
    for (const c of ranked) {
      if (picked.every(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > 42)) picked.push(c);
      if (picked.length >= count) break;
    }
    return picked.map(c => toHex(c[0], c[1], c[2]));
  } catch {
    return [];
  }
}

interface Probe { media: Partial<WorkbenchMedia>; poster?: Blob }

function probeImage(url: string): Promise<Probe> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ media: { w: img.naturalWidth, h: img.naturalHeight, colors: dominantColors(img, img.naturalWidth, img.naturalHeight) } });
    img.onerror = () => resolve({ media: {} });
    img.src = url;
  });
}

function probeVideo(url: string): Promise<Probe> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let media: Partial<WorkbenchMedia> = {};
    video.onloadedmetadata = () => {
      media = { w: video.videoWidth, h: video.videoHeight, ...(Number.isFinite(video.duration) ? { durationSec: Math.round(video.duration * 10) / 10 } : {}) };
      video.currentTime = Math.min(0.6, (Number.isFinite(video.duration) ? video.duration : 1) / 3);
    };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx || !canvas.width) { resolve({ media }); return; }
      ctx.drawImage(video, 0, 0);
      media.colors = dominantColors(video, video.videoWidth, video.videoHeight);
      canvas.toBlob(blob => resolve(blob ? { media, poster: blob } : { media }), 'image/jpeg', 0.84);
    };
    video.onerror = () => resolve({ media });
    video.src = url;
  });
}

function probeAudio(url: string): Promise<Probe> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => resolve({ media: Number.isFinite(audio.duration) ? { durationSec: Math.round(audio.duration * 10) / 10 } : {} });
    audio.onerror = () => resolve({ media: {} });
    audio.src = url;
  });
}

export async function probeFile(file: Blob): Promise<Probe> {
  const url = URL.createObjectURL(file);
  try {
    const type = file.type;
    const run = type.startsWith('image/') ? probeImage(url) : type.startsWith('video/') ? probeVideo(url) : type.startsWith('audio/') ? probeAudio(url) : Promise.resolve<Probe>({ media: {} });
    return await withTimeout(run, 8000, { media: {} });
  } finally {
    // Give the decoders a moment before the URL goes away.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function fileTitle(file: File, L: Say): string {
  const base = file.name.replace(/\.[^.]+$/, '').trim();
  if (!base || /^(image|blob|untitled|clipboard)$/i.test(base)) {
    if (file.type.startsWith('image/')) return L('粘贴的图片', 'Pasted image');
    if (file.type.startsWith('audio/')) return L('语音', 'Voice note');
    return L('未命名文件', 'Untitled file');
  }
  return base.slice(0, 80);
}

// ── Captures ────────────────────────────────────────────────────────

/** Upload files and add one item each. Resolves true when every item landed. */
export async function captureFiles(files: File[], target: CaptureTarget, L: Say, extra: { title?: string; body?: string } = {}): Promise<boolean> {
  const usable = files.filter(acceptable);
  const skipped = files.length - usable.length;
  if (skipped) toast({ title: L(`有 ${skipped} 个文件不支持`, `${skipped} file${skipped > 1 ? 's are' : ' is'} not supported`), description: L('支持图片、视频、PDF 和音频。', 'Images, videos, PDFs and audio are supported.'), tone: 'danger' });
  if (!usable.length) return false;
  const progressId = `wb-capture-${Date.now()}`;
  const ops: WorkbenchOp[] = [];
  try {
    for (const [index, file] of usable.entries()) {
      toast({
        id: progressId,
        title: usable.length > 1 ? L(`正在上传 ${index + 1}/${usable.length}`, `Uploading ${index + 1} of ${usable.length}`) : L('正在上传…', 'Uploading…'),
        description: file.name,
        busy: true,
        duration: 0,
      });
      const [upload, probe] = await Promise.all([workbenchApi.upload(file), probeFile(file)]);
      let poster: string | undefined;
      if (probe.poster) {
        try { poster = (await workbenchApi.upload(probe.poster)).src; } catch { poster = undefined; }
      }
      const media: WorkbenchMedia = { src: upload.src, mime: upload.mime, bytes: upload.bytes, ...probe.media, ...(poster ? { poster } : {}) };
      ops.push({
        op: 'add_item',
        kind: upload.kind,
        title: usable.length === 1 && extra.title ? extra.title : fileTitle(file, L),
        body: usable.length === 1 && extra.body ? extra.body : '',
        tags: target.tags ?? [],
        ...(target.spaceId ? { spaceId: target.spaceId } : {}),
        media,
      });
    }
  } catch (error) {
    dismissToast(progressId);
    reportError(error, L('上传失败', 'Upload failed'));
    if (!ops.length) return false;
  }
  dismissToast(progressId);
  const response = await workbench.ops(ops, { label: L('收进灵感', 'Capture') });
  return Boolean(response && !response.errors.length && ops.length === usable.length);
}

/** Save a link (the daemon reads title, summary and cover). Resolves true when it was saved. */
export async function captureLink(url: string, target: CaptureTarget & { title?: string; note?: string }, L: Say): Promise<boolean> {
  try {
    const response = await workbenchApi.captureUrl({
      url: url.trim(),
      ...(target.title ? { title: target.title } : {}),
      ...(target.note ? { note: target.note } : {}),
      ...(target.tags?.length ? { tags: target.tags } : {}),
      ...(target.spaceId ? { spaceId: target.spaceId } : {}),
    });
    workbench.setState(response.state);
    if (response.errors.length) {
      toast({ title: response.errors[0]!, tone: 'danger' });
      return false;
    }
    toast({
      title: response.receipts[0]?.text ?? L('链接已收进收件箱', 'Link saved to Inbox'),
      action: { label: L('撤销', 'Undo'), onClick: () => { void workbench.undo(); } },
    });
    return true;
  } catch (error) {
    reportError(error, L('链接没有存上', 'Could not save the link'));
    return false;
  }
}

/** Add a note or a quote. */
export async function captureText(kind: 'note' | 'quote', text: string, target: CaptureTarget & { source?: string }, L: Say): Promise<boolean> {
  const value = text.trim();
  if (!value) return false;
  const title = kind === 'quote' ? value : titleFromText(value, 40);
  const op: WorkbenchOp = {
    op: 'add_item',
    kind,
    title,
    body: kind === 'quote' || value === title ? '' : value,
    tags: target.tags ?? [],
    ...(target.spaceId ? { spaceId: target.spaceId } : {}),
    ...(target.source?.trim() ? { source: target.source.trim() } : {}),
  };
  const response = await workbench.ops([op], { label: L('记下灵感', 'Capture') });
  return Boolean(response && !response.errors.length);
}

/** A MediaRecorder mime the browser can produce, preferring Opus in WebM. */
export function recorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}
