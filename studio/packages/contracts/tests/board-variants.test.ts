import { describe, expect, it } from 'vitest';

import {
  boardVariantBasePath,
  compareBoardVariantLabels,
  formatBoardVariantLabel,
  parseBoardVariantPath,
} from '../src/board/index.js';

describe('parseBoardVariantPath (spec 04 §4.5.2)', () => {
  it('parses the explicit form', () => {
    expect(parseBoardVariantPath('landing.variant-a.html')).toEqual({
      groupKey: 'landing#frame', dir: '', base: 'landing', label: 'a', ext: 'html', explicit: true,
    });
    expect(parseBoardVariantPath('pages/hero.variant-bold.png')).toEqual({
      groupKey: 'pages/hero#image', dir: 'pages/', base: 'hero', label: 'bold', ext: 'png', explicit: true,
    });
    expect(parseBoardVariantPath('post.variant-1080x1920.html')).toMatchObject({ label: '1080x1920', explicit: true });
    expect(parseBoardVariantPath('my.site.variant-dark-mode.html')).toMatchObject({ base: 'my.site', label: 'dark-mode', explicit: true });
    expect(parseBoardVariantPath(`x.variant-${'a'.repeat(32)}.html`)).toMatchObject({ explicit: true });
    expect(parseBoardVariantPath('pages\\hero.variant-a.html')).toMatchObject({ dir: 'pages/', explicit: true });
  });

  it('parses the tolerated forms', () => {
    expect(parseBoardVariantPath('hero-v2.png')).toEqual({
      groupKey: 'hero#image', dir: '', base: 'hero', label: '2', ext: 'png', explicit: false,
    });
    expect(parseBoardVariantPath('a/hero-option-b.html')).toMatchObject({ dir: 'a/', base: 'hero', label: 'b', explicit: false });
    expect(parseBoardVariantPath('hero-variant-c.html')).toMatchObject({ base: 'hero', label: 'c', explicit: false });
  });

  it('rejects names that are not variants or files that are not placeable', () => {
    expect(parseBoardVariantPath('index.html')).toBeNull();
    expect(parseBoardVariantPath('x.variant-A.html')).toBeNull();
    expect(parseBoardVariantPath(`x.variant-${'a'.repeat(33)}.html`)).toBeNull();
    expect(parseBoardVariantPath('hero-v123456789.png')).toBeNull();
    expect(parseBoardVariantPath('notes.variant-a.txt')).toBeNull();
    expect(parseBoardVariantPath('.od/x.variant-a.html')).toBeNull();
  });

  it('keys groups by folder, base and board kind', () => {
    expect(parseBoardVariantPath('logo.variant-a.png')?.groupKey).toBe('logo#image');
    expect(parseBoardVariantPath('logo.variant-a.html')?.groupKey).toBe('logo#frame');
    expect(parseBoardVariantPath('x/logo.variant-a.html')?.groupKey).toBe('x/logo#frame');
  });

  it('derives the base file', () => {
    expect(boardVariantBasePath(parseBoardVariantPath('pages/landing.variant-b.html')!)).toBe('pages/landing.html');
    expect(boardVariantBasePath(parseBoardVariantPath('hero-v2.png')!)).toBe('hero.png');
  });
});

describe('variant labels', () => {
  it('sorts naturally and deterministically', () => {
    const labels = ['b', 'a', '10', '2', 'v10', 'v2', 'B', '1'];
    expect([...labels].sort(compareBoardVariantLabels)).toEqual(['1', '2', '10', 'a', 'B', 'b', 'v2', 'v10']);
    expect(compareBoardVariantLabels('a', 'a')).toBe(0);
    expect(compareBoardVariantLabels('01', '1')).toBeLessThan(0);
  });

  it('formats labels for display', () => {
    expect(formatBoardVariantLabel('a')).toBe('A');
    expect(formatBoardVariantLabel('bold')).toBe('Bold');
    expect(formatBoardVariantLabel('1080x1920')).toBe('1080×1920');
    expect(formatBoardVariantLabel('2')).toBe('2');
    expect(formatBoardVariantLabel('dark-1x2')).toBe('Dark-1×2');
    expect(formatBoardVariantLabel('')).toBe('');
  });
});
