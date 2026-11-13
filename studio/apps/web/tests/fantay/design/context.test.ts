// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { DesignSelection } from '@open-design/contracts';

import { designSelectionToWorkspaceItem } from '../../../src/fantay/design/context';

const SELECTION: DesignSelection = {
  pageId: '0:1',
  nodeIds: ['1:2', '1:3', '1:4'],
  nodes: [
    { id: '1:2', name: 'Hero', type: 'FRAME', width: 1440.4, height: 899.6 },
    { id: '1:3', name: 'CTA', type: 'RECTANGLE', width: 160, height: 48 },
    { id: '1:4', name: 'Title', type: 'TEXT', width: 320.2, height: 40 },
  ],
};

describe('designSelectionToWorkspaceItem', () => {
  it('describes the selection as a file context item', () => {
    expect(designSelectionToWorkspaceItem(SELECTION, { projectId: 'p1', path: 'designs/首页.fig', tabId: 'designs/首页.fig' })).toEqual({
      id: 'design:designs/首页.fig:1:2,1:3,1:4',
      kind: 'file',
      label: '首页.fig · Hero (+2)',
      path: 'designs/首页.fig',
      tabId: 'designs/首页.fig',
      title: 'FRAME Hero 1440×900\nRECTANGLE CTA 160×48\nTEXT Title 320×40',
    });
  });

  it('labels a single node without a count and falls back to the type for unnamed nodes', () => {
    const item = designSelectionToWorkspaceItem(
      { pageId: '0:1', nodeIds: ['5:1'], nodes: [{ id: '5:1', name: '', type: 'ELLIPSE', width: 10, height: 10 }] },
      { projectId: 'p1', path: 'a.fig' },
    );
    expect(item).toMatchObject({ id: 'design:a.fig:5:1', label: 'a.fig · ELLIPSE', title: 'ELLIPSE 10×10' });
    expect(item).not.toHaveProperty('tabId');
  });

  it('returns null for an empty selection (the editor clears its context)', () => {
    expect(designSelectionToWorkspaceItem({ pageId: '0:1', nodeIds: [], nodes: [] }, { projectId: 'p1', path: 'designs/a.fig' })).toBeNull();
  });

  it('stays within the daemon caps (id 240, label 240, title 500) for large selections', () => {
    const nodeIds = Array.from({ length: 60 }, (_, index) => `12:${index + 100}`);
    const nodes = nodeIds.slice(0, 20).map((id) => ({ id, name: `Layer with a long descriptive name ${id}`, type: 'RECTANGLE', width: 100, height: 20 }));
    const item = designSelectionToWorkspaceItem({ pageId: '0:1', nodeIds, nodes }, { projectId: 'p1', path: `designs/${'长'.repeat(100)}.fig` });
    expect(item).not.toBeNull();
    expect(item!.id.length).toBeLessThanOrEqual(240);
    expect(item!.id.startsWith('design:designs/')).toBe(true);
    expect(item!.label.length).toBeLessThanOrEqual(240);
    expect(item!.title!.length).toBeLessThanOrEqual(500);
    expect(item!.title!.endsWith('…')).toBe(true);
    // Stable for the same selection, different for another one.
    const again = designSelectionToWorkspaceItem({ pageId: '0:1', nodeIds, nodes }, { projectId: 'p1', path: `designs/${'长'.repeat(100)}.fig` });
    const other = designSelectionToWorkspaceItem({ pageId: '0:1', nodeIds: nodeIds.slice(1), nodes }, { projectId: 'p1', path: `designs/${'长'.repeat(100)}.fig` });
    expect(again!.id).toBe(item!.id);
    expect(other!.id).not.toBe(item!.id);
  });
});
