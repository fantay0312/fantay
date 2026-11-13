'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { english, loadLanguage, readyLanguage } from './dictionaries';
import { getOpenDesignHost } from '@open-design/host';
import { LOCALES, type Locale } from './types';

export { LOCALES, LOCALE_LABEL } from './types';
export type { Locale } from './types';

const LS_KEY = 'open-design:locale';
// Marker that says "the value in LS_KEY came from a deliberate user
// action through setLocale, not from some auto-detection path". Only
// values tagged this way win over the desktop host's injected OS
// locale, so a stale auto-detected pick can't pin the app forever once
// the user changes their system language.
const LS_SOURCE_KEY = 'open-design:locale-source';
const MANUAL_LOCALE_SOURCE = 'manual';

export function resolveSystemLocale(languages: readonly string[]): Locale | null {
  const supported = LOCALES as readonly string[];
  for (const raw of languages) {
    const normalized = raw.trim();
    if (!normalized) continue;

    const exact = LOCALES.find((locale) => locale.toLowerCase() === normalized.toLowerCase());
    if (exact) return exact;

    const [language, regionOrScript] = normalized.toLowerCase().split('-');
    if (language === 'zh') {
      if (regionOrScript === 'hant' || regionOrScript === 'tw' || regionOrScript === 'hk' || regionOrScript === 'mo') {
        return 'zh-TW';
      }
      return 'zh-CN';
    }

    const baseMatch = LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === language);
    if (baseMatch && supported.includes(baseMatch)) return baseMatch;
  }
  return null;
}

// Keep the current UI mounted during a switch. A late result from a previous
// selection must never change the language of the current screen.
function useLanguage(request: { locale: Locale | null }) {
  const { locale } = request;
  const [lastReady, setLastReady] = useState(() => locale && readyLanguage(locale));
  useEffect(() => {
    if (!locale) return;
    const cached = readyLanguage(locale);
    if (cached) {
      setLastReady(cached);
      return;
    }
    let current = true;
    void loadLanguage(locale).then(language => {
      if (current) setLastReady(language);
    }, () => {
      if (current) setLastReady(previous => previous ?? english);
    });
    return () => { current = false; };
  }, [request]);
  return locale ? readyLanguage(locale) ?? lastReady : null;
}

// Answer content can declare a language independently of application controls.
export function useContentTranslator(tag: string | undefined, uiT: typeof english.t) {
  const request = useMemo(() => ({ locale: tag ? resolveSystemLocale([tag]) : null }), [tag]);
  const language = useLanguage(request);
  return language && language.locale === request.locale ? language.t : uiT;
}

// Read the OS locale the desktop host attached to its client descriptor.
// Packaged desktop builds need this because Chromium otherwise reports
// en-US through navigator.language regardless of the OS setting. We go
// through `getOpenDesignHost` rather than reading the bridge global by
// name so the web/preload boundary stays single-source (see the
// `host bridge boundary` guard test).
function readDesktopHostOsLocale(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const host = getOpenDesignHost();
  const value = host?.client?.osLocale;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// First-run defaults to the user's OS / browser language when possible.
// Priority: explicit user pick saved to localStorage (only when tagged
// as manual) > OS locale that the desktop host injected (packaged
// Electron) > navigator.languages > 'en'. The source tag matters
// because untagged localStorage values are treated as legacy /
// auto-detected — they don't override a fresh OS locale read.
// Exported so tests can pin the priority chain without spinning up the
// full I18nProvider.
export function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  let storedLocale: string | null = null;
  let storedSource: string | null = null;
  try {
    storedLocale = window.localStorage.getItem(LS_KEY);
    storedSource = window.localStorage.getItem(LS_SOURCE_KEY);
  } catch {
    /* ignore */
  }
  if (
    storedSource === MANUAL_LOCALE_SOURCE &&
    storedLocale &&
    (LOCALES as string[]).includes(storedLocale)
  ) {
    return storedLocale as Locale;
  }
  const hostOsLocale = readDesktopHostOsLocale();
  if (hostOsLocale) {
    const fromHost = resolveSystemLocale([hostOsLocale]);
    if (fromHost) return fromHost;
  }
  const detected = resolveSystemLocale(
    navigator.languages?.length ? navigator.languages : [navigator.language],
  );
  return detected ?? 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: typeof english.t;
}

const I18nContext = createContext<I18nContextValue | null>(null);

// Stand-alone English translator used when no provider is mounted (e.g. an
// isolated test). It MUST be a module-level singleton, not rebuilt per render:
// components legitimately list `t` in effect dependency arrays, and inside the
// provider `t` is stable for the lifetime of its dictionary. A fresh closure
// here would break that contract only on the provider-less path, turning any
// such effect into an infinite render loop that spins instead of failing —
// which reads as a hung test suite rather than a bug.
const FALLBACK_I18N: I18nContextValue = {
  locale: 'en',
  setLocale: () => { },
  t: english.t,
};

interface ProviderProps {
  initial?: Locale;
  children: ReactNode;
}

const RTL_LOCALES: Locale[] = ['ar', 'fa'];

/**
 * Whether a locale lays out right-to-left. Exported because direction also
 * flips side-anchored UI (the nav rail moves to the right edge, so its
 * tooltips have to open toward the left) and those callers must not
 * re-declare the locale list.
 */
export function isRtlLocale(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale);
}

export function I18nProvider({ initial, children }: ProviderProps) {
  const [request, setRequest] = useState(() => ({ locale: initial ?? detectInitialLocale() }));
  const { locale } = request;
  // Locale also scopes remote data and authorizations. Update it immediately
  // even when local copy is still loading, so stale responses cannot render.
  const language = useLanguage(request);
  const t = language?.t ?? english.t;

  // Keep <html lang="…" dir="…"> in sync so screen readers and CSS hooks
  // pick the right language token and direction without each component
  // having to set it itself.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const dir = isRtlLocale(locale) ? 'rtl' : 'ltr';
      document.documentElement.setAttribute('lang', locale);
      document.documentElement.setAttribute('dir', dir);
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    // A second selection also retries a chunk that failed to load.
    setRequest({ locale: next });
    try {
      window.localStorage.setItem(LS_KEY, next);
      // Marker so detectInitialLocale knows this came from a deliberate
      // user action and should beat the desktop host's OS locale.
      window.localStorage.setItem(LS_SOURCE_KEY, MANUAL_LOCALE_SOURCE);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{language ? children : null}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  // Falling back keeps the API safe to call without requiring every callsite
  // to wrap in a provider. See FALLBACK_I18N on why it is a shared singleton.
  return useContext(I18nContext) ?? FALLBACK_I18N;
}

// Convenience for components that only need the translator function.
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}
