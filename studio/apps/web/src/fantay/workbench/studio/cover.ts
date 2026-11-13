/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — the video cover, composited in the browser: the generated picture with the big cover
 * words over a bottom shade, or a gradient type-only cover when there is no picture. The same
 * geometry drives the on-sheet preview (Studio.module.css `.poster`), so what you see is what saves.
 * Derived from dsh-media-desk client/cover.js (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { workbenchMediaUrl } from '@open-design/contracts';

const WIDTH = 1920;
const HEIGHT = 1080;
const FONT = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", "Inter", system-ui, sans-serif';

export interface CoverSource {
  /** Stored media src (daemon-relative or https). */
  src?: string | null | undefined;
  text: string;
}

/** Latin letters are about half a CJK glyph wide; long lines step down a size. */
export function coverUnits(text: string): number {
  return [...text].reduce((sum, ch) => sum + (/[\u0000-ɏ]/.test(ch) ? 0.55 : 1), 0);
}
export const coverFontRatio = (text: string) => (coverUnits(text) > 12 ? 112 : 148) / WIDTH;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:\/\//i.test(url)) image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('cover image failed to load'));
    image.src = url;
  });
}

/** CJK breaks per character, Latin per word; an over-long word is split by letters. */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  const tokens = text.match(/[!-ɏ]+\s*|\s+|[^\s]/gu) ?? [];
  for (const token of tokens) {
    if (ctx.measureText((line + token).trimEnd()).width <= maxWidth || !line.trim()) {
      line += token;
      continue;
    }
    lines.push(line.trimEnd());
    line = token.trimStart();
  }
  if (line.trim()) lines.push(line.trimEnd());
  const out: string[] = [];
  for (const row of lines) {
    if (ctx.measureText(row).width <= maxWidth) {
      out.push(row);
      continue;
    }
    let part = '';
    for (const ch of row) {
      if (ctx.measureText(part + ch).width > maxWidth && part) {
        out.push(part);
        part = ch;
      } else {
        part += ch;
      }
    }
    if (part) out.push(part);
  }
  return out.slice(0, maxLines);
}

function drawBackground(ctx: CanvasRenderingContext2D): void {
  const base = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  base.addColorStop(0, '#1a1b3a');
  base.addColorStop(0.55, '#4a2f6b');
  base.addColorStop(1, '#d9745a');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const glow = ctx.createRadialGradient(WIDTH * 0.8, HEIGHT * 0.15, 0, WIDTH * 0.8, HEIGHT * 0.15, WIDTH * 0.6);
  glow.addColorStop(0, 'rgba(255, 196, 150, .55)');
  glow.addColorStop(1, 'rgba(255, 196, 150, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

/** A 1920×1080 cover. A picture that cannot be read (offline, cross-origin) falls back to the gradient. */
export async function composeCover({ src, text }: CoverSource): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  drawBackground(ctx);
  const url = workbenchMediaUrl(src ?? null);
  if (url) {
    try {
      const image = await loadImage(url);
      const scale = Math.max(WIDTH / image.width, HEIGHT / image.height);
      ctx.drawImage(image, (WIDTH - image.width * scale) / 2, (HEIGHT - image.height * scale) / 2, image.width * scale, image.height * scale);
      const shade = ctx.createLinearGradient(0, HEIGHT * 0.35, 0, HEIGHT);
      shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
      shade.addColorStop(1, 'rgba(0, 0, 0, .72)');
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    } catch {
      drawBackground(ctx);
    }
  }
  const words = text.trim();
  if (words) {
    const size = Math.round(coverFontRatio(words) * WIDTH);
    ctx.font = `800 ${size}px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0, 0, 0, .35)';
    ctx.shadowBlur = 24;
    const lines = wrap(ctx, words, WIDTH - 200, 3);
    const lineHeight = size * 1.24;
    lines.forEach((line, index) => {
      ctx.fillText(line, 100, HEIGHT - 100 - (lines.length - 1 - index) * lineHeight);
    });
  }
  return canvas;
}

function isTainted(canvas: HTMLCanvasElement): boolean {
  try {
    canvas.getContext('2d')?.getImageData(0, 0, 1, 1);
    return false;
  } catch {
    return true;
  }
}

/** Compose, and if a cross-origin picture tainted the canvas, recompose type-only so it can be exported. */
async function exportable(source: CoverSource): Promise<HTMLCanvasElement> {
  const canvas = await composeCover(source);
  return isTainted(canvas) ? composeCover({ text: source.text }) : canvas;
}

export async function coverDataUrl(source: CoverSource): Promise<string> {
  return (await exportable(source)).toDataURL('image/jpeg', 0.9);
}

export function coverFileName(name: string, fallback: string): string {
  return `${String(name).replace(/[\\/:*?"<>|\s]+/g, ' ').trim().slice(0, 40) || fallback}.jpg`;
}

export async function downloadCover(source: CoverSource, fileName: string): Promise<void> {
  const url = await coverDataUrl(source);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
}

/** Copy the composited cover to the clipboard as PNG. */
export async function copyCover(source: CoverSource): Promise<void> {
  const canvas = await exportable(source);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
