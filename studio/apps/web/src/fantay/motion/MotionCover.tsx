// SPDX-License-Identifier: AGPL-3.0-only
// Static film cover (spec 07 §3.1): a review filmstrip tile at `time`, a rendered sample image, or
// a CSS poster in the film's own colours. Fills its parent; the film keeps its aspect (letterboxed).
import type { CSSProperties } from 'react';

import { cn } from '../ui';
import {
  motionFrameSize,
  stripBackgroundPosition,
  stripBackgroundSize,
  stripFrameIndex,
  type MotionCoverSource,
  type MovieAspect,
} from './motion-model';
import styles from './MotionCover.module.css';

export interface MotionCoverProps {
  cover: MotionCoverSource | null;
  aspect?: MovieAspect;
  /** Strip covers: the clock time whose tile is shown. */
  time?: number;
  duration?: number;
  className?: string;
}

export function MotionCover({ cover, aspect = '16:9', time = 0, duration = 0, className }: MotionCoverProps) {
  const frame = motionFrameSize(aspect);
  const box = { '--motion-cover-aspect': frame.width / frame.height } as CSSProperties;
  return (
    <div className={cn(styles.cover, className)} style={box} data-testid="motion-cover" data-kind={cover?.kind ?? 'none'}>
      {cover?.kind === 'strip' ? (
        <div
          className={styles.strip}
          aria-hidden
          data-frame={stripFrameIndex(time, duration, cover.frames)}
          style={{
            backgroundImage: `url("${cover.url.replace(/"/g, '%22')}")`,
            backgroundSize: stripBackgroundSize(cover.frames, aspect),
            backgroundPosition: stripBackgroundPosition(stripFrameIndex(time, duration, cover.frames), cover.frames, aspect),
          }}
        />
      ) : cover?.kind === 'image' ? (
        <img className={styles.image} src={cover.url} alt="" draggable={false} />
      ) : cover?.kind === 'poster' ? (
        <div className={styles.poster} aria-hidden style={{ background: cover.background, color: cover.foreground }}>
          <span className={styles.posterAccent} style={{ background: cover.accent }} />
          <p className={styles.posterTitle}>{cover.title}</p>
        </div>
      ) : null}
    </div>
  );
}
