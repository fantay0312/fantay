// Spec 05 §4.3: renderer filter, readiness groups, the needs-setup section, the live AIHubMix merge, variant
// collapse, cloud models never auto-picked, and the default order (stored → project → last used → default).
import { describe, expect, it } from 'vitest';

import { IMAGE_MODELS, VIDEO_MODELS, MEDIA_PROVIDERS, type MediaModel } from '../../../src/media/models';
import {
  buildGenerationCatalog,
  findOption,
  modelAvailability,
  pickDefaultModel,
  type GenerationModelGroup,
} from '../../../src/fantay/generation/model-catalog';
import type { MediaProviderCredentials } from '../../../src/types';

const OPENAI_ONLY: Record<string, MediaProviderCredentials> = { openai: { apiKey: 'sk-test' } as MediaProviderCredentials };
const ALL_CONFIGURED = Object.fromEntries(MEDIA_PROVIDERS.map(provider => [provider.id, {apiKey:'test-key',baseUrl:''}]));
const CLOUD_IDS = [...IMAGE_MODELS, ...VIDEO_MODELS].filter(model => model.provider === 'tokentosea').map(model => model.id);

function ids(groups: GenerationModelGroup[]): string[] {
  return groups.flatMap((group) => group.options.map((option) => option.id));
}

describe('buildGenerationCatalog', () => {
  it('lists only models whose provider has a board renderer for the surface', () => {
    const video = buildGenerationCatalog({ surface: 'video', staticModels: VIDEO_MODELS, aihubmixModels: [], mediaProviders: ALL_CONFIGURED });
    const listed = ids(video);
    expect(listed).toContain('doubao-seedance-2-0-260128'); // volcengine renders video
    expect(listed).not.toContain('minimax-video-01'); // integrated provider, no video renderer
    expect(listed).toContain('kling-2.0');
    expect(listed).toContain('kling-3.0');
    expect(listed).not.toContain('veo-3.1-generate-001'); // needs a Vertex publisher endpoint
    expect(listed).not.toContain('hyperframes-html'); // HTML compositions are not prompts
    const image = buildGenerationCatalog({ surface: 'image', staticModels: IMAGE_MODELS, aihubmixModels: [], mediaProviders: ALL_CONFIGURED });
    expect(ids(image)).not.toContain('doubao-seededit-3-0-i2i-250628'); // i2i-only and its renderer ignores references
    expect(ids(image)).toContain('gpt-image-2');
    expect(ids(image)).toContain('flux-2-pro');
    expect(ids(image)).not.toContain('comfyui-image'); // no workflow configured
  });

  it('groups configured providers and verified cloud models without setup-only providers', () => {
    const groups = buildGenerationCatalog({ surface: 'image', staticModels: IMAGE_MODELS, aihubmixModels: [], mediaProviders: OPENAI_ONLY, cloudModelIds:CLOUD_IDS });
    const readiness = groups.map((group) => group.readiness);
    const firstCloud = readiness.indexOf('cloud');
    const firstSetup = readiness.indexOf('needs-setup');
    expect(groups[0]).toMatchObject({ providerId: 'openai', label: 'OpenAI', readiness: 'ready' });
    expect(firstCloud).toBeGreaterThan(0);
    expect(firstSetup).toBe(-1);
    expect(groups.find((group) => group.providerId === 'tokentosea')?.readiness).toBe('cloud');
    expect(groups.find((group) => group.providerId === 'volcengine')).toBeUndefined();
    const option = groups[0]!.options.find((entry) => entry.id === 'gpt-image-2')!;
    expect(option).toMatchObject({ provider: 'openai', providerLabel: 'OpenAI', surface: 'image', readiness: 'ready' });
    expect(option.support.qualities).toEqual(['high', 'medium', 'low', 'auto']);
    expect(option.support.maxReferences).toBe(0);
  });

  it('does not infer availability from an unknown provider configuration', () => {
    const groups = buildGenerationCatalog({ surface: 'image', staticModels: IMAGE_MODELS, aihubmixModels: [], mediaProviders: undefined });
    expect(groups).toEqual([]);
  });

  it('replaces the static AIHubMix seeds with the live catalogue', () => {
    const live: MediaModel[] = [
      { id: 'aihubmix-flux-2-pro', label: 'flux-2-pro', hint: 'AIHubMix', provider: 'aihubmix', caps: ['t2i', 'i2i'] },
    ];
    const seeded = ids(buildGenerationCatalog({ surface: 'image', staticModels: IMAGE_MODELS, aihubmixModels: [], mediaProviders: ALL_CONFIGURED }));
    const merged = ids(buildGenerationCatalog({ surface: 'image', staticModels: IMAGE_MODELS, aihubmixModels: live, mediaProviders: ALL_CONFIGURED }));
    const seeds = IMAGE_MODELS.filter((model) => model.provider === 'aihubmix').map((model) => model.id);
    expect(seeds.length).toBeGreaterThan(0);
    for (const seed of seeds) expect(seeded).toContain(seed);
    expect(merged).toContain('aihubmix-flux-2-pro');
    for (const seed of seeds) expect(merged).not.toContain(seed);
  });

  it('collapses a model variant group into one option with resolution params', () => {
    const groups = buildGenerationCatalog({ surface: 'video', staticModels: VIDEO_MODELS, aihubmixModels: [], mediaProviders: ALL_CONFIGURED });
    const openrouter = groups.find((group) => group.providerId === 'openrouter')!;
    const seedance = openrouter.options.filter((option) => option.id.includes('seedance-2.0'));
    expect(seedance).toHaveLength(1);
    expect(seedance[0]).toMatchObject({ id: 'openrouter/bytedance/seedance-2.0', label: 'seedance-2.0 (OR)', isDefault: true });
    expect(seedance[0]!.hint).not.toMatch(/1080p$/);
    expect(seedance[0]!.support.resolutions).toEqual(['480p', '720p', '1080p']);
    expect(seedance[0]!.support.defaultResolution).toBe('720p');
    expect(findOption(groups, 'openrouter/bytedance/seedance-2.0:1080p')?.id).toBe('openrouter/bytedance/seedance-2.0');
  });

  it('shows TokenToSea video models only when the cloud availability lists them', () => {
    const vela = VIDEO_MODELS.filter((model) => model.provider === 'tokentosea').map((model) => model.id);
    expect(vela.length).toBeGreaterThan(0);
    const unknown = ids(buildGenerationCatalog({ surface: 'video', staticModels: VIDEO_MODELS, aihubmixModels: [], cloudVideoIds: null }));
    for (const id of vela) expect(unknown).not.toContain(id);
    const none = ids(buildGenerationCatalog({ surface: 'video', staticModels: VIDEO_MODELS, aihubmixModels: [], cloudVideoIds: [] }));
    for (const id of vela) expect(none).not.toContain(id);
    const listed = ids(buildGenerationCatalog({ surface: 'video', staticModels: VIDEO_MODELS, aihubmixModels: [], cloudVideoIds: [vela[0]!] }));
    expect(listed).toContain(vela[0]);
  });
});

describe('modelAvailability', () => {
  const groups = buildGenerationCatalog({ surface: 'image', staticModels: IMAGE_MODELS, aihubmixModels: [], mediaProviders: OPENAI_ONLY, cloudModelIds:CLOUD_IDS });
  it('blocks references on models that ignore them and setup-less providers', () => {
    const gpt = findOption(groups, 'gpt-image-2')!;
    expect(modelAvailability(gpt, 0)).toEqual({ selectable: true });
    expect(modelAvailability(gpt, 1)).toEqual({ selectable: false, reason: 'no-references' });
    const vela = findOption(groups, 'tokentosea/gpt-image-2')!;
    expect(modelAvailability(vela, 3)).toEqual({ selectable: true });
    expect(groups.find((group) => group.providerId === 'volcengine')).toBeUndefined();
  });

  it('requires a reference for image-to-X-only models', () => {
    const video = buildGenerationCatalog({ surface: 'video', staticModels: VIDEO_MODELS, aihubmixModels: [], mediaProviders: ALL_CONFIGURED });
    const i2v = findOption(video, 'doubao-seedance-1-0-lite-i2v-250428')!;
    expect(i2v.support.requiresReference).toBe(true);
    expect(modelAvailability(i2v, 0)).toEqual({ selectable: false, reason: 'needs-reference' });
    expect(modelAvailability(i2v, 1)).toEqual({ selectable: true });
  });
});

describe('pickDefaultModel', () => {
  const providers: Record<string, MediaProviderCredentials> = {
    openai: { apiKey: 'sk-test' } as MediaProviderCredentials,
    nanobanana: { apiKey: 'nb-test' } as MediaProviderCredentials,
  };
  const groups = buildGenerationCatalog({ surface: 'image', staticModels: IMAGE_MODELS, aihubmixModels: [], mediaProviders: providers, cloudModelIds:CLOUD_IDS });

  it('prefers the stored model when it is selectable', () => {
    expect(pickDefaultModel(groups, { stored: 'gpt-image-1', projectDefault: 'gpt-image-2', lastUsed: 'gpt-image-1.5', referenceCount: 0 })?.id).toBe('gpt-image-1');
    // A stored cloud model is an explicit choice, so it stays.
    expect(pickDefaultModel(groups, { stored: 'tokentosea/gpt-image-2', referenceCount: 0 })?.id).toBe('tokentosea/gpt-image-2');
  });

  it('falls back to the project default, then the last used model, when ready', () => {
    expect(pickDefaultModel(groups, { stored: null, projectDefault: 'gpt-image-2', lastUsed: 'gpt-image-1.5', referenceCount: 0 })?.id).toBe('gpt-image-2');
    expect(pickDefaultModel(groups, { stored: null, projectDefault: 'tokentosea/gpt-image-2', lastUsed: 'gpt-image-1.5', referenceCount: 0 })?.id).toBe('gpt-image-1.5');
    // A stored model that cannot take the connected references falls through.
    expect(pickDefaultModel(groups, { stored: 'gpt-image-1', lastUsed: 'gpt-image-1.5', referenceCount: 1 })?.provider).not.toBe('openai');
  });

  it('then takes the first ready catalog default or the first selectable ready option, never a cloud model', () => {
    const picked = pickDefaultModel(groups, { stored: null, referenceCount: 0 });
    expect(picked?.readiness).toBe('ready');
    expect(picked?.provider).not.toBe('tokentosea');
    const onlyCloud = buildGenerationCatalog({
      surface: 'image',
      staticModels: IMAGE_MODELS.filter((model) => model.provider === 'tokentosea'),
      aihubmixModels: [],
      mediaProviders: providers,
    });
    expect(pickDefaultModel(onlyCloud, { stored: null, referenceCount: 0 })).toBeNull();
  });

  it('marks the ready default and resolves canonical aliases of the project default', () => {
    const synthetic: MediaModel[] = [
      { id: 'gpt-image-1', label: 'one', hint: '', provider: 'openai', caps: ['t2i'] },
      { id: 'gpt-image-2', label: 'two', hint: '', provider: 'openai', caps: ['t2i'], default: true },
      { id: 'tokentosea/gpt-image-2', label: 'cloud', hint: '', provider: 'tokentosea', caps: ['t2i', 'i2i'], default: true },
    ];
    const syntheticGroups = buildGenerationCatalog({ surface: 'image', staticModels: synthetic, aihubmixModels: [], mediaProviders: providers });
    expect(pickDefaultModel(syntheticGroups, { referenceCount: 0 })?.id).toBe('gpt-image-2');
    // 'codex-gpt-image-2' is the legacy alias of the cloud model: never auto-picked.
    expect(pickDefaultModel(syntheticGroups, { projectDefault: 'codex-gpt-image-2', referenceCount: 0 })?.id).toBe('gpt-image-2');
  });
});
