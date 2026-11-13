/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: tests/tools.test.ts @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the board tool set; comment cases
 *   replaced by draw/place, handle, connector, edge, locked and read-only cases (spec 03 §12).
 */
import { describe, expect, it } from 'vitest';

import {
  BOARD_TOOLS,
  isDrawTool,
  isPlaceTool,
  resolvePointerAction,
  toolForKey,
  type PointerContext,
} from '../../../src/fantay/board/interaction/tools';

const mouse = (over: Partial<PointerContext>): PointerContext => ({
  tool: 'select',
  target: 'background',
  button: 0,
  pointerType: 'mouse',
  spaceHeld: false,
  locked: false,
  readOnly: false,
  ...over,
});

describe('resolvePointerAction', () => {
  it('Select: marquee on the background, drag on a node or its label', () => {
    expect(resolvePointerAction(mouse({ target: 'background' }))).toBe('marquee');
    expect(resolvePointerAction(mouse({ target: 'node' }))).toBe('node-drag');
    expect(resolvePointerAction(mouse({ target: 'label' }))).toBe('node-drag');
  });

  it('Hand: pans wherever the press lands, nodes included', () => {
    expect(resolvePointerAction(mouse({ tool: 'hand', target: 'background' }))).toBe('pan');
    expect(resolvePointerAction(mouse({ tool: 'hand', target: 'node' }))).toBe('pan');
  });

  it('space held is a temporary Hand in every tool', () => {
    for (const { id: tool } of BOARD_TOOLS) {
      expect(resolvePointerAction(mouse({ tool, target: 'node', spaceHeld: true }))).toBe('pan');
      expect(resolvePointerAction(mouse({ tool, target: 'background', spaceHeld: true }))).toBe('pan');
    }
  });

  it('the middle button pans in every tool; other buttons are not ours', () => {
    for (const { id: tool } of BOARD_TOOLS) {
      expect(resolvePointerAction(mouse({ tool, target: 'node', button: 1 }))).toBe('pan');
      expect(resolvePointerAction(mouse({ tool, target: 'node', button: 2 }))).toBe('none');
    }
  });

  it('a finger on the background pans, on a node it drags', () => {
    expect(resolvePointerAction(mouse({ pointerType: 'touch', target: 'background' }))).toBe('pan');
    expect(resolvePointerAction(mouse({ pointerType: 'touch', target: 'node' }))).toBe('node-drag');
  });

  it('draw tools draw and place tools place, on nodes and background, for every pointer type', () => {
    for (const tool of ['frame', 'rectangle', 'ellipse', 'text'] as const) {
      for (const pointerType of ['mouse', 'touch', 'pen']) {
        expect(resolvePointerAction(mouse({ tool, pointerType, target: 'background' }))).toBe('draw');
        expect(resolvePointerAction(mouse({ tool, pointerType, target: 'node' }))).toBe('draw');
      }
    }
    expect(resolvePointerAction(mouse({ tool: 'note', target: 'background' }))).toBe('place');
    expect(resolvePointerAction(mouse({ tool: 'generate', target: 'node' }))).toBe('place');
  });

  it('handles resize, connector dots connect, edges select', () => {
    expect(resolvePointerAction(mouse({ target: 'handle' }))).toBe('resize');
    expect(resolvePointerAction(mouse({ target: 'connector' }))).toBe('connect');
    expect(resolvePointerAction(mouse({ target: 'edge' }))).toBe('edge-select');
  });

  it('Comment: nodes and labels select (never drag), the canvas pans, handles and edges are not its', () => {
    expect(resolvePointerAction(mouse({ tool: 'comment', target: 'node' }))).toBe('select');
    expect(resolvePointerAction(mouse({ tool: 'comment', target: 'label' }))).toBe('select');
    expect(resolvePointerAction(mouse({ tool: 'comment', target: 'node', locked: true }))).toBe('select');
    expect(resolvePointerAction(mouse({ tool: 'comment', target: 'background' }))).toBe('pan');
    expect(resolvePointerAction(mouse({ tool: 'comment', target: 'handle' }))).toBe('none');
    expect(resolvePointerAction(mouse({ tool: 'comment', target: 'edge' }))).toBe('none');
  });

  it('a locked node lets the press through as canvas (marquee)', () => {
    expect(resolvePointerAction(mouse({ target: 'node', locked: true }))).toBe('marquee');
  });

  it('read-only: pan on the background, select (never drag) on nodes, nothing on handles', () => {
    expect(resolvePointerAction(mouse({ readOnly: true, target: 'background' }))).toBe('pan');
    expect(resolvePointerAction(mouse({ readOnly: true, target: 'node' }))).toBe('select');
    expect(resolvePointerAction(mouse({ readOnly: true, target: 'handle' }))).toBe('none');
    expect(resolvePointerAction(mouse({ readOnly: true, tool: 'rectangle', target: 'background' }))).toBe('pan');
  });
});

describe('toolForKey', () => {
  it('maps V H F R O T G N C to their tools, either case', () => {
    expect(['v', 'H', 'f', 'R', 'o', 'T', 'g', 'N', 'c'].map(toolForKey)).toEqual([
      'select', 'hand', 'frame', 'rectangle', 'ellipse', 'text', 'generate', 'note', 'comment',
    ]);
  });

  it('knows nothing about other keys', () => {
    expect(toolForKey('q')).toBeNull();
    expect(toolForKey('Escape')).toBeNull();
    expect(toolForKey('p')).toBeNull();
  });

  it('has no duplicate keys; draw and place sets are disjoint', () => {
    expect(new Set(BOARD_TOOLS.map((t) => t.key)).size).toBe(BOARD_TOOLS.length);
    for (const { id } of BOARD_TOOLS) expect(isDrawTool(id) && isPlaceTool(id)).toBe(false);
  });
});
