import { describe, expect, it } from 'vitest';
import { SOUL_LIMITS, compileLoreKey, splitKeyList } from '../../src/soul/index';

describe('compileLoreKey', () => {
  it('reads empty and plain text keys', () => {
    expect(compileLoreKey('')).toEqual({ kind: 'empty' });
    expect(compileLoreKey('   ')).toEqual({ kind: 'empty' });
    expect(compileLoreKey('  港口小镇 ')).toEqual({ kind: 'text', needle: '港口小镇' });
    expect(compileLoreKey('/open')).toEqual({ kind: 'text', needle: '/open' });
    expect(compileLoreKey('//')).toEqual({ kind: 'text', needle: '//' });
    expect(compileLoreKey('/abc/I')).toEqual({ kind: 'text', needle: '/abc/I' });
    expect(compileLoreKey('/abc/ i')).toEqual({ kind: 'text', needle: '/abc/ i' });
  });

  it('detects regex literals and takes the last unescaped slash as the delimiter', () => {
    expect(compileLoreKey('/dragon/')).toEqual({ kind: 'regex', source: 'dragon', flags: '', safe: true });
    expect(compileLoreKey(' /a\\/b/i ')).toEqual({ kind: 'regex', source: 'a\\/b', flags: 'i', safe: true });
    expect(compileLoreKey('/path/to/x/')).toEqual({ kind: 'regex', source: 'path/to/x', flags: '', safe: true });
    expect(compileLoreKey('/a\\\\/m')).toEqual({ kind: 'regex', source: 'a\\\\', flags: 'm', safe: true });
    // An escaped closing slash is not a delimiter, so the earlier slash cannot close a non-empty source.
    expect(compileLoreKey('/abc\\/')).toEqual({ kind: 'text', needle: '/abc\\/' });
  });

  it('keeps i, m, s and u, strips g, y and d, and rejects other flags', () => {
    expect(compileLoreKey('/x/gi')).toMatchObject({ kind: 'regex', flags: 'i' });
    expect(compileLoreKey('/x/iigy')).toMatchObject({ kind: 'regex', flags: 'i' });
    expect(compileLoreKey('/x/dmsu')).toMatchObject({ kind: 'regex', flags: 'msu' });
    expect(compileLoreKey('/x/gyd')).toMatchObject({ kind: 'regex', flags: '' });
    expect(compileLoreKey('/x/ix')).toEqual({ kind: 'invalid' });
    expect(compileLoreKey('/x/v')).toEqual({ kind: 'invalid' });
    // Lower-case letters after the last slash make it a literal; `b` and `n` are not allowed flags.
    expect(compileLoreKey('/usr/bin')).toEqual({ kind: 'invalid' });
  });

  it('rejects invalid and oversized sources', () => {
    expect(compileLoreKey('/(unclosed/')).toEqual({ kind: 'invalid' });
    expect(compileLoreKey('/[z-a]/')).toEqual({ kind: 'invalid' });
    expect(compileLoreKey('/\\p{Foo}/u')).toEqual({ kind: 'invalid' });
    const atLimit = `/${'a'.repeat(SOUL_LIMITS.loreRegexSource)}/`;
    const overLimit = `/${'a'.repeat(SOUL_LIMITS.loreRegexSource + 1)}/`;
    expect(compileLoreKey(atLimit).kind).toBe('regex');
    expect(compileLoreKey(overLimit)).toEqual({ kind: 'invalid' });
  });

  it('marks the bounded subset as safe', () => {
    const safe = (key: string) => {
      const compiled = compileLoreKey(key);
      if (compiled.kind !== 'regex') throw new Error(`${key} is ${compiled.kind}`);
      return compiled.safe;
    };
    expect(safe('/^(?:red|blue) dragon$/i')).toBe(true);
    expect(safe('/colou?r/')).toBe(true);
    expect(safe('/[*+{}]/')).toBe(true);
    expect(safe('/a\\*b\\+c\\{/')).toBe(true);
    expect(safe('/(?<who>cat)|(?=dog)/')).toBe(true);
    expect(safe('/a*/')).toBe(false);
    expect(safe('/a+/')).toBe(false);
    expect(safe('/a{2}/')).toBe(false);
    expect(safe('/(a)\\1/')).toBe(false);
    expect(safe('/(?<x>a)\\k<x>/')).toBe(false);
    expect(safe('/[\\1]/')).toBe(true);
  });

  it('caps optional quantifiers at eight', () => {
    expect(compileLoreKey(`/${'a?'.repeat(8)}${'a'.repeat(8)}/`)).toMatchObject({ kind: 'regex', safe: true });
    expect(compileLoreKey(`/${'a?'.repeat(9)}${'a'.repeat(9)}/`)).toMatchObject({ kind: 'regex', safe: false });
    expect(compileLoreKey(`/${'(?:x)'.repeat(12)}/`)).toMatchObject({ kind: 'regex', safe: true });
  });

  it('never marks the classic catastrophic patterns safe', () => {
    for (const key of ['/(a+)+$/', '/a*a*a*a*$/', '/(小+)+$/', '/(a|aa)+$/']) {
      expect(compileLoreKey(key), key).toMatchObject({ kind: 'regex', safe: false });
    }
  });

  it('bounds alternation like optional quantifiers, so a quantifier-free key cannot backtrack exponentially', () => {
    const names = ['艾莉', '爱丽丝', 'alice', 'ally', '小艾', '艾丽', 'ali', 'lis', '莉丝', '阿莉'];
    expect(compileLoreKey(`/(?:${names.join('|')})/i`)).toMatchObject({ kind: 'regex', safe: true });
    expect(compileLoreKey(`/${'(a|b)'.repeat(8)}/`)).toMatchObject({ kind: 'regex', safe: true });
    expect(compileLoreKey(`/${'(a|b)'.repeat(9)}/`)).toMatchObject({ kind: 'regex', safe: false });
    const hostile = `${'(a|aa)'.repeat(26)}b`;
    expect(compileLoreKey(`/${hostile}/`)).toMatchObject({ kind: 'regex', safe: false });
    expect(compileLoreKey(`/(${'a|'.repeat(300).slice(0, 190)}b)/`)).toMatchObject({ kind: 'regex', safe: true });
  });
});

describe('splitKeyList', () => {
  it('splits strings on ASCII commas and keeps a regex literal whole', () => {
    expect(splitKeyList(' rain, 雨 ,,umbrella ')).toEqual(['rain', '雨', 'umbrella']);
    expect(splitKeyList('雨，伞')).toEqual(['雨，伞']);
    expect(splitKeyList('/a,b|c/i')).toEqual(['/a,b|c/i']);
    expect(splitKeyList('/a,b/x')).toEqual(['/a,b/x']);
  });

  it('keeps string items of an array without splitting them', () => {
    expect(splitKeyList(['rain, snow', 3, null, ' fog ', ''])).toEqual(['rain, snow', 'fog']);
    expect(splitKeyList(42)).toEqual([]);
    expect(splitKeyList(undefined)).toEqual([]);
  });

  it('caps the number and length of keys', () => {
    const many = Array.from({ length: SOUL_LIMITS.loreKeys + 10 }, (_, index) => `k${index}`);
    expect(splitKeyList(many)).toHaveLength(SOUL_LIMITS.loreKeys);
    expect(splitKeyList(many.join(','))).toEqual(many.slice(0, SOUL_LIMITS.loreKeys));
    const [long] = splitKeyList(['x'.repeat(SOUL_LIMITS.loreKey + 50)]);
    expect(long).toHaveLength(SOUL_LIMITS.loreKey);
  });
});
