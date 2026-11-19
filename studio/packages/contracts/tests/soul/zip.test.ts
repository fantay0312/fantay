import { describe, expect, it } from 'vitest';
import { isZipLike, readZipEntry, readZipIndex, safeZipName } from '../../src/soul/index';
import type { ZipIndex } from '../../src/soul/index';
import { PNG_BYTES, inflate, zip } from './fixtures/zip-writer';

type Index = Extract<ZipIndex, { ok: true }>;
const text = (data: Uint8Array) => new TextDecoder().decode(data);

function index(bytes: Uint8Array, limits?: Parameters<typeof readZipIndex>[1]): Index {
  const result = readZipIndex(bytes, limits);
  if (!result.ok) throw new Error(`zip index failed: ${result.error}`);
  return result;
}

async function readNamed(bytes: Uint8Array, name: string, max = 1 << 20) {
  const idx = index(bytes);
  const entry = idx.entries.find(item => item.name === name);
  if (!entry) throw new Error(`no entry ${name}`);
  return readZipEntry(bytes, idx, entry, inflate, max);
}

describe('readZipIndex and readZipEntry', () => {
  it('round-trips stored and deflate entries', async () => {
    const body = '你好，archive。'.repeat(500);
    const bytes = zip([
      { name: 'card.json', data: '{"a":1}' },
      { name: 'assets/long.txt', data: body, method: 8 },
      { name: 'assets/', data: '' },
    ]);
    const idx = index(bytes);
    expect(idx.base).toBe(0);
    expect(idx.entries.map(entry => [entry.name, entry.method, entry.directory])).toEqual([
      ['card.json', 0, false], ['assets/long.txt', 8, false], ['assets/', 0, true],
    ]);
    expect(idx.skipped).toEqual([]);
    const stored = await readNamed(bytes, 'card.json');
    expect(stored.ok && text(stored.data)).toBe('{"a":1}');
    const deflated = await readNamed(bytes, 'assets/long.txt');
    expect(deflated.ok && text(deflated.data)).toBe(body);
    const dir = idx.entries[2];
    if (!dir) throw new Error('no dir');
    expect(await readZipEntry(bytes, idx, dir, inflate, 100)).toEqual({ ok: false, error: 'corrupt' });
  });

  it('reads an archive behind a 512-byte prefix and with a comment', async () => {
    const bytes = zip([{ name: 'a.png', data: PNG_BYTES, method: 8 }], { prefix: 512, comment: 'made by a test' });
    const idx = index(bytes);
    expect(idx.base).toBe(512);
    const read = await readNamed(bytes, 'a.png');
    expect(read.ok && Array.from(read.data)).toEqual(Array.from(PNG_BYTES));
    expect(isZipLike(bytes)).toBe(true);
  });

  it('skips unsafe names, duplicates, encrypted entries, unknown methods and zip64 fields', () => {
    const bytes = zip([
      { name: 'ok.txt', data: 'first' },
      { name: '../x', data: 'x' }, { name: '/x', data: 'x' }, { name: 'a\\b', data: 'x' }, { name: 'C:x', data: 'x' },
      { name: 'a/./b', data: 'x' }, { name: 'a/../b', data: 'x' }, { name: '', data: 'x' },
      { name: 'ok.txt', data: 'second' },
      { name: 'secret.txt', data: 'x', flags: 1 },
      { name: 'lzma.bin', data: 'x', methodField: 12 },
      { name: 'big.bin', data: 'x', size: 0xffffffff },
    ]);
    const idx = index(bytes);
    expect(idx.entries.map(entry => entry.name)).toEqual(['ok.txt']);
    expect(idx.skipped).toEqual([
      { name: '../x', reason: 'unsafe-name' }, { name: '/x', reason: 'unsafe-name' }, { name: 'a\\b', reason: 'unsafe-name' },
      { name: 'C:x', reason: 'unsafe-name' }, { name: 'a/./b', reason: 'unsafe-name' }, { name: 'a/../b', reason: 'unsafe-name' },
      { name: '', reason: 'unsafe-name' },
      { name: 'ok.txt', reason: 'duplicate' }, { name: 'secret.txt', reason: 'encrypted' }, { name: 'lzma.bin', reason: 'method' },
      { name: 'big.bin', reason: 'zip64' },
    ]);
  });

  it('answers the archive-level errors', () => {
    const one = [{ name: 'a.txt', data: 'a' }];
    expect(readZipIndex(zip(one, { count: 0xffff }))).toEqual({ ok: false, error: 'zip64' });
    expect(readZipIndex(zip(one, { truncateCentral: 20 }))).toEqual({ ok: false, error: 'corrupt' });
    expect(readZipIndex(zip(one, { cdOffset: 1_000_000 }))).toEqual({ ok: false, error: 'corrupt' });
    expect(readZipIndex(zip(one, { count: 2 }))).toEqual({ ok: false, error: 'corrupt' });
    const many = Array.from({ length: 6 }, (_, at) => ({ name: `f${at}`, data: 'x' }));
    expect(readZipIndex(zip(many), { maxEntries: 5 })).toEqual({ ok: false, error: 'too-many' });
    expect(readZipIndex(zip(one), { maxBytes: 10 })).toEqual({ ok: false, error: 'too-large' });
    expect(readZipIndex(new Uint8Array(10))).toEqual({ ok: false, error: 'not-zip' });
    expect(readZipIndex(new TextEncoder().encode('{"spec":"chara_card_v3","data":{}}'))).toEqual({ ok: false, error: 'not-zip' });
    expect(readZipIndex('PK' as unknown as Uint8Array)).toEqual({ ok: false, error: 'not-zip' });
  });

  it('refuses entries whose header or data lies outside the archive, a wrong CRC and a bomb', async () => {
    const pastEnd = zip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'x', offset: 4096 }]);
    expect(await readNamed(pastEnd, 'b.txt')).toEqual({ ok: false, error: 'corrupt' });
    const longer = zip([{ name: 'a.txt', data: 'hello', compressedSize: 5000 }]);
    expect(await readNamed(longer, 'a.txt')).toEqual({ ok: false, error: 'corrupt' });
    const wrongSize = zip([{ name: 'a.txt', data: 'hello', method: 8, size: 4 }]);
    expect(await readNamed(wrongSize, 'a.txt')).toEqual({ ok: false, error: 'corrupt' });
    const badCrc = zip([{ name: 'a.txt', data: 'hello', crc: 12345 }]);
    expect(await readNamed(badCrc, 'a.txt')).toEqual({ ok: false, error: 'crc' });
    const notDeflate = zip([{ name: 'a.txt', data: 'not deflate data', methodField: 8 }]);
    expect(await readNamed(notDeflate, 'a.txt')).toEqual({ ok: false, error: 'inflate' });

    const zeros = new Uint8Array(5 * 1024 * 1024);
    const bomb = zip([{ name: 'bomb.bin', data: zeros, method: 8 }]);
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(await readNamed(bomb, 'bomb.bin', 1024 * 1024)).toEqual({ ok: false, error: 'too-large' });
    // A central directory that hides the size: the capped inflate still stops it.
    const hidden = zip([{ name: 'bomb.bin', data: zeros, method: 8, size: 0 }]);
    const capped = await readNamed(hidden, 'bomb.bin', 1024 * 1024);
    expect(capped.ok).toBe(false);
    const idx = index(hidden);
    const entry = idx.entries[0];
    if (!entry) throw new Error('no entry');
    const overrun = (_: Uint8Array, max: number) => new Uint8Array(max + 1);
    expect(await readZipEntry(hidden, idx, entry, overrun, 1024 * 1024)).toEqual({ ok: false, error: 'too-large' });
    const stored = zip([{ name: 'big.txt', data: 'x'.repeat(2000), size: 0 }]);
    expect(await readNamed(stored, 'big.txt', 1000)).toEqual({ ok: false, error: 'too-large' });
    const throwing = () => { throw new Error('boom'); };
    const deflated = zip([{ name: 'a.txt', data: 'hi', method: 8 }]);
    const deflatedIdx = index(deflated);
    expect(await readZipEntry(deflated, deflatedIdx, deflatedIdx.entries[0]!, throwing, 100)).toEqual({ ok: false, error: 'inflate' });
  });
});

describe('isZipLike and safeZipName', () => {
  it('finds an end record only in archives', () => {
    expect(isZipLike(zip([{ name: 'a', data: 'b' }]))).toBe(true);
    expect(isZipLike(PNG_BYTES)).toBe(false);
    expect(isZipLike(new TextEncoder().encode(JSON.stringify({ name: 'x', data: 'PK' })))).toBe(false);
    expect(isZipLike(new Uint8Array(0))).toBe(false);
  });

  it('accepts plain relative names only', () => {
    expect(safeZipName('card.json')).toBe('card.json');
    expect(safeZipName('assets/icon/images/main.png')).toBe('assets/icon/images/main.png');
    expect(safeZipName('assets/')).toBe('assets/');
    expect(safeZipName('a..b/c')).toBe('a..b/c');
    for (const bad of ['', '/card.json', './card.json', 'a/..', '..', 'a/./b', 'C:card.json', 'a\\card.json', 'a\0b']) {
      expect(safeZipName(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(safeZipName('名'.repeat(171))).toBeNull();                   // 513 bytes
    expect(safeZipName('名'.repeat(170))).toBe('名'.repeat(170));
    expect(safeZipName('abcd', 3)).toBeNull();
  });
});
