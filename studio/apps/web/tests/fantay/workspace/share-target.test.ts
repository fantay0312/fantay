import { describe, expect, it } from 'vitest';

import { defaultBoardShareTarget } from '../../../src/fantay/workspace/share-target';
import type { ProjectFile } from '../../../src/types';

function file(name: string, mtime: number, extra: Partial<ProjectFile> = {}): ProjectFile {
  return { name, mtime, size: 1, kind: name.endsWith('.html') ? 'html' : 'text', mime: 'text/plain', ...extra };
}

describe('defaultBoardShareTarget', () => {
  it('prefers index.html even when other pages are newer', () => {
    expect(defaultBoardShareTarget([
      file('about.html', 50),
      file('index.html', 10),
      file('pricing.html', 90),
    ])).toBe('index.html');
  });

  it('falls back to the most recently modified .html file', () => {
    expect(defaultBoardShareTarget([
      file('about.html', 50),
      file('notes.md', 99),
      file('pages/pricing.HTML', 70),
      file('landing.variant-a.html', 60),
    ])).toBe('pages/pricing.HTML');
  });

  it('keeps the first file on equal modification times', () => {
    expect(defaultBoardShareTarget([file('a.html', 5), file('b.html', 5)])).toBe('a.html');
  });

  it('ignores directories and non-html files', () => {
    expect(defaultBoardShareTarget([
      file('site.html', 100, { type: 'dir' }),
      file('index.html', 1, { type: 'dir' }),
      file('hero.png', 100),
      file('page.htm', 100),
    ])).toBeNull();
  });

  it('returns null without files', () => {
    expect(defaultBoardShareTarget([])).toBeNull();
  });
});
