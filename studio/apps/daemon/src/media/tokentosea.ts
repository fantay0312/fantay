import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenToSeaMediaAssets } from '@open-design/contracts';
import { tokenToSeaRuntime, type TokenToSeaModel } from '../integrations/tokentosea-runtime.js';

interface MediaInput {
  projectId?: string;
  model: string; wireModel: string; prompt: string; aspect?: string | undefined; quality?: string | undefined; resolution?: string | undefined;
  imageRefs: Array<{ abs: string }>; length?: number | undefined; onProgress?: ((message: string) => void) | undefined;
}
const shortId = (id: string) => id.replace(/^(tokentosea|vela)\//u, '');
function modelFor(models: TokenToSeaModel[], input: MediaInput, surface: 'image' | 'video'): TokenToSeaModel {
  const id = shortId(input.wireModel === input.model ? input.model : input.wireModel);
  const available = models.filter(model => model.available !== false && model.executionKind && model.modality === surface);
  const selected = id === surface ? available[0] : available.find(model => model.id === id || model.model === id);
  if (!selected) throw new Error(`TokenToSea ${surface} model is unavailable: ${id}`);
  return selected;
}
function imageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('TokenToSea image references must be PNG, JPEG or WebP');
}

async function render(input: MediaInput, surface: 'image' | 'video') {
  const runtime = tokenToSeaRuntime(), abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 15 * 60_000); timeout.unref();
  let runId: string | undefined;
  try {
    const model = modelFor(await runtime.models(), input, surface);
    const examples = model.examples?.filter(example => example.mode === 'json') ?? [];
    const generation = examples.find(item => /generations|generation|tasks|videos|images/u.test(item.path)) ?? examples[0];
    const acceptsImages = Array.isArray(model.inputModalities) && model.inputModalities.includes('image');
    const example = input.imageRefs.length && surface === 'image'
      ? examples.find(item => /\/edits$/u.test(item.path)) ?? (acceptsImages ? generation : undefined)
      : generation;
    if (!example) throw new Error('This TokenToSea model has no verified JSON generation operation');
    const body: Record<string, unknown> = { ...structuredClone(example.body), model: model.model, prompt: input.prompt };
    if (input.aspect && surface === 'video' && ['doubao', 'qwen', 'minimax'].includes(model.provider ?? '')) body.ratio = input.aspect;
    else if (input.aspect && ('aspect_ratio' in body || model.provider === 'minimax')) body.aspect_ratio = input.aspect;
    else if (input.aspect && typeof body.size === 'string' && /\d+[x*]\d+/u.test(body.size)) {
      const sizes: Record<string, string> = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' };
      if (surface === 'video') {
        const [width, height] = body.size.split(/[x*]/).map(Number), [a, b] = input.aspect.split(':').map(Number);
        if (!width || !height || !a || !b || Math.abs(width / height - a / b) > 0.02) throw new Error('This TokenToSea video operation does not publish the requested aspect ratio');
      } else {
        if (!sizes[input.aspect]) throw new Error('This TokenToSea operation does not publish a matching image size for the requested aspect ratio');
        body.size = sizes[input.aspect];
      }
    } else if (input.aspect && input.aspect !== '1:1') {
      throw new Error('This TokenToSea operation does not publish the requested aspect ratio');
    }
    if (input.quality) body.quality = input.quality;
    if (input.resolution) body.resolution = input.resolution;
    if (surface === 'video' && input.length !== undefined) body.duration = input.length;
    if (input.imageRefs.length) {
      const images = await Promise.all(input.imageRefs.map(async ref => {
        const bytes = await readFile(ref.abs);
        if (bytes.length > 10 * 1024 * 1024) throw new Error('TokenToSea image reference exceeds 10 MiB');
        return `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`;
      }));
      if (Array.isArray(body.content)) {
        body.content = [{ type: 'text', text: input.prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))];
        delete body.prompt;
      } else if (surface === 'video' && acceptsImages) body.input = images.map(url => ({ role: images.length === 1 ? 'first_frame' : 'reference_image', url }));
      else if ('images' in body) body.images = images;
      else if ('image' in body || surface === 'image') body.image = images.length === 1 ? images[0] : images;
      else throw new Error('This TokenToSea video operation does not declare image-reference input');
    } else if (Array.isArray(body.content)) {
      body.content = [{ type: 'text', text: input.prompt }]; delete body.prompt;
    }
    if (/\{\{[A-Z_]+\}\}/u.test(JSON.stringify(body))) throw new Error('This TokenToSea operation still requires a reference asset');
    const maximum = await runtime.authorizationBudget();
    if (!Number.isFinite(maximum) || maximum <= 0) throw new Error('TokenToSea authorization budget is exhausted');
    const payload = { input: body };
    const prepared = await runtime.json<{ id: string }>('official/prepare', 'POST', {
      model: model.model, priceVersion: model.priceVersion, path: example.path, mode: example.mode,
      payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), requestKey: randomUUID(), maxCostUsd: maximum.toFixed(6),
    }, {}, abort.signal);
    if (!/^[\w-]+$/u.test(prepared.id)) throw new Error('Invalid TokenToSea generation receipt');
    runId = prepared.id;
    input.onProgress?.(`TokenToSea ${surface} generation started`);
    await runtime.json(`official/runs/${runId}/invoke`, 'POST', payload, {}, abort.signal);
    while (true) {
      const run = await runtime.json<{ status: string; output?: unknown; errorCode?: string }>(`official/runs/${runId}`, 'GET', undefined, {}, abort.signal);
      if (['failed', 'canceled', 'needs_review'].includes(run.status)) throw new Error(`TokenToSea generation ${run.status}; run ${runId}`);
      if (run.status === 'succeeded') {
        const [asset] = tokenToSeaMediaAssets(run.output, [`${surface}/`]);
        if (!asset) throw new Error(`TokenToSea generation has no archived ${surface}; run ${runId}`);
        const signed = await runtime.json<{ url: string }>(`official/runs/${runId}/assets/${asset}`);
        const url = new URL(signed.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.myqcloud.com')) throw new Error('Unexpected TokenToSea asset origin');
        const response = await fetch(url, { redirect: 'error', signal: abort.signal });
        const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
        if (!response.ok || !response.body || !mime.startsWith(`${surface}/`)) throw new Error('TokenToSea asset is unavailable');
        const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > (surface === 'image' ? 30 : 256) * 1024 * 1024) throw new Error('TokenToSea asset exceeds size limit');
            chunks.push(Buffer.from(chunk.value));
          }
        } finally { await reader.cancel().catch(() => undefined); }
        const bytes = Buffer.concat(chunks);
        if (surface === 'image') imageMime(bytes);
        return { bytes, providerNote: `TokenToSea · ${model.model} · ${runId}`, suggestedExt: ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm' } as Record<string, string>)[mime] ?? path.extname(url.pathname) };
      }
      await delay(2000, undefined, { signal: abort.signal });
    }
  } catch (error) {
    if (runId && abort.signal.aborted) await runtime.json(`official/runs/${runId}/cancel`, 'POST', {}).catch(() => undefined);
    throw error;
  } finally { clearTimeout(timeout); }
}
export const renderTokenToSeaImage = (input: MediaInput) => tokenToSeaRuntime().withUsageContext(input.projectId?{projectId:input.projectId}:{},()=>render(input, 'image'));
export const renderTokenToSeaVideo = (input: MediaInput) => tokenToSeaRuntime().withUsageContext(input.projectId?{projectId:input.projectId}:{},()=>render(input, 'video'));
export async function fetchTokenToSeaVideoModels(): Promise<string[]> {
  return (await tokenToSeaRuntime().models()).filter(model => model.modality === 'video' && model.available !== false && model.executionKind).map(model => model.model);
}
