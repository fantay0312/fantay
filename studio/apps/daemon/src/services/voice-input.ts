import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import {
  VOICE_INPUT_MAX_BYTES, VOICE_INPUT_MAX_SECONDS, VoiceInputConfigSchema,
  type VoiceInputConfig, type VoiceInputModel, type VoiceInputSettings, type VoiceInputUpdate,
} from '@open-design/contracts/api/voice-input';
import type { TokenToSeaModel, TokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';
import { movieFfmpeg } from '../movie/video-sources.js';
import { proxyDispatcherRequestInit } from '../connectionTest.js';
import { tokenToSeaMediaAssets } from '@open-design/contracts';

const exec = promisify(execFile);

export class VoiceInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function transcriptionUrl(base: string): URL {
  let url: URL;
  try { url = new URL(base); } catch { throw new VoiceInputError('请填写有效的语音识别服务地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new VoiceInputError('语音服务地址须使用 HTTP 或 HTTPS，且不包含凭据、查询参数或锚点。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/audio/transcriptions')) url.pathname += '/audio/transcriptions';
  return url;
}

export function isVoiceInputModel(model: TokenToSeaModel): boolean {
  return model.available !== false && model.executionKind === 'official' && model.modality === 'asr'
    && Boolean(model.examples?.some(example => ['/v1/audio/transcriptions', '/v1/tools/asr'].includes(example.path) && example.mode === 'json'));
}

/** Direct transcription and native multimodal ASR responses share this boundary. */
export function transcriptionText(value: unknown, depth = 0): string {
  if (depth > 8 || !value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map(item => transcriptionText(item, depth + 1)).filter(Boolean).join('\n');
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text.trim();
  if (typeof record.transcript === 'string') return record.transcript.trim();
  for (const key of ['output', 'result', 'data', 'transcripts', 'sentences']) {
    const text = transcriptionText(record[key], depth + 1);
    if (text) return text;
  }
  const choices = record.choices;
  if (!Array.isArray(choices)) return '';
  return choices.map(choice => {
    const content = choice?.message?.content;
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.map(part => typeof part?.text === 'string' ? part.text : '').join('') : '';
  }).join('\n').trim();
}

export class VoiceInputService {
  private readonly file: string;
  constructor(private readonly dataDir: string, private readonly tokenToSea: TokenToSeaRuntime) {
    this.file = path.join(dataDir, 'voice-input.json');
  }

  private read(): VoiceInputConfig {
    if (!existsSync(this.file)) return VoiceInputConfigSchema.parse({});
    return VoiceInputConfigSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
  }

  settings(): VoiceInputSettings {
    const config = this.read();
    return {
      provider: config.provider, model: config.model,
      custom: { baseUrl: config.custom.baseUrl, model: config.custom.model, apiKeyConfigured: Boolean(config.custom.apiKey) },
    };
  }

  update(input: VoiceInputUpdate): VoiceInputSettings {
    const current = this.read();
    const config = VoiceInputConfigSchema.parse(input);
    if (config.custom.baseUrl) transcriptionUrl(config.custom.baseUrl);
    const sameOrigin = Boolean(config.custom.baseUrl && current.custom.baseUrl)
      && transcriptionUrl(config.custom.baseUrl).origin === transcriptionUrl(current.custom.baseUrl).origin;
    config.custom.apiKey = input.clearApiKey ? '' : input.custom.apiKey || (sameOrigin ? current.custom.apiKey : '');
    if (config.provider === 'custom' && (!config.custom.baseUrl || !config.custom.model)) {
      throw new VoiceInputError('请填写自定义语音服务地址和模型 ID。');
    }
    mkdirSync(this.dataDir, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    return this.settings();
  }

  async models(): Promise<VoiceInputModel[]> {
    return (await this.tokenToSea.models()).filter(isVoiceInputModel).map(model => ({ id: model.id, name: model.name || model.model }));
  }

  async transcribe(bytes: Buffer, signal: AbortSignal): Promise<{ text: string; model: string }> {
    if (!bytes.length || bytes.length > VOICE_INPUT_MAX_BYTES) throw new VoiceInputError('录音为空或超过 10 MiB，请重新录制。');
    const supported = bytes.length >= 12 && (
      bytes.readUInt32BE(0) === 0x1a45dfa3 || bytes.toString('ascii', 0, 4) === 'OggS'
      || bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
      || bytes.toString('ascii', 4, 8) === 'ftyp'
    );
    if (!supported) throw new VoiceInputError('请选择 WebM、WAV、Ogg 或 MP4 录音。', 422);
    const config = this.read();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    try {
      const wav = await this.normalizeAudio(bytes, bounded);
      const result = config.provider === 'tokentosea'
        ? await this.transcribeTokenToSea(config, wav, bounded)
        : await this.transcribeCustom(config, wav, bounded);
      if (!result.text) throw new VoiceInputError('没有识别到清晰的语音，请重新录制。', 422);
      if (result.text.length > 32_000) throw new VoiceInputError('语音识别结果过长，请分段录制。', 422);
      return result;
    } catch (error) {
      if (bounded.aborted && !signal.aborted) throw new VoiceInputError('语音识别超时，请重试或更换模型。', 504);
      throw error;
    }
  }

  private async normalizeAudio(bytes: Buffer, signal: AbortSignal): Promise<Buffer> {
    const root = path.join(this.dataDir, 'voice-input');
    mkdirSync(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, 'capture-'));
    try {
      const source = path.join(directory, 'recording');
      const target = path.join(directory, 'recording.wav');
      await writeFile(source, bytes, { mode: 0o600, signal });
      try {
        await exec(movieFfmpeg(), [
          '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', source,
          '-map', '0:a:0', '-t', String(VOICE_INPUT_MAX_SECONDS + 1), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', target,
        ], { timeout: 20_000, maxBuffer: 128 * 1024, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new VoiceInputError('无法读取录音，请检查麦克风后重试。', 422);
      }
      // Allow the recorder's final event-loop tick at the two-minute limit.
      if ((await stat(target)).size > (VOICE_INPUT_MAX_SECONDS + 0.5) * 16000 * 2 + 512) {
        throw new VoiceInputError('每段录音最多 2 分钟，请分段录制。');
      }
      return await readFile(target, { signal });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async transcribeCustom(config: VoiceInputConfig, wav: Buffer, signal: AbortSignal) {
    if (!config.custom.model) throw new VoiceInputError('请在设置 → 模型与提供商 → 语音输入中选择识别模型。');
    const form = new FormData();
    form.set('model', config.custom.model);
    form.set('response_format', 'json');
    form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'recording.wav');
    const proxy = proxyDispatcherRequestInit(process.env);
    try {
      const response = await fetch(transcriptionUrl(config.custom.baseUrl), {
        ...proxy.requestInit, method: 'POST', body: form, signal, redirect: 'error',
        headers: config.custom.apiKey ? { Authorization: `Bearer ${config.custom.apiKey}` } : {},
      });
      if (!response.ok) throw new VoiceInputError(`语音识别服务返回 HTTP ${response.status}，请检查地址、模型和密钥。`, 502);
      return { text: transcriptionText(await response.json()), model: config.custom.model };
    } finally { await proxy.close(); }
  }

  private async transcribeTokenToSea(config: VoiceInputConfig, wav: Buffer, signal: AbortSignal) {
    const models = (await this.tokenToSea.models()).filter(isVoiceInputModel);
    const model = config.model
      ? models.find(item => item.id === config.model || item.model === config.model)
      : models.find(item => item.model === 'glm-asr-2512') ?? models[0];
    if (!model) throw new VoiceInputError('当前 TokenToSea 账号没有可用的语音识别模型，请在语音输入设置中刷新模型或配置自定义服务。', 422);
    const example = model.examples!.find(item => ['/v1/audio/transcriptions', '/v1/tools/asr'].includes(item.path) && item.mode === 'json')!;
    const maximum = await this.tokenToSea.authorizationBudget();
    if (!Number.isFinite(maximum) || maximum <= 0) throw new VoiceInputError('TokenToSea 可用额度不足，请检查账号额度。', 402);
    const payload = { input: { ...structuredClone(example.body), model: model.model }, file: { name: 'recording.wav', mime: 'audio/wav', data: wav.toString('base64') } };
    const prepared = await this.tokenToSea.json<{ id: string }>('official/prepare', 'POST', {
      model: model.model, priceVersion: model.priceVersion,
      path: example.path,
      mode: 'json',
      payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), requestKey: randomUUID(), maxCostUsd: maximum.toFixed(6),
    }, {}, signal);
    if (!/^[\w-]+$/.test(prepared.id)) throw new VoiceInputError('TokenToSea 返回了无效的语音识别任务。', 502);
    const resource = `official/runs/${prepared.id}`;
    try {
      await this.tokenToSea.json(`${resource}/invoke`, 'POST', payload, {}, signal);
      while (true) {
        const run = await this.tokenToSea.json<{ status: string; output?: unknown }>(resource, 'GET', undefined, {}, signal);
        if (run.status === 'succeeded') return { text: await this.readTokenToSeaTranscript(resource, run.output, signal), model: model.model };
        if (['failed', 'needs_review', 'canceled', 'cancelled', 'expired'].includes(run.status)) {
          throw new VoiceInputError('TokenToSea 语音识别未完成，请重试或更换识别模型。', 502);
        }
        await delay(700, undefined, { signal });
      }
    } finally {
      if (signal.aborted) await this.tokenToSea.json(`${resource}/cancel`, 'POST', {}).catch(() => undefined);
    }
  }

  private async readTokenToSeaTranscript(resource: string, output: unknown, signal: AbortSignal): Promise<string> {
    const direct = transcriptionText(output);
    if (direct) return direct;
    const assets = tokenToSeaMediaAssets(output, ['application/json', 'text/']);
    const texts: string[] = [];
    for (const asset of assets) {
      const signed = await this.tokenToSea.json<{ url: string }>(`${resource}/assets/${asset}`, 'GET', undefined, {}, signal);
      const url = new URL(signed.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.myqcloud.com')) {
        throw new VoiceInputError('TokenToSea 返回的转写文件地址无效。', 502);
      }
      const response = await fetch(url, { redirect: 'error', signal });
      if (!response.ok || !response.body) throw new VoiceInputError('无法读取 TokenToSea 转写文件。', 502);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 2 * 1024 * 1024) throw new VoiceInputError('TokenToSea 转写文件过大。', 502);
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const content = Buffer.concat(chunks).toString('utf8');
      if (response.headers.get('content-type')?.includes('text/plain')) texts.push(content.trim());
      else texts.push(transcriptionText(JSON.parse(content)));
    }
    return texts.filter(Boolean).join('\n');
  }
}
