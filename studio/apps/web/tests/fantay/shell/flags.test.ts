// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FANTAY_SHELL_STORAGE_KEY,
  isFantayShellEnabled,
  useFantayShellEnabled,
} from '../../../src/fantay/shell/flags';

describe('fantay shell flag', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is on by default', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', undefined);
    expect(isFantayShellEnabled()).toBe(true);
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    expect(isFantayShellEnabled()).toBe(true);
  });

  it("is disabled by the env values '0' and 'off'", () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    expect(isFantayShellEnabled()).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', 'off');
    expect(isFantayShellEnabled()).toBe(false);
  });

  it('lets localStorage on/off beat the env', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    window.localStorage.setItem(FANTAY_SHELL_STORAGE_KEY, 'on');
    expect(isFantayShellEnabled()).toBe(true);

    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    window.localStorage.setItem(FANTAY_SHELL_STORAGE_KEY, 'off');
    expect(isFantayShellEnabled()).toBe(false);
  });

  it('ignores unknown storage values and falls back to the env', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    window.localStorage.setItem(FANTAY_SHELL_STORAGE_KEY, 'maybe');
    expect(isFantayShellEnabled()).toBe(false);
  });

  it('falls back to the env path when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    expect(isFantayShellEnabled()).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    expect(isFantayShellEnabled()).toBe(true);
  });

  it('keeps useFantayShellEnabled stable for the component lifetime', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    const { result, rerender } = renderHook(() => useFantayShellEnabled());
    expect(result.current).toBe(true);

    window.localStorage.setItem(FANTAY_SHELL_STORAGE_KEY, 'off');
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    rerender();
    expect(result.current).toBe(true);
  });

  it('reads the current value when a component mounts', () => {
    window.localStorage.setItem(FANTAY_SHELL_STORAGE_KEY, 'off');
    const { result } = renderHook(() => useFantayShellEnabled());
    expect(result.current).toBe(false);
  });

  it('server-renders from the env only (B2 getServerSnapshot)', () => {
    window.localStorage.setItem(FANTAY_SHELL_STORAGE_KEY, 'off');
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    function Probe() {
      return createElement('span', null, useFantayShellEnabled() ? 'on' : 'off');
    }
    expect(renderToString(createElement(Probe))).toBe('<span>on</span>');
  });
});
