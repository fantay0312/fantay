// SPDX-License-Identifier: AGPL-3.0-only
// The audio player's scrubber: the whole file as a row of bars, the played part in ink and the rest
// faint. Press anywhere to go there, drag to look for a place, ← and → move five seconds. Before
// the shape is known it is a row of dots on the centre line (the structure, then the content); a
// file with no shape (too long to decode) gets a plain track with the same behaviour.
// Drawn on a canvas: the playhead moves every frame while the file plays, and React is not asked.
'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { formatMediaTime } from './media-time';
import { barsFromPeaks } from './peaks';
import { useScrub } from './use-scrub';
import styles from './Waveform.module.css';

const BAR_WIDTH = 2;
const BAR_GAP = 2;
/** A silent bar is still a dot, so the row reads as a track. */
const BAR_MIN = 2;
const TRACK_HEIGHT = 3;
const THUMB_RADIUS = 5;
const REVEAL_MS = 320;

export interface WaveformProps {
  /** Loudness values 0..1, or null while unknown or when the file has no shape. */
  peaks: Float32Array | null;
  /** True when no shape is coming: the plain track is drawn instead of the placeholder dots. */
  plain: boolean;
  /** True when the shape was known from the start: it is drawn at once, without the entrance. */
  instant: boolean;
  /** Seconds; 0 while unknown. */
  duration: number;
  /** Seconds; the position to draw while the file is not playing. */
  time: number;
  playing: boolean;
  /** The element's position right now, read every frame while playing. */
  liveTime(): number;
  onSeek(time: number): void;
  onSeekBy(seconds: number): void;
  label: string;
}

interface Colors {
  played: string;
  rest: string;
  ahead: string;
}

function easeOutQuint(t: number): number {
  return 1 - (1 - t) ** 5;
}

function roundedBar(path: Path2D, x: number, y: number, width: number, height: number): void {
  const radius = Math.min(width, height) / 2;
  if (typeof path.roundRect === 'function') path.roundRect(x, y, width, height, radius);
  else path.rect(x, y, width, height);
}

export function Waveform(props: WaveformProps): JSX.Element {
  const { peaks, plain, instant, duration, time, playing, onSeek, onSeekBy, label } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [themeTick, setThemeTick] = useState(0);
  const colorsRef = useRef<Colors | null>(null);
  /** 0 → 1 as the bars grow out of the centre line. */
  const revealRef = useRef(instant && peaks ? 1 : 0);
  const [revealing, setRevealing] = useState(false);
  const barsRef = useRef<{ peaks: Float32Array; count: number; bars: Float32Array } | null>(null);

  const scrub = useScrub<HTMLDivElement>({ duration, live: false, onSeek, onSeekBy });

  // Everything the painter reads, kept current without re-creating the frame loop.
  const inputRef = useRef({ ...props, size, hover: scrub.hover, drag: scrub.drag });
  inputRef.current = { ...props, size, hover: scrub.hover, drag: scrub.drag };

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    const input = inputRef.current;
    const { width, height } = input.size;
    if (!canvas || !context || width <= 0 || height <= 0) return;

    const ratio = window.devicePixelRatio || 1;
    const backingWidth = Math.round(width * ratio);
    const backingHeight = Math.round(height * ratio);
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    if (!colorsRef.current) {
      // The tokens reach the canvas through the element's own custom properties.
      const computed = getComputedStyle(canvas);
      colorsRef.current = {
        played: computed.getPropertyValue('--wave-played').trim(),
        rest: computed.getPropertyValue('--wave-rest').trim(),
        ahead: computed.getPropertyValue('--wave-ahead').trim(),
      };
    }
    const colors = colorsRef.current;

    const position = input.duration > 0 ? Math.min(1, Math.max(0, (input.playing ? input.liveTime() : input.time) / input.duration)) : 0;
    const playedX = (input.drag ?? position) * width;
    const hoverX = input.hover === null || input.drag !== null ? null : input.hover * width;
    const middle = height / 2;

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const shape = new Path2D();
    if (input.plain && !input.peaks) {
      roundedBar(shape, 0, middle - TRACK_HEIGHT / 2, width, TRACK_HEIGHT);
    } else {
      const period = BAR_WIDTH + BAR_GAP;
      const count = Math.max(1, Math.floor((width + BAR_GAP) / period));
      const left = (width - (count * period - BAR_GAP)) / 2;
      let bars: Float32Array | null = null;
      if (input.peaks) {
        const cached = barsRef.current;
        if (cached?.peaks === input.peaks && cached.count === count) bars = cached.bars;
        else {
          bars = barsFromPeaks(input.peaks, count);
          barsRef.current = { peaks: input.peaks, count, bars };
        }
      }
      const reveal = easeOutQuint(revealRef.current);
      for (let index = 0; index < count; index += 1) {
        const barHeight = Math.max(BAR_MIN, (bars?.[index] ?? 0) * height * reveal);
        roundedBar(shape, left + index * period, middle - barHeight / 2, BAR_WIDTH, barHeight);
      }
    }

    context.fillStyle = colors.rest;
    context.fill(shape);
    if (hoverX !== null && hoverX > playedX) {
      // Where a click would take the playhead.
      context.save();
      context.beginPath();
      context.rect(playedX, 0, hoverX - playedX, height);
      context.clip();
      context.fillStyle = colors.ahead;
      context.fill(shape);
      context.restore();
    }
    context.save();
    context.beginPath();
    context.rect(0, 0, playedX, height);
    context.clip();
    context.fillStyle = colors.played;
    context.fill(shape);
    context.restore();

    if (input.plain && !input.peaks && input.duration > 0) {
      context.beginPath();
      context.arc(Math.min(width - THUMB_RADIUS, Math.max(THUMB_RADIUS, playedX)), middle, THUMB_RADIUS, 0, Math.PI * 2);
      context.fillStyle = colors.played;
      context.fill();
    }
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setSize({ width: canvas.clientWidth, height: canvas.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // The canvas holds resolved colours, so a theme switch has to be noticed and repainted.
  useEffect(() => {
    const refresh = (): void => {
      colorsRef.current = null;
      setThemeTick((tick) => tick + 1);
    };
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', refresh);
    return () => {
      observer.disconnect();
      scheme.removeEventListener('change', refresh);
    };
  }, []);

  // The bars grow out of the centre line once, when the shape arrives after the player is on screen.
  // A later version of the file swaps its shape in place: the entrance is not played again.
  useEffect(() => {
    if (!peaks || revealRef.current >= 1) return;
    if (instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      revealRef.current = 1;
      paint();
      return;
    }
    setRevealing(true);
    // Resumes where an interrupted entrance stopped.
    const started = performance.now() - revealRef.current * REVEAL_MS;
    let frame = requestAnimationFrame(function step(now) {
      revealRef.current = Math.min(1, Math.max(0, (now - started) / REVEAL_MS));
      paint();
      if (revealRef.current < 1) frame = requestAnimationFrame(step);
      else setRevealing(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [peaks, instant, paint]);

  // While the file plays the playhead is drawn every frame; otherwise only when something changes.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function step() {
      paint();
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, paint]);

  useLayoutEffect(() => {
    paint();
  }, [paint, peaks, plain, duration, time, size, themeTick, scrub.hover, scrub.drag, revealing]);

  const shown = scrub.drag ?? scrub.hover;
  const ready = duration > 0;

  return (
    <div
      className={styles.track}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(Math.min(time, duration))}
      aria-valuetext={`${formatMediaTime(time, duration)} / ${formatMediaTime(duration)}`}
      aria-disabled={!ready || undefined}
      data-ready={ready || undefined}
      data-media-scrubber=""
      {...scrub.handlers}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      {/* Stays mounted so it can fade out; it follows the pointer and names the place under it. */}
      <span
        className={styles.hint}
        data-visible={(ready && shown !== null) || undefined}
        style={{ left: `clamp(18px, ${((shown ?? 0) * 100).toFixed(2)}%, calc(100% - 18px))` }}
        aria-hidden="true"
      >
        {formatMediaTime((shown ?? 0) * duration, duration)}
      </span>
    </div>
  );
}
