'use client';
// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-selection-toolbar.tsx.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: the dashed multi-selection union only (no Group pill: the context bar has
// it), placed in screen space from the camera variables; selection outlines, the 8 resize handles, the hover
// outline and the connector dot are Fantay additions (spec 03 §3.1, §3.8).
import { memo } from 'react';

import { useBoardSelector } from '../context';
import type { ResizeHandle } from '../model/types';
import { sameSelectionSlice, selectionSlice } from './layer-selectors';
import styles from './layers.module.css';
import { screenBox } from './screen-space';

/** Union padding in screen px (infinite-canvas SELECTION_PAD 14). */
const UNION_PAD = 14;

const HANDLE_POSITION: Readonly<Record<ResizeHandle, { left: string; top: string }>> = {
  nw: { left: '0%', top: '0%' },
  n: { left: '50%', top: '0%' },
  ne: { left: '100%', top: '0%' },
  e: { left: '100%', top: '50%' },
  se: { left: '100%', top: '100%' },
  s: { left: '50%', top: '100%' },
  sw: { left: '0%', top: '100%' },
  w: { left: '0%', top: '50%' },
};

export const SelectionOverlay = memo(function SelectionOverlay() {
  const slice = useBoardSelector(selectionSlice, sameSelectionSlice);
  return (
    <>
      {slice.hover ? <div className={styles.hoverOutline} style={screenBox(slice.hover)} data-testid="board-hover-outline" /> : null}
      {slice.connectTarget ? (
        <div className={styles.connectTarget} style={screenBox(slice.connectTarget)} data-testid="board-connect-target" />
      ) : null}
      {slice.union ? <div className={styles.union} style={screenBox(slice.union, UNION_PAD)} data-testid="board-selection-union" /> : null}
      {slice.boxes.map((box) => (
        <div
          key={box.id}
          className={styles.selectionOutline}
          style={screenBox(box.rect)}
          data-mode={box.mode ?? undefined}
          data-testid="board-selection-outline"
          data-node-id={box.id}
        >
          {box.handles.map((handle) => (
            <span
              key={handle}
              className={styles.handle}
              style={HANDLE_POSITION[handle]}
              data-board-handle={handle}
              data-node-id={box.id}
              data-testid={`board-handle-${handle}`}
            />
          ))}
        </div>
      ))}
      {slice.connector ? (
        <span
          className={styles.connector}
          style={{
            left: `calc(var(--vx, 0px) + ${slice.connector.rect.x + slice.connector.rect.w}px * var(--zoom, 1) + 12px)`,
            top: `calc(var(--vy, 0px) + ${slice.connector.rect.y + slice.connector.rect.h / 2}px * var(--zoom, 1))`,
          }}
          data-board-connector=""
          data-hover-only={slice.connector.hoverOnly ? '' : undefined}
          data-node-id={slice.connector.id}
          data-testid="board-connector"
        />
      ) : null}
    </>
  );
});
