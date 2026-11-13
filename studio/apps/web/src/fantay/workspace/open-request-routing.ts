// SPDX-License-Identifier: AGPL-3.0-only
// Where an open request lands while the workspace shows 画板 (spec 02 §5.6 minus rule 3, plan R8).
// Pure; consumed by `useFantayWorkspace().consumeOpenRequest`.
import { MOVIE_DOCUMENT_FILE } from '@open-design/contracts';

import { isSideChatTabId, isTerminalTabId } from '../../types';
import { BOARD_TAB } from './board-host-contract';

const DESIGN_EDITOR_FILE = /\.(fig|op|penpot)$/i;

/**
 * basename === 'movie-studio.json' || /\.(fig|op|penpot)$/i. Kept for callers that need the editor
 * kind; routing no longer sends these to tabs (R8 dropped spec 02 rule 3).
 */
export function isFantayEditorFileName(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return base === MOVIE_DOCUMENT_FILE || DESIGN_EDITOR_FILE.test(base);
}

/**
 * Rules, in order:
 *  1 !boardReady || activeTab !== BOARD_TAB → 'tab'
 *  2 routeFileName && name === routeFileName (explicit deep link) → 'tab'
 *  (3 dropped by plan R8: agent focus on movie-studio.json / .fig / .op focuses the board node; explicit
 *     opening uses deep links, `workspace.openEditor` or node actions)
 *  4 isTerminalTabId(name) || isSideChatTabId(name) || name.startsWith('__') → 'tab'
 *  5 otherwise (file names and `live:` ids) → 'board'
 */
export function routeOpenRequestTarget(input: {
  name: string; activeTab: string; routeFileName: string | null | undefined; boardReady: boolean;
}): 'board' | 'tab' {
  const { name, activeTab, routeFileName, boardReady } = input;
  if (!boardReady || activeTab !== BOARD_TAB) return 'tab';
  if (routeFileName && name === routeFileName) return 'tab';
  if (isTerminalTabId(name) || isSideChatTabId(name) || name.startsWith('__')) return 'tab';
  return 'board';
}
