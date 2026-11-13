import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { agentCapabilities } from '../../src/runtimes/capabilities.js';
import {
  cursorAgentDef,
  parseCursorAgentModels,
  parseCursorAgentModelVariant,
} from '../../src/runtimes/defs/cursor-agent.js';
import { CURSOR_AGENT_MODELS_SNAPSHOT_LINES } from '../../src/runtimes/defs/cursor-agent-models-snapshot.js';
import {
  isKnownModel,
  isKnownReasoningEffort,
  isKnownServiceTier,
  rememberLiveModels,
  resetLiveModelsForTests,
} from '../../src/runtimes/models.js';
import type { RuntimeModelOption } from '../../src/runtimes/types.js';

// Verbatim `cursor-agent models` stdout from cursor-agent 2026.11.05 (270 ids).
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../fixtures/cursor-agent-models-20261109.txt'),
  'utf8',
);

function byId(models: RuntimeModelOption[], id: string): RuntimeModelOption {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`missing ${id}`);
  return model;
}

const efforts = (model: RuntimeModelOption) => model.reasoningOptions?.map((option) => option.id);
const defaultEffort = (model: RuntimeModelOption) =>
  model.reasoningOptions?.filter((option) => option.default).map((option) => option.id);
const fastIds = (model: RuntimeModelOption) =>
  model.variants?.filter((variant) => variant.serviceTier === 'fast').map((variant) => variant.id) ?? [];

function modelArg(args: string[]): string | undefined {
  const index = args.indexOf('--model');
  return index === -1 ? undefined : args[index + 1];
}

afterEach(() => {
  resetLiveModelsForTests();
  agentCapabilities.delete('cursor-agent');
});

describe('parseCursorAgentModelVariant', () => {
  it('reads effort, extra-high, fast and the thinking-suffix shape', () => {
    expect(parseCursorAgentModelVariant('claude-opus-5-5-high-fast')).toEqual({
      family: 'claude-opus-5-5',
      reasoning: 'high',
      fast: true,
    });
    expect(parseCursorAgentModelVariant('gpt-5.5-extra-high')).toEqual({ family: 'gpt-5.5', reasoning: 'xhigh' });
    expect(parseCursorAgentModelVariant('claude-4.6-opus-max-thinking')).toEqual({
      family: 'claude-4.6-opus-thinking',
      reasoning: 'max',
    });
    expect(parseCursorAgentModelVariant('gpt-5.2-fast')).toEqual({ family: 'gpt-5.2', fast: true });
    expect(parseCursorAgentModelVariant('claude-4.5-sonnet-thinking')).toEqual({ family: 'claude-4.5-sonnet-thinking' });
    expect(parseCursorAgentModelVariant('auto')).toBeNull();
    expect(parseCursorAgentModelVariant('max')).toEqual({ family: 'max' });
  });
});

describe('cursor-agent models fold (fixture 2026-11-09)', () => {
  const models = cursorAgentDef.listModels.parse(FIXTURE)!;

  it('folds 270 ids into one option per model and ignores the Tip line', () => {
    expect(models.length).toBe(56);
    expect(models.slice(0, 4).map((model) => model.id)).toEqual(['default', 'auto', 'gpt-5.3-codex', 'gpt-5.2']);
    expect(models.some((model) => /^tip/i.test(model.id))).toBe(false);
    const concreteIds = models.flatMap((model) => model.variants?.map((variant) => variant.id) ?? [model.id]);
    expect(concreteIds.filter((id) => id !== 'default')).toHaveLength(270);
    expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
  });

  it('builds the Claude Opus 5.5 family with every effort and fast pairing', () => {
    const opus = byId(models, 'claude-opus-5-5');
    expect(opus.label).toBe('Claude Opus 5.5 1M');
    expect(efforts(opus)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(defaultEffort(opus)).toEqual(['medium']);
    expect(opus.serviceTierOptions).toEqual([{ id: 'fast', label: 'Fast' }]);
    expect(fastIds(opus)).toHaveLength(5);
  });

  it('reads suffix-less Codex and GPT-5.2 ids as medium', () => {
    const codex = byId(models, 'gpt-5.3-codex');
    expect(codex.label).toBe('Codex 5.3');
    expect(efforts(codex)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(defaultEffort(codex)).toEqual(['medium']);
    expect(codex.variants?.find((variant) => variant.id === 'gpt-5.3-codex')?.reasoning).toBe('medium');
    expect(codex.variants?.find((variant) => variant.id === 'gpt-5.3-codex-fast')).toMatchObject({
      reasoning: 'medium',
      serviceTier: 'fast',
    });
    expect(fastIds(codex)).toHaveLength(4);
    expect(efforts(byId(models, 'gpt-5.1'))).toEqual(['low', 'medium', 'high']);
  });

  it('uses the effort Cursor labels without an effort word as the default', () => {
    expect(defaultEffort(byId(models, 'claude-opus-4-7'))).toEqual(['xhigh']);
    expect(byId(models, 'claude-opus-4-7').label).toBe('Claude Opus 4.7 1M');
    expect(defaultEffort(byId(models, 'kimi-k3'))).toEqual(['max']);
    expect(defaultEffort(byId(models, 'cursor-grok-4.5'))).toEqual(['high']);
    expect(defaultEffort(byId(models, 'gemini-4-argon'))).toEqual(['medium']);
  });

  it('cleans labels and keeps Cursor-specific suffixes', () => {
    expect(byId(models, 'grok-4.7').label).toBe('Grok 4.7');
    expect(byId(models, 'grok-4.7').variants?.find((variant) => variant.id === 'grok-4.7-low-fast')?.label).toBe(
      'Grok 4.7 Low Fast',
    );
    expect(byId(models, 'claude-fable-5-1').label).toBe('Claude Fable 5.1 1M (NO ZDR)');
    expect(byId(models, 'claude-haiku-5-5').label).toBe('Claude Haiku 5.5 No Thinking');
    expect(byId(models, 'claude-4.6-opus-thinking').label).toBe('Claude Opus 4.6 1M Thinking');
    expect(efforts(byId(models, 'claude-4.6-opus-thinking'))).toEqual(['high', 'max']);
    expect(efforts(byId(models, 'gpt-5.5'))).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
  });

  it('folds a fast-only family without inventing efforts', () => {
    const composer = byId(models, 'composer-2.5');
    expect(composer.label).toBe('Composer 2.5');
    expect(composer.reasoningOptions).toBeUndefined();
    expect(composer.variants?.map((variant) => variant.id)).toEqual(['composer-2.5', 'composer-2.5-fast']);
  });

  it('leaves single ids untouched', () => {
    expect(byId(models, 'auto')).toEqual({ id: 'auto', label: 'Auto (default)' });
    expect(byId(models, 'gemini-3.1-pro')).toEqual({ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' });
    expect(byId(models, 'claude-4.5-opus-high')).toEqual({ id: 'claude-4.5-opus-high', label: 'Claude Opus 4.5' });
    expect(byId(models, 'claude-4.6-sonnet-medium')).toEqual({
      id: 'claude-4.6-sonnet-medium',
      label: 'Claude Sonnet 4.6 1M',
    });
  });

  it('still treats "No models available" as no list', () => {
    expect(cursorAgentDef.listModels.parse('No models available for this account.\n')).toBeNull();
  });
});

describe('cursor-agent fallback and spawn', () => {
  it('ships a folded fallback taken from the real list', () => {
    expect(cursorAgentDef.fallbackModels.map((model) => model.id)).toEqual([
      'default',
      'auto',
      'composer-2.5',
      'gpt-5.6-sol',
      'grok-4.7',
      'claude-opus-5-5',
      'gpt-5.5',
      'claude-fable-5-1',
      'gemini-3.8-flash',
      'claude-sonnet-5-5',
    ]);
    expect(efforts(byId(cursorAgentDef.fallbackModels, 'gpt-5.6-sol'))).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(fastIds(byId(cursorAgentDef.fallbackModels, 'grok-4.7'))).toHaveLength(4);
  });

  it('waits long enough for a slow `cursor-agent models` under detection load', () => {
    expect(cursorAgentDef.listModels.timeoutMs).toBeGreaterThanOrEqual(20_000);
  });

  it('passes the concrete id for a family, effort and fast choice', () => {
    const build = (options: Record<string, string | null>) =>
      modelArg(cursorAgentDef.buildArgs('', [], [], options, {}));
    expect(build({ model: 'claude-opus-5-5' })).toBe('claude-opus-5-5-medium');
    expect(build({ model: 'claude-opus-5-5', reasoning: 'max', serviceTier: 'fast' })).toBe('claude-opus-5-5-max-fast');
    expect(build({ model: 'gpt-5.5', reasoning: 'xhigh' })).toBe('gpt-5.5-extra-high');
    expect(build({ model: 'composer-2.5', serviceTier: 'fast' })).toBe('composer-2.5-fast');
    expect(build({ model: 'claude-opus-5-5-high' })).toBe('claude-opus-5-5-high');
    expect(build({ model: 'some-custom-id' })).toBe('some-custom-id');
    expect(build({ model: 'default' })).toBeUndefined();
  });

  it('keeps its built-in snapshot identical to the captured CLI output', () => {
    const fixtureLines = FIXTURE.split('\n').filter((line) => / - /.test(line) && !line.startsWith('Tip:'));
    expect(CURSOR_AGENT_MODELS_SNAPSHOT_LINES).toEqual(fixtureLines);
    expect(cursorAgentDef.modelCatalog).toEqual(parseCursorAgentModels(FIXTURE));
  });

  it('validates and resolves a saved family before any live listing', () => {
    // No rememberLiveModels: the daemon just started, or the first probe failed.
    const def = cursorAgentDef;
    expect(isKnownModel(def, 'claude-opus-4-7')).toBe(true);
    expect(isKnownReasoningEffort(def, 'claude-opus-4-7', 'xhigh')).toBe(true);
    expect(isKnownServiceTier(def, 'gpt-5.3-codex', 'fast')).toBe(true);
    expect(isKnownModel(def, 'gpt-5.4-low')).toBe(true);
    const build = (options: Record<string, string>) => modelArg(def.buildArgs('', [], [], options, {}));
    expect(build({ model: 'claude-opus-4-7', reasoning: 'xhigh' })).toBe('claude-opus-4-7-xhigh');
    expect(build({ model: 'gpt-5.3-codex', reasoning: 'low', serviceTier: 'fast' })).toBe('gpt-5.3-codex-low-fast');
    expect(build({ model: 'claude-4.6-opus-thinking', reasoning: 'max' })).toBe('claude-4.6-opus-max-thinking');
    // The picker fallback stays small; the catalog is resolution-only.
    expect(def.fallbackModels.some((model) => model.id === 'claude-opus-4-7')).toBe(false);
  });

  it('resolves against the live list when one was remembered', () => {
    rememberLiveModels('cursor-agent', parseCursorAgentModels(FIXTURE)!);
    const args = cursorAgentDef.buildArgs('', [], [], { model: 'gpt-5.3-codex', reasoning: 'low', serviceTier: 'fast' }, {});
    expect(modelArg(args)).toBe('gpt-5.3-codex-low-fast');
    const fallbackToStandard = cursorAgentDef.buildArgs('', [], [], { model: 'gpt-5.4', reasoning: 'low', serviceTier: 'fast' }, {});
    expect(modelArg(fallbackToStandard)).toBe('gpt-5.4-low');
  });
});
