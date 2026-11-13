import { describe, expect, it } from 'vitest';
import {
  applyBoardOps,
  emptyBoardDocument,
  stableBoardId,
  type BoardDocument,
  type BoardOp,
} from '@open-design/contracts';

import { en } from '../../../src/i18n/locales/en';
import { zhCN } from '../../../src/i18n/locales/zh-CN';
import type { Dict } from '../../../src/i18n/types';
import {
  boardSelectionContextItem,
  joinBoardDisplayPath,
  type BoardTranslate,
} from '../../../src/fantay/board/sync/context-items';

function translator(dict: Dict): BoardTranslate {
  return (key, vars) => {
    const raw = dict[key] ?? key;
    return vars ? raw.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`)) : raw;
  };
}

const t = translator(en);

let seq = 0;
function boardFrom(ops: BoardOp[]): BoardDocument {
  const outcome = applyBoardOps({ settings: { background: 'dots', autoPlace: true }, nodes: [], edges: [] }, ops, {
    baseRevision: 0,
    nextRevision: 1,
    actor: { kind: 'user' },
    now: 1,
    newId: (prefix) => `${prefix}_auto${(seq += 1)}`,
    checkConflicts: false,
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  return { ...emptyBoardDocument('p1'), ...outcome.content, revision: 1 };
}

const board = boardFrom([
  { op: 'add', node: { id: 'n_frame', kind: 'frame', ref: { path: 'pages/index.html' }, x: 0, y: 0 } },
  { op: 'add', node: { id: 'n_web', kind: 'web', url: 'https://example.com/pricing', x: 2000, y: 0 } },
  { op: 'add', node: { id: 'n_note', kind: 'note', text: 'Make it bolder', x: 0, y: 1200 } },
  { op: 'add', node: { id: 'n_hidden', kind: 'note', text: 'secret', hidden: true, x: 400, y: 1200 } },
  { op: 'add', node: { id: 'n_v1', kind: 'image', ref: { path: 'img/logo.variant-a.png' }, variantLabel: 'a', x: 0, y: 2400 } },
  { op: 'add', node: { id: 'n_v2', kind: 'image', ref: { path: 'img/logo.variant-b.png' }, variantLabel: 'b', x: 800, y: 2400 } },
  { op: 'group', ids: ['n_v1', 'n_v2'], group: { id: 'g_logo', role: 'variants', variantKey: 'img/logo#image' } },
]);

describe('boardSelectionContextItem', () => {
  it('returns null for an empty selection', () => {
    expect(boardSelectionContextItem({ board, selectedIds: [], t })).toBeNull();
    expect(boardSelectionContextItem({ board, selectedIds: ['n_hidden'], t })).toBeNull();
  });

  it('builds one item for a single file-backed node with path and absolutePath', () => {
    const item = boardSelectionContextItem({ board, selectedIds: ['n_frame'], t, projectDir: '/Users/me/project/' })!;
    expect(item).toEqual({
      id: 'board-selection:n_frame',
      kind: 'board-selection',
      label: 'index.html',
      tabId: '__board__',
      title: 'frame pages/index.html',
      path: 'pages/index.html',
      absolutePath: '/Users/me/project/pages/index.html',
      nodes: [{ id: 'n_frame', kind: 'frame', label: 'index.html', path: 'pages/index.html' }],
    });
  });

  it('carries the url for a single web node', () => {
    const item = boardSelectionContextItem({ board, selectedIds: ['n_web'], t })!;
    expect(item.url).toBe('https://example.com/pricing');
    expect(item.path).toBeUndefined();
    expect(item.label).toBe('example.com');
  });

  it('summarizes a multi-node selection and expands groups in paint order', () => {
    const item = boardSelectionContextItem({ board, selectedIds: ['g_logo', 'n_note', 'n_hidden'], t: translator(zhCN) })!;
    expect(item.label).toBe('画板选区（4）');
    expect(item.id).toBe('board-selection:g_logo,n_note,n_v1,n_v2');
    expect(item.path).toBeUndefined();
    // Paint order: the group was inserted where its first member was (after the note).
    expect(item.nodes?.map((node) => node.id)).toEqual(['n_note', 'g_logo', 'n_v1', 'n_v2']);
    expect(item.nodes?.[0]).toMatchObject({ kind: 'note', text: 'Make it bolder' });
    expect(item.nodes?.[1]).toMatchObject({ kind: 'group', label: 'logo · 2 个变体' });
    expect(item.nodes?.[2]).toMatchObject({ kind: 'image', path: 'img/logo.variant-a.png', group: 'logo · 2 个变体', variantLabel: 'A' });
    expect(item.title).toBe('note Make it bolder; group logo · 2 个变体; image img/logo.variant-a.png; image img/logo.variant-b.png');
  });

  it('caps the item at 24 nodes, hashes long ids and keeps the title within 500 chars', () => {
    const many = boardFrom(Array.from({ length: 30 }, (_, index) => ({
      op: 'add' as const,
      node: { id: `n_long_identifier_${String(index).padStart(2, '0')}`, kind: 'note' as const, text: `note ${index} ${'x'.repeat(40)}`, x: index * 400, y: 0 },
    })));
    const ids = many.nodes.map((node) => node.id);
    const item = boardSelectionContextItem({ board: many, selectedIds: ids, t })!;
    expect(item.nodes).toHaveLength(24);
    expect(item.label).toBe('Board selection (30)');
    const joined = ids.slice(0, 24).sort().join(',');
    expect(joined.length).toBeGreaterThan(200);
    expect(item.id).toBe(`board-selection:${stableBoardId('n', joined)}`);
    expect(item.title!.length).toBeLessThanOrEqual(500);
    expect(item.title!.endsWith('…')).toBe(true);
  });
});

describe('joinBoardDisplayPath', () => {
  it('joins like FileWorkspace joinDisplayPath', () => {
    expect(joinBoardDisplayPath('/a/b/', '/c.html')).toBe('/a/b/c.html');
    expect(joinBoardDisplayPath('C:\\proj\\', 'x/y.png')).toBe('C:\\proj/x/y.png');
    expect(joinBoardDisplayPath('/a', '')).toBe('/a');
  });
});
