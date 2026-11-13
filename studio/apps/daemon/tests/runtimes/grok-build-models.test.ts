import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  grokBuildAgentDef,
  parseGrokBuildModels,
  readGrokModelsCache,
} from '../../src/runtimes/defs/grok-build.js';
import {
  findKnownModel,
  isKnownReasoningEffort,
  isKnownServiceTier,
  rememberLiveModels,
  resetLiveModelsForTests,
} from '../../src/runtimes/models.js';

// `grok models` on grok 1.0.77.
const GROK_MODELS_STDOUT = [
  'You are logged in with grok.com.',
  '',
  'Default model: grok-4.7-build-fast',
  '',
  'Available models:',
  '  - grok-4.7',
  '  * grok-4.7-build-fast (default)',
  '  - grok-4.6',
  '  - grok-4.5',
].join('\n');

const efforts = (ids: string[], defaultId: string) =>
  ids.map((id) => ({ id, value: id, label: id, description: '', default: id === defaultId }));

// The shape of `~/.grok/models_cache.json` written by grok 1.0.77, trimmed.
const GROK_CACHE = {
  fetched_at: '2026-11-09T05:06:25.294768Z',
  grok_version: '1.0.77',
  models: {
    'grok-4.7': {
      info: {
        id: 'grok-4.7',
        name: 'Grok 4.7',
        reasoning_effort: 'high',
        supports_reasoning_effort: true,
        reasoning_efforts: efforts(['xhigh', 'high', 'medium', 'low'], 'high'),
      },
    },
    'grok-4.7-build-fast': {
      info: {
        id: 'grok-4.7-build-fast',
        name: 'Grok 4.7 Fast',
        description: 'Fast variant. 2x the price.',
        reasoning_effort: 'high',
        supports_reasoning_effort: true,
        reasoning_efforts: efforts(['xhigh', 'high', 'medium', 'low'], 'high'),
      },
    },
    'grok-4.6': {
      info: {
        id: 'grok-4.6',
        name: 'Grok 4.6',
        reasoning_effort: 'high',
        supports_reasoning_effort: true,
        reasoning_efforts: efforts(['xhigh', 'high', 'medium', 'low'], 'high'),
      },
    },
    'grok-4.5': {
      info: {
        id: 'grok-4.5',
        name: 'Grok 4.5',
        reasoning_effort: 'medium',
        supports_reasoning_effort: true,
        reasoning_efforts: efforts(['high', 'medium', 'low'], 'medium'),
      },
    },
  },
};

const promptFilePath = '/tmp/od-grok-prompt/prompt.md';
const build = (options: Record<string, string>) =>
  grokBuildAgentDef.buildArgs('', [], [], options, { promptFilePath }).slice(4);

let grokHome: string;
const originalGrokHome = process.env.GROK_HOME;

beforeEach(() => {
  grokHome = mkdtempSync(join(tmpdir(), 'od-grok-home-'));
  process.env.GROK_HOME = grokHome;
});

afterEach(() => {
  resetLiveModelsForTests();
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  rmSync(grokHome, { recursive: true, force: true });
});

describe('grok-build models', () => {
  it('folds the fast id into the base model and reads efforts from the CLI cache', () => {
    writeFileSync(join(grokHome, 'models_cache.json'), JSON.stringify(GROK_CACHE));
    const models = grokBuildAgentDef.listModels.parse(GROK_MODELS_STDOUT)!;
    expect(models.map((model) => [model.id, model.label])).toEqual([
      ['default', 'Default (CLI config)'],
      ['grok-4.7', 'Grok 4.7'],
      ['grok-4.6', 'Grok 4.6'],
      ['grok-4.5', 'Grok 4.5'],
    ]);
    const grok47 = models[1]!;
    // The fast tier says what it costs, in the fast id's own cache copy.
    expect(grok47.serviceTierOptions).toEqual([{ id: 'fast', label: 'Fast', description: 'Fast variant. 2x the price.' }]);
    expect(grok47.description).toBeUndefined();
    expect(grok47.variants).toEqual([
      { id: 'grok-4.7', label: 'Grok 4.7' },
      { id: 'grok-4.7-build-fast', label: 'Grok 4.7 Fast', serviceTier: 'fast' },
    ]);
    expect(grok47.reasoningOptions).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High', default: true },
      { id: 'xhigh', label: 'XHigh' },
    ]);
    expect(models[3]?.reasoningOptions?.map((option) => `${option.id}${option.default ? '*' : ''}`)).toEqual([
      'low',
      'medium*',
      'high',
    ]);
  });

  it('still folds fast without a cache, labelling by id', () => {
    const models = parseGrokBuildModels(GROK_MODELS_STDOUT, null);
    expect(models.map((model) => model.id)).toEqual(['default', 'grok-4.7', 'grok-4.6', 'grok-4.5']);
    expect(models[1]?.label).toBe('grok-4.7');
    expect(models[1]?.reasoningOptions).toBeUndefined();
    expect(models[1]?.serviceTierOptions).toEqual([{ id: 'fast', label: 'Fast' }]);
    expect(readGrokModelsCache()).toBeNull();
  });

  it('ignores a corrupt cache', () => {
    writeFileSync(join(grokHome, 'models_cache.json'), '{not json');
    expect(readGrokModelsCache()).toBeNull();
    expect(grokBuildAgentDef.listModels.parse(GROK_MODELS_STDOUT)?.[1]?.label).toBe('grok-4.7');
  });

  it('offers no effort above xhigh at the agent level', () => {
    expect(grokBuildAgentDef.reasoningOptions.map((option) => option.id)).toEqual(['low', 'medium', 'high', 'xhigh']);
  });
});

describe('grok-build spawn before any live listing', () => {
  it('keeps fast and effort for a saved family through the built-in catalog', () => {
    const def = grokBuildAgentDef;
    expect(isKnownServiceTier(def, 'grok-4.7', 'fast')).toBe(true);
    expect(isKnownReasoningEffort(def, 'grok-4.7', 'xhigh')).toBe(true);
    expect(build({ model: 'grok-4.7', serviceTier: 'fast', reasoning: 'xhigh' })).toEqual([
      '--model',
      'grok-4.7-build-fast',
      '--effort',
      'xhigh',
    ]);
    expect(build({ model: 'grok-4.5', reasoning: 'xhigh' })).toEqual(['--model', 'grok-4.5']);
    expect(def.fallbackModels.some((model) => model.id === 'grok-4.7')).toBe(false);
  });

  it('describes the built-in fast tier and keeps the copy through known-model lookups', () => {
    const catalogFamily = grokBuildAgentDef.modelCatalog.find((model) => model.id === 'grok-4.7');
    expect(catalogFamily?.serviceTierOptions).toEqual([
      { id: 'fast', label: 'Fast', description: 'Fast variant. 2x the price.' },
    ]);
    expect(findKnownModel(grokBuildAgentDef, 'grok-4.7')?.serviceTierOptions?.[0]?.description).toBe(
      'Fast variant. 2x the price.',
    );
    writeFileSync(join(grokHome, 'models_cache.json'), JSON.stringify(GROK_CACHE));
    rememberLiveModels('grok-build', grokBuildAgentDef.listModels.parse(GROK_MODELS_STDOUT)!);
    expect(findKnownModel(grokBuildAgentDef, 'grok-4.7')?.serviceTierOptions?.[0]?.description).toBe(
      'Fast variant. 2x the price.',
    );
  });
});

describe('grok-build spawn', () => {
  beforeEach(() => {
    writeFileSync(join(grokHome, 'models_cache.json'), JSON.stringify(GROK_CACHE));
    rememberLiveModels('grok-build', grokBuildAgentDef.listModels.parse(GROK_MODELS_STDOUT)!);
  });

  it('turns fast into the fast id and passes the effort the model lists', () => {
    expect(build({ model: 'grok-4.7', serviceTier: 'fast', reasoning: 'xhigh' })).toEqual([
      '--model',
      'grok-4.7-build-fast',
      '--effort',
      'xhigh',
    ]);
    expect(build({ model: 'grok-4.7', reasoning: 'low' })).toEqual(['--model', 'grok-4.7', '--effort', 'low']);
    expect(build({ model: 'grok-4.7' })).toEqual(['--model', 'grok-4.7']);
  });

  it('validates the same choices it spawns', () => {
    const def = grokBuildAgentDef;
    expect(isKnownServiceTier(def, 'grok-4.7', 'fast')).toBe(true);
    expect(isKnownServiceTier(def, 'grok-4.6', 'fast')).toBe(false);
    expect(isKnownReasoningEffort(def, 'grok-4.5', 'xhigh')).toBe(false);
    expect(isKnownReasoningEffort(def, 'grok-4.7-build-fast', 'high')).toBe(true);
    expect(isKnownReasoningEffort(def, 'default', 'max')).toBe(false);
  });

  it('skips efforts a model does not list, and keeps saved concrete ids working', () => {
    expect(build({ model: 'grok-4.5', reasoning: 'xhigh' })).toEqual(['--model', 'grok-4.5']);
    expect(build({ model: 'grok-4.7-build-fast', reasoning: 'medium' })).toEqual([
      '--model',
      'grok-4.7-build-fast',
      '--effort',
      'medium',
    ]);
    expect(build({ model: 'grok-build', reasoning: 'high' })).toEqual(['--model', 'grok-build']);
    expect(build({ model: 'grok-4.20-reasoning', reasoning: 'high' })).toEqual([
      '--model',
      'grok-4.20-reasoning',
      '--effort',
      'high',
    ]);
    expect(build({ model: 'default', reasoning: 'low' })).toEqual(['--effort', 'low']);
  });
});
