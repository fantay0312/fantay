// SPDX-License-Identifier: Apache-2.0
/**
 * Editor strings (06 §9). Fantay strings arrive from the host in `init.messages` / the `locale`
 * event (every `designEditor.*` key resolved in the app's language); the vendored OpenPencil
 * chrome uses the SDK catalogues, switched with `setLocale`. The only literal UI string in the
 * editor is the bilingual notice shown when the page is opened outside a Fantay workspace.
 */
import { shallowRef } from 'vue';

import { setLocale, type Locale } from '../fx/engine/op';

export const STANDALONE_NOTICE = 'Open design files from a Fantay workspace · 请在 Fantay 工作区中打开设计文件';

const SDK_LOCALES: Readonly<Record<string, Locale>> = {
  en: 'en',
  de: 'de',
  'es-ES': 'es',
  fr: 'fr',
  it: 'it',
  ja: 'ja',
  pl: 'pl',
  ru: 'ru',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-CN',
};

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

/** The SDK catalogue for a Fantay locale: en, de, es-ES→es, fr, it, ja, pl, ru, zh-CN, zh-TW→zh-CN, else en. */
export function sdkLocaleFor(locale: string): Locale {
  return Object.prototype.hasOwnProperty.call(SDK_LOCALES, locale) ? SDK_LOCALES[locale]! : 'en';
}

const messages = shallowRef<Readonly<Record<string, string>>>({});
const locale = shallowRef('en');

export function editorLocale(): string {
  return locale.value;
}

/** Applies the host's language: document `lang` (drives the CJK 12px floor), SDK catalogue, Fantay strings. */
export function setEditorLocale(nextLocale: string, nextMessages: Record<string, string>): void {
  const valid = LOCALE_PATTERN.test(nextLocale) ? nextLocale : 'en';
  locale.value = valid;
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(nextMessages)) {
    if (typeof value === 'string') clean[key] = value;
  }
  messages.value = clean;
  if (typeof document !== 'undefined') document.documentElement.lang = valid;
  setLocale(sdkLocaleFor(valid));
}

/** `key` resolved from the host messages with `{name}` placeholders filled; '' when the host sent no such key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = messages.value[key];
  if (template === undefined) {
    if (import.meta.env.DEV && Object.keys(messages.value).length > 0) console.warn(`[fantay-design] missing message ${key}`);
    return '';
  }
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** Reactive messages, for components that must re-render on a locale change. */
export function useEditorMessages() {
  return messages;
}
