import { crc32 as zlibCrc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  PA_PLACEHOLDER_PNG,
  SOUL_LIMITS,
  base64ToBytes,
  bytesToBase64,
  crc32,
  embedCard,
  exportCharacterCard,
  extractCardJson,
  paCharacterInputSchema,
  parseCharacterCard,
  scanPng,
  seededRng,
  stripPngMetadata,
} from '../../src/soul/index';
import type { PaCharacter } from '../../src/soul/index';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const latin1 = (text: string) => Uint8Array.from(text, char => char.charCodeAt(0));
const utf8 = (text: string) => new TextEncoder().encode(text);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** One chunk built independently of the module under test (zlib's CRC-32). */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  head.set(latin1(type), 4);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, zlibCrc32(concat(latin1(type), data)));
  return concat(head, data, tail);
}

function textChunk(keyword: string, text: Uint8Array | string): Uint8Array {
  return chunk('tEXt', concat(latin1(keyword), Uint8Array.of(0), typeof text === 'string' ? latin1(text) : text));
}

const base64Of = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

/** A minimal valid 2×1 RGB PNG, optionally with extra chunks before IDAT and bytes after IEND. */
function minimalPng(extra: Uint8Array[] = [], trailing = new Uint8Array(0)): Uint8Array {
  const ihdr = Uint8Array.of(0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0);
  const scanline = Uint8Array.of(0, 255, 0, 0, 0, 0, 255);
  return concat(SIGNATURE, chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(scanline)), chunk('IEND', new Uint8Array(0)), trailing);
}

function chunkTypes(bytes: Uint8Array): string[] {
  const scan = scanPng(bytes);
  if (!scan.ok) throw new Error(`not a PNG: ${scan.error}`);
  return scan.chunks.map(entry => entry.type);
}

function textChunks(bytes: Uint8Array): Array<{ keyword: string; text: string }> {
  const scan = scanPng(bytes);
  if (!scan.ok) throw new Error('not a PNG');
  return scan.chunks.filter(entry => entry.type === 'tEXt').map(entry => {
    const data = bytes.subarray(entry.dataStart, entry.dataEnd);
    const nul = data.indexOf(0);
    return { keyword: String.fromCharCode(...data.subarray(0, nul)), text: Buffer.from(data.subarray(nul + 1)).toString('latin1') };
  });
}

const card = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '小月', description: 'Draws the moon every night.', personality: 'gentle', scenario: 'A studio by the window.',
    first_mes: 'Hi ✨', mes_example: '', tags: ['moon'], extensions: { fantay: { tagline: 'window studio' } },
  },
};

describe('crc32', () => {
  it('matches the IEND test vector and zlib', () => {
    expect(crc32(latin1('IEND'))).toBe(0xae426082);
    expect(crc32(new Uint8Array(0))).toBe(0);
    const rng = seededRng('crc');
    for (let length = 1; length < 300; length += 37) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(rng() * 256));
      expect(crc32(bytes)).toBe(zlibCrc32(bytes));
    }
  });
});

describe('scanPng', () => {
  it('walks the chunks of a minimal valid PNG and ignores trailing bytes', () => {
    const png = minimalPng([], latin1('trailing junk'));
    const scan = scanPng(png);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.chunks.map(entry => entry.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(scan.chunks[0]).toEqual({ type: 'IHDR', start: 8, dataStart: 16, dataEnd: 29 });
    expect(scan.end).toBe(png.length - 'trailing junk'.length);
  });

  it('rejects non-PNG input and corrupt chunk lengths', () => {
    expect(scanPng(latin1('GIF89a......'))).toEqual({ ok: false, error: 'not-png' });
    expect(scanPng(new Uint8Array(0))).toEqual({ ok: false, error: 'not-png' });
    const png = minimalPng();
    const lying = png.slice();
    new DataView(lying.buffer).setUint32(8, 0xfffffff0);                 // IHDR claims ~4 GB
    expect(scanPng(lying)).toEqual({ ok: false, error: 'corrupt' });
    expect(scanPng(png.subarray(0, png.length - 6))).toEqual({ ok: false, error: 'corrupt' });   // IEND cut off
    expect(scanPng(SIGNATURE)).toEqual({ ok: false, error: 'corrupt' });
  });
});

describe('extractCardJson', () => {
  it('reads chara and ccv3 chunks, prefers ccv3 and matches keywords case-insensitively', () => {
    const v2 = { spec: 'chara_card_v2', data: { name: 'Old' } };
    const both = minimalPng([textChunk('chara', base64Of(v2)), textChunk('ccv3', base64Of(card))]);
    expect(extractCardJson(both)).toEqual({ ok: true, json: card, keyword: 'ccv3' });
    expect(extractCardJson(minimalPng([textChunk('Chara', base64Of(v2))]))).toEqual({ ok: true, json: v2, keyword: 'chara' });
    const twice = minimalPng([textChunk('chara', base64Of({ name: 'first' })), textChunk('chara', base64Of({ name: 'second' }))]);
    expect(extractCardJson(twice)).toMatchObject({ ok: true, json: { name: 'first' } });
  });

  it('skips whitespace in base64 and drops a UTF-8 BOM', () => {
    const encoded = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(card))]).toString('base64');
    const wrapped = encoded.replace(/(.{60})/g, '$1\r\n');
    expect(extractCardJson(minimalPng([textChunk('ccv3', wrapped)]))).toEqual({ ok: true, json: card, keyword: 'ccv3' });
  });

  it('reports every failure without throwing', () => {
    expect(extractCardJson(latin1('not a png at all'))).toEqual({ ok: false, error: 'not-png' });
    expect(extractCardJson(minimalPng())).toEqual({ ok: false, error: 'no-card' });
    expect(extractCardJson(minimalPng([textChunk('Comment', 'hello')]))).toEqual({ ok: false, error: 'no-card' });
    const itxt = chunk('iTXt', concat(latin1('chara'), Uint8Array.of(0, 0, 0, 0, 0), latin1(base64Of(card))));
    expect(extractCardJson(minimalPng([itxt]))).toEqual({ ok: false, error: 'no-card' });
    expect(extractCardJson(minimalPng([textChunk('chara', 'eyJh*mFtZSI6')]))).toEqual({ ok: false, error: 'bad-base64' });
    expect(extractCardJson(minimalPng([textChunk('chara', Buffer.from('{"name": ').toString('base64'))]))).toEqual({ ok: false, error: 'bad-json' });
    const oversized = new Uint8Array(SOUL_LIMITS.pngCardBase64 + 4).fill(0x41);
    expect(extractCardJson(minimalPng([textChunk('chara', oversized)]))).toEqual({ ok: false, error: 'too-large' });
    const corrupt = minimalPng([textChunk('chara', base64Of(card))]);
    new DataView(corrupt.buffer).setUint32(33, 0x7fffffff);
    expect(extractCardJson(corrupt)).toEqual({ ok: false, error: 'not-png' });
  });

  it('falls back to chara when the ccv3 chunk is unreadable', () => {
    const png = minimalPng([textChunk('ccv3', '%%%'), textChunk('chara', base64Of({ name: 'kept' }))]);
    expect(extractCardJson(png)).toEqual({ ok: true, json: { name: 'kept' }, keyword: 'chara' });
    expect(extractCardJson(minimalPng([textChunk('ccv3', '%%%')]))).toEqual({ ok: false, error: 'bad-base64' });
  });
});

describe('embedCard', () => {
  it('writes ccv3 and a derived V2 chara chunk right before IEND and nothing after it', () => {
    const source = minimalPng([textChunk('Comment', 'made by hand')], latin1('trailing'));
    const out = embedCard(source, card);
    expect(chunkTypes(out)).toEqual(['IHDR', 'tEXt', 'IDAT', 'tEXt', 'tEXt', 'IEND']);
    const scan = scanPng(out);
    expect(scan.ok && scan.end).toBe(out.length);
    expect(extractCardJson(out)).toEqual({ ok: true, json: card, keyword: 'ccv3' });

    const texts = textChunks(out);
    expect(texts.map(text => text.keyword)).toEqual(['Comment', 'ccv3', 'chara']);
    const chara = JSON.parse(Buffer.from(texts[2]?.text ?? '', 'base64').toString('utf8')) as Record<string, unknown>;
    expect(chara).toEqual({
      spec: 'chara_card_v2', spec_version: '2.0', data: card.data,
      name: '小月', description: 'Draws the moon every night.', personality: 'gentle', scenario: 'A studio by the window.',
      first_mes: 'Hi ✨', mes_example: '',
    });
    // Every chunk carries a correct CRC.
    if (scan.ok) {
      for (const entry of scan.chunks) {
        const stored = new DataView(out.buffer, out.byteOffset).getUint32(entry.dataEnd);
        expect(stored).toBe(zlibCrc32(out.subarray(entry.start + 4, entry.dataEnd)));
      }
    }
  });

  it('replaces existing card chunks and drops chara-ext-asset chunks', () => {
    const source = minimalPng([
      textChunk('chara', base64Of({ name: 'old' })), textChunk('ccv3', base64Of({ name: 'old' })), textChunk('chara-ext-asset_:0', 'AAAA'),
      textChunk('Software', 'paint'),
    ]);
    const once = embedCard(source, card);
    const twice = embedCard(once, { ...card, data: { ...card.data, name: 'Renamed' } });
    expect(textChunks(twice).map(text => text.keyword)).toEqual(['Software', 'ccv3', 'chara']);
    expect(extractCardJson(twice)).toMatchObject({ ok: true, json: { data: { name: 'Renamed' } } });
  });

  it('throws only for input that is not a PNG', () => {
    expect(() => embedCard(latin1('nope'), card)).toThrow();
    expect(() => embedCard(PA_PLACEHOLDER_PNG, {})).not.toThrow();
  });

  it('carries an exported character through a PNG and back', () => {
    const character: PaCharacter = {
      id: 'agent-1', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, revision: 1,
      ...paCharacterInputSchema.parse({ description: 'Keeps the window open.', firstMessage: '你好呀', tags: ['moon'] }),
      origin: null, preserved: {}, needsReview: [],
    };
    const exported = exportCharacterCard({ name: '小月', character, lorebooks: [], now: 1_800_000_000_000 });
    const extracted = extractCardJson(embedCard(PA_PLACEHOLDER_PNG, exported));
    if (!extracted.ok) throw new Error(extracted.error);
    const preview = parseCharacterCard(extracted.json, { now: 1 });
    expect(preview).toMatchObject({ ok: true, format: 'ccv3', name: '小月', character: { firstMessage: '你好呀', tags: ['moon'] } });
  });
});

describe('stripPngMetadata', () => {
  it('keeps image chunks only and drops text and trailing bytes', () => {
    const source = minimalPng([
      chunk('pHYs', new Uint8Array(9)), textChunk('chara', base64Of(card)), chunk('eXIf', new Uint8Array(6)), chunk('zTXt', new Uint8Array(4)),
    ], latin1('junk after IEND'));
    const out = stripPngMetadata(source);
    expect(chunkTypes(out)).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
    const scan = scanPng(out);
    expect(scan.ok && scan.end).toBe(out.length);
    expect(extractCardJson(out)).toEqual({ ok: false, error: 'no-card' });
  });

  it('returns input that is not a PNG unchanged', () => {
    const bytes = latin1('plain text');
    expect(stripPngMetadata(bytes)).toBe(bytes);
  });
});

describe('PA_PLACEHOLDER_PNG', () => {
  it('is a valid 1×1 PNG', () => {
    const scan = scanPng(PA_PLACEHOLDER_PNG);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.chunks.map(entry => entry.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(scan.end).toBe(PA_PLACEHOLDER_PNG.length);
    const view = new DataView(PA_PLACEHOLDER_PNG.buffer, PA_PLACEHOLDER_PNG.byteOffset);
    for (const entry of scan.chunks) {
      expect(view.getUint32(entry.dataEnd)).toBe(zlibCrc32(PA_PLACEHOLDER_PNG.subarray(entry.start + 4, entry.dataEnd)));
    }
    const ihdr = scan.chunks[0];
    const idat = scan.chunks[1];
    if (ihdr === undefined || idat === undefined) throw new Error('missing chunks');
    expect(view.getUint32(ihdr.dataStart)).toBe(1);
    expect(view.getUint32(ihdr.dataStart + 4)).toBe(1);
    expect(Array.from(PA_PLACEHOLDER_PNG.subarray(ihdr.dataStart + 8, ihdr.dataEnd))).toEqual([8, 6, 0, 0, 0]);
    expect(Array.from(inflateSync(PA_PLACEHOLDER_PNG.subarray(idat.dataStart, idat.dataEnd)))).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('base64', () => {
  it('matches Node for every tail length and decodes back', () => {
    const rng = seededRng('b64');
    for (let length = 0; length < 40; length += 1) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(rng() * 256));
      const text = bytesToBase64(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64'));
      expect(Array.from(base64ToBytes(text) ?? [])).toEqual(Array.from(bytes));
    }
    const big = utf8('月'.repeat(20_000));
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });

  it('skips whitespace, stops at padding and rejects foreign characters', () => {
    expect(Array.from(base64ToBytes(' aGVs\nbG8= ignored after padding') ?? [])).toEqual(Array.from(utf8('hello')));
    expect(base64ToBytes('aGVsbG8')).toEqual(utf8('hello'));
    expect(base64ToBytes('aGV*bG8=')).toBeNull();
    expect(base64ToBytes('aGVs月')).toBeNull();
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });
});
