/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — an item's cover at any size: the generated cover or the item's own image, else
 * a tinted tile with the first character (or the cover words) so every row keeps its shape.
 * Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useState } from 'react';
import type { WorkbenchItem } from '@open-design/contracts';
import { cn } from '../../ui';
import { displayItem, hash } from '../shared/format';
import { coverUrl } from './data';
import styles from './ItemCover.module.css';

export interface ItemCoverProps {
  item: WorkbenchItem;
  className?: string;
  /** What the fallback tile shows: the first character (default), the cover words, or nothing. */
  fallback?: 'glyph' | 'words' | 'none';
}

export function ItemCover({ item, className, fallback = 'glyph' }: ItemCoverProps) {
  const url = coverUrl(item);
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) {
    return (
      <span className={cn(styles.cover, className)}>
        <img src={url} alt="" loading="lazy" draggable={false} onError={() => setFailed(url)} />
      </span>
    );
  }
  const shown = displayItem(item);
  const words = item.production?.coverText || shown.title;
  return (
    <span className={cn(styles.cover, styles.fallback, className)} data-tone={hash(item.id) % 6} aria-hidden>
      {fallback === 'glyph' ? <span className={styles.glyph}>{Array.from(shown.title.trim())[0] ?? '·'}</span> : null}
      {fallback === 'words' ? <b className={styles.words}>{words}</b> : null}
    </span>
  );
}
