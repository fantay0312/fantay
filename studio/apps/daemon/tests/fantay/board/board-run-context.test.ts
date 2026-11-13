import { describe, expect, it } from 'vitest';

import {
  BOARD_SELECTION_TOOL_HINT,
  formatBoardSelectionNodes,
  normalizeBoardSelectionNodes,
} from '../../../src/fantay/board/run-context.js';
import {
  normalizeWorkspaceContextItems,
  renderRunContextPrompt,
} from '../../../src/runtimes/chat-run-context.js';

const selection = {
  id: 'board-selection:n_frame01,n_note01',
  kind: 'board-selection',
  label: '2 selected',
  tabId: '__board__',
  title: 'frame index.html; note Make the hero bolder',
  nodes: [
    { id: 'n_frame01', kind: 'frame', label: 'Landing', path: 'index.html', group: 'Turn 1', variantLabel: 'B' },
    { id: 'n_note01', kind: 'note', label: 'Note', text: 'Make the\n  hero bolder' },
    { id: 'n_web01', kind: 'web', label: 'Reference', url: 'https://example.com/pricing' },
  ],
};

describe('board-selection run context', () => {
  it('renders the selected nodes under the context item and adds the board hint once', () => {
    const prompt = renderRunContextPrompt({ workspaceItems: [selection] }, {});
    expect(prompt).toContain('## Selected run context');
    expect(prompt).toContain('1. board-selection: 2 selected (`board-selection:n_frame01,n_note01`)');
    expect(prompt).toContain('   - frame "Landing" (`n_frame01`) path: `index.html` group: Turn 1 variant: B');
    expect(prompt).toContain('   - note "Note" (`n_note01`) text: "Make the hero bolder"');
    expect(prompt).toContain('   - web "Reference" (`n_web01`) url: https://example.com/pricing');
    expect(prompt).toContain(BOARD_SELECTION_TOOL_HINT);
    expect(prompt.split(BOARD_SELECTION_TOOL_HINT)).toHaveLength(2);
  });

  it('drops invalid nodes and caps the selection at 24', () => {
    const nodes = normalizeBoardSelectionNodes([
      { id: 'bad id!', kind: 'frame', label: 'x' },
      { id: 'n_ok0001', kind: 'not-a-kind', label: 'x' },
      { id: 'n_ok0002', kind: 'note', label: '   ' },
      { id: 'n_ok0003', kind: 'image', label: 'L'.repeat(200), path: 'p'.repeat(600), text: 't'.repeat(600), variantLabel: 'v'.repeat(40) },
      { id: 'n_ok0003', kind: 'image', label: 'duplicate' },
      'not an object',
      ...Array.from({ length: 40 }, (_, index) => ({ id: `n_many${String(index).padStart(3, '0')}`, kind: 'note', label: `n${index}` })),
    ])!;
    expect(nodes).toHaveLength(24);
    expect(nodes[0]).toEqual({
      id: 'n_ok0003',
      kind: 'image',
      label: 'L'.repeat(120),
      path: 'p'.repeat(500),
      text: 't'.repeat(500),
      variantLabel: 'v'.repeat(32),
    });
    expect(nodes.map((node) => node.id)).not.toContain('bad id!');
    expect(normalizeBoardSelectionNodes('nope')).toBeUndefined();
    expect(normalizeBoardSelectionNodes([{ id: 'x', kind: 'note', label: 'too short id' }])).toBeUndefined();
  });

  it('keeps nodes only on board-selection items and drops an empty node list', () => {
    const items = normalizeWorkspaceContextItems([
      selection,
      { id: 'file-1', kind: 'file', label: 'App', path: 'src/app.ts', nodes: selection.nodes },
      { id: 'board-selection:empty', kind: 'board-selection', label: 'Nothing valid', nodes: [{ id: '!', kind: 'x', label: '' }] },
    ]);
    expect(items[0]!.nodes).toHaveLength(3);
    expect(items[1]).toEqual({ id: 'file-1', kind: 'file', label: 'App', path: 'src/app.ts' });
    expect(items[2]).toEqual({ id: 'board-selection:empty', kind: 'board-selection', label: 'Nothing valid' });
    const prompt = renderRunContextPrompt({ workspaceItems: [items[1], items[2]] }, {});
    expect(prompt).not.toContain('   - ');
    expect(prompt).toContain(BOARD_SELECTION_TOOL_HINT);
  });

  it('formats one line per node', () => {
    expect(formatBoardSelectionNodes([
      { id: 'n_a00001', kind: 'design', label: 'Poster', path: 'designs/poster.fig' },
      { id: 'n_b00001', kind: 'generator', label: 'Generator', text: 'neon city' },
    ])).toBe([
      '   - design "Poster" (`n_a00001`) path: `designs/poster.fig`',
      '   - generator "Generator" (`n_b00001`) text: "neon city"',
    ].join('\n'));
  });
});
