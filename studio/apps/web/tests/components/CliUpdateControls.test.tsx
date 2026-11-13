// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CliUpdatesSnapshot } from '@open-design/contracts';
import { I18nProvider } from '../../src/i18n';
import { CliUpdateControl, CliUpdateToolbar, useCliUpdates } from '../../src/components/CliUpdateControls';
import { requestCliUpdates } from '../../src/providers/cli-updates';

vi.mock('../../src/providers/cli-updates', () => ({ requestCliUpdates: vi.fn() }));
vi.mock('../../src/providers/registry', () => ({ openExternalUrl: vi.fn() }));
const request = vi.mocked(requestCliUpdates);
const refresh = vi.fn();
function Harness() {
  const controller = useCliUpdates(true, refresh);
  return <><CliUpdateToolbar controller={controller} /><CliUpdateControl agentId="claude" controller={controller} /></>;
}
function show(snapshot: CliUpdatesSnapshot) {
  request.mockResolvedValue(snapshot);
  render(<I18nProvider initial="zh-CN"><Harness /></I18nProvider>);
}
const available: CliUpdatesSnapshot = { checking: false, lastCheckedAt: '2026-11-02T17:00:00Z', items: [{ agentId: 'claude', state: 'available', method: 'native', canUpdate: true, installedVersion: '2.1.0', latestVersion: '2.1.1' }] };
beforeEach(() => { request.mockReset(); refresh.mockReset(); });
afterEach(cleanup);

it('checks when opened and sends only the selected CLI ID for an update', async () => {
  show(available);
  await screen.findByText('有新版本 2.1.1');
  expect(request).toHaveBeenCalledWith('check', expect.objectContaining({ force: false }));
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('update', expect.objectContaining({ agentIds: ['claude'] })));
});

it('retains an actionable error instead of showing up to date after a failed check', async () => {
  show({ ...available, items: [{ ...available.items[0]!, state: 'error', latestVersion: null, reason: 'check-failed' }] });
  await screen.findByText('未能完成，请检查网络后重试。');
  expect(screen.queryByText('已是最新版本')).toBeNull();
  expect(screen.getByRole('button', { name: '检查更新' })).toBeTruthy();
});

it('shows progress, polls the backend, refreshes versions, and never repeats a completed refresh', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const done = { ...available, items: [{ ...available.items[0]!, state: 'updated' as const, installedVersion: '2.1.1' }] };
    request.mockResolvedValueOnce({ ...available, items: [{ ...available.items[0]!, state: 'updating', phase: 'verifying' }] }).mockResolvedValue(done);
    render(<I18nProvider initial="zh-CN"><Harness /></I18nProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('验证版本…')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(screen.getByText('已更新至 2.1.1')).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it('shows the original application update entry without allowing a bundle mutation', async () => {
  show({ ...available, items: [{ ...available.items[0]!, canUpdate: false, method: 'manual', reason: 'app-managed', sourceUrl: 'https://example.com/docs' }] });
  await screen.findByText('由所属桌面应用更新');
  expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
  expect(screen.getByRole('button', { name: '官方更新入口' })).toBeTruthy();
});
