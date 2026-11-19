// SPDX-License-Identifier: AGPL-3.0-only
// Which files the 代码 surface reads as text. The daemon's kind is a coarse viewer bucket, so the
// name decides for everything it calls "binary".
import { Database, File, FileCode, FileImage, FileText } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { getFileVisualKind, pickFileIcon } from '../../../../src/fantay/workspace/code/file-visual';
import {
  MAX_TEXT_BYTES,
  MAX_UNKNOWN_TEXT_BYTES,
  classifyProjectFile,
  isTextFileName,
  looksBinary,
} from '../../../../src/fantay/workspace/code/text-preview';
import type { ProjectFile } from '../../../../src/types';

function file(name: string, kind: ProjectFile['kind'], extra: Partial<ProjectFile> = {}): ProjectFile {
  return { name, size: 100, mtime: 1, kind, mime: 'application/octet-stream', ...extra };
}

describe('isTextFileName', () => {
  it('knows source, config and document extensions', () => {
    for (const name of ['a.tsx', 'src/b.jsx', 'c.yaml', 'd.toml', 'e.go', 'f.rs', 'g.scss', 'h.md', 'i.csv', 'pnpm-lock.lock']) {
      expect(isTextFileName(name), name).toBe(true);
    }
  });

  it('knows dotfiles and extension-less names', () => {
    for (const name of ['.gitignore', '.env', '.env.local', 'config/.prettierrc.json', 'Dockerfile', 'Makefile', 'LICENSE', 'docs/README']) {
      expect(isTextFileName(name), name).toBe(true);
    }
  });

  it('does not vouch for unknown names', () => {
    for (const name of ['archive.zip', 'font.woff2', 'data.bin', 'photo.png', '.DS_Store', 'noextension']) {
      expect(isTextFileName(name), name).toBe(false);
    }
  });
});

describe('classifyProjectFile', () => {
  it('reads the text kinds as text', () => {
    expect(classifyProjectFile(file('index.html', 'html'))).toBe('text');
    expect(classifyProjectFile(file('notes.md', 'text'))).toBe('text');
    expect(classifyProjectFile(file('app.ts', 'code'))).toBe('text');
  });

  it('refuses media and office kinds', () => {
    for (const kind of ['image', 'video', 'audio', 'pdf', 'document', 'presentation', 'spreadsheet'] as const) {
      expect(classifyProjectFile(file(`x.${kind}`, kind)), kind).toBe('binary');
    }
  });

  it('reads an SVG sketch as text and refuses other sketches', () => {
    expect(classifyProjectFile(file('logo.svg', 'sketch'))).toBe('text');
    expect(classifyProjectFile(file('board.sketch.json', 'sketch'))).toBe('binary');
    expect(classifyProjectFile(file('sketch-1.png', 'sketch'))).toBe('binary');
  });

  it('decides a "binary" kind by name: the daemon buckets most source files there', () => {
    expect(classifyProjectFile(file('src/App.jsx', 'binary'))).toBe('text');
    expect(classifyProjectFile(file('config.yaml', 'binary'))).toBe('text');
    expect(classifyProjectFile(file('.gitignore', 'binary'))).toBe('text');
    expect(classifyProjectFile(file('Dockerfile', 'binary'))).toBe('text');
  });

  it('accepts a textual MIME type when the name says nothing', () => {
    expect(classifyProjectFile(file('data.custom', 'binary', { mime: 'text/plain; charset=utf-8' }))).toBe('text');
    expect(classifyProjectFile(file('data.custom', 'binary', { mime: 'application/json' }))).toBe('text');
  });

  it('refuses names known to be binary without loading them', () => {
    expect(classifyProjectFile(file('bundle.zip', 'binary'))).toBe('binary');
    expect(classifyProjectFile(file('app.sqlite', 'binary'))).toBe('binary');
    expect(classifyProjectFile(file('clip.mkv', 'binary'))).toBe('binary');
  });

  it('leaves a small unknown file to be judged by its bytes, and refuses a large one', () => {
    expect(classifyProjectFile(file('mystery', 'binary'))).toBe('unknown');
    expect(classifyProjectFile(file('mystery', 'binary', { size: MAX_UNKNOWN_TEXT_BYTES + 1 }))).toBe('binary');
  });

  it('refuses any file too large to hold in memory as text', () => {
    expect(classifyProjectFile(file('huge.log', 'text', { size: MAX_TEXT_BYTES + 1 }))).toBe('binary');
  });
});

describe('looksBinary', () => {
  it('accepts ordinary text, including non-Latin text', () => {
    expect(looksBinary('')).toBe(false);
    expect(looksBinary('const a = 1;\n// 注释 — ok\n')).toBe(false);
  });

  it('flags a NUL byte', () => {
    expect(looksBinary('PK\u0003\u0004\u0000\u0000data')).toBe(true);
  });

  it('flags a head full of replacement characters and tolerates a stray one', () => {
    expect(looksBinary('�'.repeat(40) + 'abc')).toBe(true);
    expect(looksBinary(`${'readable text '.repeat(20)}�`)).toBe(false);
  });
});

describe('file glyphs', () => {
  it('classifies by name first, then by MIME type', () => {
    expect(getFileVisualKind('src/app.tsx')).toBe('code');
    expect(getFileVisualKind('README.md')).toBe('text');
    expect(getFileVisualKind('.env.production')).toBe('code');
    expect(getFileVisualKind('photo.heic')).toBe('image');
    expect(getFileVisualKind('cache.sqlite3')).toBe('database');
    expect(getFileVisualKind('blob', 'image/png')).toBe('image');
    expect(getFileVisualKind('blob', 'text/plain; charset=utf-8')).toBe('text');
    expect(getFileVisualKind('blob')).toBe('file');
  });

  it('picks one glyph per kind', () => {
    expect(pickFileIcon('app.tsx')).toBe(FileCode);
    expect(pickFileIcon('notes.txt')).toBe(FileText);
    expect(pickFileIcon('logo.png')).toBe(FileImage);
    expect(pickFileIcon('data.db')).toBe(Database);
    expect(pickFileIcon('unknown')).toBe(File);
  });
});
