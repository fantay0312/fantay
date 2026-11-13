'use client';
// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-connections.tsx.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: world-space SVG over the culled edge set, board tokens instead of the theme
// store, hairlines in screen px (`--inv-zoom`), edge kinds, `data-board-edge` hit paths, drag previews followed,
// and the dashed connect-drag path (ActiveConnectionPath).
import { memo } from 'react';

import { useBoardSelector } from '../context';
import { edgeEndpoints } from '../engine/culling';
import { edgeLayerSlice, sameEdgeLayerSlice, type EdgeLayerSlice } from './layer-selectors';
import styles from './layers.module.css';

function bezier(startX: number, startY: number, endX: number, endY: number, curvature: number): string {
  return `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;
}

export const EdgeLayer = memo(function EdgeLayer() {
  const slice: EdgeLayerSlice = useBoardSelector(edgeLayerSlice, sameEdgeLayerSlice);
  if (slice.edges.length === 0 && !slice.connect) return null;
  return (
    <svg className={styles.edges} aria-hidden data-testid="board-edges">
      {slice.edges.map((edge) => {
        const { startX, startY, endX, endY, curvature } = edgeEndpoints(edge.from, edge.to);
        const d = bezier(startX, startY, endX, endY, curvature);
        return (
          <g key={edge.id}>
            <path className={styles.edgeHit} d={d} data-board-edge="" data-edge-id={edge.id} />
            <path className={styles.edgePath} d={d} data-kind={edge.kind} data-selected={edge.selected ? '' : undefined} />
          </g>
        );
      })}
      {slice.connect ? (
        <path
          className={styles.connectPath}
          d={(() => {
            const { source, point, target } = slice.connect;
            const startX = source.x + source.w;
            const startY = source.y + source.h / 2;
            const endX = target ? target.x : point.x;
            const endY = target ? target.y + target.h / 2 : point.y;
            const distance = Math.abs(endX - startX);
            return bezier(startX, startY, endX, endY, distance * 0.5);
          })()}
          data-testid="board-connect-preview"
        />
      ) : null}
    </svg>
  );
});
