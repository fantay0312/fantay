import { describe, expect, it } from 'vitest';
import {
  PA_DEFAULT_APPEARANCE,
  PA_DEFAULT_CHAT_SETTINGS,
  PA_EMOTIONS,
  paAssetIdSchema,
  paCharacterInputSchema,
  paCharacterPatchSchema,
  paChatAppearanceSchema,
  paChatSettingsInputSchema,
  paChatSettingsPatchSchema,
  paDeckSchema,
  paLorebookInputSchema,
  paPersonaInputSchema,
  paPresetRefSchema,
  paSoulIdSchema,
  paSpeechIdSchema,
  paSpritesSchema,
  paStateFieldSchema,
  paStateOpInputSchema,
  paStateSchemaSchema,
  paStylePresetInputSchema,
  paVoiceSchema,
  toCharacterInput,
  toChatSettingsInput,
  toLorebookInput,
  toPersonaInput,
  toPresetInput,
} from '../../src/soul/index';
import type {
  PaCharacter,
  PaChatSettings,
  PaLorebook,
  PaPersona,
  PaResolvedAppearance,
  PaStylePreset,
} from '../../src/soul/index';

const entity = { id: 'agent-1', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000, revision: 3 };
const importMeta = { origin: null, preserved: {}, needsReview: [] };

function character(input: Record<string, unknown> = {}): PaCharacter {
  return { ...entity, ...paCharacterInputSchema.parse(input), ...importMeta };
}

function numberField(key: string, label = key) {
  return { key, label, kind: 'number', initial: 0 };
}

describe('soul schemas: save rule', () => {
  it('a partial patch changes only the keys it names', () => {
    const existing = character({ description: 'Keeps tea warm.', tags: ['quiet'], talkativeness: 0.8 });
    const patch = paCharacterPatchSchema.parse({ tagline: 'night owl' });
    expect(Object.keys(patch)).toEqual(['tagline']);
    const merged = paCharacterInputSchema.parse({ ...toCharacterInput(existing), ...patch });
    expect(merged).toEqual({ ...toCharacterInput(existing), tagline: 'night owl' });
    expect(merged.description).toBe('Keeps tea warm.');
    expect(merged.talkativeness).toBe(0.8);

    const settings = paChatSettingsInputSchema.parse({
      ...PA_DEFAULT_CHAT_SETTINGS, scenario: 'rainy station', historyBudget: 'long',
    });
    const settingsPatch = paChatSettingsPatchSchema.parse({ turnRecord: 'off' });
    expect(Object.keys(settingsPatch)).toEqual(['turnRecord']);
    expect(paChatSettingsInputSchema.parse({ ...settings, ...settingsPatch }))
      .toEqual({ ...settings, turnRecord: 'off' });
  });

  it('rejects an echoed entity and accepts it after the to…Input picker', () => {
    const echoedCharacter = character({ nickname: 'Mira' });
    expect(paCharacterInputSchema.safeParse(echoedCharacter).success).toBe(false);
    expect(paCharacterInputSchema.safeParse(toCharacterInput(echoedCharacter)).success).toBe(true);
    expect(Object.keys(toCharacterInput(echoedCharacter))).not.toContain('revision');

    const lorebook: PaLorebook = {
      ...entity, ...paLorebookInputSchema.parse({ name: 'Harbor town' }),
      origin: null, preserved: {}, needsReview: [],
    };
    expect(paLorebookInputSchema.safeParse(lorebook).success).toBe(false);
    expect(paLorebookInputSchema.safeParse(toLorebookInput(lorebook)).success).toBe(true);

    const persona: PaPersona = { ...entity, ...paPersonaInputSchema.parse({ name: 'Lin' }) };
    expect(paPersonaInputSchema.safeParse(persona).success).toBe(false);
    expect(paPersonaInputSchema.safeParse(toPersonaInput(persona)).success).toBe(true);

    const preset: PaStylePreset = { ...entity, ...paStylePresetInputSchema.parse({ name: 'Mine' }), builtin: false };
    expect(paStylePresetInputSchema.safeParse(preset).success).toBe(false);
    expect(paStylePresetInputSchema.safeParse(toPresetInput(preset)).success).toBe(true);

    const chat: PaChatSettings = { ...entity, ...PA_DEFAULT_CHAT_SETTINGS };
    const view = { ...chat, activeEvent: null, candidateEvent: null, branchOf: null, userStateOps: [] };
    expect(paChatSettingsInputSchema.safeParse(view).success).toBe(false);
    expect(paChatSettingsInputSchema.safeParse(toChatSettingsInput(view)).success).toBe(true);
  });
});

describe('soul schemas: uniqueness and reserved keys', () => {
  it('fails on duplicate state keys and labels', () => {
    expect(paStateSchemaSchema.safeParse([numberField('trust'), numberField('mood_level')]).success).toBe(true);
    expect(paStateSchemaSchema.safeParse([numberField('trust'), numberField('Trust', 'other')]).success).toBe(false);
    expect(paStateSchemaSchema.safeParse([numberField('trust', '信任'), numberField('bond', '信任')]).success).toBe(false);
    expect(paStateSchemaSchema.safeParse([numberField('a', 'Trust'), numberField('b', 'ＴＲＵＳＴ')]).success).toBe(false);
  });

  it('fails on duplicate deck ids and lore entry ids', () => {
    const deck = (id: string) => ({ id, name: 'Fate', cards: [{ title: 'Sun' }, { title: 'Moon' }] });
    expect(paCharacterInputSchema.safeParse({ decks: [deck('fate'), deck('omen')] }).success).toBe(true);
    expect(paCharacterInputSchema.safeParse({ decks: [deck('fate'), deck('fate')] }).success).toBe(false);
    expect(paDeckSchema.safeParse({ ...deck('fate'), cards: [{ title: 'Only' }] }).success).toBe(false);

    expect(paLorebookInputSchema.safeParse({ name: 'Book', entries: [{ id: 'e1' }, { id: 'e2' }] }).success).toBe(true);
    expect(paLorebookInputSchema.safeParse({ name: 'Book', entries: [{ id: 'e1' }, { id: 'e1' }] }).success).toBe(false);
  });

  it('rejects __proto__, reserved and case-folded reserved state keys', () => {
    for (const key of ['__proto__', 'Mood', 'constructor', 'toString', 'STATE', 'meta', '1abc', 'a-b']) {
      expect(paStateFieldSchema.safeParse(numberField(key)).success, key).toBe(false);
    }
    expect(paStateFieldSchema.safeParse(numberField('affection')).success).toBe(true);
  });
});

describe('soul schemas: values', () => {
  it('rejects non-finite numbers', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(paCharacterInputSchema.safeParse({ talkativeness: value }).success).toBe(false);
      expect(paStateFieldSchema.safeParse({ ...numberField('hp'), initial: value }).success).toBe(false);
      expect(paStateOpInputSchema.safeParse({ key: 'hp', op: 'delta', value }).success).toBe(false);
      expect(paStylePresetInputSchema.safeParse({ name: 'x', sampling: { temperature: value } }).success).toBe(false);
    }
  });

  it('ties kind and initial together', () => {
    expect(paStateFieldSchema.safeParse({ key: 'hp', label: 'HP', kind: 'number', initial: '3' }).success).toBe(false);
    expect(paStateFieldSchema.safeParse({ key: 'place', label: 'Place', kind: 'text', initial: 3 }).success).toBe(false);
    expect(paStateFieldSchema.safeParse({ key: 'bag', label: 'Bag', kind: 'list', initial: 'key' }).success).toBe(false);
    const weather = { key: 'weather', label: 'Weather', kind: 'enum', options: ['rain', 'sun'] };
    expect(paStateFieldSchema.safeParse({ ...weather, initial: 'rain' }).success).toBe(true);
    expect(paStateSchemaSchema.safeParse([{ ...weather, initial: 'snow' }]).success).toBe(false);
    expect(paStateSchemaSchema.safeParse([{ ...numberField('hp'), min: 0, max: 10, initial: 11 }]).success).toBe(false);
    expect(paStateSchemaSchema.safeParse([{ ...numberField('hp'), min: 5, max: 1, initial: 3 }]).success).toBe(false);
    expect(paStateSchemaSchema.safeParse([{ ...weather, initial: 'rain', options: ['rain', 'rain'] }]).success).toBe(false);
    expect(paStateSchemaSchema.safeParse([{ key: 'bag', label: 'Bag', kind: 'list', initial: ['key', 'key'] }]).success)
      .toBe(false);
  });

  it('enforces the greeting and lore content totals', () => {
    const greeting = 'x'.repeat(32000);
    expect(paCharacterInputSchema.safeParse({ alternateGreetings: Array(12).fill(greeting) }).success).toBe(true);
    expect(paCharacterInputSchema.safeParse({ alternateGreetings: Array(13).fill(greeting) }).success).toBe(false);

    const content = 'y'.repeat(32000);
    const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `e${index + 1}`, content }));
    expect(paLorebookInputSchema.safeParse({ name: 'Book', entries: entries(62) }).success).toBe(true);
    expect(paLorebookInputSchema.safeParse({ name: 'Book', entries: entries(63) }).success).toBe(false);
  });

  it('id schemas reject path-shaped values', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(paAssetIdSchema.safeParse(`${uuid}.png`).success).toBe(true);
    for (const bad of [`../${uuid}.png`, `${uuid}.png/..`, `a/${uuid}.webp`, `${uuid}.svg`, `${uuid.toUpperCase()}.png`, '..']) {
      expect(paAssetIdSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(paSoulIdSchema.safeParse('persona_1-a').success).toBe(true);
    for (const bad of ['../x', 'a/b', '.hidden', 'a\\b', '', 'x'.repeat(65)]) {
      expect(paSoulIdSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(paPresetRefSchema.safeParse('builtin:real-chat').success).toBe(true);
    for (const bad of ['builtin:../x', 'builtin:', '../preset', 'builtin:a/b', '/abs']) {
      expect(paPresetRefSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('parses stage 1 rows and fills the stage 2 keys', () => {
    const stage1Character = { description: 'Keeps tea warm.', appearance: { theme: 'rain', layout: 'journal' }, decks: [] };
    const parsed = paCharacterInputSchema.parse(stage1Character);
    expect(parsed.sprites).toEqual({});
    expect(parsed.voice).toBeNull();
    expect(parsed.appearance).toEqual({ theme: 'rain', layout: 'journal' });
    expect(paChatSettingsInputSchema.parse({ turnRecord: 'off' }).voiceReplies).toBe('manual');
    expect(PA_DEFAULT_CHAT_SETTINGS.voiceReplies).toBe('manual');
    expect(paChatAppearanceSchema.parse({ theme: 'ink' })).toEqual({ theme: 'ink' });
    expect(paChatAppearanceSchema.parse({ stage: 'side' })).toEqual({ stage: 'side' });
    expect(paChatAppearanceSchema.safeParse({ stage: 'top' }).success).toBe(false);
    expect(paChatSettingsInputSchema.safeParse({ voiceReplies: 'always' }).success).toBe(false);
    expect(Object.keys(paCharacterPatchSchema.parse({ tagline: 'x' }))).toEqual(['tagline']);
  });

  it('validates sprites, voice and speech ids', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(paSpritesSchema.parse({ happy: `${uuid}.png`, neutral: `${uuid}.webp` })).toEqual({ happy: `${uuid}.png`, neutral: `${uuid}.webp` });
    expect(paSpritesSchema.safeParse({ joyful: `${uuid}.png` }).success).toBe(false);
    expect(paSpritesSchema.safeParse({ happy: '../x.png' }).success).toBe(false);
    expect(paSpritesSchema.safeParse({ happy: `${uuid}.svg` }).success).toBe(false);
    expect(paCharacterInputSchema.safeParse({ sprites: { sad: `${uuid}.jpg` } }).success).toBe(true);
    expect(PA_EMOTIONS).toEqual(['neutral', 'happy', 'sad', 'angry', 'surprised', 'shy', 'worried', 'sleepy']);

    expect(paVoiceSchema.parse({ model: 'openai/gpt-4o-mini-tts' })).toEqual({ model: 'openai/gpt-4o-mini-tts', voice: '', language: '' });
    expect(paVoiceSchema.parse({ model: 'minimax:speech-02', voice: ' alloy ', language: 'zh' }))
      .toEqual({ model: 'minimax:speech-02', voice: 'alloy', language: 'zh' });
    for (const model of ['', '-x', '../tts', 'a b', 'x'.repeat(121), 'tts;rm']) {
      expect(paVoiceSchema.safeParse({ model }).success, model).toBe(false);
    }
    expect(paVoiceSchema.safeParse({ model: 'x'.repeat(120) }).success).toBe(true);
    expect(paVoiceSchema.safeParse({ model: 'tts', voice: 'v'.repeat(201) }).success).toBe(false);
    expect(paVoiceSchema.safeParse({ model: 'tts', extra: 1 }).success).toBe(false);
    expect(paCharacterInputSchema.safeParse({ voice: { model: 'bad model' } }).success).toBe(false);
    expect(paCharacterInputSchema.parse({ voice: null }).voice).toBeNull();

    const hash = 'a'.repeat(64);
    expect(paSpeechIdSchema.safeParse(`${hash}.mp3`).success).toBe(true);
    for (const bad of [`${hash}.exe`, `${'A'.repeat(64)}.mp3`, `../${hash}.mp3`, `${hash.slice(1)}.wav`, `${hash}.mp3/x`]) {
      expect(paSpeechIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('PaResolvedAppearance has no undefined members (type test)', () => {
    const resolved: PaResolvedAppearance = { ...PA_DEFAULT_APPEARANCE };
    // @ts-expect-error a resolved appearance cannot hold undefined
    const withUndefined: PaResolvedAppearance = { ...PA_DEFAULT_APPEARANCE, theme: undefined };
    // @ts-expect-error a resolved appearance needs every key
    const missing: PaResolvedAppearance = { theme: 'fantay' };
    expect(resolved.accent).toBeNull();
    expect(withUndefined.theme).toBeUndefined();
    expect(missing.theme).toBe('fantay');
  });
});
