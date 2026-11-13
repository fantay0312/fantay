// SPDX-License-Identifier: AGPL-3.0-only
// The one loading animation for a whole surface: the Fantay sprite waiting, as it waits on the startup splash
// (apps/desktop/src/main/splash-screen.ts) — riding the air, its hat tip swaying a beat behind it, blinking, the orb
// on its hat breathing. The wait that starts on the splash and the waits that follow it are the same character doing
// the same thing.
//
// It is one image: `public/fantay-sprite-live.svg` carries the drawing and its own CSS keyframes, so there is no
// canvas, no three.js and no script, and the drawing's ids never meet the app's. That is the point of it beside the
// living mascot (FantayMascot.tsx), which has to load its stage before it can be seen — a loader cannot be something
// that is itself loading. It is also what lets the pre-mount shell (app/[[...slug]]/client-app.tsx) use it before any
// of the app's own JS has arrived.
//
// A control that is merely busy (a button, a toast, a status chip) keeps the ring `Spinner`; this is for a surface
// that has nothing else to show yet.
import type { CSSProperties, ReactNode } from 'react';

import styles from './FantayLoader.module.css';

/** Sizes at and under this use the still small cut: the idle motion is a pixel or two there and reads as shimmer. */
const SMALL_MAX = 32;

export interface FantayLoaderProps {
  /** Side of the sprite's box, px. */
  size?: number;
  /** Shown under the sprite and announced with it. */
  label?: ReactNode;
  labelClassName?: string;
  /** The host is already the live region (or the wait is announced elsewhere): no role of its own. */
  decorative?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function FantayLoader({
  size = 64,
  label,
  labelClassName,
  decorative = false,
  className,
  'data-testid': testId = 'fantay-loader',
}: FantayLoaderProps) {
  const small = size <= SMALL_MAX;
  const announced = !decorative && label != null;
  return (
    <span
      className={className ? `${styles.root} ${className}` : styles.root}
      style={{ '--fl-size': `${size}px` } as CSSProperties}
      data-small={small ? '' : undefined}
      data-testid={testId}
      role={announced ? 'status' : undefined}
      aria-live={announced ? 'polite' : undefined}
      aria-hidden={!announced && label == null ? true : undefined}
    >
      <span className={styles.stage} aria-hidden>
        <img
          className={styles.sprite}
          src={small ? '/fantay-sprite-small.svg' : '/fantay-sprite-live.svg'}
          alt=""
          width={size}
          height={size}
          draggable={false}
        />
        <span className={styles.shadow} />
      </span>
      {label != null ? <span className={labelClassName ? `${styles.label} ${labelClassName}` : styles.label}>{label}</span> : null}
    </span>
  );
}
