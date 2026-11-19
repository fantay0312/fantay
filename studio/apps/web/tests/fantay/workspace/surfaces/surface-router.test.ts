import { describe, expect, it } from 'vitest';

import {
  intentFromAgentFocus,
  intentFromTurnChanges,
  isCodeLikePath,
  suggestSurfaces,
} from '../../../../src/fantay/workspace/surfaces/surface-router';
import type { TurnFileChange } from '../../../../src/fantay/workspace/surfaces/surface-types';

function change(path: string, added: number, removed: number, status: TurnFileChange['status'] = 'modified'): TurnFileChange {
  return { path, status, hunks: [], added, removed };
}

describe('isCodeLikePath', () => {
  it.each([
    'src/app.ts',
    'src/App.tsx',
    'styles/main.css',
    'server/main.rs',
    'scripts/build.sh',
    'config/site.yaml',
    'pyproject.toml',
    'package.json',
    'board.sketch.json',
    'data/rows.csv',
    'notes.txt',
    'content/post.mdx',
    'Makefile',
    'docker/Dockerfile',
    '.gitignore',
    '.env.local',
    'C:\\repo\\src\\main.go',
  ])('%s reads as code', (path) => {
    expect(isCodeLikePath(path)).toBe(true);
  });

  it.each([
    'index.html',
    'pages/about.HTM',
    'README.md',
    'docs/plan.markdown',
    'assets/logo.svg',
    'assets/hero.png',
    'clips/intro.mp4',
    'audio/voice.mp3',
    'report.pdf',
    'brief.docx',
    'deck.pptx',
    'budget.xlsx',
    'designs/home.fig',
    'legacy.op',
    'kit.penpot',
    'movie-studio.json',
    'nested/movie-studio.json',
    'archive.zip',
    'fonts/inter.woff2',
    'model.glb',
    'assets/.DS_Store',
    '',
    'src/',
  ])('%s does not', (path) => {
    expect(isCodeLikePath(path)).toBe(false);
  });

  it('lets the file kind veto a name and vouch for an extension it does not know', () => {
    expect(isCodeLikePath('sketch-01.json', 'sketch')).toBe(false);
    expect(isCodeLikePath('export.data', 'image')).toBe(false);
    expect(isCodeLikePath('export.data', 'code')).toBe(true);
    expect(isCodeLikePath('export.data', 'text')).toBe(true);
    expect(isCodeLikePath('export.data', 'binary')).toBe(false);
    expect(isCodeLikePath('export.data', null)).toBe(false);
    // The daemon files everything outside its short list as binary; the extension still decides.
    expect(isCodeLikePath('server/main.rs', 'binary')).toBe(true);
    // Markdown is `text` to the daemon and still belongs to the preview.
    expect(isCodeLikePath('README.md', 'text')).toBe(false);
    expect(isCodeLikePath('movie-studio.json', 'code')).toBe(false);
  });
});

describe('intentFromAgentFocus', () => {
  it('returns null without a tool, so a bare open keeps its existing path', () => {
    expect(intentFromAgentFocus({})).toBeNull();
    expect(intentFromAgentFocus({ open: 'index.html' })).toBeNull();
    expect(intentFromAgentFocus({ tool: null, open: 'index.html' })).toBeNull();
    expect(intentFromAgentFocus({ tool: '  ' })).toBeNull();
  });

  it('returns null for a tool this build does not know', () => {
    expect(intentFromAgentFocus({ tool: 'terminal', open: 'index.html' })).toBeNull();
  });

  it('preview needs a file', () => {
    expect(intentFromAgentFocus({ tool: 'preview', open: 'index.html' })).toEqual({
      surface: 'preview',
      engine: 'agent',
      file: 'index.html',
    });
    expect(intentFromAgentFocus({ tool: 'preview' })).toBeNull();
    expect(intentFromAgentFocus({ tool: 'preview', open: '' })).toBeNull();
  });

  it('code opens the source view, on the file when one is named', () => {
    expect(intentFromAgentFocus({ tool: 'code', open: 'src/app.ts' })).toEqual({
      surface: 'code',
      engine: 'agent',
      file: 'src/app.ts',
      view: 'source',
    });
    expect(intentFromAgentFocus({ tool: 'code' })).toEqual({ surface: 'code', engine: 'agent', view: 'source' });
    expect(intentFromAgentFocus({ tool: 'Code', open: null })).toEqual({ surface: 'code', engine: 'agent', view: 'source' });
  });

  it('browser carries an http(s) address when given', () => {
    expect(intentFromAgentFocus({ tool: 'browser', url: 'https://example.com/docs' })).toEqual({
      surface: 'browser',
      engine: 'agent',
      url: 'https://example.com/docs',
    });
    expect(intentFromAgentFocus({ tool: 'browser' })).toEqual({ surface: 'browser', engine: 'agent' });
    expect(intentFromAgentFocus({ tool: 'browser', url: 'javascript:alert(1)' })).toEqual({
      surface: 'browser',
      engine: 'agent',
    });
    // `open` belongs to preview and code; the browser does not take a file.
    expect(intentFromAgentFocus({ tool: 'browser', open: 'index.html' })).toEqual({ surface: 'browser', engine: 'agent' });
  });

  it.each([
    'https://',
    'http:example.com',
    '//example.com/path',
    'https://user:secret@example.com/',
    'https://example.com/a b',
    'https://example.com/\u0000',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    `https://example.com/${'a'.repeat(2100)}`,
  ])('browser opens without an address the marker contract would refuse: %s', (url) => {
    expect(intentFromAgentFocus({ tool: 'browser', url })).toEqual({ surface: 'browser', engine: 'agent' });
  });

  it('browser carries the address as the contract serializes it', () => {
    expect(intentFromAgentFocus({ tool: 'browser', url: '  HTTPS://Example.com  ' })?.url).toBe('https://example.com/');
    expect(intentFromAgentFocus({ tool: 'browser', url: null })).toEqual({ surface: 'browser', engine: 'agent' });
  });

  it.each(['files', 'board', 'design-system'] as const)('%s is a bare surface', (tool) => {
    expect(intentFromAgentFocus({ tool, open: 'index.html', url: 'https://example.com' })).toEqual({
      surface: tool,
      engine: 'agent',
    });
  });
});

describe('intentFromTurnChanges', () => {
  it('opens the code surface on the changes of the most changed code file', () => {
    expect(
      intentFromTurnChanges([change('src/a.ts', 3, 1), change('src/b.ts', 20, 5), change('src/c.ts', 2, 2)]),
    ).toEqual({ surface: 'code', engine: 'activity', file: 'src/b.ts', view: 'changes' });
  });

  it('breaks a tie towards the file touched last', () => {
    expect(intentFromTurnChanges([change('src/a.ts', 4, 0), change('src/b.ts', 1, 3), change('src/c.ts', 1, 0)])?.file).toBe(
      'src/b.ts',
    );
    // A Codex change can carry no counts at all; the last one still wins.
    expect(intentFromTurnChanges([change('src/a.ts', 0, 0), change('src/b.ts', 0, 0)])?.file).toBe('src/b.ts');
  });

  it('ignores deleted files and files that do not read as code', () => {
    expect(
      intentFromTurnChanges([
        change('index.html', 400, 0),
        change('README.md', 90, 0),
        change('src/gone.ts', 50, 50, 'deleted'),
        change('src/app.ts', 1, 0, 'created'),
      ]),
    ).toEqual({ surface: 'code', engine: 'activity', file: 'src/app.ts', view: 'changes' });
  });

  it('returns null when the turn changed no code', () => {
    expect(intentFromTurnChanges([])).toBeNull();
    expect(intentFromTurnChanges([change('index.html', 10, 0), change('src/gone.ts', 0, 9, 'deleted')])).toBeNull();
  });
});

describe('suggestSurfaces', () => {
  const files = [
    { name: 'index.html', kind: 'html', mtime: 100 },
    { name: 'about.html', kind: 'html', mtime: 300 },
    { name: 'notes.md', kind: 'text', mtime: 900 },
    { name: 'hero.png', kind: 'image', mtime: 950 },
    { name: 'src/app.ts', kind: 'code', mtime: 999 },
    { name: 'pages', type: 'dir', mtime: 999 },
    { name: '.cache/draft.html', kind: 'html', mtime: 999 },
  ];

  it('offers the turn changes first, then the newest previewable deliverable', () => {
    expect(
      suggestSurfaces({
        turnChanges: [change('src/app.ts', 12, 3), change('index.html', 80, 0), change('src/util.ts', 2, 0, 'created')],
        files,
        openTabNames: [],
      }),
    ).toEqual([
      {
        kind: 'changes',
        intent: { surface: 'code', engine: 'activity', file: 'src/app.ts', view: 'changes' },
        fileCount: 2,
        added: 14,
        removed: 3,
      },
      { kind: 'latest', intent: { surface: 'preview', engine: 'content', file: 'about.html' }, fileName: 'about.html' },
    ]);
  });

  it('ranks a page over markdown over media, whatever their age, and skips open tabs', () => {
    const latest = (openTabNames: string[]) =>
      suggestSurfaces({ turnChanges: [], files, openTabNames }).map((suggestion) =>
        suggestion.kind === 'latest' ? suggestion.fileName : suggestion.kind,
      );

    expect(latest([])).toEqual(['about.html']);
    expect(latest(['about.html'])).toEqual(['index.html']);
    expect(latest(['about.html', 'index.html'])).toEqual(['notes.md']);
    expect(latest(['about.html', 'index.html', 'notes.md'])).toEqual(['hero.png']);
    // Folders, hidden files and code are never the deliverable.
    expect(latest(['about.html', 'index.html', 'notes.md', 'hero.png'])).toEqual([]);
  });

  it('offers only the changes when nothing previewable is left', () => {
    expect(
      suggestSurfaces({
        turnChanges: [change('src/app.ts', 1, 1)],
        files: [{ name: 'src/app.ts', kind: 'code', mtime: 1 }],
        openTabNames: [],
      }).map((suggestion) => suggestion.kind),
    ).toEqual(['changes']);
  });

  it('offers nothing for an empty project', () => {
    expect(suggestSurfaces({ turnChanges: [], files: [], openTabNames: [] })).toEqual([]);
  });
});
