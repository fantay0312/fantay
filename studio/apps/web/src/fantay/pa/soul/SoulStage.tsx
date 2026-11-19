// SPDX-License-Identifier: AGPL-3.0-only
// The standing picture (立绘区, stage 2 spec §6.1, §12.2): a column at the inline start of a direct companion chat's
// transcript that shows the current sprite large, uncropped and standing on the bottom edge. It is decoration: no
// pointer events, one accessible name. The transcript makes room for it (`.scroller[data-stage]` in
// SoulTranscript.module.css), so it never covers a bubble. A new sprite crossfades like a portrait; an image that
// fails to load leaves the plain paper.
import { useState } from 'react';

import { cn } from '../../ui';
import { useSoulImageSwap } from './SoulPortrait';
import styles from './SoulStage.module.css';

export interface SoulStageProps {
  /** The sprite URL (an asset URL or a data: URL); '' keeps the column with nothing in it. */
  src: string;
  /** The character's display name. */
  name: string;
  /** The accessible name of the picture (who, and in which mood). */
  label: string;
  className?: string;
}

export function SoulStage({ src, name, label, className }: SoulStageProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const image = src && src !== failed ? src : null;
  const swap = useSoulImageSwap(image);
  return (
    <div
      // An empty column (no image, or one that failed) is plain paper and says nothing.
      {...(image ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      data-testid="pa-soul-stage"
      data-name={name}
      className={cn(styles.stage, className)}
    >
      {swap.under ? (
        <img
          key={`under:${swap.under}`}
          src={swap.under}
          alt=""
          aria-hidden
          draggable={false}
          data-out={swap.phase === 'in' ? '' : undefined}
          className={cn(styles.image, styles.under)}
        />
      ) : null}
      {image ? (
        <img
          key={image}
          src={image}
          alt=""
          draggable={false}
          decoding="async"
          data-swap={swap.phase ?? undefined}
          className={styles.image}
          onLoad={swap.onLoad}
          onAnimationEnd={swap.onSwapEnd}
          onError={() => setFailed(src)}
        />
      ) : null}
    </div>
  );
}
