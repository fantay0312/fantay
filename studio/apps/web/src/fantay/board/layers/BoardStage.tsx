'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/Stage.tsx (stage element and layer stack L904-941) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the stage DOM stack of spec 03 §3.1
 *   (grid, label layer under the world, world, screen-space overlay, comment pins and popovers); the camera
 *   controller attaches to these elements and the pointer controller receives the stage's pointer events.
 */
import { memo, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import styles from '../BoardView.module.css';
import { BoardCommentLayer } from '../comments/BoardCommentLayer';
import { BoardLabelLayerContext, useBoardEngine, useBoardSelector } from '../context';
import { BOARD_INTERACTIVE_ATTR } from '../extensions';
import { GridLayer } from './GridLayer';
import { LabelLayer } from './LabelLayer';
import { OverlayLayer } from './OverlayLayer';
import { WorldLayer } from './WorldLayer';

export interface BoardStageProps {
  /** the board root (carries the camera's CSS variables) */
  rootRef: RefObject<HTMLDivElement | null>;
}

function interactiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${BOARD_INTERACTIVE_ATTR}]`) !== null;
}

export const BoardStage = memo(function BoardStage({ rootRef }: BoardStageProps) {
  const engine = useBoardEngine();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [labelLayer, setLabelLayer] = useState<HTMLDivElement | null>(null);
  const tool = useBoardSelector((state) => state.ui.tool);
  const spaceHeld = useBoardSelector((state) => state.ui.spaceHeld);
  const panning = useBoardSelector((state) => state.ui.interaction === 'panning');

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const world = worldRef.current;
    // the parent's ref is attached after this child's layout effect: read the root from the DOM
    const root = rootRef.current ?? stage?.parentElement ?? null;
    if (!root || !stage || !world) return undefined;
    const detach = engine.camera.attach({ root, stage, world, grid: gridRef.current });
    const detachInput = engine.camera.attachInput(stage, {
      ignoreTarget: interactiveTarget,
      wheelZooms: () => engine.store.getState().ui.wheelZooms,
      frozen: () => {
        const mode = engine.store.getState().ui.mode;
        return mode?.mode === 'capture' && mode.captureTool === 'markup';
      },
    });
    return () => {
      detachInput();
      detach();
    };
  }, [engine, rootRef]);

  const { pointer } = engine;
  return (
    <div
      ref={stageRef}
      className={styles.stage}
      data-testid="board-stage"
      data-tool={tool}
      data-space-held={spaceHeld ? '' : undefined}
      data-panning={panning ? '' : undefined}
      onPointerDown={(event) => pointer.onPointerDown(event.nativeEvent)}
      onPointerMove={(event) => pointer.onPointerMove(event.nativeEvent)}
      onPointerLeave={() => pointer.onPointerLeave()}
      onDoubleClick={(event) => pointer.onDoubleClick(event.nativeEvent)}
      onContextMenu={(event) => pointer.onContextMenu(event.nativeEvent)}
    >
      <GridLayer ref={gridRef} />
      <LabelLayer ref={setLabelLayer} />
      <BoardLabelLayerContext.Provider value={labelLayer}>
        <WorldLayer ref={worldRef} />
      </BoardLabelLayerContext.Provider>
      <OverlayLayer />
      <BoardCommentLayer />
    </div>
  );
});
