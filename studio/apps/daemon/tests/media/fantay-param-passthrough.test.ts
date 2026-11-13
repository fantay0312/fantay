// Spec 05 §9 D-1 / D-1b: the gpt-image quality and the Nano Banana image size the board generator asks for
// reach the provider request; absent or unknown values keep the previous fixed defaults (high / 1K).
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateMedia } from '../../src/media/index.js';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=';
const ENV_KEYS = ['OD_MEDIA_CONFIG_DIR', 'OD_DATA_DIR', 'OPENAI_API_KEY', 'OD_OPENAI_API_KEY', 'OD_AIHUBMIX_API_KEY', 'OD_NANOBANANA_API_KEY'] as const;

describe('board generation params reach the provider (D-1 / D-1b)', () => {
  let root: string;
  let projectRoot: string;
  let projectsRoot: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    root = await mkdtemp(path.join(tmpdir(), 'od-fantay-params-'));
    projectRoot = path.join(root, 'project-root');
    projectsRoot = path.join(projectRoot, '.od', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    delete process.env.OD_MEDIA_CONFIG_DIR;
    delete process.env.OD_DATA_DIR;
    delete process.env.OD_OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    process.env.OD_AIHUBMIX_API_KEY = 'sk-test-aihubmix';
    process.env.OD_NANOBANANA_API_KEY = 'nano-test-key';
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  /** Stubs fetch with one image response and returns the parsed JSON body of the provider request. */
  function captureImageRequest(response: unknown): { body: () => Record<string, unknown> } {
    let captured: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    return {
      body: () => {
        if (!captured) throw new Error('no provider request');
        return captured;
      },
    };
  }

  async function openaiImage(quality: string | undefined): Promise<Record<string, unknown>> {
    const request = captureImageRequest({ data: [{ b64_json: PNG_BASE64 }] });
    await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'gpt-image-2',
      prompt: 'a red bicycle',
      aspect: '1:1',
      output: 'bike.png',
      ...(quality !== undefined ? { quality } : {}),
    });
    return request.body();
  }

  it('sends the requested gpt-image quality to OpenAI', async () => {
    expect((await openaiImage('low')).quality).toBe('low');
    expect((await openaiImage('medium')).quality).toBe('medium');
    expect((await openaiImage('auto')).quality).toBe('auto');
  });

  it('keeps OpenAI gpt-image at high for an unknown or absent quality', async () => {
    expect((await openaiImage('ultra')).quality).toBe('high');
    expect((await openaiImage(undefined)).quality).toBe('high');
  });

  it('keeps the DALL-E quality vocabulary', async () => {
    const request = captureImageRequest({ data: [{ b64_json: PNG_BASE64 }] });
    await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'dall-e-3',
      prompt: 'a red bicycle',
      aspect: '1:1',
      output: 'dalle.png',
      quality: 'low',
    });
    expect(request.body().quality).toBe('hd');
  });

  it('sends the requested gpt-image quality through AIHubMix', async () => {
    const request = captureImageRequest({ data: [{ b64_json: PNG_BASE64 }] });
    await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'aihubmix-gpt-image-1',
      prompt: 'a teal fox logo',
      aspect: '1:1',
      output: 'fox.png',
      quality: 'medium',
    });
    expect(request.body().quality).toBe('medium');
  });

  async function nanoBanana(resolution: string | undefined) {
    const request = captureImageRequest({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] } }],
    });
    const result = await generateMedia({
      projectRoot,
      projectsRoot,
      projectId: 'project-1',
      surface: 'image',
      model: 'gemini-3.1-flash-image-preview',
      prompt: 'a neon city skyline',
      aspect: '16:9',
      output: 'nano.png',
      ...(resolution !== undefined ? { resolution } : {}),
    });
    const body = request.body() as { generationConfig?: { imageConfig?: { imageSize?: string } } };
    return { imageSize: body.generationConfig?.imageConfig?.imageSize, providerNote: result.providerNote };
  }

  it('sends the requested Nano Banana image size (case-insensitive) and names it in the provider note', async () => {
    const sized = await nanoBanana('2k');
    expect(sized.imageSize).toBe('2K');
    expect(sized.providerNote).toContain('2K');
    expect((await nanoBanana('4K')).imageSize).toBe('4K');
  });

  it('keeps Nano Banana at 1K for an absent or unknown size', async () => {
    const fallback = await nanoBanana(undefined);
    expect(fallback.imageSize).toBe('1K');
    expect(fallback.providerNote).toContain('1K');
    expect((await nanoBanana('8K')).imageSize).toBe('1K');
  });
});
