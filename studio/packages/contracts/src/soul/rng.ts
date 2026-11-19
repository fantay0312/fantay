// SPDX-License-Identifier: Apache-2.0
// Deterministic hashing and seeded randomness for tests, the fixture transport and the stable macros.

/** FNV-1a 32-bit over UTF-16 code units; unsigned. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32. Returns values in [0, 1). Same seed, same sequence. */
export function seededRng(seed: string | number): () => number {
  let a = (typeof seed === "number" ? seed : hashSeed(seed)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
