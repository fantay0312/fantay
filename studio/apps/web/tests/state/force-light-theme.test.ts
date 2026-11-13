// @vitest-environment jsdom
//
// The legacy `AppConfig.theme` field is dead data: Fantay owns the visible
// theme (`fantay:theme` in localStorage, dark by default — see
// `src/fantay/theme/theme.ts` and `tests/fantay/theme.test.ts`). `config.ts` is
// unchanged and still coerces every persisted value of that field to `light`
// on read; these specs pin that config-level invariant only.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, loadConfig } from '../../src/state/config';
import type { AppConfig } from '../../src/types';

const STORAGE_KEY = 'open-design:config';
const store = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    store.delete(key);
  }),
  clear: vi.fn(() => {
    store.clear();
  }),
});

function persist(config: Partial<AppConfig>): void {
  store.set(STORAGE_KEY, JSON.stringify(config));
}

/** Pretend the OS is in dark mode, the way a dark-desktop user's browser is. */
function stubSystemPrefersDark(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('system-default theme — persisted config', () => {
  beforeEach(() => {
    store.clear();
  });

  it('defaults a fresh install to the system theme', () => {
    expect(DEFAULT_CONFIG.theme).toBe('system');
    expect(loadConfig().theme).toBe('system');
  });

  it('preserves an explicitly selected dark theme', () => {
    persist({ theme: 'dark', accentColor: '#4F46E5' });

    const config = loadConfig();

    expect(config.theme).toBe('dark');
    // Unrelated preferences must survive the coercion.
    expect(config.accentColor).toBe('#4f46e5');
  });

  it('retains system preference when the OS prefers dark', () => {
    stubSystemPrefersDark();
    persist({ theme: 'system' });

    expect(loadConfig().theme).toBe('system');
  });

  it('does not overwrite an explicitly stored preference', () => {
    persist({ theme: 'dark' });

    loadConfig();

    const written = JSON.parse(store.get(STORAGE_KEY) ?? '{}') as Partial<AppConfig>;
    expect(written.theme).toBe('dark');
  });
});
