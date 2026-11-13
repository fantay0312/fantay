// Drift guard (spec 05 §9): the board generator lists a model only when the daemon dispatcher has a renderer
// for its (provider, surface) pair. `GENERATION_RENDERED_PROVIDERS` in @open-design/contracts mirrors the
// `def.provider === '…' && surface === '…'` branches of src/media/index.ts; a renderer added or removed
// there fails this test until the table is updated.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GENERATION_RENDERED_PROVIDERS } from '@open-design/contracts';
import { CATALOG_PROVIDER_SURFACES } from '../../src/media/provider-clients.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_INDEX = path.resolve(here, '../../src/media/index.ts');
const BRANCH = /def\.provider === '([\w-]+)'\s*&&\s*surface === '(image|video)'/g;

function renderedPairs(source: string): Record<'image' | 'video', Set<string>> {
  const pairs = { image: new Set<string>(), video: new Set<string>() };
  for (const surface of ['image', 'video'] as const) for (const provider of CATALOG_PROVIDER_SURFACES[surface]) pairs[surface].add(provider);
  for (const match of source.matchAll(BRANCH)) {
    const provider = match[1]!;
    const surface = match[2] as 'image' | 'video';
    // HyperFrames renders agent-authored HTML compositions, not prompts: never a board generator model.
    if (provider === 'hyperframes') continue;
    pairs[surface].add(provider);
  }
  return pairs;
}

describe('board generation renderer table', () => {
  const pairs = renderedPairs(readFileSync(MEDIA_INDEX, 'utf8'));

  it('finds the dispatcher branches (also the ones that span lines)', () => {
    expect(pairs.image.size).toBeGreaterThan(5);
    expect(pairs.video.size).toBeGreaterThan(3);
    expect(pairs.image.has('openai')).toBe(true);
  });

  it('matches GENERATION_RENDERED_PROVIDERS for images', () => {
    expect([...pairs.image].sort()).toEqual([...GENERATION_RENDERED_PROVIDERS.image].sort());
  });

  it('matches GENERATION_RENDERED_PROVIDERS for videos', () => {
    expect([...pairs.video].sort()).toEqual([...GENERATION_RENDERED_PROVIDERS.video].sort());
  });
});
