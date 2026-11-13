import { displayCurrencyForLocale, type DisplayCurrencyQuote } from '@open-design/contracts';

const DAY = 24 * 60 * 60 * 1000;
const SOURCE = 'https://www.exchangerate-api.com';
type Rates = { asOf: number; next: number; rates: Record<string, number> };

/** Uses the same daily USD reference feed as TokenToSea's currency display. */
export class DisplayCurrencyRates {
  private cached?: Rates;
  private pending: Promise<Rates> | undefined;
  private retryAt = 0;
  constructor(private readonly request: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  private async load(): Promise<Rates> {
    const now = this.now();
    if (this.cached && this.cached.next > now) return this.cached;
    if (!this.pending && now >= this.retryAt) {
      this.pending = (async () => {
        const response = await this.request('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000), redirect: 'error' });
        if (!response.ok) throw new Error('exchange_rate_unavailable');
        const body = await response.json() as { result?: string; base_code?: string; time_last_update_unix?: number; time_next_update_unix?: number; rates?: Record<string, number> };
        const asOf = Number(body.time_last_update_unix) * 1000;
        if (body.result !== 'success' || body.base_code !== 'USD' || !Number.isFinite(asOf) || asOf > now + 300_000 || now - asOf > 2 * DAY || !body.rates) throw new Error('exchange_rate_invalid');
        const next = Math.max(now + 3_600_000, Math.min(Number(body.time_next_update_unix) * 1000 || now + DAY, now + DAY));
        this.cached = { asOf, next, rates: body.rates };
        return this.cached;
      })().finally(() => { this.pending = undefined; this.retryAt = this.now() + 30_000; });
    }
    try { if (this.pending) return await this.pending; } catch { /* Keep a recent dated quote through a short outage. */ }
    if (this.cached && now - this.cached.asOf <= 2 * DAY) return this.cached;
    throw new Error('exchange_rate_unavailable');
  }

  async quote(locale: string): Promise<DisplayCurrencyQuote> {
    const currency = displayCurrencyForLocale(locale);
    if (currency === 'USD') return { base: 'USD', currency, rate: 1, asOf: null, source: null, validUntil: this.now() + DAY };
    const data = await this.load();
    const rate = data.rates[currency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new Error('exchange_rate_invalid');
    const nextCheck = data.next > this.now() ? data.next : this.now() + 30_000;
    return { base: 'USD', currency, rate, asOf: new Date(data.asOf).toISOString(), validUntil: Math.min(nextCheck, data.asOf + 2 * DAY), source: SOURCE };
  }
}
