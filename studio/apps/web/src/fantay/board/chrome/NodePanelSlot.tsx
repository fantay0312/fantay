'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The generator panel slot (spec 03 §4.9, plan R4): while exactly one generator is selected and the generation
// extension renders a panel, it is docked under the node in screen space (left = node centre − 280, top = node
// bottom + 12, width 560, capped by the board height) through the camera variables, so pan and zoom never re-render
// it. The slot is a flex column so the panel, not the slot, scrolls at the height cap: a scrolling slot would clip the
// panel's shadow. If the opened panel would run off the bottom, the camera pans once per generator and shape (no zoom
// change). It stays mounted 140 ms after closing for the exit transition. The slot is a `data-board-interactive` island.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { useBoardEngine, useBoardHost, useBoardSelector } from '../context';
import { BOARD_INTERACTIVE_ATTR } from '../extensions';
import type { EngineNode } from '../model/types';
import { BOARD_CHROME_ISLAND_ATTR } from '../nodes/frame/FrameNode';
import styles from './chrome.module.css';

export const PANEL_SLOT_WIDTH = 560;
const GAP = 12;
/** Stage height kept free under the panel: the toolbar and the context bar above it. */
const BOTTOM_RESERVE = 116;
const EXIT_MS = 140;

export function panelSlotStyle(node: Pick<EngineNode, 'x' | 'y' | 'w' | 'h'>): CSSProperties {
  const top = `calc(var(--vy, 0px) + ${node.y + node.h}px * var(--zoom, 1) + ${GAP}px)`;
  return {
    left: `max(${GAP}px, min(calc(var(--vx, 0px) + ${node.x + node.w / 2}px * var(--zoom, 1) - ${PANEL_SLOT_WIDTH / 2}px), calc(100% - ${PANEL_SLOT_WIDTH + GAP}px)))`,
    top,
    maxHeight: `max(160px, calc(100% - (${top}) - ${BOTTOM_RESERVE}px))`,
  };
}

function selectedGenerator(state: { ui: { selection: readonly string[] }; doc: { nodes: ReadonlyMap<string, EngineNode> } }): EngineNode | null {
  if (state.ui.selection.length !== 1) return null;
  const node = state.doc.nodes.get(state.ui.selection[0]!);
  return node?.kind === 'generator' ? node : null;
}

export function NodePanelSlot() {
  const engine = useBoardEngine();
  const { extensions } = useBoardHost();
  const render = extensions?.renderGeneratorPanel;
  const node = useBoardSelector(selectedGenerator);
  const [shown, setShown] = useState<EngineNode | null>(node);
  const slotRef = useRef<HTMLDivElement | null>(null);
  const revealed = useRef<string | null>(null);

  useEffect(() => {
    if (node) {
      setShown(node);
      return undefined;
    }
    const timer = setTimeout(() => setShown(null), EXIT_MS);
    return () => clearTimeout(timer);
  }, [node]);

  // once per opened generator: keep the panel on screen by panning (never zooming)
  useLayoutEffect(() => {
    const shape = node ? `${node.id}:${node.h}` : null;
    if (!node || !render || revealed.current === shape) return;
    revealed.current = shape;
    const slot = slotRef.current;
    const stage = engine.camera.stageSize();
    if (!slot || stage.h <= 0) return;
    const cam = engine.camera.get();
    const top = cam.y + (node.y + node.h) * cam.zoom + GAP;
    // The panel's own scroll height: the slot is already capped by the space left under the node.
    const height = slot.firstElementChild?.scrollHeight ?? slot.offsetHeight;
    const overflow = top + height - (stage.h - BOTTOM_RESERVE);
    if (overflow > 0 && height > 0) engine.camera.panBy(0, -Math.min(overflow, Math.max(0, top - GAP * 4)), 'program');
  }, [engine, node, render]);
  useEffect(() => {
    if (!node) revealed.current = null;
  }, [node]);

  const current = node ?? shown;
  if (!render || !current) return null;
  return (
    <div
      ref={slotRef}
      className={styles.panelSlot}
      style={panelSlotStyle(current)}
      data-state={node ? 'open' : 'closed'}
      data-testid="board-panel-slot"
      {...{ [BOARD_INTERACTIVE_ATTR]: '', [BOARD_CHROME_ISLAND_ATTR]: '' }}
    >
      {render({ nodeId: current.id, onClose: () => engine.commands.clearSelection() })}
    </div>
  );
}
