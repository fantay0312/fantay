// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Settings ▸ 外观 and Settings ▸ 账户 inside the real SettingsDialog (spec 07 §8, amendment C1): nav rows,
// section headers, deep links, and the theme switch that writes the Fantay preference.
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      newRequestId: vi.fn(() => 'request-1'),
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      track: vi.fn(),
    }),
    useAppVersion: () => null,
  };
});

import { SettingsDialog, type SettingsSection } from '../../../src/components/SettingsDialog';
import { __resetThemeForTests } from '../../../src/fantay/theme/theme';
import { I18nProvider } from '../../../src/i18n';
import { DEFAULT_CONFIG } from '../../../src/state/config';
import type { AgentInfo } from '../../../src/types';

const AGENTS: AgentInfo[] = [{ id: 'codex', name: 'Codex', bin: 'codex', available: true }];

function renderSettings(initialSection: SettingsSection) {
  return render(
    <I18nProvider initial="en">
      <SettingsDialog
        presentation="page"
        initial={{ ...DEFAULT_CONFIG }}
        agents={AGENTS}
        daemonLive
        appVersionInfo={null}
        initialSection={initialSection}
        onPersist={vi.fn()}
        onPersistComposioKey={vi.fn()}
        onClose={vi.fn()}
        onRefreshAgents={vi.fn()}
      />
    </I18nProvider>,
  );
}

/** The dialog header line (title + subtitle of the active section). */
function header(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.modal-head-line');
}

beforeEach(() => {
  window.localStorage.removeItem('fantay:theme');
  __resetThemeForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/tokentosea/status')) {
        return new Response(
          JSON.stringify({ configured: true, clientId: null, redirectUri: 'http://127.0.0.1:47654/callback', signedIn: false, pending: false, user: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.removeItem('fantay:theme');
  __resetThemeForTests();
});

describe('SettingsDialog — Fantay sections', () => {
  it('deep-links to 账户 with its nav row active and the TokenToSea account inside', async () => {
    renderSettings('account');
    const section = screen.getByTestId('settings-account');
    expect(screen.getByTestId('settings-nav-account')).toHaveAttribute('aria-current', 'page');
    expect(header()).toHaveTextContent('Account');
    expect(header()).toHaveTextContent('TokenToSea sign-in and services');
    expect(await within(section).findByTestId('tokentosea-account')).toBeTruthy();
    expect(await within(section).findByTestId('settings-account-services-signed-out')).toBeTruthy();
  });

  it('folds the 外观 deep link into General, with the theme switch as its own block', () => {
    renderSettings('appearance');
    const general = document.querySelector<HTMLElement>('.settings-general-section');
    expect(general).not.toBeNull();
    const section = within(general!).getByTestId('settings-appearance');
    expect(screen.queryByTestId('settings-nav-appearance')).toBeNull();
    expect(header()).toHaveTextContent('General');
    expect(within(section).getByRole('heading', { name: 'Appearance' })).toBeTruthy();
    expect(within(section).getByRole('radiogroup', { name: 'Appearance' })).toBeTruthy();
    expect(screen.queryByTestId('settings-account')).toBeNull();
  });

  it('switches the theme from Settings ▸ 通用 ▸ 外观 and stores the Fantay preference', async () => {
    renderSettings('appearance');
    const group = screen.getByRole('radiogroup', { name: 'Appearance' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(within(group).getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).queryByRole('radio', { name: 'System' })).toBeNull();

    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }));

    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(window.localStorage.getItem('fantay:theme')).toBe('dark');
    expect(within(group).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  });

  it('drops the 外观 and media rows from the sidebar and keeps 账户 right after 记忆', () => {
    renderSettings('general');
    const rows = Array.from(document.querySelectorAll<HTMLElement>('#settings-sidebar .settings-nav-item'));
    const memory = rows.findIndex((row) => row.textContent?.includes('Memory'));
    expect(rows.some((row) => row.textContent?.includes('Media providers'))).toBe(false);
    expect(rows.some((row) => row.textContent?.includes('Appearance'))).toBe(false);
    expect(rows[memory + 1]).toBe(screen.getByTestId('settings-nav-account'));
    expect(screen.getByTestId('settings-appearance')).toBeTruthy();

    fireEvent.click(screen.getByTestId('settings-nav-account'));
    expect(screen.getByTestId('settings-account')).toBeTruthy();
    expect(screen.queryByTestId('settings-appearance')).toBeNull();
    expect(screen.getByTestId('settings-nav-account')).toHaveAttribute('aria-current', 'page');
  });

  it('opens media providers as the third Models & providers tab and leaves the execution mode alone', () => {
    renderSettings('media');
    const nav = screen.getByTestId('settings-nav-execution');
    const tabs = within(screen.getByRole('tablist', { name: 'Execution mode' })).getAllByRole('tab');
    expect(nav).toHaveClass('active');
    expect(header()).toHaveTextContent('Models & providers');
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
    expect(tabs[2]).toHaveTextContent('Media providers');

    fireEvent.click(tabs[1]!);
    const afterApi = within(screen.getByRole('tablist', { name: 'Execution mode' })).getAllByRole('tab');
    expect(afterApi.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(nav).toHaveClass('active');
  });
});
