// @vitest-environment jsdom
/* SPDX-License-Identifier: Apache-2.0 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '@fantay/tokens';

const hostSetTheme = vi.fn();
vi.mock('@open-design/host', () => ({
  getOpenDesignHost: () => ({ appearance: { setTheme: hostSetTheme } }),
}));

import { FANTAY_THEME_INIT_SCRIPT, FANTAY_THEME_STORAGE_KEY } from '../../src/fantay/theme/init-script';
import {
  DEFAULT_THEME_PREFERENCE,
  __resetThemeForTests,
  getThemePreference,
  isThemePreference,
  paintThemePreference,
  resolveTheme,
  setThemePreference,
  useTheme,
} from '../../src/fantay/theme/theme';

const root = document.documentElement;
const ACCENT_VARS = ['--accent', '--accent-strong', '--accent-soft', '--accent-tint', '--accent-hover'];

type MediaListener = (event: { matches: boolean }) => void;

/** A controllable `prefers-color-scheme: dark` media query. */
function stubPrefersDark(initial: boolean): { set(matches: boolean): void } {
  let matches = initial;
  const listeners = new Set<MediaListener>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches() {
        return query.includes('prefers-color-scheme: dark') ? matches : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: MediaListener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: MediaListener) => listeners.delete(listener),
      addListener: (listener: MediaListener) => listeners.add(listener),
      removeListener: (listener: MediaListener) => listeners.delete(listener),
      dispatchEvent: () => true,
    })),
  );
  return {
    set(next: boolean) {
      matches = next;
      for (const listener of [...listeners]) listener({ matches });
    },
  };
}

/** requestAnimationFrame under manual control. */
function stubFrames(): { flush(): void; pending(): number } {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queue.push(callback);
    return queue.length;
  });
  return {
    flush() {
      const current = queue;
      queue = [];
      for (const callback of current) callback(0);
    },
    pending: () => queue.length,
  };
}

function runInitScript(): void {
  // eslint-disable-next-line no-new-func
  new Function(FANTAY_THEME_INIT_SCRIPT)();
}

function resetDocument(): void {
  root.removeAttribute('data-theme');
  root.removeAttribute('data-theme-switching');
  root.style.removeProperty('color-scheme');
  root.style.colorScheme = '';
  for (const name of ACCENT_VARS) root.style.removeProperty(name);
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => node.remove());
}

beforeEach(() => {
  window.localStorage.clear();
  resetDocument();
  hostSetTheme.mockClear();
});

afterEach(() => {
  cleanup();
  __resetThemeForTests();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  resetDocument();
});

describe('storage key', () => {
  it('matches the @fantay/tokens key', () => {
    expect(FANTAY_THEME_STORAGE_KEY).toBe(THEME_STORAGE_KEY);
    expect(FANTAY_THEME_STORAGE_KEY).toBe('fantay:theme');
    expect(FANTAY_THEME_INIT_SCRIPT).toContain(`'${FANTAY_THEME_STORAGE_KEY}'`);
  });
});

describe('FANTAY_THEME_INIT_SCRIPT (pre-hydration paint)', () => {
  it('defaults to light with empty storage even when OS prefers dark', () => {
    stubPrefersDark(true);
    runInitScript();
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });

  it('paints light for a stored light preference and dark for a stored dark preference', () => {
    window.localStorage.setItem('fantay:theme', 'light');
    runInitScript();
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.style.colorScheme).toBe('light');

    window.localStorage.setItem('fantay:theme', 'dark');
    runInitScript();
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
  });

  it('normalizes a legacy stored system preference to light regardless of matchMedia', () => {
    window.localStorage.setItem('fantay:theme', 'system');
    const media = stubPrefersDark(false);
    runInitScript();
    expect(root.getAttribute('data-theme')).toBe('light');

    media.set(true);
    runInitScript();
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('falls back to light without matchMedia', () => {
    vi.stubGlobal('matchMedia', undefined);
    runInitScript();
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('uses the light fallback for garbage values', () => {
    for (const value of ['Dark', 'auto', '', '{"theme":"light"}']) {
      window.localStorage.setItem('fantay:theme', value);
      runInitScript();
      expect(root.getAttribute('data-theme'), value).toBe('light');
    }
  });

  it('still stamps the attribute when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      runInitScript();
    } finally {
      spy.mockRestore();
    }
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('writes a custom accent inline', () => {
    window.localStorage.setItem('open-design:config', JSON.stringify({ accentColor: ' #4F46E5 ' }));
    runInitScript();
    expect(root.style.getPropertyValue('--accent')).toBe('#4f46e5');
    expect(root.style.getPropertyValue('--accent-strong')).toBe('color-mix(in srgb, #4f46e5 82%, var(--text-strong))');
    expect(root.style.getPropertyValue('--accent-soft')).toContain('#4f46e5');
    expect(root.style.getPropertyValue('--accent-tint')).toContain('#4f46e5');
    expect(root.style.getPropertyValue('--accent-hover')).toContain('#4f46e5');
  });

  it('does not write the default accent or an unmigrated legacy accent', () => {
    for (const config of [
      { accentColor: '#353535' },
      { accentColor: '#87ea5c' },
      { accentColor: '#c96442', configMigrationVersion: 2 },
      { accentColor: 'blue' },
      {},
    ]) {
      window.localStorage.setItem('open-design:config', JSON.stringify(config));
      runInitScript();
      for (const name of ACCENT_VARS) expect(root.style.getPropertyValue(name), JSON.stringify(config)).toBe('');
    }
  });

  it('keeps a legacy-coloured accent chosen after the migration', () => {
    window.localStorage.setItem('open-design:config', JSON.stringify({ accentColor: '#87ea5c', configMigrationVersion: 3 }));
    runInitScript();
    expect(root.style.getPropertyValue('--accent')).toBe('#87ea5c');
  });

  it('survives an unparsable config', () => {
    window.localStorage.setItem('open-design:config', '{not json');
    runInitScript();
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.style.getPropertyValue('--accent')).toBe('');
  });
});

describe('theme store', () => {
  it('defaults to light and validates two-state preferences', () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe('light');
    expect(getThemePreference()).toBe('light');
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('system')).toBe(false);
    expect(isThemePreference('auto')).toBe(false);
  });

  it('reads the stored preference once and caches it for the session (coercing legacy system to light)', () => {
    window.localStorage.setItem('fantay:theme', 'system');
    expect(getThemePreference()).toBe('light');
    __resetThemeForTests();
    window.localStorage.setItem('fantay:theme', 'dark');
    expect(getThemePreference()).toBe('dark');
    window.localStorage.setItem('fantay:theme', 'light');
    expect(getThemePreference()).toBe('dark');
  });

  it('resolves fixed light and dark preferences regardless of matchMedia', () => {
    stubPrefersDark(true);
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('setThemePreference persists, paints and syncs the desktop appearance', () => {
    stubFrames();
    setThemePreference('dark');
    expect(window.localStorage.getItem('fantay:theme')).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(hostSetTheme).toHaveBeenLastCalledWith('dark');

    setThemePreference('light');
    expect(window.localStorage.getItem('fantay:theme')).toBe('light');
    expect(hostSetTheme).toHaveBeenLastCalledWith('light');
  });

  it('keeps working when storage writes throw', () => {
    stubFrames();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    try {
      setThemePreference('dark');
    } finally {
      spy.mockRestore();
    }
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(getThemePreference()).toBe('dark');
  });

  it('paintThemePreference paints the stored preference idempotently', () => {
    stubFrames();
    expect(paintThemePreference()).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(paintThemePreference()).toBe('light');
    expect(hostSetTheme).toHaveBeenCalledWith('light');
  });

  it('sets data-theme-switching while switching and removes it after two frames', () => {
    const frames = stubFrames();
    root.setAttribute('data-theme', 'dark');
    setThemePreference('light');
    expect(root.hasAttribute('data-theme-switching')).toBe(true);
    frames.flush();
    expect(root.hasAttribute('data-theme-switching')).toBe(true);
    frames.flush();
    expect(root.hasAttribute('data-theme-switching')).toBe(false);
    expect(frames.pending()).toBe(0);
  });

  it('does not flag a switch when the painted theme is unchanged', () => {
    const frames = stubFrames();
    root.setAttribute('data-theme', 'light');
    paintThemePreference();
    expect(root.hasAttribute('data-theme-switching')).toBe(false);
    expect(frames.pending()).toBe(0);
  });

  it('a newer switch keeps its guard when an older one finishes', () => {
    const frames = stubFrames();
    root.setAttribute('data-theme', 'dark');
    setThemePreference('light');
    frames.flush();
    setThemePreference('dark');
    frames.flush(); // second frame of the first switch, first frame of the second
    expect(root.hasAttribute('data-theme-switching')).toBe(true);
    frames.flush();
    expect(root.hasAttribute('data-theme-switching')).toBe(false);
  });

  it('updates <meta name="theme-color"> from --paper', () => {
    stubFrames();
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#141414');
    document.head.append(meta);
    root.style.setProperty('--paper', '#fdfdfd');
    try {
      setThemePreference('light');
      expect(meta.getAttribute('content')).toBe('#fdfdfd');
    } finally {
      root.style.removeProperty('--paper');
    }
  });

  it('repaints on a storage event for its key or a cleared storage, and ignores other keys', () => {
    stubFrames();
    paintThemePreference();
    expect(root.getAttribute('data-theme')).toBe('light');
    window.localStorage.setItem('fantay:theme', 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'open-design:config', newValue: '{}' }));
    expect(root.getAttribute('data-theme')).toBe('light');
    window.dispatchEvent(new StorageEvent('storage', { key: 'fantay:theme', newValue: 'dark' }));
    expect(root.getAttribute('data-theme')).toBe('dark');
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('ignores OS color-scheme changes for fixed light and dark preferences', () => {
    stubFrames();
    const media = stubPrefersDark(false);
    paintThemePreference();
    expect(root.getAttribute('data-theme')).toBe('light');
    media.set(true);
    expect(root.getAttribute('data-theme')).toBe('light');

    setThemePreference('dark');
    media.set(false);
    expect(root.getAttribute('data-theme')).toBe('dark');
  });
});

describe('useTheme', () => {
  function Probe(): JSX.Element {
    const { preference, resolved, setPreference } = useTheme();
    return createElement(
      'button',
      { type: 'button', 'data-testid': 'probe', onClick: () => setPreference(preference === 'dark' ? 'light' : 'dark') },
      `${preference}/${resolved}`,
    );
  }

  it('renders the server snapshot without a window store (static export, 91 B2)', () => {
    expect(renderToString(createElement(Probe))).toContain('light/light');
  });

  it('re-renders on a switch and on storage updates from another tab', () => {
    stubFrames();
    render(createElement(Probe));
    const probe = screen.getByTestId('probe');
    expect(probe.textContent).toBe('light/light');

    act(() => probe.click());
    expect(probe.textContent).toBe('dark/dark');
    expect(root.getAttribute('data-theme')).toBe('dark');

    act(() => {
      window.localStorage.setItem('fantay:theme', 'light');
      window.dispatchEvent(new StorageEvent('storage', { key: 'fantay:theme', newValue: 'light' }));
    });
    expect(probe.textContent).toBe('light/light');
    expect(root.getAttribute('data-theme')).toBe('light');
  });
});
