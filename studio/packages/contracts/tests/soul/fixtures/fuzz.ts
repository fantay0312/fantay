// Fixture reading and seeded mutation fuzzing shared by the card and world importer tests.
import { readFileSync } from 'node:fs';

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name)) as unknown;
}

interface Slot { parent: Record<string, unknown> | unknown[]; key: string | number }

/** Every (container, key) pair down to depth 12; `__proto__` own keys are left alone. */
function slots(root: unknown): Slot[] {
  const out: Slot[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (depth > 12 || value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      value.forEach((item: unknown, index) => {
        out.push({ parent: value, key: index });
        stack.push({ value: item, depth: depth + 1 });
      });
    } else {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key === '__proto__') continue;
        out.push({ parent: record, key });
        stack.push({ value: record[key], depth: depth + 1 });
      }
    }
  }
  return out;
}

function swapType(value: unknown): unknown {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 1 : 'false';
  if (Array.isArray(value)) return Object.fromEntries(value.map((item: unknown, index) => [String(index), item]));
  if (value !== null && typeof value === 'object') return Object.values(value);
  return 'null';
}

function nest(value: unknown, depth: number, asObjects: boolean): unknown {
  let out = value;
  for (let level = 0; level < depth; level += 1) out = asObjects ? { x: out } : [out];
  return out;
}

const pick = <T>(list: readonly T[], rng: () => number): T => list[Math.floor(rng() * list.length)] as T;

function hostile(original: unknown, rng: () => number): unknown {
  const makers: Array<() => unknown> = [
    () => null,
    () => undefined,
    () => 1e308,
    () => -1e308,
    () => Number.MAX_SAFE_INTEGER + 2,
    () => -0,
    () => 0.5,
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    () => '',
    () => 'x'.repeat(40_000 + Math.floor(rng() * 1_000)),
    () => 'true',
    () => '12',
    () => '/(a+)+$/',
    () => '<% if (x) { %>\n<% } %>',
    () => `data:image/png;base64,${'A'.repeat(5_000)}`,
    () => [],
    () => ({}),
    () => [1, 'a', null, { k: 'v' }],
    () => JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":1}}') as unknown,
    () => true,
    () => false,
    () => swapType(original),
    () => swapType(original),
    () => nest(original, 200 + Math.floor(rng() * 400), rng() < 0.5),
    () => Array.from({ length: 80 }, (_, index) => (typeof original === 'string' ? `${original} ${index}` : original)),
  ];
  return pick(makers, rng)();
}

/** A deep copy of `source` with one to four values replaced by hostile ones (type swaps, nulls, huge values, nesting). */
export function mutate(source: unknown, rng: () => number): unknown {
  let root = JSON.parse(JSON.stringify(source)) as unknown;
  const count = 1 + Math.floor(rng() * 4);
  for (let round = 0; round < count; round += 1) {
    const all = slots(root);
    if (all.length === 0 || rng() < 0.03) {
      root = hostile(root, rng);
      continue;
    }
    const slot = pick(all, rng);
    const current = Array.isArray(slot.parent) ? slot.parent[slot.key as number] : slot.parent[slot.key as string];
    Object.defineProperty(slot.parent, slot.key, { value: hostile(current, rng), writable: true, enumerable: true, configurable: true });
  }
  return root;
}
