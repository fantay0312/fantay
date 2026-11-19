import type { BundledLanguage, HighlighterGeneric, LanguageInput } from 'shiki/bundle/web';

const LIGHT_THEME = 'github-light-default';
const DARK_THEME = 'github-dark-default';

type WebHighlighter = HighlighterGeneric<BundledLanguage, typeof LIGHT_THEME | typeof DARK_THEME>;

interface HighlighterSession {
  highlighter: WebHighlighter;
  webLangs: ReadonlySet<string>;
}

// Grammars used in technical docs that sit outside `shiki/bundle/web`, loaded only on first request.
const EXTRA_LANG_LOADERS: Readonly<Record<string, () => Promise<{ default: LanguageInput }>>> = {
  rust: () => import('shiki/dist/langs/rust.mjs'),
  rs: () => import('shiki/dist/langs/rust.mjs'),
  go: () => import('shiki/dist/langs/go.mjs'),
  golang: () => import('shiki/dist/langs/go.mjs'),
  swift: () => import('shiki/dist/langs/swift.mjs'),
  ruby: () => import('shiki/dist/langs/ruby.mjs'),
  rb: () => import('shiki/dist/langs/ruby.mjs'),
  diff: () => import('shiki/dist/langs/diff.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  dockerfile: () => import('shiki/dist/langs/dockerfile.mjs'),
  docker: () => import('shiki/dist/langs/dockerfile.mjs'),
  // The source of a diagram block, when the reader asks for it or the block does not draw.
  mermaid: () => import('shiki/dist/langs/mermaid.mjs'),
};

const CANONICAL_LANG: Readonly<Record<string, string>> = {
  rs: 'rust',
  golang: 'go',
  rb: 'ruby',
  docker: 'dockerfile',
};

let sessionPromise: Promise<HighlighterSession> | null = null;

const cache = new Map<string, string>();
const CACHE_MAX = 128;

function getSession(): Promise<HighlighterSession> {
  if (!sessionPromise) {
    sessionPromise = import('shiki/bundle/web').then(
      async ({ createHighlighter, bundledLanguages }) => ({
        highlighter: (await createHighlighter({
          themes: [LIGHT_THEME, DARK_THEME],
          langs: [],
        })) as WebHighlighter,
        webLangs: new Set(Object.keys(bundledLanguages)),
      }),
      (error: unknown) => {
        sessionPromise = null;
        throw error;
      },
    );
  }
  return sessionPromise;
}

function isDarkMode(): boolean {
  if (typeof document === 'undefined') return false;
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return '';
  const dark = isDarkMode();
  const cacheKey = `${dark ? 'd' : 'l'}:${normalized}:${code}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const { highlighter, webLangs } = await getSession();
  const canonical = CANONICAL_LANG[normalized] ?? normalized;

  if (!highlighter.getLoadedLanguages().includes(canonical)) {
    if (webLangs.has(canonical)) {
      await highlighter.loadLanguage(canonical as BundledLanguage);
    } else {
      const extraLoader = EXTRA_LANG_LOADERS[normalized];
      if (!extraLoader) return '';
      const mod = await extraLoader();
      await highlighter.loadLanguage(mod.default);
    }
  }

  const html = highlighter.codeToHtml(code, {
    lang: canonical as BundledLanguage,
    theme: dark ? DARK_THEME : LIGHT_THEME,
  });

  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(cacheKey, html);
  return html;
}
