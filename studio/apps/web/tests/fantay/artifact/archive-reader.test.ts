// SPDX-License-Identifier: AGPL-3.0-only
// The archive reader lists untrusted archives without unpacking them: these pin the formats it
// reads, the limits it keeps and what it does with paths that try to leave the folder.
import { gzipSync, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  ArchiveError,
  cleanArchivePath,
  decodeEntryName,
  looksLikeTarHeader,
  openArchive,
} from '../../../src/fantay/artifact/viewers/archive/archive-reader';

/** One tar header block (ustar) for `name`, followed by the padded data. */
function tarEntry(name: string, data: Uint8Array, type = '0', extra: { link?: string; prefix?: string } = {}): Uint8Array {
  const header = new Uint8Array(512);
  const put = (text: string, offset: number): void => {
    header.set(new TextEncoder().encode(text), offset);
  };
  put(name, 0);
  put('0000644\0', 100);
  put('0000000\0', 108);
  put('0000000\0', 116);
  put(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  put(`${(1_700_000_000).toString(8).padStart(11, '0')}\0`, 136);
  put('        ', 148);
  put(type, 156);
  if (extra.link) put(extra.link, 157);
  put('ustar\0', 257);
  put('00', 263);
  if (extra.prefix) put(extra.prefix, 345);
  let sum = 0;
  for (const byte of header) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const padded = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
  padded.set(header, 0);
  padded.set(data, 512);
  return padded;
}

function tar(...entries: Uint8Array[]): Uint8Array {
  const total = entries.reduce((sum, entry) => sum + entry.length, 0) + 1024;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    out.set(entry, offset);
    offset += entry.length;
  }
  return out;
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ArchiveError ? error.code : `other: ${String(error)}`;
  }
  return 'no error';
}

describe('cleanArchivePath', () => {
  it('keeps a plain relative path', () => {
    expect(cleanArchivePath('site/css/app.css')).toEqual({ path: 'site/css/app.css', unsafe: false, dir: false });
  });

  it('makes absolute and climbing paths relative and flags them', () => {
    expect(cleanArchivePath('/etc/passwd')).toEqual({ path: 'etc/passwd', unsafe: true, dir: false });
    expect(cleanArchivePath('../../home/.ssh/keys')).toEqual({ path: 'home/.ssh/keys', unsafe: true, dir: false });
    expect(cleanArchivePath('C:\\Windows\\system.ini', true)).toEqual({ path: 'Windows/system.ini', unsafe: true, dir: false });
  });

  it('drops empty and "." parts and notes a folder', () => {
    expect(cleanArchivePath('./docs//guide/')).toEqual({ path: 'docs/guide', unsafe: false, dir: true });
  });

  it('keeps a backslash that is part of a Unix file name', () => {
    expect(cleanArchivePath('notes\\draft.txt').path).toBe('notes\\draft.txt');
  });
});

describe('decodeEntryName', () => {
  it('reads UTF-8 without being told', () => {
    expect(decodeEntryName(new TextEncoder().encode('素材/海报.png'))).toBe('素材/海报.png');
  });

  it('falls back to GBK for names written by Windows tools', () => {
    // "中文.txt" in GBK.
    expect(decodeEntryName(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x74, 0x78, 0x74]))).toBe('中文.txt');
  });
});

describe('openArchive: zip', () => {
  const bytes = zipSync({
    'site/index.html': strToU8('<h1>hi</h1>'),
    'site/css/app.css': strToU8('body { margin: 0 }'.repeat(50)),
    '素材/说明.txt': strToU8('手冲咖啡'),
    'empty/': new Uint8Array(0),
  });

  it('lists entries with sizes without unpacking', () => {
    const { listing } = openArchive(bytes, 'pack.zip');
    expect(listing.format).toBe('zip');
    expect(listing.fileCount).toBe(3);
    expect(listing.totalSize).toBe(11 + 18 * 50 + 12);
    const css = listing.entries.find((entry) => entry.path === 'site/css/app.css');
    expect(css?.size).toBe(900);
    expect(css?.packedSize).toBeLessThan(900);
    expect(listing.entries.find((entry) => entry.path === 'empty')?.kind).toBe('dir');
    expect(listing.entries.some((entry) => entry.path === '素材/说明.txt')).toBe(true);
  });

  it('reads one entry on demand', () => {
    const archive = openArchive(bytes, 'pack.zip');
    const entry = archive.listing.entries.find((item) => item.path === '素材/说明.txt');
    expect(new TextDecoder().decode(archive.read(entry?.id ?? -1, 1024))).toBe('手冲咖啡');
  });

  it('refuses an entry over the limit, by its stated size and by what really comes out', () => {
    const bomb = zipSync({ 'zeros.bin': new Uint8Array(4 * 1024 * 1024) });
    const archive = openArchive(bomb, 'bomb.zip');
    expect(failure(() => archive.read(0, 1024 * 1024))).toBe('too-large');
    // The directory lies about the size: patch the stated size to 10 bytes.
    const lying = bomb.slice();
    const view = new DataView(lying.buffer);
    for (let at = lying.length - 22; at >= 0; at -= 1) {
      if (view.getUint32(at, true) === 0x02014b50) {
        view.setUint32(at + 24, 10, true);
        break;
      }
    }
    const liar = openArchive(lying, 'bomb.zip');
    expect(liar.listing.entries[0]?.size).toBe(10);
    expect(failure(() => liar.read(0, 1024 * 1024))).toBe('too-large');
  });

  it('flags paths that try to leave the folder', () => {
    const evil = zipSync({ '../../outside.txt': strToU8('x'), 'fine.txt': strToU8('y') });
    const { listing } = openArchive(evil, 'evil.zip');
    expect(listing.unsafePaths).toBe(1);
    expect(listing.entries.map((entry) => entry.path).sort()).toEqual(['fine.txt', 'outside.txt']);
  });

  it('lists a password-protected entry but will not read it', () => {
    const locked = zipSync({ 'secret.txt': strToU8('secret') }).slice();
    const view = new DataView(locked.buffer);
    for (let at = 0; at < locked.length - 4; at += 1) {
      const signature = view.getUint32(at, true);
      if (signature === 0x04034b50) view.setUint16(at + 6, view.getUint16(at + 6, true) | 1, true);
      if (signature === 0x02014b50) view.setUint16(at + 8, view.getUint16(at + 8, true) | 1, true);
    }
    const archive = openArchive(locked, 'locked.zip');
    expect(archive.listing.encryptedCount).toBe(1);
    expect(failure(() => archive.read(0, 1024))).toBe('encrypted');
  });

  it('stops listing at the entry limit and says so', () => {
    const many: Record<string, Uint8Array> = {};
    for (let index = 0; index < 30; index += 1) many[`f${index}.txt`] = strToU8('x');
    const { listing } = openArchive(zipSync(many), 'many.zip', { maxEntries: 10 });
    expect(listing.entries).toHaveLength(10);
    expect(listing.truncated).toBe(true);
  });

  it('opens an empty zip', () => {
    expect(openArchive(zipSync({}), 'empty.zip').listing.entries).toEqual([]);
  });

  it('rejects bytes that are not an archive', () => {
    expect(failure(() => openArchive(strToU8('Rar!\x1a\x07\x00 not a zip at all'), 'fake.zip', { hint: 'zip' }))).toBe('invalid');
    expect(failure(() => openArchive(new Uint8Array(0), 'empty.tar'))).toBe('invalid');
  });
});

describe('openArchive: tar', () => {
  const bytes = tar(
    tarEntry('site/', new Uint8Array(0), '5'),
    tarEntry('site/index.html', strToU8('<h1>hi</h1>')),
    tarEntry('logo.png', new Uint8Array(700), '0', { prefix: 'site/assets' }),
    tarEntry('site/current', new Uint8Array(0), '2', { link: 'index.html' }),
  );

  it('lists files, folders and links', () => {
    expect(looksLikeTarHeader(bytes.subarray(0, 512))).toBe(true);
    const { listing } = openArchive(bytes, 'site.tar');
    expect(listing.format).toBe('tar');
    expect(listing.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      'dir:site',
      'file:site/index.html',
      'file:site/assets/logo.png',
      'link:site/current',
    ]);
    const link = listing.entries.find((entry) => entry.kind === 'link');
    expect(link?.linkTarget).toBe('index.html');
    expect(listing.entries[1]?.modified).toBe(1_700_000_000_000);
    expect(listing.totalSize).toBe(11 + 700);
  });

  it('reads a file and never a link', () => {
    const archive = openArchive(bytes, 'site.tar');
    expect(new TextDecoder().decode(archive.read(1, 1024))).toBe('<h1>hi</h1>');
    expect(failure(() => archive.read(3, 1024))).toBe('missing');
    expect(failure(() => archive.read(2, 100))).toBe('too-large');
  });

  it('takes a GNU long name from the entry before it', () => {
    const long = `${'deep/'.repeat(30)}file.txt`;
    const withLong = tar(tarEntry('././@LongLink', strToU8(`${long}\0`), 'L'), tarEntry('truncated', strToU8('ok')));
    const { listing } = openArchive(withLong, 'long.tar');
    expect(listing.entries[0]?.path).toBe(long);
  });

  it('takes path and size from a pax header', () => {
    // A pax record is "<length> <key>=<value>\n", where the length counts the record's own bytes.
    const record = (key: string, value: string): string => {
      const body = ` ${key}=${value}\n`;
      const bytes = (text: string): number => new TextEncoder().encode(text).length;
      let length = bytes(body) + 1;
      while (bytes(`${length}${body}`) !== length) length = bytes(`${length}${body}`);
      return `${length}${body}`;
    };
    const withPax = tar(tarEntry('PaxHeader', strToU8(record('path', '文档/说明.md')), 'x'), tarEntry('x', strToU8('# 说明')));
    const archive = openArchive(withPax, 'pax.tar');
    expect(archive.listing.entries[0]?.path).toBe('文档/说明.md');
    expect(new TextDecoder().decode(archive.read(archive.listing.entries[0]?.id ?? -1, 1024))).toBe('# 说明');
  });
});

describe('openArchive: gzip', () => {
  it('lists a tar inside a gzip and reads from it', () => {
    const inner = tar(tarEntry('a.txt', strToU8('alpha')), tarEntry('b/c.txt', strToU8('gamma')));
    const archive = openArchive(gzipSync(inner), 'pack.tgz');
    expect(archive.listing.format).toBe('tar.gz');
    expect(archive.listing.entries.map((entry) => entry.path)).toEqual(['a.txt', 'b/c.txt']);
    expect(new TextDecoder().decode(archive.read(1, 1024))).toBe('gamma');
  });

  it('shows a single compressed file under its own name', () => {
    const archive = openArchive(gzipSync(strToU8('line\n'.repeat(100))), 'logs/app.log.gz');
    expect(archive.listing.format).toBe('gz');
    expect(archive.listing.entries).toHaveLength(1);
    expect(archive.listing.entries[0]?.path).toBe('app.log');
    expect(archive.listing.entries[0]?.size).toBe(500);
    expect(archive.read(0, 1024).length).toBe(500);
    expect(failure(() => archive.read(0, 100))).toBe('too-large');
  });

  it('rejects a damaged stream', () => {
    const broken = gzipSync(strToU8('x'.repeat(4000))).slice(0, 20);
    expect(failure(() => openArchive(broken, 'broken.gz').read(0, 1 << 20))).toBe('invalid');
  });
});
