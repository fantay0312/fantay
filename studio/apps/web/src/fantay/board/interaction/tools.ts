/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/lib/tools.ts @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the board tool set (V H F R O T G N,
 *   spec 03 §3.8), place tools, handle/connector/edge/label targets, read-only presses select instead of drag;
 *   the path tool dropped; labels are i18n keys. The Comment tool (C) came back for the board comment layer
 *   (`../comments/`): presses on nodes select (the selected frame then takes comment picks), the canvas pans.
 */
import type { BoardTool, DictKey } from '../model/types';

/* The board tools (bottom toolbar): what a pointer-down means depends on the tool, on what it landed on, and on
   a few modifiers. Resolved here, in one place, so the stage, nodes and handles agree on it. */

export const DRAW_TOOLS: ReadonlySet<BoardTool> = new Set<BoardTool>(['frame', 'rectangle', 'ellipse', 'text', 'pen']);
export const PLACE_TOOLS: ReadonlySet<BoardTool> = new Set<BoardTool>(['note', 'generate']);

export function isDrawTool(tool: BoardTool): boolean {
  return DRAW_TOOLS.has(tool);
}

export function isPlaceTool(tool: BoardTool): boolean {
  return PLACE_TOOLS.has(tool);
}

export const BOARD_TOOLS: ReadonlyArray<{ id: BoardTool; key: string; labelKey: DictKey }> = [
  { id: 'select', key: 'V', labelKey: 'board.tool.select' },
  { id: 'hand', key: 'H', labelKey: 'board.tool.hand' },
  { id: 'frame', key: 'F', labelKey: 'board.tool.frame' },
  { id: 'rectangle', key: 'R', labelKey: 'board.tool.rectangle' },
  { id: 'ellipse', key: 'O', labelKey: 'board.tool.ellipse' },
  { id: 'pen', key: 'P', labelKey: 'board.tool.pen' },
  { id: 'text', key: 'T', labelKey: 'board.tool.text' },
  { id: 'generate', key: 'G', labelKey: 'board.tool.generate' },
  { id: 'note', key: 'N', labelKey: 'board.tool.note' },
  { id: 'comment', key: 'C', labelKey: 'board.tool.comment' },
];

export type BoardPointerTarget = 'background' | 'node' | 'handle' | 'label' | 'edge' | 'connector';

export type PointerAction =
  /** drag the viewport */
  | 'pan'
  /** drag out a selection rectangle on the background */
  | 'marquee'
  /** select and move the node under the pointer */
  | 'node-drag'
  /** read-only boards: select the node under the pointer, never move it */
  | 'select'
  /** drag a resize handle */
  | 'resize'
  /** draw a frame, shape or text box */
  | 'draw'
  /** place a note or generator at the pointer */
  | 'place'
  /** drag a reference connection out of a connector dot */
  | 'connect'
  /** select the connection under the pointer */
  | 'edge-select'
  /** nothing — the press is not ours */
  | 'none';

export interface PointerContext {
  tool: BoardTool;
  target: BoardPointerTarget;
  /** `PointerEvent.button`: 0 = primary, 1 = middle */
  button: number;
  pointerType: string;
  /** the space bar is held: a temporary Hand, whatever the tool */
  spaceHeld: boolean;
  /** the node under the pointer is locked */
  locked: boolean;
  readOnly: boolean;
}

export function resolvePointerAction({ tool, target, button, pointerType, spaceHeld, locked, readOnly }: PointerContext): PointerAction {
  /* the middle button pans anywhere, in any tool */
  if (button === 1) return 'pan';
  if (button !== 0) return 'none';
  if (tool === 'hand' || spaceHeld) return 'pan';
  /* a read-only board can be looked at and selected (Navigate, add to chat), never edited */
  if (readOnly) {
    if (target === 'background') return 'pan';
    if (target === 'node' || target === 'label') return 'select';
    if (target === 'edge') return 'edge-select';
    return 'none';
  }
  /* Comment: a press picks the node to comment on (never drags it); the canvas pans, a click on it deselects */
  if (tool === 'comment') {
    if (target === 'node' || target === 'label') return 'select';
    if (target === 'background') return 'pan';
    return 'none';
  }
  if (isDrawTool(tool)) return 'draw';
  if (isPlaceTool(tool)) return 'place';
  if (target === 'handle') return 'resize';
  if (target === 'connector') return 'connect';
  if (target === 'edge') return 'edge-select';
  /* a finger on the background pans: touch has no space bar, and one-finger pan is how phones move around */
  if (target === 'background') return pointerType === 'touch' ? 'pan' : 'marquee';
  /* a locked node lets the press through: the board treats it as empty canvas */
  return locked ? 'marquee' : 'node-drag';
}

/** The tool a bare key press picks, or null when the key is not a tool key. */
export function toolForKey(key: string): BoardTool | null {
  const found = BOARD_TOOLS.find((t) => t.key.toLowerCase() === key.toLowerCase());
  return found?.id ?? null;
}
