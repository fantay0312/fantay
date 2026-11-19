import { describe, expect, it } from 'vitest';
import {
  SOUL_LIMITS,
  exportCharacterBook,
  exportWorldInfo,
  importWorldInfo,
  mapCharacterBook,
  mapLoreEntry,
  paLoreEntrySchema,
  paLorebookInputSchema,
  parseWorldText,
  seededRng,
} from '../../src/soul/index';
import type {
  PaLoreEntry,
  PaLorebook,
  PaLorebookDoc,
  PaLorebookImportMeta,
  PaNeedsReviewItem,
  PaWorldImportPreview,
  WorldImportOptions,
} from '../../src/soul/index';
import { fixtureJson, mutate } from './fixtures/fuzz';

type OkWorld = Extract<PaWorldImportPreview, { ok: true }>;

function importOk(json: unknown, options?: WorldImportOptions): OkWorld {
  const preview = importWorldInfo(json, options);
  if (!preview.ok) throw new Error(`world did not import: ${preview.error} ${preview.detail ?? ''}`);
  return preview;
}

function collector() {
  const items: PaNeedsReviewItem[] = [];
  return { items, sink: (item: PaNeedsReviewItem) => { items.push(item); } };
}

function entity(lorebook: PaLorebookDoc, meta: PaLorebookImportMeta, id = 'lb-1'): PaLorebook {
  return { id, createdAt: 1, updatedAt: 1, revision: 1, ...lorebook, ...meta };
}

function without(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

function harbor(): OkWorld {
  return importOk(fixtureJson('st-world.json'), { fileName: 'worlds/harbor-lore.json' });
}

describe('importWorldInfo: SillyTavern world entries', () => {
  it('reads every entry in file order with regenerated ids and book defaults', () => {
    const preview = harbor();
    expect(preview.name).toBe('harbor-lore');
    expect(preview.lorebook).toMatchObject({
      name: 'harbor-lore', scanDepth: 4, tokenBudget: SOUL_LIMITS.loreImportBudgetFloor, recursive: true,
      caseSensitive: false, matchWholeWords: true, global: false,
    });
    expect(preview.meta.origin).toEqual({ format: 'st-world', name: 'worlds/harbor-lore.json' });
    expect(preview.meta.preserved).toEqual({});
    const entries = preview.lorebook.entries;
    expect(entries.map(entry => entry.id)).toEqual(Array.from({ length: 13 }, (_, index) => `e${index + 1}`));
    expect(entries.map(entry => entry.preserved.uid)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(entries[0]).toMatchObject({
      title: 'Harbor', keys: ['harbor', 'port'], content: 'The harbor smells of tar.', enabled: true, order: 100,
      logic: 'and_any', groups: [], scanDepth: null, caseSensitive: null, matchWholeWords: null,
      preserved: { uid: 0, position: 0, displayIndex: 0, addMemo: true },
    });
    expect(entries[1]).toMatchObject({ secondaryKeys: ['night'], logic: 'not_all', order: 50 });
    expect(paLorebookInputSchema.safeParse(preview.lorebook).success).toBe(true);
  });

  it('maps positions 0 to 7', () => {
    const entries = harbor().lorebook.entries;
    const pick = (entry: PaLoreEntry | undefined) => entry && ({
      position: entry.position, depth: entry.depth, role: entry.role, enabled: entry.enabled, number: entry.preserved.position,
    });
    expect(entries.slice(0, 8).map(pick)).toEqual([
      { position: 'before_char', depth: 4, role: 'system', enabled: true, number: 0 },
      { position: 'after_char', depth: 4, role: 'system', enabled: true, number: 1 },
      { position: 'at_depth', depth: 4, role: 'system', enabled: true, number: 2 },     // depth 9 and role 2 are overridden
      { position: 'at_depth', depth: 4, role: 'system', enabled: true, number: 3 },
      { position: 'at_depth', depth: 2, role: 'user', enabled: true, number: 4 },
      { position: 'after_char', depth: 4, role: 'system', enabled: true, number: 5 },
      { position: 'after_char', depth: 4, role: 'system', enabled: true, number: 6 },
      { position: 'before_char', depth: 4, role: 'system', enabled: false, number: 7 }, // outlet
    ]);
    expect(entries[7]?.preserved.outletName).toBe('ledger');
  });

  it('inverts disable, splits comma groups and coerces string numbers', () => {
    const entries = harbor().lorebook.entries;
    expect(entries[10]).toMatchObject({
      enabled: false, groups: ['Weather', 'Night'], groupOverride: true, groupWeight: 50, probability: 30, sticky: 0,
      cooldown: 2, delay: 1, recursionOnly: true, scanDepth: 6, excludeRecursion: true, preventRecursion: true, ignoreBudget: true,
      preserved: { uid: 10, position: 0, vectorized: true },
    });
    expect(entries[11]).toMatchObject({ keys: [], probability: 100, constant: true });
    expect(entries[12]).toMatchObject({
      keys: ['rope', 'knot'], role: 'assistant', scanDepth: 2, enabled: false, content: 'Rope knots tell stories.',
      preserved: { uid: 12, position: 0, decorators: ['@@scan_depth 2', '@@dont_activate'] },
    });
  });

  it('reports outlets, risky keys, template entries and keyless vector entries', () => {
    const preview = harbor();
    expect(preview.lorebook.entries[8]).toMatchObject({
      keys: ['/harbou?r master/i', '码头，灯塔', '/(a+)+$/'], caseSensitive: true, matchWholeWords: false, enabled: true,
    });
    expect(preview.lorebook.entries[9]?.enabled).toBe(false);
    expect(preview.meta.needsReview.map(({ key, kind, action }) => ({ key, kind, action }))).toEqual([
      { key: 'entries.e8.position', kind: 'other', action: 'disabled' },
      { key: 'entries.e9.keys', kind: 'other', action: 'kept' },
      { key: 'entries.e9.keys', kind: 'regex', action: 'kept' },
      { key: 'entries.e10.content', kind: 'script', action: 'disabled' },
      { key: 'entries.e12.keys', kind: 'other', action: 'kept' },
    ]);
    expect(preview.meta.needsReview[1]?.summary).toContain('may never match');
  });
});

describe('mapLoreEntry', () => {
  it('reads card-style entries with extension overrides first', () => {
    const { items, sink } = collector();
    const entry = mapLoreEntry({
      keys: 'alpha, beta', secondary_keys: ['gamma'], comment: '', name: 'Named', content: 'Text', enabled: 'false', constant: 1,
      insertion_order: '42', position: 'after_char', case_sensitive: false, priority: 3, use_regex: true,
      extensions: {
        position: '4', depth: '3', role: 'user', case_sensitive: true, selectiveLogic: '2', useProbability: false, probability: 5,
        group: ['g1', 'g1', 'G2'], unknown_flag: 'x',
      },
    }, 4, sink);
    expect(entry).toMatchObject({
      id: 'e5', keys: ['alpha', 'beta'], secondaryKeys: ['gamma'], title: 'Named', content: 'Text', enabled: false, constant: true,
      order: 42, position: 'at_depth', depth: 3, role: 'user', caseSensitive: true, logic: 'not_any', probability: 100,
      groups: ['g1', 'G2'],
    });
    expect(entry.preserved).toEqual({ position: 4, priority: 3, use_regex: true, extensions: { unknown_flag: 'x' } });
    expect(items).toEqual([]);
    expect(paLoreEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('falls back to the top-level position and case flag of a card entry', () => {
    const entry = mapLoreEntry({ keys: ['a'], position: 'after_char', case_sensitive: false, extensions: { position: 'x' } }, 0, () => {});
    expect(entry).toMatchObject({ position: 'after_char', caseSensitive: false });
    expect(entry.preserved).toEqual({});
  });

  it('applies the eight decorators and keeps the raw lines', () => {
    const content = [
      '@@depth 7', '@@role user', '@@scan_depth 3', '@@activate', '@@dont_activate', '@@activate_only_after 2',
      '@@additional_keys extra, k ,more', '@@unknown_thing 5', '@@@depth 1', 'Body line', '@@depth 1 stays in the body',
    ].join('\n');
    const entry = mapLoreEntry({ keys: ['k'], content }, 0, () => {});
    expect(entry).toMatchObject({
      position: 'at_depth', depth: 7, role: 'user', scanDepth: 3, constant: true, enabled: false, delay: 4,
      keys: ['k', 'extra', 'more'], content: 'Body line\n@@depth 1 stays in the body',
    });
    expect(entry.preserved.decorators).toEqual(content.split('\n').slice(0, 9));

    expect(mapLoreEntry({ keys: ['k'], content: '@@position after_desc\nx' }, 0, () => {}).position).toBe('after_char');
    expect(mapLoreEntry({ keys: ['k'], content: '@@position before_desc\nx', position: 'after_char' }, 0, () => {}).position)
      .toBe('before_char');
    const ignored = mapLoreEntry({ keys: ['k'], content: '@@depth soon\n@@role narrator\nx' }, 0, () => {});
    expect(ignored).toMatchObject({ position: 'before_char', depth: 4, role: 'system', content: 'x' });
    expect(mapLoreEntry({ keys: ['k'], content: '@@depth 5000\nx' }, 0, () => {}).depth).toBe(SOUL_LIMITS.loreDepth);
  });

  it('disables entries that are mostly template or command code', () => {
    const { items, sink } = collector();
    const mostly = mapLoreEntry({ keys: ['k'], content: 'intro\n<UpdateVariable>\n_.set("a", 1)\n</UpdateVariable>' }, 0, sink);
    expect(mostly.enabled).toBe(false);
    const prose = mapLoreEntry({ keys: ['k'], content: 'Once, the tower said 50% of nothing.\nAnother line.\nA third <% line.' }, 1, sink);
    expect(prose.enabled).toBe(true);
    expect(items).toEqual([expect.objectContaining({ key: 'entries.e1.content', kind: 'script', action: 'disabled' })]);
  });

  it('turns any value into a schema-valid entry', () => {
    for (const raw of [null, 'text', 42, [], { keys: 5, content: { a: 1 }, order: 1e300, depth: -5, probability: 900, extensions: [] }]) {
      expect(paLoreEntrySchema.safeParse(mapLoreEntry(raw, 0, () => {})).success).toBe(true);
    }
  });
});

describe('importWorldInfo: shapes and limits', () => {
  it('rejects other formats and non-objects', () => {
    expect(importWorldInfo({ lorebookVersion: 1, entries: [] })).toEqual({ ok: false, error: 'unsupported-format', detail: 'NovelAI lorebook' });
    expect(importWorldInfo({ kind: 'memory', name: 'm', entries: [] })).toMatchObject({ error: 'unsupported-format', detail: 'Agnai memory book' });
    expect(importWorldInfo({ type: 'risu', data: [] })).toMatchObject({ error: 'unsupported-format', detail: 'RisuAI lorebook' });
    expect(importWorldInfo({ spec: 'chara_card_v2', data: {} })).toMatchObject({ error: 'unsupported-format', detail: 'character card' });
    expect(importWorldInfo({ name: 'no entries' })).toMatchObject({ error: 'unsupported-format', detail: 'no entries' });
    expect(importWorldInfo({ spec: 'lorebook_v3', data: 5 })).toMatchObject({ error: 'unsupported-format' });
    for (const value of [null, [], 'world', 3, undefined]) expect(importWorldInfo(value)).toEqual({ ok: false, error: 'not-object' });
    expect(parseWorldText('{"entries": ')).toMatchObject({ ok: false, error: 'bad-json' });
    expect(parseWorldText(' '.repeat(SOUL_LIMITS.cardTextChars + 1))).toMatchObject({ ok: false, error: 'too-large' });
  });

  it('accepts a bare character_book, a lorebook_v3 wrapper and a BOM', () => {
    const book = { name: 'Wrapped', scan_depth: 7, token_budget: 20_000, recursive_scanning: false, extensions: { x: 1 }, entries: [{ keys: ['a'], content: 'A' }] };
    const wrapped = importOk({ spec: 'lorebook_v3', data: book });
    expect(wrapped.lorebook).toMatchObject({ name: 'Wrapped', scanDepth: 7, tokenBudget: 20_000, recursive: false });
    expect(wrapped.meta).toMatchObject({ origin: { format: 'st-world', name: 'Wrapped' }, preserved: { extensions: { x: 1 } } });
    expect(importOk(book, { name: '  Override  ' }).name).toBe('Override');
    expect(importOk({ entries: [] }).name).toBe('世界书');
    expect(importOk({ ...book, token_budget: 100 }).lorebook.tokenBudget).toBe(SOUL_LIMITS.loreImportBudgetFloor);
    expect(importOk({ ...book, token_budget: 1e9 }).lorebook.tokenBudget).toBe(SOUL_LIMITS.loreBudgetMax);
    const text = parseWorldText(`﻿${JSON.stringify(book)}`, { fileName: 'w.json' });
    expect(text).toMatchObject({ ok: true, name: 'Wrapped', meta: { origin: { name: 'w.json' } } });
  });

  it('regenerates ids, keeps the original uid and skips non-object entries', () => {
    const preview = importOk({ entries: [{ uid: 'abc', key: ['a'] }, { uid: 99, key: ['b'] }, 'junk', { id: 'x/y', keys: ['c'] }] });
    expect(preview.lorebook.entries.map(entry => [entry.id, entry.preserved.uid])).toEqual([['e1', 'abc'], ['e2', 99], ['e3', 'x/y']]);
    expect(preview.meta.needsReview).toEqual([expect.objectContaining({ key: 'entries', action: 'truncated' })]);
    const map = importOk({ entries: { b: { key: ['b'] }, 10: { key: ['ten'] }, 2: { key: ['two'] }, a: { key: ['a'] } } });
    expect(map.lorebook.entries.map(entry => entry.keys[0])).toEqual(['two', 'ten', 'b', 'a']);
  });

  it('imports a generated 1000-entry book and enforces the entry and content totals', () => {
    const generated = (count: number, content: (index: number) => string) => ({
      entries: Object.fromEntries(Array.from({ length: count }, (_, index) => [
        String(index), { uid: index, key: [`k${index}`], content: content(index), position: index % 8, order: index },
      ])),
    });
    const full = importOk(generated(1000, index => `entry ${index}`));
    expect(full.lorebook.entries).toHaveLength(SOUL_LIMITS.loreEntries);
    expect(full.lorebook.entries[999]?.id).toBe('e1000');
    expect(paLorebookInputSchema.safeParse(full.lorebook).success).toBe(true);

    const over = importOk(generated(1005, index => `entry ${index}`));
    expect(over.lorebook.entries).toHaveLength(SOUL_LIMITS.loreEntries);
    expect(over.meta.needsReview.filter(item => item.key === 'entries')).toEqual([
      expect.objectContaining({ action: 'truncated', summary: expect.stringContaining('5 entries') }),
    ]);

    const heavy = importOk(generated(70, () => 'x'.repeat(SOUL_LIMITS.loreContent)));
    expect(heavy.lorebook.entries).toHaveLength(62);
    expect(heavy.meta.needsReview.filter(item => item.key === 'entries')).toEqual([
      expect.objectContaining({ summary: expect.stringContaining('8 entries dropped') }),
    ]);
    expect(paLorebookInputSchema.safeParse(heavy.lorebook).success).toBe(true);
  });

  it('caps the report and says how many items were dropped', () => {
    const preview = importOk({ entries: Array.from({ length: 300 }, () => ({ key: ['/(a+)+$/'] })) });
    expect(preview.meta.needsReview).toHaveLength(SOUL_LIMITS.needsReview);
    expect(preview.meta.needsReview[SOUL_LIMITS.needsReview - 1]).toEqual({
      key: 'needsReview', kind: 'other', action: 'truncated', summary: '101 more items were not listed',
    });
  });
});

describe('world export', () => {
  it('round-trips a world file through exportWorldInfo', () => {
    const first = harbor();
    const file = exportWorldInfo(entity(first.lorebook, first.meta));
    const entries = file.entries as Record<string, Record<string, unknown>>;
    expect(Object.keys(file)).toEqual(['entries']);
    expect(Object.keys(entries)).toEqual(Array.from({ length: 13 }, (_, index) => String(index)));
    expect(entries['7']).toMatchObject({
      uid: 7, key: ['ledger'], keysecondary: [], comment: 'Outlet', position: 7, disable: true, depth: 4, role: 0,
      useProbability: true, outletName: 'ledger',
    });
    expect(entries['2']).toMatchObject({ position: 2, depth: 4, role: 0 });
    expect(entries['10']).toMatchObject({ group: 'Weather,Night', groupWeight: 50, delayUntilRecursion: true, scanDepth: 6, vectorized: true });
    expect(entries['12']?.content).toBe('@@scan_depth 2\n@@dont_activate\nRope knots tell stories.');
    expect(entries['0']).not.toHaveProperty('decorators');

    const second = importOk(file, { fileName: 'worlds/harbor-lore.json' });
    expect(second.lorebook.entries).toEqual(first.lorebook.entries);
    expect(second.meta.needsReview).toEqual(first.meta.needsReview);
  });

  it('writes back only the interpreted decorators the entry still agrees with', () => {
    const entry = mapLoreEntry({ keys: ['k'], content: '@@depth 2\n@@activate\n@@custom x\nBody' }, 0, () => {});
    const edited: PaLoreEntry = { ...entry, position: 'before_char', constant: true };
    const book = entity(paLorebookInputSchema.parse({ name: 'B', entries: [edited] }), { origin: null, preserved: {}, needsReview: [] });
    const exported = (exportWorldInfo(book).entries as Record<string, { content: string }>)['0'];
    expect(exported?.content).toBe('@@activate\n@@custom x\nBody');
    const again = importOk(exportWorldInfo(book)).lorebook.entries[0];
    expect(again).toMatchObject({ position: 'before_char', constant: true, content: 'Body' });
  });

  it('merges books into one character_book written in both forms and round-trips it', () => {
    const first = harbor();
    const second = paLorebookInputSchema.parse({
      name: 'Second', scanDepth: 9, tokenBudget: 12_000, recursive: false,
      entries: [{ id: 'z', keys: ['zeta'], content: 'Z', position: 'at_depth', depth: 1, role: 'user' }],
    });
    const books = [
      entity(first.lorebook, first.meta),
      entity(second, { origin: null, preserved: {}, needsReview: [] }, 'lb-2'),
    ];
    const card = exportCharacterBook(books);
    expect(card).toMatchObject({ name: 'harbor-lore', scan_depth: 9, token_budget: 12_000, recursive_scanning: true, extensions: {} });
    const entries = (card?.entries ?? []) as Array<Record<string, unknown>>;
    expect(entries.map(entry => entry.id)).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
    expect(entries[7]).toMatchObject({
      keys: ['ledger'], secondary_keys: [], selective: true, constant: false, enabled: false, insertion_order: 100,
      position: 'before_char', comment: 'Outlet', name: 'Outlet', content: 'The ledger lists every ship.', id: 8, use_regex: false,
      outletName: 'ledger',
      extensions: {
        position: 7, depth: 4, role: 0, selectiveLogic: 0, probability: 100, useProbability: true, group: '', group_override: false,
        group_weight: 100, sticky: 0, cooldown: 0, delay: 0, exclude_recursion: false, prevent_recursion: false,
        delay_until_recursion: false, scan_depth: null, case_sensitive: null, match_whole_words: null, ignore_budget: false,
      },
    });
    expect(entries[7]).not.toHaveProperty('case_sensitive');
    expect(entries[8]).toMatchObject({ use_regex: true, case_sensitive: true, extensions: { case_sensitive: true, match_whole_words: false } });
    expect(entries[4]).toMatchObject({ position: 'before_char', extensions: { position: 4, depth: 2, role: 1 } });
    expect(entries[13]).toMatchObject({ position: 'before_char', extensions: { position: 4, depth: 1, role: 1 } });

    const { sink } = collector();
    const mapped = mapCharacterBook(card, 'Harbor', sink);
    expect(mapped?.lorebook).toMatchObject({ name: 'harbor-lore', scanDepth: 9, tokenBudget: 12_000, recursive: true });
    expect(mapped?.meta.origin).toEqual({ format: 'card', name: 'Harbor' });
    const original = books.flatMap(book => book.entries);
    const strip = (entry: PaLoreEntry) => ({ ...entry, id: '', preserved: without(entry.preserved, 'uid', 'use_regex', 'position') });
    expect(mapped?.lorebook.entries.map(strip)).toEqual(original.map(strip));
    expect(mapped?.lorebook.entries.slice(0, 13).map(entry => entry.preserved.position))
      .toEqual(original.slice(0, 13).map(entry => entry.preserved.position));
    expect(mapped?.lorebook.entries[13]?.preserved).toEqual({ uid: 14, position: 4, use_regex: false });
  });

  it('returns null when there is nothing to export or import', () => {
    expect(exportCharacterBook([])).toBeNull();
    const empty = entity(paLorebookInputSchema.parse({ name: 'Empty' }), { origin: null, preserved: {}, needsReview: [] });
    expect(exportCharacterBook([empty])).toBeNull();
    expect(mapCharacterBook({ entries: [] }, 'A', () => {})).toBeNull();
    expect(mapCharacterBook('book', 'A', () => {})).toBeNull();
    expect(mapCharacterBook({ entries: [{ keys: ['a'] }] }, 'Ada', () => {})?.lorebook.name).toBe('Ada 世界书');
  });
});

describe('importWorldInfo: invariant', () => {
  it('never throws and stays schema-valid over the corpus and 500 seeded mutations', () => {
    const v3 = fixtureJson('v3-full.json') as { data: { character_book: unknown } };
    const corpus: unknown[] = [
      fixtureJson('st-world.json'),
      v3.data.character_book,
      { spec: 'lorebook_v3', data: v3.data.character_book },
      { entries: Array.from({ length: 30 }, (_, index) => ({ uid: index, key: [`k${index}`, '/k\\d+/i'], content: `@@depth ${index}\nentry` })) },
    ];
    const rng = seededRng('soul-world-fuzz');
    const failures: string[] = [];
    let imported = 0;
    const check = (preview: PaWorldImportPreview, label: string) => {
      if (preview.ok) {
        imported += 1;
        if (!paLorebookInputSchema.safeParse(preview.lorebook).success) failures.push(`${label}: lorebook`);
        if (preview.meta.needsReview.length > SOUL_LIMITS.needsReview) failures.push(`${label}: needsReview`);
      } else if (preview.detail === 'unreadable world book' || preview.detail === 'world book could not be mapped') {
        failures.push(`${label}: ${preview.detail}`);
      }
    };
    corpus.forEach((value, index) => check(importWorldInfo(value), `fixture ${index}`));
    for (let round = 0; round < 500; round += 1) {
      const value = mutate(corpus[round % corpus.length], rng);
      check(importWorldInfo(value, { fileName: 'fuzz.json' }), `mutation ${round}`);
      const mapped = mapCharacterBook(value, 'Fuzz', () => {});
      if (mapped !== null && !paLorebookInputSchema.safeParse(mapped.lorebook).success) failures.push(`book ${round}`);
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch {
        text = undefined;
      }
      if (text !== undefined) check(parseWorldText(text), `text ${round}`);
    }
    expect(failures).toEqual([]);
    expect(imported).toBeGreaterThan(600);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
