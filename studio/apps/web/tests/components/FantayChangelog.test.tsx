// @vitest-environment jsdom

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FantayChangelog } from '../../src/components/fantay-changelog/FantayChangelog';
import { PAGE_COUNT } from '../../src/components/fantay-changelog/MangaPages';
import { MANGA_VOLUMES } from '../../src/components/fantay-changelog/volumes';
import { I18nProvider } from '../../src/i18n';

function stubReducedMotion() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('FantayChangelog', () => {
  beforeEach(() => {
    stubReducedMotion();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('ships self-hosted manga display and dialogue font subsets with @font-face declarations', () => {
    const webRoot = process.cwd();
    const displayFont = resolve(webRoot, 'public/fonts/KingHwaOldSong-manga.woff2');
    const dialogueFont = resolve(webRoot, 'public/fonts/LXGWWenKai-manga.woff2');
    const fontCss = readFileSync(
      resolve(webRoot, 'src/components/fantay-changelog/manga-fonts.css'),
      'utf8',
    );

    expect(existsSync(displayFont)).toBe(true);
    expect(existsSync(dialogueFont)).toBe(true);
    expect(statSync(displayFont).size).toBeGreaterThan(50_000);
    expect(statSync(dialogueFont).size).toBeGreaterThan(50_000);
    expect(fontCss).toContain('font-family: "Fantay Manga Display"');
    expect(fontCss).toContain('font-family: "Fantay Manga Dialogue"');
  });

  it('renders the 3D shelf with the new star-hat spirit mascot on every volume cover', () => {
    const onClose = vi.fn();
    render(
      <I18nProvider initial="zh-CN">
        <FantayChangelog onClose={onClose} />
      </I18nProvider>,
    );

    const dialog = screen.getByTestId('fantay-changelog');
    expect(dialog.getAttribute('data-mode')).toBe('shelf');

    const svgs = [...dialog.querySelectorAll('svg[data-look]')];
    expect(svgs).toHaveLength(MANGA_VOLUMES.length);
    for (const svg of svgs) {
      expect(svg.getAttribute('viewBox')).toBe('0 0 512 512');
      expect(svg.getAttribute('data-mood')).toBeTruthy();
      expect(svg.getAttribute('data-pose')).toBeTruthy();
    }

    const latest = MANGA_VOLUMES[MANGA_VOLUMES.length - 1]!;
    expect(dialog.textContent).toContain(latest.version ?? '');
    expect(dialog.textContent).toContain(latest.copy['zh-CN'].title);
  });

  it('renders all 5 chapters of the 26.1114.1 volume across the two story spreads plus contents and end card', () => {
    const onClose = vi.fn();
    render(
      <I18nProvider initial="zh-CN">
        <FantayChangelog onClose={onClose} />
      </I18nProvider>,
    );

    expect(PAGE_COUNT).toBe(6);
    const dialog = screen.getByTestId('fantay-changelog');
    const frontBook = dialog.querySelector('button[aria-current="true"]') as HTMLButtonElement;
    fireEvent.click(frontBook);
    expect(dialog.getAttribute('data-mode')).toBe('reader');

    const latestCopy = MANGA_VOLUMES[MANGA_VOLUMES.length - 1]!.copy['zh-CN'];
    expect(latestCopy.chapters).toHaveLength(5);

    // Spread 1 (pages 1–2): tagline + chapters 1, 2, 3
    expect(dialog.textContent).toContain('1–2 / 6 页');
    expect(dialog.textContent).toContain(latestCopy.tagline);
    for (const ch of latestCopy.chapters.slice(0, 3)) {
      expect(dialog.textContent).toContain(ch.head);
      expect(dialog.textContent).toContain(ch.text);
    }

    // Spread 2 (pages 3–4): chapters 4 & 5 + next-volume cliffhanger
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(dialog.textContent).toContain('3–4 / 6 页');
    for (const ch of latestCopy.chapters.slice(3, 5)) {
      expect(dialog.textContent).toContain(ch.head);
      expect(dialog.textContent).toContain(ch.text);
    }

    // Spread 3 (pages 5–6): Contents (all 5 chapters) + To Be Continued
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(dialog.textContent).toContain('5–6 / 6 页');
    expect(dialog.textContent).toContain('目次');
    expect(dialog.textContent).toContain('未完待续');
    for (const ch of latestCopy.chapters) {
      expect(dialog.textContent).toContain(ch.head);
    }

    // Past the last spread -> Finale card, then rewind to pages 1–2
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(dialog.textContent).toContain('已是最新一卷');
    fireEvent.click(screen.getByRole('button', { name: '从头再读' }));
    expect(dialog.textContent).toContain('1–2 / 6 页');

    // Escape closes book to shelf, second Escape closes dialog
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialog.getAttribute('data-mode')).toBe('shelf');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['zh-TW', 'en'] as const)(
    'renders all 4 chapters of historical volumes in %s locale',
    async (locale) => {
      render(
        <I18nProvider initial={locale}>
          <FantayChangelog onClose={() => {}} />
        </I18nProvider>,
      );

      const dialog = await screen.findByTestId('fantay-changelog');
      // Jump to Volume 1 (oldest, 4 chapters, blue cover -> paper mascot look)
      fireEvent.keyDown(window, { key: 'End' });
      const frontBook = dialog.querySelector('button[aria-current="true"]') as HTMLButtonElement;
      expect(frontBook.querySelector('svg[data-look]')?.getAttribute('data-look')).toBe('paper');

      fireEvent.click(frontBook);
      const vol1 = MANGA_VOLUMES[0]!.copy[locale];
      expect(vol1.chapters).toHaveLength(4);

      for (const ch of vol1.chapters.slice(0, 3)) {
        expect(dialog.textContent).toContain(ch.head);
        expect(dialog.textContent).toContain(ch.text);
      }

      fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(dialog.textContent).toContain(vol1.chapters[3]!.head);
      expect(dialog.textContent).toContain(vol1.chapters[3]!.text);
      // Teases Volume 2 title in the cliffhanger panel
      expect(dialog.textContent).toContain(MANGA_VOLUMES[1]!.copy[locale].title);
    },
  );
});
