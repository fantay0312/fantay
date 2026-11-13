import { describe, expect, it } from 'vitest';
import {
  agentModelIsSelectable,
  dropUnavailableServiceTier,
  effectiveAgentModelChoice,
  modelServiceTierAvailability,
  modelServiceTierEfforts,
  normalizeAgentModelChoice,
  normalizeAgentModelVariantChoice,
} from '../../src/components/agentModelSelection';
import type { AgentInfo } from '../../src/types';

type ModelOption = NonNullable<AgentInfo['models']>[number];

// Cursor Agent style: the bare id runs the default effort, and only some
// efforts ship a `-fast` id.
const codexFamily: ModelOption = {
  id: 'gpt-5.3-codex',
  label: 'GPT-5.3 Codex',
  reasoningOptions: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium', default: true },
    { id: 'high', label: 'High' },
  ],
  serviceTierOptions: [{ id: 'fast', label: 'Fast' }],
  variants: [
    { id: 'gpt-5.3-codex-low', reasoning: 'low' },
    { id: 'gpt-5.3-codex' },
    { id: 'gpt-5.3-codex-high', reasoning: 'high' },
    { id: 'gpt-5.3-codex-fast', serviceTier: 'fast' },
    { id: 'gpt-5.3-codex-high-fast', reasoning: 'high', serviceTier: 'fast' },
  ],
};

// Grok Build style, as the daemon's foldGrokBuildModels emits it: the ids differ
// only by speed tier, while effort stays a `--effort` flag whose ladder the
// family keeps from the models cache.
const grokFamily: ModelOption = {
  id: 'grok-4.7',
  label: 'Grok 4.7',
  reasoningOptions: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium', default: true },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'XHigh' },
  ],
  serviceTierOptions: [{ id: 'fast', label: 'Fast' }],
  variants: [
    { id: 'grok-4.7', label: 'Grok 4.7' },
    { id: 'grok-4.7-build-fast', label: 'Grok 4.7 Build Fast', serviceTier: 'fast' },
  ],
};

// A speed-only family with no effort ladder at all.
const speedOnlyFamily: ModelOption = {
  id: 'grok-build',
  label: 'Grok Build',
  serviceTierOptions: [{ id: 'fast', label: 'Fast' }],
  variants: [{ id: 'grok-build' }, { id: 'grok-build-fast', serviceTier: 'fast' }],
};

const cursorAgent: AgentInfo = {
  id: 'cursor-agent',
  name: 'Cursor Agent',
  bin: 'cursor-agent',
  available: true,
  models: [{ id: 'default', label: 'Default' }, codexFamily, grokFamily, speedOnlyFamily],
};

const codexCli: AgentInfo = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  available: true,
  models: [
    {
      id: 'gpt-5.5',
      label: 'GPT-5.5',
      reasoningOptions: [{ id: 'medium', label: 'Medium', default: true }, { id: 'high', label: 'High' }],
      serviceTierOptions: [{ id: 'priority', label: 'Fast' }],
    },
  ],
};

describe('folded model variants', () => {
  it('reads a saved concrete id as its family, effort and tier', () => {
    expect(
      normalizeAgentModelVariantChoice(cursorAgent, { model: 'gpt-5.3-codex-high-fast' }),
    ).toEqual({ model: 'gpt-5.3-codex', reasoning: 'high', serviceTier: 'fast' });
    expect(
      normalizeAgentModelVariantChoice(cursorAgent, {
        model: 'gpt-5.3-codex-low',
        reasoning: 'max',
        serviceTier: 'fast',
      }),
    ).toEqual({ model: 'gpt-5.3-codex', reasoning: 'low' });
  });

  it('keeps the saved effort when the ids do not encode effort', () => {
    // Grok passed `--effort high` before the fold and still does after it.
    expect(
      normalizeAgentModelVariantChoice(cursorAgent, { model: 'grok-4.7-build-fast', reasoning: 'high' }),
    ).toEqual({ model: 'grok-4.7', reasoning: 'high', serviceTier: 'fast' });
    expect(
      normalizeAgentModelVariantChoice(cursorAgent, { model: 'grok-4.7-build-fast' }),
    ).toEqual({ model: 'grok-4.7', serviceTier: 'fast' });
    expect(
      normalizeAgentModelVariantChoice(cursorAgent, { model: 'grok-build-fast', reasoning: 'high' }),
    ).toEqual({ model: 'grok-build', reasoning: 'high', serviceTier: 'fast' });
  });

  it('leaves option ids, unknown ids and the default sentinel alone', () => {
    expect(normalizeAgentModelVariantChoice(cursorAgent, { model: 'gpt-5.3-codex' })).toBeNull();
    expect(normalizeAgentModelVariantChoice(cursorAgent, { model: 'my-custom-model' })).toBeNull();
    expect(normalizeAgentModelVariantChoice(cursorAgent, { model: 'default' })).toBeNull();
    expect(normalizeAgentModelVariantChoice(cursorAgent, undefined)).toBeNull();
  });

  it('feeds the effective choice every surface reads, keeping TokenToSea first', () => {
    expect(effectiveAgentModelChoice(cursorAgent, { model: 'grok-4.7' })).toEqual({
      model: 'grok-4.7',
    });
    expect(effectiveAgentModelChoice(cursorAgent, { model: 'gpt-5.3-codex-fast' })).toEqual({
      model: 'gpt-5.3-codex',
      serviceTier: 'fast',
    });
    const amr: AgentInfo = {
      id: 'tokentosea',
      name: 'AMR',
      bin: 'tokentosea',
      available: true,
      models: [{ id: 'glm-5', label: 'GLM 5' }],
    };
    expect(effectiveAgentModelChoice(amr, { model: 'retired', reasoning: 'low' })).toEqual({
      model: 'glm-5',
      reasoning: 'low',
    });
  });

  it('does not widen what the strictness invariant gates', () => {
    // Variant normalization only maps ids that are not options, so a row the
    // pickers offer is never coerced away by it.
    for (const model of cursorAgent.models ?? []) {
      expect(agentModelIsSelectable(cursorAgent, model.id)).toBe(true);
      expect(normalizeAgentModelChoice(cursorAgent, { model: model.id })).toBeNull();
      expect(normalizeAgentModelVariantChoice(cursorAgent, { model: model.id })).toBeNull();
    }
  });

  it('offers a folded tier only at efforts that have a concrete id for it', () => {
    expect(modelServiceTierAvailability(codexFamily, 'high', 'fast')).toBe(true);
    expect(modelServiceTierAvailability(codexFamily, 'low', 'fast')).toBe(false);
    // Nothing chosen, or a stale effort, runs the default-flagged effort,
    // which the bare `-fast` id stands for.
    expect(modelServiceTierAvailability(codexFamily, undefined, 'fast')).toBe(true);
    expect(modelServiceTierAvailability(codexFamily, 'max', 'fast')).toBe(true);
    expect(modelServiceTierAvailability(codexFamily, 'low', null)).toBe(true);
    expect(modelServiceTierEfforts(codexFamily, 'fast')).toEqual(['medium', 'high']);
    expect(modelServiceTierAvailability(speedOnlyFamily, 'anything', 'fast')).toBe(true);
  });

  it('offers a speed-only id at every effort when effort is a flag', () => {
    // The daemon runs grok-4.7-build-fast with `--effort <any>`.
    for (const effort of ['low', 'medium', 'high', 'xhigh', undefined]) {
      expect(modelServiceTierAvailability(grokFamily, effort, 'fast')).toBe(true);
      expect(modelServiceTierAvailability(grokFamily, effort, null)).toBe(true);
    }
    expect(modelServiceTierEfforts(grokFamily, 'fast')).toEqual(['low', 'medium', 'high', 'xhigh']);
    const highFast = { model: 'grok-4.7', reasoning: 'high', serviceTier: 'fast' };
    expect(dropUnavailableServiceTier(grokFamily, highFast)).toBe(highFast);
  });

  it('treats flag-style tiers as available at every effort', () => {
    const model = codexCli.models![0]!;
    expect(modelServiceTierAvailability(model, 'high', 'priority')).toBe(true);
    expect(modelServiceTierAvailability(model, undefined, 'priority')).toBe(true);
    expect(modelServiceTierAvailability(undefined, 'high', 'priority')).toBe(false);
  });

  it('drops a tier the choice cannot run instead of saving the pair', () => {
    expect(
      dropUnavailableServiceTier(codexFamily, { model: 'gpt-5.3-codex', reasoning: 'low', serviceTier: 'fast' }),
    ).toEqual({ model: 'gpt-5.3-codex', reasoning: 'low' });
    const runnable = { model: 'gpt-5.3-codex', reasoning: 'high', serviceTier: 'fast' };
    expect(dropUnavailableServiceTier(codexFamily, runnable)).toBe(runnable);
    const unknownModel = { model: 'custom', serviceTier: 'fast' };
    expect(dropUnavailableServiceTier(undefined, unknownModel)).toBe(unknownModel);
  });
});
