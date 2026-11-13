// @vitest-environment jsdom
/**
 * `useDwell`:刚结束的东西再留一会儿(Fantay 2026-11-08)。三条承诺逐条钉:
 *  1. 挂载不驻留 —— 历史会话一打开就是落定的;
 *  2. 下降沿**当帧**就成立 —— 不先提交一个「假」再被拨回「真」(那是一次收起 → 展开的闪动);
 *  3. 驻留期间又变真,直接跟随。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDwell } from '../../../src/components/chat/useDwell';

afterEach(() => { vi.useRealTimers(); });

describe('useDwell', () => {
  it('挂载时 flag 为假 → 直接是假(历史不驻留)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDwell(false, 1_000));
    expect(result.current).toBe(false);
  });

  it('真 → 假:下降沿那一次渲染仍是真,ms 之后才落成假', () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const { result, rerender } = renderHook(({ flag }) => {
      const value = useDwell(flag, 1_000);
      seen.push(value);
      return value;
    }, { initialProps: { flag: true } });
    expect(result.current).toBe(true);

    seen.length = 0;
    rerender({ flag: false });
    expect(result.current).toBe(true);
    // 中间那一次被丢弃的渲染之外,提交出去的值从没出现过「假」
    expect(seen.at(-1)).toBe(true);

    act(() => { vi.advanceTimersByTime(999); });
    expect(result.current).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(false);
  });

  it('驻留期间又变真 → 跟随;再落下时重新计时', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ flag }) => useDwell(flag, 1_000), {
      initialProps: { flag: true },
    });
    rerender({ flag: false });
    act(() => { vi.advanceTimersByTime(600); });
    rerender({ flag: true });
    expect(result.current).toBe(true);
    rerender({ flag: false });
    act(() => { vi.advanceTimersByTime(600); });
    expect(result.current, '第一段的计时器漏过来了').toBe(true);
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current).toBe(false);
  });

  it('ms 为 0 → 不驻留', () => {
    const { result, rerender } = renderHook(({ flag }) => useDwell(flag, 0), {
      initialProps: { flag: true },
    });
    rerender({ flag: false });
    expect(result.current).toBe(false);
  });
});
