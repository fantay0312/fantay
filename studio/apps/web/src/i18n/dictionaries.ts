import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';
import type { Dict, Locale } from './types';

export function createTranslator(dict: Dict) {
  return (key: keyof Dict, vars?: Record<string, string | number>): string => {
    const raw = dict[key] ?? en[key] ?? key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      vars[name] == null ? placeholder : String(vars[name]),
    );
  };
}

type Language = { locale: Locale; t: ReturnType<typeof createTranslator> };

// English supplies missing-key fallbacks. Keep Simplified Chinese ready for
// the desktop's common first launch; every other dictionary is a separate chunk.
export const english: Language = { locale: 'en', t: createTranslator(en) };
const ready = new Map<Locale, Language>([
  ['en', english],
  ['zh-CN', { locale: 'zh-CN', t: createTranslator(zhCN) }],
]);
const loaders = {
  ar: () => import('./locales/ar').then(m => m.ar),
  de: () => import('./locales/de').then(m => m.de),
  'es-ES': () => import('./locales/es-ES').then(m => m.esES),
  fa: () => import('./locales/fa').then(m => m.fa),
  fr: () => import('./locales/fr').then(m => m.fr),
  hu: () => import('./locales/hu').then(m => m.hu),
  id: () => import('./locales/id').then(m => m.id),
  it: () => import('./locales/it').then(m => m.it),
  ja: () => import('./locales/ja').then(m => m.ja),
  ko: () => import('./locales/ko').then(m => m.ko),
  pl: () => import('./locales/pl').then(m => m.pl),
  'pt-BR': () => import('./locales/pt-BR').then(m => m.ptBR),
  ru: () => import('./locales/ru').then(m => m.ru),
  th: () => import('./locales/th').then(m => m.th),
  tr: () => import('./locales/tr').then(m => m.tr),
  uk: () => import('./locales/uk').then(m => m.uk),
  'zh-TW': () => import('./locales/zh-TW').then(m => m.zhTW),
} satisfies Record<Exclude<Locale, 'en' | 'zh-CN'>, () => Promise<Dict>>;

export function readyLanguage(locale: Locale) {
  return ready.get(locale);
}

const loading = new Map<Locale, Promise<Language>>();

export function loadLanguage(locale: Locale): Promise<Language> {
  const known = ready.get(locale);
  if (known) return Promise.resolve(known);
  const pending = loading.get(locale);
  if (pending) return pending;
  const request = loaders[locale as keyof typeof loaders]().then(dict => {
    const language = { locale, t: createTranslator(dict) };
    ready.set(locale, language);
    return language;
  }).finally(() => loading.delete(locale));
  loading.set(locale, request);
  return request;
}
