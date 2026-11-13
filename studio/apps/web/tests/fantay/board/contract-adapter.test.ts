// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { applyBoardChangeSet, applyBoardOps, type BoardDocument, type BoardNode } from '@open-design/contracts';

import {
  applyNodePatch,
  diffNodes,
  findNodeByPath,
  nodeFilePath,
  toContractNode,
  toEngineDoc,
  toEngineNode,
} from '../../../src/fantay/board/model/contract-adapter';
import { formatLabel, nodeLabelSpec } from '../../../src/fantay/board/model/labels';
import { frameDraft, groupDraft, makeBoard, noteDraft, PROJECT_ID, testId } from './engine-fixtures';

function patchBoard(board: BoardDocument, ops: Parameters<typeof applyBoardOps>[1]): BoardDocument {
  const outcome = applyBoardOps(board, ops, {
    baseRevision: board.revision,
    nextRevision: board.revision + 1,
    actor: { kind: 'user' },
    now: 5_000,
    newId: (prefix) => testId(prefix),
    checkConflicts: false,
  });
  if (!outcome.ok) throw new Error('patch failed');
  return applyBoardChangeSet(board, outcome.changes);
}

describe('contract adapter', () => {
  it('derives engine nodes with contract field names and paint order (groups beneath others)', () => {
    const board = makeBoard([
      noteDraft('n_note', 0, 0, 'hi'),
      groupDraft('n_group', -100, -100, 2000, 1200),
      frameDraft('n_page', 400, 0, 'pages/home.html'),
    ]);
    const doc = toEngineDoc(board, PROJECT_ID);
    expect(doc.order).toEqual(['n_group', 'n_note', 'n_page']);
    expect(doc.arrayIndex.get('n_page')).toBe(2);
    const page = doc.nodes.get('n_page')!;
    expect(page).toMatchObject({ id: 'n_page', kind: 'frame', x: 400, y: 0, w: 1440, h: 900, parentId: null, locked: false, hidden: false });
    expect(page.kind === 'frame' && page.data.ref?.path).toBe('pages/home.html');
    expect(page.kind === 'frame' && page.data.device).toBe('desktop');
    expect(nodeFilePath(page)).toBe('pages/home.html');
    expect(findNodeByPath(doc, 'pages/home.html')?.id).toBe('n_page');
  });

  it('memoizes engine nodes per contract node: unchanged nodes keep their identity', () => {
    const board = makeBoard([noteDraft('n_a', 0, 0), noteDraft('n_b', 400, 0)]);
    const first = toEngineDoc(board, PROJECT_ID);
    expect(toEngineDoc(board, PROJECT_ID, first)).toBe(first);
    const next = patchBoard(board, [{ op: 'update', id: 'n_b', patch: { text: 'changed' } }]);
    const second = toEngineDoc(next, PROJECT_ID, first);
    expect(second).not.toBe(first);
    expect(second.nodes.get('n_a')).toBe(first.nodes.get('n_a'));
    expect(second.nodes.get('n_b')).not.toBe(first.nodes.get('n_b'));
    expect(second.order).toBe(first.order); // same paint order → same array
  });

  it('round-trips to the contract node and keeps unknown keys', () => {
    const board = makeBoard([noteDraft('n_a', 0, 0, 'x')]);
    const raw = { ...board.nodes[0]!, futureField: { nested: true } } as unknown as BoardNode;
    const engine = toEngineNode(raw);
    expect(toContractNode(engine)).toBe(raw);
    expect(toEngineNode(raw)).toBe(engine);
    const patched = applyNodePatch(raw, { text: 'y', size: 'lg' });
    expect((patched as unknown as Record<string, unknown>).futureField).toEqual({ nested: true });
    expect(diffNodes(raw, patched)).toEqual({ text: 'y', size: 'lg' });
    expect(diffNodes(patched, applyNodePatch(patched, { size: null }))).toEqual({ size: null });
    expect(diffNodes(raw, raw)).toBeNull();
  });

  it('drops edges whose endpoints are gone and indexes group children', () => {
    const board = makeBoard([
      groupDraft('n_g', 0, 0, 800, 600),
      { ...noteDraft('n_c', 40, 60), parentId: 'n_g' } as Parameters<typeof makeBoard>[0][number],
    ]);
    const withDangling: BoardDocument = {
      ...board,
      edges: [{ id: 'e_dangling', kind: 'lineage', from: 'n_c', to: 'n_missing', createdAt: 1, createdBy: { kind: 'user' }, updatedBy: { kind: 'user' }, rev: 1 }],
    };
    const doc = toEngineDoc(withDangling, PROJECT_ID);
    expect(doc.edges.size).toBe(0);
    expect(doc.children.get('n_g')).toEqual(['n_c']);
    expect(doc.nodes.get('n_c')?.parentId).toBe('n_g');
  });

  it('labels variant children "版本 {index} · {label}" from the group order', () => {
    const board = makeBoard([
      groupDraft('n_v', 0, 0, 3200, 1000, { role: 'variants' }),
      { ...frameDraft('n_b', 1600, 0, 'landing.variant-b.html'), parentId: 'n_v', variantLabel: 'b' } as Parameters<typeof makeBoard>[0][number],
      { ...frameDraft('n_a', 0, 0, 'landing.variant-a.html'), parentId: 'n_v', variantLabel: 'a' } as Parameters<typeof makeBoard>[0][number],
    ]);
    const doc = toEngineDoc(board, PROJECT_ID);
    const t = (key: string, vars?: Record<string, string | number>) => `${key}:${JSON.stringify(vars ?? {})}`;
    expect(formatLabel(nodeLabelSpec(doc, doc.nodes.get('n_a')!), t)).toBe('board.node.variantTitle:{"index":1,"name":"A"}');
    expect(formatLabel(nodeLabelSpec(doc, doc.nodes.get('n_b')!), t)).toBe('board.node.variantTitle:{"index":2,"name":"B"}');
    expect(formatLabel(nodeLabelSpec(doc, doc.nodes.get('n_v')!), t)).toBe('board.node.variantsGroup:{"title":"board.kind.group:{}","count":2}');
  });

  it('labels file nodes by file name and untitled nodes by key', () => {
    const board = makeBoard([frameDraft('n_page', 0, 0, 'pages/pricing.html'), noteDraft('n_note', 2000, 0)]);
    const doc = toEngineDoc(board, PROJECT_ID);
    const t = (key: string) => key;
    expect(formatLabel(nodeLabelSpec(doc, doc.nodes.get('n_page')!), t)).toBe('pricing.html');
    expect(formatLabel(nodeLabelSpec(doc, doc.nodes.get('n_note')!), t)).toBe('board.node.untitled');
  });

  it('an empty or missing document derives an empty engine document', () => {
    const empty = toEngineDoc(null, PROJECT_ID);
    expect(empty.nodes.size).toBe(0);
    expect(toEngineDoc(null, PROJECT_ID, empty)).toBe(empty);
  });
});
