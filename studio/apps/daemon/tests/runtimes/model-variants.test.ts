import { afterEach, describe, expect, it } from 'vitest';

import {
  foldModelVariants,
  normalizeModelLabel,
  resolveModelVariant,
  resolveVariantModelId,
  type ModelVariantParser,
} from '../../src/runtimes/model-variants.js';
import {
  DEFAULT_MODEL_OPTION,
  findKnownModel,
  getRememberedLiveModels,
  isKnownModel,
  isKnownReasoningEffort,
  isKnownServiceTier,
  rememberLiveModels,
  resetLiveModelsForTests,
} from '../../src/runtimes/models.js';
import type { RuntimeModelOption } from '../../src/runtimes/types.js';

// `<family>[-<effort>][-fast]`, the shape Cursor and agy use.
const suffixParser: ModelVariantParser = (id) => {
  const tokens = id.split('-');
  let fast = false;
  if (tokens.at(-1) === 'fast') {
    tokens.pop();
    fast = true;
  }
  const last = tokens.at(-1) ?? '';
  const reasoning = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(last)
    ? (tokens.pop(), last)
    : undefined;
  if (tokens.length === 0) return null;
  return { family: tokens.join('-'), ...(reasoning ? { reasoning } : {}), ...(fast ? { fast } : {}) };
};

const opt = (id: string, label = id): RuntimeModelOption => ({ id, label });

afterEach(() => resetLiveModelsForTests());

describe('normalizeModelLabel', () => {
  it('strips zero-width characters and collapses whitespace', () => {
    expect(normalizeModelLabel('Grok 4.7  Low Fast​​')).toBe('Grok 4.7 Low Fast');
    expect(normalizeModelLabel('﻿ A⁠B  ‍C ')).toBe('AB C');
  });
});

describe('foldModelVariants', () => {
  it('folds effort and fast ids into one family at the first id position', () => {
    const folded = foldModelVariants(
      [
        DEFAULT_MODEL_OPTION,
        opt('solo', 'Solo'),
        opt('opus-low', 'Opus 1M Low'),
        opt('opus-low-fast', 'Opus 1M Low Fast'),
        opt('other', 'Other'),
        opt('opus-medium', 'Opus 1M'),
        opt('opus-high', 'Opus 1M High'),
        opt('opus-max-fast', 'Opus 1M Max Fast'),
      ],
      suffixParser,
    );
    expect(folded.map((model) => model.id)).toEqual(['default', 'solo', 'opus', 'other']);
    expect(folded[0]).toBe(DEFAULT_MODEL_OPTION);
    const opus = folded[2]!;
    expect(opus.label).toBe('Opus 1M');
    expect(opus.reasoningOptions).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium', default: true },
      { id: 'high', label: 'High' },
      { id: 'max', label: 'Max' },
    ]);
    expect(opus.serviceTierOptions).toEqual([{ id: 'fast', label: 'Fast' }]);
    expect(opus.variants).toEqual([
      { id: 'opus-low', label: 'Opus 1M Low', reasoning: 'low' },
      { id: 'opus-low-fast', label: 'Opus 1M Low Fast', reasoning: 'low', serviceTier: 'fast' },
      { id: 'opus-medium', label: 'Opus 1M', reasoning: 'medium' },
      { id: 'opus-high', label: 'Opus 1M High', reasoning: 'high' },
      { id: 'opus-max-fast', label: 'Opus 1M Max Fast', reasoning: 'max', serviceTier: 'fast' },
    ]);
  });

  it('leaves a family with a single id untouched', () => {
    const lone = { id: 'lone-high', label: 'Lone High', metadata: { cost: 'high' as const } };
    const folded = foldModelVariants([DEFAULT_MODEL_OPTION, lone], suffixParser);
    expect(folded).toEqual([DEFAULT_MODEL_OPTION, lone]);
    expect(folded[1]).toBe(lone);
  });

  it('takes the default effort from the id whose label carries no effort word', () => {
    const [family] = foldModelVariants(
      [opt('opus-high', 'Opus 4.7 1M High'), opt('opus-xhigh', 'Opus 4.7 1M'), opt('opus-low', 'Opus 4.7 1M Low')],
      suffixParser,
    );
    expect(family?.label).toBe('Opus 4.7 1M');
    expect(family?.reasoningOptions?.filter((option) => option.default)).toEqual([
      { id: 'xhigh', label: 'XHigh', default: true },
    ]);
  });

  it('defaults to medium, else the first effort, when every label names its effort', () => {
    const [withMedium] = foldModelVariants(
      [opt('argon-high', 'Argon (High)'), opt('argon-medium', 'Argon (Medium)'), opt('argon-low', 'Argon (Low)')],
      suffixParser,
    );
    expect(withMedium?.label).toBe('Argon');
    expect(withMedium?.reasoningOptions?.find((option) => option.default)?.id).toBe('medium');
    expect(withMedium?.reasoningOptions?.map((option) => option.id)).toEqual(['low', 'medium', 'high']);

    const [withoutMedium] = foldModelVariants(
      [opt('kimi-high', 'Kimi High'), opt('kimi-low', 'Kimi Low')],
      suffixParser,
    );
    expect(withoutMedium?.label).toBe('Kimi');
    expect(withoutMedium?.reasoningOptions?.find((option) => option.default)?.id).toBe('high');
  });

  it('strips Extra High from labels and falls back to a fast label', () => {
    const [xhigh] = foldModelVariants(
      [opt('gpt-xhigh', 'GPT 1M Extra High'), opt('gpt-low', 'GPT 1M Low')],
      suffixParser,
    );
    expect(xhigh?.label).toBe('GPT 1M');

    const [fastOnly] = foldModelVariants(
      [opt('mini-high-fast', 'Mini High Fast'), opt('mini-low-fast', 'Mini Low Fast')],
      suffixParser,
    );
    expect(fastOnly?.label).toBe('Mini');
  });

  it('reads a suffix-less id as medium unless the family also lists an explicit medium', () => {
    const [codex] = foldModelVariants(
      [opt('codex-low', 'Codex Low'), opt('codex', 'Codex'), opt('codex-fast', 'Codex Fast'), opt('codex-high', 'Codex High')],
      suffixParser,
    );
    expect(codex?.id).toBe('codex');
    expect(codex?.variants).toEqual([
      { id: 'codex-low', label: 'Codex Low', reasoning: 'low' },
      { id: 'codex', label: 'Codex', reasoning: 'medium' },
      { id: 'codex-fast', label: 'Codex Fast', reasoning: 'medium', serviceTier: 'fast' },
      { id: 'codex-high', label: 'Codex High', reasoning: 'high' },
    ]);
    expect(codex?.reasoningOptions?.find((option) => option.default)?.id).toBe('medium');

    const ambiguous = foldModelVariants(
      [opt('gem-pro', 'Gem Pro'), opt('gem-pro-medium', 'Gem Pro Medium'), opt('gem-pro-high', 'Gem Pro High')],
      suffixParser,
    );
    // The suffix-less id would collide with the family id, so nothing folds.
    expect(ambiguous.map((model) => model.id)).toEqual(['gem-pro', 'gem-pro-medium', 'gem-pro-high']);
    expect(ambiguous.some((model) => model.variants)).toBe(false);

    // An ambiguous id that does not collide stays beside the folded family.
    const separate = foldModelVariants(
      [opt('lyra-fast', 'Lyra Fast'), opt('lyra-medium', 'Lyra Medium'), opt('lyra-high', 'Lyra High')],
      suffixParser,
    );
    expect(separate.map((model) => model.id)).toEqual(['lyra-fast', 'lyra']);
    expect(separate[1]?.serviceTierOptions).toBeUndefined();
  });

  it('folds fast-only families without reasoning options and keeps base metadata', () => {
    const base = { id: 'composer', label: 'Composer', reasoningOptions: [{ id: 'high', label: 'High', default: true }] };
    const [family] = foldModelVariants([base, opt('composer-fast', 'Composer Fast')], suffixParser);
    expect(family).toEqual({
      id: 'composer',
      label: 'Composer',
      reasoningOptions: [{ id: 'high', label: 'High', default: true }],
      serviceTierOptions: [{ id: 'fast', label: 'Fast' }],
      variants: [{ id: 'composer', label: 'Composer' }, { id: 'composer-fast', label: 'Composer Fast', serviceTier: 'fast' }],
    });
  });

  it('treats an id that is another family key as that family base', () => {
    const folded = foldModelVariants(
      [opt('codex-max', 'Codex Max'), opt('codex-max-high', 'Codex Max High'), opt('codex-max-low', 'Codex Max Low')],
      suffixParser,
    );
    expect(folded.map((model) => model.id)).toEqual(['codex-max']);
    expect(folded[0]?.variants?.map((variant) => [variant.id, variant.reasoning])).toEqual([
      ['codex-max', 'medium'],
      ['codex-max-high', 'high'],
      ['codex-max-low', 'low'],
    ]);
  });

  it('is idempotent over an already folded list', () => {
    const once = foldModelVariants([opt('a-low', 'A Low'), opt('a-high', 'A High')], suffixParser);
    expect(foldModelVariants(once, suffixParser)).toEqual(once);
  });
});

describe('resolveModelVariant', () => {
  const [family] = foldModelVariants(
    [
      opt('m-low', 'M Low'),
      opt('m-low-fast', 'M Low Fast'),
      opt('m-medium', 'M'),
      opt('m-medium-fast', 'M Fast'),
      opt('m-high', 'M High'),
    ],
    suffixParser,
  );

  it('picks the exact pairing, defaulting the effort', () => {
    expect(resolveModelVariant(family!, 'low', 'fast')).toBe('m-low-fast');
    expect(resolveModelVariant(family!, 'high', null)).toBe('m-high');
    expect(resolveModelVariant(family!, null, 'fast')).toBe('m-medium-fast');
    expect(resolveModelVariant(family!, null, null)).toBe('m-medium');
  });

  it('drops fast when the effort has no fast id, and ignores unknown efforts and tiers', () => {
    expect(resolveModelVariant(family!, 'high', 'fast')).toBe('m-high');
    expect(resolveModelVariant(family!, 'max', 'fast')).toBe('m-medium-fast');
    expect(resolveModelVariant(family!, 'max', 'priority')).toBe('m-medium');
  });

  it('returns the option id when there are no variants', () => {
    expect(resolveModelVariant({ id: 'plain', label: 'Plain' }, 'high', 'fast')).toBe('plain');
  });

  it('ignores reasoning for a family whose ids only encode the tier', () => {
    const [grok] = foldModelVariants(
      [
        { id: 'grok-4.7', label: 'Grok 4.7', reasoningOptions: [{ id: 'high', label: 'High', default: true }] },
        opt('grok-4.7-fast'),
      ],
      suffixParser,
    );
    expect(resolveModelVariant(grok!, 'high', 'fast')).toBe('grok-4.7-fast');
    expect(resolveModelVariant(grok!, 'high', null)).toBe('grok-4.7');
  });
});

describe('resolveVariantModelId and remembered variants', () => {
  const source = { id: 'variant-test-agent', fallbackModels: [DEFAULT_MODEL_OPTION] };
  const live = () =>
    foldModelVariants(
      [DEFAULT_MODEL_OPTION, opt('x-low', 'X Low'), opt('x-medium', 'X'), opt('x-medium-fast', 'X Fast'), opt('plain')],
      suffixParser,
    );

  it('resolves a remembered family and passes other ids through', () => {
    rememberLiveModels(source.id, live());
    expect(resolveVariantModelId(source, { model: 'x', reasoning: 'low' })).toEqual({
      model: 'x-low',
      reasoningConsumed: true,
      serviceTierConsumed: true,
    });
    expect(resolveVariantModelId(source, { model: 'x', serviceTier: 'fast' }).model).toBe('x-medium-fast');
    expect(resolveVariantModelId(source, { model: 'x-low' }).model).toBe('x-low');
    expect(resolveVariantModelId(source, { model: 'plain', reasoning: 'high' })).toEqual({
      model: 'plain',
      reasoningConsumed: false,
      serviceTierConsumed: false,
    });
    expect(resolveVariantModelId(source, { model: 'default' }).model).toBe('default');
    expect(resolveVariantModelId(source, { model: 'custom-typed' }).model).toBe('custom-typed');
  });

  it('keeps concrete variant ids known without adding them to the picker order', () => {
    const def = { ...source, name: 'Variant', bin: 'variant', versionArgs: [], buildArgs: () => [], streamFormat: 'plain' as const };
    rememberLiveModels(def.id, live());
    expect(getRememberedLiveModels(def.id).map((model) => model.id)).toEqual(['default', 'x', 'plain']);
    expect(isKnownModel(def, 'x-medium-fast')).toBe(true);
    expect(findKnownModel(def, 'x-medium-fast')).toEqual({ id: 'x-medium-fast', label: 'X Fast' });
    expect(isKnownReasoningEffort(def, 'x', 'low')).toBe(true);
    expect(isKnownReasoningEffort(def, 'x', 'high')).toBe(false);
    expect(isKnownServiceTier(def, 'x', 'fast')).toBe(true);
  });

  it('gives concrete ids the family efforts when effort is a CLI flag', () => {
    const def = { ...source, name: 'Variant', bin: 'variant', versionArgs: [], buildArgs: () => [], streamFormat: 'plain' as const };
    rememberLiveModels(
      def.id,
      foldModelVariants(
        [{ id: 'g', label: 'G', reasoningOptions: [{ id: 'high', label: 'High', default: true }] }, opt('g-fast', 'G Fast')],
        suffixParser,
      ),
    );
    expect(isKnownReasoningEffort(def, 'g-fast', 'high')).toBe(true);
  });

  it('finds variant ids inside folded fallback models too', () => {
    const def = {
      id: 'variant-fallback-agent',
      name: 'Variant',
      bin: 'variant',
      versionArgs: [],
      buildArgs: () => [],
      streamFormat: 'plain' as const,
      fallbackModels: live(),
    };
    expect(isKnownModel(def, 'x-low')).toBe(true);
    expect(resolveVariantModelId(def, { model: 'x', reasoning: 'low' }).model).toBe('x-low');
  });
});
