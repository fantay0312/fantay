import { describe, expect, it } from 'vitest';
import { estimateTokens, hashSeed, seededRng } from '../../src/soul/index';

function take(rng: () => number, count: number): number[] {
  return Array.from({ length: count }, () => rng());
}

describe('soul rng', () => {
  it('hashSeed is unsigned 32-bit FNV-1a over UTF-16 code units', () => {
    expect(hashSeed('')).toBe(0x811c9dc5);
    expect(hashSeed('a')).toBe(0xe40c292c);
    expect(hashSeed('foobar')).toBe(0xbf9cf968);
    const cjk = hashSeed('茶');
    expect(Number.isInteger(cjk) && cjk >= 0 && cjk <= 0xffffffff).toBe(true);
  });

  it('the same seed gives the same sequence', () => {
    expect(take(seededRng('conversation-1'), 50)).toEqual(take(seededRng('conversation-1'), 50));
    expect(take(seededRng(42), 50)).toEqual(take(seededRng(42), 50));
    expect(take(seededRng('conversation-1'), 1)).toEqual(take(seededRng(hashSeed('conversation-1')), 1));
    expect(take(seededRng('conversation-1'), 10)).not.toEqual(take(seededRng('conversation-2'), 10));
  });

  it('returns values in [0, 1)', () => {
    for (const seed of ['a', 'lab', 0, 1, -1, 0xffffffff]) {
      const values = take(seededRng(seed), 5000);
      expect(values.every(value => value >= 0 && value < 1)).toBe(true);
      expect(new Set(values).size).toBeGreaterThan(4900);
    }
  });
});

describe('soul token estimate', () => {
  it('is zero only for empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(' ')).toBe(1);
    expect(estimateTokens('a')).toBe(1);
  });

  it('counts one token per CJK code point', () => {
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('こんにちは')).toBe(5);
    expect(estimateTokens('안녕')).toBe(2);
    expect(estimateTokens('，！')).toBe(2);
    expect(estimateTokens('𠀀𠀁')).toBe(2);
  });

  it('counts one token per four other code points', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('hello world!')).toBe(3);
    expect(estimateTokens('😀😀')).toBe(1);
  });

  it('adds both parts for mixed text', () => {
    expect(estimateTokens('你好, world')).toBe(2 + 2);
    expect(estimateTokens('今天 rain')).toBe(2 + 2);
  });
});
