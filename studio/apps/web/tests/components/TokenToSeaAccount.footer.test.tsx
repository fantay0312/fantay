// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryNavRail } from '../../src/components/EntryNavRail';
import { TokenToSeaAccount } from '../../src/components/TokenToSeaAccount';
import * as startup from '../../src/observability/startup-ready';
import { I18nProvider } from '../../src/i18n';
import { buildWorkspacePermissions, buildWorkspaceSeatSummary } from '@open-design/contracts';
vi.mock('@open-design/host', async () => ({ ...await vi.importActual('@open-design/host'), openHostExternalUrl: vi.fn(async () => ({ ok: true })) }));
let signedIn = true;
let pending = false;
let request: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear(); signedIn = true; pending = false;
  request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/tokentosea/login') { pending = true; return Response.json({ authorizeUrl: 'https://tokentosea.com/api/oauth/authorize?state=fixture' }); }
    if (url === '/api/tokentosea/logout') { signedIn = false; pending = false; return Response.json({ ok: true }); }
    if (url === '/api/tokentosea/status') return Response.json({ configured: true, signedIn, pending, user: signedIn ? { id: 'tts|user', name: 'fantay', email: 'user@example.test' } : null });
    if (url.includes('/messages?')) return Response.json({ messages: [], nextCursor: null, unreadCount: 0 });
    return Response.json({ items: [] });
  });
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function footer(onOpenSettings = vi.fn()) {
  render(<I18nProvider initial="zh-CN"><EntryNavRail view="home" onViewChange={() => {}} onNewProject={() => {}} open context={null}
    accountSlot={<TokenToSeaAccount variant="rail" onOpenSettings={onOpenSettings} />} /></I18nProvider>);
  return onOpenSettings;
}
describe('TokenToSea sidebar account', () => {
  it('reports welcome readiness only after config and the actual sign-in action are ready', async () => {
    const report = vi.spyOn(startup, 'useStartupReady').mockImplementation(() => {});
    let respond!: (result: Response) => void;
    request.mockImplementationOnce(() => new Promise<Response>(resolve => { respond = resolve; }));
    try {
      const view = render(<TokenToSeaAccount variant="gate" gateConfigReady />);
      expect(screen.getByRole('button')).toBeDisabled();
      expect(report).toHaveBeenLastCalledWith({ visible: true, interactive: false });
      view.rerender(<TokenToSeaAccount variant="gate" gateConfigReady={false} />);
      await act(async () => { respond(Response.json({ configured: true, signedIn: false })); });
      expect(report).toHaveBeenLastCalledWith({ visible: false, interactive: false });
      view.rerender(<TokenToSeaAccount variant="gate" gateConfigReady />);
      expect(screen.getByRole('button')).toBeEnabled();
      expect(report).toHaveBeenLastCalledWith({ visible: true, interactive: true });
    } finally {
      report.mockRestore();
    }
  });

  it('renders one identity row alongside notifications without the legacy local-mode account', async () => {
    footer();
    const dock = screen.getByTestId('entry-nav-product-account-dock');
    expect(await within(dock).findByRole('button', { name: 'fantay，TokenToSea 账号' })).toBeVisible();
    expect(within(dock).getByText('TokenToSea 已登录')).toBeVisible();
    expect(within(dock).getByRole('button', { name: '消息中心' })).toBeVisible();
    expect(screen.queryByTestId('entry-nav-local-account')).toBeNull();
    expect(screen.queryByText('本地模式')).toBeNull();
    expect(screen.getAllByTestId('tokentosea-account')).toHaveLength(1);
  });
  it('keeps settings in the account menu and returns focus after Escape', async () => {
    const settings = footer(); const trigger = await screen.findByRole('button', { name: 'fantay，TokenToSea 账号' });
    fireEvent.click(trigger); const menu = screen.getByRole('menu', { name: 'TokenToSea 账号菜单' });
    expect(within(menu).getByText('创作文件保存在本机，分享通过 TokenToSea 发布。')).toBeVisible();
    fireEvent.keyDown(menu, { key: 'Escape' }); expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: '设置' })); expect(settings).toHaveBeenCalledOnce();
  });
  it('does not duplicate the account or notification control when an old workspace is present', async () => {
    const context = { workspaceId: 'workspace', workspaceType: 'team' as const, workspaceMemberId: 'member', displayName: 'Workspace', role: 'owner' as const, memberStatus: 'active' as const, lifecycleState: 'active' as const, billingState: 'active' as const, planId: null, providerMode: 'platform_credits' as const, seatSummary: buildWorkspaceSeatSummary({ seatLimit: 3, usedSeats: 1 }), permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }) };
    render(<I18nProvider initial="zh-CN"><EntryNavRail view="home" onViewChange={() => {}} onNewProject={() => {}} open context={context} accountSlot={<TokenToSeaAccount variant="rail" />} /></I18nProvider>);
    await screen.findByRole('button', { name: 'fantay，TokenToSea 账号' });
    expect(document.querySelectorAll('.entry-nav-rail__account')).toHaveLength(1);
    expect(screen.getAllByTestId('entry-nav-message-center')).toHaveLength(1);
    expect(screen.queryByTestId('entry-nav-account-message-center')).toBeNull();
  });
  it('preserves the message-center opener and focus return', async () => {
    footer(); await screen.findByText('fantay'); const bell = screen.getByTestId('entry-nav-message-center');
    fireEvent.click(bell); await screen.findByTestId('message-center-dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('message-center-dialog')).toBeNull()); expect(document.activeElement).toBe(bell);
  });
  it('logs out only the TokenToSea account and leaves one sign-in row', async () => {
    footer(); fireEvent.click(await screen.findByRole('button', { name: 'fantay，TokenToSea 账号' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '退出登录' }));
    await screen.findByRole('button', { name: '使用 TokenToSea 登录' });
    expect(request.mock.calls.some(([url, init]) => url === '/api/tokentosea/logout' && init.method === 'POST')).toBe(true);
    expect(screen.queryByText('本地模式')).toBeNull();
  });
  it('keeps authorization pending and cancellation available without a duplicate identity', async () => {
    signedIn = false; footer(); fireEvent.click(await screen.findByRole('button', { name: '使用 TokenToSea 登录' }));
    const trigger = await screen.findByRole('button', { name: '等待授权…' });
    expect(screen.queryByText('Client ID')).toBeNull();
    fireEvent.click(trigger); expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    fireEvent.click(trigger); fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(request.mock.calls.filter(([url]) => url === '/api/tokentosea/login')).toHaveLength(1);
    await screen.findByRole('button', { name: '使用 TokenToSea 登录' }); expect(screen.getAllByTestId('tokentosea-account')).toHaveLength(1);
  });
});

describe('TokenToSea welcome gate', () => {
  it('releases the sign-in button after a terminal authorization failure', async () => {
    vi.useFakeTimers();
    signedIn = false;
    render(<I18nProvider initial="en"><TokenToSeaAccount variant="gate" /></I18nProvider>);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in with TokenToSea' })); });
    request.mockImplementation(async () => Response.json({ configured: true, signedIn: false, pending: false, error: 'Authorization expired. Sign in again.' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1800); });
    expect(screen.getByRole('button', { name: 'Sign in with TokenToSea' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Authorization expired. Sign in again.');
  });

  it('contains malformed status responses and keeps the gate retryable', async () => {
    request.mockImplementation(async () => new Response('{', { status: 200 }));
    render(<I18nProvider initial="en"><TokenToSeaAccount variant="gate" /></I18nProvider>);
    expect(await screen.findByRole('button', { name: 'Sign in with TokenToSea' })).toBeEnabled();
  });

  it('saves connection settings through configure and refreshes the account status', async () => {
    render(<I18nProvider initial="en"><TokenToSeaAccount variant="inline" /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Connection settings' }));
    fireEvent.change(screen.getByPlaceholderText(/Client ID/i), { target: { value: 'client-updated' } });
    request.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/tokentosea/configure' && init?.method === 'POST') return Response.json({ ok: true });
      if (String(input) === '/api/tokentosea/status') return Response.json({ configured: true, signedIn: true, pending: false, user: { name: 'fantay' } });
      return Response.json({ error: 'not found' }, { status: 404 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' }));
    await waitFor(() => expect(request.mock.calls.some(([url, init]) => url === '/api/tokentosea/configure' && init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.queryByPlaceholderText(/Client ID/i)).toBeNull());
    expect(screen.getByText('fantay')).toBeVisible();
  });

  it('opens login directly without exposing connection setup on the welcome page', async () => {
    signedIn = false;
    request.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/tokentosea/status') return Response.json({ configured: false, signedIn: false, pending: false });
      return Response.json({ error: 'Login temporarily unavailable' }, { status: 503 });
    });
    render(<I18nProvider initial="en"><TokenToSeaAccount variant="gate" /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with TokenToSea' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Login temporarily unavailable');
    expect(request.mock.calls.some(([url]) => url === '/api/tokentosea/login')).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('Connection settings')).toBeNull();
    expect(screen.queryByRole('button', { name: /Save connection/i })).toBeNull();
  });

  it('requires an explicit continue for an already signed-in account', async () => {
    const onSignedIn = vi.fn();
    render(<I18nProvider initial="en"><TokenToSeaAccount variant="gate" onSignedIn={onSignedIn} /></I18nProvider>);
    const enter = await screen.findByRole('button', { name: 'Enter workspace' });
    expect(onSignedIn).not.toHaveBeenCalled();
    fireEvent.click(enter);
    expect(onSignedIn).toHaveBeenCalledOnce();
  });

  it('enters once when a login started on the gate completes', async () => {
    vi.useFakeTimers();
    signedIn = false;
    const onSignedIn = vi.fn();
    render(<I18nProvider initial="en"><TokenToSeaAccount variant="gate" onSignedIn={onSignedIn} /></I18nProvider>);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign in with TokenToSea' })); });
    expect(screen.getByRole('button', { name: 'Finish signing in in your browser…' })).toBeDisabled();
    signedIn = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_800); });
    expect(onSignedIn).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(3_600); });
    expect(onSignedIn).toHaveBeenCalledOnce();
  });
});
