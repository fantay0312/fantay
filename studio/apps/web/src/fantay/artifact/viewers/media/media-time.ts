// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/AudioPreview.tsx @ c5e6b24f (MIT): the m:ss clock
// (`audioTime`). Changed here: hours, a reference so the elapsed time is as wide as the duration, and
// the other small sums both players share (speed labels, where to resume, how a film fits its stage).
// Pure: no React, no DOM.

/** The speeds the menu offers. */
export const PLAYBACK_RATES = [0.5, 1, 1.25, 1.5, 2] as const;
/** What ← and → move by. */
export const SEEK_STEP_SECONDS = 5;
/** What ↑ and ↓ change the volume by. */
export const VOLUME_STEP = 0.1;

/**
 * "3:42", or "1:03:42" from an hour on. `reference` is the longest time shown next to this one
 * (the duration), so "0:05:10 / 1:03:42" keeps one shape while the file plays.
 */
export function formatMediaTime(seconds: number, reference = seconds): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const withHours = (Number.isFinite(reference) ? reference : 0) >= 3600 || safe >= 3600;
  const s = String(safe % 60).padStart(2, '0');
  if (!withHours) return `${Math.floor(safe / 60)}:${s}`;
  const m = String(Math.floor(safe / 60) % 60).padStart(2, '0');
  return `${Math.floor(safe / 3600)}:${m}:${s}`;
}

/** "1×", "1.25×", "0.5×". */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

/** "44.1 kHz", "48 kHz", "22.05 kHz". */
export function formatSampleRate(hertz: number): string {
  return `${Number((hertz / 1000).toFixed(2))} kHz`;
}

export function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time) || time < 0) return 0;
  return Number.isFinite(duration) && duration > 0 ? Math.min(time, duration) : time;
}

/**
 * Where to put the playhead when a file is opened again. A position within the last half second is
 * "finished": the file starts over rather than opening on its final frame.
 */
export function resumeTime(saved: number | undefined, duration: number): number {
  if (saved === undefined || !Number.isFinite(saved) || saved <= 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return saved >= duration - 0.5 ? 0 : saved;
}

/** The speed after `rate` in the list (`direction` 1) or before it (-1), staying inside the list. */
export function nextRate(rate: number, direction: 1 | -1): number {
  const rates: readonly number[] = PLAYBACK_RATES;
  const index = rates.findIndex((candidate) => Math.abs(candidate - rate) < 1e-3);
  if (index < 0) return 1;
  return rates[Math.min(rates.length - 1, Math.max(0, index + direction))] ?? 1;
}

export interface MediaSize {
  width: number;
  height: number;
}

/**
 * The largest size at the film's own proportions that fits the stage with `pad` around it. Unlike
 * a picture, a film is scaled up as well as down: it is watched, not inspected.
 */
export function fitMedia(natural: MediaSize, viewport: MediaSize, pad: number): MediaSize {
  if (natural.width <= 0 || natural.height <= 0) return { width: 0, height: 0 };
  const availableWidth = Math.max(1, viewport.width - pad * 2);
  const availableHeight = Math.max(1, viewport.height - pad * 2);
  const scale = Math.min(availableWidth / natural.width, availableHeight / natural.height);
  return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
}

/** The end of the loaded stretch the playhead is in; `time` itself when nothing around it is loaded. */
export function bufferedEnd(ranges: ReadonlyArray<{ start: number; end: number }>, time: number): number {
  let end = time;
  for (const range of ranges) {
    // Half a second of slack: the playhead can sit a frame ahead of the range that holds it.
    if (range.start <= time + 0.5 && range.end > end) end = range.end;
  }
  return end;
}

/** A position along a track, 0 at its left edge and 1 at its right, from a pointer's x. */
export function fractionAt(clientX: number, left: number, width: number): number {
  if (width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}
