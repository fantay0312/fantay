import { describe, expect, it } from 'vitest';
import { SOUL_LIMITS, buildCharx, readCharx, readZipIndex } from '../../src/soul/index';
import type { CharxResult } from '../../src/soul/index';
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES, concat, inflate, zip } from './fixtures/zip-writer';
import type { TestEntry } from './fixtures/zip-writer';

type Ok = Extract<CharxResult, { ok: true }>;
const NOW = 1_800_000_000_000;

function card(assets: unknown[], name = 'Mira'): string {
  return JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name, description: 'Keeps the old letters.', assets } });
}

const ASSETS = [
  { type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' },
  { type: 'emotion', uri: 'embeded://assets/emotion/happy.png', name: 'happy', ext: 'png' },
  { type: 'emotion', uri: 'embeded://assets/emotion/sad.webp', name: 'sad', ext: 'webp' },
  { type: 'emotion', uri: 'embedded://assets/emotion/blush.jpg', name: 'blush', ext: 'jpg' },
  { type: 'background', uri: 'embeded://assets/background/room.png', name: 'room', ext: 'png' },
];

function archive(cardText: string, extra: TestEntry[] = []): Uint8Array {
  return zip([
    { name: 'card.json', data: cardText, method: 8 },
    { name: 'assets/icon/images/main.png', data: PNG_BYTES, method: 8 },
    { name: 'assets/emotion/happy.png', data: PNG_BYTES },
    { name: 'assets/emotion/sad.webp', data: WEBP_BYTES, method: 8 },
    { name: 'assets/emotion/blush.jpg', data: JPEG_BYTES },
    { name: 'assets/background/room.png', data: PNG_BYTES },
    { name: 'module.risum', data: 'not an image, never read', method: 8 },
    { name: 'assets/', data: '' },
    ...extra,
  ]);
}

async function read(bytes: Uint8Array): Promise<Ok> {
  const result = await readCharx(bytes, inflate, { fileName: 'mira.charx', now: NOW });
  if (!result.ok) throw new Error(`charx failed: ${result.error}`);
  return result;
}

describe('readCharx', () => {
  it('imports the portrait and the emotion images the card plans, and reports the rest', async () => {
    const result = await read(archive(card(ASSETS)));
    if (!result.preview.ok) throw new Error('preview failed');
    expect(result.preview.name).toBe('Mira');
    expect(result.assets.map(asset => [asset.role, asset.emotion, asset.name, asset.path, asset.mime])).toEqual([
      ['portrait', undefined, 'main', 'assets/icon/images/main.png', 'image/png'],
      ['sprite', 'happy', 'happy', 'assets/emotion/happy.png', 'image/png'],
      ['sprite', 'sad', 'sad', 'assets/emotion/sad.webp', 'image/webp'],
      ['sprite', 'shy', 'blush', 'assets/emotion/blush.jpg', 'image/jpeg'],
    ]);
    expect(Array.from(result.assets[0]?.data ?? [])).toEqual(Array.from(PNG_BYTES));
    expect(Object.hasOwn(result.assets[0] ?? {}, 'emotion')).toBe(false);
    expect(result.report).toEqual([
      { path: 'assets/icon/images/main.png', action: 'imported' },
      { path: 'assets/emotion/happy.png', action: 'imported' },
      { path: 'assets/emotion/sad.webp', action: 'imported' },
      { path: 'assets/emotion/blush.jpg', action: 'imported' },
      { path: 'assets/background/room.png', action: 'skipped', reason: 'not-planned' },
      { path: 'module.risum', action: 'skipped', reason: 'not-referenced' },
    ]);
    expect(result.preview.meta.needsReview).toContainEqual({
      key: 'data.assets.4', kind: 'other', action: 'kept', summary: 'asset room (background) is not imported',
    });
    expect(result.card).toMatchObject({ spec: 'chara_card_v3', data: { name: 'Mira' } });
  });

  it('reads only card.json and the planned images', async () => {
    const seen: number[] = [];
    const counting = (data: Uint8Array, max: number) => {
      seen.push(data.length);
      return inflate(data, max);
    };
    const result = await readCharx(archive(card(ASSETS)), counting, { now: NOW });
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(3);                       // card.json, main.png and sad.webp are the deflate entries read
  });

  it('answers no-card, bad-json and the archive errors', async () => {
    const noCard = zip([{ name: 'other.json', data: card([]) }, { name: 'dir/card.json', data: card([]) }]);
    expect(await readCharx(noCard, inflate, { now: NOW })).toEqual({ ok: false, error: 'no-card' });
    const badJson = zip([{ name: 'card.json', data: '{"spec": "chara_card_v3", ' }]);
    expect(await readCharx(badJson, inflate, { now: NOW })).toEqual({ ok: false, error: 'bad-json' });
    const badCrc = zip([{ name: 'card.json', data: card([]), crc: 1 }]);
    expect(await readCharx(badCrc, inflate, { now: NOW })).toEqual({ ok: false, error: 'corrupt' });
    expect(await readCharx(PNG_BYTES, inflate, { now: NOW })).toEqual({ ok: false, error: 'not-zip' });
    expect(await readCharx(zip([{ name: 'card.json', data: '{}' }], { count: 0xffff }), inflate, { now: NOW }))
      .toEqual({ ok: false, error: 'zip64' });
    const bom = zip([{ name: 'card.json', data: `﻿${card([])}` }]);
    expect((await read(bom)).preview.ok).toBe(true);
  });

  it('hands card errors back through the preview', async () => {
    const result = await read(zip([{ name: 'card.json', data: '{"foo": 1}' }, { name: 'a.png', data: PNG_BYTES }]));
    expect(result.preview).toMatchObject({ ok: false, error: 'no-name' });
    expect(result.assets).toEqual([]);
    expect(result.report).toEqual([]);
  });

  it('reports a missing file, a non-image and unsafe entries', async () => {
    const assets = [
      { type: 'emotion', uri: 'embeded://assets/emotion/happy.png', name: 'happy' },
      { type: 'emotion', uri: 'embeded://assets/emotion/gone.png', name: 'sad' },
      { type: 'emotion', uri: 'embeded://assets/emotion/text.png', name: 'angry' },
    ];
    const result = await read(zip([
      { name: 'card.json', data: card(assets) },
      { name: 'assets/emotion/happy.png', data: PNG_BYTES },
      { name: 'assets/emotion/text.png', data: '<svg>no</svg>' },
      { name: '../evil.png', data: PNG_BYTES },
      { name: 'locked.png', data: PNG_BYTES, flags: 1 },
    ]));
    expect(result.assets.map(asset => asset.emotion)).toEqual(['happy']);
    expect(result.report).toEqual([
      { path: 'assets/emotion/happy.png', action: 'imported' },
      { path: 'assets/emotion/gone.png', action: 'skipped', reason: 'missing' },
      { path: 'assets/emotion/text.png', action: 'skipped', reason: 'not-image' },
      { path: '../evil.png', action: 'skipped', reason: 'unsafe-name' },
      { path: 'locked.png', action: 'skipped', reason: 'encrypted' },
    ]);
  });

  it('refuses an oversize image and stops at the extraction budget', async () => {
    const size = 20_900_000;                            // under charxAssetBytes; five of them exceed charxExtractBytes
    expect(size).toBeLessThanOrEqual(SOUL_LIMITS.charxAssetBytes);
    expect(size * 5).toBeGreaterThan(SOUL_LIMITS.charxExtractBytes);
    const big = new Uint8Array(size);
    big.set(PNG_BYTES);
    const tooBig = concat([big, new Uint8Array(SOUL_LIMITS.charxAssetBytes - size + 1)]);
    const emotions = ['happy', 'sad', 'angry', 'shy'];
    const assets = [
      { type: 'icon', uri: 'embeded://icon.png', name: 'main' },
      ...emotions.map(emotion => ({ type: 'emotion', uri: `embeded://${emotion}.png`, name: emotion })),
      { type: 'emotion', uri: 'embeded://sleepy.png', name: 'sleepy' },
    ];
    const result = await read(zip([
      { name: 'card.json', data: card(assets) },
      { name: 'icon.png', data: big, method: 8 },
      ...emotions.map(emotion => ({ name: `${emotion}.png`, data: big, method: 8 as const })),
      { name: 'sleepy.png', data: tooBig, method: 8 },
    ]));
    expect(result.assets.map(asset => asset.name)).toEqual(['main', 'happy', 'sad', 'angry']);
    expect(result.report.filter(item => item.action === 'skipped')).toEqual([
      { path: 'shy.png', action: 'skipped', reason: 'too-large' },
      { path: 'sleepy.png', action: 'skipped', reason: 'too-large' },
    ]);
  }, 30_000);

  it('caps the report and says how many items were left out', async () => {
    const extra = Array.from({ length: 250 }, (_, at) => ({ name: `junk/${at}.bin`, data: 'x' }));
    const result = await read(archive(card([]), extra));
    expect(result.report).toHaveLength(SOUL_LIMITS.charxReport);
    const total = 6 + 250;                              // six unreferenced files of the archive plus the junk
    expect(result.report.at(-1)).toEqual({ path: String(total - (SOUL_LIMITS.charxReport - 1)), action: 'skipped', reason: 'limit' });
  });
});

describe('buildCharx', () => {
  it('packs the card with its portrait and sprites so that readCharx gives them back', async () => {
    const exported = JSON.parse(card([
      { type: 'icon', uri: 'data:image/png;base64,AAAA', name: 'main', ext: 'png' },
      { type: 'emotion', uri: 'embeded://assets/emotion/old-happy.png', name: 'happy', ext: 'png' },
      { type: 'background', uri: 'embeded://assets/background/room.png', name: 'room', ext: 'png' },
      { type: 'icon', uri: 'ccdefault:', name: 'alt', ext: 'png' },
    ])) as Record<string, unknown>;
    const bytes = buildCharx({
      card: exported,
      portrait: WEBP_BYTES,
      sprites: { happy: PNG_BYTES, sad: JPEG_BYTES, shy: new TextEncoder().encode('not an image'), angry: null },
    });

    const index = readZipIndex(bytes);
    expect(index.ok && index.entries.map(entry => entry.name)).toEqual([
      'card.json', 'assets/icon/main.webp', 'assets/emotion/happy.png', 'assets/emotion/sad.jpeg',
    ]);
    const result = await read(bytes);
    expect(result.preview.ok && result.preview.name).toBe('Mira');
    expect(result.assets.map(asset => [asset.role, asset.emotion ?? null, asset.mime])).toEqual([
      ['portrait', null, 'image/webp'], ['sprite', 'happy', 'image/png'], ['sprite', 'sad', 'image/jpeg'],
    ]);
    expect(result.assets[0]?.data).toEqual(WEBP_BYTES);
    expect(result.report.every(item => item.action === 'imported')).toBe(true);
    // Entries that pointed into the original archive, and the ones the packed pictures replace, are gone.
    const assets = ((result.card as { data: { assets: Array<{ uri: string }> } }).data.assets).map(asset => asset.uri);
    expect(assets).toEqual([
      'embeded://assets/icon/main.webp', 'embeded://assets/emotion/happy.png', 'embeded://assets/emotion/sad.jpeg', 'ccdefault:',
    ]);
    expect(buildCharx({ card: exported, portrait: WEBP_BYTES, sprites: { happy: PNG_BYTES, sad: JPEG_BYTES } })).toEqual(bytes);
  });

  it('packs a card without pictures as card.json alone', async () => {
    const bytes = buildCharx({ card: JSON.parse(card([])) as Record<string, unknown> });
    const index = readZipIndex(bytes);
    expect(index.ok && index.entries.map(entry => entry.name)).toEqual(['card.json']);
    const result = await read(bytes);
    expect(result.assets).toEqual([]);
    expect((result.card as { data: Record<string, unknown> }).data.assets).toBeUndefined();
  });
});
