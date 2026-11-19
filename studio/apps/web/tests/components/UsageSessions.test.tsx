// @vitest-environment jsdom
import '../fantay/helpers/radix-jsdom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UsageDetails } from '../../src/components/usage/UsageDetails';
import type { AiUsageSummary } from '@open-design/contracts';
import * as usageFormat from '../../src/components/usage/usage-format';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const totals = { requests: 502, inputTokens: 5020, outputTokens: 1004, cachedTokens: 2008, chargedUsd: '0.000000', refundedUsd: '0.000000', reportedUsd: '0.000000', reservedUsd: '0.000000', estimatedUsd: '5.020000', estimatedRequests: 502, pending: 0, unknown: 502, failed: 0, withTokens: 502 };
const at = Date.parse('2026-11-14T01:00:00Z');
const data: AiUsageSummary = { scope: 'device', from: '2026-11-14', to: '2026-11-14', days: 1, bucket: 'hour', timeZone: 'Asia/Taipei', provider: 'muse', account: 'local', coverageSince: at,
  totals, daily: [], models: [], projects: [], providers: [], availableProviders: [], series: [], hours: [], recent: [],
  sessions: [{ provider: 'muse', sessionId: 'session-outside-recent', models: ['muse-wonder'], firstUsedAt: at, lastUsedAt: at, totals }] };

it('shows full session totals and fetches its requests instead of filtering the recent subset', async () => {
  const request = { requestKey: 'real-request', provider: 'muse', sessionId: 'session-outside-recent', model: 'muse-wonder', kind: 'cli', status: 'completed', inputTokens: 10, outputTokens: 2, cachedTokens: 4, chargedUsd: null, refundedUsd: null, reportedUsd: null, estimatedUsd: '0.010000', reservedUsd: null, createdAt: at, updatedAt: at };
  const fetcher = vi.fn(async () => Response.json({ ...data, recent: [request] })); vi.stubGlobal('fetch', fetcher);
  render(<UsageDetails data={data} zh locale="zh-CN" showProjects />);
  fireEvent.mouseDown(screen.getByRole('tab', { name: /会话\s*1/ }), { button: 0, ctrlKey: false });
  const panel = screen.getByRole('tabpanel');
  expect(within(panel).getByText('502')).toBeInTheDocument();
  expect(within(panel).getByText(/\$5.02/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'MuseCode · session-outside-recent' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const query = new URL(String((fetcher.mock.calls as unknown[][])[0]?.[0]), 'http://local').searchParams;
  expect(query.get('sessionId')).toBe('session-outside-recent');
  expect(query.get('provider')).toBe('muse');
  expect(query.get('limit')).toBe('1000');
  expect(await screen.findByText('muse-wonder')).toBeInTheDocument();
  expect(screen.getByText(/汇总包含全部请求/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '全部会话' }));
  expect(screen.getByRole('button', { name: 'MuseCode · session-outside-recent' })).toBeInTheDocument();
});

it('shows a session read error and retains the back action', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Read failed' }, { status: 500 })));
  render(<UsageDetails data={data} zh locale="zh-CN" showProjects />);
  fireEvent.mouseDown(screen.getByRole('tab', { name: /会话\s*1/ }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole('button', { name: 'MuseCode · session-outside-recent' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Read failed');
  expect(screen.getByRole('button', { name: '全部会话' })).toBeEnabled();
});

it('exports the full session summary with stable identity and separate estimates', () => {
  const download = vi.spyOn(usageFormat, 'downloadCsv').mockImplementation(() => undefined);
  render(<UsageDetails data={data} zh locale="zh-CN" showProjects />);
  fireEvent.mouseDown(screen.getByRole('tab', { name: /会话\s*1/ }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
  expect(download).toHaveBeenCalledOnce();
  const [, header, rows] = download.mock.calls[0]!;
  expect(rows[0]?.[header.indexOf('session_id')]).toBe('session-outside-recent');
  expect(rows[0]?.[header.indexOf('requests')]).toBe(502);
  expect(rows[0]?.[header.indexOf('reported_usd')]).toBe('0.000000');
  expect(rows[0]?.[header.indexOf('estimated_usd')]).toBe('5.020000');
});
