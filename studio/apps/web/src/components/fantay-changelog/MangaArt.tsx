// SPDX-License-Identifier: AGPL-3.0-only
// The manga's drawing kit: the mascot redrawn in ink, focus lines, a starburst, bubbles, captions and sound effects.
// Every shape is deterministic (seeded), so a page draws the same way on every open. Colours live in the stylesheet.
import { useMemo, type CSSProperties, type ReactNode } from 'react';

import { MASCOT_ART } from '../../fantay/brand/FantayMascot';
import styles from './FantayChangelog.module.css';

export type InkMascotStyle = 'ink' | 'inverse' | 'color' | 'paper';
export type InkMascotMood = 'calm' | 'happy' | 'shock' | 'wink';

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ');
}

/** Small, fast, seeded PRNG so every page draws identically. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An eye drawn as an upturned arc: the character smiling with its eyes closed. */
function arcEye(x: number, y: number, rx: number): string {
  return `M ${x - rx * 1.35} ${y + rx * 0.55} Q ${x} ${y - rx * 1.9} ${x + rx * 1.35} ${y + rx * 0.55}`;
}

/**
 * The Fantay mascot as a manga character. `ink` is the line drawing on paper, `inverse` the white-lined
 * silhouette for black panels, `color` and `paper` the cover renderings in the brand's own colours.
 */
export function InkMascot({
  look = 'ink',
  mood = 'calm',
  mirrored = false,
  className,
  style,
}: {
  look?: InkMascotStyle;
  mood?: InkMascotMood;
  mirrored?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const { front, back, eyes, eyeTilt, transform } = MASCOT_ART;
  return (
    <svg
      className={cx(styles.mascot, className)}
      data-look={look}
      viewBox="0 0 1024 1024"
      style={style}
      aria-hidden
      focusable="false"
    >
      <g transform={mirrored ? `translate(1024 0) scale(-1 1) ${transform}` : transform}>
        <path className={styles.mascotBody} d={front} />
        <path className={styles.mascotFold} d={back} />
        <path className={styles.mascotLine} d={front} />
        {eyes.map(([x, y, rx, ry], index) => {
          const closed = mood === 'happy' || (mood === 'wink' && index === 1);
          const rotate = `rotate(${eyeTilt} ${x} ${y})`;
          if (closed) return <path key={x} className={styles.mascotLid} d={arcEye(x, y, rx)} transform={rotate} />;
          if (mood === 'shock') {
            return (
              <g key={x} transform={rotate}>
                <ellipse className={styles.mascotWhite} cx={x} cy={y} rx={rx * 1.7} ry={ry * 1.45} />
                <ellipse className={styles.mascotPupil} cx={x + rx * 0.2} cy={y + ry * 0.25} rx={rx * 0.55} ry={ry * 0.5} />
              </g>
            );
          }
          return (
            <g key={x} transform={rotate}>
              <ellipse className={styles.mascotEye} cx={x} cy={y} rx={rx} ry={ry} />
              <ellipse className={styles.mascotGlint} cx={x - rx * 0.3} cy={y - ry * 0.42} rx={rx * 0.32} ry={ry * 0.22} />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** 集中線: ink wedges converging on a point, the manga way of saying "look here". Coordinates are panel percentages. */
export function FocusLines({
  x = 50,
  y = 50,
  count = 64,
  inner = 26,
  seed = 1,
  className,
}: {
  x?: number;
  y?: number;
  count?: number;
  inner?: number;
  seed?: number;
  className?: string;
}) {
  const d = useMemo(() => {
    const rnd = seeded(seed);
    const outer = 160;
    let path = '';
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * Math.PI * 2 + rnd() * 0.05;
      const w = 0.006 + rnd() * 0.016;
      const r = inner + rnd() * 18;
      const p = (angle: number, radius: number) =>
        `${(x + Math.cos(angle) * radius).toFixed(2)} ${(y + Math.sin(angle) * radius).toFixed(2)}`;
      path += `M ${p(a - w, outer)} L ${p(a, r)} L ${p(a + w, outer)} Z `;
    }
    return path;
  }, [count, inner, seed, x, y]);
  return (
    <svg className={cx(styles.fill, className)} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
      <path className={styles.inkFill} d={d} />
    </svg>
  );
}

/** Parallel speed lines sweeping across a panel at an angle. */
export function SpeedLines({ angle = -12, seed = 3, className }: { angle?: number; seed?: number; className?: string }) {
  const d = useMemo(() => {
    const rnd = seeded(seed);
    let path = '';
    for (let i = 0; i < 26; i += 1) {
      const y = -20 + i * 5.6 + rnd() * 3;
      const start = rnd() * 40;
      const length = 30 + rnd() * 70;
      const t = 0.15 + rnd() * 0.5;
      path += `M ${start.toFixed(2)} ${y.toFixed(2)} L ${(start + length).toFixed(2)} ${(y - t).toFixed(2)} L ${(start + length).toFixed(2)} ${(y + t).toFixed(2)} Z `;
    }
    return path;
  }, [seed]);
  return (
    <svg className={cx(styles.fill, className)} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
      <path className={styles.inkFill} d={d} transform={`rotate(${angle} 50 50)`} />
    </svg>
  );
}

/** The jagged explosion balloon a shout lives in. */
export function Starburst({
  children,
  seed = 7,
  className,
  style,
}: {
  children: ReactNode;
  seed?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const d = useMemo(() => {
    const rnd = seeded(seed);
    const spikes = 18;
    let path = '';
    for (let i = 0; i < spikes * 2; i += 1) {
      const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? 47 + rnd() * 3 : 36 + rnd() * 5;
      path += `${i === 0 ? 'M' : 'L'} ${(50 + Math.cos(a) * r).toFixed(2)} ${(50 + Math.sin(a) * r).toFixed(2)} `;
    }
    return `${path}Z`;
  }, [seed]);
  return (
    <div className={cx(styles.starburst, className)} style={style}>
      <svg className={styles.fill} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden focusable="false">
        <path className={styles.burstShape} d={d} />
      </svg>
      <p className={styles.burstText}>{children}</p>
    </div>
  );
}

export type BubbleTail = 'left' | 'right' | 'center';

/** An oval speech balloon; the tail points down toward whoever is talking. */
export function Bubble({
  children,
  tail = 'center',
  className,
  style,
}: {
  children: ReactNode;
  tail?: BubbleTail;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cx(styles.bubble, className)} data-tail={tail} style={style}>
      <p className={styles.bubbleText}>{children}</p>
      <svg className={styles.bubbleTail} viewBox="0 0 20 26" aria-hidden focusable="false">
        <path d={tail === 'left' ? 'M 4 0 L 1 25 L 17 0' : tail === 'right' ? 'M 3 0 L 19 25 L 16 0' : 'M 3 0 L 10 25 L 17 0'} />
      </svg>
    </div>
  );
}

/** A narration box. `dark` sets it in paper on ink. */
export function Caption({
  children,
  dark = false,
  className,
  style,
}: {
  children: ReactNode;
  dark?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <p className={cx(styles.caption, dark && styles.captionDark, className)} style={style}>
      {children}
    </p>
  );
}

/** A hand-lettered sound effect: decoration, hidden from assistive technology. */
export function Sfx({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <span className={cx(styles.sfx, className)} style={style} aria-hidden>
      {children}
    </span>
  );
}

/** Screentone: a dot screen laid over part of a panel. `fade` grades it out the way printed tone is cut. */
export function Tone({
  fade = 'none',
  dense = false,
  className,
  style,
}: {
  fade?: 'none' | 'left' | 'right' | 'up' | 'down' | 'radial';
  dense?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return <span className={cx(styles.tone, dense && styles.toneDense, className)} data-fade={fade} style={style} aria-hidden />;
}
