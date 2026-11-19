// @vitest-environment jsdom
import '../fantay/helpers/radix-jsdom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiUsageSummary, AiUsageTotals } from '@open-design/contracts';
import { I18nProvider } from '../../src/i18n';
import { UsageDashboard } from '../../src/components/usage/UsageDashboard';
import { presetRange, todayKey } from '../../src/components/usage/usage-format';
import {
  buildUsageReceipt,
  cleanReceiptModelDisplayName,
  defaultReceiptMetric,
  formatReceiptPlainText,
  inferReceiptModelBrand,
  receiptMoney,
  receiptTokens,
} from '../../src/components/usage/usage-receipt';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function makeTotals(partial: Partial<AiUsageTotals> = {}): AiUsageTotals {
  return {
    requests: 10,
    inputTokens: 7_700_000,
    outputTokens: 20_800_000,
    cachedTokens: 240_000_000,
    chargedUsd: '0.000000',
    refundedUsd: '0.000000',
    reportedUsd: '2177.030000',
    reservedUsd: '0.000000',
    pending: 0,
    unknown: 2,
    failed: 3,
    withTokens: 10,
    ...partial,
  };
}

describe('usage-receipt model and invariants', () => {
  it('builds a daily receipt with streak, vs-daily-avg, grouped agent models, cache rate and unknown-cost footnote', () => {
    const claudeTotals = makeTotals({ requests: 7, reportedUsd: '2162.880000', unknown: 1 });
    const opusTotals = makeTotals({ requests: 5, reportedUsd: '2162.470000', unknown: 0 });
    const sonnetTotals = makeTotals({ requests: 2, reportedUsd: '0.410000', unknown: 1 });
    const codexTotals = makeTotals({ requests: 3, reportedUsd: '14.150000', unknown: 1 });
    const gptTotals = makeTotals({ requests: 3, reportedUsd: '14.150000', unknown: 1 });

    const summary: AiUsageSummary = {
      days: 1,
      from: '2026-11-10',
      to: '2026-11-10',
      bucket: 'hour',
      timeZone: 'Asia/Shanghai',
      provider: null,
      coverageSince: Date.parse('2026-11-10T01:00:00Z'),
      account: 'local',
      totals: makeTotals(),
      daily: [{ day: '2026-11-10', totals: makeTotals() }],
      models: [
        { provider: 'claude', model: 'claude-sonnet-5', totals: sonnetTotals },
        { provider: 'claude', model: 'claude-opus-5-5', totals: opusTotals },
        { provider: 'codex', model: 'gpt-5.2', totals: gptTotals },
      ],
      providers: [
        { provider: 'codex', totals: codexTotals },
        { provider: 'claude', totals: claudeTotals },
      ],
      projects: [],
      availableProviders: [
        { provider: 'claude', requests: 7 },
        { provider: 'codex', requests: 3 },
      ],
      series: [],
      hours: Array.from({ length: 24 }, () => ({ requests: 0, tokens: 0, costUsd: '0.000000' })),
      recent: [],
      activity: {
        from: '2025-11-05',
        to: '2026-11-11',
        days: [
          { day: '2026-11-08', requests: 10, tokens: 1_000_000, costUsd: '200.000000', unknown: 0 },
          { day: '2026-11-09', requests: 12, tokens: 2_000_000, costUsd: '200.000000', unknown: 0 },
          { day: '2026-11-10', requests: 10, tokens: 28_500_000, costUsd: '2177.030000', unknown: 2 },
        ],
      },
    };

    const receipt = buildUsageReceipt({
      data: summary,
      activity: summary.activity,
      metric: 'cost',
      zh: true,
      today: '2026-11-11',
      issuedAt: new Date(2026, 10, 11, 14, 16).getTime(),
      preset: 'yesterday',
    });

    expect(receipt.title).toBe('每日 AI 账单');
    expect(receipt.subtitle).toBe('Fantay');
    expect(receipt.metaRows).toEqual([
      { label: '日期', value: '2026年11月10日' },
      { label: '开具', value: '2026年11月11日 14:16' },
    ]);
    expect(receipt.heroFigures).toEqual([{ label: 'API 总费用', value: '$2,177.03' }]);
    expect(receipt.heroSubnote).toBeNull();
    expect(receipt.summaryRows).toContainEqual({ label: '连续使用', value: '3 天' });
    expect(receipt.summaryRows).toContainEqual({ label: '请求数', value: '10' });
    expect(receipt.summaryRows).toContainEqual({ label: '错误', value: '3' });
    expect(receipt.summaryRows.find(r => r.label === '对比日均')?.value).toBe('2.5×');

    // Groups sorted descending by cost, and models inside each group sorted descending by cost.
    expect(receipt.groups.map(g => g.label)).toEqual(['CLAUDE', 'CODEX']);
    expect(receipt.groups[0]?.valueText).toBe('$2,162.88');
    expect(receipt.groups[0]?.models.map(m => [m.displayName, m.valueText])).toEqual([
      ['CLAUDE-OPUS-5-5', '$2,162.47'],
      ['CLAUDE-SONNET-5', '$0.41'],
    ]);
    expect(receipt.groups[1]?.models[0]?.brandIcon?.src).toBe('/model-brand-icons/openai.svg');

    // Token summary & unknown cost footnote
    expect(receipt.tokenRows).toContainEqual({ label: 'TOKEN 总量', value: '28.5M' });
    expect(receipt.tokenRows).toContainEqual({ label: '输入', value: '7.70M' });
    expect(receipt.tokenRows).toContainEqual({ label: '输出', value: '20.8M' });
    expect(receipt.footnotes).toContain('2 次请求未提供费用');
    expect(receipt.footerLines).toEqual(['Fantay · design.tokentosea.com']);

    const plain = formatReceiptPlainText(receipt, true);
    expect(plain).toContain('每日 AI 账单');
    expect(plain).toContain('$2,177.03');
    expect(plain).toContain('• CLAUDE-OPUS-5-5  $2,162.47');
  });

  it('never adds TokenToSea billed charges and CLI self-reported costs together, and never shows unavailable cost as $0', () => {
    const mixedTotals = makeTotals({
      chargedUsd: '12.500000',
      reportedUsd: '34.200000',
      unknown: 0,
    });
    const mixedSummary: AiUsageSummary = {
      days: 7,
      from: '2026-11-05',
      to: '2026-11-11',
      bucket: 'day',
      timeZone: 'Asia/Shanghai',
      provider: null,
      coverageSince: null,
      account: 'signed-in',
      totals: mixedTotals,
      daily: [],
      models: [
        { provider: 'tokentosea', model: 'gemini-2.5-pro', totals: makeTotals({ chargedUsd: '12.500000', reportedUsd: '0.000000', unknown: 0 }) },
        { provider: 'claude', model: 'claude-sonnet-4-5', totals: makeTotals({ chargedUsd: '0.000000', reportedUsd: '34.200000', unknown: 0 }) },
      ],
      providers: [
        { provider: 'tokentosea', totals: makeTotals({ chargedUsd: '12.500000', reportedUsd: '0.000000', unknown: 0 }) },
        { provider: 'claude', totals: makeTotals({ chargedUsd: '0.000000', reportedUsd: '34.200000', unknown: 0 }) },
      ],
      projects: [],
      availableProviders: [],
      series: [],
      hours: [],
      recent: [],
    };

    const receipt = buildUsageReceipt({
      data: mixedSummary,
      metric: 'cost',
      zh: true,
      today: '2026-11-11',
      issuedAt: Date.now(),
      preset: '7d',
    });
    expect(receipt.heroEyebrow).toBeNull();
    expect(receipt.heroSubnote).toBeNull();
    expect(receipt.heroFigures).toEqual([
      { label: 'TokenToSea', value: '$12.50' },
      { label: '其他渠道', value: '$34.20' },
    ]);

    // Pure token-only local usage without reported cost defaults to `tokens` and shows `未提供` if switched to `cost`.
    const unpricedTotals = makeTotals({
      requests: 5,
      chargedUsd: '0.000000',
      reportedUsd: '0.000000',
      unknown: 5,
      inputTokens: 12_400,
      outputTokens: 9_600,
    });
    expect(defaultReceiptMetric(unpricedTotals)).toBe('tokens');

    const unpricedCostReceipt = buildUsageReceipt({
      data: {
        ...mixedSummary,
        totals: unpricedTotals,
        providers: [{ provider: 'deepseek-harness', totals: unpricedTotals }],
        models: [{ provider: 'deepseek-harness', model: 'deepseek-chat', totals: unpricedTotals }],
      },
      metric: 'cost',
      zh: true,
      today: '2026-11-11',
      issuedAt: Date.now(),
    });
    expect(unpricedCostReceipt.heroFigures[0]?.value).toBe('未提供');
    expect(unpricedCostReceipt.groups[0]?.valueText).toBe('未提供');
  });

  it('formats compact receipt figures and infers vendor icons accurately', () => {
    expect(receiptTokens(4_900_000_000)).toBe('4.90B');
    expect(receiptTokens(20_800_000)).toBe('20.8M');
    expect(receiptTokens(7_700_000)).toBe('7.70M');
    expect(receiptTokens(850)).toBe('850');
    expect(receiptMoney('0.00004')).toBe('<$0.0001');
    expect(receiptMoney('0.0042')).toBe('$0.0042');
    expect(receiptMoney('2177.03')).toBe('$2,177.03');

    expect(inferReceiptModelBrand('openrouter/anthropic/claude-opus-5.5')?.src).toBe('/model-brand-icons/claude.svg');
    expect(inferReceiptModelBrand('deepseek/deepseek-v4.1-flash')?.src).toBe('/model-brand-icons/deepseek.svg');
    expect(inferReceiptModelBrand('gpt-image-2.5')?.src).toBe('/model-brand-icons/openai.svg');
    expect(inferReceiptModelBrand('tokentosea:gpt/gpt-6-astra')?.src).toBe('/model-brand-icons/openai.svg');
    expect(inferReceiptModelBrand('unknown-local-runner')).toBeNull();

    expect(cleanReceiptModelDisplayName('official:deepseek-v4.1-flash')).toBe('DEEPSEEK-V4.1-FLASH');
    expect(cleanReceiptModelDisplayName('supplier:suanlizhixuan/global/claude-fable-5.1')).toBe('CLAUDE-FABLE-5.1');
    expect(cleanReceiptModelDisplayName('tokentosea:gpt/gpt-6-astra')).toBe('GPT/GPT-6-ASTRA');
    expect(cleanReceiptModelDisplayName('anthropic/claude-opus-5.5')).toBe('ANTHROPIC/CLAUDE-OPUS-5.5');
  });
});

describe('UsageReceiptModal integration in UsageDashboard', () => {
  it('opens receipt modal from UsageDashboard, switches to Yesterday, and copies plain text with live announcement', async () => {
    const today = todayKey();
    const range = presetRange('30d', today);
    const baseTotals = makeTotals({ requests: 4, reportedUsd: '18.600000', unknown: 0, failed: 0 });
    const bucketMetric = { requests: 4, tokens: 28_500_000, costUsd: '18.600000' };
    const baseSummary: AiUsageSummary = {
      days: 30,
      from: range.from,
      to: range.to,
      bucket: 'day',
      timeZone: 'Asia/Shanghai',
      provider: null,
      coverageSince: Date.now(),
      account: 'local',
      totals: baseTotals,
      daily: [{ day: today, totals: baseTotals }],
      models: [{ provider: 'claude', model: 'claude-opus-5-5', totals: baseTotals }],
      providers: [{ provider: 'claude', totals: baseTotals }],
      projects: [],
      availableProviders: [{ provider: 'claude', requests: 4 }],
      series: [{
        start: today,
        ...bucketMetric,
        failed: 0,
        unknown: 0,
        chargedUsd: '0.000000',
        reportedUsd: '18.600000',
        groups: {
          model: { 'claude-opus-5-5': bucketMetric },
          provider: { claude: bucketMetric },
          project: {},
        },
      }],
      hours: Array.from({ length: 24 }, () => ({ requests: 0, tokens: 0, costUsd: '0.000000' })),
      recent: [],
      activity: { from: today, to: today, days: [{ day: today, requests: 4, tokens: 28_500_000, costUsd: '18.600000', unknown: 0 }] },
    };

    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('limit=0')) {
        return Response.json({
          ...baseSummary,
          days: 1,
          from: '2026-11-10',
          to: '2026-11-10',
          totals: makeTotals({ requests: 2, reportedUsd: '9.400000', unknown: 0 }),
          providers: [{ provider: 'codex', totals: makeTotals({ requests: 2, reportedUsd: '9.400000', unknown: 0 }) }],
          models: [{ provider: 'codex', model: 'gpt-5.2', totals: makeTotals({ requests: 2, reportedUsd: '9.400000', unknown: 0 }) }],
        });
      }
      return Response.json(baseSummary);
    });
    vi.stubGlobal('fetch', fetcher);

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <I18nProvider initial="zh-CN">
        <UsageDashboard />
      </I18nProvider>,
    );

    const trigger = await screen.findByRole('button', { name: '生成小票' });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('AI 用量小票')).toBeInTheDocument();
    expect(within(dialog).getByText('30 日 AI 账单')).toBeInTheDocument();
    expect(within(dialog).getAllByText('$18.60').length).toBeGreaterThan(0);

    // Subtitle never carries a redundant native title tooltip that could obscure the headline, while footer domain links out
    expect(within(dialog).getByText('Fantay')).not.toHaveAttribute('title');
    const footerLink = within(dialog).getByRole('link', { name: 'design.tokentosea.com' });
    expect(footerLink).toHaveAttribute('href', 'https://design.tokentosea.com');
    expect(footerLink).toHaveAttribute('target', '_blank');

    // Switch photographic stage skin to 海汐 (`sea`)
    const backdropGroup = within(dialog).getByRole('radiogroup', { name: '画布背景' });
    fireEvent.click(within(backdropGroup).getByText('海汐'));
    expect(dialog.querySelector('[data-backdrop="sea"]')).not.toBeNull();

    // Switch to 昨天 -> triggers lightweight limit=0 query and switches title to 每日 AI 账单
    const rangeGroup = within(dialog).getByRole('radiogroup', { name: '小票统计范围' });
    fireEvent.click(within(rangeGroup).getByText('昨天'));

    await waitFor(() => {
      expect(within(dialog).getByText('每日 AI 账单')).toBeInTheDocument();
    });
    expect(within(dialog).getAllByText('$9.40').length).toBeGreaterThan(0);

    // Copy text -> keeps button enabled and writes accessible status confirmation
    const copyTextBtn = within(dialog).getByRole('button', { name: '复制文本' });
    fireEvent.click(copyTextBtn);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0])).toContain('每日 AI 账单');
    expect(copyTextBtn).not.toBeDisabled();
    expect(within(dialog).getByText(/已复制文本/)).toBeInTheDocument();
  });
});
