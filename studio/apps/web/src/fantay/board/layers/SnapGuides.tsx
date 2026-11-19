'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Gesture overlay (spec 03 §3.1, §3.8): snap guides, the marquee, the draw preview and the resize W×H badge,
// in screen space from the camera variables.
import { memo } from 'react';

import { useBoardSelector } from '../context';
import { gestureSlice, sameGestureSlice } from './layer-selectors';
import styles from './layers.module.css';
import { screenBox, screenPoint } from './screen-space';

export const SnapGuides = memo(function SnapGuides() {
  const slice = useBoardSelector(gestureSlice, sameGestureSlice);
  return (
    <>
      {slice.guides.map((guide, index) =>
        guide.axis === 'v' ? (
          <span
            key={`v${index}`}
            className={styles.guideV}
            style={{ ...screenPoint(guide.at, guide.from), height: `calc(${guide.to - guide.from}px * var(--zoom, 1))` }}
            data-testid="board-snap-guide"
          />
        ) : (
          <span
            key={`h${index}`}
            className={styles.guideH}
            style={{ ...screenPoint(guide.from, guide.at), width: `calc(${guide.to - guide.from}px * var(--zoom, 1))` }}
            data-testid="board-snap-guide"
          />
        ),
      )}
      {slice.marquee ? <div className={styles.marquee} style={screenBox(slice.marquee)} data-testid="board-marquee" /> : null}
      {slice.draw?.points ? (
        <svg style={{ position: 'absolute', ...screenBox(slice.draw.rect) }} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden>
          <polyline points={slice.draw.points} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : slice.draw ? (
        <div className={styles.drawPreview} style={screenBox(slice.draw.rect)} data-tool={slice.draw.tool} data-testid="board-draw-preview" />
      ) : null}
      {slice.resize ? (
        <span
          className={styles.badge}
          style={screenPoint(slice.resize.rect.x + slice.resize.rect.w / 2, slice.resize.rect.y + slice.resize.rect.h)}
          data-testid="board-resize-badge"
        >
          {`${slice.resize.w} × ${slice.resize.h}`}
        </span>
      ) : null}
    </>
  );
});
