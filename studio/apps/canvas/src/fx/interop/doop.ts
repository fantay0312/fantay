// SPDX-License-Identifier: Apache-2.0
/**
 * Doop canvas JSON (`{ frames: [{ html, x, y, width, height, name }] }`) → one HTML page with the
 * frames absolutely positioned, which then converts like any page (06 §8.1). Format adapter
 * only; no Doop code is used.
 */
import { DesignBridgeFailure } from '@open-design/contracts/runtime/design-editor-bridge';

import { safeHTMLFragment } from './html';

export const DOOP_MAX_FRAMES = 100;

interface DoopFrame {
  html: string;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function isDoopCanvas(value: unknown): value is { frames: DoopFrame[] } {
  if (!value || typeof value !== 'object') return false;
  const frames = (value as { frames?: unknown }).frames;
  return (
    Array.isArray(frames) &&
    frames.length > 0 &&
    frames.length <= DOOP_MAX_FRAMES &&
    frames.every((frame) => !!frame && typeof frame === 'object' && typeof (frame as DoopFrame).html === 'string')
  );
}

export function doopCanvasToHtml(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DesignBridgeFailure('PARSE_FAILED', 'The file is not valid JSON');
  }
  if (!isDoopCanvas(parsed)) throw new DesignBridgeFailure('PARSE_FAILED', 'The JSON has no canvas frames');
  const sections = parsed.frames.map((frame) => {
    const left = finite(frame.x, 0);
    const top = finite(frame.y, 0);
    const width = Math.max(1, finite(frame.width, 800));
    const height = Math.max(1, finite(frame.height, 600));
    return `<section style="position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;overflow:hidden">${safeHTMLFragment(frame.html)}</section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;position:relative">${sections.join('')}</body></html>`;
}
