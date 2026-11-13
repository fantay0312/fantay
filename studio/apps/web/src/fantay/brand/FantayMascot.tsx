'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The Fantay mascot as a living character: a small spirit wearing a square of magic cloth, blue outside and coral
// inside. The cloth is a real surface in three dimensions (mascot-sheet.ts), simulated as cloth (mascot-cloth.ts),
// given its life by mascot-flight.ts and drawn with both of its sides and the motes of light it sheds
// (mascot-stage.ts). Everything quick lives in the eyes (mascot-gaze.ts). This file only puts a canvas on the page and
// wires the pointer to it: the drawing runs in one loop shared by every mascot, stops off screen and never touches
// React between events.
//
// The sprite artwork is always there underneath. It is what shows wherever WebGL is not to be had, and under
// prefers-reduced-motion, where there is no loop and no listener at all. It is a different drawing of the character
// from the living one, so it is kept out of sight while the stage loads: the two are never seen swapping.
import { useEffect, useRef, useState } from 'react';

import { cn } from '../ui/cn';
import { ART_TRANSFORM, BACK_PATH, EYES, EYE_TILT, FRONT_PATH, SMALL_MAX } from './mascot-art';
import { clickFlight, flipFlight, pulseFlight, stirFlight, type Flight, type FlightInput } from './mascot-flight';
import { FACE, HEAD } from './mascot-sheet';
import type { StageActor } from './mascot-stage';
import styles from './FantayMascot.module.css';

export type FantayMascotMood = 'idle' | 'working';

export interface FantayMascotProps {
  /** px; omitted = fills its box. */
  size?: number;
  mood?: FantayMascotMood;
  /** The eyes follow the pointer, and it turns a little to face it. */
  tracking?: boolean;
  /** Increment to lift it once. */
  pulse?: number;
  /** Increment to send it head over heels in the air. */
  flip?: number;
  /** Draws a soft shadow beneath the character, for hero sizes. */
  grounded?: boolean;
  /** Floats in once. */
  appear?: boolean;
  /** Its cloth is stirred by the pointer, it waves at a pointer that comes close, and gives itself up to one that
   *  strokes it. It lifts on a click, turns right round on two quick ones and goes head over heels on three. */
  interactive?: boolean;
  className?: string;
}

/** The original folded-paper artwork, used by the illustrated changelog. */
export const MASCOT_ART = {
  front: FRONT_PATH,
  back: BACK_PATH,
  eyes: EYES,
  eyeTilt: EYE_TILT,
  /** Fits the artwork inside a 0 0 1024 1024 viewBox. */
  transform: ART_TRANSFORM,
} as const;

/** The eyes' centre inside the mascot's box, as shares of its width and height: where the living body has them. */
const EYE_ORIGIN = { x: (1 + HEAD.x) / 2, y: (1 - HEAD.y + FACE.low) / 2 };
/** Pointer distance, in box widths, at which the eyes are looking as far as they can. */
const EYE_RANGE = 1;
/** A pointer inside this many box widths moves the air around the body, and is waved at. */
const AIR_RANGE = 1.15;
/** Seconds a still pointer keeps its attention. */
const LOOK_HOLD = 2.4;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** Whether this page can draw the living mascot at all. */
function canLive(): boolean {
  return typeof WebGL2RenderingContext !== 'undefined' && typeof IntersectionObserver !== 'undefined';
}

let stageLoading: Promise<typeof import('./mascot-stage')> | null = null;
/** The stage brings three.js with it, so it is fetched once, the first time a mascot goes live. */
function loadStage(): Promise<typeof import('./mascot-stage')> {
  stageLoading ??= import('./mascot-stage');
  return stageLoading;
}

/** Where focus would draw its eye, or null for anything it does not care about. Exported for the tests. */
export function focusPoint(target: EventTarget | null): { x: number; y: number } | null {
  const element = target as HTMLElement | null;
  if (!element?.matches?.('input, textarea, [contenteditable="true"]') && !element?.closest?.('[data-testid="home-hero-composer-card"]')) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 28) };
}

/** The same star-hat sprite used by the startup splash, with a cut for small icons. */
function Artwork({ small, className, size, testId }: { small: boolean; className?: string; size?: number; testId?: string }) {
  return (
    <img
      src={small ? '/fantay-sprite-small.svg' : '/fantay-sprite.svg'}
      className={className}
      style={size === undefined ? undefined : { width: size, height: size }}
      data-testid={testId}
      alt=""
      aria-hidden
      draggable={false}
    />
  );
}

export function FantayMascot({
  size,
  mood = 'idle',
  tracking = false,
  pulse = 0,
  flip = 0,
  grounded = false,
  appear = false,
  interactive = false,
  className,
}: FantayMascotProps) {
  const [internalPulse, setInternalPulse] = useState(0);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shadowRef = useRef<HTMLSpanElement | null>(null);
  const actorRef = useRef<StageActor | null>(null);
  /** What was asked of it before its stage had loaded. */
  const owedRef = useRef({ pulse: false, flip: false });
  const pointerRef = useRef({ x: 0, y: 0, fresh: false, moved: false, known: false });
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const appearRef = useRef(appear);
  const trackingRef = useRef(tracking);
  trackingRef.current = tracking;
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const small = size !== undefined && size <= SMALL_MAX;

  // Going live. The canvas takes over from the artwork once its first picture is drawn, and hands back if it ever
  // cannot be drawn. It is stepped only while it is on screen.
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas || reducedMotion() || !canLive()) return undefined;
    const pointer = pointerRef.current;
    let actor: StageActor | null = null;
    let observer: IntersectionObserver | null = null;
    let cancelled = false;
    let lastX = 0;
    let lastY = 0;
    let stillFor = LOOK_HOLD;
    let ground = '';
    let groundX = '';
    // The mark must not be seen standing in place before the living mascot takes over from it.
    root.setAttribute('data-wait', '');

    const read = (dt: number, input: FlightInput) => {
      input.gustX = 0;
      input.gustY = 0;
      input.near = 0;
      if (!pointer.known) return;
      stillFor += dt;
      // A pointer left alone stops being the thing worth looking at.
      input.look = trackingRef.current && stillFor < LOOK_HOLD ? 1 : 0;
      if (!pointer.fresh) return;
      pointer.fresh = false;
      stillFor = 0;
      input.look = trackingRef.current ? 1 : 0;
      const box = root.getBoundingClientRect();
      const width = box.width || 1;
      const height = box.height || 1;
      const dx = pointer.x - (box.left + width * EYE_ORIGIN.x);
      const dy = pointer.y - (box.top + height * EYE_ORIGIN.y);
      const distance = Math.hypot(dx, dy) || 1;
      const span = distance / width;
      const reach = Math.tanh(span / EYE_RANGE);
      input.lookX = (dx / distance) * reach;
      input.lookY = (dy / distance) * reach;
      input.atX = (pointer.x - box.left - width / 2) / (width / 2);
      input.atY = -(pointer.y - box.top - height / 2) / (height / 2);
      if (!interactiveRef.current) return;
      const close = Math.exp(-(span / AIR_RANGE) * (span / AIR_RANGE));
      if (pointer.moved && dt > 0) {
        input.gustX = (((pointer.x - lastX) / width) / dt) * close;
        input.gustY = (((pointer.y - lastY) / width) / dt) * close;
      }
      input.near = close > 0.45 ? (close - 0.45) / 0.55 : 0;
      lastX = pointer.x;
      lastY = pointer.y;
      pointer.moved = true;
    };

    const drawn = (flight: Flight) => {
      const shadow = shadowRef.current;
      if (!shadow) return;
      // The higher it floats the smaller its shadow, and the shadow follows it sideways.
      const scale = (1 - flight.drawY * 0.85).toFixed(3);
      const shift = `${(flight.drawX * 54).toFixed(1)}%`;
      if (scale !== ground) {
        ground = scale;
        shadow.style.setProperty('--ground', scale);
      }
      if (shift !== groundX) {
        groundX = shift;
        shadow.style.setProperty('--ground-x', shift);
      }
    };

    /** Back to the approved artwork, for good: reduced motion was turned on, or the graphics context went away. */
    const rest = () => {
      root.removeAttribute('data-live');
      root.removeAttribute('data-wait');
      shadowRef.current?.style.removeProperty('--ground');
      shadowRef.current?.style.removeProperty('--ground-x');
      observer?.disconnect();
      actor?.show(false);
    };

    loadStage()
      .then((stage) => {
        if (cancelled) return;
        actor = stage.createActor({
          canvas,
          size: size ?? (root.getBoundingClientRect().width || 128),
          small,
          appear: appearRef.current,
          mood: () => moodRef.current,
          read,
          drawn,
          rest,
        });
        if (!actor) {
          root.removeAttribute('data-wait');
          return;
        }
        actorRef.current = actor;
        if (owedRef.current.pulse) pulseFlight(actor.flight);
        if (owedRef.current.flip) flipFlight(actor.flight);
        owedRef.current = { pulse: false, flip: false };
        root.removeAttribute('data-wait');
        root.setAttribute('data-live', '');
        const live = actor;
        observer = new IntersectionObserver(([entry]) => {
          if (!entry) return;
          if (entry.isIntersecting && size === undefined && entry.boundingClientRect.width > 0) {
            live.resize(entry.boundingClientRect.width);
          }
          live.show(entry.isIntersecting);
        });
        observer.observe(root);
      })
      .catch(() => {
        root.removeAttribute('data-wait');
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      actor?.dispose();
      actorRef.current = null;
      root.removeAttribute('data-live');
      root.removeAttribute('data-wait');
    };
  }, [small, size]);

  // The pointer only ever leaves a note for the loop, so moving it costs nothing and needs no frame of its own.
  useEffect(() => {
    if (!(tracking || interactive) || reducedMotion() || !canLive()) return undefined;
    const pointer = pointerRef.current;
    const onMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.fresh = true;
      pointer.known = true;
    };
    const onFocusIn = (event: FocusEvent) => {
      const point = focusPoint(event.target);
      if (!point) return;
      pointer.x = point.x;
      pointer.y = point.y;
      pointer.fresh = true;
      pointer.known = true;
      pointer.moved = false;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('focusin', onFocusIn, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('focusin', onFocusIn);
    };
  }, [tracking, interactive]);

  const effectivePulse = pulse + internalPulse;
  useEffect(() => {
    if (!effectivePulse || reducedMotion()) return;
    if (actorRef.current) pulseFlight(actorRef.current.flight);
    else owedRef.current.pulse = true;
  }, [effectivePulse]);

  useEffect(() => {
    if (!flip || reducedMotion()) return;
    if (actorRef.current) flipFlight(actorRef.current.flight);
    else owedRef.current.flip = true;
  }, [flip]);

  return (
    <span
      ref={rootRef}
      className={cn(styles.root, className)}
      style={size === undefined ? undefined : { width: size, height: size }}
      data-mood={mood}
      data-small={small ? '' : undefined}
      data-appear={appear ? '' : undefined}
      data-interactive={interactive ? '' : undefined}
      data-testid="fantay-mascot"
      aria-hidden
      onPointerEnter={
        interactive
          ? () => {
              if (!reducedMotion() && actorRef.current) stirFlight(actorRef.current.flight, 0.6);
            }
          : undefined
      }
      onClick={
        interactive
          ? () => {
              if (reducedMotion()) return;
              if (actorRef.current) clickFlight(actorRef.current.flight);
              setInternalPulse((p) => p + 1);
            }
          : undefined
      }
    >
      {grounded ? <span ref={shadowRef} className={styles.shadow} /> : null}
      <Artwork small={small} className={styles.still} />
      <canvas ref={canvasRef} className={styles.stage} />
    </span>
  );
}

/** Static sprite for avatars and navigation icons. */
export interface FantayMascotStillProps {
  size: number;
  className?: string;
}
export function FantayMascotStill({ size, className }: FantayMascotStillProps) {
  return <Artwork small={size <= SMALL_MAX} className={cn(styles.root, className)} size={size} testId="fantay-mascot-still" />;
}
