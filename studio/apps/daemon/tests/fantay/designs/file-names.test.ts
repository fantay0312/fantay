// Amendment B14: the contracts' `designFileNameFromTitle` must follow the daemon's real project-file `sanitizeName`
// (apps/daemon/src/projects.ts). Within the caps (120 UTF-16 units, 150 UTF-8 bytes) both give the same name; above
// them the contract name is the longest code-point-aligned prefix of the daemon name that fits both caps.
import { describe, expect, it } from 'vitest';
import { designFileNameFromTitle, uniqueDesignPath } from '@open-design/contracts';

import { sanitizeName, sanitizePath } from '../../../src/projects.js';
import { DESIGN_FILE_NAME_MAX_BYTES, validateDesignPath } from '../../../src/fantay/designs/paths.js';

const MAX_UNITS = 120;
const MAX_BYTES = 150;

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function fits(value: string): boolean {
  return value.length <= MAX_UNITS && bytes(value) <= MAX_BYTES;
}

/** The parity rule of B14 for one title. */
function expectParity(title: string): void {
  const daemon = sanitizeName(title) as string;
  const contract = designFileNameFromTitle(title);
  if (title === '') {
    // The daemon invents `file-<time>`; the contract names an untitled design `design`.
    expect(daemon).toMatch(/^file-\d+$/);
    expect(contract).toBe('design');
    return;
  }
  if (fits(daemon)) {
    expect(contract, JSON.stringify(title)).toBe(daemon);
    return;
  }
  expect(fits(contract), JSON.stringify(title)).toBe(true);
  expect(daemon.startsWith(contract), JSON.stringify(title)).toBe(true);
  // Maximal: the next code point of the daemon name would cross a cap.
  const next = [...daemon.slice(contract.length)][0]!;
  expect(fits(contract + next), JSON.stringify(title)).toBe(false);
  // The prefix is itself canonical, so `designs/<name>.fig` passes the daemon's own sanitizer unchanged.
  expect(sanitizeName(contract)).toBe(contract);
}

const CORPUS = [
  '',
  '首页',
  '首页 设计',
  'Landing Page',
  '  leading and trailing  ',
  'tab\tand\nnewline',
  'a/b\\c',
  '..hidden',
  '.env',
  '...',
  '-dash-',
  'ok-name_1.2',
  'semi;colon:quote"star*?',
  '🎨 Poster',
  '👨‍👩‍👧 family',
  'é combining',
  'Ünïcödé Ελληνικά Кириллица العربية עברית',
  ' nbsp em-space',
  'zero​width',
  'lone \ud800 surrogate',
  '日本語のデザイン',
  '한국어 디자인',
  'x'.repeat(119),
  'x'.repeat(120),
  'x'.repeat(121),
  'é'.repeat(75),
  'é'.repeat(76),
  '中'.repeat(50),
  '中'.repeat(51),
  '中'.repeat(200),
  '😀'.repeat(37),
  '😀'.repeat(38),
  `${'a'.repeat(118)}😀b`,
  `${'中'.repeat(49)}ab`,
];

/** mulberry32: deterministic pseudo-random numbers for the fuzz corpus. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'Z', '7', ' ', '\t', '-', '_', '.', '/', '\\', ':', '?', '中', '文', 'é', 'ß', 'Ж', 'ي', '😀', '👍🏽', '́', ' ', '​', '\ud83d', '%', '#', '"', "'", '·', '—'];

describe('designFileNameFromTitle ≡ sanitizeName (B14)', () => {
  it('matches the daemon sanitizer on the corpus', () => {
    for (const title of CORPUS) expectParity(title);
  });

  it('matches the daemon sanitizer on 5,000 random titles, long ones by the prefix rule', () => {
    const next = random(0xfa47a1);
    for (let index = 0; index < 5_000; index += 1) {
      const length = Math.floor(next() * (index % 10 === 0 ? 260 : 40));
      let title = '';
      for (let char = 0; char < length; char += 1) title += ALPHABET[Math.floor(next() * ALPHABET.length)]!;
      expectParity(title);
    }
  });

  it('produces names whose design paths the daemon accepts as canonical', () => {
    for (const title of [...CORPUS.filter(Boolean), '中'.repeat(300), '😀'.repeat(300)]) {
      const name = designFileNameFromTitle(title);
      const designPath = uniqueDesignPath(name, 'fig', ['designs/existing.fig']);
      expect(sanitizePath(designPath)).toBe(designPath);
      expect(validateDesignPath(designPath)).toBe(designPath);
      // `<name>-NN.fig` plus the atomic temp name stays within the 255-byte file-name limit.
      expect(bytes(`${name}-99.fig`)).toBeLessThanOrEqual(DESIGN_FILE_NAME_MAX_BYTES);
    }
  });
});
