// SPDX-License-Identifier: Apache-2.0
import type { MaterialApplyResponse, MaterialSummaryItem } from '@open-design/contracts';
import { MATERIAL_NOTICE } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registryMocks = vi.hoisted(() => ({ invalidateProjectFilesCache: vi.fn() }));
vi.mock('../../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/registry')>()),
  invalidateProjectFilesCache: registryMocks.invalidateProjectFilesCache,
}));

import { insertMaterialToBoard, materialDrafts } from '../../../src/fantay/materials/material-insert';
import {
  drainQueuedBoardInserts,
  resetWorkspaceBusForTests,
  subscribeWorkspaceCommand,
  type WorkspaceCommandOf,
} from '../../../src/fantay/workspace/workspace-bus';
import { WEBSITE_ITEM, makeItem, materialsFetch } from '../../components/materials/fixtures';

function applied(id: string, files: string[], attachments = files): MaterialApplyResponse {
  return {
    id,
    projectId: 'p1',
    dir: `references/${id}`,
    files: [
      ...files.map((relPath) => ({ relPath, bytes: 1, sha256: 'a'.repeat(64) })),
      { relPath: `references/${id}/.material-receipt.json`, bytes: 1, sha256: 'b'.repeat(64) },
    ],
    attachments,
    receiptRelPath: `references/${id}/.material-receipt.json`,
    notice: MATERIAL_NOTICE,
  };
}

const provenance = (item: MaterialSummaryItem, receipt: string | null, sourceUrl?: string) => ({
  source: 'material',
  materialId: item.id,
  license: item.license,
  ...(receipt ? { receiptPath: receipt } : {}),
  ...(sourceUrl ? { sourceUrl } : {}),
});

describe('materialDrafts', () => {
  const component = makeItem(1, { source: 'https://github.com/kobra/ui' });
  const receipt = 'references/item-1/.material-receipt.json';

  it.each([
    ['png thumbnail + entry → the entry decides', ['references/item-1/thumb.png', 'references/item-1/hero.png'], 'image', 'references/item-1/hero.png'],
    ['svg', ['references/item-1/icon.svg'], 'image', 'references/item-1/icon.svg'],
    ['JPEG (case-insensitive)', ['references/item-1/Photo.JPEG'], 'image', 'references/item-1/Photo.JPEG'],
    ['mp4', ['references/item-1/clip.mp4'], 'video', 'references/item-1/clip.mp4'],
    ['webm', ['references/item-1/clip.webm'], 'video', 'references/item-1/clip.webm'],
    ['mov', ['references/item-1/clip.mov'], 'video', 'references/item-1/clip.mov'],
    ['html', ['references/item-1/index.html'], 'frame', 'references/item-1/index.html'],
    ['htm', ['references/item-1/page.htm'], 'frame', 'references/item-1/page.htm'],
  ] as const)('%s', (_label, files, kind, path) => {
    expect(materialDrafts(component, applied('item-1', [...files]))).toEqual([
      { kind, path, title: 'Material 1', provenance: provenance(component, receipt, 'https://github.com/kobra/ui') },
    ]);
  });

  it('markdown and component sources become a note naming the file', () => {
    for (const path of ['references/item-1/README.md', 'references/item-1/index.tsx']) {
      expect(materialDrafts(component, applied('item-1', [path]))).toEqual([
        {
          kind: 'note',
          title: 'Material 1',
          text: `Material 1\nSubtitle 1\n${path}`,
          provenance: provenance(component, receipt, 'https://github.com/kobra/ui'),
        },
      ]);
    }
  });

  it('falls back to the first copied file that is not the receipt when there are no attachments', () => {
    const response = applied('item-1', ['references/item-1/cover.webp'], []);
    expect(materialDrafts(component, response)[0]).toMatchObject({ kind: 'image', path: 'references/item-1/cover.webp' });
  });

  it('a website with an http(s) source is a web node; without one a note, and no receipt either way', () => {
    expect(materialDrafts(WEBSITE_ITEM, null)).toEqual([
      { kind: 'web', url: 'https://linear.app/', title: 'Linear', provenance: provenance(WEBSITE_ITEM, null, 'https://linear.app/') },
    ]);
    const noUrl = { ...WEBSITE_ITEM, source: 'javascript:alert(1)' };
    expect(materialDrafts(noUrl, null)).toEqual([
      { kind: 'note', title: 'Linear', text: 'Subtitle 900', provenance: provenance(noUrl, null) },
    ]);
    const bare = { ...WEBSITE_ITEM, source: undefined, subtitle: undefined, description: '' };
    expect(materialDrafts(bare, null)).toEqual([
      { kind: 'note', title: 'Linear', text: 'Linear', provenance: provenance(bare, null) },
    ]);
  });

  it('always yields exactly one draft, even without an apply response', () => {
    expect(materialDrafts(component, null)).toEqual([
      {
        kind: 'note',
        title: 'Material 1',
        text: 'Material 1\nSubtitle 1',
        provenance: provenance(component, null, 'https://github.com/kobra/ui'),
      },
    ]);
  });
});

describe('insertMaterialToBoard', () => {
  let fetchState: ReturnType<typeof materialsFetch>;

  beforeEach(() => {
    resetWorkspaceBusForTests();
    registryMocks.invalidateProjectFilesCache.mockClear();
    fetchState = materialsFetch({ items: [makeItem(0), makeItem(1), WEBSITE_ITEM], failApply: new Set(['item-1']) });
    vi.stubGlobal('fetch', vi.fn(fetchState.handler));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetWorkspaceBusForTests();
  });

  it('applies into the project, refreshes its file list and delivers to the mounted board', async () => {
    const received: WorkspaceCommandOf<'board.insert'>[] = [];
    subscribeWorkspaceCommand('board.insert', (command) => {
      received.push(command);
      return command.projectId === 'p1';
    });

    const result = await insertMaterialToBoard({ item: makeItem(0), projectId: 'p1', at: { x: 40, y: 80 } });

    expect(fetchState.calls.filter((call) => call.method === 'POST').map((call) => [call.url, call.body])).toEqual([
      ['/api/materials/items/item-0/apply', { projectId: 'p1' }],
    ]);
    expect(registryMocks.invalidateProjectFilesCache).toHaveBeenCalledWith('p1', null);
    expect(result.delivered).toBe('board');
    expect(received).toEqual([
      { type: 'board.insert', projectId: 'p1', drafts: result.drafts, at: { x: 40, y: 80 }, select: true },
    ]);
    // the fixture's main entry is index.tsx → a note naming the copied file
    expect(result.drafts).toEqual([
      expect.objectContaining({ kind: 'note', text: 'Material 0\nSubtitle 0\nreferences/item-0/index.tsx' }),
    ]);
    expect(drainQueuedBoardInserts('p1')).toEqual([]);
  });

  it('queues the insert for the project board when no board takes it', async () => {
    subscribeWorkspaceCommand('board.insert', (command) => command.projectId === 'another-project');

    const result = await insertMaterialToBoard({ item: makeItem(0), projectId: 'p1' });

    expect(result.delivered).toBe('queued');
    expect(drainQueuedBoardInserts('p1')).toEqual([
      { type: 'board.insert', projectId: 'p1', drafts: result.drafts, select: true },
    ]);
  });

  it('never calls apply for a website and does not touch the file list', async () => {
    const result = await insertMaterialToBoard({ item: WEBSITE_ITEM, projectId: 'p1' });

    expect(fetchState.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(registryMocks.invalidateProjectFilesCache).not.toHaveBeenCalled();
    expect(result).toEqual({
      delivered: 'queued',
      drafts: [expect.objectContaining({ kind: 'web', url: 'https://linear.app/' })],
    });
  });

  it('rejects with the daemon error when apply fails, and inserts nothing', async () => {
    await expect(insertMaterialToBoard({ item: makeItem(1), projectId: 'p1' })).rejects.toThrow('item-1 cannot be copied');
    expect(drainQueuedBoardInserts('p1')).toEqual([]);
    expect(registryMocks.invalidateProjectFilesCache).not.toHaveBeenCalled();
  });

  it('sends the workspace headers of a team project with the apply request', async () => {
    const workspaceContext = {
      workspaceId: 'ws-1',
      workspaceType: 'team',
      workspaceMemberId: 'member-1',
      role: 'owner',
      memberStatus: 'active',
      lifecycleState: 'active',
      permissions: { canShareProjects: true, canWriteSyncedFiles: true },
    } as unknown as NonNullable<Parameters<typeof insertMaterialToBoard>[0]['workspaceContext']>;
    const fetchSpy = vi.fn(fetchState.handler);
    vi.stubGlobal('fetch', fetchSpy);

    await insertMaterialToBoard({ item: makeItem(0), projectId: 'p1', workspaceContext });

    expect(registryMocks.invalidateProjectFilesCache).toHaveBeenCalledWith('p1', workspaceContext);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers ?? {}) as Record<string, string>).toMatchObject({
      'content-type': 'application/json',
      'x-od-workspace-id': 'ws-1',
      'x-od-workspace-member-id': 'member-1',
    });
  });
});
