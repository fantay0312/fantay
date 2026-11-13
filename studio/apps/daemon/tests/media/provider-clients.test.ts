import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderCatalogProvider, type CatalogProviderContext } from '../../src/media/provider-clients.js';
import { generateMedia } from '../../src/media/index.js';

vi.mock('../../src/connectionTest.js', () => ({
  assertAndFetchExternalAsset: async (url: string, init: RequestInit, _lookup: unknown, fetchImpl: typeof fetch) => fetchImpl(url, init),
}));

const DATA = Buffer.from('real provider media bytes');
const ctx: CatalogProviderContext = { surface: 'image', model: 'flux-2-pro', wireModel: 'flux-2-pro', prompt: 'A floating island', aspect: '16:9', imageRef: null, requestInit: {} };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const media = (mime = 'image/png') => new Response(DATA, { headers: { 'content-type': mime } });
let requests: { url: string; init: RequestInit }[];
function queue(...responses: Response[]) {
  const fetchMock = vi.fn(async (url: unknown, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected request ${String(url)}`);
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const body = (i: number) => JSON.parse(String(requests[i]?.init.body));

describe('media provider protocol clients', () => {
  beforeEach(() => { requests = []; });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  it('dispatches BFL from the public generation path and persists the downloaded result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fantay-provider-'));
    vi.stubEnv('OD_DATA_DIR', root);
    vi.stubEnv('OD_MEDIA_CONFIG_DIR', root);
    vi.stubEnv('OD_BFL_API_KEY', 'test-key');
    vi.stubEnv('OD_MEDIA_ALLOW_STUBS', '0');
    queue(json({ id: 'b1', polling_url: 'https://api.bfl.ai/v1/get_result?id=b1' }), json({ status: 'Ready', result: { sample: 'https://cdn.example.test/image' } }), media());
    try {
      const result = await generateMedia({ projectRoot: root, projectsRoot: path.join(root, 'projects'), projectId: 'one', surface: 'image', model: 'flux-2-pro', prompt: ctx.prompt, output: 'image.png' });
      expect(result.providerId).toBe('bfl');
      expect(result.providerNote).not.toContain('[stub]');
      expect(await readFile(path.join(root, 'projects', 'one', result.name))).toEqual(DATA);
      expect(requests[0]?.init.headers).toMatchObject({ 'x-key': 'test-key' });
      expect(requests[2]?.init.headers).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('polls pending BFL tasks and fails moderated tasks instead of returning a placeholder', async () => {
    vi.useFakeTimers();
    queue(json({ polling_url: 'https://api.bfl.ai/result' }), json({ status: 'Pending' }), json({ status: 'Request Moderated' }));
    const task = renderCatalogProvider('bfl', ctx, { apiKey: 'key' }, '.');
    const failure = expect(task).rejects.toThrow(/Moderated/);
    await vi.advanceTimersByTimeAsync(2000);
    await failure;
    expect(requests).toHaveLength(3);
  });

  it('refuses to forward a BFL key to an unrelated polling host', async () => {
    queue(json({ polling_url: 'https://attacker.example/result' }));
    await expect(renderCatalogProvider('bfl', ctx, { apiKey: 'secret' }, '.')).rejects.toThrow(/origin/);
    expect(requests).toHaveLength(1);
  });

  it('submits Replicate model input, polls the prediction and downloads output', async () => {
    queue(json({ openapi_schema: { components: { schemas: { Input: { properties: { prompt: {}, width: {}, height: {} } } } } } }), json({ id: 'r1', status: 'processing' }), json({ id: 'r1', status: 'succeeded', output: ['https://replicate.delivery/result.png'] }), media());
    const result = await renderCatalogProvider('replicate', { ...ctx, model: 'sdxl', wireModel: 'sdxl' }, { apiKey: 'token', model: 'stability-ai/sdxl:abc123' }, '.');
    expect(requests[0]?.url).toBe('https://api.replicate.com/v1/models/stability-ai/sdxl/versions/abc123');
    expect(requests[1]?.url).toBe('https://api.replicate.com/v1/predictions');
    expect(body(1)).toMatchObject({ version: 'abc123', input: { prompt: ctx.prompt } });
    expect(result.bytes).toEqual(DATA);
  });

  it.each(['image', 'video', 'audio'] as const)('reads Google %s from REST model_output steps', async (surface) => {
    queue(json({ id: 'g1', status: 'completed', steps: [{ type: 'thought', content: [{ type: surface, data: 'bad' }] }, { type: 'model_output', content: [{ type: surface, data: DATA.toString('base64'), mime_type: surface === 'image' ? 'image/png' : surface === 'video' ? 'video/mp4' : 'audio/mpeg' }] }] }));
    const result = await renderCatalogProvider('google', { ...ctx, surface, model: 'gemini-model', wireModel: 'gemini-model' }, { apiKey: 'google-key' }, '.');
    expect(requests[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(requests[0]?.init.headers).toMatchObject({ 'x-goog-api-key': 'google-key' });
    expect(body(0)).toMatchObject({ response_format: { type: surface } });
    expect(result.bytes).toEqual(DATA);
  });

  it('uses Vertex generateContent with a reference image and an OAuth bearer token', async () => {
    queue(json({ candidates: [{ content: { parts: [{ inlineData: { data: DATA.toString('base64'), mimeType: 'image/png' } }] } }] }));
    await renderCatalogProvider('google', { ...ctx, model: 'gemini-2.5-flash-image', wireModel: 'gemini-2.5-flash-image', imageRef: { abs: '/unused', mime: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' } }, { apiKey: 'access-token', baseUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/project/locations/us-central1/publishers/google' }, '.');
    expect(requests[0]?.url).toContain('/models/gemini-2.5-flash-image:generateContent');
    expect(requests[0]?.init.headers).toMatchObject({ authorization: 'Bearer access-token' });
    expect(body(0).contents[0].parts[1].inlineData.data).toBe('aGVsbG8=');
  });

  it('uses current Kling submit and tasks protocols', async () => {
    queue(json({ code: 0, data: { id: 'k1' } }), json({ code: 0, data: [{ id: 'k1', status: 'succeeded', outputs: [{ type: 'video', url: 'https://cdn.example.test/video.mp4' }] }] }), media('video/mp4'));
    const result = await renderCatalogProvider('kling', { ...ctx, surface: 'video', model: 'kling-3.0', wireModel: 'kling-3.0', length: 5 }, { apiKey: 'key' }, '.');
    expect(requests[0]?.url).toBe('https://api-singapore.klingai.com/text-to-video/kling-3.0');
    expect(body(0)).toMatchObject({ settings: { duration: 5, audio: 'off' } });
    expect(requests[1]?.url).toContain('/tasks?task_ids=k1');
    expect(result.suggestedExt).toBe('.mp4');
  });

  it('authenticates midjourney-proxy using mj-api-secret and waits for SUCCESS', async () => {
    queue(json({ code: 22, result: 'mj1' }), json({ status: 'SUCCESS', imageUrl: 'https://cdn.example.test/mj.png' }), media());
    await renderCatalogProvider('midjourney', { ...ctx, model: 'midjourney-v7', wireModel: 'midjourney-v7' }, { apiKey: 'proxy-key', baseUrl: 'https://proxy.example.test' }, '.');
    expect(requests[0]?.init.headers).toMatchObject({ 'mj-api-secret': 'proxy-key' });
    expect(requests[0]?.init.headers).not.toHaveProperty('authorization');
    expect(requests[1]?.url).toContain('/mj/task/mj1/fetch');
  });

  it('uses the gcui Suno gateway protocol and preserves the gateway model default', async () => {
    queue(json([{ id: 's1', status: 'submitted' }]), json([{ id: 's1', status: 'complete', audio_url: 'https://cdn.example.test/song.mp3' }]), media('audio/mpeg'));
    const result = await renderCatalogProvider('suno', { ...ctx, surface: 'audio', model: 'suno-v5', wireModel: 'suno-v5' }, { apiKey: 'proxy-key', baseUrl: 'https://suno.example.test' }, '.');
    expect(requests[0]?.url).toContain('/api/generate');
    expect(body(0)).not.toHaveProperty('model');
    expect(requests[1]?.url).toContain('/api/get?ids=s1');
    expect(result.suggestedExt).toBe('.mp3');
  });

  it('implements the explicitly configured Udio music gateway contract', async () => {
    queue(json({ id: 'u1', status: 'queued' }), json({ id: 'u1', status: 'completed', outputs: [{ url: 'https://cdn.example.test/udio.mp3', mime_type: 'audio/mpeg' }] }), media('audio/mpeg'));
    await renderCatalogProvider('udio', { ...ctx, surface: 'audio', model: 'udio-v2', wireModel: 'udio-v2' }, { apiKey: 'gateway-key', baseUrl: 'https://gateway.example.test' }, '.');
    expect(requests[0]?.url).toBe('https://gateway.example.test/generations');
    expect(body(0)).toMatchObject({ provider: 'udio', duration_seconds: 30 });
    expect(requests[1]?.url).toContain('/generations/u1');
  });

  it('submits a real ComfyUI API graph, interpolates typed values and downloads the saved output', async () => {
    queue(json({ prompt_id: 'c1' }), json({ c1: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'image.png', subfolder: '', type: 'output' }] } } } }), media());
    const result = await renderCatalogProvider('comfyui', ctx, { model: JSON.stringify({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', seed: '{{seed}}' } } }) }, '.');
    expect(requests[0]?.url).toBe('http://127.0.0.1:8188/prompt');
    expect(body(0).prompt['1'].inputs).toMatchObject({ text: ctx.prompt, seed: expect.any(Number) });
    expect(requests[2]?.url).toContain('/view?filename=image.png');
    expect(result.bytes).toEqual(DATA);
  });

  it.each(['midjourney', 'suno', 'udio'])('requires an explicit %s gateway before any request', async (provider) => {
    const fetchMock = queue();
    await expect(renderCatalogProvider(provider, ctx, { apiKey: 'key' }, '.')).rejects.toThrow(/Base URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects HTML masquerading as a successful media result', async () => {
    queue(json({ polling_url: 'https://api.bfl.ai/result' }), json({ status: 'Ready', result: { sample: 'https://cdn.example.test/denied' } }), new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }));
    await expect(renderCatalogProvider('bfl', ctx, { apiKey: 'key' }, '.')).rejects.toThrow(/document/);
  });
});
