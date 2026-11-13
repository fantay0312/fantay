// The hand-off arms the lift of the app's boot curtain, waits for the app's
// document to take that in, lets the splash's content leave, and shows the app
// window in its place. The timing is cosmetic; what must hold on every path is
// the order (nothing visible starts before the document has answered; the app
// is never shown while the splash's content is still up), that `arm` and
// `show` each run exactly once, and that the splash ends up closed.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  SPLASH_HANDOFF_ARM_MAX_MS,
  SPLASH_HANDOFF_LEAD_MS,
  SPLASH_HANDOFF_SETTLE_MS,
  handOffFromSplash,
} from '../../src/main/splash-handoff.js';

function createSplash() {
  let closed = false;
  const executed: string[] = [];
  return {
    executed,
    isClosed: () => closed,
    window: {
      isDestroyed: () => closed,
      close: () => {
        closed = true;
      },
      webContents: {
        executeJavaScript: (code: string) => {
          executed.push(code);
          return Promise.resolve(undefined);
        },
      },
    },
  };
}

describe('splash hand-off', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('waits for the document to take the lift, lets the splash leave, shows the app, closes the splash', async () => {
    const splash = createSplash();
    const order: string[] = [];
    let answered: () => void = () => {};
    handOffFromSplash({
      splash: splash.window,
      arm: () => {
        order.push('arm');
        return new Promise<void>((resolve) => {
          answered = resolve;
        });
      },
      show: () => order.push('show'),
    });

    // The lift is armed at once; while the document is busy the splash keeps
    // playing — nothing has been asked of it.
    await vi.advanceTimersByTimeAsync(600);
    expect(order).toEqual(['arm']);
    expect(splash.executed).toEqual([]);

    answered();
    await vi.advanceTimersByTimeAsync(0);
    expect(splash.executed).toEqual(['window.__odSplashExit && window.__odSplashExit();']);
    await vi.advanceTimersByTimeAsync(SPLASH_HANDOFF_LEAD_MS - 1);
    expect(order).toEqual(['arm']);

    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(['arm', 'show']);
    // The splash stays under the app window until that window has presented.
    expect(splash.isClosed()).toBe(false);

    await vi.advanceTimersByTimeAsync(SPLASH_HANDOFF_SETTLE_MS);
    expect(splash.isClosed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('does not hold the splash for a document that never answers', async () => {
    const splash = createSplash();
    const show = vi.fn();
    handOffFromSplash({ splash: splash.window, arm: () => new Promise(() => {}), show });
    await vi.advanceTimersByTimeAsync(SPLASH_HANDOFF_ARM_MAX_MS - 1);
    expect(splash.executed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + SPLASH_HANDOFF_LEAD_MS + SPLASH_HANDOFF_SETTLE_MS);
    expect(show).toHaveBeenCalledTimes(1);
    expect(splash.isClosed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('shows the app at once when there is no splash to leave', () => {
    const show = vi.fn();
    const arm = vi.fn(() => Promise.resolve());
    handOffFromSplash({ splash: null, arm, show });
    expect(arm).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);

    const gone = createSplash();
    gone.window.close();
    handOffFromSplash({ splash: gone.window, arm, show });
    expect(arm).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledTimes(2);
    expect(gone.executed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('goes on when arming fails or throws, and when the splash closes while the document is busy', async () => {
    const rejected = createSplash();
    const show = vi.fn();
    handOffFromSplash({ splash: rejected.window, arm: () => Promise.reject(new Error('renderer is gone')), show });
    await vi.advanceTimersByTimeAsync(SPLASH_HANDOFF_LEAD_MS + SPLASH_HANDOFF_SETTLE_MS);
    expect(show).toHaveBeenCalledTimes(1);
    expect(rejected.isClosed()).toBe(true);

    const thrown = createSplash();
    handOffFromSplash({
      splash: thrown.window,
      arm: () => {
        throw new Error('no window');
      },
      show,
    });
    await vi.advanceTimersByTimeAsync(SPLASH_HANDOFF_LEAD_MS + SPLASH_HANDOFF_SETTLE_MS);
    expect(show).toHaveBeenCalledTimes(2);
    expect(thrown.isClosed()).toBe(true);

    const gone = createSplash();
    handOffFromSplash({
      splash: gone.window,
      arm: async () => {
        gone.window.close();
      },
      show,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(show).toHaveBeenCalledTimes(3);
    expect(gone.executed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('still closes the splash when showing the app throws', async () => {
    const splash = createSplash();
    handOffFromSplash({
      splash: splash.window,
      arm: () => Promise.resolve(),
      show: () => {
        throw new Error('window is gone');
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(() => vi.advanceTimersByTime(SPLASH_HANDOFF_LEAD_MS)).toThrow('window is gone');
    vi.advanceTimersByTime(SPLASH_HANDOFF_SETTLE_MS);
    expect(splash.isClosed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
