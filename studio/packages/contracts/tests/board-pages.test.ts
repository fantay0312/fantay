import { describe, expect, it } from 'vitest';

import {
  applyBoardChangeSet,
  applyBoardOps,
  boardNodesOnPage,
  boardPagesOf,
  emptyBoardContent,
  emptyBoardDocument,
  nextBoardPageTitle,
  resolveBoardPageId,
  type BoardApplyContext,
  type BoardContent,
  type BoardOp,
} from '../src/index.js';

const context: BoardApplyContext = {
  baseRevision: 0,
  nextRevision: 1,
  actor: { kind: 'user' },
  now: 1_000,
  newId: (prefix) => `${prefix}_generated`,
  checkConflicts: false,
};

const pages = [{ id: 'page_1', title: 'Page 1' }, { id: 'page_two', title: 'Page 2' }];

function apply(content: BoardContent, ops: BoardOp[]): BoardContent {
  const outcome = applyBoardOps(content, ops, context);
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  return outcome.content;
}

const note = (id: string, page?: string): BoardOp => ({
  op: 'add',
  node: { id, kind: 'note', text: id, ...(page ? { page } : {}) } as Extract<BoardOp, { op: 'add' }>['node'],
});

describe('board pages', () => {
  it('reads a board without pages as one implicit page', () => {
    expect(boardPagesOf(emptyBoardContent())).toHaveLength(1);
    expect(resolveBoardPageId(boardPagesOf({}), 'gone')).toBe(boardPagesOf({})[0]!.id);
  });

  it('numbers new pages past the titles in use', () => {
    expect(nextBoardPageTitle(pages)).toBe('Page 3');
    expect(nextBoardPageTitle([{ id: 'a_a', title: 'Page 2' }])).toBe('Page 3');
  });

  it('places a new node against its own page only', () => {
    const content = apply(emptyBoardContent(), [{ op: 'set-meta', pages }, note('n_one'), note('n_two', 'page_two')]);
    const [first] = boardNodesOnPage(content.nodes, pages, 'page_1');
    const [second] = boardNodesOnPage(content.nodes, pages, 'page_two');
    expect(first?.id).toBe('n_one');
    expect(second?.id).toBe('n_two');
    expect({ x: second?.x, y: second?.y }).toEqual({ x: first?.x, y: first?.y });
  });

  it('keeps a node with its group, whatever page the draft names', () => {
    const content = apply(emptyBoardContent(), [
      { op: 'set-meta', pages },
      note('n_one', 'page_two'),
      { op: 'group', ids: ['n_one'], group: { id: 'n_group', role: 'section' } },
      { op: 'add', node: { id: 'n_child', kind: 'note', text: '', parentId: 'n_group', page: 'page_1' } as Extract<BoardOp, { op: 'add' }>['node'] },
    ]);
    expect(content.nodes.find((node) => node.id === 'n_group')?.page).toBe('page_two');
    expect(content.nodes.find((node) => node.id === 'n_child')?.page).toBe('page_two');
  });

  it('restores pages and their nodes from the inverse of a page removal', () => {
    const before = apply(emptyBoardContent(), [{ op: 'set-meta', pages }, note('n_two', 'page_two')]);
    const outcome = applyBoardOps(before, [
      { op: 'remove', ids: ['n_two'] },
      { op: 'set-meta', pages: pages.slice(0, 1) },
    ], context);
    if (!outcome.ok) throw new Error('remove failed');
    expect(outcome.changes.meta?.pages).toEqual(pages.slice(0, 1));
    const after = apply(outcome.content, outcome.inverse.map((op) => (op.op === 'restore' ? { ...op, expectRev: {} } : op)));
    expect(after.pages).toEqual(pages);
    expect(after.nodes.map((node) => node.id)).toEqual(['n_two']);
  });

  it('carries pages through a change set and clears them with null', () => {
    const doc = emptyBoardDocument('p');
    const set = { fromRevision: 0, toRevision: 1, upsertNodes: [], removeNodeIds: [], upsertEdges: [], removeEdgeIds: [] };
    const withPages = applyBoardChangeSet(doc, { ...set, meta: { title: null, settings: doc.settings, pages } });
    expect(withPages.pages).toEqual(pages);
    const kept = applyBoardChangeSet(withPages, { ...set, fromRevision: 1, toRevision: 2, meta: { title: null, settings: doc.settings } });
    expect(kept.pages).toEqual(pages);
    const cleared = applyBoardChangeSet(kept, { ...set, fromRevision: 2, toRevision: 3, meta: { title: null, settings: doc.settings, pages: null } });
    expect(cleared.pages).toBeUndefined();
  });
});
