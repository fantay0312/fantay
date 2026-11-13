// Cover art for one material record: the daemon's bounded thumbnail when the
// archive indexed one, otherwise a typographic cover built from the record's
// own text (host or collection, title, palette). Shared by the Materials grid,
// its detail dialog and the composer picker.

import { useEffect, useRef, useState } from 'react';
import type { MaterialSummaryItem } from '@open-design/contracts';
import {
  extractPromptBadge,
  getMaterialArchetype,
  isSafeCssColor,
  materialCoverText,
} from './material-model';
import styles from './MaterialCover.module.css';

interface Props {
  item: MaterialSummaryItem;
  /** `large` is the detail dialog's hero; `card` is a grid cell. */
  size?: 'card' | 'large';
}

export function MaterialCover({ item, size = 'card' }: Props) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const src = failed ? null : item.thumbnailUrl;

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [item.thumbnailUrl]);

  // A cached image can finish before React attaches `onLoad`.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) setLoaded(true);
  }, [src]);

  const archetype = getMaterialArchetype(item);
  const isMultimedia = archetype === 'multimedia';
  const promptBadge = isMultimedia ? extractPromptBadge(item) : null;
  const isComponent = archetype === 'component';

  // SVG icons are drawn for a light ground and read best uncropped.
  const isIcon = item.kind === 'svg';
  const className = [
    styles.cover,
    size === 'large' ? styles.large : '',
    src && isIcon ? styles.icon : '',
    isMultimedia && size === 'card' ? styles.multimediaRatio : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (src) {
    return (
      <span className={className} data-cover="image">
        <img
          ref={imgRef}
          className={styles.img}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          data-loaded={loaded ? 'true' : 'false'}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
        {isComponent && item.capabilities?.previewEntry && size === 'card' ? (
          <span className={styles.coverBadgeInteractive}>
            <span className={styles.interactiveDot} />
            可交互
          </span>
        ) : null}
        {isMultimedia && promptBadge && size === 'card' ? (
          <span className={styles.coverBadgePrompt}>
            {promptBadge}
          </span>
        ) : null}
      </span>
    );
  }

  const palette = item.palette.filter((color) => isSafeCssColor(color.value)).slice(0, 6);
  const { eyebrow, headline } = materialCoverText(item);
  return (
    <span className={`${className} ${styles.fallback}`} data-cover="type" aria-hidden>
      {eyebrow ? <span className={styles.eyebrow}>{eyebrow}</span> : <span />}
      <span className={styles.fallbackTitle}>{headline}</span>
      {isComponent && item.capabilities?.previewEntry && size === 'card' ? (
        <span className={styles.coverBadgeInteractive}>
          <span className={styles.interactiveDot} />
          可交互
        </span>
      ) : null}
      {isMultimedia && promptBadge && size === 'card' ? (
        <span className={styles.coverBadgePrompt}>
          {promptBadge}
        </span>
      ) : null}
      {palette.length > 0 ? (
        <span className={styles.paletteStrip}>
          {palette.map((color) => (
            <span
              key={`${color.name}-${color.value}`}
              className={styles.paletteBand}
              style={{ background: color.value }}
            />
          ))}
        </span>
      ) : null}
    </span>
  );
}

