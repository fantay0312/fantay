// SPDX-License-Identifier: AGPL-3.0-only
// React bindings of the engine store (spec 03 §3.3): selector hooks over `useSyncExternalStore` with a server
// snapshot (amendment B2) and memoized selections, so a component re-renders only when its slice changes.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { isLod } from '../engine/culling';
import type { NodeView } from '../model/types';
import type { EngineState, EngineStore } from './board-store';
import { IDLE_RUNTIME } from './runtime-state';

interface ExternalStore<S> {
  getState(): S;
  subscribe(listener: () => void): () => void;
}

/**
 * `useSyncExternalStore` with a selector: the selection is recomputed only when the store state changes, and an
 * equal selection (by `isEqual`) keeps the previous value's identity.
 */
export function useStoreSelector<S, T>(
  store: ExternalStore<S>,
  selector: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const committed = useRef<{ value: T } | null>(null);
  const getSelection = useMemo(() => {
    let memo: { state: S; value: T } | null = null;
    return (): T => {
      const next = store.getState();
      if (memo && Object.is(memo.state, next)) return memo.value;
      const value = selector(next);
      // a fresh selector (inline function) still returns the committed value when the slice is equal
      const previous = memo ?? committed.current;
      if (previous && isEqual(previous.value, value)) {
        memo = { state: next, value: previous.value };
        return previous.value;
      }
      memo = { state: next, value };
      return value;
    };
  }, [store, selector, isEqual]);
  const value = useSyncExternalStore(store.subscribe, getSelection, getSelection);
  useEffect(() => {
    committed.current = { value };
  }, [value]);
  return value;
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) if (!Object.is(left[key], right[key])) return false;
  return true;
}

/** The per-node slice of the engine state (03 §3.3 `useNodeView`); null once the node left the document. */
export function selectNodeView(state: EngineState, id: string): NodeView | null {
  const node = state.doc.nodes.get(id);
  if (!node) return null;
  const { ui, settled } = state;
  const selected = state.selectionSet.has(id);
  const mode = ui.mode && ui.mode.nodeId === id ? ui.mode : null;
  return {
    node,
    runtime: state.runtime.get(id) ?? IDLE_RUNTIME,
    selected,
    soleSelected: selected && ui.selection.length === 1,
    hovered: ui.hoverId === id,
    live: state.liveIds.has(id),
    mode: mode ? mode.mode : null,
    captureTool: mode ? mode.captureTool : null,
    commenting: ui.tool === 'comment' && selected && ui.selection.length === 1 && ui.mode === null && !state.readOnly,
    previewRect: state.preview?.rects.get(id) ?? null,
    layoutZoom: settled.layoutZoom,
    settledZoom: settled.zoom,
    lod: isLod(node, settled.zoom),
    editingText: ui.editingTextId === id,
    renaming: ui.renamingId === id,
    readOnly: state.readOnly,
    spaceHeld: ui.spaceHeld,
    active: state.active,
    dropTarget: state.preview?.dropGroupId === id,
  };
}

export function useEngineSelector<T>(store: EngineStore, selector: (state: EngineState) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useStoreSelector(store, selector, isEqual);
}

export function useNodeViewFrom(store: EngineStore, id: string): NodeView | null {
  const selector = useMemo(() => (state: EngineState) => selectNodeView(state, id), [id]);
  return useStoreSelector<EngineState, NodeView | null>(store, selector, shallowEqual);
}
