// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { BoardNodeDraft } from '@open-design/contracts';

import { toEngineDoc } from '../../../src/fantay/board/model/contract-adapter';
import {
  cycleSelection,
  dragSetFor,
  marqueeHits,
  marqueeSelect,
  pressSelect,
  pruneRemoved,
  readingOrder,
  selectAll,
  toggleSelect,
} from '../../../src/fantay/board/store/selection';
import { groupDraft, makeBoard, noteDraft, PROJECT_ID } from './engine-fixtures';

const child = (draft: BoardNodeDraft, parentId: string): BoardNodeDraft => ({ ...draft, parentId }) as BoardNodeDraft;

describe('selection reducers', () => {
  it('a click replaces the selection; Shift/⌘ toggles', () => {
    expect(pressSelect(['a', 'b'], 'c', false)).toEqual(['c']);
    expect(pressSelect(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(pressSelect(['a', 'b'], 'a', true)).toEqual(['b']);
    expect(toggleSelect([], 'x')).toEqual(['x']);
  });

  it('a click inside a multi-selection keeps it (the drag moves the group)', () => {
    const selection = ['a', 'b', 'c'];
    expect(pressSelect(selection, 'b', false)).toBe(selection);
  });

  it('marquee: intersecting nodes, groups only when fully enclosed, locked/hidden excluded', () => {
    const doc = toEngineDoc(
      makeBoard([
        groupDraft('n_group', 0, 0, 600, 400),
        child(noteDraft('n_in', 40, 60), 'n_group'),
        noteDraft('n_partial', 700, 0),
        { ...noteDraft('n_locked', 100, 500), locked: true } as BoardNodeDraft,
        { ...noteDraft('n_hidden', 200, 500), hidden: true } as BoardNodeDraft,
      ]),
      PROJECT_ID,
    );
    const partial = marqueeHits(doc.nodes.values(), { x: 0, y: 0, w: 750, h: 300 });
    expect(partial).toEqual(['n_in', 'n_partial']);
    const enclosing = marqueeHits(doc.nodes.values(), { x: -10, y: -10, w: 1100, h: 1000 });
    expect(enclosing).toEqual(['n_group', 'n_in', 'n_partial']);
  });

  it('Shift-marquee keeps the previous selection and appends new hits', () => {
    expect(marqueeSelect(['a'], ['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
    expect(marqueeSelect([], ['b'])).toEqual(['b']);
  });

  it('⌘A selects every non-locked, non-hidden node in paint order', () => {
    const doc = toEngineDoc(
      makeBoard([
        noteDraft('n_a', 0, 0),
        { ...noteDraft('n_locked', 400, 0), locked: true } as BoardNodeDraft,
        groupDraft('n_g', 0, 800, 400, 400),
      ]),
      PROJECT_ID,
    );
    expect(selectAll(doc)).toEqual(['n_g', 'n_a']);
  });

  it('Tab reading order: rows by y with a 40 px tolerance, then x', () => {
    const doc = toEngineDoc(
      makeBoard([
        noteDraft('n_row1_right', 800, 30),
        noteDraft('n_row2', 0, 400),
        noteDraft('n_row1_left', 0, 0),
        noteDraft('n_row1_mid', 400, 40),
      ]),
      PROJECT_ID,
    );
    expect(readingOrder([...doc.nodes.values()])).toEqual(['n_row1_left', 'n_row1_mid', 'n_row1_right', 'n_row2']);
    expect(cycleSelection(doc, [], 1)).toBe('n_row1_left');
    expect(cycleSelection(doc, ['n_row1_mid'], 1)).toBe('n_row1_right');
    expect(cycleSelection(doc, ['n_row2'], 1)).toBe('n_row1_left');
    expect(cycleSelection(doc, ['n_row1_left'], -1)).toBe('n_row2');
  });

  it('prunes ids that left the document but keeps ids it never had (optimistic adds)', () => {
    const before = toEngineDoc(makeBoard([noteDraft('n_a', 0, 0), noteDraft('n_b', 400, 0)]), PROJECT_ID);
    const after = toEngineDoc(makeBoard([noteDraft('n_a', 0, 0)]), PROJECT_ID);
    expect(pruneRemoved(['n_a', 'n_b', 'n_new'], before, after)).toEqual(['n_a', 'n_new']);
    const same = ['n_a'];
    expect(pruneRemoved(same, before, after)).toBe(same);
  });

  it('drag set: selected unlocked nodes plus the descendants of selected groups; roots carry the move', () => {
    const doc = toEngineDoc(
      makeBoard([
        groupDraft('n_g', 0, 0, 800, 600),
        child(noteDraft('n_c1', 40, 60), 'n_g'),
        child(noteDraft('n_c2', 400, 60), 'n_g'),
        noteDraft('n_free', 1000, 0),
        { ...noteDraft('n_locked', 1400, 0), locked: true } as BoardNodeDraft,
      ]),
      PROJECT_ID,
    );
    const set = dragSetFor(doc, ['n_g', 'n_c1', 'n_free', 'n_locked']);
    expect(set.roots.sort()).toEqual(['n_free', 'n_g']);
    expect(set.all.sort()).toEqual(['n_c1', 'n_c2', 'n_free', 'n_g']);
  });
});
