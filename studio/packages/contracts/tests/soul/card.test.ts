import { describe, expect, it } from 'vitest';
import {
  SOUL_LIMITS,
  exportCharacterCard,
  importWorldInfo,
  paCharacterInputSchema,
  paLorebookInputSchema,
  parseCardText,
  parseCharacterCard,
  seededRng,
} from '../../src/soul/index';
import type { PaCardImportPreview, PaCharacter, PaLorebook, PaNeedsReviewItem } from '../../src/soul/index';
import { fixtureJson, fixtureText, mutate } from './fixtures/fuzz';

type OkPreview = Extract<PaCardImportPreview, { ok: true }>;

const NOW = 1_800_000_000_000;
const CREATED = 1_700_000_000_000;

function ok(preview: PaCardImportPreview): OkPreview {
  if (!preview.ok) throw new Error(`card did not parse: ${preview.error} ${preview.detail ?? ''}`);
  return preview;
}

function parse(name: string, fileName?: string): OkPreview {
  return ok(parseCharacterCard(fixtureJson(name), fileName === undefined ? { now: NOW } : { now: NOW, fileName }));
}

function itemKeys(items: readonly PaNeedsReviewItem[], action?: PaNeedsReviewItem['action']): string[] {
  return items.filter(item => action === undefined || item.action === action).map(item => item.key);
}

function entities(preview: OkPreview): { character: PaCharacter; lorebooks: PaLorebook[] } {
  const character: PaCharacter = {
    id: 'agent-1', createdAt: CREATED, updatedAt: CREATED, revision: 1, ...preview.character, ...preview.meta,
  };
  const lorebooks: PaLorebook[] = preview.lorebook !== null && preview.lorebookMeta !== null
    ? [{ id: 'lb-1', createdAt: CREATED, updatedAt: CREATED, revision: 1, ...preview.lorebook, ...preview.lorebookMeta }]
    : [];
  return { character, lorebooks };
}

function without(record: Record<string, unknown> | undefined, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !keys.includes(key)));
}

describe('parseCharacterCard: formats', () => {
  it('reads a flat V1 card and preserves its unknown root keys', () => {
    const preview = parse('v1-flat.json', 'lin.json');
    expect(preview.format).toBe('ccv1');
    expect(preview.name).toBe('Lin');
    expect(preview.character).toMatchObject({
      description: "A quiet bookbinder who repairs other people's diaries and never reads them.",
      personality: 'patient, dry humour, notices small things',
      firstMessage: "*looks up from the press* Oh, you're early. Mind the glue.",
      creatorNotes: 'A small slice-of-life card written for the importer tests.',
      talkativeness: 0.7,
      tags: ['slice of life', 'Books'],
      autoMemory: false,
      personaId: null,
      lorebookIds: [],
      portraitAssetId: null,
      presetId: null,
    });
    expect(preview.meta.origin).toEqual({ format: 'ccv1', name: 'lin.json', importedAt: NOW });
    expect(preview.meta.preserved).toEqual({
      root: { avatar: 'none', chat: 'Lin - 2024-01-02@10h00m00s', create_date: '2024-01-02@10h00m00s' },
    });
    expect(preview.preservedKeys).toEqual(['root.avatar', 'root.chat', 'root.create_date']);
    expect(preview.lorebook).toBeNull();
    expect(preview.portrait).toBeNull();
  });

  it('maps the char_name spelling of V1', () => {
    const preview = ok(parseCharacterCard({
      char_name: 'Old Pip', char_persona: 'A retired lamplighter.', world_scenario: 'A foggy square.',
      char_greeting: 'Evening.', example_dialogue: '<START>\nPip: Evening.', avatar: 'pip.png',
    }, { now: NOW }));
    expect(preview.format).toBe('ccv1');
    expect(preview.name).toBe('Old Pip');
    expect(preview.character).toMatchObject({
      description: 'A retired lamplighter.', scenario: 'A foggy square.', firstMessage: 'Evening.', exampleDialogue: '<START>\nPip: Evening.',
    });
    expect(preview.meta.preserved).toEqual({ root: { avatar: 'pip.png' } });
  });

  it('reads a SillyTavern V2 export with mirrors, depth prompt, world link and string numbers', () => {
    const preview = parse('v2-st-export.json');
    expect(preview.format).toBe('ccv2');
    expect(preview.name).toBe('Captain Wen');
    expect(preview.character).toMatchObject({
      description: 'Mirror description of the harbour pilot.',            // data.description is empty: mirror
      firstMessage: '<img src="https://example.com/boat.png"> The tide turns in an hour. Are you coming aboard?',
      scenario: 'The pilot boat waits at the breakwater before a storm.',
      creatorNotes: 'Pairs with the Harbor Lore world book.',
      systemPrompt: '{{original}} Keep replies short.',
      postHistoryInstructions: 'Stay in character as {{char}}.',
      tags: ['sea', 'mentor'],
      creator: 'fixture-team',
      characterVersion: '1.2',
      talkativeness: 0.8,                                                  // extensions win over the root mirror
      characterNote: { text: 'Remember the storm of last winter.', depth: 2, role: 'user' },
    });
    expect(preview.character.alternateGreetings).toHaveLength(2);
    expect(preview.lorebook).toBeNull();
    expect(preview.meta.preserved.root).toEqual({
      avatar: 'none', chat: 'Captain Wen - 2024-03-01@09h00m00s', fav: false, create_date: '2024-03-01@09h00m00s',
    });
    expect(preview.meta.preserved.extensions).toEqual({
      fav: false, world: 'Harbor Lore', chub: { id: 12345, full_path: 'fixture/captain-wen' },
    });
    expect(Object.keys(preview.meta.preserved.quarantine ?? {})).toEqual(['regex_scripts']);
    const items = preview.meta.needsReview;
    expect(items).toContainEqual(expect.objectContaining({ key: 'extensions.regex_scripts', kind: 'script', action: 'quarantined' }));
    expect(items).toContainEqual(expect.objectContaining({ key: 'firstMessage', kind: 'html', action: 'kept' }));
    expect(items).toContainEqual(expect.objectContaining({ key: 'alternateGreetings', kind: 'html', action: 'kept' }));
    expect(items).toContainEqual({
      key: 'extensions.world', kind: 'other', action: 'kept', summary: 'depends on external world book Harbor Lore',
    });
    expect(preview.preservedKeys).not.toContain('quarantine.regex_scripts');
  });

  it('reads a full V3 card: fantay extensions, book with decorators, assets and quarantine', () => {
    const preview = parse('v3-full.json');
    expect(preview.format).toBe('ccv3');
    expect(preview.name).toBe('Mira');
    expect(preview.character).toMatchObject({
      nickname: '小米',
      tagline: '钟楼的档案员',
      firstMessage: '*Mira looks up from a stack of letters.* You came back.',   // empty first_mes: first alternate
      alternateGreetings: ['The clock is three minutes slow tonight.'],
      presetId: 'builtin:slow-scene',
      appearance: { theme: 'archive', shape: 'square', layout: 'journal' },
      openers: ['今天有新信吗？', '钟又慢了吗？'],
      characterNote: { text: 'Mira never lies about letters.', depth: 6, role: 'system' },
      talkativeness: 0.3,
      autoMemory: false,
    });
    expect(preview.character.stateSchema).toEqual([
      { key: 'trust', label: '信任', kind: 'number', initial: 10, min: 0, max: 100, hint: '', writable: 'model' },
    ]);
    expect(preview.character.decks[0]?.cards[1]).toEqual({ title: 'A postcard', text: '', secret: '' });

    const book = preview.lorebook;
    expect(book).not.toBeNull();
    expect(book).toMatchObject({ name: 'Clock Tower', scanDepth: 3, tokenBudget: SOUL_LIMITS.loreImportBudgetFloor, recursive: false });
    expect(book?.entries.map(entry => entry.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(book?.entries[0]).toMatchObject({
      position: 'at_depth', depth: 2, role: 'assistant', content: 'The lighthouse keeper writes every Sunday.',
      preserved: { uid: 1, position: 4, decorators: ['@@depth 2', '@@role assistant', '@@custom_marker keep me'], use_regex: false },
    });
    expect(book?.entries[1]).toMatchObject({
      title: 'Letters', position: 'after_char', logic: 'and_all', groups: ['letters', 'night'], groupWeight: 80, probability: 50,
      sticky: 2, cooldown: 1, scanDepth: 5, caseSensitive: true, matchWholeWords: false,
      preserved: { uid: 2, position: 1, priority: 5, extensions: { weight_hint: 3 } },
    });
    expect(book?.entries[3]).toMatchObject({ title: 'Bell', constant: true, keys: ['bell', 'horn'] });
    expect(preview.lorebookMeta).toMatchObject({
      origin: { format: 'card', name: 'Mira' },
      preserved: { description: 'Places and people of the tower.', extensions: { fixture: true } },
    });

    expect(preview.portrait?.mime).toBe('image/png');
    expect(preview.portrait?.data.startsWith('iVBORw0KGgo')).toBe(true);

    const preserved = preview.meta.preserved;
    expect(Object.keys(preserved.data ?? {})).toEqual([
      'group_only_greetings', 'creator_notes_multilingual', 'source', 'creation_date', 'modification_date', 'assets',
    ]);
    expect((preserved.data?.assets as unknown[]).length).toBe(1);
    expect(preserved.extensions).toEqual({ risuai: { utilityBot: false }, custom_field: { a: 1 } });
    expect(preserved.quarantine).toEqual({
      risuai: { customScripts: [{ comment: 'swap', in: 'a', out: 'b' }], triggerscript: [] },
      tavern_helper: { scripts: [{ name: 'popup', content: 'alert(1)' }] },
      assets: [{ type: 'background', uri: 'https://example.com/archive.png', name: 'archive', ext: 'png' }],
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(preserved.extensions?.custom_field as object, '__proto__')).toBe(false);
    expect(preview.preservedKeys).toEqual([
      'data.group_only_greetings', 'data.creator_notes_multilingual', 'data.source', 'data.creation_date',
      'data.modification_date', 'data.assets', 'extensions.risuai', 'extensions.custom_field',
    ]);

    const items = preview.meta.needsReview;
    expect(itemKeys(items, 'quarantined')).toEqual([
      'extensions.risuai.customScripts', 'extensions.risuai.triggerscript', 'extensions.tavern_helper', 'data.assets.1',
    ]);
    expect(items.find(item => item.key === 'data.assets.1')?.kind).toBe('remote');
    expect(items).toContainEqual(expect.objectContaining({ key: 'creatorNotes', kind: 'html', action: 'kept' }));
    expect(items).toContainEqual(expect.objectContaining({ key: 'entries.e3.secondaryKeys', kind: 'regex', action: 'kept' }));
    expect(preview.lorebookMeta?.needsReview).toEqual([expect.objectContaining({ key: 'entries.e3.secondaryKeys' })]);
  });

  it('cleans a BOM, CRLF line ends and NUL through parseCardText', () => {
    const preview = ok(parseCardText(fixtureText('crlf-bom.json'), { now: NOW }));
    expect(preview.name).toBe('Rin');
    expect(preview.character.description).toBe('Line one\nLine two\nLine three');
    expect(preview.character.firstMessage).toBe('Hello there.\nWelcome back.');
    expect(preview.character.exampleDialogue).toBe('<START>\n{{user}}: Hi\n{{char}}: Hi.');
    expect(preview.character.alternateGreetings).toEqual(['One\ntwo']);
  });

  it('reports text, JSON and shape errors', () => {
    expect(parseCardText('{"name": ', { now: NOW })).toMatchObject({ ok: false, error: 'bad-json' });
    expect(parseCardText('x'.repeat(SOUL_LIMITS.cardTextChars + 1), { now: NOW })).toMatchObject({ ok: false, error: 'too-large' });
    for (const value of [null, [], 'card', 42, true]) {
      expect(parseCharacterCard(value, { now: NOW })).toEqual({ ok: false, error: 'not-object' });
    }
    expect(parseCharacterCard({ spec: 'chara_card_v2', data: { description: 'nameless' } }, { now: NOW }))
      .toEqual({ ok: false, error: 'no-name' });
    expect(parseCharacterCard({ description: 'no name at all' }, { now: NOW, fileName: 'x.json' }))
      .toEqual({ ok: false, error: 'no-name' });
    const stem = ok(parseCharacterCard({ spec: 'chara_card_v3', data: { name: '   ' } }, { now: NOW, fileName: 'cards/Nova Lee.card.json' }));
    expect(stem.name).toBe('Nova Lee.card');
    expect(stem.meta.origin?.name).toBe('cards/Nova Lee.card.json');
  });

  it('answers unsupported-format for a world book so callers can route it to the world importer', () => {
    const entry = { uid: 0, key: ['灯塔'], content: '灯塔在岬角上。', comment: '灯塔', order: 100, position: 0 };
    const worlds: unknown[] = [
      { name: '灯塔', entries: { 0: entry } },                    // SillyTavern map, top-level name
      { entries: [entry] },                                       // entries as a list, no name
      { name: '灯塔', entries: {}, scan_depth: 2 },
      fixtureJson('st-world.json'),
      { spec: 'lorebook_v3', data: { name: '灯塔', entries: [entry] } },
    ];
    for (const world of worlds) {
      expect(parseCharacterCard(world, { now: NOW, fileName: '灯塔.json' })).toEqual({ ok: false, error: 'unsupported-format', detail: 'world book' });
    }
    expect(parseCardText(JSON.stringify(worlds[0]), { now: NOW })).toMatchObject({ ok: false, error: 'unsupported-format' });
    expect(importWorldInfo(worlds[0], { fileName: '灯塔.json' }).ok).toBe(true);
    // Any card body key keeps an object with entries a card.
    for (const card of [
      { name: 'A', description: 'd', entries: { 0: entry } },
      { name: 'A', first_mes: 'Hi', entries: [entry] },
      { char_name: 'A', char_persona: 'p', entries: [entry] },
      { spec: 'chara_card_v2', data: { name: 'A' }, entries: [entry] },
    ]) {
      expect(parseCharacterCard(card, { now: NOW }).ok).toBe(true);
    }
    // A string or number entries field is not a world book shape.
    expect(parseCharacterCard({ name: 'A', entries: 'none' }, { now: NOW }).ok).toBe(true);
  });

  it('clips the name to 60 characters with a report item', () => {
    const preview = ok(parseCharacterCard({ name: `  ${'名'.repeat(70)}  ` }, { now: NOW }));
    expect(preview.name).toBe('名'.repeat(SOUL_LIMITS.name));
    expect(preview.meta.needsReview).toContainEqual(expect.objectContaining({ key: 'name', action: 'truncated' }));
  });
});

describe('parseCharacterCard: fields', () => {
  it('keeps first_mes when it is set and shifts the first alternate only when it is empty', () => {
    const kept = ok(parseCharacterCard({ name: 'A', first_mes: 'Hi', alternate_greetings: ['B', 'C'] }, { now: NOW }));
    expect(kept.character.firstMessage).toBe('Hi');
    expect(kept.character.alternateGreetings).toEqual(['B', 'C']);
    const shifted = ok(parseCharacterCard({ name: 'A', first_mes: '  ', alternate_greetings: [7, 'B', null, 'C'] }, { now: NOW }));
    expect(shifted.character.firstMessage).toBe('B');
    expect(shifted.character.alternateGreetings).toEqual(['C']);
  });

  it('caps alternate greetings by count and by total size', () => {
    const many = ok(parseCharacterCard({ name: 'A', first_mes: 'Hi', alternate_greetings: Array.from({ length: 70 }, (_, i) => `g${i}`) }, { now: NOW }));
    expect(many.character.alternateGreetings).toHaveLength(SOUL_LIMITS.alternateGreetings);
    const big = ok(parseCharacterCard({ name: 'A', first_mes: 'Hi', alternate_greetings: Array.from({ length: 20 }, () => 'x'.repeat(30_000)) }, { now: NOW }));
    expect(big.character.alternateGreetings).toHaveLength(13);
    expect(big.meta.needsReview.filter(item => item.key === 'alternateGreetings')).toHaveLength(1);
    expect(paCharacterInputSchema.safeParse(big.character).success).toBe(true);
  });

  it('reads depth_prompt with numeric roles, clamps the depth and drops an empty prompt', () => {
    const numeric = ok(parseCharacterCard({ name: 'A', extensions: { depth_prompt: { prompt: 'note', depth: 2000, role: 1 } } }, { now: NOW }));
    expect(numeric.character.characterNote).toEqual({ text: 'note', depth: SOUL_LIMITS.noteDepth, role: 'user' });
    const empty = ok(parseCharacterCard({ name: 'A', extensions: { depth_prompt: { prompt: '  ', depth: 2 } } }, { now: NOW }));
    expect(empty.character.characterNote).toBeNull();
  });

  it('quarantines script-like extensions by name and keeps the rest', () => {
    const preview = ok(parseCharacterCard({
      spec: 'chara_card_v2',
      data: {
        name: 'A',
        description: 'Uses <% if (x) %> templates and <span>tags</span>.',
        extensions: { my_custom_js: 'x', iframeWidget: {}, QuickReply: [], quick_reply: {}, theme_hint: 'keep', risuai: { lowLevelAccess: true } },
      },
    }, { now: NOW }));
    expect(Object.keys(preview.meta.preserved.quarantine ?? {})).toEqual(['my_custom_js', 'iframeWidget', 'QuickReply', 'quick_reply', 'risuai']);
    expect(preview.meta.preserved.extensions).toEqual({ theme_hint: 'keep', risuai: {} });
    expect(preview.meta.needsReview).toContainEqual(expect.objectContaining({ key: 'description', kind: 'html', action: 'kept' }));
    expect(preview.meta.needsReview).toContainEqual(expect.objectContaining({ key: 'description', kind: 'script', action: 'kept' }));
    expect(preview.character.description).toBe('Uses <% if (x) %> templates and <span>tags</span>.');
  });

  it('keeps extension keys that only contain "script" inside an ordinary word', () => {
    const preview = ok(parseCharacterCard({
      name: 'A',
      extensions: {
        description_hint: 'keep', transcript: ['a', 'b'], SubscriptionTier: 'free', prescription: 'tea', manuscript_notes: 'n',
        regex_scripts: [], tavern_helper: {}, quick_reply: {}, custom_js: 'x', iframe: {}, iframe_embed: 'y',
      },
    }, { now: NOW }));
    expect(preview.meta.preserved.extensions).toEqual({
      description_hint: 'keep', transcript: ['a', 'b'], SubscriptionTier: 'free', prescription: 'tea', manuscript_notes: 'n',
    });
    const quarantined = ['regex_scripts', 'tavern_helper', 'quick_reply', 'custom_js', 'iframe', 'iframe_embed'];
    expect(Object.keys(preview.meta.preserved.quarantine ?? {})).toEqual(quarantined);
    expect(itemKeys(preview.meta.needsReview, 'quarantined')).toEqual(quarantined.map(key => `extensions.${key}`));
  });

  it('clips foreign key names in review items', () => {
    const long = `custom_script_${'x'.repeat(100000)}`;
    const preview = ok(parseCharacterCard({ name: 'A', extensions: { [long]: 'y' } }, { now: NOW }));
    const item = preview.meta.needsReview.find(entry => entry.action === 'quarantined')!;
    expect(item.key.length).toBeLessThanOrEqual(200);
    expect(item.summary.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(preview.meta.needsReview).length).toBeLessThan(2000);
  });

  it('suggests a portrait only for a small data: icon named main', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AAAAAAAABQABZHiVOAAAAABJRU5ErkJggg==';
    const card = (assets: unknown) => ok(parseCharacterCard({ spec: 'chara_card_v3', data: { name: 'A', assets } }, { now: NOW }));
    expect(card([{ type: 'icon', name: 'main', uri: `data:image/jpeg;base64,${png}` }]).portrait).toEqual({ mime: 'image/jpeg', data: png });
    expect(card([{ type: 'icon', name: 'main', uri: `data:image/gif;base64,${png}` }]).portrait).toBeNull();
    expect(card([{ type: 'icon', name: 'other', uri: `data:image/png;base64,${png}` }]).portrait).toBeNull();
    expect(card([{ type: 'icon', name: 'main', uri: 'https://example.com/a.png' }]).portrait).toBeNull();
    expect(card([{ type: 'icon', name: 'main', uri: 'data:image/png;base64,***' }]).portrait).toBeNull();
    const huge = `data:image/png;base64,${'A'.repeat(Math.ceil((SOUL_LIMITS.assetBytes * 4) / 3) + 8)}`;
    expect(card([{ type: 'icon', name: 'main', uri: huge }]).portrait).toBeNull();
    // The preserved copy of a large inline icon is replaced by a short marker.
    const big = card([{ type: 'icon', name: 'main', uri: `data:image/png;base64,${'A'.repeat(4_000)}` }]);
    expect(big.portrait?.data).toHaveLength(4_000);
    expect(big.meta.preserved.data?.assets).toEqual([{ type: 'icon', name: 'main', uri: '[data omitted, 4022 chars]' }]);
  });

  it('drops extensions.fantay parts that fail their schema, each on its own', () => {
    const confused = parse('type-confused.json');
    expect(confused.character).toMatchObject({
      tagline: '99', presetId: null, appearance: {}, stateSchema: [], decks: [], openers: ['Hi', 'Hello'],
    });
    expect(itemKeys(confused.meta.needsReview).filter(key => key.startsWith('extensions.fantay'))).toEqual([
      'extensions.fantay.appearance', 'extensions.fantay.stateSchema', 'extensions.fantay.decks',
    ]);
    const partial = ok(parseCharacterCard({
      name: 'A', extensions: { fantay: { appearance: { theme: 'rain' }, decks: [{ id: 'x', name: 'one card', cards: [{ title: 'a' }] }] } },
    }, { now: NOW }));
    expect(partial.character.appearance).toEqual({ theme: 'rain' });
    expect(partial.character.decks).toEqual([]);
  });

  it('coerces type-confused fields', () => {
    const preview = parse('type-confused.json');
    expect(preview.name).toBe('12345');
    expect(preview.character).toMatchObject({
      description: '', personality: 'true', scenario: '', firstMessage: '', exampleDialogue: '42', alternateGreetings: [],
      tags: ['a', 'b', 'c'], creator: '', characterVersion: '1.5', systemPrompt: 'false', nickname: '', talkativeness: 0.5,
      characterNote: { text: '7', depth: 4, role: 'system' },
    });
    expect(preview.lorebook).toBeNull();
    expect(preview.meta.preserved.data).toEqual({ assets: 'not a list' });
  });

  it('caps preserved data and reports what was dropped', () => {
    const blob = 'x'.repeat(90_000);
    const preview = ok(parseCharacterCard({
      spec: 'chara_card_v2', a: blob, b: blob, c: blob, data: { name: 'A', d: blob, extensions: { e: 'small' } },
    }, { now: NOW }));
    expect(JSON.stringify(preview.meta.preserved).length).toBeLessThanOrEqual(SOUL_LIMITS.preservedJson);
    expect(preview.meta.preserved.root).toEqual({ a: blob, b: blob });
    expect(preview.meta.preserved.extensions).toEqual({ e: 'small' });
    expect(itemKeys(preview.meta.needsReview, 'truncated')).toEqual(['root.c', 'data.d']);
  });
});

describe('parseCharacterCard: invariant', () => {
  const corpus = ['v1-flat.json', 'v2-st-export.json', 'v3-full.json', 'type-confused.json'].map(fixtureJson);
  corpus.push(JSON.parse(fixtureText('crlf-bom.json').slice(1)) as unknown);

  function check(value: unknown, failures: string[], label: string): void {
    const preview = parseCharacterCard(value, { now: NOW });
    if (!preview.ok) {
      if (preview.error !== 'not-object' && preview.error !== 'no-name') failures.push(`${label}: ${preview.error} ${preview.detail ?? ''}`);
      return;
    }
    if (!paCharacterInputSchema.safeParse(preview.character).success) failures.push(`${label}: character`);
    if (preview.lorebook !== null && !paLorebookInputSchema.safeParse(preview.lorebook).success) failures.push(`${label}: lorebook`);
    if (preview.meta.needsReview.length > SOUL_LIMITS.needsReview) failures.push(`${label}: needsReview`);
    if (JSON.stringify(preview.meta.preserved).length > SOUL_LIMITS.preservedJson) failures.push(`${label}: preserved`);
  }

  it('emits schema-valid input for the whole corpus', () => {
    const failures: string[] = [];
    corpus.forEach((card, index) => check(card, failures, `fixture ${index}`));
    expect(failures).toEqual([]);
  });

  it('never throws and stays schema-valid over 500 seeded mutations', () => {
    const rng = seededRng('soul-card-fuzz');
    const failures: string[] = [];
    let parsed = 0;
    for (let round = 0; round < 500; round += 1) {
      const value = mutate(corpus[round % corpus.length], rng);
      check(value, failures, `mutation ${round}`);
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch {
        text = undefined;
      }
      if (text !== undefined) {
        const preview = parseCardText(text, { now: NOW });
        if (preview.ok) parsed += 1;
        else if (preview.error === 'unsupported-format') failures.push(`text ${round}: ${preview.detail ?? ''}`);
      }
    }
    expect(failures).toEqual([]);
    expect(parsed).toBeGreaterThan(300);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('exportCharacterCard', () => {
  it('round-trips every mapped field, preserved data and decorators', () => {
    const first = parse('v3-full.json');
    const { character, lorebooks } = entities(first);
    const card = exportCharacterCard({ name: first.name, character, lorebooks, now: NOW + 5_000 });
    expect(card).toMatchObject({ spec: 'chara_card_v3', spec_version: '3.0' });
    const data = card.data as Record<string, unknown>;
    expect(data).toMatchObject({
      name: 'Mira', nickname: '小米', first_mes: first.character.firstMessage, creation_date: 1_700_000_000,
      modification_date: Math.floor((NOW + 5_000) / 1000), group_only_greetings: ['Everyone, the archive closes at nine.'],
    });
    const book = data.character_book as { entries: Array<Record<string, unknown>> };
    expect(book.entries[0]?.content).toBe('@@depth 2\n@@role assistant\n@@custom_marker keep me\nThe lighthouse keeper writes every Sunday.');

    const second = ok(parseCharacterCard(card, { now: NOW }));
    expect(second.format).toBe('ccv3');
    expect(second.name).toBe(first.name);
    expect(second.character).toEqual(first.character);
    expect(second.portrait).toEqual(first.portrait);
    const strip = (preview: OkPreview) => ({
      ...preview.lorebook,
      entries: preview.lorebook?.entries.map(entry => ({ ...entry, preserved: without(entry.preserved, 'use_regex') })),
    });
    expect(strip(second)).toEqual(strip(first));
    expect(second.lorebookMeta?.preserved).toEqual(first.lorebookMeta?.preserved);
    expect(without(second.meta.preserved.data, 'modification_date')).toEqual(without(first.meta.preserved.data, 'modification_date'));
    expect(second.meta.preserved.extensions).toEqual(first.meta.preserved.extensions);
    expect(second.meta.preserved.root).toEqual(first.meta.preserved.root);

    // One more trip is a fixed point.
    const again = entities(second);
    expect(exportCharacterCard({ name: second.name, ...again, now: NOW + 5_000 })).toEqual(card);
  });

  it('writes quarantined data only with includeQuarantined', () => {
    const first = parse('v3-full.json');
    const { character, lorebooks } = entities(first);
    const plain = exportCharacterCard({ name: first.name, character, lorebooks, now: NOW });
    const plainData = plain.data as Record<string, Record<string, unknown> | unknown[]>;
    expect(plainData.extensions).not.toHaveProperty('tavern_helper');
    expect((plainData.extensions as Record<string, unknown>).risuai).toEqual({ utilityBot: false });
    expect(plainData.assets).toHaveLength(1);
    const plainAgain = ok(parseCharacterCard(plain, { now: NOW }));
    expect(plainAgain.meta.preserved.quarantine).toBeUndefined();
    expect(itemKeys(plainAgain.meta.needsReview, 'quarantined')).toEqual([]);

    const full = exportCharacterCard({ name: first.name, character, lorebooks, now: NOW, includeQuarantined: true });
    const fullData = full.data as Record<string, Record<string, unknown> | unknown[]>;
    expect((fullData.extensions as Record<string, unknown>).risuai)
      .toEqual({ utilityBot: false, customScripts: [{ comment: 'swap', in: 'a', out: 'b' }], triggerscript: [] });
    expect(fullData.assets).toHaveLength(2);
    const fullAgain = ok(parseCharacterCard(full, { now: NOW }));
    expect(fullAgain.meta.preserved.quarantine).toEqual(first.meta.preserved.quarantine);
    expect(itemKeys(fullAgain.meta.needsReview, 'quarantined')).toEqual(itemKeys(first.meta.needsReview, 'quarantined'));
  });

  it('round-trips a V2 export and a V1 card', () => {
    for (const name of ['v2-st-export.json', 'v1-flat.json']) {
      const first = parse(name);
      const { character, lorebooks } = entities(first);
      const second = ok(parseCharacterCard(exportCharacterCard({ name: first.name, character, lorebooks, now: NOW, includeQuarantined: true }), { now: NOW }));
      expect(second.character, name).toEqual(first.character);
      expect(second.meta.preserved.root, name).toEqual(first.meta.preserved.root);
      expect(second.meta.preserved.extensions, name).toEqual(first.meta.preserved.extensions);
      expect(second.meta.preserved.quarantine, name).toEqual(first.meta.preserved.quarantine);
    }
  });

  it('writes the creation date from createdAt and only built-in preset ids', () => {
    const character: PaCharacter = {
      id: 'agent-2', createdAt: 1_650_000_123_456, updatedAt: 0, revision: 1,
      ...paCharacterInputSchema.parse({ presetId: 'my-own-preset' }),
      origin: null, preserved: {}, needsReview: [],
    };
    const card = exportCharacterCard({ name: 'B', character, lorebooks: [], now: NOW });
    const data = card.data as Record<string, unknown>;
    expect(data.creation_date).toBe(1_650_000_123);
    expect(data.character_book).toBeUndefined();
    expect(data).not.toHaveProperty('nickname');
    expect((data.extensions as { fantay: { presetId: unknown } }).fantay.presetId).toBeNull();
  });
});

describe('parseCharacterCard: embedded archive images (stage 2)', () => {
  const card = (assets: unknown) => ok(parseCharacterCard({ spec: 'chara_card_v3', data: { name: 'A', assets } }, { now: NOW }));
  const reviewSummaries = (preview: OkPreview) => preview.meta.needsReview.map(item => [item.key, item.summary]);

  it('plans the portrait and the emotion images for both spellings of the scheme', () => {
    const preview = card([
      { type: 'icon', uri: 'embeded://assets/icon/images/other.png', name: 'other' },
      { type: 'emotion', uri: 'embeded://assets/emotion/happy.png', name: 'happy' },
      { type: 'ICON', uri: 'EMBEDDED:///assets/icon/images/main.png', name: 'main' },
      { type: 'emotion', uri: 'embedded://assets/emotion/sad_2.webp', name: 'Sad_2' },
      { type: 'emotion', uri: 'ccdefault:', name: 'angry' },
      { type: 'icon', uri: 'ccdefault:', name: 'main' },
    ]);
    expect(preview.embedded).toEqual([
      { index: 2, role: 'portrait', path: 'assets/icon/images/main.png', name: 'main' },
      { index: 1, role: 'sprite', emotion: 'happy', path: 'assets/emotion/happy.png', name: 'happy' },
      { index: 3, role: 'sprite', emotion: 'sad', path: 'assets/emotion/sad_2.webp', name: 'Sad_2' },
    ]);
    expect(reviewSummaries(preview)).toEqual([['data.assets.0', 'asset other (icon) is not imported']]);
    expect(preview.character.sprites).toEqual({});
    expect(preview.character.voice).toBeNull();
    // Embedded assets stay in the preserved local assets like any other non-remote asset.
    expect((preview.meta.preserved.data?.assets as unknown[]).length).toBe(6);
  });

  it('takes the first icon when none is named main', () => {
    const preview = card([
      { type: 'icon', uri: 'embeded://a.png', name: 'first' },
      { type: 'icon', uri: 'embeded://b.png', name: 'second' },
    ]);
    expect(preview.embedded).toEqual([{ index: 0, role: 'portrait', path: 'a.png', name: 'first' }]);
    expect(reviewSummaries(preview)).toEqual([['data.assets.1', 'asset second (icon) is not imported']]);
  });

  it('lets an inline data: portrait win over an embedded icon', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AAAAAAAABQABZHiVOAAAAABJRU5ErkJggg==';
    const preview = card([
      { type: 'icon', uri: 'embeded://assets/main.png', name: 'main' },
      { type: 'icon', uri: `data:image/png;base64,${png}`, name: 'main' },
    ]);
    expect(preview.portrait).toEqual({ mime: 'image/png', data: png });
    expect(preview.embedded).toEqual([]);
    expect(reviewSummaries(preview)).toEqual([['data.assets.0', 'asset main (icon) is not imported']]);
  });

  it('reviews repeated and unknown emotions, other asset types and unsafe paths', () => {
    const preview = card([
      { type: 'emotion', uri: 'embeded://e/joy.png', name: 'joy' },
      { type: 'emotion', uri: 'embeded://e/happy.png', name: 'happy' },
      { type: 'emotion', uri: 'embeded://e/xyz.png', name: 'xyz' },
      { type: 'emotion', uri: 'embeded://e/none.png' },
      { type: 'background', uri: 'embeded://bg/room.png', name: 'room' },
      { type: 'emotion', uri: 'embeded://../../etc/happy.png', name: 'sad' },
      { type: 'emotion', uri: 'embeded://e\\angry.png', name: 'angry' },
      { type: 'x-risu-asset', uri: 'embeded://e/a.png', name: 'n'.repeat(100) },
      'not an asset',
    ]);
    expect(preview.embedded).toEqual([{ index: 0, role: 'sprite', emotion: 'happy', path: 'e/joy.png', name: 'joy' }]);
    expect(reviewSummaries(preview)).toEqual([
      ['data.assets.5', 'asset sad has an unsafe path; it is not imported'],
      ['data.assets.6', 'asset angry has an unsafe path; it is not imported'],
      ['data.assets.1', 'emotion image happy repeats happy; it is not imported'],
      ['data.assets.2', 'emotion image xyz matches no mood; it is not imported'],
      ['data.assets.3', 'emotion image 3 matches no mood; it is not imported'],
      ['data.assets.4', 'asset room (background) is not imported'],
      ['data.assets.7', `asset ${'n'.repeat(60)} (x-risu-asset) is not imported`],
    ]);
  });

  it('answers an empty plan for cards without embedded assets', () => {
    expect(parse('v3-full.json').embedded).toEqual([]);
    expect(parse('v1-flat.json').embedded).toEqual([]);
    expect(card('not a list').embedded).toEqual([]);
  });
});
