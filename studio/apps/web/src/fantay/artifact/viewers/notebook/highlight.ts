// SPDX-License-Identifier: AGPL-3.0-only
// Syntax colours for code cells, from Shiki's web bundle (the same bundle and the same two GitHub
// themes as the app's `runtime/shiki.ts`). The notebook keeps a loader of its own because a cell
// needs two things that shared runtime does not offer: the theme is passed in (the page decides
// dark or light once, for every cell), and `peekHighlightedCell` answers synchronously so a cell
// that is mounted again never flashes uncoloured. Only languages in the web bundle are coloured.
// Shiki itself is imported inside `start()`, so it stays out of the first bundle and off the server.
import type { BundledLanguage, HighlighterGeneric } from 'shiki/bundle/web';

const LIGHT = 'github-light-default';
const DARK = 'github-dark-default';

type WebHighlighter = HighlighterGeneric<BundledLanguage, typeof LIGHT | typeof DARK>;

let starting: Promise<{ highlighter: WebHighlighter; known: ReadonlySet<string> }> | null = null;

function start(): Promise<{ highlighter: WebHighlighter; known: ReadonlySet<string> }> {
  starting ??= import('shiki/bundle/web').then(async ({ createHighlighter, bundledLanguages }) => ({
    highlighter: (await createHighlighter({ themes: [LIGHT, DARK], langs: [] })) as WebHighlighter,
    known: new Set(Object.keys(bundledLanguages)),
  }));
  // A failed start (a chunk that did not load) may be tried again by the next cell.
  starting.catch(() => {
    starting = null;
  });
  return starting;
}

const cache = new Map<string, string>();
const CACHE_MAX = 256;

function cacheKey(code: string, language: string, dark: boolean): string {
  return `${dark ? 'd' : 'l'}:${language}:${code}`;
}

/** What an earlier call produced, at once: a cell that is mounted again never shows uncoloured. */
export function peekHighlightedCell(code: string, language: string, dark: boolean): string | null {
  return cache.get(cacheKey(code, language, dark)) ?? null;
}

/**
 * The cell's source as highlighted HTML (Shiki escapes the text itself), or '' when the language is
 * not one the bundle knows: the caller then keeps the plain source.
 */
export async function highlightCell(code: string, language: string, dark: boolean): Promise<string> {
  const key = cacheKey(code, language, dark);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const { highlighter, known } = await start();
  if (!known.has(language)) return '';
  if (!highlighter.getLoadedLanguages().includes(language)) await highlighter.loadLanguage(language as BundledLanguage);

  // Shiki makes every block a tab stop; a notebook has hundreds of blocks.
  const html = highlighter.codeToHtml(code, { lang: language, theme: dark ? DARK : LIGHT }).replace(' tabindex="0"', '');
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, html);
  return html;
}
