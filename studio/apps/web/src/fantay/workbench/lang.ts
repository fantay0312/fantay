/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — bilingual copy. The workbench writes its own strings in Chinese and English
 * (like the original desk) instead of growing the 19-locale app dictionary: Chinese locales get
 * Chinese, every other locale gets English. Usage: `const L = useL(); L('灵感', 'Ideas')`.
 */
import { useEffect } from 'react';
import { useI18n } from '../../i18n';
import { setWorkbenchRequestLang } from './api';

export type WorkbenchLang = 'zh' | 'en';

export function useWorkbenchLang(): WorkbenchLang {
  const { locale } = useI18n();
  const lang: WorkbenchLang = String(locale).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  useEffect(() => { setWorkbenchRequestLang(lang); }, [lang]);
  return lang;
}

export function useL(): (zh: string, en: string) => string {
  const lang = useWorkbenchLang();
  return (zh, en) => (lang === 'zh' ? zh : en);
}
