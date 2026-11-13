import { describe, expect, it, vi } from 'vitest';
import { DisplayCurrencyRates } from '../../src/integrations/display-currency.js';

const now = 1_800_000_000_000;
const payload = { result: 'success', base_code: 'USD', time_last_update_unix: now / 1000, time_next_update_unix: now / 1000 + 86400, rates: { USD: 1, CNY: 7, TWD: 32, JPY: 150, EUR: .9, BRL: 5 } };

describe('display currency rates', () => {
  it('shares a validated reference snapshot across language quotes', async () => {
    const request = vi.fn(async () => Response.json(payload));
    const service = new DisplayCurrencyRates(request, () => now);
    const [cn, tw, jp, de] = await Promise.all(['zh-CN', 'zh-TW', 'ja', 'de'].map(locale => service.quote(locale)));
    expect(cn).toMatchObject({ currency: 'CNY', rate: 7, base: 'USD' });
    expect(tw).toMatchObject({ currency: 'TWD', rate: 32 });
    expect(jp).toMatchObject({ currency: 'JPY', rate: 150 });
    expect(de).toMatchObject({ currency: 'EUR', rate: .9 });
    expect(request).toHaveBeenCalledOnce();
  });

  it('keeps USD accounting as the fallback without fetching an invented rate', async () => {
    const request = vi.fn();
    const service = new DisplayCurrencyRates(request, () => now);
    expect(await service.quote('en')).toMatchObject({ currency: 'USD', rate: 1, source: null });
    expect(await service.quote('unknown')).toMatchObject({ currency: 'USD', rate: 1 });
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects stale and non-positive reference rates', async () => {
    const stale = new DisplayCurrencyRates(vi.fn(async () => Response.json({ ...payload, time_last_update_unix: now / 1000 - 3 * 86400 })), () => now);
    await expect(stale.quote('zh-CN')).rejects.toThrow('exchange_rate');
    const invalid = new DisplayCurrencyRates(vi.fn(async () => Response.json({ ...payload, rates: { CNY: 0 } })), () => now);
    await expect(invalid.quote('zh-CN')).rejects.toThrow('exchange_rate');
  });

  it('keeps a recent quote usable during an outage and expires it after two days', async () => {
    let clock = now;
    const request = vi.fn().mockResolvedValueOnce(Response.json(payload)).mockRejectedValue(new Error('offline'));
    const service = new DisplayCurrencyRates(request, () => clock);
    await service.quote('zh-CN');
    clock += 86_400_000 + 1;
    const fallback = await service.quote('zh-CN');
    expect(fallback.rate).toBe(7);
    expect(fallback.validUntil).toBe(clock + 30_000);
    expect(fallback.asOf).toBe(new Date(now).toISOString());
    clock = now + 2 * 86_400_000 + 1;
    await expect(service.quote('zh-CN')).rejects.toThrow('exchange_rate');
  });
});
