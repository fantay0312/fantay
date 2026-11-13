/* SPDX-License-Identifier: AGPL-3.0-only */
/* 洞察 (Codex): label on the left, value on the right. Every row is read off the summary; a row whose figure the data
   cannot support is left out rather than estimated. */
import type { AiUsageSummary } from '@open-design/contracts';
import { count, formatDay, percent, projectLabel, providerLabel, tokens } from './usage-format';
import styles from './UsageDashboard.module.css';

const pad2 = (value: number) => String(value).padStart(2, '0');

export function UsageInsights({ data, zh, today, showProjects }: {
  data: AiUsageSummary;
  zh: boolean;
  today: string;
  showProjects: boolean;
}) {
  const t = data.totals;
  const tokenSum = t.inputTokens + t.outputTokens;
  const rows: Array<{ label: string; value: string; title?: string }> = [];

  // Models are listed per provider; the same model name through two providers counts once here.
  const models = new Map<string, { tokens: number; requests: number }>();
  for (const row of data.models) {
    const entry = models.get(row.model) ?? { tokens: 0, requests: 0 };
    entry.tokens += row.totals.inputTokens + row.totals.outputTokens;
    entry.requests += row.totals.requests;
    models.set(row.model, entry);
  }
  const byTokens = tokenSum > 0;
  const topModel = [...models].sort((a, b) => (byTokens ? b[1].tokens - a[1].tokens : b[1].requests - a[1].requests))[0];
  if (topModel) {
    const share = byTokens ? topModel[1].tokens / tokenSum : topModel[1].requests / t.requests;
    rows.push({
      label: zh ? '最常用的模型' : 'Most used model',
      value: `${topModel[0]} · ${percent(share)}${byTokens ? ' Token' : (zh ? ' 请求' : ' of requests')}`,
      title: topModel[0],
    });
  }

  if (!data.provider && data.providers.length) {
    const top = [...data.providers].sort((a, b) => b.totals.requests - a.totals.requests)[0]!;
    rows.push({ label: zh ? '最常用的来源' : 'Most used source', value: `${providerLabel(top.provider)} · ${percent(top.totals.requests / t.requests)}${zh ? ' 请求' : ' of requests'}` });
  }

  const busiest = data.hours.reduce((best, metric, hour) => (metric.requests > (data.hours[best]?.requests ?? 0) ? hour : best), 0);
  if (data.hours[busiest]?.requests) {
    const requests = data.hours[busiest]!.requests;
    rows.push({
      label: zh ? '最活跃的时段' : 'Busiest hour',
      value: `${pad2(busiest)}:00–${pad2((busiest + 1) % 24)}:00 · ${count(requests)} ${zh ? '次请求' : requests === 1 ? 'request' : 'requests'}`,
    });
  }

  if (data.bucket === 'day' && data.days > 1 && tokenSum > 0) {
    const peak = data.series.reduce((best, bucket) => (bucket.tokens > best.tokens ? bucket : best), data.series[0]!);
    rows.push({ label: zh ? 'Token 最多的一天' : 'Heaviest day', value: `${formatDay(peak.start, zh, today)} · ${tokens(peak.tokens)}` });
  }

  if (t.withTokens > 0) {
    rows.push({
      label: zh ? '平均每次请求 Token' : 'Tokens per request',
      value: tokens(Math.round(tokenSum / t.withTokens)),
      title: zh ? `按 ${count(t.withTokens)} 次报告了 Token 的请求计算` : `Across ${count(t.withTokens)} requests that reported tokens`,
    });
  }

  if (tokenSum > 0) {
    rows.push({ label: zh ? '输出占 Token' : 'Output share of tokens', value: percent(t.outputTokens / tokenSum) });
  }

  if (showProjects && data.projects.length > 1) {
    const top = data.projects[0]!;
    const share = tokenSum > 0 ? (top.totals.inputTokens + top.totals.outputTokens) / tokenSum : top.totals.requests / t.requests;
    rows.push({ label: zh ? '用量最多的项目' : 'Top project', value: `${projectLabel(top.projectId, top.projectName, zh)} · ${percent(share)}` });
  }

  if (t.requests > 0) {
    const known = t.requests - t.unknown;
    rows.push({
      label: zh ? '有费用记录的请求' : 'Requests with a known cost',
      value: `${count(known)} / ${count(t.requests)}`,
      title: zh ? '没有费用记录的请求不计为零，也不按价格估算' : 'Requests without a cost are not counted as zero or estimated',
    });
  }

  if (!rows.length) return null;
  return (
    <section className={styles.section} aria-label={zh ? '洞察' : 'Insights'}>
      <h3 className={styles.sectionTitle}>{zh ? '洞察' : 'Insights'}</h3>
      <dl className={styles.insightList}>
        {rows.map(row => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd title={row.title}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
