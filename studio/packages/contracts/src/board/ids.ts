// SPDX-License-Identifier: Apache-2.0
// Board ids (spec 04 §3.2). Random ids are injected by callers (`newId`); this module only derives stable ones.

export const BOARD_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

export function isBoardId(v: unknown): v is string {
  return typeof v === 'string' && BOARD_ID_PATTERN.test(v);
}

/** cyrb53 (public-domain 53-bit string hash). Returns an integer in [0, 2^53). */
function cyrb53(input: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const HALF_MODULUS = 36 ** 8;

function base36Half(value: number): string {
  return (value % HALF_MODULUS).toString(36).padStart(8, '0');
}

/**
 * Deterministic id for derived board entities: `${prefix}_` + 16 lowercase base36 chars, built from two cyrb53
 * rounds of `seed` (seeds 0 and 0x9e3779b9), each reduced to 8 zero-padded base36 chars. The daemon planner and
 * every client use this one implementation, so the same seed always maps to the same id.
 */
export function stableBoardId(prefix: 'n' | 'e', seed: string): string {
  return `${prefix}_${base36Half(cyrb53(seed, 0))}${base36Half(cyrb53(seed, 0x9e3779b9))}`;
}
