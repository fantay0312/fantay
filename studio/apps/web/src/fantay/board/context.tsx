'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Board contexts (spec 03 §2 context.tsx). Two contexts keep re-renders local: the engine context is stable for
// the board's lifetime (node shells read it), the host context carries the 04 data value, the host environment
// and the extensions, which change more often. The label layer context is the screen-space portal host.
import { createContext, useContext, useEffect } from 'react';

import type { BoardDataValue } from './data/types';
import type { BoardExtensions } from './extensions';
import type { BoardEnvironment, BoardServices, NodeView } from './model/types';
import type { BoardEngine } from './store/board-engine';
import type { EngineState } from './store/board-store';
import { useEngineSelector, useNodeViewFrom } from './store/use-board';

export const BoardEngineContext = createContext<BoardEngine | null>(null);

export interface BoardHostValue {
  data: BoardDataValue;
  env: BoardEnvironment;
  extensions: BoardExtensions | undefined;
}

export const BoardHostContext = createContext<BoardHostValue | null>(null);

/** Screen-space element node labels are portalled into (null outside a board stage). */
export const BoardLabelLayerContext = createContext<HTMLElement | null>(null);

export function useBoardEngine(): BoardEngine {
  const engine = useContext(BoardEngineContext);
  if (!engine) throw new Error('useBoardEngine must be used inside <BoardView>');
  return engine;
}

export function useBoardHost(): BoardHostValue {
  const host = useContext(BoardHostContext);
  if (!host) throw new Error('useBoardHost must be used inside <BoardView>');
  return host;
}

/** Engine state slice; re-renders only when `isEqual` says the slice changed. */
export function useBoardSelector<T>(selector: (state: EngineState) => T, isEqual?: (a: T, b: T) => boolean): T {
  const engine = useBoardEngine();
  return useEngineSelector(engine.store, selector, isEqual);
}

/** Per-node slice for faces (03 §3.3 `useNodeView`). */
export function useNodeView(id: string): NodeView | null {
  const engine = useBoardEngine();
  return useNodeViewFrom(engine.store, id);
}

/** Registers optional board services (e.g. duplicating file-backed nodes) for the component's lifetime. */
export function useRegisterBoardServices(services: BoardServices): void {
  const engine = useBoardEngine();
  useEffect(() => engine.services.register(services), [engine, services]);
}
