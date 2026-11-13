import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createMovieExport } from '../../src/main/movie-export.js';

const scratch: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup(format: 'mp4' | 'mov' = 'mp4') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fantay-save-video-')); scratch.push(dir);
  const target = path.join(dir, `中文影片.${format}`);
  const choose = vi.fn(async () => ({ canceled: false, filePath: target }));
  const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('/raw/') ? new Response('video-bytes') : Response.json({ document: { renders: [{ id: 'render-1', status: 'done', file: `movie-render-1.${format}` }] } }));
  const openPath = vi.fn(async () => ''); const reveal = vi.fn();
  return { dir, target, choose, fetcher, openPath, reveal, host: createMovieExport({ choose, discoverDaemonBaseUrl: async () => 'http://127.0.0.1:7456', openPath, reveal, fetch: fetcher }) };
}
it('saves the authorized completed version directly to a native selected filename and opens only that file', async () => {
  const m = await setup('mov');
  const chosen = await m.host.chooseDestination({ filename: '中文影片', format: 'mov' });
  expect(chosen.ok).toBe(true); if (!chosen.ok) throw new Error('No destination');
  expect(m.choose).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: '中文影片.mov' }));
  expect(m.fetcher).not.toHaveBeenCalled();
  const result = await m.host.save({ destinationId: chosen.id, projectId: 'project-1', renderId: 'render-1' });
  expect(result).toEqual(chosen); expect(await readFile(m.target, 'utf8')).toBe('video-bytes');
  expect(await readdir(m.dir)).toEqual(['中文影片.mov']);
  expect(await m.host.open({ destinationId: chosen.id, reveal: true })).toEqual({ ok: true });
  expect(m.reveal).toHaveBeenCalledWith(m.target);
  await m.host.open({ destinationId: chosen.id, reveal: false }); expect(m.openPath).toHaveBeenCalledWith(m.target);
});
it('treats picker cancellation as a no-op and rejects invented handles and unsafe project identifiers', async () => {
  const m = await setup(); m.choose.mockResolvedValueOnce({ canceled: true, filePath: '' });
  expect(await m.host.chooseDestination({ filename: 'movie', format: 'mp4' })).toMatchObject({ ok: false, cancelled: true });
  expect(await m.host.save({ destinationId: 'invented', projectId: 'project-1', renderId: 'render-1' })).toMatchObject({ ok: false });
  expect(await m.host.save({ destinationId: 'invented', projectId: '../private', renderId: 'render-1' })).toMatchObject({ ok: false });
  expect(m.fetcher).not.toHaveBeenCalled(); expect(await readdir(m.dir)).toEqual([]);
});
it('keeps an existing destination intact when rendering fails and reports the real failure', async () => {
  const m = await setup(); await writeFile(m.target, 'existing-video');
  const chosen = await m.host.chooseDestination({ filename: 'movie', format: 'mp4' }); if (!chosen.ok) throw new Error('No destination');
  m.fetcher.mockResolvedValueOnce(Response.json({ document: { renders: [{ id: 'render-1', status: 'failed', error: 'Missing source video' }] } }));
  expect(await m.host.save({ destinationId: chosen.id, projectId: 'project-1', renderId: 'render-1' })).toMatchObject({ ok: false, reason: 'Missing source video' });
  expect(await readFile(m.target, 'utf8')).toBe('existing-video');
  expect(await m.host.open({ destinationId: chosen.id, reveal: false })).toMatchObject({ ok: false });
});
it('waits for rendering and preserves workspace identity on both project and video requests', async () => {
  const m = await setup();
  const chosen = await m.host.chooseDestination({ filename: 'movie', format: 'mp4' }); if (!chosen.ok) throw new Error('No destination');
  m.fetcher.mockResolvedValueOnce(Response.json({ document: { renders: [{ id: 'render-1', status: 'running' }] } }));
  const result = await m.host.save({ destinationId: chosen.id, projectId: 'project-1', renderId: 'render-1', workspaceContext: { workspaceId: 'workspace-a', workspaceMemberId: 'member-a', workspaceType: 'team', lifecycleState: 'active', memberStatus: 'active', role: 'owner', permissions: { canShareProjects: true, canWriteSyncedFiles: true } } });
  expect(result.ok).toBe(true); expect(m.fetcher).toHaveBeenCalledTimes(3);
  for (const [url] of m.fetcher.mock.calls) {
    expect(String(url)).toContain('workspaceId=workspace-a'); expect(String(url)).toContain('workspaceMemberId=member-a');
  }
});
