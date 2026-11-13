// SPDX-License-Identifier: AGPL-3.0-only
// Locale handling for tool plugins. Plugin dictionaries are keyed by short language ids (`zh`, `en`),
// the ids DeepSeek Harness plugins register, while Fantay locales are tags such as `zh-CN`.
import type { OpenDesignHostToolPluginText } from '@open-design/host';

/** The plugin language for a Fantay locale tag: `zh-CN` and `zh-TW` read `zh`, everything else its base tag. */
export function pluginLanguage(locale: string): string {
  return locale.toLowerCase().split('-')[0] || 'en';
}

/** Languages to try for a Fantay locale, most specific first; `en` then `zh` close the list. */
export function pluginLanguageChain(locale: string): string[] {
  return [...new Set([locale, pluginLanguage(locale), 'en', 'zh'])];
}

/** Picks the text for `locale`; a missing language falls back along `pluginLanguageChain`, then to any value. */
export function resolvePluginText(text: OpenDesignHostToolPluginText | undefined, locale: string): string | undefined {
  if (typeof text === 'string' || text === undefined) return text;
  for (const language of pluginLanguageChain(locale)) {
    const value = text[language];
    if (value) return value;
  }
  return Object.values(text)[0];
}
