// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountSettingsSection } from '../../../src/fantay/account/AccountSettingsSection';
import { FantaySettingsNavItems } from '../../../src/fantay/account/FantaySettingsNavItems';
import { TOKENTOSEA_SESSION_CHANGED_EVENT } from '../../../src/fantay/account/use-tokentosea-session';
import { I18nProvider } from '../../../src/i18n';

const SIGNED_OUT = {
  configured: true,
  clientId: 'client-1',
  redirectUri: 'http://127.0.0.1:47654/callback',
  signedIn: false,
  pending: false,
  user: null,
};
const SIGNED_IN = { ...SIGNED_OUT, signedIn: true, user: { id: 'u1', name: 'Ada', email: 'ada@example.com' } };

let status: typeof SIGNED_OUT | typeof SIGNED_IN;
let requests: string[];

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

beforeEach(() => {
  status = SIGNED_OUT;
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      if (url.endsWith('/api/tokentosea/status')) return json(status);
      if (url.includes('/service/models')) {
        return json({ data: [{ id: 'm1', model: 'm-1', displayName: 'Model one', provider: 'test', priceVersion: 'v1' }] });
      }
      if (url.includes('/service/tools')) return json({ items: [], total: 0 });
      if (url.endsWith('/service/wallet')) return json({ availableUsd: '2.50' });
      if (url.includes('/api/tokentosea/currency?')) {
        const locale = new URL(url, 'http://test.local').searchParams.get('locale');
        const currency = locale === 'ja' ? 'JPY' : locale === 'zh-TW' ? 'TWD' : 'CNY';
        return json({ base: 'USD', currency, rate: currency === 'JPY' ? 150 : currency === 'TWD' ? 32 : 7, validUntil: Date.now() + 300000, asOf: new Date().toISOString(), source: 'https://www.exchangerate-api.com' });
      }
      return json({ error: 'not found' }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderSection(locale: 'zh-CN' | 'en' | 'ja' = 'zh-CN') {
  return render(
    <I18nProvider initial={locale}>
      <AccountSettingsSection />
    </I18nProvider>,
  );
}

describe('AccountSettingsSection', () => {
  it('saves a changed client through the configure endpoint and reloads status', async () => {
    status = SIGNED_IN;
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Client ID' }), { target: { value: 'client-updated' } });
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tokentosea/configure' && init?.method === 'POST') {
        status = { ...SIGNED_IN, clientId: 'client-updated' };
        return json({ ok: true });
      }
      return original(input);
    });
    fireEvent.click(screen.getByRole('button', { name: '保存连接配置' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/tokentosea/configure' && init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' })).toHaveAttribute('aria-expanded', 'false'));
  });

  it('signed out: the TokenToSea sign-in, no services, and the signed-out caption', async () => {
    renderSection();
    const section = screen.getByTestId('settings-account');
    expect(screen.getByRole('region', { name: '账户' })).toBe(section);
    expect(within(section).getByRole('heading', { name: 'TokenToSea 账户' })).toBeTruthy();
    expect(await within(section).findByRole('button', { name: /使用 TokenToSea 登录/ })).toBeTruthy();
    expect(await within(section).findByTestId('settings-account-services-signed-out')).toHaveTextContent(
      '登录 TokenToSea 后可浏览模型与工具',
    );
    expect(within(section).queryByTestId('tokentosea-services')).toBeNull();
    expect(within(section).getByText('官方图像模型之后会出现在「媒体生成提供商」中。')).toBeTruthy();
  });

  it('signed in: the services in their embedded look — no page title, no second sign-in', async () => {
    status = SIGNED_IN;
    renderSection();
    const services = await screen.findByTestId('tokentosea-services');
    expect(services).toHaveAttribute('data-variant', 'embedded');
    expect(screen.queryByRole('heading', { name: 'TokenToSea 服务', level: 1 })).toBeNull();
    expect(await within(services).findByRole('button', { name: /Model one/ })).toBeTruthy();
    // Signed in, the account is the overview group (balance in cents), not a second sign-in card.
    await waitFor(() => expect(screen.getByTestId('settings-account-balance')).toHaveTextContent('¥17.50'));
    expect(screen.getByTestId('settings-account-overview')).toHaveTextContent('ada@example.com');
    expect(screen.queryByTestId('tokentosea-account')).toBeNull();
    expect(screen.queryByTestId('settings-account-services-signed-out')).toBeNull();
  });

  it('loads models while the only wallet request is pending, then allows retry after a timeout', async () => {
    status = SIGNED_IN;
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    let walletCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/wallet') && ++walletCalls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        });
      }
      return original(input, init);
    });

    renderSection('en');
    expect(await screen.findByRole('button', { name: /Model one/ })).toBeTruthy();
    expect(walletCalls).toBe(1);
    const refresh = screen.getByRole('button', { name: 'Refresh balance' });
    expect(refresh).toBeDisabled();

    await act(async () => {
      deadline.abort(new DOMException('Timed out', 'TimeoutError'));
    });
    expect(await screen.findByText('Unavailable')).toBeTruthy();
    expect(refresh).toBeEnabled();

    vi.restoreAllMocks();
    fireEvent.click(refresh);
    expect(await screen.findByTestId('settings-account-balance')).toHaveTextContent('2.50');
    expect(walletCalls).toBe(2);
  });

  it('keeps models available when the tool catalog fails and retries only tools', async () => {
    status = SIGNED_IN;
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    let toolsAvailable = false;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/service/tools')) {
        return toolsAvailable
          ? json({ items: [{ id: 't1', name: 'Tool one' }], total: 1 })
          : json({ error: 'upstream_unavailable' }, { status: 503 });
      }
      return original(input, init);
    });

    renderSection();
    const services = await screen.findByTestId('tokentosea-services');
    expect(await within(services).findByRole('button', { name: /Model one/ })).toBeTruthy();
    expect(within(services).queryByRole('alert')).toBeNull();

    fireEvent.click(within(services).getByRole('radio', { name: '工具' }));
    expect(await within(services).findByRole('alert')).toHaveTextContent('无法读取工具');
    toolsAvailable = true;
    const beforeRetry = fetchMock.mock.calls.length;
    fireEvent.click(within(services).getByRole('button', { name: '重试' }));
    expect(await within(services).findByRole('button', { name: /Tool one/ })).toBeTruthy();
    expect(within(services).queryByRole('alert')).toBeNull();
    expect(fetchMock.mock.calls.slice(beforeRetry).map(([url]) => url)).toEqual(['/api/tokentosea/service/tools']);
  });

  it('shows the services once the account signs in (window focus or the session event)', async () => {
    renderSection();
    await screen.findByTestId('settings-account-services-signed-out');

    status = SIGNED_IN;
    act(() => {
      window.dispatchEvent(new Event(TOKENTOSEA_SESSION_CHANGED_EVENT));
    });
    expect(await screen.findByTestId('tokentosea-services')).toBeTruthy();

    status = SIGNED_OUT;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.queryByTestId('tokentosea-services')).toBeNull());
    expect(screen.getByTestId('settings-account-services-signed-out')).toBeTruthy();
  });

  it('never sends account secrets from the browser', async () => {
    status = SIGNED_IN;
    renderSection();
    await screen.findByTestId('tokentosea-services');
    expect(requests.every((url) => url.startsWith('/api/tokentosea/'))).toBe(true);
    expect(requests.join(' ')).not.toMatch(/access_token|refresh_token|apiKey/);
  });

  it.each([['en', 'USD', '2.50'], ['ja', 'JPY', '375.00']] as const)('defaults %s to the corresponding display currency', async (locale, currency, amount) => {
    status = SIGNED_IN;
    renderSection(locale);
    await waitFor(() => expect(screen.getByTestId('settings-account-balance')).toHaveAttribute('data-currency', currency));
    expect(screen.getByTestId('settings-account-balance')).toHaveTextContent(amount);
  });
});

describe('FantaySettingsNavItems', () => {
  it('renders the 账户 row like its siblings and selects the section', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <I18nProvider initial="zh-CN">
        <FantaySettingsNavItems active="general" onSelect={onSelect} />
      </I18nProvider>,
    );
    const account = screen.getByTestId('settings-nav-account');
    expect(account).toHaveClass('settings-nav-item');
    expect(account).toHaveTextContent('账户');
    expect(account).toHaveTextContent('TokenToSea 登录与服务');
    expect(account).not.toHaveAttribute('aria-current');

    fireEvent.click(account);
    expect(onSelect).toHaveBeenCalledWith('account');

    rerender(
      <I18nProvider initial="zh-CN">
        <FantaySettingsNavItems active="account" onSelect={onSelect} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('settings-nav-account')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('settings-nav-account')).toHaveClass('active');
  });
});
