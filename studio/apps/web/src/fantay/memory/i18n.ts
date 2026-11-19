// SPDX-License-Identifier: AGPL-3.0-only
// 记忆 page translator. The page's copy is its own typed dictionary (src/i18n/memory-ui/page.ts, En/Zh/Ja
// written together) rather than 19 global locale entries; the app's locale still decides which one is read.
// The dialogs keep their copy in the sibling unit (memory-ui/dialogs.ts) and pick it with `memoryLang` too.
import { useMemo } from 'react';
import { useI18n } from '../../i18n';
import {
  memoryPageEn,
  memoryPageJa,
  memoryPageZh,
  type MemoryPageDict,
  type MemoryPageKey,
} from '../../i18n/memory-ui/page';

export type { MemoryPageKey } from '../../i18n/memory-ui/page';

export type MemoryT = (key: MemoryPageKey, vars?: Record<string, string | number>) => string;

export type MemoryLang = 'zh' | 'en' | 'ja';

/** zh-CN and zh-TW read the Simplified Chinese source, ja the Japanese copy, every other locale English. */
export function memoryLang(locale: string): MemoryLang {
  const lower = locale.toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('ja')) return 'ja';
  return 'en';
}

const PAGE_DICTS: Record<MemoryLang, MemoryPageDict> = { zh: memoryPageZh, en: memoryPageEn, ja: memoryPageJa };

export function memoryDictFor(locale: string): MemoryPageDict {
  return PAGE_DICTS[memoryLang(locale)];
}

const PLURAL_RULES: Partial<Record<MemoryLang, Intl.PluralRules>> = {};
const PLURAL = /\{(\w+)\|([^|{}]*)\|([^{}]*)\}/g;

/**
 * Fills `{name}` from `vars`; an unknown placeholder stays as written. `{count|one|other}` picks the word for
 * that number (English copy: "{count} {count|memory|memories}"); Chinese and Japanese copy never needs it.
 */
export function fillMemoryTemplate(
  template: string,
  vars: Readonly<Record<string, string | number>> | undefined,
  lang: MemoryLang,
): string {
  if (!vars) return template;
  const rules = (PLURAL_RULES[lang] ??= new Intl.PluralRules(lang));
  return template
    .replace(PLURAL, (match, name: string, one: string, other: string) => {
      const value = vars[name];
      if (typeof value !== 'number') return match;
      return rules.select(value) === 'one' ? one : other;
    })
    .replace(/\{(\w+)\}/g, (placeholder, name: string) => (vars[name] == null ? placeholder : String(vars[name])));
}

export function createMemoryT(locale: string): MemoryT {
  const lang = memoryLang(locale);
  const dict = PAGE_DICTS[lang];
  return (key, vars) => fillMemoryTemplate(dict[key] ?? memoryPageEn[key] ?? key, vars, lang);
}

/** The page translator; stable for one locale, so it can sit in effect dependency lists. */
export function useMemoryT(): MemoryT {
  const { locale } = useI18n();
  return useMemo(() => createMemoryT(String(locale)), [locale]);
}

/** The app locale, for dates and relative times that sit inside translated sentences. */
export function useMemoryLocale(): string {
  return String(useI18n().locale);
}
