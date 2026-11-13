import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configureTokenToSeaRuntime } from '../../src/integrations/tokentosea-runtime.js';
import { renderTokenToSeaImage } from '../../src/media/tokentosea.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hUQAAAAASUVORK5CYII=', 'base64');
const asset = `asset_${'a'.repeat(64)}`;
const folders: string[] = [];
afterEach(async () => { configureTokenToSeaRuntime(undefined); vi.unstubAllGlobals(); await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
function runtime({ available = true, url = 'https://fixture.cos.ap-test.myqcloud.com/image.png', budget = '1.000000' } = {}) {
  const json = vi.fn(async (resource: string, _method?: string, body?: any) => {
    if (resource === 'grant') return { perCallUsd: budget, remainingUsd: budget };
    if (resource === 'official/prepare') return { id: 'test-run' };
    if (resource.endsWith('/invoke')) return { status: 'running' };
    if (resource.includes('/assets/')) return { url };
    return { status: 'succeeded', output: { assets: [{ asset_id: asset, mime_type: 'image/png' }] } };
  });
  configureTokenToSeaRuntime({ models: async () => [{ id: 'official:image-model', model: 'image-model', modality: 'image', executionKind: 'official', available, priceVersion: 'p1', examples: [
    { path: '/v1/images/generations', mode: 'json', body: { model: 'image-model', prompt: 'sample', size: '1024x1024' } },
    { path: '/v1/images/edits', mode: 'json', body: { model: 'image-model', prompt: 'sample', image: '{{IMAGE_URL}}' } },
  ] }], json, authorizationBudget:async()=>{const grant=await json('grant');return Math.min(Number(grant.perCallUsd),Number(grant.remainingUsd));},withUsageContext: <T>(_context:unknown,work:()=>Promise<T>)=>work() } as never);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(png, { headers: { 'Content-Type': 'image/png' } })));
  return json;
}
it('prepares exactly the payload that it invokes, then retrieves only the archived asset', async () => {
  const json = runtime();
  const result = await renderTokenToSeaImage({ model: 'tokentosea/image-model', wireModel: 'tokentosea/image-model', prompt: 'A blue square', imageRefs: [] });
  expect(result.bytes).toEqual(png);
  const prepare = json.mock.calls.find(call => call[0] === 'official/prepare')![2];
  const invoke = json.mock.calls.find(call => call[0].endsWith('/invoke'))![2];
  expect(prepare).toMatchObject({ model: 'image-model', priceVersion: 'p1', maxCostUsd: '1.000000', path: '/v1/images/generations' });
  expect(prepare.payloadHash).toBe(createHash('sha256').update(JSON.stringify(invoke)).digest('hex'));
  expect(invoke.input.prompt).toBe('A blue square');
});
it('uses the verified edit operation when an image reference is supplied', async () => {
  const json = runtime(), folder = await mkdtemp(path.join(os.tmpdir(), 'tts-image-')); folders.push(folder);
  const source = path.join(folder, 'source.png'); await writeFile(source, png);
  await renderTokenToSeaImage({ model: 'tokentosea/image-model', wireModel: 'tokentosea/image-model', prompt: 'Blue', imageRefs: [{ abs: source }] });
  expect(json.mock.calls.find(call => call[0] === 'official/prepare')![2].path).toBe('/v1/images/edits');
  expect(json.mock.calls.find(call => call[0].endsWith('/invoke'))![2].input.image).toContain('data:image/png;base64,');
});
it('refuses unavailable models and exhausted grants before preparing a paid run', async () => {
  const json = runtime({ available: false });
  await expect(renderTokenToSeaImage({ model: 'tokentosea/image-model', wireModel: 'tokentosea/image-model', prompt: 'Blue', imageRefs: [] })).rejects.toThrow('unavailable');
  expect(json).not.toHaveBeenCalled();
  const noBudget = runtime({ budget: '0' });
  await expect(renderTokenToSeaImage({ model: 'tokentosea/image-model', wireModel: 'tokentosea/image-model', prompt: 'Blue', imageRefs: [] })).rejects.toThrow('budget');
  expect(noBudget.mock.calls.some(call => call[0] === 'official/prepare')).toBe(false);
});
it('refuses an unadvertised image ratio instead of silently turning 16:9 into 3:2', async () => {
  const json = runtime();
  await expect(renderTokenToSeaImage({ model: 'tokentosea/image-model', wireModel: 'tokentosea/image-model', prompt: 'Blue', aspect: '16:9', imageRefs: [] })).rejects.toThrow('aspect ratio');
  expect(json.mock.calls.some(call => call[0] === 'official/prepare')).toBe(false);
});
it('rejects an unexpected asset host without sending it a credential or downloading it', async () => {
  runtime({ url: 'https://untrusted.example/image.png' });
  await expect(renderTokenToSeaImage({ model: 'tokentosea/image-model', wireModel: 'tokentosea/image-model', prompt: 'Blue', imageRefs: [] })).rejects.toThrow('origin');
  expect(fetch).not.toHaveBeenCalled();
});

it('never turns a TokenToSea media failure into a stub, even when stubs are enabled', async () => {
  // src/media/index.ts rethrows TokenToSea failures before the stub fallback:
  // a cloud refusal (billing, moderation) must not become a fake image.
  const { generateMedia } = await import('../../src/media/index.js');
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'tts-media-nostub-')); folders.push(projectRoot);
  const projectsRoot = path.join(projectRoot, '.od', 'projects');
  const { mkdir, stat } = await import('node:fs/promises');
  await mkdir(path.join(projectsRoot, 'project-1'), { recursive: true });
  configureTokenToSeaRuntime({
    models: async () => { throw new Error('workspace billing denied'); },
    json: async () => { throw new Error('workspace billing denied'); },
    authorizationBudget: async () => 1,
    withUsageContext: <T>(_context: unknown, work: () => Promise<T>) => work(),
  } as never);
  const previous = process.env.OD_MEDIA_ALLOW_STUBS;
  process.env.OD_MEDIA_ALLOW_STUBS = '1';
  try {
    await expect(generateMedia({
      projectRoot, projectsRoot, projectId: 'project-1', prompt: 'A precise test prompt',
      surface: 'image', model: 'tokentosea/gpt-image-2', output: 'must-not-exist.png',
    } as never)).rejects.toThrow('workspace billing denied');
    await expect(stat(path.join(projectsRoot, 'project-1', 'must-not-exist.png'))).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.OD_MEDIA_ALLOW_STUBS; else process.env.OD_MEDIA_ALLOW_STUBS = previous;
  }
});
