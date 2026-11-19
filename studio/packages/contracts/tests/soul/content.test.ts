import { describe, expect, it } from 'vitest';
import {
  PA_BUILTIN_PRESETS,
  PA_DEFAULT_PRESET_ID,
  PA_STARTERS,
  PA_STARTER_SHELF,
  SOUL_LIMITS,
  SOUL_TEXT,
  builtinPresets,
  detectCrisis,
  paCharacterInputSchema,
  paChatSettingsPatchSchema,
  paLorebookInputSchema,
  paPresetRefSchema,
  paStylePresetInputSchema,
  resolvePreset,
} from '../../src/soul/index';
import type { PaStarterCharacter, PaStarterRoom, PaStylePreset } from '../../src/soul/index';

const characters = PA_STARTERS.filter((starter): starter is PaStarterCharacter => starter.kind === 'character');
const rooms = PA_STARTERS.filter((starter): starter is PaStarterRoom => starter.kind === 'room');
/** Macro names the built-in content may use. */
const KNOWN_MACROS = new Set(['char', 'user', 'daypart']);

function macroNames(text: string): string[] {
  return [...text.matchAll(/\{\{([^{}]*)\}\}/g)].map(match => (match[1] ?? '').trim().toLowerCase());
}

function userPreset(id: string, name: string): PaStylePreset {
  return { id, createdAt: 1, updatedAt: 1, revision: 1, ...paStylePresetInputSchema.parse({ name, main: 'Be brief.' }) };
}

describe('built-in presets', () => {
  it('are the five named presets with the default first', () => {
    expect(PA_BUILTIN_PRESETS.map(preset => preset.id)).toEqual([
      'builtin:real-chat', 'builtin:stay', 'builtin:slow-scene', 'builtin:light-novel', 'builtin:game-master',
    ]);
    expect(PA_DEFAULT_PRESET_ID).toBe('builtin:real-chat');
    expect(PA_BUILTIN_PRESETS.map(preset => preset.name.zh)).toEqual(['真人聊天', '陪我待一会儿', '慢慢走一幕', '轻小说旁白', '跑团主持']);
  });

  it('have both locales, valid flags and stay within SOUL_LIMITS', () => {
    for (const preset of PA_BUILTIN_PRESETS) {
      expect(paPresetRefSchema.safeParse(preset.id).success, preset.id).toBe(true);
      for (const locale of ['zh', 'en'] as const) {
        const label = `${preset.id} ${locale}`;
        const doc = { name: preset.name[locale], description: preset.description[locale], main: preset.main[locale], ...preset.doc };
        expect(doc.name.trim().length, label).toBeGreaterThan(0);
        expect(doc.description.trim().length, label).toBeGreaterThan(0);
        expect(doc.main.trim().length, label).toBeGreaterThan(0);
        expect(doc.name.length, label).toBeLessThanOrEqual(SOUL_LIMITS.presetName);
        expect(doc.description.length, label).toBeLessThanOrEqual(SOUL_LIMITS.presetDescription);
        expect(doc.main.length, label).toBeLessThanOrEqual(SOUL_LIMITS.presetMain);
        expect(paStylePresetInputSchema.parse(doc), label).toEqual(doc);
        for (const name of macroNames(doc.main)) expect(KNOWN_MACROS.has(name), `${label} {{${name}}}`).toBe(true);
      }
      expect(preset.doc.postHistory, preset.id).toBe('');
      expect(preset.doc.extra, preset.id).toBe('');
    }
    const flags = Object.fromEntries(PA_BUILTIN_PRESETS.map(preset => [preset.id, preset.doc]));
    expect(flags['builtin:real-chat']).toMatchObject({ format: 'im', multiBubble: true, playRequests: true, suggestChoices: false });
    expect(flags['builtin:stay']).toMatchObject({ format: 'im', tempo: 'slow', playRequests: false });
    expect(flags['builtin:slow-scene']).toMatchObject({ format: 'prose', narration: 'third', suggestChoices: true, timeAware: false });
    expect(flags['builtin:light-novel']).toMatchObject({ replyLength: 'long', mood: false, sampling: { maxTokens: 1536 } });
    expect(flags['builtin:game-master']).toMatchObject({ narration: 'second', suggestChoices: true, playRequests: true, mood: false });
  });

  it('become localised PaStylePreset rows', () => {
    const zh = builtinPresets('zh');
    const en = builtinPresets('en');
    expect(zh).toHaveLength(5);
    for (const row of [...zh, ...en]) {
      expect(row).toMatchObject({ createdAt: 0, updatedAt: 0, revision: 0, builtin: true });
    }
    expect(zh[0]).toMatchObject({ id: 'builtin:real-chat', name: '真人聊天', format: 'im' });
    expect(en[0]).toMatchObject({ id: 'builtin:real-chat', name: 'Real chat' });
    expect(en[3]?.sampling).toEqual({ maxTokens: 1536 });
    const first = builtinPresets('en')[3];
    if (first) first.sampling.maxTokens = 64;
    expect(builtinPresets('en')[3]?.sampling).toEqual({ maxTokens: 1536 });
  });

  it('resolve by built-in id, then user id, then fall back to the default', () => {
    const mine = userPreset('my-style', '我的文风');
    expect(resolvePreset('builtin:stay', [mine], 'zh')).toMatchObject({ id: 'builtin:stay', name: '陪我待一会儿', builtin: true });
    expect(resolvePreset('builtin:game-master', [], 'en')).toMatchObject({ id: 'builtin:game-master', name: 'Game master' });
    expect(resolvePreset('my-style', [mine], 'zh')).toBe(mine);
    for (const ref of [null, undefined, '', 'missing', 'builtin:missing']) {
      expect(resolvePreset(ref, [mine], 'zh'), String(ref)).toMatchObject({ id: PA_DEFAULT_PRESET_ID, name: '真人聊天' });
    }
    expect(resolvePreset('builtin:stay', [userPreset('builtin:stay', 'shadow')], 'en')).toMatchObject({ name: 'Stay with me', builtin: true });
  });
});

describe('starters', () => {
  it('are six unique starters with a shelf of three characters', () => {
    expect(PA_STARTERS.map(starter => starter.id)).toEqual(['xiaoyue', 'zhou', 'alan', 'storyteller', 'foghaven', 'tea-room']);
    expect(PA_STARTER_SHELF).toEqual(['xiaoyue', 'storyteller', 'zhou']);
    for (const id of PA_STARTER_SHELF) expect(characters.some(starter => starter.id === id), id).toBe(true);
  });

  it('every character and lorebook passes its schema and stays within SOUL_LIMITS', () => {
    expect(characters).toHaveLength(5);
    for (const starter of characters) {
      const parsed = paCharacterInputSchema.safeParse(starter.character);
      if (!parsed.success) throw new Error(`${starter.id}: ${parsed.error.message}`);
      const character = parsed.data;
      expect(character.autoMemory, starter.id).toBe(true);
      expect(character.description.length, starter.id).toBeGreaterThan(0);
      expect(character.firstMessage.length, starter.id).toBeGreaterThan(0);
      expect(character.firstMessage.length, starter.id).toBeLessThanOrEqual(SOUL_LIMITS.messageContent);
      expect(character.openers.length, starter.id).toBeGreaterThan(0);
      expect(character.exampleDialogue.startsWith('<START>\n'), starter.id).toBe(true);
      expect(PA_BUILTIN_PRESETS.some(preset => preset.id === character.presetId), starter.id).toBe(true);
      expect(character.tagline, starter.id).toBe(starter.display.zh.tagline);
      expect(starter.agent.name, starter.id).toBe(starter.display.zh.name);
      expect(starter.agent.name.length, starter.id).toBeLessThanOrEqual(SOUL_LIMITS.name);
      expect(starter.agent.role.length, starter.id).toBeGreaterThan(0);
      for (const text of [character.description, character.personality, character.scenario, character.firstMessage,
        ...character.alternateGreetings, character.exampleDialogue]) {
        for (const name of macroNames(text)) expect(KNOWN_MACROS.has(name), `${starter.id} {{${name}}}`).toBe(true);
      }
      if (starter.lorebook) {
        const lorebook = paLorebookInputSchema.safeParse(starter.lorebook);
        if (!lorebook.success) throw new Error(`${starter.id} lorebook: ${lorebook.error.message}`);
        expect(lorebook.data.entries.length, starter.id).toBeGreaterThan(0);
        expect(lorebook.data.entries.every(entry => entry.content.length > 0 && (entry.constant || entry.keys.length > 0)), starter.id).toBe(true);
      }
    }
    for (const starter of PA_STARTERS) {
      for (const locale of ['zh', 'en'] as const) {
        const { name, tagline } = starter.display[locale];
        expect(name.length, `${starter.id} ${locale}`).toBeGreaterThan(0);
        expect(name.length, `${starter.id} ${locale}`).toBeLessThanOrEqual(SOUL_LIMITS.name);
        expect(tagline.length, `${starter.id} ${locale}`).toBeGreaterThan(0);
        expect(tagline.length, `${starter.id} ${locale}`).toBeLessThanOrEqual(SOUL_LIMITS.tagline);
      }
    }
  });

  it('ship their state schemas, deck and world books as specified', () => {
    const byId = new Map(characters.map(starter => [starter.id, paCharacterInputSchema.parse(starter.character)]));
    expect(byId.get('storyteller')?.stateSchema.map(field => [field.key, field.kind])).toEqual([
      ['hp', 'number'], ['gold', 'number'], ['location', 'text'], ['bag', 'list'],
    ]);
    expect(byId.get('foghaven')?.stateSchema.find(field => field.key === 'suspect')).toMatchObject({ kind: 'enum', writable: 'user', initial: '未定' });
    const soup = byId.get('alan')?.decks[0];
    expect(soup).toMatchObject({ id: 'soup', name: '海龟汤' });
    expect(soup?.cards).toHaveLength(8);
    expect(soup?.cards.every(card => card.text.length > 0 && card.secret.length > 0)).toBe(true);
    expect(byId.get('xiaoyue')?.alternateGreetings).toHaveLength(2);
    expect(byId.get('xiaoyue')?.firstMessage).toContain('{{daypart}}');
    const foghaven = characters.find(starter => starter.id === 'foghaven');
    expect(foghaven?.lorebook).toMatchObject({ recursive: false, tokenBudget: 4000 });
    expect(foghaven?.lorebook?.entries).toHaveLength(8);
    expect(characters.find(starter => starter.id === 'zhou')?.lorebook?.entries).toHaveLength(6);
  });

  it('room members exist and the room settings pass their schema', () => {
    expect(rooms).toHaveLength(1);
    for (const room of rooms) {
      const ids = new Set(characters.map(starter => starter.id));
      expect(room.group.members.length).toBeGreaterThan(1);
      for (const member of room.group.members) expect(ids.has(member), member).toBe(true);
      expect(room.group.members).toContain(room.group.moderator);
      expect(room.group.members).toContain(room.opening.from);
      expect(paChatSettingsPatchSchema.safeParse(room.chat).success).toBe(true);
      expect(room.opening.text.length).toBeGreaterThan(0);
      expect(room.opening.text.length).toBeLessThanOrEqual(SOUL_LIMITS.messageContent);
      expect(room.opening.openers.length).toBeLessThanOrEqual(SOUL_LIMITS.openers);
      for (const opener of room.opening.openers) expect(opener.length, opener).toBeLessThanOrEqual(SOUL_LIMITS.opener);
      expect(room.group.name.length).toBeLessThanOrEqual(SOUL_LIMITS.name);
    }
  });
});

describe('crisis examples named in the specification', () => {
  it('classify as specified', () => {
    for (const text of ['想死你了', '可想死我了', '累得想死']) expect(detectCrisis([text]), text).toEqual({ level: 'none', rule: '' });
    expect(detectCrisis(['我想死']).level).toBe('crisis');
  });
});

describe('SOUL_TEXT', () => {
  it('has the same keys in both locales and no empty value', () => {
    const zhKeys = Object.keys(SOUL_TEXT.zh).sort();
    expect(zhKeys.length).toBeGreaterThan(0);
    expect(Object.keys(SOUL_TEXT.en).sort()).toEqual(zhKeys);
    for (const locale of ['zh', 'en'] as const) {
      for (const [key, value] of Object.entries(SOUL_TEXT[locale])) expect(value.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
    }
  });
});
