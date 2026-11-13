'use client';
// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-mini-map.tsx.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: a 200×132 board island (spec 03 §6.5) shown while `ui.minimapOpen`; node rects
// coloured `--board-lod-<kind>`; the bounds/projection maths split into pure helpers; the viewport rect is written to
// the DOM by a camera subscription (no React state, so pan/zoom never re-render it); press and drag recentre the
// camera through the camera controller at the current zoom.
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useT } from '../../../i18n';
import type { Camera } from '../camera/camera';
import { useBoardEngine, useBoardSelector } from '../context';
import type { EngineNode, Point, Rect, Size } from '../model/types';
import { BOARD_CHROME_ISLAND_ATTR } from '../nodes/frame/FrameNode';
import styles from './chrome.module.css';

export const MINIMAP_SIZE: Size = { w: 200, h: 132 };
/** World margin around the node union (IC `:32-35`). */
export const MINIMAP_MARGIN = 500;

export interface MinimapProjection {
  /** world rect shown by the minimap */
  bounds: Rect;
  /** minimap px per world px */
  scale: number;
  /** minimap px of the bounds' top-left (the content is centred) */
  offset: Point;
}

/** World bounds = node union ± 500, fitted and centred in the minimap (IC `:15-48`). */
export function minimapProjection(rects: readonly Rect[], size: Size = MINIMAP_SIZE): MinimapProjection {
  if (rects.length === 0) {
    const empty = { x: -500, y: -500, w: 1000, h: 1000 };
    const scale = Math.min(size.w / empty.w, size.h / empty.h);
    return { bounds: empty, scale, offset: { x: (size.w - empty.w * scale) / 2, y: (size.h - empty.h * scale) / 2 } };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  minX -= MINIMAP_MARGIN;
  minY -= MINIMAP_MARGIN;
  maxX += MINIMAP_MARGIN;
  maxY += MINIMAP_MARGIN;
  const w = maxX - minX;
  const h = maxY - minY;
  const scale = Math.min(size.w / w, size.h / h);
  return { bounds: { x: minX, y: minY, w, h }, scale, offset: { x: (size.w - w * scale) / 2, y: (size.h - h * scale) / 2 } };
}

export function worldToMinimap(projection: MinimapProjection, world: Point): Point {
  return {
    x: (world.x - projection.bounds.x) * projection.scale + projection.offset.x,
    y: (world.y - projection.bounds.y) * projection.scale + projection.offset.y,
  };
}

export function minimapToWorld(projection: MinimapProjection, point: Point): Point {
  return {
    x: (point.x - projection.offset.x) / projection.scale + projection.bounds.x,
    y: (point.y - projection.offset.y) / projection.scale + projection.bounds.y,
  };
}

/** The camera's view in minimap px, at least 4×4 (IC `:70-84`). */
export function minimapViewportRect(projection: MinimapProjection, camera: Camera, stage: Size): Rect {
  const topLeft = worldToMinimap(projection, { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom });
  const bottomRight = worldToMinimap(projection, {
    x: (stage.w - camera.x) / camera.zoom,
    y: (stage.h - camera.y) / camera.zoom,
  });
  return { x: topLeft.x, y: topLeft.y, w: Math.max(bottomRight.x - topLeft.x, 4), h: Math.max(bottomRight.y - topLeft.y, 4) };
}

/** The camera that centres `world` on the stage at the current zoom (IC `:86-96`). */
export function cameraCenteredOn(world: Point, camera: Camera, stage: Size): Camera {
  return { x: stage.w / 2 - world.x * camera.zoom, y: stage.h / 2 - world.y * camera.zoom, zoom: camera.zoom };
}

function minimapNodes(nodes: ReadonlyMap<string, EngineNode>, order: readonly string[]): EngineNode[] {
  const list: EngineNode[] = [];
  for (const id of order) {
    const node = nodes.get(id);
    if (node && !node.hidden) list.push(node);
  }
  return list;
}

export function Minimap() {
  const engine = useBoardEngine();
  const t = useT();
  const open = useBoardSelector((state) => state.ui.minimapOpen);
  const doc = useBoardSelector((state) => state.doc);
  const nodes = useMemo(() => minimapNodes(doc.nodes, doc.order), [doc]);
  const projection = useMemo(() => minimapProjection(nodes), [nodes]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<number | null>(null);

  // the viewport rect follows the camera without React (I2)
  useEffect(() => {
    if (!open) return undefined;
    const { camera } = engine;
    const write = (): void => {
      const element = viewportRef.current;
      if (!element) return;
      const rect = minimapViewportRect(projection, camera.get(), camera.stageSize());
      element.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
      element.style.width = `${rect.w}px`;
      element.style.height = `${rect.h}px`;
    };
    write();
    const offCamera = camera.subscribe(write);
    const offResize = camera.onResize(write);
    return () => {
      offCamera();
      offResize();
    };
  }, [engine, open, projection]);

  const recentre = useCallback(
    (clientX: number, clientY: number) => {
      const element = containerRef.current;
      if (!element) return;
      const box = element.getBoundingClientRect();
      const world = minimapToWorld(projection, { x: clientX - box.left, y: clientY - box.top });
      const { camera } = engine;
      camera.cancelFlight();
      camera.set(cameraCenteredOn(world, camera.get(), camera.stageSize()), 'user');
    },
    [engine, projection],
  );

  if (!open) return null;
  return (
    <div
      ref={containerRef}
      className={styles.minimap}
      role="group"
      aria-label={t('board.minimap.label')}
      data-testid="board-minimap"
      {...{ [BOARD_CHROME_ISLAND_ATTR]: '' }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* jsdom / synthetic pointers */
        }
        dragging.current = event.pointerId;
        recentre(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (dragging.current === event.pointerId) recentre(event.clientX, event.clientY);
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
      onLostPointerCapture={() => {
        dragging.current = null;
      }}
    >
      {nodes.map((node) => {
        const at = worldToMinimap(projection, node);
        return (
          <span
            key={node.id}
            className={styles.minimapNode}
            data-kind={node.kind}
            style={{
              left: at.x,
              top: at.y,
              width: Math.max(node.w * projection.scale, 2),
              height: Math.max(node.h * projection.scale, 2),
              background: `var(--board-lod-${node.kind})`,
            }}
          />
        );
      })}
      <div ref={viewportRef} className={styles.minimapViewport} data-testid="board-minimap-viewport" />
    </div>
  );
}
