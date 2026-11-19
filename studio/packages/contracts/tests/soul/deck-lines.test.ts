import { describe, expect, it } from 'vitest';
import { PA_BUILTIN_DECKS, SOUL_LIMITS, deckIdFor, paDeckSchema, parseDeckLines } from '../../src/soul/index';

describe('parseDeckLines', () => {
  it('splits on |, ｜ and tab; text and secret are optional', () => {
    expect(parseDeckLines('太阳 | 好日子 | 其实是阴天\n月亮｜慢一点\n星星\t许个愿\t别告诉别人\t真的\n钥匙', 10)).toEqual({
      cards: [
        { title: '太阳', text: '好日子', secret: '其实是阴天' },
        { title: '月亮', text: '慢一点', secret: '' },
        { title: '星星', text: '许个愿', secret: '别告诉别人 | 真的' },
        { title: '钥匙', text: '', secret: '' },
      ],
      skipped: 0,
    });
  });

  it('removes one list marker, ignores blank lines and counts lines without a title', () => {
    const result = parseDeckLines('- 愚者 | 出发\n\n  \n* 魔术师\n• 女祭司\n1. 皇帝\n2）教皇\n3．恋人\n| 只有说明\n- - 双重', 10);
    expect(result.cards.map(card => card.title)).toEqual(['愚者', '魔术师', '女祭司', '皇帝', '教皇', '恋人', '- 双重']);
    expect(result.skipped).toBe(1);
  });

  it('cuts each part to its limit without splitting a surrogate pair', () => {
    const [card] = parseDeckLines(`${'牌'.repeat(80)} | ${'说'.repeat(700)} | ${'秘'.repeat(700)}`, 1).cards;
    expect(card?.title).toHaveLength(SOUL_LIMITS.cardTitle);
    expect(card?.text).toHaveLength(SOUL_LIMITS.cardText);
    expect(card?.secret).toHaveLength(SOUL_LIMITS.cardSecret);
    const [emoji] = parseDeckLines('🙂'.repeat(40), 1).cards;
    expect(emoji?.title.length).toBeLessThanOrEqual(SOUL_LIMITS.cardTitle);
    expect(emoji?.title).toBe('🙂'.repeat(30));
  });

  it('stops at the room left in the deck and counts the rest as skipped', () => {
    expect(parseDeckLines('a\nb\nc\nd', 2)).toEqual({ cards: [{ title: 'a', text: '', secret: '' }, { title: 'b', text: '', secret: '' }], skipped: 2 });
    expect(parseDeckLines('a\nb', 0)).toEqual({ cards: [], skipped: 2 });
    expect(parseDeckLines('a', Number.NaN)).toEqual({ cards: [], skipped: 1 });
  });

  it('reads only the first deckPasteChars characters', () => {
    const line = `${'x'.repeat(98)}\n`;                     // 99 characters per line
    const text = line.repeat(Math.ceil(SOUL_LIMITS.deckPasteChars / line.length) + 50);
    const { cards, skipped } = parseDeckLines(text, 5000);
    expect(cards.length + skipped).toBe(Math.ceil(SOUL_LIMITS.deckPasteChars / line.length));
  });

  it('builds schema-valid cards', () => {
    const { cards } = parseDeckLines(`牌一 | 说明\n牌二\n${'长'.repeat(200)} | ${'x'.repeat(2000)}`, 120);
    expect(paDeckSchema.safeParse({ id: 'mine', name: '我的', cards }).success).toBe(true);
    expect(parseDeckLines(undefined as unknown as string, 4)).toEqual({ cards: [], skipped: 0 });
  });
});

describe('deckIdFor', () => {
  const pattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;
  it('slugs ASCII letters and digits and falls back to deck', () => {
    expect(deckIdFor('塔罗', new Set())).toBe('deck');
    expect(deckIdFor('My Deck!', new Set())).toBe('my-deck');
    expect(deckIdFor('  --Ｈｅｌｌｏ　Ｗｏｒｌｄ 2--', new Set())).toBe('hello-world-2');
    expect(deckIdFor('', new Set())).toBe('deck');
  });

  it('never answers a taken or built-in id', () => {
    expect(deckIdFor('My Deck!', new Set(['my-deck']))).toBe('my-deck-2');
    expect(deckIdFor('My Deck!', new Set(['my-deck', 'my-deck-2']))).toBe('my-deck-3');
    expect(deckIdFor('塔罗', new Set(['deck']))).toBe('deck-2');
    for (const deck of PA_BUILTIN_DECKS) expect(deckIdFor(deck.id, new Set())).toBe(`${deck.id}-2`);
    expect(deckIdFor('Tarot', new Set(['tarot-2']))).toBe('tarot-3');
  });

  it('matches the deck id pattern, even for long names', () => {
    const long = deckIdFor(`${'a'.repeat(31)}-${'b'.repeat(40)}`, new Set());
    expect(long).toBe('a'.repeat(31));
    const taken = new Set<string>();
    for (let index = 0; index < 30; index += 1) {
      const id = deckIdFor('x'.repeat(60), taken);
      expect(id).toMatch(pattern);
      taken.add(id);
    }
    expect(taken.size).toBe(30);
  });
});
