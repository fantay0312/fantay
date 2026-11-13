import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import {
  antigravityAgentDef,
  antigravityTakesModelFlag,
  parseAntigravityModels,
  resolveAntigravityConcreteModel,
} from '../../src/runtimes/defs/antigravity.js';
import { rememberLiveModels, resetLiveModelsForTests } from '../../src/runtimes/models.js';

afterEach(() => agentCapabilities.delete('antigravity'));

describe('antigravity models', () => {
  it('reads `agy models`, keeping the CLI default first', () => {
    const models = parseAntigravityModels(
      'gemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\n',
    );
    expect(models?.map((model) => model.id)).toEqual(['default', 'gemini-4-argon-high', 'claude-opus-5-5-low']);
    expect(models?.[1]?.label).toBe('Gemini 4 Argon (High)');
  });

  it('falls back to the built-in list when the output has no models', () => {
    expect(parseAntigravityModels('Fetching available models...\n')).toBeNull();
  });

  it('passes an id with --model on builds that have the flag, and leaves settings.json alone', () => {
    agentCapabilities.set('antigravity', { modelFlag: true });
    const args = antigravityAgentDef.buildArgs('', [], [], { model: 'gemini-3.8-flash-low' }, {
      antigravitySettingsPath: '/nonexistent/dir/settings.json',
    });
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gemini-3.8-flash-low']);
  });

  it('keeps a label saved by an older build on the settings.json route', () => {
    agentCapabilities.set('antigravity', { modelFlag: true });
    expect(antigravityTakesModelFlag('Gemini 3.1 Pro (High)')).toBe(false);
    expect(antigravityTakesModelFlag('gemini-4-argon-high')).toBe(true);
  });
});

// `agy models` 1.5.3 lists one id per effort; the picker shows one model and a
// thinking-effort control, and spawn turns the pair back into the listed id.
const AGY_MODELS_153 = [
  'Fetching available models...',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
].join('\n');

describe('antigravity effort folding', () => {
  afterEach(() => resetLiveModelsForTests());

  it('folds effort ids into one model with a thinking-effort ladder', () => {
    const models = parseAntigravityModels(AGY_MODELS_153)!;
    expect(models.map((model) => [model.id, model.label])).toEqual([
      ['default', 'Default (CLI config)'],
      ['gemini-4-argon', 'Gemini 4 Argon'],
      ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
      ['claude-opus-5-5', 'Claude Opus 5.5'],
      ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
      ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
    ]);
    expect(models[1]?.reasoningOptions).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium', default: true },
      { id: 'high', label: 'High' },
    ]);
    expect(models[1]?.serviceTierOptions).toBeUndefined();
    expect(models[1]?.variants?.map((variant) => variant.id)).toEqual([
      'gemini-4-argon-medium',
      'gemini-4-argon-high',
      'gemini-4-argon-low',
    ]);
  });

  it('ships the same folded shape as its offline fallback', () => {
    expect(antigravityAgentDef.fallbackModels.map((model) => model.id)).toEqual([
      'default',
      'gemini-4-argon',
      'gemini-3.8-flash',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gpt-oss-120b-medium',
    ]);
    expect(antigravityAgentDef.supportsCustomModel).toBe(false);
  });

  it('passes the concrete id on the --model route', () => {
    agentCapabilities.set('antigravity', { modelFlag: true });
    const modelArgs = (options: Record<string, string>) => {
      const args = antigravityAgentDef.buildArgs('', [], [], options, {
        antigravitySettingsPath: '/nonexistent/dir/settings.json',
      });
      return args.slice(args.indexOf('--model'), args.indexOf('--model') + 2);
    };
    expect(modelArgs({ model: 'gemini-4-argon', reasoning: 'high' })).toEqual(['--model', 'gemini-4-argon-high']);
    expect(modelArgs({ model: 'claude-opus-5-5' })).toEqual(['--model', 'claude-opus-5-5-medium']);
    // A pick saved before the fold is still a listed id and passes unchanged.
    expect(modelArgs({ model: 'claude-opus-5-5-low' })).toEqual(['--model', 'claude-opus-5-5-low']);
  });

  it('resolves against the live list, and writes the concrete id on the settings.json route', () => {
    rememberLiveModels('antigravity', parseAntigravityModels(AGY_MODELS_153)!);
    expect(resolveAntigravityConcreteModel({ model: 'gemini-3.8-flash', reasoning: 'low' })).toBe('gemini-3.8-flash-low');
    expect(resolveAntigravityConcreteModel({ model: 'default', reasoning: 'low' })).toBeNull();
    expect(resolveAntigravityConcreteModel({})).toBeNull();

    // Builds without `--model` read the choice from settings.json.
    const settingsDir = mkdtempSync(join(tmpdir(), 'od-agy-fold-'));
    try {
      const settingsPath = join(settingsDir, 'settings.json');
      const args = antigravityAgentDef.buildArgs('', [], [], { model: 'claude-sonnet-5-5', reasoning: 'high' }, {
        antigravitySettingsPath: settingsPath,
      });
      expect(args.includes('--model')).toBe(false);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'claude-sonnet-5-5-high' });
    } finally {
      rmSync(settingsDir, { recursive: true, force: true });
    }
  });
});
