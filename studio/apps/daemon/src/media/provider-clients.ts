import { createHmac, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { assertAndFetchExternalAsset } from '../connectionTest.js';
import { fetchMedia } from './usage.js';

type Json = Record<string, unknown>;
export type CatalogProviderConfig = { apiKey?: string; baseUrl?: string; model?: string };
export interface CatalogProviderContext {
  surface: 'image' | 'video' | 'audio';
  model: string;
  wireModel: string;
  prompt: string;
  aspect?: string | undefined;
  resolution?: string | undefined;
  length?: number | undefined;
  duration?: number | undefined;
  imageRef: { abs: string; mime: string; dataUrl: string } | null;
  requestInit: RequestInit;
}
export type CatalogProviderResult = { bytes: Buffer; providerNote: string; suggestedExt?: string };
export const CATALOG_PROVIDER_SURFACES = {
  image: ['bfl', 'replicate', 'google', 'midjourney', 'comfyui'],
  video: ['google', 'kling', 'comfyui'],
  audio: ['google', 'replicate', 'suno', 'udio', 'comfyui'],
} as const;
export const CATALOG_PROVIDER_IDS = new Set<string>(Object.values(CATALOG_PROVIDER_SURFACES).flat());

function record(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function endpoint(base: string, suffix: string): string { return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`; }
function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Configure ${name} in Settings → Models & providers → Media providers.`);
  return value.trim();
}
function httpUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Media endpoint must be an HTTP(S) URL without embedded credentials.');
  return url;
}
function sameOrigin(raw: string, base: string): string {
  const url = httpUrl(raw);
  if (url.origin !== httpUrl(base).origin) throw new Error('Provider returned a task URL on a different origin.');
  return url.href;
}
async function json(ctx: CatalogProviderContext, url: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
  httpUrl(url);
  const response = await fetchMedia(url, {
    ...ctx.requestInit, method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(60_000),
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    // Do not echo upstream text: proxies sometimes include request credentials.
    throw new Error(`Media provider request failed (HTTP ${response.status}). Check the endpoint, model and credentials.`);
  }
  const data: unknown = await response.json();
  const obj = record(data);
  if (obj.error || (typeof obj.code === 'number' && ![0, 1, 21, 22, 200].includes(obj.code))) {
    throw new Error('Media provider rejected the task. Check the model, input and account permissions.');
  }
  return data;
}
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, onProgress?: (message: string) => void): Promise<T> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    onProgress?.('Media task is running…');
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('Media provider task timed out after 10 minutes.');
}
function assertStatus(status: unknown): void {
  if (/^(failed|failure|error|cancelled|canceled|request[ _]moderated|content[ _]moderated|task not found|no card generated|NOT_FOUND)$/i.test(string(status))) {
    throw new Error(`Media provider task ${string(status)}.`);
  }
}
function extension(mime: string, fallback: string): string {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/flac': '.flac', 'audio/ogg': '.ogg' } as Record<string, string>)[(mime.split(';')[0] || '').trim()] || fallback;
}
async function output(ctx: CatalogProviderContext, provider: string, url: string, options?: { localBase?: string; headers?: Record<string, string> }): Promise<CatalogProviderResult> {
  const fallback = ctx.surface === 'image' ? '.png' : ctx.surface === 'video' ? '.mp4' : '.mp3';
  let response: Response;
  if (options?.localBase) {
    response = await fetchMedia(sameOrigin(url, options.localBase), { ...ctx.requestInit, ...(options.headers ? { headers: options.headers } : {}), redirect: 'error', signal: AbortSignal.timeout(120_000) });
  } else {
    response = await assertAndFetchExternalAsset(url, { ...ctx.requestInit, ...(options?.headers ? { headers: options.headers } : {}), signal: AbortSignal.timeout(120_000) }, undefined, fetchMedia);
  }
  if (!response.ok) throw new Error(`Media output download failed (HTTP ${response.status}).`);
  const mime = response.headers.get('content-type') || '';
  if (/text\/|application\/json/.test(mime)) throw new Error('Media provider returned a document instead of media bytes.');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw new Error('Media provider returned empty output.');
  return { bytes, suggestedExt: extension(mime, fallback), providerNote: `${provider}/${ctx.wireModel} · ${bytes.length} bytes` };
}
function inline(ctx: CatalogProviderContext, provider: string, data: string, mime: string): CatalogProviderResult {
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new Error('Media provider returned empty inline output.');
  return { bytes, suggestedExt: extension(mime, '.png'), providerNote: `${provider}/${ctx.wireModel} · ${bytes.length} bytes` };
}
function dimensions(aspect?: string): { width: number; height: number } {
  return aspect === '16:9' ? { width: 1344, height: 768 } : aspect === '9:16' ? { width: 768, height: 1344 } : aspect === '4:3' ? { width: 1152, height: 896 } : aspect === '3:4' ? { width: 896, height: 1152 } : { width: 1024, height: 1024 };
}

async function bfl(ctx: CatalogProviderContext, config: CatalogProviderConfig, progress?: (message: string) => void): Promise<CatalogProviderResult> {
  const base = config.baseUrl || 'https://api.bfl.ai';
  const headers = { 'x-key': required(config.apiKey, 'Black Forest Labs API key') };
  const model = config.model || ({ 'flux-1.1-pro': 'flux-pro-1.1' } as Record<string, string>)[ctx.wireModel] || ctx.wireModel;
  const body: Json = { prompt: ctx.prompt, ...dimensions(ctx.aspect), output_format: 'png' };
  if (ctx.imageRef) body.input_image = ctx.imageRef.dataUrl.split(',')[1];
  const submitted = record(await json(ctx, endpoint(base.replace(/\/v1\/?$/, ''), `v1/${encodeURIComponent(model)}`), headers, body));
  const pollingUrl = string(submitted.polling_url) || endpoint(base.replace(/\/v1\/?$/, ''), `v1/get_result?id=${encodeURIComponent(required(string(submitted.id), 'BFL task id'))}`);
  // BFL may return regional api.*.bfl.ai poll URLs. Never send its key elsewhere.
  const pollHost = httpUrl(pollingUrl).hostname;
  if (httpUrl(base).protocol === 'https:' && httpUrl(pollingUrl).protocol !== 'https:') throw new Error('Invalid BFL task protocol.');
  if (httpUrl(pollingUrl).origin !== httpUrl(base).origin && !(httpUrl(base).hostname.endsWith('.bfl.ai') && /(^|\.)bfl\.ai$/.test(pollHost))) throw new Error('Invalid BFL task origin.');
  const result = await poll(async () => record(await json(ctx, pollingUrl, headers)), (value) => { assertStatus(value.status); return string(value.status).toLowerCase() === 'ready'; }, progress);
  return output(ctx, 'bfl', required(string(record(result.result).sample), 'BFL output URL'));
}

const REPLICATE_MODELS: Record<string, string> = { 'sdxl': 'stability-ai/sdxl', 'ideogram-v2': 'ideogram-ai/ideogram-v2', 'audiocraft': 'meta/musicgen' };
async function replicate(ctx: CatalogProviderContext, config: CatalogProviderConfig, progress?: (message: string) => void): Promise<CatalogProviderResult> {
  const base = (config.baseUrl || 'https://api.replicate.com/v1').replace(/\/v1\/?$/, '') + '/v1';
  const headers = { authorization: `Bearer ${required(config.apiKey, 'Replicate API token')}` };
  const model = config.model || REPLICATE_MODELS[ctx.wireModel] || ctx.wireModel;
  if (!/^[\w.-]+\/[\w.-]+(?::[a-f\d]+)?$/i.test(model)) throw new Error('Replicate model must be owner/name or owner/name:version.');
  const [slug, version] = model.split(':');
  const metadata = record(await json(ctx, endpoint(base, `models/${slug}${version ? `/versions/${version}` : ''}`), headers));
  const latest = version ? metadata : record(metadata.latest_version);
  const schema = record(record(record(record(latest.openapi_schema).components).schemas).Input);
  const properties = record(schema.properties);
  const input: Json = { prompt: ctx.prompt };
  if (ctx.surface === 'image') {
    if (properties.width) input.width = dimensions(ctx.aspect).width;
    if (properties.height) input.height = dimensions(ctx.aspect).height;
    if (properties.aspect_ratio) input.aspect_ratio = ctx.aspect || '1:1';
  }
  if (ctx.surface === 'audio' && properties.duration) input.duration = ctx.duration || 10;
  if (ctx.imageRef) {
    const imageKey = properties.image ? 'image' : properties.image_input ? 'image_input' : properties.input_image ? 'input_image' : null;
    if (!imageKey) throw new Error('This Replicate model does not accept reference images.');
    input[imageKey] = ctx.imageRef.dataUrl;
  }
  const pinnedVersion = version || (metadata?.is_official === true ? '' : required(string(latest.id), 'Replicate model version'));
  const submitted = record(await json(ctx, pinnedVersion ? endpoint(base, 'predictions') : endpoint(base, `models/${slug}/predictions`), headers, { input, ...(pinnedVersion ? { version: pinnedVersion } : {}) }));
  assertStatus(submitted.status);
  const result = string(submitted.status) === 'succeeded' ? submitted : await poll(async () => record(await json(ctx, endpoint(base, `predictions/${encodeURIComponent(required(string(submitted.id), 'Replicate prediction id'))}`), headers)), (value) => { assertStatus(value.status); return value.status === 'succeeded'; }, progress);
  const urls = Array.isArray(result.output) ? result.output : [result.output];
  const first = urls.find((value) => typeof value === 'string');
  const resultUrl = required(string(first), 'Replicate output URL');
  return output(ctx, 'replicate', resultUrl, /(^|\.)replicate\.delivery$/.test(httpUrl(resultUrl).hostname) ? { headers } : undefined);
}

async function google(ctx: CatalogProviderContext, config: CatalogProviderConfig, progress?: (message: string) => void): Promise<CatalogProviderResult> {
  const base = (config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const vertex = /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(httpUrl(base).hostname);
  const apiBase = vertex || /\/v1(?:beta\d*)?$/.test(base) ? base : `${base}/v1beta`;
  const headers = vertex ? { authorization: `Bearer ${required(config.apiKey, 'Vertex access token')}` } : { 'x-goog-api-key': required(config.apiKey, 'Google API key') };
  const aliases: Record<string, string> = { 'imagen-4': 'imagen-4.0-generate-001', 'imagen-3': 'imagen-3.0-generate-002', 'veo-3': 'veo-3.0-generate-001', 'veo-2': 'veo-2.0-generate-001', 'lyria-2': 'lyria-002' };
  const model = config.model || aliases[ctx.wireModel] || ctx.wireModel;
  const modelBase = endpoint(apiBase, `models/${encodeURIComponent(model)}`);
  if (!vertex && !/^imagen-|^veo-/.test(model)) {
    const input: unknown = ctx.imageRef ? [{ type: 'text', text: ctx.prompt }, { type: 'image', mime_type: ctx.imageRef.mime, data: ctx.imageRef.dataUrl.split(',')[1] }] : ctx.prompt;
    const responseFormat = { type: ctx.surface, ...(ctx.surface === 'image' ? { aspect_ratio: ctx.aspect || '1:1' } : ctx.surface === 'video' ? { aspect_ratio: ctx.aspect || '16:9', delivery: 'uri' } : {}) };
    const interactionHeaders = { ...headers, 'Api-Revision': '2026-05-20' };
    const submitted = record(await json(ctx, endpoint(apiBase, 'interactions'), interactionHeaders, { model, input, response_format: responseFormat, ...(ctx.surface === 'image' ? {} : { background: true, store: true }) }));
    assertStatus(submitted.status);
    const result = submitted.status === 'completed' ? submitted : await poll(async () => record(await json(ctx, endpoint(apiBase, `interactions/${encodeURIComponent(required(string(submitted.id), 'Google interaction id'))}`), interactionHeaders)), (value) => { assertStatus(value.status); if (value.status === 'requires_action') throw new Error('Google media interaction requires additional input.'); return value.status === 'completed'; }, progress);
    for (const step of Array.isArray(result.steps) ? result.steps : []) {
      if (record(step).type !== 'model_output') continue;
      for (const part of Array.isArray(record(step).content) ? record(step).content as unknown[] : []) {
        const media = record(part);
        if (media.type !== ctx.surface) continue;
        if (string(media.data)) return inline(ctx, 'google', string(media.data), string(media.mime_type) || (ctx.surface === 'audio' ? 'audio/mpeg' : ctx.surface === 'video' ? 'video/mp4' : 'image/png'));
        if (string(media.uri)) return output(ctx, 'google', string(media.uri), httpUrl(string(media.uri)).origin === httpUrl(base).origin ? { localBase: base, headers } : undefined);
      }
    }
    throw new Error('Google returned no matching media output. Check the model and safety restrictions.');
  }
  if (ctx.surface === 'image' && /^gemini/.test(model)) {
    const parts: Json[] = [{ text: ctx.prompt }];
    if (ctx.imageRef) parts.push({ inlineData: { mimeType: ctx.imageRef.mime, data: ctx.imageRef.dataUrl.split(',')[1] } });
    const data = record(await json(ctx, `${modelBase}:generateContent`, headers, { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ctx.aspect || '1:1' } } }));
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    for (const candidate of candidates) {
      const parts = record(record(candidate).content).parts;
      for (const part of Array.isArray(parts) ? parts : []) {
        const image = record(record(part).inlineData ?? record(part).inline_data);
        if (string(image.data)) return inline(ctx, 'google', string(image.data), string(image.mimeType || image.mime_type) || 'image/png');
      }
    }
    throw new Error('Google returned no image. Check the model and safety restrictions.');
  }
  if (ctx.surface === 'video') {
    const instance: Json = { prompt: ctx.prompt };
    if (ctx.imageRef) instance.image = { bytesBase64Encoded: ctx.imageRef.dataUrl.split(',')[1], mimeType: ctx.imageRef.mime };
    const submitted = record(await json(ctx, `${modelBase}:predictLongRunning`, headers, { instances: [instance], parameters: { sampleCount: 1, aspectRatio: ctx.aspect || '16:9', durationSeconds: ctx.length || 8 } }));
    const name = required(string(submitted.name), 'Google operation name');
    const result = await poll(async () => record(await json(ctx, vertex ? `${modelBase}:fetchPredictOperation` : endpoint(apiBase, name), headers, vertex ? { operationName: name } : undefined)), (value) => { if (value.error) throw new Error('Google video task failed.'); return value.done === true; }, progress);
    const response = record(result.response);
    const videos = record(response.generateVideoResponse).generatedSamples ?? response.videos;
    const video = record(record(Array.isArray(videos) ? videos[0] : {}).video ?? (Array.isArray(videos) ? videos[0] : {}));
    const encoded = string(video.bytesBase64Encoded);
    if (encoded) return inline(ctx, 'google', encoded, string(video.mimeType) || 'video/mp4');
    if (vertex && /^gs:\/\/[^/]+\/.+/.test(string(video.gcsUri))) {
      const storageUrl = `https://storage.googleapis.com/${string(video.gcsUri).slice(5).split('/').map(encodeURIComponent).join('/')}`;
      return output(ctx, 'google', storageUrl, { headers });
    }
    const uri = required(string(video.uri), 'Google video URL');
    // Gemini's download endpoint requires the same API key. Never forward it to an arbitrary asset host.
    return output(ctx, 'google', uri, httpUrl(uri).origin === httpUrl(base).origin ? { localBase: base, headers } : undefined);
  }
  if (ctx.surface === 'audio' && !vertex) throw new Error('Lyria requires a Vertex publisher endpoint and access token. Configure the Google provider Base URL to your project/region endpoint.');
  const data = record(await json(ctx, `${modelBase}:predict`, headers, { instances: [{ prompt: ctx.prompt }], parameters: ctx.surface === 'audio' ? { sample_count: 1 } : { sampleCount: 1, aspectRatio: ctx.aspect || '1:1' } }));
  const prediction = record(Array.isArray(data.predictions) ? data.predictions[0] : {});
  const encoded = string(prediction.bytesBase64Encoded || prediction.audioContent);
  if (!encoded) throw new Error('Google returned no media. Check the publisher model and access permissions.');
  return inline(ctx, 'google', encoded, string(prediction.mimeType) || (ctx.surface === 'audio' ? 'audio/wav' : 'image/png'));
}

function klingToken(key: string): string {
  if (!key.includes(':')) return key;
  const [access, secret] = key.split(':');
  if (!access || !secret) throw new Error('Kling legacy credentials must be AccessKey:SecretKey.');
  const now = Math.floor(Date.now() / 1000);
  const input = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: access, exp: now + 1800, nbf: now - 5 })).toString('base64url')}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}
async function kling(ctx: CatalogProviderContext, config: CatalogProviderConfig, progress?: (message: string) => void): Promise<CatalogProviderResult> {
  const base = (config.baseUrl || 'https://api-singapore.klingai.com').replace(/\/v1\/?$/, '');
  const headers = { authorization: `Bearer ${klingToken(required(config.apiKey, 'Kling API key or AccessKey:SecretKey'))}` };
  if ((config.model || ctx.wireModel).startsWith('kling-3')) {
    const model = config.model || ctx.wireModel;
    const settings = { resolution: ctx.resolution || '1080p', duration: ctx.length || 5, audio: 'off', ...(!ctx.imageRef ? { aspect_ratio: ctx.aspect || '16:9', multi_shot: false } : {}) };
    const body = ctx.imageRef ? { contents: [{ type: 'prompt', text: ctx.prompt }, { type: 'first_frame', url: ctx.imageRef.dataUrl }], settings } : { prompt: ctx.prompt, settings };
    const submitted = record(record(await json(ctx, endpoint(base, `${ctx.imageRef ? 'image-to-video' : 'text-to-video'}/${encodeURIComponent(model)}`), headers, body)).data);
    const result = await poll(async () => {
      const values = record(await json(ctx, endpoint(base, `tasks?task_ids=${encodeURIComponent(required(string(submitted.id), 'Kling task id'))}`), headers)).data;
      return record(Array.isArray(values) ? values[0] : {});
    }, (value) => { assertStatus(value.status); return value.status === 'succeeded'; }, progress);
    const videos = Array.isArray(result.outputs) ? result.outputs : [];
    return output(ctx, 'kling', required(string(record(videos.find((item) => record(item).type === 'video')).url), 'Kling video URL'));
  }
  const kind = ctx.imageRef ? 'image2video' : 'text2video';
  const aliases: Record<string, string> = { 'kling-1.5': 'kling-v1-5', 'kling-1.6': 'kling-v1-6', 'kling-2.0': 'kling-v2-master' };
  const body: Json = { model_name: config.model || aliases[ctx.wireModel] || ctx.wireModel, prompt: ctx.prompt, duration: String((ctx.length || 5) <= 5 ? 5 : 10), mode: 'std' };
  if (ctx.imageRef) body.image = ctx.imageRef.dataUrl.split(',')[1];
  else body.aspect_ratio = ctx.aspect || '16:9';
  const submitted = record(record(await json(ctx, endpoint(base, `v1/videos/${kind}`), headers, body)).data);
  const result = await poll(async () => record(record(await json(ctx, endpoint(base, `v1/videos/${kind}/${encodeURIComponent(required(string(submitted.task_id), 'Kling task id'))}`), headers)).data), (value) => { assertStatus(value.task_status); return value.task_status === 'succeed'; }, progress);
  const videos = record(result.task_result).videos;
  return output(ctx, 'kling', required(string(record(Array.isArray(videos) ? videos[0] : {}).url), 'Kling video URL'));
}

async function midjourney(ctx: CatalogProviderContext, config: CatalogProviderConfig, progress?: (message: string) => void): Promise<CatalogProviderResult> {
  const base = required(config.baseUrl, 'midjourney-proxy server Base URL');
  const headers = config.apiKey ? { 'mj-api-secret': config.apiKey } : {};
  const version = config.model || ctx.wireModel.match(/^midjourney-v([\d.]+)$/)?.[1];
  const submitted = record(await json(ctx, endpoint(base.replace(/\/mj\/?$/, ''), 'mj/submit/imagine'), headers, { prompt: `${ctx.prompt}${ctx.aspect ? ` --ar ${ctx.aspect}` : ''}${version ? ` --v ${version}` : ''}`, base64Array: ctx.imageRef ? [ctx.imageRef.dataUrl] : [] }));
  const id = required(string(submitted.result), 'Midjourney proxy task id');
  const result = await poll(async () => record(await json(ctx, endpoint(base.replace(/\/mj\/?$/, ''), `mj/task/${encodeURIComponent(id)}/fetch`), headers)), (value) => { assertStatus(value.status); return value.status === 'SUCCESS'; }, progress);
  return output(ctx, 'midjourney-proxy', required(string(result.imageUrl), 'Midjourney image URL'));
}

async function musicProxy(ctx: CatalogProviderContext, config: CatalogProviderConfig, provider: 'suno' | 'udio', progress?: (message: string) => void): Promise<CatalogProviderResult> {
  // Explicit, user-hosted gateway protocols; these are not official public APIs.
  const base = required(config.baseUrl, `${provider} proxy Base URL`);
  const headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
  const submitted = await json(ctx, endpoint(base, provider === 'suno' ? 'api/generate' : 'generations'), headers, provider === 'suno'
    ? { prompt: ctx.prompt, make_instrumental: true, wait_audio: false, ...(config.model ? { model: config.model } : {}) }
    : { provider: 'udio', prompt: ctx.prompt, model: config.model || ctx.wireModel, duration_seconds: ctx.duration || 30, instrumental: true });
  const tracks = Array.isArray(submitted) ? submitted : [record(submitted).data || submitted];
  const first = record(tracks[0]);
  const id = string(first.id || first.task_id);
  const completed = (value: Json) => {
    assertStatus(value.status);
    return (!!string(value.audio_url || value.audioUrl) || (Array.isArray(value.outputs) && value.outputs.length > 0)) && (!value.status || /^(complete|completed|succeeded|success)$/i.test(string(value.status)));
  };
  const result = completed(first) ? first : await poll(async () => {
    const raw = await json(ctx, endpoint(base, provider === 'suno' ? `api/get?ids=${encodeURIComponent(required(id, 'Suno task id'))}` : `generations/${encodeURIComponent(required(id, 'Udio proxy task id'))}`), headers);
    return record(Array.isArray(raw) ? raw[0] : record(raw).data || raw);
  }, completed, progress);
  return output(ctx, `${provider}-proxy`, required(string(result.audio_url || result.audioUrl || record(Array.isArray(result.outputs) ? result.outputs[0] : {}).url), `${provider} output URL`));
}

async function comfyui(ctx: CatalogProviderContext, config: CatalogProviderConfig, projectDir: string, progress?: (message: string) => void): Promise<CatalogProviderResult> {
  const base = config.baseUrl || 'http://127.0.0.1:8188';
  const headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
  const source = required(config.model, 'ComfyUI API workflow JSON (paste it into Workflow in provider settings)');
  let text = source;
  if (!source.startsWith('{')) {
    const root = await realpath(projectDir);
    const file = await realpath(path.resolve(root, source));
    if (!file.startsWith(root + path.sep) || !/\.json$/i.test(file)) throw new Error('ComfyUI workflow must be a JSON file inside the current project.');
    text = await readFile(file, 'utf8');
  }
  let workflow: unknown;
  try { workflow = JSON.parse(text); } catch { throw new Error('ComfyUI workflow must be valid API-format JSON.'); }
  workflow = record(workflow).prompt || workflow;
  if (!Object.keys(record(workflow)).length || !Object.values(record(workflow)).every((node) => string(record(node).class_type))) throw new Error('Export the ComfyUI workflow in API format (nodes with class_type and inputs).');
  if (!JSON.stringify(workflow).includes('{{prompt}}')) throw new Error('Place {{prompt}} in the ComfyUI positive text input so each generation uses your prompt.');
  let imageName = '';
  if (ctx.imageRef) {
    const form = new FormData();
    form.set('image', new Blob([new Uint8Array(await readFile(ctx.imageRef.abs))], { type: ctx.imageRef.mime }), `fantay-${randomUUID()}.png`);
    const response = await fetchMedia(endpoint(base, 'upload/image'), { ...ctx.requestInit, method: 'POST', headers, body: form, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`ComfyUI reference upload failed (HTTP ${response.status}).`);
    const data = record(await response.json());
    imageName = [string(data.subfolder), string(data.name)].filter(Boolean).join('/');
    if (!imageName || !JSON.stringify(workflow).includes('{{image}}')) throw new Error('Use {{image}} in a ComfyUI LoadImage input to connect the reference image.');
  }
  const replacements: Record<string, string | number> = { prompt: ctx.prompt, image: imageName, seed: Math.floor(Math.random() * 2 ** 32), ...dimensions(ctx.aspect), duration: ctx.duration || ctx.length || 5 };
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = value.match(/^\{\{(\w+)\}\}$/);
      if (exact?.[1] && exact[1] in replacements) return replacements[exact[1]];
      return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) => String(replacements[key] ?? match));
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  const submitted = record(await json(ctx, endpoint(base, 'prompt'), headers, { prompt: replace(workflow), client_id: randomUUID() }));
  if (submitted.node_errors && Object.keys(record(submitted.node_errors)).length) throw new Error('ComfyUI workflow validation failed. Check the workflow nodes and installed models.');
  const id = required(string(submitted.prompt_id), 'ComfyUI prompt id');
  const history = await poll(async () => record(record(await json(ctx, endpoint(base, `history/${encodeURIComponent(id)}`), headers))[id]), (value) => { assertStatus(record(value.status).status_str); return record(value.status).completed === true || (!value.status && !!value.outputs); }, progress);
  for (const node of Object.values(record(history.outputs))) {
    const keys = ctx.surface === 'image' ? ['images'] : ctx.surface === 'video' ? ['videos', 'gifs', 'images'] : ['audio'];
    for (const key of keys) {
      for (const item of Array.isArray(record(node)[key]) ? record(node)[key] as unknown[] : []) {
        const file = record(item), name = string(file.filename);
        if (!name || (ctx.surface === 'video' && !/\.(mp4|webm|mov)$/i.test(name))) continue;
        const query = new URLSearchParams({ filename: name, subfolder: string(file.subfolder), type: string(file.type) || 'output' });
        return output(ctx, 'comfyui', endpoint(base, `view?${query}`), { localBase: base, headers });
      }
    }
  }
  throw new Error(`ComfyUI completed without a saved ${ctx.surface} output. Add a matching Save node to the workflow.`);
}

export async function renderCatalogProvider(provider: string, ctx: CatalogProviderContext, config: CatalogProviderConfig, projectDir: string, progress?: (message: string) => void): Promise<CatalogProviderResult> {
  if (provider !== 'comfyui' && config.model) ctx = { ...ctx, wireModel: config.model };
  if (provider === 'suno' && !config.model) ctx = { ...ctx, wireModel: 'gateway-default' };
  switch (provider) {
    case 'bfl': return bfl(ctx, config, progress);
    case 'replicate': return replicate(ctx, config, progress);
    case 'google': return google(ctx, config, progress);
    case 'kling': return kling(ctx, config, progress);
    case 'midjourney': return midjourney(ctx, config, progress);
    case 'suno': case 'udio': return musicProxy(ctx, config, provider, progress);
    case 'comfyui': return comfyui(ctx, config, projectDir, progress);
    default: throw new Error(`Unsupported media provider: ${provider}`);
  }
}
