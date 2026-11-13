// SPDX-License-Identifier: AGPL-3.0-only
// 04 focus intents (spec 04 §7.5, plan R2): `fly-to` animates the camera to the nodes and selects them;
// `reveal-pill` shows a non-modal pill that flies on click. Every intent is acknowledged once executed; intents
// wait for the first camera (initial viewport or fit) so they are not overwritten by it.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { BoardDataValue, BoardFocusIntent } from '../data/types';
import type { BoardEngine } from '../store/board-engine';

export interface RevealPillState {
  nonce: number;
  nodeIds: string[];
  primaryId: string | null;
}

function orderedIds(intent: Pick<BoardFocusIntent, 'nodeIds' | 'primaryNodeId'>, has: (id: string) => boolean): string[] {
  const ids = intent.nodeIds.filter(has);
  if (intent.primaryNodeId && ids.includes(intent.primaryNodeId)) {
    return [intent.primaryNodeId, ...ids.filter((id) => id !== intent.primaryNodeId)];
  }
  return ids;
}

/** Runs one intent; returns the pill to show for `reveal-pill`, else null. */
export function executeFocusIntent(engine: BoardEngine, intent: BoardFocusIntent): RevealPillState | null {
  const { doc } = engine.store.getState();
  // the nodes may sit on another page: `select` shows it
  const onBoard = new Set(doc.source?.nodes.map((node) => node.id) ?? doc.nodes.keys());
  const ids = orderedIds(intent, (id) => onBoard.has(id));
  if (ids.length === 0) return null;
  if (intent.behavior === 'reveal-pill') return { nonce: intent.nonce, nodeIds: ids, primaryId: ids[0] ?? null };
  engine.commands.select(ids);
  engine.commands.focusNodes(ids, { animate: true });
  return null;
}

export interface BoardFocusIntentState {
  pill: RevealPillState | null;
  /** fly to the pill's nodes and hide it */
  openPill(): void;
  dismissPill(): void;
}

export const REVEAL_PILL_TIMEOUT_MS = 12_000;

export function useBoardFocusIntent(engine: BoardEngine, data: BoardDataValue, active: boolean): BoardFocusIntentState {
  const [pill, setPill] = useState<RevealPillState | null>(null);
  const handled = useRef<number | null>(null);
  const intent = data.focusIntent;
  const ack = data.ackFocusIntent;

  useEffect(() => {
    if (!intent || !active || handled.current === intent.nonce) return undefined;
    const run = (): void => {
      if (handled.current === intent.nonce) return;
      handled.current = intent.nonce;
      const next = executeFocusIntent(engine, intent);
      setPill(next);
      ack(intent.nonce);
    };
    if (engine.runtime.cameraReady()) {
      run();
      return undefined;
    }
    return engine.runtime.onCameraReady(run);
  }, [engine, intent, active, ack]);

  useEffect(() => {
    if (!pill) return undefined;
    const timer = setTimeout(() => setPill((current) => (current?.nonce === pill.nonce ? null : current)), REVEAL_PILL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pill]);

  const openPill = useCallback(() => {
    if (pill) {
      engine.commands.select(pill.nodeIds);
      engine.commands.focusNodes(pill.nodeIds, { animate: true });
    }
    setPill(null);
  }, [engine, pill]);

  const dismissPill = useCallback(() => setPill(null), []);

  return { pill, openPill, dismissPill };
}
