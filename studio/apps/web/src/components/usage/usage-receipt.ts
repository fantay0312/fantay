/* SPDX-License-Identifier: AGPL-3.0-only */
/* Pure receipt model, plain-text formatter, photographic skin loader and high-DPI 2D canvas PNG exporter for AI 用量.
   Reads the same AiUsageSummary as UsageDashboard: unavailable costs stay unavailable and billed vs reported totals
   never get added into one synthetic figure. */
import type { AiUsageSummary, AiUsageTotals } from '@open-design/contracts';
import { copyImageDataUrlToClipboard, downloadImageDataUrl } from '../../runtime/exports';
import { agentIconId } from '../../utils/agentLabels';
import { resolveModelBrandIcon } from '../tokentosea/ModelBrandIcon';
import { count, percent, providerLabel, shiftDay } from './usage-format';

export type ReceiptMetricMode = 'cost' | 'tokens';
export type ReceiptBackdrop = 'mist' | 'sea' | 'stone' | 'ink' | 'paper';
export type ScenicReceiptBackdrop = Exclude<ReceiptBackdrop, 'paper'>;

export const RECEIPT_FOOTER_DOMAIN = 'design.tokentosea.com';
export const RECEIPT_FOOTER_URL = 'https://design.tokentosea.com';

export interface ReceiptHeroFigure {
  label: string;
  value: string;
}

export interface ReceiptStatRow {
  label: string;
  value: string;
  muted?: boolean;
}

export interface ReceiptModelItem {
  model: string;
  displayName: string;
  brandIcon: { src: string; mono: boolean } | null;
  valueText: string;
  sortValue: number;
  requests: number;
}

export interface ReceiptAgentGroup {
  provider: string;
  label: string;
  iconId: string;
  valueText: string;
  sortValue: number;
  requests: number;
  models: ReceiptModelItem[];
  foldedCount: number;
  foldedValueText: string | null;
}

export interface UsageReceiptModel {
  title: string;
  subtitle: string;
  metaRows: ReceiptStatRow[];
  metric: ReceiptMetricMode;
  heroEyebrow: string | null;
  /** Single headline figure in normal cases; two side-by-side figures when both TokenToSea charges and CLI-reported
   *  costs are non-zero, preserving Fantay's invariant never to sum billed receipts with provider-reported estimates. */
  heroFigures: ReceiptHeroFigure[];
  heroSubnote: string | null;
  summaryRows: ReceiptStatRow[];
  breakdownHeader: { left: string; right: string };
  groups: ReceiptAgentGroup[];
  tokenRows: ReceiptStatRow[];
  footnotes: string[];
  footerLines: string[];
  filenameBase: string;
}

const MAX_MODELS_PER_GROUP = 10;

const pad2 = (n: number) => String(n).padStart(2, '0');

function sig3(value: number): string {
  if (value >= 100) return Math.round(value).toLocaleString('en-US');
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

/** Compact token formatting aligned with receipt columns (`4.90B`, `20.8M`, `7.71K`, `850`). */
export function receiptTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return count(Math.round(value));
  if (value < 1_000_000) return `${sig3(value / 1_000)}K`;
  if (value < 1_000_000_000) return `${sig3(value / 1_000_000)}M`;
  return `${sig3(value / 1_000_000_000)}B`;
}

/** Cents for regular dollar figures (`$2,177.03`, `$0.35`, `$0.00`), four decimals for sub-cent (`$0.0042`), and
 *  `<$0.0001` below one tenth of a mill so non-zero usage never masquerades as `$0.00`. */
export function receiptMoney(value: string | number): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  if (amount < 0.0001) return '<$0.0001';
  const digits = amount < 0.01 ? 4 : 2;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

/** Defaults to `cost` whenever any non-zero cost is known, otherwise `tokens` if token counts exist. */
export function defaultReceiptMetric(totals: AiUsageTotals | null | undefined): ReceiptMetricMode {
  if (!totals) return 'cost';
  const knownCost = Number(totals.chargedUsd) + Number(totals.reportedUsd);
  if (knownCost > 0) return 'cost';
  if (totals.inputTokens + totals.outputTokens > 0 && totals.unknown > 0) return 'tokens';
  return 'cost';
}

export function fullDateLabel(day: string, zh: boolean): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  if (zh) return `${year}年${month}月${date}日`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[month - 1]} ${date}, ${year}`;
}

export function fullRangeLabel(from: string, to: string, zh: boolean): string {
  if (from === to) return fullDateLabel(from, zh);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  if (!sameYear) return `${fullDateLabel(from, zh)} – ${fullDateLabel(to, zh)}`;
  const [, endMonth, endDate] = to.split('-').map(Number) as [number, number, number];
  if (zh) return `${fullDateLabel(from, true)} – ${endMonth}月${endDate}日`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(from.slice(5, 7)) - 1]} ${Number(from.slice(8, 10))} – ${months[endMonth - 1]} ${endDate}, ${from.slice(0, 4)}`;
}

export function issuedAtLabel(timestamp: number, zh: boolean): string {
  const at = new Date(timestamp);
  const day = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  return `${fullDateLabel(day, zh)} ${clock}`;
}

const MODEL_BRAND_PATTERNS: ReadonlyArray< readonly [RegExp, string] > = [
  [/claude|anthropic/i, 'claude'],
  [/(?:^|[/:-])(?:gpt(?=$|[/:-])|chatgpt|o1(?=$|-)|o3(?=$|-)|o4(?=$|-)|dall-e|sora|whisper|codex|openai)/i, 'openai'],
  [/deepseek/i, 'deepseek'],
  [/gemini|gemma|imagen|veo/i, 'gemini'],
  [/grok|xai/i, 'grok'],
  [/qwen|qwq|qvq/i, 'qwen'],
  [/(?:^|[/:-])wan(?=$|[-0-9])/i, 'wan'],
  [/kimi|moonshot/i, 'kimi'],
  [/glm|chatglm|zhipu|cogview|cogvideo/i, 'zhipu'],
  [/minimax|abab|hailuo/i, 'minimax'],
  [/doubao|seedream|seedance/i, 'doubao'],
  [/mistral|codestral|pixtral|ministral/i, 'mistral'],
  [/llama/i, 'meta'],
  [/hunyuan/i, 'hunyuan'],
  [/ernie|wenxin/i, 'wenxin'],
  [/(?:^|[/:-])yi-/i, 'yi'],
];

/** Strips internal gateway routing prefixes (`official:`, `supplier:<vendor>/global/`, `tokentosea:`) while keeping
 *  standard `vendor/model` identifiers (`ANTHROPIC/CLAUDE-OPUS-5.5`) intact for receipt columns. */
export function cleanReceiptModelDisplayName(rawModel: string, fallbackProvider = ''): string {
  const trimmed = rawModel.trim();
  if (!trimmed) return fallbackProvider.trim().toUpperCase();
  const stripped = trimmed
    .replace(/^official:/i, '')
    .replace(/^supplier:[^/]+\/(?:global\/)?/i, '')
    .replace(/^(?:tokentosea|amr):/i, '');
  return (stripped || trimmed || fallbackProvider.trim()).toUpperCase();
}

/** Resolves a monochrome model vendor mark from a raw model identifier; returns null when unknown (`•` bullet). */
export function inferReceiptModelBrand(modelName: string): { src: string; mono: boolean } | null {
  const trimmed = modelName.trim();
  if (!trimmed) return null;
  const cleaned = cleanReceiptModelDisplayName(trimmed);
  const tail = cleaned.includes('/') ? cleaned.slice(cleaned.lastIndexOf('/') + 1) : cleaned;
  for (const candidate of [tail, cleaned, trimmed]) {
    for (const [pattern, brand] of MODEL_BRAND_PATTERNS) {
      if (pattern.test(candidate)) {
        // Use monochrome SVG variants on thermal paper whenever available.
        return { src: `/model-brand-icons/${brand}.svg`, mono: true };
      }
    }
  }
  const resolved = resolveModelBrandIcon({ brand: tail.toLowerCase() });
  return resolved ? { src: resolved.src, mono: true } : null;
}

function rowKnownCost(totals: AiUsageTotals): number {
  return Number(totals.chargedUsd) + Number(totals.reportedUsd);
}

function formatRowValue(totals: AiUsageTotals, metric: ReceiptMetricMode, zh: boolean): { text: string; sort: number } {
  if (metric === 'tokens') {
    const sum = totals.inputTokens + totals.outputTokens;
    if (sum === 0 && totals.requests > 0 && totals.withTokens === 0) {
      return { text: '—', sort: 0 };
    }
    return { text: receiptTokens(sum), sort: sum };
  }
  if (totals.unknown > 0 && totals.unknown >= totals.requests) {
    return { text: zh ? '未提供' : 'n/a', sort: -1 };
  }
  const amount = rowKnownCost(totals);
  return { text: receiptMoney(amount), sort: amount };
}

function computeStreak(
  activity: AiUsageSummary['activity'] | null | undefined,
  anchorDay: string,
  today: string,
): number | null {
  if (!activity?.days.length) return null;
  const activeSet = new Set(activity.days.filter(d => d.requests > 0 || d.tokens > 0).map(d => d.day));
  if (!activeSet.size) return 0;
  let cursor = anchorDay;
  if (anchorDay === today && !activeSet.has(today)) {
    cursor = shiftDay(today, -1);
  }
  let streak = 0;
  while (cursor >= activity.from && activeSet.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return streak;
}

function formatRatioMultiple(ratio: number): string | null {
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  if (ratio < 0.05) return '<0.1×';
  return `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×`;
}

function computeDailyComparison(
  data: AiUsageSummary,
  activity: AiUsageSummary['activity'] | null | undefined,
  metric: ReceiptMetricMode,
): string | null {
  if (!activity?.days.length) return null;
  const activeDays = activity.days.filter(d => d.requests > 0 || d.tokens > 0);
  if (activeDays.length < 2) return null;

  if (metric === 'cost') {
    const pricedDays = activeDays.filter(d => Number(d.costUsd) > 0);
    if (pricedDays.length < 2) return null;
    const avgDailyCost = pricedDays.reduce((sum, d) => sum + Number(d.costUsd), 0) / pricedDays.length;
    if (!(avgDailyCost > 0)) return null;
    const rangeCost = rowKnownCost(data.totals);
    if (!(rangeCost > 0)) return null;
    const rangeActiveCount = Math.max(1, data.days === 1 ? 1 : data.daily.filter(d => rowKnownCost(d.totals) > 0).length);
    return formatRatioMultiple((rangeCost / rangeActiveCount) / avgDailyCost);
  }

  const tokenDays = activeDays.filter(d => d.tokens > 0);
  if (tokenDays.length < 2) return null;
  const avgDailyTokens = tokenDays.reduce((sum, d) => sum + d.tokens, 0) / tokenDays.length;
  if (!(avgDailyTokens > 0)) return null;
  const rangeTokens = data.totals.inputTokens + data.totals.outputTokens;
  if (!(rangeTokens > 0)) return null;
  const rangeActiveCount = Math.max(1, data.days === 1 ? 1 : data.daily.filter(d => d.totals.inputTokens + d.totals.outputTokens > 0).length);
  return formatRatioMultiple((rangeTokens / rangeActiveCount) / avgDailyTokens);
}

function receiptTitle(data: AiUsageSummary, preset: string | undefined, zh: boolean): string {
  if (data.from === data.to) return zh ? '每日 AI 账单' : 'DAILY AI RECEIPT';
  if (preset === '7d' || data.days === 7) return zh ? '7 日 AI 账单' : '7-DAY AI RECEIPT';
  if (preset === 'mtd' || preset === 'last-month') return zh ? '月度 AI 账单' : 'MONTHLY AI RECEIPT';
  if (preset === '30d' || data.days === 30) return zh ? '30 日 AI 账单' : '30-DAY AI RECEIPT';
  return zh ? 'AI 用量账单' : 'AI USAGE RECEIPT';
}

export interface BuildUsageReceiptOptions {
  data: AiUsageSummary;
  activity?: AiUsageSummary['activity'] | null;
  metric: ReceiptMetricMode;
  zh: boolean;
  today: string;
  issuedAt: number;
  preset?: string;
  projectName?: string;
}

export function buildUsageReceipt(options: BuildUsageReceiptOptions): UsageReceiptModel {
  const { data, activity, metric, zh, today, issuedAt, preset, projectName } = options;
  const t = data.totals;

  const scopeParts = ['Fantay'];
  if (projectName) scopeParts.push(projectName);
  if (data.provider) scopeParts.push(providerLabel(data.provider));

  const metaRows: ReceiptStatRow[] = [
    {
      label: data.from === data.to ? (zh ? '日期' : 'Date') : (zh ? '范围' : 'Period'),
      value: fullRangeLabel(data.from, data.to, zh),
    },
    {
      label: zh ? '开具' : 'Issued',
      value: issuedAtLabel(issuedAt, zh),
    },
  ];

  // Hero block: strictly preserves billed vs reported separation and unavailable cost truth without verbose disclaimers.
  let heroEyebrow: string | null = null;
  let heroFigures: ReceiptHeroFigure[];
  const heroSubnote: string | null = null;

  if (metric === 'tokens') {
    const sumTokens = t.inputTokens + t.outputTokens;
    heroEyebrow = zh ? 'TOKEN 总量' : 'TOTAL TOKENS';
    heroFigures = [{ label: heroEyebrow, value: t.requests > 0 && t.withTokens === 0 ? '—' : receiptTokens(sumTokens) }];
  } else {
    const charged = Number(t.chargedUsd);
    const reported = Number(t.reportedUsd);
    const allUnknown = t.unknown > 0 && t.unknown >= t.requests;
    if (allUnknown) {
      heroEyebrow = zh ? 'API 总费用' : 'API COST';
      heroFigures = [{ label: heroEyebrow, value: zh ? '未提供' : 'N/A' }];
    } else if (charged > 0 && reported > 0) {
      heroFigures = [
        { label: 'TokenToSea', value: receiptMoney(t.chargedUsd) },
        { label: zh ? '其他渠道' : 'Other sources', value: receiptMoney(t.reportedUsd) },
      ];
    } else if (charged > 0 || (data.providers.length === 1 && data.providers[0]?.provider === 'tokentosea')) {
      heroEyebrow = 'TokenToSea';
      heroFigures = [{ label: 'TokenToSea', value: receiptMoney(t.chargedUsd) }];
    } else {
      heroEyebrow = zh ? 'API 总费用' : 'API COST';
      heroFigures = [{ label: heroEyebrow, value: receiptMoney(t.reportedUsd) }];
    }
  }

  // Summary rows (streak / active days, requests, failed, vs daily average).
  const summaryRows: ReceiptStatRow[] = [];
  if(t.sessionRecords)summaryRows.push({label:zh?'会话汇总':'Session summaries',value:count(t.sessionRecords)});
  if (data.scope === 'device') summaryRows.push({ label: zh ? '统计范围' : 'Scope', value: zh ? '本机全部' : 'This device' });
  if ((t.estimatedRequests ?? 0) > 0) summaryRows.push({ label: zh ? 'Token 估算价值' : 'Estimated token value', value: receiptMoney(t.estimatedUsd ?? '0') });
  const streak = data.from === data.to || data.to === today ? computeStreak(activity, data.to, today) : null;
  if (streak !== null && streak > 0) {
    summaryRows.push({
      label: zh ? '连续使用' : 'Active streak',
      value: zh ? `${count(streak)} 天` : `${count(streak)} d`,
    });
  } else if (data.days > 1) {
    const activeInRange = data.daily.filter(d => d.totals.requests > 0).length;
    summaryRows.push({
      label: zh ? '活跃天数' : 'Active days',
      value: zh ? `${count(activeInRange)} / ${count(data.days)} 天` : `${count(activeInRange)} / ${count(data.days)} d`,
    });
  }
  summaryRows.push({
    label: zh ? '请求数' : 'Requests',
    value: count(t.requests),
  });
  summaryRows.push({
    label: zh ? '错误' : 'Errors',
    value: count(t.failed),
  });
  const vsAvg = computeDailyComparison(data, activity, metric);
  if (vsAvg) {
    summaryRows.push({
      label: zh ? '对比日均' : 'vs. daily avg',
      value: vsAvg,
    });
  }

  // Group models under each provider (Agent).
  const modelsByProvider = new Map<string, Array<{ model: string; totals: AiUsageTotals }>>();
  for (const entry of data.models) {
    const list = modelsByProvider.get(entry.provider);
    if (list) list.push({ model: entry.model, totals: entry.totals });
    else modelsByProvider.set(entry.provider, [{ model: entry.model, totals: entry.totals }]);
  }

  const groups: ReceiptAgentGroup[] = data.providers
    .map((prov): ReceiptAgentGroup => {
      const groupVal = formatRowValue(prov.totals, metric, zh);
      const rawModels = modelsByProvider.get(prov.provider) ?? [];
      const ranked = rawModels
        .map((item) => {
          const val = formatRowValue(item.totals, metric, zh);
          const cleanName = cleanReceiptModelDisplayName(item.model, prov.provider);
          return {
            model: item.model,
            displayName: cleanName,
            brandIcon: inferReceiptModelBrand(item.model),
            valueText: val.text,
            sortValue: val.sort,
            requests: item.totals.requests,
            totals: item.totals,
          };
        })
        .sort((a, b) => b.sortValue - a.sortValue || b.requests - a.requests || a.displayName.localeCompare(b.displayName));

      const visible = ranked.slice(0, MAX_MODELS_PER_GROUP).map(({ totals: _ignored, ...rest }) => rest);
      const hidden = ranked.slice(MAX_MODELS_PER_GROUP);
      let foldedValueText: string | null = null;
      if (hidden.length > 0) {
        if (metric === 'tokens') {
          const restTokens = hidden.reduce((sum, item) => sum + item.totals.inputTokens + item.totals.outputTokens, 0);
          foldedValueText = receiptTokens(restTokens);
        } else {
          const allHiddenUnknown = hidden.every(item => item.totals.unknown >= item.totals.requests);
          const restCost = hidden.reduce((sum, item) => sum + rowKnownCost(item.totals), 0);
          foldedValueText = allHiddenUnknown ? (zh ? '未提供' : 'n/a') : receiptMoney(restCost);
        }
      }

      return {
        provider: prov.provider,
        label: providerLabel(prov.provider).toUpperCase(),
        iconId: agentIconId(prov.provider),
        valueText: groupVal.text,
        sortValue: groupVal.sort,
        requests: prov.totals.requests,
        models: visible,
        foldedCount: hidden.length,
        foldedValueText,
      };
    })
    .sort((a, b) => b.sortValue - a.sortValue || b.requests - a.requests || a.label.localeCompare(b.label));

  // Bottom token stats.
  const sumTokens = t.inputTokens + t.outputTokens;
  const cachePool = t.inputTokens + t.cachedTokens;
  const cacheRate = cachePool > 0 ? percent(t.cachedTokens / cachePool) : '—';
  const tokenRows: ReceiptStatRow[] = [
    { label: zh ? 'TOKEN 总量' : 'TOTAL TOKENS', value: t.requests > 0 && t.withTokens === 0 ? '—' : receiptTokens(sumTokens) },
    { label: zh ? '输入' : 'Input', value: t.requests > 0 && t.withTokens === 0 ? '—' : receiptTokens(t.inputTokens) },
    { label: zh ? '输出' : 'Output', value: t.requests > 0 && t.withTokens === 0 ? '—' : receiptTokens(t.outputTokens) },
  ];
  if (t.cachedTokens > 0) {
    tokenRows.push({ label: zh ? '缓存读取' : 'Cache reads', value: receiptTokens(t.cachedTokens) });
  }
  tokenRows.push({ label: zh ? '缓存命中率' : 'Cache hit rate', value: cacheRate });

  const footnotes: string[] = [];
  if (t.unknown > 0) {
    footnotes.push(zh ? `${count(t.unknown)} 次请求未提供费用` : `${count(t.unknown)} requests without price`);
  }
  if (Number(t.refundedUsd) > 0) {
    footnotes.push(zh ? `已退款 ${receiptMoney(t.refundedUsd)}` : `Refunded ${receiptMoney(t.refundedUsd)}`);
  }
  if (t.pending > 0) {
    footnotes.push(zh ? `${count(t.pending)} 次请求处理中` : `${count(t.pending)} requests pending`);
  }

  const footerLines: string[] = ['Fantay · design.tokentosea.com'];

  const filenameBase = data.from === data.to
    ? `fantay-receipt-${data.from}`
    : `fantay-receipt-${data.from}_${data.to}`;

  return {
    title: receiptTitle(data, preset, zh),
    subtitle: scopeParts.join(' · '),
    metaRows,
    metric,
    heroEyebrow,
    heroFigures,
    heroSubnote,
    summaryRows,
    breakdownHeader: {
      left: zh ? 'AGENT / 模型' : 'AGENT / MODEL',
      right: metric === 'tokens' ? 'TOKEN' : (zh ? '费用' : 'COST'),
    },
    groups,
    tokenRows,
    footnotes,
    footerLines,
    filenameBase,
  };
}

/** Formats a clean plain-text monospace receipt for clipboard text sharing. */
export function formatReceiptPlainText(receipt: UsageReceiptModel, zh: boolean): string {
  const divider = '----------------------------------------';
  const line = (left: string, right: string) => `${left}  ${right}`;
  const out: string[] = [
    receipt.title,
    receipt.subtitle,
    '',
    ...receipt.metaRows.map(r => line(r.label, r.value)),
    divider,
  ];
  if (receipt.heroFigures.length === 1) {
    if (receipt.heroEyebrow) out.push(receipt.heroEyebrow);
    out.push(receipt.heroFigures[0]!.value);
    if (receipt.heroSubnote) out.push(receipt.heroSubnote);
  } else {
    if (receipt.heroEyebrow) out.push(receipt.heroEyebrow);
    out.push(...receipt.heroFigures.map(f => line(f.label, f.value)));
    if (receipt.heroSubnote) out.push(receipt.heroSubnote);
  }
  out.push(divider, ...receipt.summaryRows.map(r => line(r.label, r.value)), divider);
  out.push(line(receipt.breakdownHeader.left, receipt.breakdownHeader.right));
  for (const group of receipt.groups) {
    out.push(line(group.label, group.valueText));
    for (const m of group.models) {
      out.push(line(`  • ${m.displayName}`, m.valueText));
    }
    if (group.foldedCount > 0 && group.foldedValueText) {
      out.push(line(zh ? `  • 其他 ${group.foldedCount} 个模型` : `  • ${group.foldedCount} more models`, group.foldedValueText));
    }
  }
  out.push(divider, ...receipt.tokenRows.map(r => line(r.label, r.value)));
  if (receipt.footnotes.length) {
    out.push(...receipt.footnotes);
  }
  out.push(divider, ...receipt.footerLines);
  return out.join('\n');
}

/* ── Photographic Backdrop Skins & High-DPI 2D Canvas Receipt Exporter ──────────────────── */

const AGENT_ICON_EXT: Record<string, 'svg' | 'png'> = {
  tokentosea: 'svg', claude: 'svg', codex: 'svg', gemini: 'svg', opencode: 'svg',
  'cursor-agent': 'svg', copilot: 'svg', qwen: 'svg', qoder: 'svg', deepseek: 'svg',
  reasonix: 'svg', mimo: 'svg', hermes: 'svg', 'grok-build': 'svg', kimi: 'svg',
  pi: 'svg', kiro: 'svg', kilo: 'svg', vibe: 'svg', antigravity: 'svg', glm: 'svg',
  aider: 'png', 'trae-cli': 'png', devin: 'png',
};
const AGENT_ICON_ALIAS: Record<string, string> = {
  'deepseek-harness': 'deepseek',
  amr: 'tokentosea',
  cursor: 'cursor-agent',
  grok: 'grok-build',
  'antigravity-ide': 'antigravity',
  'antigravity-insiders': 'antigravity',
  'qoder-cn': 'qoder',
  omp: 'pi',
  'anthropic-api': 'claude',
  'google-gemini-api': 'gemini',
};

function agentIconAssetUrl(iconId: string): string | null {
  const id = AGENT_ICON_ALIAS[iconId] ?? iconId;
  const ext = AGENT_ICON_EXT[id];
  return ext ? `/agent-icons/${id}.${ext}` : null;
}

const iconCanvasCache = new Map<string, Promise<HTMLCanvasElement | null>>();
const backdropSkinCache = new Map<ScenicReceiptBackdrop, Promise<HTMLImageElement | null>>();

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

/** Loads the 2× photographic skin for canvas PNG export (WebP first, JPEG fallback, null in headless unit tests). */
export function loadBackdropSkinImage(backdrop: ScenicReceiptBackdrop): Promise<HTMLImageElement | null> {
  const cached = backdropSkinCache.get(backdrop);
  if (cached) return cached;

  const pending = (async (): Promise<HTMLImageElement | null> => {
    try {
      return await loadHtmlImage(`/receipt-skins/${backdrop}-2x.webp`);
    } catch {
      try {
        return await loadHtmlImage(`/receipt-skins/${backdrop}-2x.jpg`);
      } catch {
        backdropSkinCache.delete(backdrop);
        return null;
      }
    }
  })();

  backdropSkinCache.set(backdrop, pending);
  return pending;
}

const FALLBACK_TONES: Record<ScenicReceiptBackdrop, readonly [string, string, string]> = {
  mist: ['#9aa4a6', '#566865', '#2a3936'],
  sea: ['#cdd4d8', '#687980', '#232e33'],
  stone: ['#e6decb', '#d9ceb9', '#c7baa2'],
  ink: ['#252321', '#181716', '#0f0f0e'],
};

/** Paints the photographic backdrop with `object-fit: cover` geometry and a soft edge vignette. */
export function paintReceiptBackdrop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  backdrop: ReceiptBackdrop,
  skinImage?: HTMLImageElement | null,
): void {
  ctx.save();
  if (backdrop === 'paper') {
    ctx.clearRect(0, 0, width, height);
    ctx.restore();
    return;
  }

  const imgW = skinImage ? (skinImage.naturalWidth || skinImage.width) : 0;
  const imgH = skinImage ? (skinImage.naturalHeight || skinImage.height) : 0;

  if (skinImage && imgW > 0 && imgH > 0) {
    const scale = Math.max(width / imgW, height / imgH);
    const srcW = width / scale;
    const srcH = height / scale;
    const srcX = Math.max(0, (imgW - srcW) * 0.5);
    const srcY = Math.max(0, (imgH - srcH) * 0.5);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(skinImage, srcX, srcY, srcW, srcH, 0, 0, width, height);

    // Subtle atmospheric vignette so the warm cream paper separates naturally from bright sky or travertine edges.
    const vig = ctx.createRadialGradient(
      width * 0.5,
      height * 0.48,
      Math.min(width, height) * 0.24,
      width * 0.5,
      height * 0.5,
      Math.hypot(width, height) * 0.56,
    );
    vig.addColorStop(0, 'rgba(8, 12, 14, 0)');
    vig.addColorStop(1, backdrop === 'stone' ? 'rgba(28, 22, 16, 0.12)' : 'rgba(8, 12, 14, 0.18)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
    return;
  }

  // Quiet tonal fallback when static photographic assets are unavailable (e.g. jsdom unit tests).
  const [c0, c1, c2] = FALLBACK_TONES[backdrop];
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, c0);
  grad.addColorStop(0.55, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** Loads any local SVG/PNG icon and converts it into crisp monochrome thermal-printer ink (`#1e1d1a`).
 *  Uses ink absorption (`1 - min(R,G,B)/255`) so white icon backgrounds melt seamlessly into the paper while
 *  colored or dark strokes render with full contrast. */
async function loadThermalInkIcon(url: string, pixelSize = 64): Promise<HTMLCanvasElement | null> {
  const key = `${url}@${pixelSize}`;
  const cached = iconCanvasCache.get(key);
  if (cached) return cached;

  const pending = (async (): Promise<HTMLCanvasElement | null> => {
    try {
      let imageSource = url;
      if (url.endsWith('.svg')) {
        const res = await fetch(url);
        if (!res.ok) return null;
        let svg = await res.text();
        svg = svg
          .replace(/\b(width|height)=["']1em["']/g, '')
          .replace(/currentColor/g, '#1e1d1a');
        if (!/\bwidth=/.test(svg.slice(0, 220))) {
          svg = svg.replace('<svg', `<svg width="${pixelSize}" height="${pixelSize}"`);
        }
        imageSource = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      }
      const img = await loadHtmlImage(imageSource);
      const off = document.createElement('canvas');
      off.width = pixelSize;
      off.height = pixelSize;
      const octx = off.getContext('2d');
      if (!octx) return null;
      octx.drawImage(img, 0, 0, pixelSize, pixelSize);
      const imageData = octx.getImageData(0, 0, pixelSize, pixelSize);
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3]! / 255;
        if (a <= 0.01) {
          d[i + 3] = 0;
          continue;
        }
        const minChannel = Math.min(d[i]!, d[i + 1]!, d[i + 2]!);
        const absorption = Math.min(1, (1 - minChannel / 255) * 1.45);
        d[i] = 30;
        d[i + 1] = 29;
        d[i + 2] = 26;
        d[i + 3] = Math.round(a * absorption * 255);
      }
      octx.putImageData(imageData, 0, 0);
      return off;
    } catch {
      return null;
    }
  })();

  iconCanvasCache.set(key, pending);
  return pending;
}

function traceReceiptPaperPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  bodyHeight: number,
  toothHeight: number,
  teethCount: number,
): void {
  const r = 2;
  const bottomY = y + bodyHeight;
  const toothW = width / teethCount;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, bottomY);
  for (let i = teethCount - 1; i >= 0; i -= 1) {
    const midX = x + (i + 0.5) * toothW;
    const leftX = x + i * toothW;
    ctx.lineTo(midX, bottomY + toothHeight);
    ctx.lineTo(leftX, bottomY);
  }
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fitEndEllipsis(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, Math.max(1, lo))}…`;
}

export interface RenderReceiptCanvasOptions {
  backdrop: ReceiptBackdrop;
  scale?: number;
}

/** Renders the complete thermal receipt + selected photographic backdrop onto a high-DPI `<canvas>`. */
export async function renderReceiptCanvas(
  receipt: UsageReceiptModel,
  options: RenderReceiptCanvasOptions,
): Promise<HTMLCanvasElement> {
  const scale = options.scale ?? 2;
  const paperW = 384;
  const innerX = 28;
  const contentW = paperW - innerX * 2;
  const toothH = 7;
  const teethCount = 28;

  const fontSans = `'Inter Variable', 'Inter', 'PingFang SC', -apple-system, 'Microsoft YaHei', sans-serif`;
  const fontMono = `'SF Mono', ui-monospace, Menlo, Consolas, 'PingFang SC', monospace`;

  // Preload all unique icons and the selected photographic skin in parallel.
  const iconUrls = new Set<string>();
  for (const g of receipt.groups) {
    const aUrl = agentIconAssetUrl(g.iconId);
    if (aUrl) iconUrls.add(aUrl);
    for (const m of g.models) {
      if (m.brandIcon?.src) iconUrls.add(m.brandIcon.src);
    }
  }
  const iconMap = new Map<string, HTMLCanvasElement | null>();
  const skinBackdrop = options.backdrop === 'paper' ? null : options.backdrop;
  const [skinImage] = await Promise.all([
    skinBackdrop ? loadBackdropSkinImage(skinBackdrop) : Promise.resolve(null),
    ...[...iconUrls].map(async (u) => {
      iconMap.set(u, await loadThermalInkIcon(u, 64));
    }),
  ]);

  // Compute exact paper height from content rows.
  let cursor = 34; // top margin inside paper
  cursor += 30; // title
  cursor += 24; // subtitle
  cursor += 12; // gap before meta
  cursor += receipt.metaRows.length * 23;
  cursor += 24; // dashed divider
  if (receipt.heroEyebrow) cursor += 20; // hero eyebrow
  cursor += receipt.heroFigures.length > 1 ? 46 : 50; // hero figure(s)
  if (receipt.heroSubnote) cursor += 22; // optional hero subnote
  cursor += 24; // dashed divider
  cursor += receipt.summaryRows.length * 24;
  cursor += 24; // dashed divider
  if (receipt.groups.length > 0) {
    cursor += 24; // AGENT / MODEL header
    for (let gi = 0; gi < receipt.groups.length; gi += 1) {
      const g = receipt.groups[gi]!;
      if (gi > 0) cursor += 10;
      cursor += 26; // agent header row
      cursor += g.models.length * 22;
      if (g.foldedCount > 0 && g.foldedValueText) cursor += 22;
    }
    cursor += 24; // dashed divider
  }
  cursor += receipt.tokenRows.length * 24;
  if (receipt.footnotes.length > 0) {
    cursor += 6 + receipt.footnotes.length * 19;
  }
  cursor += 24; // dashed divider
  cursor += receipt.footerLines.length * 20;
  cursor += 26; // bottom margin inside paper

  const bodyH = cursor;
  const padX = options.backdrop === 'paper' ? 24 : Math.round(Math.min(82, Math.max(60, bodyH * 0.085)));
  const padTop = options.backdrop === 'paper' ? 20 : 56;
  const padBottom = options.backdrop === 'paper' ? 28 : 62;
  const totalW = paperW + padX * 2;
  const totalH = padTop + bodyH + toothH + padBottom;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(totalW * scale);
  canvas.height = Math.round(totalH * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context is unavailable');
  ctx.scale(scale, scale);

  // 1. Photographic backdrop stage
  paintReceiptBackdrop(ctx, totalW, totalH, options.backdrop, skinImage);

  // 2. Thermal receipt paper with layered ambient + contact shadows and serrated bottom edge
  const paperX = padX;
  const paperY = padTop;
  ctx.save();
  ctx.shadowColor = options.backdrop === 'paper' ? 'rgba(0, 0, 0, 0.14)' : 'rgba(8, 12, 14, 0.30)';
  ctx.shadowBlur = options.backdrop === 'paper' ? 18 : 42;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = options.backdrop === 'paper' ? 6 : 20;
  traceReceiptPaperPath(ctx, paperX, paperY, paperW, bodyH, toothH, teethCount);
  ctx.fillStyle = '#f5f3ee';
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.shadowColor = options.backdrop === 'paper' ? 'rgba(0, 0, 0, 0.08)' : 'rgba(8, 12, 14, 0.16)';
  ctx.shadowBlur = options.backdrop === 'paper' ? 5 : 10;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = options.backdrop === 'paper' ? 2 : 4;
  traceReceiptPaperPath(ctx, paperX, paperY, paperW, bodyH, toothH, teethCount);
  ctx.fillStyle = '#f5f3ee';
  ctx.fill();
  ctx.restore();

  // Subtle top specular highlight + warm thermal-paper sheen
  ctx.save();
  traceReceiptPaperPath(ctx, paperX, paperY, paperW, bodyH, toothH, teethCount);
  ctx.clip();
  const paperGrad = ctx.createLinearGradient(0, paperY, 0, paperY + bodyH);
  paperGrad.addColorStop(0, 'rgba(255, 255, 255, 0.44)');
  paperGrad.addColorStop(0.45, 'rgba(245, 243, 238, 0)');
  paperGrad.addColorStop(1, 'rgba(220, 214, 202, 0.24)');
  ctx.fillStyle = paperGrad;
  ctx.fillRect(paperX, paperY, paperW, bodyH + toothH);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.fillRect(paperX, paperY, paperW, 1);
  ctx.restore();

  // Drawing helpers inside paper coordinates
  const leftEdge = paperX + innerX;
  const rightEdge = paperX + paperW - innerX;
  const centerX = paperX + paperW / 2;
  let y = paperY + 34;

  const drawDivider = () => {
    y += 11;
    ctx.save();
    ctx.strokeStyle = '#c8c3b8';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(leftEdge, Math.round(y) + 0.5);
    ctx.lineTo(rightEdge, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
    y += 13;
  };

  const drawKeyValue = (label: string, value: string, opts?: { bold?: boolean; muted?: boolean }) => {
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${opts?.bold ? 600 : 500} 12.5px ${fontSans}`;
    ctx.fillStyle = opts?.muted ? '#7a766e' : '#4a4842';
    ctx.textAlign = 'left';
    ctx.fillText(label, leftEdge, y + 15);

    ctx.font = `${opts?.bold ? 700 : 500} 13px ${fontMono}`;
    ctx.fillStyle = opts?.muted ? '#7a766e' : '#1e1d1a';
    ctx.textAlign = 'right';
    ctx.fillText(value, rightEdge, y + 15);
    y += 24;
  };

  // Title & subtitle
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1b1a17';
  ctx.font = `700 24px ${fontSans}`;
  ctx.fillText(receipt.title, centerX, y + 21);
  y += 30;

  ctx.fillStyle = '#6d6a62';
  ctx.font = `500 12px ${fontSans}`;
  ctx.fillText(fitEndEllipsis(ctx, receipt.subtitle, contentW), centerX, y + 14);
  y += 24 + 12;

  // Meta rows
  for (const row of receipt.metaRows) {
    ctx.font = `500 12.5px ${fontSans}`;
    ctx.fillStyle = '#57544d';
    ctx.textAlign = 'left';
    ctx.fillText(row.label, leftEdge, y + 14);

    ctx.font = `500 12.5px ${fontMono}`;
    ctx.fillStyle = '#242320';
    ctx.textAlign = 'right';
    ctx.fillText(row.value, rightEdge, y + 14);
    y += 23;
  }

  drawDivider();

  // Hero block
  ctx.textAlign = 'center';
  if (receipt.heroEyebrow) {
    ctx.fillStyle = '#5c5952';
    ctx.font = `500 12px ${fontSans}`;
    ctx.fillText(receipt.heroEyebrow, centerX, y + 13);
    y += 20;
  }

  if (receipt.heroFigures.length === 1) {
    ctx.fillStyle = '#181715';
    ctx.font = `700 41px ${fontMono}`;
    ctx.fillText(receipt.heroFigures[0]!.value, centerX, y + 38);
    y += 50;
  } else {
    const colW = contentW / 2;
    receipt.heroFigures.forEach((fig, idx) => {
      const colCenter = leftEdge + colW * (idx + 0.5);
      ctx.fillStyle = '#6d6a62';
      ctx.font = `500 11.5px ${fontSans}`;
      ctx.fillText(fig.label, colCenter, y + 13);
      ctx.fillStyle = '#181715';
      ctx.font = `700 25px ${fontMono}`;
      ctx.fillText(fig.value, colCenter, y + 39);
    });
    ctx.save();
    ctx.strokeStyle = '#c8c3b8';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(centerX) + 0.5, y + 4);
    ctx.lineTo(Math.round(centerX) + 0.5, y + 42);
    ctx.stroke();
    ctx.restore();
    y += 46;
  }

  if (receipt.heroSubnote) {
    ctx.fillStyle = '#6d6a62';
    ctx.font = `500 11.5px ${fontSans}`;
    ctx.fillText(receipt.heroSubnote, centerX, y + 14);
    y += 22;
  }

  drawDivider();

  // Summary rows
  for (const row of receipt.summaryRows) {
    drawKeyValue(row.label, row.value);
  }

  drawDivider();

  // Breakdown section
  if (receipt.groups.length > 0) {
    ctx.font = `500 12px ${fontMono}`;
    ctx.fillStyle = '#78746c';
    ctx.textAlign = 'left';
    ctx.fillText(receipt.breakdownHeader.left, leftEdge, y + 14);
    ctx.textAlign = 'right';
    ctx.fillText(receipt.breakdownHeader.right, rightEdge, y + 14);
    y += 24;

    receipt.groups.forEach((group, gi) => {
      if (gi > 0) y += 10;
      const aUrl = agentIconAssetUrl(group.iconId);
      const aIcon = aUrl ? iconMap.get(aUrl) : null;
      if (aIcon) {
        ctx.drawImage(aIcon, leftEdge, y + 3, 15, 15);
      } else {
        ctx.fillStyle = '#1e1d1a';
        ctx.beginPath();
        ctx.arc(leftEdge + 6, y + 10.5, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.font = `700 13.5px ${fontMono}`;
      ctx.fillStyle = '#1b1a17';
      ctx.textAlign = 'right';
      ctx.fillText(group.valueText, rightEdge, y + 15);
      const valW = ctx.measureText(group.valueText).width;

      ctx.textAlign = 'left';
      const maxLabelW = Math.max(80, contentW - 22 - valW - 12);
      ctx.fillText(fitEndEllipsis(ctx, group.label, maxLabelW), leftEdge + 22, y + 15);
      y += 26;

      for (const m of group.models) {
        const mIcon = m.brandIcon?.src ? iconMap.get(m.brandIcon.src) : null;
        const indentX = leftEdge + 16;
        if (mIcon) {
          ctx.save();
          ctx.globalAlpha = 0.85;
          ctx.drawImage(mIcon, indentX, y + 4, 12, 12);
          ctx.restore();
        } else {
          ctx.fillStyle = '#4a4842';
          ctx.beginPath();
          ctx.arc(indentX + 5.5, y + 10, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.font = `500 12.5px ${fontMono}`;
        ctx.fillStyle = '#3a3833';
        ctx.textAlign = 'right';
        ctx.fillText(m.valueText, rightEdge, y + 14);
        const mValW = ctx.measureText(m.valueText).width;

        ctx.textAlign = 'left';
        const maxModelW = Math.max(80, contentW - 34 - mValW - 10);
        ctx.fillText(fitEndEllipsis(ctx, m.displayName, maxModelW), indentX + 18, y + 14);
        y += 22;
      }

      if (group.foldedCount > 0 && group.foldedValueText) {
        const indentX = leftEdge + 16;
        ctx.fillStyle = '#78746c';
        ctx.beginPath();
        ctx.arc(indentX + 5.5, y + 10, 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = `500 12px ${fontMono}`;
        ctx.textAlign = 'right';
        ctx.fillText(group.foldedValueText, rightEdge, y + 14);
        ctx.textAlign = 'left';
        const moreText = receipt.breakdownHeader.right === '费用' || receipt.title.includes('账单')
          ? `其他 ${group.foldedCount} 个模型`
          : `${group.foldedCount} MORE MODELS`;
        ctx.fillText(moreText, indentX + 18, y + 14);
        y += 22;
      }
    });

    drawDivider();
  }

  // Token rows
  for (const row of receipt.tokenRows) {
    drawKeyValue(row.label, row.value);
  }

  if (receipt.footnotes.length > 0) {
    y += 6;
    ctx.font = `500 11.5px ${fontSans}`;
    ctx.fillStyle = '#7d7970';
    ctx.textAlign = 'left';
    for (const note of receipt.footnotes) {
      ctx.fillText(note, leftEdge, y + 13);
      y += 19;
    }
  }

  drawDivider();

  // Footer branding
  ctx.textAlign = 'center';
  ctx.fillStyle = '#5c5952';
  ctx.font = `500 11.5px ${fontSans}`;
  for (const line of receipt.footerLines) {
    ctx.fillText(line, centerX, y + 14);
    y += 20;
  }

  return canvas;
}

export async function renderReceiptPngDataUrl(
  receipt: UsageReceiptModel,
  options: RenderReceiptCanvasOptions,
): Promise<string> {
  const canvas = await renderReceiptCanvas(receipt, options);
  return canvas.toDataURL('image/png');
}

export async function copyReceiptImage(
  receipt: UsageReceiptModel,
  options: RenderReceiptCanvasOptions,
): Promise<'copied' | 'denied' | 'failed'> {
  // Prefer passing Promise<Blob> to ClipboardItem when available so async icon decoding never loses the user gesture.
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  const ClipboardItemRef = (globalThis as {
    ClipboardItem?: new (items: Record<string, Blob | Promise<Blob>>) => ClipboardItem;
  }).ClipboardItem;

  if (clipboard && typeof clipboard.write === 'function' && ClipboardItemRef) {
    try {
      const blobPromise = renderReceiptCanvas(receipt, options).then(
        canvas => new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))), 'image/png');
        }),
      );
      try {
        await clipboard.write([new ClipboardItemRef({ 'image/png': blobPromise })]);
        return 'copied';
      } catch {
        const blob = await blobPromise;
        await clipboard.write([new ClipboardItemRef({ 'image/png': blob })]);
        return 'copied';
      }
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
    }
  }

  try {
    const dataUrl = await renderReceiptPngDataUrl(receipt, options);
    return await copyImageDataUrlToClipboard(dataUrl);
  } catch {
    return 'failed';
  }
}

export async function downloadReceiptPng(
  receipt: UsageReceiptModel,
  options: RenderReceiptCanvasOptions,
): Promise<void> {
  const dataUrl = await renderReceiptPngDataUrl(receipt, options);
  downloadImageDataUrl(dataUrl, `${receipt.filenameBase}.png`);
}
