// SPDX-License-Identifier: AGPL-3.0-only
// Translator for the Memory Center dialogs. Their copy is a typed unit next to the page's
// (src/i18n/memory-ui/dialogs.ts); the app locale picks the language by the same rule as the page.
import { useCallback, useMemo } from 'react';

import { useI18n } from '../../../i18n';
import {
  memoryDialogEn,
  memoryDialogJa,
  memoryDialogZh,
  type MemoryDialogDict,
  type MemoryDialogKey,
} from '../../../i18n/memory-ui/dialogs';
import { fillMemoryTemplate, memoryLang, type MemoryLang } from '../i18n';

export type { MemoryDialogKey } from '../../../i18n/memory-ui/dialogs';

export type MemoryDialogLang = MemoryLang;
export type MemoryDialogVars = Readonly<Record<string, string | number>>;
export type MemoryDialogT = (key: MemoryDialogKey, vars?: MemoryDialogVars) => string;

const DICTIONARIES: Record<MemoryDialogLang, MemoryDialogDict> = {
  zh: memoryDialogZh,
  en: memoryDialogEn,
  ja: memoryDialogJa,
};

/** `{name}` placeholders are filled from `vars` (see `fillMemoryTemplate` for `{n|one|other}`). */
export function translateMemoryDialog(lang: MemoryDialogLang, key: MemoryDialogKey, vars?: MemoryDialogVars): string {
  return fillMemoryTemplate(DICTIONARIES[lang][key], vars, lang);
}

export function useMemoryDialogT(): { t: MemoryDialogT; lang: MemoryDialogLang } {
  const { locale } = useI18n();
  const lang = memoryLang(String(locale));
  const t = useCallback<MemoryDialogT>((key, vars) => translateMemoryDialog(lang, key, vars), [lang]);
  return useMemo(() => ({ t, lang }), [t, lang]);
}
