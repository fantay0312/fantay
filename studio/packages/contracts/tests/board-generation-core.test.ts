import { describe, expect, it } from 'vitest';

import type { MediaTaskSnapshotResponse } from '../src/api/media-generate';
import type { ProjectMediaTask, ProjectMediaTaskError } from '../src/api/media';
import {
  GENERATION_EDGE_ROLE_TO_BOARD_KIND,
  GENERATION_LIMITS,
  GENERATION_RENDERED_PROVIDERS,
  GENERATOR_DEFAULT_SIZE,
  MEDIA_ASPECT_VALUES,
  REFERENCE_LABELS,
  applyCandidatePatch,
  buildMediaGenerateRequest,
  candidatePatchFromAccepted,
  candidatePatchFromHttpError,
  candidatePatchFromSnapshot,
  candidatePatchFromTask,
  candidatePatchNetworkError,
  canConnectToGenerator,
  clampParams,
  cloneGeneratorData,
  cloneMediaNodeData,
  compileGeneration,
  createGeneratorForSelection,
  createGeneratorNodeInput,
  defaultParamsFor,
  fillTemplateArguments,
  findFreePlacement,
  generationEdgeRoleFromBoardKind,
  generationOutputName,
  generatorRunState,
  isActiveSlot,
  isDaemonReadyImage,
  mediaNodeSizeFor,
  outputStemOf,
  paramSupportFor,
  parseTemplateArguments,
  planCandidateRetry,
  planGenerationRun,
  planMoreLikeThis,
  promoteCandidateOps,
  removeCandidate,
  resolveModelVariant,
  setPrimaryCandidate,
  shortGenerationId,
  variantGroupFor,
  type BoardMediaFile,
  type GenerationCandidate,
  type GenerationGraph,
  type GenerationGraphNode,
  type GenerationNodeInput,
  type GenerationRequestRecord,
  type GeneratorParams,
  type GeneratorRunSummary,
  type MediaNodeData,
} from '../src/api/board-generation';

// Spec 05 §11 "board-generation-core" cases plus the R3e/C8 amendments.

type Model = { id: string; provider: string; caps: readonly string[] };
const OPENAI_GPT_IMAGE: Model = { id: 'gpt-image-2', provider: 'openai', caps: ['t2i', 'i2i', 'inpaint'] };
const VELA_IMAGE: Model = { id: 'vela/gpt-image-2', provider: 'vela', caps: ['t2i', 'i2i'] };
const SEEDEDIT: Model = { id: 'doubao-seededit-3-0-i2i-250628', provider: 'volcengine', caps: ['i2i'] };
const NANOBANANA: Model = { id: 'gemini-3.1-flash-image-preview', provider: 'nanobanana', caps: ['t2i'] };
const VELA_VIDEO: Model = { id: 'vela/doubao-seedance-2-0-260128', provider: 'vela', caps: ['t2v', 'i2v'] };
const GROK_VIDEO: Model = { id: 'grok-imagine-video', provider: 'grok', caps: ['t2v', 'i2v', 'audio'] };
const SEEDANCE_BASE: Model = { id: 'openrouter/bytedance/seedance-2.0', provider: 'openrouter', caps: ['t2v', 'i2v'] };
const SEEDANCE_1080: Model = { id: 'openrouter/bytedance/seedance-2.0:1080p', provider: 'openrouter', caps: ['t2v', 'i2v'] };
const HYPERFRAMES: Model = { id: 'hyperframes-html', provider: 'hyperframes', caps: ['t2v'] };

function counter(prefix = 'id'): { next(): string } {
  let n = 0;
  return { next: () => `${prefix}-${++n}` };
}

function generatorNode(
  id: string,
  opts: { x?: number; y?: number; prompt?: string; runs?: GeneratorRunSummary[]; surface?: 'image' | 'video' } = {},
): GenerationGraphNode {
  return {
    id,
    kind: 'generator',
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    w: GENERATOR_DEFAULT_SIZE.w,
    h: GENERATOR_DEFAULT_SIZE.h,
    generator: {
      version: 1,
      surface: opts.surface ?? 'image',
      prompt: opts.prompt ?? 'A cat',
      model: null,
      params: { aspect: '1:1', count: 2 },
      runs: opts.runs ?? [],
    },
  };
}

function imageNode(id: string, rect: { x: number; y: number; w?: number; h?: number }, path = `${id}.png`): GenerationGraphNode {
  return {
    id,
    kind: 'image',
    x: rect.x,
    y: rect.y,
    w: rect.w ?? 320,
    h: rect.h ?? 320,
    image: { path, daemonReady: true },
  };
}

function record(overrides: Partial<GenerationRequestRecord> = {}): GenerationRequestRecord {
  return {
    surface: 'image',
    model: 'gpt-image-2',
    modelBase: 'gpt-image-2',
    provider: 'openai',
    prompt: 'A cat',
    promptSource: 'A cat',
    aspect: '1:1',
    references: [],
    generatorId: 'G',
    runId: 'run-1',
    createdAt: 1,
    ...overrides,
  };
}

function candidate(id: string, index: number, overrides: Partial<GenerationCandidate> = {}): GenerationCandidate {
  return {
    id,
    runId: 'run-1',
    index,
    attempt: 0,
    status: 'pending',
    outputStem: outputStemOf(
      generationOutputName({ generatorId: 'G', runId: 'run-1', index, attempt: 0, surface: 'image' }),
    ),
    ...overrides,
  };
}

function file(path: string, extra: Partial<BoardMediaFile> = {}): BoardMediaFile {
  return { path, mime: 'image/png', size: 100, mtime: 5, ...extra };
}

function mediaData(candidates: GenerationCandidate[], extra: Partial<MediaNodeData> = {}): MediaNodeData {
  return { generation: { candidates, request: record(), sizedToMedia: false }, ...extra };
}

function outputNode(id: string, data: MediaNodeData, rect = { x: 516, y: 200, w: 320, h: 320 }): GenerationGraphNode {
  return { id, kind: 'image', ...rect, media: data };
}

/** Same rules as the daemon's sanitizeName (apps/daemon/src/projects.ts). */
function daemonSanitizeName(raw: string): string {
  return raw
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '_')
    .trim();
}

/** Reference FNV-1a over TextEncoder bytes, to cross-check the hand-written UTF-8 encoder. */
function referenceShortId(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(-6);
}

// ---------------------------------------------------------------------------

describe('naming', () => {
  it('hashes ids with FNV-1a 32-bit (standard vectors) into 6 base36 chars', () => {
    expect(shortGenerationId('a')).toBe((0xe40c292c).toString(36).padStart(6, '0').slice(-6));
    expect(shortGenerationId('foobar')).toBe((0xbf9cf968).toString(36).padStart(6, '0').slice(-6));
    expect(shortGenerationId('')).toBe((0x811c9dc5).toString(36).padStart(6, '0').slice(-6));
    for (const text of ['a', 'run-1', '图片 参考', 'emoji 🎨 ok', 'Ünïcödé']) {
      expect(shortGenerationId(text)).toMatch(/^[0-9a-z]{6}$/);
      expect(shortGenerationId(text)).toBe(referenceShortId(text));
    }
  });

  it('builds stable, flat output names unique per slot and attempt', () => {
    const base = { generatorId: '6f1c2b8e-1d3a-4b5c-9e7f-0a1b2c3d4e5f', runId: 'run/with/slashes', surface: 'image' as const };
    const first = generationOutputName({ ...base, index: 0, attempt: 0 });
    expect(generationOutputName({ ...base, index: 0, attempt: 0 })).toBe(first);
    expect(first).toBe(`gen-${shortGenerationId(base.generatorId)}-${shortGenerationId(base.runId)}-1.png`);
    expect(generationOutputName({ ...base, index: 1, attempt: 2 })).toMatch(/^gen-[0-9a-z]{6}-[0-9a-z]{6}-2r2\.png$/);
    expect(generationOutputName({ ...base, surface: 'video', index: 0, attempt: 0 })).toMatch(/-1\.mp4$/);

    const names = new Set<string>();
    for (let index = 0; index < 4; index++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const name = generationOutputName({ ...base, index, attempt });
        expect(name).not.toContain('/');
        expect(daemonSanitizeName(name)).toBe(name);
        names.add(name);
      }
    }
    expect(names.size).toBe(12);
  });

  it('derives the output stem from a file name or path', () => {
    expect(outputStemOf('gen-abc123-def456-1.png')).toBe('gen-abc123-def456-1');
    expect(outputStemOf('moved/sub/gen-abc123-def456-2r1.jpg')).toBe('gen-abc123-def456-2r1');
    expect(outputStemOf('archive.tar.gz')).toBe('archive.tar');
    expect(outputStemOf('noext')).toBe('noext');
    expect(outputStemOf('.hidden')).toBe('.hidden');
    // The daemon may swap the extension; the stem still matches the planned one.
    const planned = generationOutputName({ generatorId: 'G', runId: 'R', index: 0, attempt: 0, surface: 'image' });
    expect(outputStemOf(planned.replace(/\.png$/, '.webp'))).toBe(outputStemOf(planned));
  });
});

describe('sizing and placement', () => {
  it('sizes media nodes by long edge 320 (image) / 384 (video)', () => {
    expect(mediaNodeSizeFor('image', '1:1')).toEqual({ w: 320, h: 320 });
    expect(mediaNodeSizeFor('image', '16:9')).toEqual({ w: 320, h: 180 });
    expect(mediaNodeSizeFor('image', '9:16')).toEqual({ w: 180, h: 320 });
    expect(mediaNodeSizeFor('image', '4:3')).toEqual({ w: 320, h: 240 });
    expect(mediaNodeSizeFor('image', '3:4')).toEqual({ w: 240, h: 320 });
    expect(mediaNodeSizeFor('video', '16:9')).toEqual({ w: 384, h: 216 });
    expect(mediaNodeSizeFor('video', '9:16')).toEqual({ w: 216, h: 384 });
    expect(mediaNodeSizeFor('image', { width: 1000, height: 500 })).toEqual({ w: 320, h: 160 });
    expect(mediaNodeSizeFor('image', { width: 0, height: 0 })).toEqual({ w: 320, h: 320 });
    expect(mediaNodeSizeFor('image', { width: 10_000, height: 1 })).toEqual({ w: 320, h: 8 });
  });

  it('moves a rect down by (h + stepY) until it is free of non-group nodes', () => {
    const rect = { x: 100, y: 100, w: 200, h: 100 };
    expect(findFreePlacement({ nodes: [], edges: [] }, rect)).toEqual({ x: 100, y: 100 });

    const blocked: GenerationGraph = { nodes: [imageNode('X', { x: 100, y: 100, w: 200, h: 100 })], edges: [] };
    expect(findFreePlacement(blocked, rect)).toEqual({ x: 100, y: 224 });
    expect(findFreePlacement(blocked, rect, { stepY: 40 })).toEqual({ x: 100, y: 240 });
    // A step inside the 16 px margin needs a second move.
    expect(findFreePlacement(blocked, rect, { stepY: 10 })).toEqual({ x: 100, y: 320 });
    expect(findFreePlacement(blocked, rect, { ignoreIds: ['X'] })).toEqual({ x: 100, y: 100 });

    const groupOnly: GenerationGraph = {
      nodes: [{ id: 'Gr', kind: 'group', x: 0, y: 0, w: 2000, h: 2000, memberIds: [] }],
      edges: [],
    };
    expect(findFreePlacement(groupOnly, rect)).toEqual({ x: 100, y: 100 });
  });

  it('keeps a 16 px margin and gives up after maxSteps', () => {
    const rect = { x: 0, y: 0, w: 100, h: 100 };
    const near = (gap: number): GenerationGraph => ({
      nodes: [imageNode('N', { x: 100 + gap, y: 0, w: 50, h: 50 })],
      edges: [],
    });
    expect(findFreePlacement(near(10), rect)).toEqual({ x: 0, y: 124 });
    expect(findFreePlacement(near(16), rect)).toEqual({ x: 0, y: 0 });

    const wall: GenerationGraph = { nodes: [imageNode('W', { x: 0, y: 0, w: 100, h: 1_000_000 })], edges: [] };
    expect(findFreePlacement(wall, rect, { maxSteps: 3 })).toEqual({ x: 0, y: 3 * (100 + GENERATION_LIMITS.placementStepY) });
  });
});

describe('connectability (R3e) and reference readiness', () => {
  it('connects images/others with a picture and notes; never generators, videos or groups', () => {
    const graph: GenerationGraph = { nodes: [], edges: [] };
    expect(canConnectToGenerator(imageNode('A', { x: 0, y: 0 }), graph)).toBe(true);
    expect(canConnectToGenerator({ id: 'P', kind: 'image', x: 0, y: 0, w: 1, h: 1 }, graph)).toBe(false);
    expect(
      canConnectToGenerator(
        { id: 'F', kind: 'other', x: 0, y: 0, w: 1, h: 1, image: { path: 'c.webp', daemonReady: true } },
        graph,
      ),
    ).toBe(true);
    expect(canConnectToGenerator({ id: 'O', kind: 'other', x: 0, y: 0, w: 1, h: 1 }, graph)).toBe(false);
    expect(canConnectToGenerator({ id: 'N', kind: 'note', x: 0, y: 0, w: 1, h: 1, text: '' }, graph)).toBe(true);
    expect(canConnectToGenerator({ id: 'V', kind: 'video', x: 0, y: 0, w: 1, h: 1 }, graph)).toBe(false);
    expect(canConnectToGenerator(generatorNode('G2'), graph)).toBe(false);
    const withMembers: GenerationGraph = { nodes: [imageNode('A', { x: 0, y: 0 })], edges: [] };
    expect(
      canConnectToGenerator({ id: 'Gr', kind: 'group', x: 0, y: 0, w: 1, h: 1, memberIds: ['A'] }, withMembers),
    ).toBe(false);
  });

  it('accepts only project-relative png/jpg/jpeg/webp/gif files up to 16 MB as daemon-ready', () => {
    for (const path of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.gif', 'board-media/refs/ref-x.png']) {
      expect(isDaemonReadyImage({ path }), path).toBe(true);
    }
    for (const path of ['a.svg', 'b.heic', 'noext', '/abs/a.png', '../a.png', 'x/../../a.png', 'https://cdn/a.png', 'data:image/png;base64,AAAA', 'C:\\a.png']) {
      expect(isDaemonReadyImage({ path }), path).toBe(false);
    }
    expect(isDaemonReadyImage({ path: 'a.png', size: GENERATION_LIMITS.referenceMaxBytes })).toBe(true);
    expect(isDaemonReadyImage({ path: 'a.png', size: GENERATION_LIMITS.referenceMaxBytes + 1 })).toBe(false);
  });

  it('maps the derived role to the board lineage kind and back', () => {
    expect(GENERATION_EDGE_ROLE_TO_BOARD_KIND).toEqual({ reference: 'reference', output: 'output', derived: 'lineage' });
    expect(generationEdgeRoleFromBoardKind('lineage')).toBe('derived');
    expect(generationEdgeRoleFromBoardKind('reference')).toBe('reference');
    expect(generationEdgeRoleFromBoardKind('output')).toBe('output');
    expect(generationEdgeRoleFromBoardKind('derived')).toBe('derived');
    expect(generationEdgeRoleFromBoardKind('other')).toBeNull();
  });
});

describe('paramSupportFor', () => {
  it('openai gpt-image: no references (renderer ignores them) but qualities', () => {
    expect(paramSupportFor(OPENAI_GPT_IMAGE, 'image')).toEqual({
      usable: true,
      aspects: MEDIA_ASPECT_VALUES,
      maxReferences: 0,
      requiresReference: false,
      qualities: ['high', 'medium', 'low', 'auto'],
      defaultQuality: 'high',
    });
    const aihubmix = paramSupportFor({ id: 'aihubmix-gpt-image-1', provider: 'aihubmix', caps: ['t2i', 'i2i'] }, 'image');
    expect(aihubmix.qualities).toEqual(['high', 'medium', 'low', 'auto']);
    expect(aihubmix.maxReferences).toBe(0);
  });

  it('vela image reads up to 5 references; nanobanana exposes 1K/2K/4K', () => {
    const vela = paramSupportFor(VELA_IMAGE, 'image');
    expect(vela).toMatchObject({ usable: true, maxReferences: 5, requiresReference: false });
    expect(vela.qualities).toBeUndefined();
    expect(vela.lengths).toBeUndefined();
    expect(paramSupportFor(NANOBANANA, 'image')).toMatchObject({
      usable: true,
      resolutions: ['1K', '2K', '4K'],
      defaultResolution: '1K',
      maxReferences: 0,
    });
  });

  it('marks SeedEdit (i2i only, renderer cannot feed references) unusable', () => {
    expect(paramSupportFor(SEEDEDIT, 'image')).toMatchObject({ usable: false, requiresReference: true, maxReferences: 0 });
  });

  it('vela video: three aspects and 5/10 s; other video renderers: all aspects and 3..30 s', () => {
    expect(paramSupportFor(VELA_VIDEO, 'video')).toMatchObject({
      usable: true,
      aspects: ['16:9', '9:16', '1:1'],
      lengths: [5, 10],
      maxReferences: 5,
    });
    expect(paramSupportFor(GROK_VIDEO, 'video')).toMatchObject({
      usable: true,
      aspects: MEDIA_ASPECT_VALUES,
      lengths: [3, 5, 8, 10, 15, 30],
      maxReferences: 1,
    });
  });

  it('seedance variants: resolutions from the group, default from the picked id', () => {
    expect(paramSupportFor(SEEDANCE_BASE, 'video')).toMatchObject({
      usable: true,
      resolutions: ['480p', '720p', '1080p'],
      defaultResolution: '720p',
      maxReferences: 9,
    });
    expect(paramSupportFor(SEEDANCE_1080, 'video').defaultResolution).toBe('1080p');
    expect(variantGroupFor(SEEDANCE_1080.id)?.baseId).toBe(SEEDANCE_BASE.id);
    expect(variantGroupFor('openrouter/bytedance/seedance-2.0:480p')?.baseId).toBe(SEEDANCE_BASE.id);
    expect(variantGroupFor('grok-imagine-video')).toBeNull();
    expect(resolveModelVariant(SEEDANCE_BASE.id, '1080p')).toBe(SEEDANCE_1080.id);
    expect(resolveModelVariant(SEEDANCE_BASE.id, '480P')).toBe('openrouter/bytedance/seedance-2.0:480p');
    expect(resolveModelVariant(SEEDANCE_BASE.id, undefined)).toBe(SEEDANCE_BASE.id);
    expect(resolveModelVariant(SEEDANCE_BASE.id, 'bogus')).toBe(SEEDANCE_BASE.id);
    expect(resolveModelVariant(SEEDANCE_1080.id, '480p')).toBe('openrouter/bytedance/seedance-2.0:480p');
    expect(resolveModelVariant(SEEDANCE_1080.id, undefined)).toBe(SEEDANCE_1080.id);
    expect(resolveModelVariant(SEEDANCE_1080.id, 'bogus')).toBe(SEEDANCE_1080.id);
    expect(resolveModelVariant('grok-imagine-video', '1080p')).toBe('grok-imagine-video');
  });

  it('hides hyperframes, unrendered providers and models without a capability for the surface', () => {
    expect(paramSupportFor(HYPERFRAMES, 'video').usable).toBe(false);
    expect(paramSupportFor({ ...HYPERFRAMES, provider: 'vela' }, 'video').usable).toBe(false);
    expect(GENERATION_RENDERED_PROVIDERS.video).not.toContain('hyperframes');
    expect(paramSupportFor({ id: 'unknown-image', provider: 'unimplemented', caps: ['t2i', 'i2i'] }, 'image').usable).toBe(false);
    expect(paramSupportFor({ id: 'flux-2-pro', provider: 'bfl', caps: ['t2i', 'i2i'] }, 'image')).toMatchObject({ usable: true, maxReferences: 1 });
    expect(paramSupportFor(GROK_VIDEO, 'image').usable).toBe(false);
  });
});

describe('clampParams / defaultParamsFor', () => {
  it('drops unsupported quality/resolution/length and clamps count', () => {
    const vela = paramSupportFor(VELA_IMAGE, 'image');
    expect(
      clampParams({ aspect: '4:3', count: 7 as GeneratorParams['count'], quality: 'low', resolution: '2K', length: 5 }, vela, 'image'),
    ).toEqual({ aspect: '4:3', count: 4 });
    expect(clampParams({ aspect: '1:1', count: 0 as GeneratorParams['count'] }, vela, 'image').count).toBe(1);
    expect(clampParams({ aspect: '1:1', count: 2.6 as GeneratorParams['count'] }, vela, 'image').count).toBe(3);
    expect(clampParams({ aspect: '1:1', count: Number.NaN as GeneratorParams['count'] }, vela, 'image').count).toBe(2);
  });

  it('keeps supported values (case-insensitive) and fills defaults for supported controls', () => {
    const gpt = paramSupportFor(OPENAI_GPT_IMAGE, 'image');
    expect(clampParams({ aspect: '1:1', count: 1, quality: 'LOW' }, gpt, 'image').quality).toBe('low');
    expect(clampParams({ aspect: '1:1', count: 1, quality: 'ultra' }, gpt, 'image').quality).toBe('high');
    expect(clampParams({ aspect: '1:1', count: 1 }, gpt, 'image').quality).toBe('high');
    const nano = paramSupportFor(NANOBANANA, 'image');
    expect(clampParams({ aspect: '1:1', count: 1, resolution: '2k' }, nano, 'image').resolution).toBe('2K');
    expect(clampParams({ aspect: '1:1', count: 1, resolution: '8K' }, nano, 'image').resolution).toBe('1K');
  });

  it('snaps aspects to the nearest supported ratio, keeping the orientation on ties', () => {
    const vela = paramSupportFor(VELA_VIDEO, 'video');
    expect(clampParams({ aspect: '4:3', count: 1 }, vela, 'video').aspect).toBe('16:9');
    expect(clampParams({ aspect: '3:4', count: 1 }, vela, 'video').aspect).toBe('9:16');
    expect(clampParams({ aspect: '1:1', count: 1 }, vela, 'video').aspect).toBe('1:1');
  });

  it('snaps video lengths to the nearest supported value (ties keep the shorter, like the daemon)', () => {
    const vela = paramSupportFor(VELA_VIDEO, 'video');
    expect(clampParams({ aspect: '16:9', count: 1, length: 7 }, vela, 'video').length).toBe(5);
    expect(clampParams({ aspect: '16:9', count: 1, length: 8 }, vela, 'video').length).toBe(10);
    expect(clampParams({ aspect: '16:9', count: 1 }, vela, 'video').length).toBe(5);
    const grok = paramSupportFor(GROK_VIDEO, 'video');
    expect(clampParams({ aspect: '16:9', count: 1, length: 4 }, grok, 'video').length).toBe(3);
    expect(clampParams({ aspect: '16:9', count: 1, length: 20 }, grok, 'video').length).toBe(15);
  });

  it('is idempotent', () => {
    const cases: Array<[GeneratorParams, Model, 'image' | 'video']> = [
      [{ aspect: '3:4', count: 4, length: 12, quality: 'Medium' }, VELA_VIDEO, 'video'],
      [{ aspect: '16:9', count: 3, quality: 'auto' }, OPENAI_GPT_IMAGE, 'image'],
      [{ aspect: '9:16', count: 1, resolution: '1080P' }, SEEDANCE_BASE, 'video'],
    ];
    for (const [params, model, surface] of cases) {
      const support = paramSupportFor(model, surface);
      const once = clampParams(params, support, surface);
      expect(clampParams(once, support, surface)).toEqual(once);
    }
  });

  it('starts from the surface defaults and applies preferences', () => {
    expect(defaultParamsFor('image', paramSupportFor(VELA_IMAGE, 'image'))).toEqual({ aspect: '1:1', count: 2 });
    expect(defaultParamsFor('image', paramSupportFor(OPENAI_GPT_IMAGE, 'image'))).toEqual({
      aspect: '1:1',
      count: 2,
      quality: 'high',
    });
    expect(defaultParamsFor('video', paramSupportFor(VELA_VIDEO, 'video'))).toEqual({
      aspect: '16:9',
      count: 1,
      length: 5,
    });
    expect(
      defaultParamsFor('video', paramSupportFor(SEEDANCE_BASE, 'video'), { aspect: '9:16', count: 3, length: 10 }),
    ).toEqual({ aspect: '9:16', count: 3, length: 10, resolution: '720p' });
  });
});

describe('generator factories and copies', () => {
  it('creates generator node inputs with surface defaults', () => {
    const image = createGeneratorNodeInput({ id: 'G', x: 10, y: 20 });
    expect(image).toEqual({
      id: 'G',
      kind: 'generator',
      x: 10,
      y: 20,
      w: 320,
      h: 320,
      title: '',
      data: { version: 1, surface: 'image', prompt: '', model: null, params: { aspect: '1:1', count: 2 }, runs: [] },
    });
    const video = createGeneratorNodeInput({
      id: 'V',
      x: 0,
      y: 0,
      surface: 'video',
      prompt: 'waves',
      model: 'grok-imagine-video',
      params: { count: 9 as GeneratorParams['count'], aspect: '9:16' },
    });
    expect(video.data).toEqual({
      version: 1,
      surface: 'video',
      prompt: 'waves',
      model: 'grok-imagine-video',
      params: { aspect: '9:16', count: 4, length: 5 },
      runs: [],
    });
  });

  it('creates a generator right of the selection with reference edges from eligible nodes', () => {
    const graph: GenerationGraph = {
      nodes: [
        imageNode('A', { x: 0, y: 0 }),
        imageNode('B', { x: 400, y: 50, w: 200, h: 200 }),
        { id: 'N', kind: 'note', x: 0, y: 400, w: 280, h: 220, text: 'calm' },
        { id: 'V', kind: 'video', x: 700, y: 0, w: 384, h: 216 },
        { id: 'Gr', kind: 'group', x: -50, y: -50, w: 1200, h: 800, memberIds: ['A', 'B'] },
      ],
      edges: [],
    };
    const result = createGeneratorForSelection(graph, ['B', 'A', 'V', 'N', 'Gr', 'missing', 'A'], counter(), 'video');
    expect(result.generatorId).toBe('id-1');
    const [add, ...edges] = result.ops;
    expect(add).toMatchObject({
      type: 'node.add',
      node: { id: 'id-1', kind: 'generator', x: 1150 + 96, y: -50, data: { surface: 'video' } },
    });
    expect(edges).toEqual([
      { type: 'edge.add', edge: { id: 'id-2', from: 'B', to: 'id-1', role: 'reference' } },
      { type: 'edge.add', edge: { id: 'id-3', from: 'A', to: 'id-1', role: 'reference' } },
      { type: 'edge.add', edge: { id: 'id-4', from: 'N', to: 'id-1', role: 'reference' } },
    ]);

    const occupied: GenerationGraph = {
      nodes: [imageNode('A', { x: 0, y: 0 }), imageNode('O', { x: 416, y: 0, w: 100, h: 100 })],
      edges: [],
    };
    const shifted = createGeneratorForSelection(occupied, ['A'], counter());
    expect(shifted.ops[0]).toMatchObject({ node: { x: 416, y: 320 + 24 } });
  });

  it('drops run history from generator copies', () => {
    const data = generatorNode('G', {
      runs: [{ runId: 'r', outputNodeId: 'R', surface: 'image', model: 'm', count: 1, startedAt: 1 }],
    }).generator!;
    const withTemplate = { ...data, templateId: 'tpl-1' };
    const copy = cloneGeneratorData(withTemplate);
    expect(copy.runs).toEqual([]);
    expect(copy.templateId).toBe('tpl-1');
    copy.params.count = 4;
    expect(withTemplate.params.count).toBe(2);
  });

  it('drops non-terminal candidates from media copies and keeps the primary mirror', () => {
    const done = candidate('c1', 0, { status: 'done', file: file('one.png') });
    const data = mediaData(
      [
        done,
        candidate('c2', 1, { status: 'running', taskId: 't2' }),
        candidate('c3', 2, { status: 'failed', error: { message: 'x', nextStep: 'retry-later' } }),
        candidate('c4', 3, { status: 'stopped', taskId: 't4' }),
        candidate('c5', 4, { status: 'lost' }),
        candidate('c6', 5),
        candidate('c7', 6, { status: 'queued', taskId: 't7' }),
        candidate('c8', 7, { status: 'interrupted' }),
      ],
      { file: file('one.png') },
    );
    data.generation!.primaryCandidateId = 'c1';
    const copy = cloneMediaNodeData(data);
    expect(copy.generation?.candidates.map((entry) => entry.id)).toEqual(['c1', 'c3', 'c5', 'c8']);
    expect(copy.generation?.primaryCandidateId).toBe('c1');
    expect(copy.file).toEqual(file('one.png'));
    copy.generation!.candidates[0]!.file!.path = 'changed.png';
    expect(done.file?.path).toBe('one.png');

    const primaryDropped = mediaData([done, candidate('c2', 1, { status: 'running' })]);
    primaryDropped.generation!.primaryCandidateId = 'c2';
    const fallback = cloneMediaNodeData(primaryDropped);
    expect(fallback.generation?.primaryCandidateId).toBe('c1');
    expect(fallback.file).toEqual(file('one.png'));

    const onlyActive = cloneMediaNodeData(mediaData([candidate('c2', 1, { status: 'running' })], { refProxy: { path: 'p.png', sourceKey: 'k' } }));
    expect(onlyActive).toEqual({ refProxy: { path: 'p.png', sourceKey: 'k' } });
  });
});

describe('planGenerationRun', () => {
  function plan(options: {
    graph?: GenerationGraph;
    model?: Model;
    params?: GeneratorParams;
    surface?: 'image' | 'video';
    runs?: GeneratorRunSummary[];
    refs?: number;
    templateId?: string;
  } = {}) {
    const surface = options.surface ?? 'image';
    const model = options.model ?? OPENAI_GPT_IMAGE;
    const refNodes = Array.from({ length: options.refs ?? 0 }, (_, i) => imageNode(`ref${i}`, { x: -2000, y: i * 400 }));
    const graph = options.graph ?? {
      nodes: [
        generatorNode('G', {
          x: 100,
          y: 200,
          surface,
          prompt: 'A cat',
          ...(options.runs ? { runs: options.runs } : {}),
        }),
        ...refNodes,
      ],
      edges: refNodes.map((node, order) => ({ id: `e${order}`, from: node.id, to: 'G', role: 'reference' as const, order })),
    };
    const support = paramSupportFor(model, surface);
    const compiled = compileGeneration(graph, 'G', {
      maxReferences: support.maxReferences,
      requiresReference: support.requiresReference,
      labels: REFERENCE_LABELS.en,
    });
    const ids = counter();
    const params = options.params ?? defaultParamsFor(surface, support);
    return {
      graph,
      support,
      result: planGenerationRun({
        graph,
        generatorId: 'G',
        compiled,
        model,
        params,
        support,
        now: 1_000,
        ids,
        title: 'A cat',
        ...(options.templateId ? { templateId: options.templateId } : {}),
      }),
    };
  }

  it('adds the output node right of G with pending candidates, an output edge and a G patch', () => {
    const { result } = plan({ params: { aspect: '1:1', count: 3, quality: 'low' } });
    expect(result.runId).toBe('id-1');
    expect(result.outputNodeId).toBe('id-2');
    const [add, edge, patch] = result.ops;
    expect(add?.type).toBe('node.add');
    const node = (add as { node: GenerationNodeInput }).node;
    expect(node).toMatchObject({ id: 'id-2', kind: 'image', x: 100 + 320 + 96, y: 200, w: 320, h: 320, title: 'A cat' });
    const data = node.data as MediaNodeData;
    expect(data.file).toBeUndefined();
    expect(data.generation?.sizedToMedia).toBe(false);
    expect(data.generation?.candidates).toEqual(
      ['id-3', 'id-4', 'id-5'].map((id, index) => ({
        id,
        runId: 'id-1',
        index,
        attempt: 0,
        status: 'pending',
        outputStem: outputStemOf(generationOutputName({ generatorId: 'G', runId: 'id-1', index, attempt: 0, surface: 'image' })),
      })),
    );
    expect(edge).toEqual({ type: 'edge.add', edge: { id: 'id-6', from: 'G', to: 'id-2', role: 'output' } });
    expect(patch).toEqual({
      type: 'node.patchData',
      id: 'G',
      patch: {
        runs: [{ runId: 'id-1', outputNodeId: 'id-2', surface: 'image', model: 'gpt-image-2', count: 3, startedAt: 1_000 }],
        model: 'gpt-image-2',
      },
    });
    expect(result.slots.map((slot) => slot.candidateId)).toEqual(['id-3', 'id-4', 'id-5']);
    const outputs = result.slots.map((slot) => slot.request.output);
    expect(new Set(outputs).size).toBe(3);
    expect(outputs.every((name) => name?.endsWith('.png'))).toBe(true);
    expect(result.slots[0]?.request).toEqual({
      surface: 'image',
      model: 'gpt-image-2',
      prompt: 'A cat',
      output: generationOutputName({ generatorId: 'G', runId: 'id-1', index: 0, attempt: 0, surface: 'image' }),
      aspect: '1:1',
      quality: 'low',
    });
    expect(result.request).toMatchObject({ prompt: 'A cat', promptSource: 'A cat', createdAt: 1_000, references: [] });
  });

  it('shifts the output node down when the spot right of G is taken', () => {
    const graph: GenerationGraph = {
      nodes: [generatorNode('G', { x: 100, y: 200 }), imageNode('X', { x: 516, y: 200 })],
      edges: [],
    };
    const node = (plan({ graph }).result.ops[0] as { node: GenerationNodeInput }).node;
    expect(node).toMatchObject({ x: 516, y: 200 + 320 + 24 });
  });

  it('caps G.runs at 20, newest first', () => {
    const runs = Array.from({ length: 20 }, (_, i): GeneratorRunSummary => ({
      runId: `old-${i}`,
      outputNodeId: `R${i}`,
      surface: 'image',
      model: 'm',
      count: 1,
      startedAt: i,
    }));
    const patch = plan({ runs }).result.ops[2] as { patch: { runs: GeneratorRunSummary[] } };
    expect(patch.patch.runs).toHaveLength(GENERATION_LIMITS.runHistory);
    expect(patch.patch.runs[0]?.runId).toBe('id-1');
    expect(patch.patch.runs[19]?.runId).toBe('old-18');
  });

  it('splits references into image (primary) and images (extras)', () => {
    const three = plan({ model: VELA_IMAGE, refs: 3 }).result;
    expect(three.slots[0]?.request.image).toBe('ref0.png');
    expect(three.slots[0]?.request.images).toEqual(['ref1.png', 'ref2.png']);
    expect(three.request.references.map((ref) => ref.label)).toEqual(['Image 1', 'Image 2', 'Image 3']);
    const one = plan({ model: VELA_IMAGE, refs: 1 }).result.slots[0]?.request;
    expect(one?.image).toBe('ref0.png');
    expect(one && 'images' in one).toBe(false);
    const none = plan({ model: VELA_IMAGE }).result.slots[0]?.request;
    expect(none && ('image' in none || 'images' in none)).toBe(false);
  });

  it('sends quality/resolution/length only when supported', () => {
    const vela = plan({ model: VELA_IMAGE, params: { aspect: '1:1', count: 1, quality: 'low', resolution: '2K' } }).result;
    expect(vela.slots[0]?.request).not.toHaveProperty('quality');
    expect(vela.slots[0]?.request).not.toHaveProperty('resolution');
    expect(vela.slots[0]?.request).not.toHaveProperty('length');

    const nano = plan({ model: NANOBANANA, params: { aspect: '1:1', count: 1, resolution: '2K' } }).result;
    expect(nano.slots[0]?.request.resolution).toBe('2K');

    const video = plan({ model: VELA_VIDEO, surface: 'video', params: { aspect: '16:9', count: 1, length: 10 } }).result;
    expect(video.slots[0]?.request).toMatchObject({ surface: 'video', length: 10, aspect: '16:9' });
    expect(video.slots[0]?.request.output).toMatch(/\.mp4$/);
    const videoNode = (video.ops[0] as { node: GenerationNodeInput }).node;
    expect(videoNode).toMatchObject({ kind: 'video', w: 384, h: 216 });
  });

  it('resolves variant ids for the request and keeps the base id on the generator', () => {
    const base = plan({
      model: SEEDANCE_BASE,
      surface: 'video',
      params: { aspect: '16:9', count: 1, length: 5, resolution: '1080p' },
    }).result;
    expect(base.request).toMatchObject({ model: SEEDANCE_1080.id, modelBase: SEEDANCE_BASE.id, resolution: '1080p' });
    expect(base.slots[0]?.request.model).toBe(SEEDANCE_1080.id);
    expect(base.slots[0]?.request).not.toHaveProperty('resolution');
    expect((base.ops[2] as { patch: { model: string } }).patch.model).toBe(SEEDANCE_BASE.id);

    // A variant id picked directly (CLI) keeps its own resolution.
    const picked = plan({ model: SEEDANCE_1080, surface: 'video' }).result;
    expect(picked.request.model).toBe(SEEDANCE_1080.id);
    expect((picked.ops[2] as { patch: { model: string } }).patch.model).toBe(SEEDANCE_BASE.id);
  });

  it('records the template id and refuses blocked compilations or missing generators', () => {
    expect(plan({ templateId: 'tpl-9' }).result.request.templateId).toBe('tpl-9');
    const graph: GenerationGraph = { nodes: [generatorNode('G', { prompt: '' })], edges: [] };
    const support = paramSupportFor(OPENAI_GPT_IMAGE, 'image');
    const blocked = compileGeneration(graph, 'G', { maxReferences: 0, requiresReference: false, labels: REFERENCE_LABELS.en });
    const input = {
      graph,
      generatorId: 'G',
      compiled: blocked,
      model: OPENAI_GPT_IMAGE,
      params: defaultParamsFor('image', support),
      support,
      now: 1,
      ids: counter(),
      title: 't',
    };
    expect(() => planGenerationRun(input)).toThrow(/blocked/);
    expect(() => planGenerationRun({ ...input, compiled: { ...blocked, ok: true }, generatorId: 'nope' })).toThrow(/not found/);
  });

  it('builds the request from a record (empty prompt allowed with references)', () => {
    expect(
      buildMediaGenerateRequest(
        record({ prompt: '', references: [{ nodeId: 'A', path: 'a.png', label: 'Image 1' }] }),
        'gen-x-y-1.png',
      ),
    ).toEqual({ surface: 'image', model: 'gpt-image-2', prompt: '', output: 'gen-x-y-1.png', aspect: '1:1', image: 'a.png' });
  });
});

describe('candidate patches', () => {
  const doneSnapshot: MediaTaskSnapshotResponse = {
    taskId: 't1',
    status: 'done',
    startedAt: 10,
    endedAt: 20,
    progress: ['rendering'],
    nextSince: 1,
    file: {
      name: 'gen-x-y-1.jpg',
      size: 123,
      mtime: 456,
      mime: 'image/jpeg',
      kind: 'image',
      providerNote: '[stub] fallback image',
      warnings: ['--length 7 clamped to 8'],
      usedStubFallback: true,
    },
    error: null,
  };

  it('maps accepted, queued and running states', () => {
    expect(candidatePatchFromAccepted('c1', { taskId: 't1', status: 'queued', startedAt: 10 })).toEqual({
      id: 'c1',
      taskId: 't1',
      status: 'queued',
      startedAt: 10,
    });
    expect(candidatePatchFromAccepted('c1', { taskId: 't1', status: 'done', startedAt: 0 })).toEqual({
      id: 'c1',
      taskId: 't1',
      status: 'running',
    });
    expect(
      candidatePatchFromSnapshot('c1', { ...doneSnapshot, status: 'running', endedAt: null, file: null }, 'gpt-image-2'),
    ).toEqual({ id: 'c1', taskId: 't1', status: 'running', startedAt: 10 });
  });

  it('maps a done snapshot to file, note, warnings and the stub flag (progress is not persisted)', () => {
    const patch = candidatePatchFromSnapshot('c1', doneSnapshot, 'gpt-image-2');
    expect(patch).toEqual({
      id: 'c1',
      taskId: 't1',
      status: 'done',
      startedAt: 10,
      endedAt: 20,
      file: { path: 'gen-x-y-1.jpg', size: 123, mtime: 456, mime: 'image/jpeg' },
      providerNote: '[stub] fallback image',
      warnings: ['--length 7 clamped to 8'],
      stub: true,
    });
    expect(Object.prototype.hasOwnProperty.call(patch, 'error')).toBe(true);
    expect(patch).not.toHaveProperty('progress');
    const intentional = candidatePatchFromSnapshot(
      'c1',
      { ...doneSnapshot, file: { name: 'a.png', intentionalStub: true } },
      'gpt-image-2',
    );
    expect(intentional.stub).toBe(true);
    const real = candidatePatchFromSnapshot('c1', { ...doneSnapshot, file: { name: 'a.png' } }, 'gpt-image-2');
    expect(real).not.toHaveProperty('stub');
  });

  it('maps a done snapshot without a file to a failure', () => {
    expect(candidatePatchFromSnapshot('c1', { ...doneSnapshot, file: null }, 'm')).toMatchObject({
      status: 'failed',
      error: { nextStep: 'contact-support', code: 'MEDIA_OUTPUT_MISSING' },
    });
  });

  it('maps failures through nextStep, falling back to mediaFailureNextStep', () => {
    const failed = (error: ProjectMediaTaskError | null, model = 'gpt-image-2') =>
      candidatePatchFromSnapshot('c1', { ...doneSnapshot, status: 'failed', file: null, error }, model);
    expect(failed({ message: 'refused', nextStep: 'revise-request', code: 'safety_rejection', subject: 'prompt' })).toEqual({
      id: 'c1',
      taskId: 't1',
      status: 'failed',
      startedAt: 10,
      endedAt: 20,
      error: { message: 'refused', nextStep: 'revise-request', code: 'safety_rejection', subject: 'prompt' },
    });
    expect(failed({ message: 'media model "x" is not allowed', code: 'MEDIA_MODEL_DENIED', status: 403 }).error?.nextStep).toBe(
      'switch-model',
    );
    expect(failed({ message: 'openai image 429: slow down' }).error?.nextStep).toBe('retry-later');
    expect(failed({ message: 'unauthorized', status: 401 }, 'vela/gpt-image-2').error?.nextStep).toBe('sign-in');
    expect(failed(null).error).toEqual({ message: 'The generation failed.', nextStep: 'contact-support' });
  });

  it('maps interrupted to retry-later', () => {
    const patch = candidatePatchFromSnapshot(
      'c1',
      {
        ...doneSnapshot,
        status: 'interrupted',
        file: null,
        error: { message: 'daemon restarted', code: 'DAEMON_RESTART', nextStep: 'contact-support' },
      },
      'm',
    );
    expect(patch.status).toBe('interrupted');
    expect(patch.error).toEqual({ message: 'daemon restarted', nextStep: 'retry-later', code: 'DAEMON_RESTART' });
  });

  it('maps task-list rows like snapshots', () => {
    const task: ProjectMediaTask = {
      taskId: 't9',
      status: 'done',
      startedAt: 5,
      endedAt: 9,
      elapsed: 4,
      progress: ['a', 'b', 'c'],
      progressCount: 3,
      file: { name: 'moved/gen-a-b-1.png', size: 10, mtime: 11, mime: 'image/png', kind: 'image' },
    };
    expect(candidatePatchFromTask('c1', task, 'm')).toEqual({
      id: 'c1',
      taskId: 't9',
      status: 'done',
      startedAt: 5,
      endedAt: 9,
      file: { path: 'moved/gen-a-b-1.png', size: 10, mtime: 11, mime: 'image/png' },
    });
    expect(candidatePatchFromTask('c1', { ...task, status: 'running', endedAt: null }, 'm')).toEqual({
      id: 'c1',
      taskId: 't9',
      status: 'running',
      startedAt: 5,
    });
    expect(
      candidatePatchFromTask('c1', { ...task, status: 'failed', error: { message: 'x', code: 'MEDIA_MODEL_DENIED' } }, 'm')
        .error?.nextStep,
    ).toBe('switch-model');
  });

  it('maps POST errors: sandbox TOOL_TOKEN_MISSING, MEDIA_MODEL_DENIED and plain statuses', () => {
    expect(
      candidatePatchFromHttpError(
        'c1',
        { status: 401, code: 'TOOL_TOKEN_MISSING', message: 'tool token is required for media generation in sandbox mode' },
        'gpt-image-2',
      ),
    ).toEqual({
      id: 'c1',
      status: 'failed',
      error: {
        message: 'tool token is required for media generation in sandbox mode',
        nextStep: 'unsupported',
        messageKey: 'fantay.gen.sandbox',
        code: 'TOOL_TOKEN_MISSING',
        status: 401,
      },
    });
    const denied = candidatePatchFromHttpError('c1', { status: 403, code: 'MEDIA_MODEL_DENIED', message: 'denied' }, 'm');
    expect(denied.error).toEqual({ message: 'denied', nextStep: 'switch-model', code: 'MEDIA_MODEL_DENIED', status: 403 });
    expect(candidatePatchFromHttpError('c1', { status: 403, message: 'cross-origin request rejected' }, 'm').error?.nextStep).toBe(
      'open-settings',
    );
    expect(candidatePatchFromHttpError('c1', { status: 503, message: 'busy' }, 'm').error?.nextStep).toBe('retry-later');
    expect(candidatePatchFromHttpError('c1', { status: 0, message: 'x' }, 'm').error).not.toHaveProperty('status');
  });

  it('maps network errors to retry-later', () => {
    expect(candidatePatchNetworkError('c1', 'Failed to fetch')).toEqual({
      id: 'c1',
      status: 'failed',
      error: { message: 'Failed to fetch', nextStep: 'retry-later', retryable: true },
    });
    expect(candidatePatchNetworkError('c1', '').error?.message).toBe('Network error');
  });
});

describe('reducers', () => {
  it('makes the first done candidate primary and mirrors its file', () => {
    const data = mediaData([candidate('c1', 0), candidate('c2', 1)]);
    const second = applyCandidatePatch(data, { id: 'c2', status: 'done', taskId: 't2', file: file('two.png') });
    expect(second.firstDone).toBe(true);
    expect(second.data.generation?.primaryCandidateId).toBe('c2');
    expect(second.data.file).toEqual(file('two.png'));
    expect(data.generation?.primaryCandidateId).toBeUndefined();

    const first = applyCandidatePatch(second.data, { id: 'c1', status: 'done', file: file('one.png') });
    expect(first.firstDone).toBe(false);
    expect(first.data.generation?.primaryCandidateId).toBe('c2');
    expect(first.data.file).toEqual(file('two.png'));

    const probed = applyCandidatePatch(first.data, { id: 'c2', file: file('two.png', { width: 1024, height: 768 }) });
    expect(probed.data.file).toEqual(file('two.png', { width: 1024, height: 768 }));
  });

  it('applies undefined as a clear and never changes id/runId/index', () => {
    const data = mediaData([
      candidate('c1', 0, { status: 'failed', taskId: 't1', error: { message: 'x', nextStep: 'retry-later' } }),
    ]);
    const next = applyCandidatePatch(data, {
      id: 'c1',
      status: 'pending',
      taskId: undefined,
      error: undefined,
      runId: 'hijack',
      index: 9,
    } as unknown as Parameters<typeof applyCandidatePatch>[1]).data.generation!.candidates[0]!;
    expect(next).toEqual({ ...candidate('c1', 0), status: 'pending' });
    expect('taskId' in next || 'error' in next).toBe(false);
    expect(applyCandidatePatch(data, { id: 'unknown', status: 'done' }).data).toBe(data);
  });

  it('sets the primary candidate and mirrors (or clears) the file', () => {
    let data = mediaData([
      candidate('c1', 0, { status: 'done', file: file('one.png') }),
      candidate('c2', 1, { status: 'done', file: file('two.png') }),
      candidate('c3', 2, { status: 'running' }),
    ]);
    data = setPrimaryCandidate(data, 'c2');
    expect(data.generation?.primaryCandidateId).toBe('c2');
    expect(data.file).toEqual(file('two.png'));
    const running = setPrimaryCandidate(data, 'c3');
    expect(running.generation?.primaryCandidateId).toBe('c3');
    expect('file' in running).toBe(false);
    expect(setPrimaryCandidate(data, 'nope')).toBe(data);
  });

  it('removes candidates: last → null, primary falls back to the first done one', () => {
    expect(removeCandidate(mediaData([candidate('c1', 0)]), 'c1')).toBeNull();

    const base = mediaData([
      candidate('c1', 0, { status: 'done', file: file('one.png') }),
      candidate('c2', 1, { status: 'failed', error: { message: 'x', nextStep: 'retry-later' } }),
      candidate('c3', 2, { status: 'done', file: file('three.png') }),
    ]);
    const withPrimary = setPrimaryCandidate(base, 'c1');
    const fallback = removeCandidate(withPrimary, 'c1');
    expect(fallback?.generation?.candidates.map((entry) => entry.id)).toEqual(['c2', 'c3']);
    expect(fallback?.generation?.primaryCandidateId).toBe('c3');
    expect(fallback?.file).toEqual(file('three.png'));

    const nonPrimary = removeCandidate(withPrimary, 'c2');
    expect(nonPrimary?.generation?.primaryCandidateId).toBe('c1');
    expect(nonPrimary?.file).toEqual(file('one.png'));

    const noDoneLeft = removeCandidate(
      setPrimaryCandidate(mediaData([candidate('c1', 0, { status: 'done', file: file('one.png') }), candidate('c2', 1)]), 'c1'),
      'c1',
    );
    expect(noDoneLeft?.generation?.primaryCandidateId).toBeUndefined();
    expect(noDoneLeft && 'file' in noDoneLeft).toBe(false);

    expect(removeCandidate(base, 'nope')).toBe(base);
  });

  it('promotes a done candidate as a copy under R, wired from the generator or R', () => {
    const data = mediaData([candidate('c1', 0, { status: 'done', file: file('one.png') }), candidate('c2', 1)]);
    const r = outputNode('R', data);
    const withGenerator: GenerationGraph = { nodes: [generatorNode('G', { x: 100, y: 200 }), r], edges: [] };
    const promoted = promoteCandidateOps(withGenerator, 'R', 'c1', counter('p'), 'Cat · 1');
    expect(promoted?.newNodeId).toBe('p-1');
    expect(promoted?.ops).toEqual([
      {
        type: 'node.add',
        node: { id: 'p-1', kind: 'image', x: 516, y: 200 + 320 + 24, w: 320, h: 320, title: 'Cat · 1', data: { file: file('one.png') } },
      },
      { type: 'edge.add', edge: { id: 'p-2', from: 'G', to: 'p-1', role: 'output' } },
    ]);
    // Copy semantics: no op touches R, so the candidate stays there.
    expect(promoted?.ops.some((op) => 'id' in op && op.id === 'R')).toBe(false);

    const orphan = promoteCandidateOps({ nodes: [r], edges: [] }, 'R', 'c1', counter('p'), 't');
    expect(orphan?.ops[1]).toEqual({ type: 'edge.add', edge: { id: 'p-2', from: 'R', to: 'p-1', role: 'derived' } });

    expect(promoteCandidateOps(withGenerator, 'R', 'c2', counter(), 't')).toBeNull();
    expect(promoteCandidateOps(withGenerator, 'G', 'c1', counter(), 't')).toBeNull();
  });

  it('plans a retry with a new stem that clears the previous task and error', () => {
    const failedCandidate = candidate('c1', 0, {
      status: 'failed',
      taskId: 't1',
      startedAt: 1,
      endedAt: 2,
      error: { message: 'x', nextStep: 'retry-later' },
    });
    const data = mediaData([failedCandidate]);
    const node = outputNode('R', data);
    const retry = planCandidateRetry(node, 'c1');
    const expectedName = generationOutputName({ generatorId: 'G', runId: 'run-1', index: 0, attempt: 1, surface: 'image' });
    expect(expectedName).toMatch(/-1r1\.png$/);
    expect(retry?.request.output).toBe(expectedName);
    expect(retry?.request).toMatchObject({ surface: 'image', model: 'gpt-image-2', prompt: 'A cat' });
    const applied = applyCandidatePatch(data, retry!.patch).data.generation!.candidates[0]!;
    expect(applied).toEqual({
      id: 'c1',
      runId: 'run-1',
      index: 0,
      attempt: 1,
      status: 'pending',
      outputStem: outputStemOf(expectedName),
    });
    for (const status of ['interrupted', 'lost', 'stopped'] as const) {
      expect(planCandidateRetry(outputNode('R', mediaData([candidate('c1', 0, { status })])), 'c1')).not.toBeNull();
    }
    for (const status of ['pending', 'queued', 'running', 'done'] as const) {
      expect(planCandidateRetry(outputNode('R', mediaData([candidate('c1', 0, { status })])), 'c1')).toBeNull();
    }
  });

  it('plans more-like-this with a fresh run id, capped at 16 candidates', () => {
    const data = mediaData([candidate('c1', 0, { status: 'done', file: file('one.png') }), candidate('c2', 1)]);
    const more = planMoreLikeThis(outputNode('R', data), counter('m'));
    expect(more?.candidateId).toBe('m-2');
    const op = more?.ops[0] as { type: string; id: string; patch: MediaNodeData };
    expect(op.type).toBe('node.patchData');
    expect(op.id).toBe('R');
    const candidates = op.patch.generation?.candidates ?? [];
    expect(candidates.map((entry) => entry.id)).toEqual(['c1', 'c2', 'm-2']);
    const expectedName = generationOutputName({ generatorId: 'G', runId: 'm-1', index: 0, attempt: 0, surface: 'image' });
    expect(candidates[2]).toEqual({
      id: 'm-2',
      runId: 'm-1',
      index: 0,
      attempt: 0,
      status: 'pending',
      outputStem: outputStemOf(expectedName),
    });
    expect(more?.request.output).toBe(expectedName);

    const full = mediaData(Array.from({ length: GENERATION_LIMITS.maxCandidatesPerNode }, (_, i) => candidate(`c${i}`, i)));
    expect(planMoreLikeThis(outputNode('R', full), counter())).toBeNull();
    expect(planMoreLikeThis(outputNode('R', { file: file('x.png') }), counter())).toBeNull();
  });

  it('classifies active slots', () => {
    expect(['pending', 'queued', 'running'].every((status) => isActiveSlot(status as GenerationCandidate['status']))).toBe(true);
    expect(
      ['done', 'failed', 'interrupted', 'stopped', 'lost'].some((status) => isActiveSlot(status as GenerationCandidate['status'])),
    ).toBe(false);
  });
});

describe('generatorRunState', () => {
  const run: GeneratorRunSummary = { runId: 'run-1', outputNodeId: 'R', surface: 'image', model: 'm', count: 3, startedAt: 42 };

  it('is idle without runs', () => {
    expect(generatorRunState({ nodes: [generatorNode('G')], edges: [] }, 'G')).toEqual({
      active: false,
      outputMissing: false,
      total: 0,
      counts: { pending: 0, queued: 0, running: 0, done: 0, failed: 0, interrupted: 0, stopped: 0, lost: 0 },
    });
  });

  it('counts the latest run on its output node and reports the first error', () => {
    const error = { message: 'boom', nextStep: 'retry-later' as const };
    const data = mediaData([
      candidate('c3', 2, { status: 'failed', error }),
      candidate('c1', 0, { status: 'running' }),
      candidate('c2', 1, { status: 'done', file: file('two.png') }),
      { ...candidate('m1', 0), runId: 'more-run' },
    ]);
    const state = generatorRunState({ nodes: [generatorNode('G', { runs: [run] }), outputNode('R', data)], edges: [] }, 'G');
    expect(state).toMatchObject({
      active: true,
      runId: 'run-1',
      outputNodeId: 'R',
      outputMissing: false,
      total: 3,
      startedAt: 42,
      firstError: error,
    });
    expect(state.counts).toMatchObject({ running: 1, done: 1, failed: 1, pending: 0 });

    const finished = generatorRunState(
      {
        nodes: [
          generatorNode('G', { runs: [run] }),
          outputNode('R', mediaData([candidate('c1', 0, { status: 'done', file: file('one.png') })])),
        ],
        edges: [],
      },
      'G',
    );
    expect(finished.active).toBe(false);
    expect(finished.firstError).toBeUndefined();
  });

  it('flags a missing output node', () => {
    expect(generatorRunState({ nodes: [generatorNode('G', { runs: [run] })], edges: [] }, 'G')).toMatchObject({
      active: false,
      outputMissing: true,
      total: 0,
      runId: 'run-1',
    });
  });
});

describe('prompt template arguments', () => {
  const prompt =
    'A {argument name="subject" default="red fox"} in {argument  name="place" default="a forest" } — ' +
    'the {argument name="subject" default="ignored"} looks up';

  it('parses arguments in order, deduped by name, first default wins', () => {
    expect(parseTemplateArguments(prompt)).toEqual([
      { name: 'subject', defaultValue: 'red fox' },
      { name: 'place', defaultValue: 'a forest' },
    ]);
    expect(parseTemplateArguments('{argument name="" default="x"} plain')).toEqual([]);
  });

  it('fills values, falling back to the first default of each name', () => {
    expect(fillTemplateArguments(prompt, { place: 'the city' })).toBe('A red fox in the city — the red fox looks up');
    expect(fillTemplateArguments(prompt, { subject: 'cat $& dog' })).toBe('A cat $& dog in a forest — the cat $& dog looks up');
    expect(fillTemplateArguments('{argument name="constructor" default="safe"}', {})).toBe('safe');
    expect(fillTemplateArguments(prompt, { subject: '' })).toBe('A  in a forest — the  looks up');
  });
});
