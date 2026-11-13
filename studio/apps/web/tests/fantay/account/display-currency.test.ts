// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDisplayBalance, useDisplayCurrency } from '../../../src/fantay/account/display-currency';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const quote = { base: 'USD' as const, currency: 'CNY' as const, rate: 7, asOf: '2026-11-04T00:00:00Z', validUntil: 2000, source: 'https://www.exchangerate-api.com' };
describe('localized balance display', () => {
  it('converts USD to CNY and truncates cents rather than changing the currency symbol alone', () => {
    expect(formatDisplayBalance('2.50', 'zh-CN', quote, 1000)).toEqual({ text: '¥17.50', currency: 'CNY', converted: true });
    expect(formatDisplayBalance('2.999999', 'zh-CN', quote, 1000).text).toBe('¥20.99');
  });
  it('never labels an expired or wrong-language quote as local currency', () => {
    expect(formatDisplayBalance('2.50', 'zh-CN', quote, 3000)).toMatchObject({ currency: 'USD', converted: false });
    expect(formatDisplayBalance('2.50', 'ja', quote, 1000)).toMatchObject({ currency: 'USD', converted: false });
  });

  it('automatically recovers after a temporary quote failure without reusing the HTTP cache', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(async () => Response.json({ ...quote, validUntil: Date.now() + 300_000 }));
    vi.stubGlobal('fetch', request);
    const { result } = renderHook(() => useDisplayCurrency('zh-CN'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.failed).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current.quote?.currency).toBe('CNY');
    expect(result.current.failed).toBe(false);
    expect(request).toHaveBeenLastCalledWith('/api/tokentosea/currency?locale=zh-CN', expect.objectContaining({ cache: 'no-store' }));
  });
});
