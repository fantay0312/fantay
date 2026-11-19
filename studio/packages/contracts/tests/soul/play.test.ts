import { describe, expect, it } from 'vitest';
import {
  PA_BUILTIN_DECKS,
  PA_EVENT_TURNS,
  PA_INTERLUDE_BEATS,
  availableDecks,
  drawCard,
  drawInterlude,
  paDeckSchema,
  rollDice,
  secretSuffix,
  seededRng,
  storyText,
} from '../../src/soul/index';
import type { DiceRoll, PaDeck } from '../../src/soul/index';

const fixed = (value: number) => () => value;

function deck(id: string, name: string, titles: readonly string[]): PaDeck {
  return { id, name, cards: titles.map(title => ({ title, text: `${title} text`, secret: '' })) };
}

describe('rollDice', () => {
  it('parses the dice grammar and normalises the notation', () => {
    expect(rollDice('d20', fixed(0))).toEqual({ notation: 'd20', rolls: [1], modifier: 0, total: 1 });
    expect(rollDice('1d20', fixed(0))?.notation).toBe('d20');
    expect(rollDice('01D20', fixed(0))?.notation).toBe('d20');
    expect(rollDice(' 2 d 6 + 3 ', fixed(0))).toEqual({ notation: '2d6+3', rolls: [1, 1], modifier: 3, total: 5 });
    expect(rollDice('2d6-1', fixed(0))).toMatchObject({ notation: '2d6-1', modifier: -1, total: 1 });
    expect(rollDice('d20+0', fixed(0))?.notation).toBe('d20');
    expect(rollDice('d20+0002', fixed(0))).toMatchObject({ notation: 'd20+2', modifier: 2 });
    expect(rollDice('d%', fixed(0.999999))).toEqual({ notation: 'd100', rolls: [100], modifier: 0, total: 100 });
    expect(rollDice('3d%', fixed(0))?.notation).toBe('3d100');
  });

  it('rejects anything outside 1–40 dice of 2–1000 sides', () => {
    for (const notation of ['', 'd', '20', 'abc', 'd20+', '2x6', 'd20+10000', '100d6', '0d6', '41d6', 'd1', 'd0', 'd1001',
      'd20 + 2 + 1', '2d6*2', '-1d6', 'd-6']) {
      expect(rollDice(notation, fixed(0.5)), notation).toBeNull();
    }
    expect(rollDice('40d6', fixed(0))?.rolls).toHaveLength(40);
    expect(rollDice('d2', fixed(0.75))?.rolls).toEqual([2]);
    expect(rollDice('d1000', fixed(0.999999))?.rolls).toEqual([1000]);
  });

  it('keeps every die within its faces and totals rolls plus modifier', () => {
    const rng = seededRng('dice');
    for (let round = 0; round < 500; round += 1) {
      const roll = rollDice('4d6+2', rng);
      if (!roll) throw new Error('4d6+2 did not parse');
      expect(roll.rolls).toHaveLength(4);
      expect(roll.rolls.every(value => Number.isInteger(value) && value >= 1 && value <= 6)).toBe(true);
      expect(roll.total).toBe(roll.rolls.reduce((sum, value) => sum + value, 0) + 2);
    }
    expect(rollDice('3d6', seededRng(7))).toEqual(rollDice('3d6', seededRng(7)));
  });

  it('decides the outcome against a dc', () => {
    expect(rollDice('d20+2', fixed(0.5), 12)).toEqual({ notation: 'd20+2', rolls: [11], modifier: 2, total: 13, dc: 12, outcome: 'success' });
    expect(rollDice('d20+2', fixed(0.45), 12)).toMatchObject({ total: 12, dc: 12, outcome: 'success' });
    expect(rollDice('d20', fixed(0), 12)).toMatchObject({ total: 1, dc: 12, outcome: 'fail' });
    expect(rollDice('d20', fixed(0.999), 999)).toMatchObject({ dc: 999, outcome: 'fail' });
    for (const dc of [0, 1000, 2.5, Number.NaN, -3]) {
      const roll = rollDice('d20', fixed(0.5), dc);
      expect(roll, String(dc)).not.toHaveProperty('dc');
      expect(roll, String(dc)).not.toHaveProperty('outcome');
    }
  });
});

describe('decks', () => {
  it('ships five valid built-in decks', () => {
    expect(PA_BUILTIN_DECKS.map(item => [item.id, item.name])).toEqual([
      ['topic', '话题'], ['truth', '真心话'], ['dare', '大冒险'], ['tarot', '塔罗'], ['fortune', '签'],
    ]);
    for (const builtin of PA_BUILTIN_DECKS) {
      expect(paDeckSchema.parse(builtin), builtin.id).toEqual(builtin);
      expect(builtin.cards.every(card => card.secret === ''), builtin.id).toBe(true);
      expect(new Set(builtin.cards.map(card => card.title)).size, builtin.id).toBe(builtin.cards.length);
    }
    const sizes = Object.fromEntries(PA_BUILTIN_DECKS.map(item => [item.id, item.cards.length]));
    expect(sizes).toEqual({ topic: 16, truth: 12, dare: 10, tarot: 22, fortune: 12 });
    for (const id of ['topic', 'truth', 'dare']) {
      expect(PA_BUILTIN_DECKS.find(item => item.id === id)?.cards.every(card => card.text === ''), id).toBe(true);
    }
    expect(PA_BUILTIN_DECKS.find(item => item.id === 'tarot')?.cards[0]).toEqual({ title: '愚者', text: '新的开始，带着一点莽撞出发。', secret: '' });
  });

  it('puts the character decks first and lets them shadow built-ins by id', () => {
    expect(availableDecks(null)).toEqual([...PA_BUILTIN_DECKS]);
    expect(availableDecks({ decks: [] }).map(item => item.id)).toEqual(['topic', 'truth', 'dare', 'tarot', 'fortune']);
    const soup = deck('soup', '海龟汤', ['one', 'two']);
    const tarot = deck('tarot', '我的塔罗', ['星', '月']);
    const decks = availableDecks({ decks: [soup, tarot] });
    expect(decks.map(item => item.id)).toEqual(['soup', 'tarot', 'topic', 'truth', 'dare', 'fortune']);
    expect(decks[1]).toBe(tarot);
  });

  it('draws uniformly with the given rng', () => {
    const topic = PA_BUILTIN_DECKS[0];
    if (!topic) throw new Error('no built-in deck');
    expect(drawCard(topic, fixed(0))).toEqual({ index: 0, card: topic.cards[0] });
    expect(drawCard(topic, fixed(0.999999)).index).toBe(topic.cards.length - 1);
    const rng = seededRng('draws');
    const seen = new Set<number>();
    for (let round = 0; round < 400; round += 1) {
      const { index, card } = drawCard(topic, rng);
      expect(card).toBe(topic.cards[index]);
      seen.add(index);
    }
    expect(seen.size).toBe(topic.cards.length);
    expect(drawCard(topic, seededRng(3))).toEqual(drawCard(topic, seededRng(3)));
  });
});

describe('interludes', () => {
  it('ships twelve beats with both locales', () => {
    expect(PA_INTERLUDE_BEATS).toHaveLength(12);
    expect(new Set(PA_INTERLUDE_BEATS.map(item => item.id)).size).toBe(12);
    for (const beat of PA_INTERLUDE_BEATS) {
      expect(beat.id).toMatch(/^[a-z-]+$/);
      for (const value of [beat.title.zh, beat.title.en, beat.summary.zh, beat.summary.en]) expect(value.length, beat.id).toBeGreaterThan(0);
    }
    expect(PA_INTERLUDE_BEATS[0]).toEqual({
      id: 'arrival',
      title: { zh: '有人来了', en: 'Someone arrives' },
      summary: { zh: '一个没想到的人出现在门口，带着一件要紧的事。', en: 'An unexpected person shows up at the door with something urgent.' },
    });
    expect(PA_EVENT_TURNS).toBe(3);
  });

  it('never draws an excluded beat unless every beat is excluded', () => {
    const rng = seededRng('interludes');
    const excluded = ['arrival', 'quiet'];
    const seen = new Set<string>();
    for (let round = 0; round < 300; round += 1) seen.add(drawInterlude(excluded, rng).id);
    expect(seen.has('arrival') || seen.has('quiet')).toBe(false);
    expect(seen.size).toBe(10);
    const all = PA_INTERLUDE_BEATS.map(item => item.id);
    expect(all).toContain(drawInterlude(all, rng).id);
    expect(drawInterlude([], seededRng(11))).toEqual(drawInterlude([], seededRng(11)));
    expect(drawInterlude([], fixed(0)).id).toBe('arrival');
    expect(drawInterlude(['arrival'], fixed(0)).id).toBe('revelation');
  });
});

describe('storyText', () => {
  const roll = (extra: Partial<DiceRoll> = {}): DiceRoll => ({ notation: 'd20+2', rolls: [11], modifier: 2, total: 13, ...extra });

  it('writes rolls in both locales', () => {
    expect(storyText({ kind: 'roll', roll: roll() }, 'zh')).toBe('掷骰 d20+2 = 13');
    expect(storyText({ kind: 'roll', roll: roll() }, 'en')).toBe('Roll d20+2 = 13');
    expect(storyText({ kind: 'roll', roll: roll({ dc: 12, outcome: 'success' }), label: '翻墙' }, 'zh'))
      .toBe('掷骰 翻墙 d20+2 = 13（目标 12，成功）');
    expect(storyText({ kind: 'roll', roll: roll({ dc: 14, outcome: 'fail' }), label: 'Climb' }, 'en'))
      .toBe('Roll Climb d20+2 = 13 (target 14, failure)');
    expect(storyText({ kind: 'roll', roll: roll({ dc: 14 }) }, 'zh')).toBe('掷骰 d20+2 = 13（目标 14，失败）');
    expect(storyText({ kind: 'roll', roll: roll(), label: '  ' }, 'en')).toBe('Roll d20+2 = 13');
  });

  it('writes draws and interludes in both locales', () => {
    expect(storyText({ kind: 'draw', deckName: '塔罗', title: '星星', text: '许个愿，然后睡个好觉。' }, 'zh'))
      .toBe('抽到「星星」· 塔罗：许个愿，然后睡个好觉。');
    expect(storyText({ kind: 'draw', deckName: '话题', title: '下雨天你最想做什么？', text: '' }, 'zh'))
      .toBe('抽到「下雨天你最想做什么？」· 话题');
    expect(storyText({ kind: 'draw', deckName: 'Tarot', title: 'The Star', text: 'Make a wish.' }, 'en'))
      .toBe('Drew "The Star" from Tarot: Make a wish.');
    expect(storyText({ kind: 'draw', deckName: 'Topics', title: 'Rainy days?', text: '' }, 'en')).toBe('Drew "Rainy days?" from Topics');
    expect(storyText({ kind: 'event', title: '变天了', phase: 'accepted' }, 'zh')).toBe('小插曲开始：变天了');
    expect(storyText({ kind: 'event', title: '变天了', phase: 'ended' }, 'zh')).toBe('小插曲结束：变天了');
    expect(storyText({ kind: 'event', title: 'The weather turns', phase: 'accepted' }, 'en')).toBe('Interlude begins: The weather turns');
    expect(storyText({ kind: 'event', title: 'The weather turns', phase: 'ended' }, 'en')).toBe('Interlude ends: The weather turns');
  });

  it('stays on one line', () => {
    expect(storyText({ kind: 'draw', deckName: 'soup', title: 'two\nlines', text: 'a\r\n  b' }, 'en')).toBe('Drew "two lines" from soup: a b');
  });

  it('formats the secret suffix', () => {
    expect(secretSuffix('汤底', 'zh')).toBe('（只有你知道：汤底）');
    expect(secretSuffix('the answer', 'en')).toBe('(Only you know: the answer)');
  });
});
