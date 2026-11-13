// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from 'react';
import { displayCurrencyForLocale, type DisplayCurrencyQuote } from '@open-design/contracts';

export function formatDisplayBalance(raw: string, locale: string, quote: DisplayCurrencyQuote | null, now = Date.now()) {
  const usd = Number(raw);
  if (!Number.isFinite(usd)) return { text: '—', currency: 'USD', converted: false };
  const valid = quote?.base === 'USD' && quote.currency === displayCurrencyForLocale(locale)
    && quote.validUntil > now && Number.isFinite(quote.rate) && quote.rate > 0;
  const currency = valid ? quote.currency : 'USD';
  const value = Math.trunc(Number((usd * (valid ? quote.rate : 1) * 100).toPrecision(12))) / 100;
  return {
    text: new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: !valid && displayCurrencyForLocale(locale) !== 'USD' ? 'code' : 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value),
    currency,
    converted: valid && currency !== 'USD',
  };
}

export function useDisplayCurrency(locale: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ locale: string; quote: DisplayCurrencyQuote | null; failed: boolean }>({ locale: '', quote: null, failed: false });
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const expected = displayCurrencyForLocale(locale);
    if (expected === 'USD') {
      setState({ locale, failed: false, quote: { base: 'USD', currency: 'USD', rate: 1, asOf: null, source: null, validUntil: Date.now() + 86_400_000 } });
      return;
    }
    void fetch(`/api/tokentosea/currency?locale=${encodeURIComponent(locale)}`, {
      cache: 'no-store',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    }).then(async response => {
      if (!response.ok) throw new Error('exchange_rate_unavailable');
      const quote = await response.json() as DisplayCurrencyQuote;
      if (quote.base !== 'USD' || quote.currency !== expected || !Number.isFinite(quote.rate) || quote.rate <= 0 || !Number.isFinite(quote.validUntil) || quote.validUntil <= Date.now()) throw new Error('exchange_rate_invalid');
      if (controller.signal.aborted) return;
      setState({ locale, quote, failed: false });
      timer = window.setTimeout(refresh, Math.min(300_000, quote.validUntil - Date.now()));
    }).catch(() => {
      if (!controller.signal.aborted) {
        setState(previous => ({ locale, quote: previous.locale === locale && previous.quote && previous.quote.validUntil > Date.now() ? previous.quote : null, failed: true }));
        timer = window.setTimeout(refresh, 30_000);
      }
    });
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [locale, revision, refresh]);
  return { quote: state.locale === locale ? state.quote : null, failed: state.locale === locale && state.failed, refresh };
}
