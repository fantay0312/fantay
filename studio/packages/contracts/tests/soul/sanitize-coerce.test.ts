import { describe, expect, it } from 'vitest';
import { SOUL_LIMITS, bool, capPreserved, isRecord, num, sanitizeForeign, str, strList } from '../../src/soul/index';
import type { PaNeedsReviewItem } from '../../src/soul/index';

function collector() {
  const items: PaNeedsReviewItem[] = [];
  return { items, sink: (item: PaNeedsReviewItem) => { items.push(item); } };
}

describe('sanitizeForeign', () => {
  it('drops reserved keys at every level and rebuilds plain containers', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"keep":{"__proto__":{"x":1},"inner":[{"constructor":"c","ok":true}]}}',
    ) as unknown;
    const output = sanitizeForeign(input) as Record<string, unknown>;
    expect(output).toEqual({ keep: { inner: [{ ok: true }] } });
    expect(Object.hasOwn(output, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(output).not.toBe(input);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('walks a 200 000-deep array without overflowing the stack', () => {
    let deep: unknown = 'bottom';
    for (let index = 0; index < 200_000; index += 1) deep = [deep];

    const bounded = sanitizeForeign(deep);
    let cursor: unknown = bounded;
    let depth = 0;
    while (Array.isArray(cursor)) {
      cursor = cursor[0];
      depth += 1;
    }
    expect(depth).toBe(SOUL_LIMITS.foreignDepth + 1);
    expect(cursor).toBeNull();

    const full = sanitizeForeign(deep, { maxDepth: 300_000, maxNodes: 1_000_000 });
    cursor = full;
    depth = 0;
    while (Array.isArray(cursor)) {
      cursor = cursor[0];
      depth += 1;
    }
    expect(depth).toBe(200_000);
    expect(cursor).toBe('bottom');
  });

  it('nulls non-finite numbers, non-JSON values and non-plain objects', () => {
    class Thing { value = 1; }
    expect(sanitizeForeign({
      nan: Number.NaN, inf: Number.POSITIVE_INFINITY, n: 1.5, b: false, z: null, u: undefined,
      fn: () => 1, sym: Symbol('s'), big: BigInt(1), date: new Date(0), map: new Map(), thing: new Thing(),
    })).toEqual({
      nan: null, inf: null, n: 1.5, b: false, z: null, u: null,
      fn: null, sym: null, big: null, date: null, map: null, thing: null,
    });
    expect(sanitizeForeign(Number.NaN)).toBeNull();
    expect(sanitizeForeign(undefined)).toBeNull();
  });

  it('cuts long strings and omits long data: URIs', () => {
    expect(sanitizeForeign('x'.repeat(10), { maxString: 4 })).toBe('xxxx');
    expect(sanitizeForeign('y'.repeat(SOUL_LIMITS.foreignString + 5))).toHaveLength(SOUL_LIMITS.foreignString);
    const longUri = `data:image/png;base64,${'A'.repeat(SOUL_LIMITS.dataUriInline)}`;
    expect(sanitizeForeign({ icon: longUri })).toEqual({ icon: `[data omitted, ${longUri.length} chars]` });
    const shortUri = 'data:image/png;base64,AAAA';
    expect(sanitizeForeign([shortUri])).toEqual([shortUri]);
  });

  it('nulls containers beyond the depth and node limits', () => {
    expect(sanitizeForeign({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({ a: { b: { c: null } } });
    expect(sanitizeForeign({ a: { b: { c: 1 } } }, { maxDepth: 1 })).toEqual({ a: { b: null } });
    const wide = Array.from({ length: 10 }, (_, index) => ({ index }));
    const capped = sanitizeForeign(wide, { maxNodes: 5 }) as unknown[];
    expect(capped).toHaveLength(10);
    expect(capped.slice(0, 2)).toEqual([{ index: 0 }, { index: 1 }]);
    expect(capped.slice(2).every(item => item === null)).toBe(true);
  });

  it('never throws on hostile getters or proxies', () => {
    const hostile = { get boom(): never { throw new Error('boom'); }, fine: 1 };
    expect(sanitizeForeign(hostile)).toEqual({ boom: null, fine: 1 });
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('trap'); } });
    expect(() => sanitizeForeign({ proxy })).not.toThrow();
  });
});

describe('capPreserved', () => {
  it('keeps entries in insertion order within the JSON budget and reports the rest', () => {
    const record = { a: 'x'.repeat(10), big: 'y'.repeat(100), b: 1 };
    const { kept, dropped } = capPreserved(record, 40);
    expect(kept).toEqual({ a: 'x'.repeat(10), b: 1 });
    expect(Object.keys(kept)).toEqual(['a', 'b']);
    expect(dropped).toEqual(['big']);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(40);
  });

  it('keeps everything that fits exactly', () => {
    const record = { a: 1, b: [true] };
    const limit = JSON.stringify(record).length;
    expect(capPreserved(record, limit)).toEqual({ kept: record, dropped: [] });
    expect(capPreserved(record, limit - 1).dropped).toEqual(['b']);
  });

  it('drops values that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(capPreserved({ cyclic, ok: 'y' }, 1000)).toEqual({ kept: { ok: 'y' }, dropped: ['cyclic'] });
  });
});

describe('coercion helpers', () => {
  it('str normalises line breaks, removes NUL and reports truncation', () => {
    const { items, sink } = collector();
    expect(str('a\r\nb\rc\0d', 100, 'description', sink)).toBe('a\nb\ncd');
    expect(str(42, 10, 'n', sink)).toBe('42');
    expect(str(true, 10, 'b', sink)).toBe('true');
    expect(str({ text: 'x' }, 10, 'o', sink)).toBe('');
    expect(str(null, 10, 'z', sink)).toBe('');
    expect(items).toEqual([]);
    expect(str('abcdefgh', 5, 'name', sink)).toBe('abcde');
    expect(items).toEqual([
      { key: 'name', kind: 'other', action: 'truncated', summary: 'name truncated from 8 to 5' },
    ]);
  });

  it('strList splits, trims, de-duplicates, clips and caps', () => {
    const { items, sink } = collector();
    expect(strList(' rain , ,Rain, ＲＡＩＮ,tea ', 10, 20, 'tags', sink)).toEqual(['rain', 'tea']);
    expect(strList(['a', 2, null, ' b ', 'A'], 10, 20, 'tags', sink)).toEqual(['a', 'b']);
    expect(strList({ a: 1 }, 10, 20, 'tags', sink)).toEqual([]);
    expect(items).toEqual([]);
    expect(strList(['one', 'two', 'three'], 2, 20, 'tags', sink)).toEqual(['one', 'two']);
    expect(strList(['abcdef'], 5, 3, 'groups', sink)).toEqual(['abc']);
    expect(items).toHaveLength(2);
    expect(items.every(item => item.action === 'truncated' && item.kind === 'other')).toBe(true);
    expect(items.map(item => item.key)).toEqual(['tags', 'groups']);
  });

  it('num accepts finite numbers and numeric strings, rounds and clamps', () => {
    expect(num(5, 100, 0, 10, true)).toBe(5);
    expect(num('7', 100, 0, 10, true)).toBe(7);
    expect(num(' 2.6 ', 100, 0, 10, true)).toBe(3);
    expect(num(2.6, 100, 0, 10, false)).toBe(2.6);
    expect(num(50, 4, 0, 10, true)).toBe(10);
    expect(num(-3, 4, 0, 10, true)).toBe(0);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'Infinity', '', 'abc', null, undefined, true, {}, []]) {
      expect(num(bad, 4, 0, 10, true)).toBe(4);
    }
  });

  it('bool accepts booleans, true/false words and 1/0', () => {
    expect(bool(true, false)).toBe(true);
    expect(bool('TRUE', false)).toBe(true);
    expect(bool('False', true)).toBe(false);
    expect(bool(1, false)).toBe(true);
    expect(bool(0, true)).toBe(false);
    for (const other of ['yes', 2, null, undefined, {}, '1']) {
      expect(bool(other, true)).toBe(true);
      expect(bool(other, false)).toBe(false);
    }
  });

  it('isRecord accepts plain objects only', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(JSON.parse('{"a":1}'))).toBe(true);
    for (const other of [null, [], 'x', 1, new Date(0), new Map()]) expect(isRecord(other)).toBe(false);
  });
});
