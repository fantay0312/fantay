import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveStudioFile, overviewFromMarkdown } from '../../src/runtime/design-system-studio';

vi.mock('../../src/providers/registry', () => ({
  projectRawUrl: (_id: string, file: string) => '/raw/' + file,
  designSystemStaticUrl: (_id: string, file: string) => '/static/' + file,
  ensureDesignSystemWorkspace: vi.fn(async () => ({ project: { id: 'p1' } })),
  writeProjectTextFile: vi.fn(async () => ({ name: 'tokens.css' })),
  syncDesignSystemAssetsFromWorkspace: vi.fn(async () => ({ synced: ['tokens.css'] })),
  updateDesignSystemDraft: vi.fn(async () => ({ id: 'user:test' })),
}));
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ projectId: 'p1', synced: ['tokens.css'] })))); });

describe('studio source persistence', () => {
  it('saves to the project and synchronizes before reporting success', async () => {
    await saveStudioFile({ id: 'user:test', projectId: 'p1', path: 'tokens.css', expected: 'old', content: 'new' });
    expect(fetch).toHaveBeenCalledWith('/api/design-systems/user%3Atest/editor', expect.objectContaining({ method: 'POST', body: JSON.stringify({ path: 'tokens.css', content: 'new', expected: 'old' }) }));
  });
  it('rejects changed source without overwriting it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 409 }));
    await expect(saveStudioFile({ id: 'user:test', projectId: 'p1', path: 'tokens.css', expected: 'stale', content: 'new' })).rejects.toThrow('TOKEN_CONFLICT');
  });
  it('does not claim success when the canonical package was not synchronized', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ projectId: 'p1', synced: [] })));
    await expect(saveStudioFile({ id: 'user:test', projectId: 'p1', path: 'tokens.css', expected: 'old', content: 'new' })).rejects.toThrow('SYNC_FAILED');
  });
  it('reads human-written overview principles without exposing metadata', () => {
    const value = overviewFromMarkdown('# Product\n\n> Category: Tools\n\nA useful tool.\n\n## Principles\n\n- Clear\n- Calm\n\n## Colors\n\n#ffffff');
    expect(value.intro).toBe('A useful tool.');
    expect(value.blocks).toEqual([{ title: 'Principles', body: '- Clear\n- Calm' }]);
  });
});
