import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createMovieDocument } from '@open-design/contracts';
import { saveMovie, readMovie } from '../../src/movie/store.js';
import { importTokenToSeaVideo } from '../../src/movie/tokentosea-assets.js';
import { editMovie } from '../../src/movie/edits.js';

let dir: string, bytes: Buffer;
const assetId = `asset_${'a'.repeat(64)}`;
beforeAll(async () => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'tts-movie-fixture-'));
  try {
    const fixturePath = path.join(fixtureDir, 'fixture.mp4');
    execFileSync(ffmpeg.path, ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:r=30', '-t', '2', '-pix_fmt', 'yuv420p', fixturePath], { stdio: 'ignore' });
    bytes = await readFile(fixturePath);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tts-movie-'));
  await saveMovie(dir, { expectedRevision: 0, document: createMovieDocument('Generated source', 'blank') });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function setup(output: unknown = { assets: [{ asset_id: assetId }] }, url = 'https://media.cos.ap-tokyo.myqcloud.com/video.mp4?signature=test') {
  const service = vi.fn(async (_session: string, resource: string) => Response.json(resource.endsWith(assetId)
    ? { url } : { status: 'succeeded', model: 'test-video-model', output }));
  const download = vi.fn(async () => new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'video/mp4' } }));
  return { service, download };
}
it('imports an owned TokenToSea video as real editable footage without passing credentials to storage', async () => {
  const h = setup(), before = (await readMovie(dir))!;
  const result = await importTokenToSeaVideo(dir, h, 'private-session', { projectId: 'p', runId: 'run-1', assetId, expectedRevision: before.revision }, h.download);
  expect(result.document.style.assets![0]).toMatchObject({ id: `tts-${assetId}`, label: 'TokenToSea · test-video-model' });
  expect(h.service.mock.calls.map(c => c[1])).toEqual(['official/runs/run-1', `official/runs/run-1/assets/${assetId}`]);
  expect(JSON.stringify(h.download.mock.calls)).not.toContain('private-session');
  const edited = await editMovie(dir, { expectedRevision: result.document.revision, operations: [{ op: 'insert-clip', assetId: result.assetId, index: 0 }] });
  expect(edited.document.shots[0]!.duration).toBeCloseTo(2);
});
it('rejects unrelated assets, untrusted storage and stale revisions before downloading', async () => {
  const before = (await readMovie(dir))!, request = { projectId: 'p', runId: 'run-1', assetId, expectedRevision: before.revision };
  for (const h of [setup({ assets: [{ asset_id: `asset_${'b'.repeat(64)}` }] }), setup(undefined, 'http://127.0.0.1/private')]) {
    await expect(importTokenToSeaVideo(dir, h, 'session', request, h.download)).rejects.toThrow();
    expect(h.download).not.toHaveBeenCalled();
  }
  const h = setup();
  await expect(importTokenToSeaVideo(dir, h, 'session', { ...request, expectedRevision: 0 }, h.download)).rejects.toThrow();
  expect(h.service).not.toHaveBeenCalled();
  expect(await readMovie(dir)).toEqual(before);
});

it('imports owned image and audio materials for the native library',async()=>{
 for(const [mime,content,suffix] of [
  ['image/png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG9kAAAAASUVORK5CYII=','base64'),'png'],
  ['audio/wav',Buffer.from('524946462400000057415645666d7420100000000100010044ac000088580100020010006461746100000000','hex'),'wav'],
 ] as const){
  const before=(await readMovie(dir))!,h=setup({assets:[{asset_id:assetId,mime_type:mime}]});
  const download=async()=>new Response(new Uint8Array(content),{headers:{'content-type':mime}});
  const result=await importTokenToSeaVideo(dir,h,'same-account',{projectId:'p',runId:'run-1',assetId,expectedRevision:before.revision},download);
  expect(result.document.style.assets?.[0]?.path).toMatch(new RegExp(`\\.${suffix}$`));
 }
});
