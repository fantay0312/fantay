/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — page contexts. Actions are one stable object (cards can be memoised);
 * the changing state (items, spaces, selection, nav) lives in a second context that only menus,
 * bars and panels read.
 */
import { createContext, useContext, type DragEvent } from 'react';
import type { WorkbenchItem, WorkbenchPage, WorkbenchSpace } from '@open-design/contracts';
import type { QuickCaptureRequest } from '../capture-bus';
import type { LibNav } from './library';

export interface PointerMods { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }

export interface LibraryActions {
  /** Click semantics: plain = only this, ⌘/Ctrl = toggle, Shift = range from the anchor. */
  select(id: string, mods?: PointerMods): void;
  setSelection(ids: string[], anchor?: string | null): void;
  clearSelection(): void;
  /** Select and show in the inspector. */
  open(id: string): void;
  openReader(id: string): void;
  star(ids: string[], starred: boolean): void;
  moveToSpace(ids: string[], spaceId: string | null): void;
  keep(ids: string[]): void;
  trash(ids: string[]): void;
  restore(ids: string[]): void;
  deleteForever(ids: string[]): void;
  organize(ids: string[]): Promise<void>;
  produce(id: string, withImages?: boolean): void;
  openProduction(id: string): void;
  editTags(ids: string[]): void;
  /** Open the new-space dialog; the given items move into the space once it exists. */
  createSpace(moveIds?: string[]): void;
  navigate(nav: LibNav): void;
  /** Switch to another workbench page (内容, 排期 …). */
  gotoPage(page: WorkbenchPage): void;
  openSettings(): void;
  capture(request?: QuickCaptureRequest): void;
  ask(prompt?: string): void;
  /** Targets for an action started on `id`: the whole selection when `id` is part of it. */
  targetsFor(id: string): string[];
  /** Start an HTML drag of `id` (or the selection containing it) toward the rail. */
  dragStart(id: string, event: DragEvent): void;
}

export interface LibraryState {
  items: WorkbenchItem[];
  byId: Map<string, WorkbenchItem>;
  spaces: WorkbenchSpace[];
  selection: ReadonlySet<string>;
  nav: LibNav;
  /** Ids being organised by AI right now. */
  organizing: ReadonlySet<string>;
}

export const ActionsContext = createContext<LibraryActions | null>(null);
export const StateContext = createContext<LibraryState | null>(null);

export function useActions(): LibraryActions {
  const value = useContext(ActionsContext);
  if (!value) throw new Error('useActions outside InspirationPage');
  return value;
}

export function useLibraryState(): LibraryState {
  const value = useContext(StateContext);
  if (!value) throw new Error('useLibraryState outside InspirationPage');
  return value;
}
