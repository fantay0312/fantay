// SPDX-License-Identifier: AGPL-3.0-only
// The archive listing's tree and its "what does selecting this show" decision.
import { describe, expect, it } from 'vitest';

import { decodePeekText, planPeek } from '../../../src/fantay/artifact/viewers/archive/archive-peek';
import type { ArchiveEntry, ArchiveListing } from '../../../src/fantay/artifact/viewers/archive/archive-reader';
import { buildArchiveTree, initialExpansion } from '../../../src/fantay/artifact/viewers/archive/archive-tree';

function entry(path: string, size = 10, extra: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return { id: 0, path, kind: 'file', size, packedSize: size, modified: null, encrypted: false, linkTarget: null, ...extra };
}

function listing(entries: ArchiveEntry[]): ArchiveListing {
  return {
    format: 'zip',
    entries: entries.map((item, id) => ({ ...item, id })),
    fileCount: entries.filter((item) => item.kind !== 'dir').length,
    totalSize: entries.reduce((sum, item) => sum + item.size, 0),
    truncated: false,
    unsafePaths: 0,
    encryptedCount: 0,
  };
}

describe('buildArchiveTree', () => {
  const tree = buildArchiveTree(
    listing([
      entry('site/index.html', 100),
      entry('site/css/app.css', 40),
      entry('site/css/print.css', 60),
      entry('README.md', 5),
      entry('empty', 0, { kind: 'dir' }),
    ]),
  );

  it('puts folders first and totals what is inside each', () => {
    expect(tree.roots.map((node) => `${node.kind}:${node.label}`)).toEqual(['dir:empty', 'dir:site', 'file:README.md']);
    expect(tree.folders.get('site')).toEqual({ size: 200, files: 3 });
    expect(tree.folders.get('site/css')).toEqual({ size: 100, files: 2 });
    expect(tree.folders.get('empty')).toEqual({ size: 0, files: 0 });
  });

  it('finds the entry behind a file row', () => {
    expect(tree.files.get('site/css/app.css')?.size).toBe(40);
    expect(tree.files.has('site')).toBe(false);
  });

  it('opens every folder of a small archive', () => {
    expect(initialExpansion(tree).sort()).toEqual(['empty', 'site', 'site/css']);
  });

  it('opens only the wrapping folders of a large archive', () => {
    const many = Array.from({ length: 200 }, (_, index) => entry(`pkg-1.0/src/part${index % 10}/file${index}.ts`));
    const large = buildArchiveTree(listing([...many, entry('pkg-1.0/README.md')]));
    // "pkg-1.0" holds a folder and a file, so it is the last level opened.
    expect(initialExpansion(large)).toEqual(['pkg-1.0']);
  });
});

describe('planPeek', () => {
  it('reads text and code as text', () => {
    expect(planPeek(entry('src/app.ts')).kind).toBe('text');
    expect(planPeek(entry('notes/README.md')).kind).toBe('text');
    expect(planPeek(entry('data/orders.csv')).kind).toBe('text');
    expect(planPeek(entry('index.html')).kind).toBe('text');
  });

  it('shows pictures the browser decodes, with their type', () => {
    expect(planPeek(entry('img/海报.png'))).toMatchObject({ kind: 'image', mime: 'image/png' });
    expect(planPeek(entry('logo.svg'))).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
    expect(planPeek(entry('photo.heic'))).toEqual({ kind: 'facts', reason: 'type' });
  });

  it('never unpacks what is too large, locked, a link or a folder', () => {
    expect(planPeek(entry('big.log', 5 * 1024 * 1024))).toEqual({ kind: 'facts', reason: 'too-large' });
    expect(planPeek(entry('huge.png', 20 * 1024 * 1024))).toEqual({ kind: 'facts', reason: 'too-large' });
    expect(planPeek(entry('secret.txt', 10, { encrypted: true }))).toEqual({ kind: 'facts', reason: 'encrypted' });
    expect(planPeek(entry('current', 0, { kind: 'link', linkTarget: 'v2' }))).toEqual({ kind: 'facts', reason: 'link' });
    expect(planPeek(entry('docs', 0, { kind: 'dir' }))).toEqual({ kind: 'facts', reason: 'folder' });
  });

  it('lets the bytes decide for a name that says nothing, and skips known binary types', () => {
    expect(planPeek(entry('bin/tool')).kind).toBe('sniff');
    expect(planPeek(entry('report.pdf'))).toEqual({ kind: 'facts', reason: 'type' });
    expect(planPeek(entry('clip.mp4'))).toEqual({ kind: 'facts', reason: 'type' });
  });
});

describe('decodePeekText', () => {
  it('reads UTF-8 and UTF-16 with a byte-order mark', () => {
    expect(decodePeekText(new TextEncoder().encode('手冲咖啡'))).toBe('手冲咖啡');
    expect(decodePeekText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]))).toBe('AB');
  });

  it('refuses bytes that were never text', () => {
    expect(decodePeekText(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00, 0x01, 0x00]))).toBeNull();
  });
});
