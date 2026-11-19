import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isVoiceInputModel, transcriptionText, transcriptionUrl, VoiceInputService } from '../../src/services/voice-input.js';
import type { TokenToSeaRuntime, TokenToSeaModel } from '../../src/integrations/tokentosea-runtime.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const model: TokenToSeaModel = { id: 'glm-asr-2512', model: 'glm-asr-2512', priceVersion: 'current', modality: 'asr', executionKind: 'official', examples: [{ path: '/v1/audio/transcriptions', mode: 'json', body: {} }] };
function fixture(runtime: Partial<TokenToSeaRuntime> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'voice-input-test-'));
  directories.push(directory);
  return { directory, service: new VoiceInputService(directory, runtime as TokenToSeaRuntime) };
}
function wav() {
  const bytes = Buffer.alloc(44 + 3200);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(3200, 40);
  return bytes;
}

describe('voice input settings', () => {
  it('defaults to TokenToSea and retains a saved secret when a masked form is saved again', () => {
    const { service, directory } = fixture();
    expect(service.settings()).toMatchObject({ provider: 'tokentosea', model: '', custom: { apiKeyConfigured: false } });
    const saved = service.update({ provider: 'custom', model: '', custom: { baseUrl: 'http://localhost:9000/v1', model: 'whisper-1', apiKey: 'test-key-secret' } });
    expect(JSON.stringify(saved)).not.toContain('test-key-secret');
    service.update({ ...saved, custom: { ...saved.custom, apiKey: '' } });
    expect(JSON.parse(readFileSync(path.join(directory, 'voice-input.json'), 'utf8')).custom.apiKey).toBe('test-key-secret');
    expect(statSync(path.join(directory, 'voice-input.json')).mode & 0o777).toBe(0o600);
    const moved = service.update({ ...saved, custom: { ...saved.custom, baseUrl: 'https://another.example/v1', apiKey: '' } });
    expect(moved.custom.apiKeyConfigured).toBe(false);
    expect(service.update({ ...saved, custom: { ...saved.custom, apiKey: '' }, clearApiKey: true }).custom.apiKeyConfigured).toBe(false);
  });
  it('builds compatible endpoints and rejects embedded credentials', () => {
    expect(String(transcriptionUrl('http://127.0.0.1:9000/v1/'))).toBe('http://127.0.0.1:9000/v1/audio/transcriptions');
    expect(String(transcriptionUrl('https://example.com/v1/audio/transcriptions'))).toBe('https://example.com/v1/audio/transcriptions');
    expect(() => transcriptionUrl('https://user:password@example.com')).toThrow();
    expect(() => transcriptionUrl('file:///tmp/audio')).toThrow();
  });
  it('only offers available file-based recognition models', () => {
    expect(isVoiceInputModel(model)).toBe(true);
    for (const change of [{ available: false }, { modality: 'speech' }, { examples: [] }]) {
      expect(isVoiceInputModel({ ...model, ...change })).toBe(false);
    }
    expect(isVoiceInputModel({ ...model, model: 'qwen3-asr-flash-filetrans' })).toBe(true);
  });
});

describe('voice input transcription', () => {
  it('normalizes audio and sends the custom model and key as multipart', async () => {
    const { service, directory } = fixture();
    service.update({ provider: 'custom', model: '', custom: { baseUrl: 'https://asr.example/v1', model: 'my-asr', apiKey: 'private-key' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://asr.example/v1/audio/transcriptions');
      expect(init?.headers).toEqual({ Authorization: 'Bearer private-key' });
      const body = init?.body as FormData;
      expect(body.get('model')).toBe('my-asr');
      expect((body.get('file') as Blob).type).toBe('audio/wav');
      return Response.json({ text: '你好，Fantay。' });
    });
    await expect(service.transcribe(wav(), new AbortController().signal)).resolves.toEqual({ text: '你好，Fantay。', model: 'my-asr' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readFileSync(path.join(directory, 'voice-input.json'), 'utf8')).toContain('my-asr');
  });
  it('uses the current TokenToSea catalog, payload hash and authorization budget', async () => {
    const calls: Array<{ resource: string; body: unknown }> = [];
    const runtime = {
      models: vi.fn(async () => [model]), authorizationBudget: vi.fn(async () => 0.5),
      json: vi.fn(async (resource: string, _method?: string, body?: unknown) => {
        calls.push({ resource, body });
        if (resource === 'official/prepare') return { id: 'run-voice' };
        if (resource === 'official/runs/run-voice') return { status: 'succeeded', output: { output: { choices: [{ message: { content: [{ text: '识别结果' }] } }] } } };
        return {};
      }),
    };
    const { service } = fixture(runtime as unknown as Partial<TokenToSeaRuntime>);
    await expect(service.transcribe(wav(), new AbortController().signal)).resolves.toEqual({ text: '识别结果', model: model.model });
    const prepare = calls[0]!.body as Record<string, unknown>;
    const payload = calls[1]!.body;
    expect(prepare).toMatchObject({ model: model.model, priceVersion: 'current', path: '/v1/audio/transcriptions', mode: 'json', maxCostUsd: '0.500000' });
    expect(prepare.payloadHash).toBe(createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
  });
  it('rejects unknown audio and empty recognition without creating a draft', async () => {
    const { service } = fixture();
    await expect(service.transcribe(Buffer.from('not audio'), new AbortController().signal)).rejects.toThrow('录音');
    expect(transcriptionText({ text: '  ' })).toBe('');
    expect(transcriptionText({ choices: [{ message: { content: ' hello ' } }] })).toBe('hello');
  });
  it('cancels an in-flight TokenToSea task when the caller aborts', async () => {
    const controller = new AbortController();
    const json = vi.fn(async (resource: string) => {
      if (resource === 'official/prepare') return { id: 'run-cancel' };
      if (resource.endsWith('/invoke')) { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }
      return {};
    });
    const { service } = fixture({ models: async () => [model], authorizationBudget: async () => 1, json } as unknown as Partial<TokenToSeaRuntime>);
    await expect(service.transcribe(wav(), controller.signal)).rejects.toThrow('Aborted');
    expect(json).toHaveBeenLastCalledWith('official/runs/run-cancel/cancel', 'POST', {});
  });
  it('reads archived JSON transcripts for asynchronous recognition models', async () => {
    const asset = `asset_${'a'.repeat(64)}`;
    const json = vi.fn(async (resource: string) => {
      if (resource === 'official/prepare') return { id: 'run-archive' };
      if (resource.endsWith(`/assets/${asset}`)) return { url: 'https://voice.cos.ap-guangzhou.myqcloud.com/transcript.json' };
      if (resource === 'official/runs/run-archive') return { status: 'succeeded', output: { data: [{ asset_id: asset, mime_type: 'application/json' }] } };
      return {};
    });
    const { service } = fixture({ models: async () => [{ ...model, model: 'paraformer-v2' }], authorizationBudget: async () => 1, json } as unknown as Partial<TokenToSeaRuntime>);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ transcripts: [{ sentences: [{ text: '第一句。' }, { text: '第二句。' }] }] }));
    await expect(service.transcribe(wav(), new AbortController().signal)).resolves.toEqual({ text: '第一句。\n第二句。', model: 'paraformer-v2' });
  });
});
