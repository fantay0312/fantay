/** Display conversion only. Account balances and authorization budgets remain USD. */
export type DisplayCurrency = 'USD' | 'CNY' | 'TWD' | 'EUR' | 'JPY' | 'KRW' | 'RUB' | 'BRL' | 'PLN' | 'HUF' | 'TRY' | 'UAH' | 'IDR' | 'THB' | 'IRR';

export interface DisplayCurrencyQuote {
  base: 'USD';
  currency: DisplayCurrency;
  rate: number;
  asOf: string | null;
  validUntil: number;
  source: string | null;
}

export function displayCurrencyForLocale(locale: string): DisplayCurrency {
  const code = locale.toLowerCase();
  if (code === 'zh-tw' || code === 'zh-hant') return 'TWD';
  const language = code.split('-')[0];
  const currencies: Record<string, DisplayCurrency> = {
    zh: 'CNY', en: 'USD', de: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR',
    ja: 'JPY', ko: 'KRW', ru: 'RUB', pt: 'BRL', pl: 'PLN', hu: 'HUF',
    tr: 'TRY', uk: 'UAH', id: 'IDR', th: 'THB', fa: 'IRR',
  };
  // A language without a country-specific currency (for example ar) keeps USD.
  return currencies[language ?? ''] ?? 'USD';
}
