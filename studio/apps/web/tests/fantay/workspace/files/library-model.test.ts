// SPDX-License-Identifier: AGPL-3.0-only
// Pure model tests for the Files library: file classification, recursive folder counts, filter
// counts that stay stable during search, sorting, middle truncation, writing-state windowing,
// per-project preferences, and structural text/page/table sketches.
import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectFile, ProjectFolder } from '../../../../src/types';
import {
  SORT_START,
  WRITING_WINDOW_MS,
  buildLibraryScope,
  describeLibraryFile,
  indexLibraryFolders,
  libraryCrumbs,
  nearestExistingDir,
  relativeTime,
  selectLibraryView,
  splitDisplayName,
  writingFiles,
} from '../../../../src/fantay/workspace/files/library-model';
import {
  readLibraryPrefs,
  resetLibraryStoreForTests,
  writeLibraryPrefs,
} from '../../../../src/fantay/workspace/files/library-store';
import {
  looksBinary,
  sketchLines,
  sketchMarkdown,
  sketchPage,
  sketchTable,
} from '../../../../src/fantay/workspace/files/text-sketch';

function makeFile(name: string, overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    name,
    path: name,
    type: 'file',
    size: 1024,
    mtime: 1_700_000_000_000,
    kind: name.endsWith('.html') ? 'html' : 'binary',
    mime: 'application/octet-stream',
    ...overrides,
  };
}

afterEach(() => {
  resetLibraryStoreForTests();
});

describe('library-model', () => {
  it('computes recursive file counts and latest mtimes for nested and empty folders', () => {
    const files = [
      makeFile('office/reports/q3.pdf', { mtime: 2000 }),
      makeFile('office/reports/q4.docx', { mtime: 5000 }),
      makeFile('office/budget.xlsx', { mtime: 3000 }),
      makeFile('images/hero.png', { mtime: 4000 }),
    ];
    const folders: ProjectFolder[] = [
      { name: 'office', path: 'office', type: 'dir', size: 0, mtime: 1000 },
      { name: 'nested-empty', path: 'empty-dir/nested-empty', type: 'dir', size: 0, mtime: 6000 },
    ];

    const index = indexLibraryFolders(files, folders);
    expect(index.get('office')).toEqual({ path: 'office', label: 'office', fileCount: 3, mtime: 5000 });
    expect(index.get('office/reports')).toEqual({ path: 'office/reports', label: 'reports', fileCount: 2, mtime: 5000 });
    expect(index.get('images')).toEqual({ path: 'images', label: 'images', fileCount: 1, mtime: 4000 });
    expect(index.get('empty-dir')).toEqual({ path: 'empty-dir', label: 'empty-dir', fileCount: 0, mtime: 6000 });
    expect(index.get('empty-dir/nested-empty')).toEqual({
      path: 'empty-dir/nested-empty',
      label: 'nested-empty',
      fileCount: 0,
      mtime: 6000,
    });

    expect(nearestExistingDir('office/reports/gone', index)).toBe('office/reports');
    expect(nearestExistingDir('missing/deep', index)).toBe('');
  });

  it('keeps filter counts scoped to the folder and unchanged by search queries', () => {
    const raw = [
      makeFile('landing.html'),
      makeFile('docs/readme.md'),
      makeFile('docs/spec.pdf'),
      makeFile('data/metrics.csv'),
      makeFile('src/index.ts'),
      makeFile('media/clip.mp4'),
    ];
    const described = raw.map(describeLibraryFile);
    const index = indexLibraryFolders(raw, undefined);
    const rootScope = buildLibraryScope(described, index, '');

    expect(rootScope.counts.all).toBe(6);
    expect(rootScope.counts.page).toBe(1);
    expect(rootScope.counts.document).toBe(2);
    expect(rootScope.counts.sheet).toBe(1);
    expect(rootScope.counts.code).toBe(1);
    expect(rootScope.counts.media).toBe(1);
    expect(rootScope.filters).toEqual(['all', 'page', 'document', 'sheet', 'code', 'media']);

    const searched = selectLibraryView(rootScope, {
      filter: 'all',
      query: 'spec',
      sort: { key: 'name', direction: 'asc' },
    });
    expect(searched.files.map((item) => item.path)).toEqual(['docs/spec.pdf']);
    // Counts on scope stay unchanged while searching.
    expect(rootScope.counts.document).toBe(2);

    const filtered = selectLibraryView(rootScope, {
      filter: 'document',
      query: '',
      sort: { key: 'name', direction: 'asc' },
    });
    expect(filtered.folders).toEqual([]);
    expect(filtered.files.map((item) => item.path)).toEqual(['docs/readme.md', 'docs/spec.pdf']);
  });

  it('sorts naturally by name, size, modified time and type', () => {
    const raw = [
      makeFile('slide10.pptx', { size: 300, mtime: 100 }),
      makeFile('slide2.pptx', { size: 900, mtime: 300 }),
      makeFile('notes.md', { size: 100, mtime: 200 }),
    ];
    const scope = buildLibraryScope(raw.map(describeLibraryFile), indexLibraryFolders(raw, undefined), '');

    expect(
      selectLibraryView(scope, { filter: 'all', query: '', sort: { key: 'name', direction: 'asc' } }).files.map((f) => f.path),
    ).toEqual(['notes.md', 'slide2.pptx', 'slide10.pptx']);

    expect(
      selectLibraryView(scope, { filter: 'all', query: '', sort: { key: 'size', direction: SORT_START.size } }).files.map(
        (f) => f.path,
      ),
    ).toEqual(['slide2.pptx', 'slide10.pptx', 'notes.md']);

    expect(
      selectLibraryView(scope, {
        filter: 'all',
        query: '',
        sort: { key: 'modified', direction: SORT_START.modified },
      }).files.map((f) => f.path),
    ).toEqual(['slide2.pptx', 'notes.md', 'slide10.pptx']);
  });

  it('splits long names at code-point boundaries, formats crumbs/times, and marks active writes', () => {
    expect(libraryCrumbs('office/2026/q3')).toEqual([
      { label: 'office', path: 'office' },
      { label: '2026', path: 'office/2026' },
      { label: 'q3', path: 'office/2026/q3' },
    ]);
    expect(splitDisplayName('short.pdf')).toEqual({ head: 'short.pdf', tail: '' });
    const split = splitDisplayName('季度复盘-非常长的项目总结终稿.pdf', 2);
    expect(`${split.head}${split.tail}`).toBe('季度复盘-非常长的项目总结终稿.pdf');
    expect(split.tail).toBe('终稿.pdf');

    expect(relativeTime(10_000, 30_000)).toEqual({ unit: 'now' });
    expect(relativeTime(0, 5 * 60_000)).toEqual({ unit: 'minutes', n: 5 });

    const now = 1_000_000;
    const files = [
      makeFile('fresh.html', { mtime: now - 5_000 }),
      makeFile('stale-in-turn.html', { mtime: now - WRITING_WINDOW_MS - 1_000 }),
      makeFile('before-turn.html', { mtime: now - 90_000 }),
    ];
    expect([...writingFiles(files, { running: true, startedAt: now - 60_000, now })]).toEqual(['fresh.html']);
    expect([...writingFiles(files, { running: false, startedAt: now - 60_000, now })]).toEqual([]);
  });

  it('remembers library preferences per project and inherits last chosen view mode', () => {
    const initial = readLibraryPrefs('proj-a');
    expect(initial.view).toBe('grid');
    writeLibraryPrefs('proj-a', { ...initial, view: 'list', query: 'hero' });
    expect(readLibraryPrefs('proj-a').query).toBe('hero');
    expect(readLibraryPrefs('proj-b').view).toBe('list');
  });
});

describe('text-sketch', () => {
  it('detects binary content and sketches code, markdown, CSV and HTML safely', () => {
    expect(looksBinary('plain utf-8 text\nline two')).toBe(false);
    expect(looksBinary('has\u0000nul')).toBe(true);

    expect(sketchLines('\n\n\tconst x = 1;   \nconst y = 2;')).toEqual(['  const x = 1;', 'const y = 2;']);

    const md = sketchMarkdown('---\ntitle: Ignored\n---\n# Overview\n- First item\n> A note\n```ts\nconst n = 1;\n```');
    expect(md).toEqual([
      { kind: 'heading', text: 'Overview', level: 1 },
      { kind: 'item', text: 'First item' },
      { kind: 'quote', text: 'A note' },
      { kind: 'code', text: 'const n = 1;' },
    ]);

    expect(sketchTable('city,users\n"Shanghai, CN",3860\nHangzhou,2240')).toEqual([
      ['city', 'users'],
      ['Shanghai, CN', '3860'],
      ['Hangzhou', '2240'],
    ]);

    const page = sketchPage('<html><head><title>Pricing</title><script>alert(1)</script></head><body><h1>Pricing</h1><p>Simple plans.</p><button>Start</button></body></html>');
    expect(page.title).toBe('Pricing');
    expect(page.blocks).toEqual([
      { kind: 'text', text: 'Simple plans.' },
      { kind: 'button', text: 'Start' },
    ]);
  });
});
