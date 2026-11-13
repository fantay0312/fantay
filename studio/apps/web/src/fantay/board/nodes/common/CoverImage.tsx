'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Cover image (spec 03 §3.6, §4.1): fades in once decoded, can be hidden under a live surface while staying
// mounted (no flash when the live slot is released), and marks a cover that may be out of date.
import { useState } from 'react';

import { useT } from '../../../../i18n';
import styles from './faces.module.css';

export interface CoverImageProps {
  src: string;
  alt: string;
  stale?: boolean;
  /** keep mounted but transparent (a live surface is on top) */
  hidden?: boolean;
  onLoad?: () => void;
  onError?: () => void;
}

export function CoverImage({ src, alt, stale = false, hidden = false, onLoad, onError }: CoverImageProps) {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      <img
        className={styles.cover}
        src={src}
        alt={alt}
        decoding="async"
        draggable={false}
        data-loaded={loaded ? 'true' : 'false'}
        data-hidden={hidden ? '' : undefined}
        data-testid="board-cover"
        onLoad={() => {
          setLoaded(true);
          onLoad?.();
        }}
        onError={onError}
      />
      {stale && !hidden ? <span className={styles.stale}>{t('board.node.state.coverStale')}</span> : null}
    </>
  );
}
