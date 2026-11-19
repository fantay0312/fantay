import { describe, expect, it } from 'vitest';
import { activateLore, paLorebookInputSchema, seededRng } from '../../src/soul/index';
import type {
  ActivateLoreInput, ActivateLoreResult, LoreBookLike, PaLoreEntry, PaLoreTimer, PaSoulTraceLore,
} from '../../src/soul/index';

type EntryInput = Partial<PaLoreEntry> & { id: string };

function book(id: string, entries: EntryInput[], settings: Record<string, unknown> = {}): LoreBookLike {
  const doc = paLorebookInputSchema.parse({ name: `book ${id}`, entries, ...settings });
  return {
    id, name: doc.name, scanDepth: doc.scanDepth, tokenBudget: doc.tokenBudget, recursive: doc.recursive,
    caseSensitive: doc.caseSensitive, matchWholeWords: doc.matchWholeWords, entries: doc.entries,
  };
}

function run(books: readonly LoreBookLike[], over: Partial<ActivateLoreInput> = {}): ActivateLoreResult {
  return activateLore({
    books: books.map(item => ({ book: item, rank: 1 as const })),
    disabled: new Set(), messages: [], extraScan: [], index: 10, timers: {},
    names: { char: '小月', user: '阿青' }, rng: seededRng('lore'),
    ...over,
  });
}

const ids = (result: ActivateLoreResult) => result.included.map(entry => entry.entryId);
const traceOf = (result: ActivateLoreResult, entryId: string): PaSoulTraceLore => {
  const found = result.trace.find(item => item.entryId === entryId);
  if (!found) throw new Error(`no trace for ${entryId}`);
  return found;
};

describe('activateLore: matching', () => {
  it('inserts names literally: $ patterns in a name never expand', () => {
    const key = '{{char}}'.repeat(50);
    const result = run([book('b', [{ id: 'e', keys: [key], content: 'x' }])], {
      names: { char: "$'".repeat(50), user: '$&' }, messages: ["$'".repeat(2500)],
    });
    expect(ids(result)).toEqual(['e']);
    expect(traceOf(result, 'e').reason).toMatchObject({ code: 'key' });
    expect((traceOf(result, 'e').reason as { key: string }).key.length).toBeLessThanOrEqual(400);
    const user = run([book('b', [{ id: 'u', keys: ['{{user}}'], content: 'y' }])], { names: { char: '', user: '$&' }, messages: ['hi $&'] });
    expect(ids(user)).toEqual(['u']);
  });

  it('matches CJK keys as substrings', () => {
    const result = run([book('b', [{ id: 'e1', keys: ['灯塔'], content: '海边有座灯塔。' }])], { messages: ['我们去看那座灯塔吧'] });
    expect(ids(result)).toEqual(['e1']);
    expect(traceOf(result, 'e1').reason).toEqual({ code: 'key', key: '灯塔' });
  });

  it('applies whole-word matching to ASCII keys only', () => {
    const entries: EntryInput[] = [
      { id: 'word', keys: ['cat'], content: 'word' },
      { id: 'mixed', keys: ['cat猫'], content: 'mixed' },
    ];
    expect(ids(run([book('b', entries)], { messages: ['concatenate xcat猫x'] }))).toEqual(['mixed']);
    expect(ids(run([book('b', entries)], { messages: ['a cat!'] }))).toEqual(['word']);
    expect(ids(run([book('b', entries, { matchWholeWords: false })], { messages: ['concatenate'] }))).toEqual(['word']);
    const override = [{ id: 'word', keys: ['cat'], content: 'word', matchWholeWords: false }];
    expect(ids(run([book('b', override)], { messages: ['concatenate'] }))).toEqual(['word']);
  });

  it('folds case and width unless the entry is case-sensitive', () => {
    const entries: EntryInput[] = [
      { id: 'folded', keys: ['Lighthouse'], content: 'a' },
      { id: 'strict', keys: ['Lighthouse'], content: 'b', caseSensitive: true },
      { id: 'width', keys: ['abc'], content: 'c' },
    ];
    expect(ids(run([book('b', entries)], { messages: ['THE LIGHTHOUSE and ＡＢＣ'] }))).toEqual(['folded', 'width']);
    expect(ids(run([book('b', entries)], { messages: ['the Lighthouse'] }))).toEqual(['folded', 'strict']);
  });

  it('replaces {{char}} and {{user}} inside text keys and scans the extra strings', () => {
    const entries: EntryInput[] = [{ id: 'e1', keys: ['{{char}}的秘密'], content: 'x' }, { id: 'e2', keys: ['便签词'], content: 'y' }];
    expect(ids(run([book('b', entries)], { messages: ['那是小月的秘密'] }))).toEqual(['e1']);
    expect(ids(run([book('b', entries)], { messages: ['无关'], extraScan: ['这是便签词'] }))).toEqual(['e2']);
    expect(ids(run([book('b', entries, { scanDepth: 0 })], { messages: ['小月的秘密'], extraScan: ['便签词'] }))).toEqual([]);
  });

  it('scans only the newest scanDepth messages', () => {
    const entries: EntryInput[] = [{ id: 'old', keys: ['旧事'], content: 'x' }, { id: 'deep', keys: ['旧事'], content: 'y', scanDepth: 3 }];
    const result = run([book('b', entries, { scanDepth: 2 })], { messages: ['新', '新', '提起旧事'] });
    expect(ids(result)).toEqual(['deep']);
    expect(traceOf(result, 'old')).toMatchObject({ status: 'inactive', reason: { code: 'no-key' } });
  });

  it('applies the four secondary logics and ignores secondary keys when selective is off', () => {
    const entry = (logic: PaLoreEntry['logic'], selective = true): EntryInput =>
      ({ id: 'e', keys: ['门'], secondaryKeys: ['钥匙', '锁'], logic, selective, content: 'x' });
    const hit = (logic: PaLoreEntry['logic'], message: string, selective = true) =>
      ids(run([book('b', [entry(logic, selective)])], { messages: [message] })).length === 1;
    expect([hit('and_any', '门和钥匙'), hit('and_all', '门和钥匙'), hit('not_any', '门和钥匙'), hit('not_all', '门和钥匙')])
      .toEqual([true, false, false, true]);
    expect([hit('and_any', '门钥匙锁'), hit('and_all', '门钥匙锁'), hit('not_any', '门钥匙锁'), hit('not_all', '门钥匙锁')])
      .toEqual([true, true, false, false]);
    expect([hit('and_any', '门'), hit('and_all', '门'), hit('not_any', '门'), hit('not_all', '门')])
      .toEqual([false, false, true, true]);
    expect(hit('and_all', '门', false)).toBe(true);
    expect(hit('and_all', '钥匙和锁', false)).toBe(false);
  });
});

describe('activateLore: gates and timers', () => {
  it('gates every entry once, first hit wins, constants included', () => {
    const entries: EntryInput[] = [
      { id: 'off', constant: true, enabled: false, delay: 50, content: 'x' },
      { id: 'listed', constant: true, content: 'x' },
      { id: 'blank', constant: true, content: '   ' },
      { id: 'late', constant: true, delay: 11, content: 'x' },
      { id: 'cool', constant: true, content: 'x' },
      { id: 'ok', constant: true, delay: 10, content: 'x' },
    ];
    const timers: Record<string, PaLoreTimer> = { 'b:cool': { at: 4, stickyEnd: 4, cooldownEnd: 12 } };
    const result = run([book('b', entries)], { disabled: new Set(['b:listed']), timers });
    expect(result.trace.map(item => [item.entryId, item.status, item.reason.code])).toEqual([
      ['off', 'disabled', 'disabled'],
      ['listed', 'disabled', 'disabled'],
      ['blank', 'inactive', 'empty'],
      ['late', 'inactive', 'delay'],
      ['cool', 'cooldown', 'cooldown'],
      ['ok', 'included', 'constant'],
    ]);
    expect(result.timers).toEqual(timers);
  });

  it('runs sticky and cooldown over a sequence of indexes', () => {
    const books = [book('b', [{ id: 'e', keys: ['火'], content: 'fire', sticky: 2, cooldown: 2 }])];
    let timers: Record<string, PaLoreTimer> = {};
    const steps: Array<[number, string, string]> = [];
    const script: Array<[number, string]> = [[1, '点火'], [2, '无'], [3, '无'], [4, '又点火'], [5, '再点火'], [6, '无']];
    for (const [index, message] of script) {
      const result = run(books, { index, messages: [message], timers });
      const item = traceOf(result, 'e');
      steps.push([index, item.status, item.reason.code]);
      timers = result.timers;
    }
    expect(steps).toEqual([
      [1, 'included', 'key'],
      [2, 'included', 'sticky'],
      [3, 'cooldown', 'cooldown'],
      [4, 'cooldown', 'cooldown'],
      [5, 'included', 'key'],
      [6, 'included', 'sticky'],
    ]);
    expect(timers).toEqual({ 'b:e': { at: 5, stickyEnd: 7, cooldownEnd: 9 } });
  });

  it('drops timers at or after the index and timers of entries that no longer exist', () => {
    const timers: Record<string, PaLoreTimer> = {
      'b:e': { at: 6, stickyEnd: 9, cooldownEnd: 9 },
      'b:gone': { at: 1, stickyEnd: 9, cooldownEnd: 9 },
    };
    const result = run([book('b', [{ id: 'e', keys: ['火'], content: 'fire', sticky: 3 }])], { index: 6, timers });
    expect(traceOf(result, 'e').reason.code).toBe('no-key');
    expect(result.timers).toEqual({});
  });

  it('sees the same lore when a reply at the same index is regenerated', () => {
    const books = [book('b', [
      { id: 'sticky', keys: ['雨'], content: 'rain', sticky: 3, probability: 60 },
      { id: 'cool', keys: ['雨'], content: 'cool', cooldown: 4 },
      { id: 'g1', keys: ['雨'], content: 'g1', groups: ['天气'] },
      { id: 'g2', keys: ['雨'], content: 'g2', groups: ['天气'] },
    ])];
    const before: Record<string, PaLoreTimer> = { 'b:sticky': { at: 1, stickyEnd: 3, cooldownEnd: 3 } };
    const first = run(books, { index: 4, messages: ['下雨了'], timers: before, rng: seededRng('regen') });
    const again = run(books, { index: 4, messages: ['下雨了'], timers: first.timers, rng: seededRng('regen') });
    expect(again.trace).toEqual(first.trace);
    expect(again.included).toEqual(first.included);
    expect(again.timers).toEqual(first.timers);
  });
});

describe('activateLore: recursion', () => {
  const chain: EntryInput[] = [
    { id: 'a', keys: ['apple'], content: 'a banana grows here' },
    { id: 'b', keys: ['banana'], content: 'next to a cherry' },
    { id: 'c', keys: ['cherry'], content: 'the end' },
  ];

  it('feeds committed content to later passes', () => {
    expect(ids(run([book('b', chain)], { messages: ['an apple'] }))).toEqual(['a', 'b', 'c']);
    expect(ids(run([book('b', chain, { recursive: false })], { messages: ['an apple'] }))).toEqual(['a']);
  });

  it('only kept entries feed their children', () => {
    const entries: EntryInput[] = [
      { id: 'lost', keys: ['apple'], content: 'durian', probability: 0 },
      { id: 'child', keys: ['durian'], content: 'x' },
    ];
    const result = run([book('b', entries)], { messages: ['apple'] });
    expect(ids(result)).toEqual([]);
    expect(traceOf(result, 'lost').status).toBe('probability');
    expect(traceOf(result, 'child').reason.code).toBe('no-key');
  });

  it('honours excludeRecursion and preventRecursion', () => {
    const excluded = chain.map(entry => (entry.id === 'b' ? { ...entry, excludeRecursion: true } : entry));
    expect(ids(run([book('b', excluded)], { messages: ['apple'] }))).toEqual(['a']);
    const prevented = chain.map(entry => (entry.id === 'a' ? { ...entry, preventRecursion: true } : entry));
    expect(ids(run([book('b', prevented)], { messages: ['apple'] }))).toEqual(['a']);
  });

  it('activates recursionOnly entries only after a pass committed something', () => {
    const entries: EntryInput[] = [
      { id: 'root', keys: ['apple'], content: 'plain' },
      { id: 'later', keys: ['apple'], content: 'late', recursionOnly: true },
    ];
    expect(ids(run([book('b', entries)], { messages: ['apple'] }))).toEqual(['root', 'later']);
    const alone = run([book('b', [entries[1] as EntryInput])], { messages: ['apple'] });
    expect(traceOf(alone, 'later')).toMatchObject({ status: 'inactive', reason: { code: 'recursion-only' } });
  });
});

describe('activateLore: groups and probability', () => {
  it('lets the highest-order override member win', () => {
    const entries: EntryInput[] = [
      { id: 'big', keys: ['x'], content: 'a', groups: ['g'], order: 500 },
      { id: 'low', keys: ['x'], content: 'b', groups: ['g'], order: 5, groupOverride: true },
      { id: 'high', keys: ['x'], content: 'c', groups: ['g'], order: 9, groupOverride: true },
    ];
    const result = run([book('b', entries)], { messages: ['x'] });
    expect(ids(result)).toEqual(['high']);
    expect(traceOf(result, 'big').status).toBe('group');
    expect(traceOf(result, 'low').status).toBe('group');
  });

  it('makes one weighted pick per group with a single rng draw', () => {
    const entries: EntryInput[] = [
      { id: 'light', keys: ['x'], content: 'a', groups: ['g'], groupWeight: 1 },
      { id: 'heavy', keys: ['x'], content: 'b', groups: ['g'], groupWeight: 10000 },
    ];
    const draws: number[] = [];
    const rng = (value: number) => () => {
      draws.push(value);
      return value;
    };
    expect(ids(run([book('b', entries)], { messages: ['x'], rng: rng(0) }))).toEqual(['light']);
    expect(ids(run([book('b', entries)], { messages: ['x'], rng: rng(0.5) }))).toEqual(['heavy']);
    expect(draws).toEqual([0, 0.5]);
  });

  it('keeps sticky members over override and loses to a member kept in an earlier pass', () => {
    const sticky: EntryInput[] = [
      { id: 'over', keys: ['x'], content: 'a', groups: ['g'], groupOverride: true, order: 900 },
      { id: 'stuck', keys: ['x'], content: 'b', groups: ['g'] },
    ];
    const timers = { 'b:stuck': { at: 8, stickyEnd: 12, cooldownEnd: 12 } };
    expect(ids(run([book('b', sticky)], { messages: ['x'], timers }))).toEqual(['stuck']);
    const passes: EntryInput[] = [
      { id: 'first', keys: ['apple'], content: 'banana', groups: ['g'] },
      { id: 'second', keys: ['banana'], content: 'x', groups: ['g'] },
    ];
    const result = run([book('b', passes)], { messages: ['apple'] });
    expect(ids(result)).toEqual(['first']);
    expect(traceOf(result, 'second').status).toBe('group');
  });

  it('rolls probability once per survivor in walk order; sticky entries never roll', () => {
    const entries: EntryInput[] = [
      { id: 'half', keys: ['x'], content: 'a', probability: 50 },
      { id: 'never', keys: ['x'], content: 'b', probability: 0 },
      { id: 'stuck', keys: ['y'], content: 'c', probability: 0 },
    ];
    const timers = { 'b:stuck': { at: 8, stickyEnd: 12, cooldownEnd: 12 } };
    const draws: number[] = [];
    const result = run([book('b', entries)], { messages: ['x'], timers, rng: () => { draws.push(0.4); return 0.4; } });
    expect(ids(result)).toEqual(['half', 'stuck']);
    expect(traceOf(result, 'never').status).toBe('probability');
    expect(draws).toHaveLength(2);
    const seeded = () => run([book('b', entries)], { messages: ['x'], rng: seededRng('prob') });
    expect(seeded().trace).toEqual(seeded().trace);
  });
});

describe('activateLore: budget and output', () => {
  const cjk = (count: number) => '字'.repeat(count);

  it('skips an entry that does not fit and continues with the next', () => {
    const entries: EntryInput[] = [
      { id: 'a', keys: ['x'], content: cjk(30), order: 100 },
      { id: 'b', keys: ['x'], content: cjk(40), order: 90 },
      { id: 'c', keys: ['x'], content: cjk(10), order: 80 },
    ];
    const result = run([book('b', entries, { tokenBudget: 50 })], { messages: ['x'] });
    expect(ids(result)).toEqual(['c', 'a']);
    expect(traceOf(result, 'b')).toMatchObject({ status: 'budget', reason: { code: 'over-budget', need: 40, left: 20 } });
    expect([result.used, result.limit]).toEqual([40, 50]);
  });

  it('includes ignoreBudget entries for free and applies maxBudget', () => {
    const entries: EntryInput[] = [
      { id: 'a', keys: ['x'], content: cjk(30), order: 100 },
      { id: 'b', keys: ['x'], content: cjk(40), order: 90, ignoreBudget: true },
      { id: 'c', keys: ['x'], content: cjk(10), order: 80 },
    ];
    const free = run([book('b', entries, { tokenBudget: 50 })], { messages: ['x'] });
    expect(ids(free)).toEqual(['c', 'b', 'a']);
    expect(free.used).toBe(40);
    const capped = run([book('b', entries, { tokenBudget: 50 })], { messages: ['x'], maxBudget: 35 });
    expect(ids(capped)).toEqual(['b', 'a']);
    expect(capped.limit).toBe(35);
    expect(run([book('b', entries)], { messages: ['x'], budgetOverride: 60, maxBudget: 1000 }).limit).toBe(60);
  });

  it('ranks sticky, then constant, then order, and reports a cut constant', () => {
    const entries: EntryInput[] = [
      { id: 'keyed', keys: ['x'], content: cjk(30), order: 1000 },
      { id: 'const', constant: true, content: cjk(30), order: 1 },
      { id: 'stuck', keys: ['nothing'], content: cjk(30), order: 0 },
    ];
    const timers = { 'b:stuck': { at: 8, stickyEnd: 12, cooldownEnd: 12 } };
    const result = run([book('b', entries, { tokenBudget: 60 })], { messages: ['x'], timers });
    expect(ids(result)).toEqual(['stuck', 'const']);
    expect(result.constantCut).toBe(false);
    const tight = run([book('b', entries, { tokenBudget: 50 })], { messages: ['x'], timers });
    expect(ids(tight)).toEqual(['stuck']);
    expect(tight.constantCut).toBe(true);
  });

  it('walks books by rank then book order, and breaks order ties in walk order', () => {
    const global = book('g', [{ id: 'e', constant: true, content: 'global' }]);
    const chat = book('c', [{ id: 'e', constant: true, content: 'chat' }]);
    const result = activateLore({
      books: [{ book: global, rank: 2 }, { book: chat, rank: 0 }], disabled: new Set(), messages: [], extraScan: [],
      index: 0, timers: {}, names: { char: 'a', user: 'b' }, rng: seededRng('x'),
    });
    expect(result.included.map(entry => entry.bookId)).toEqual(['c', 'g']);
    expect(result.trace.map(entry => entry.lorebookId)).toEqual(['c', 'g']);
  });

  it('puts every entry of every book in the trace exactly once', () => {
    const books = [
      book('one', [
        { id: 'a', keys: ['x'], content: 'a' }, { id: 'b', content: '' }, { id: 'c', enabled: false, content: 'c' },
        { id: 'd', keys: ['zzz'], content: 'd' }, { id: 'e', keys: ['x'], content: 'e', probability: 0 },
      ]),
      book('two', [{ id: 'a', constant: true, content: 'a' }, { id: 'f', keys: ['x'], content: 'f', groups: ['g'] }]),
    ];
    const result = run(books, { messages: ['x'] });
    const keys = result.trace.map(item => `${item.lorebookId}:${item.entryId}`);
    expect(keys).toEqual(['one:a', 'one:b', 'one:c', 'one:d', 'one:e', 'two:a', 'two:f']);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('activateLore: regex keys, two tiers', () => {
  const hostile = ['/(a+)+$/', '/a*a*a*a*$/', '/(小+)+$/', '/(a|aa)+$/'];
  const messages = [`${'a'.repeat(5000)}b`, `${'小'.repeat(5000)}!`];

  it('runs safe regex keys inline', () => {
    const result = run([book('b', [{ id: 'e', keys: ['/灯塔|码头/'], content: 'x' }])], { messages: ['去码头'] });
    expect(traceOf(result, 'e').reason).toEqual({ code: 'key', key: '/灯塔|码头/' });
  });

  it('never runs a hostile pattern inline and returns quickly', () => {
    const entries = hostile.map((key, index) => ({ id: `h${index}`, keys: [key], content: 'x' }));
    const started = performance.now();
    const result = run([book('b', entries)], { messages });
    expect(performance.now() - started).toBeLessThan(100);
    expect(result.trace.map(item => item.reason.code)).toEqual(Array(4).fill('regex-needs-daemon'));
  });

  it('reports a timed-out daemon test and counts it', () => {
    const entries = hostile.map((key, index) => ({ id: `h${index}`, keys: [key], content: 'x' }));
    const calls: Array<[string, string, number]> = [];
    const started = performance.now();
    const result = run([book('b', entries)], {
      messages,
      regexTest: (source, flags, text) => {
        calls.push([source, flags, text.length]);
        return null;
      },
    });
    expect(performance.now() - started).toBeLessThan(100);
    expect(result.trace.map(item => item.reason.code)).toEqual(Array(4).fill('regex-timeout'));
    expect(result.regexTimeouts).toBe(8);
    expect(calls.every(([, , length]) => length <= 4000)).toBe(true);
  });

  it('never runs a quantifier-free alternation chain inline', () => {
    const key = `/${'(a|aa)'.repeat(26)}b/`;
    const started = performance.now();
    const result = run([book('b', [{ id: 'alt', keys: [key], content: 'x' }])], { messages });
    expect(performance.now() - started).toBeLessThan(100);
    expect(traceOf(result, 'alt').reason.code).toBe('regex-needs-daemon');
  });

  it('uses the daemon answer for unsafe keys and rejects invalid ones', () => {
    const entries: EntryInput[] = [{ id: 'u', keys: ['/(a+)+$/'], content: 'x' }, { id: 'bad', keys: ['/[/'], content: 'y' }];
    const result = run([book('b', entries)], { messages: ['aaa'], regexTest: () => true });
    expect(traceOf(result, 'u').status).toBe('included');
    expect(traceOf(result, 'bad')).toMatchObject({ status: 'inactive', reason: { code: 'regex-rejected' } });
  });
});
