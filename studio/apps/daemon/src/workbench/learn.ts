// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// 自我强化：从真实数据和你对草稿的修改里提炼规则，确认后才生效，并可导出成 Fantay 用户 Skill。
// 废纸篓里的条目和它们的数据不参与复盘和学习。
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchInsights, WorkbenchMetric, WorkbenchState } from '@open-design/contracts';
import { slugifySkillName, updateUserSkill } from '../skills.js';
import { httpError, platformName, tr } from './i18n.js';
import { liveItems } from './ops.js';
import { activeStyle, styleToVoice } from './style.js';

type Totals = { views: number; likes: number; comments: number; shares: number; saves: number };
const TOTAL_KEYS = ['views', 'likes', 'comments', 'shares', 'saves'] as const;

/** 按这台电脑的时区算日期，北京时间早上发的内容不会算到前一天。 */
function localDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function engagement(row: Partial<Totals>): number {
  return (row.likes || 0) + (row.comments || 0) + (row.shares || 0) + (row.saves || 0);
}

/** 废纸篓里的条目的数据不算；有了真实数据后，示例数据也不再参与统计。 */
function countedMetrics(state: WorkbenchState): WorkbenchMetric[] {
  const trashed = new Set(state.items.filter(item => item.trashedAt).map(item => item.id));
  const metrics = state.metrics.filter(metric => !metric.itemId || !trashed.has(metric.itemId));
  const real = metrics.filter(metric => !metric.sample);
  return real.length ? real : metrics;
}

/** 每篇内容的累计数据。 */
function itemTotals(metrics: WorkbenchMetric[]): Map<string, Totals> {
  const totals = new Map<string, Totals>();
  for (const metric of metrics) {
    if (!metric.itemId) continue;
    const entry = totals.get(metric.itemId) ?? { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
    for (const key of TOTAL_KEYS) entry[key] += metric[key] || 0;
    totals.set(metric.itemId, entry);
  }
  return totals;
}

function bestGroup(rows: Array<{ key: string | null | undefined; value: number }>): Array<{ key: string; n: number; avg: number }> {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.key) continue;
    const list = groups.get(row.key) ?? [];
    list.push(row.value);
    groups.set(row.key, list);
  }
  return [...groups.entries()]
    .map(([key, values]) => ({ key, n: values.length, avg: values.reduce((a, b) => a + b, 0) / values.length }))
    .sort((a, b) => b.avg - a.avg);
}

/** 对比 AI 原稿和你改完的版本，粗略判断修改方向。 */
function editSignals(state: WorkbenchState): Array<{ title: string; ratio: number }> {
  const signals: Array<{ title: string; ratio: number }> = [];
  for (const item of liveItems(state)) {
    const production = item.production;
    if (production?.aiArticle && production.article && production.article !== production.aiArticle) {
      const before = production.aiArticle.replace(/\s/g, '').length;
      const after = production.article.replace(/\s/g, '').length;
      signals.push({ title: item.title, ratio: before ? after / before : 1 });
    }
    for (const format of ['article', 'script'] as const) {
      const draft = item.drafts?.[format];
      if (!draft?.aiText || draft.by !== 'user' || draft.text === draft.aiText) continue;
      const before = draft.aiText.replace(/\s/g, '').length;
      const after = draft.text.replace(/\s/g, '').length;
      signals.push({ title: item.title, ratio: before ? after / before : 1 });
    }
  }
  return signals;
}

export interface RuleProposal { name: string; rule: string; evidence: string; confidence: number; source: string }

/** 基于现有数据计算规则提案。只有样本足够才提案，不凑数。 */
export function proposeRules(state: WorkbenchState): RuleProposal[] {
  const proposals: RuleProposal[] = [];
  const totals = itemTotals(countedMetrics(state));
  const published = liveItems(state).filter(item => totals.has(item.id));
  const rows = published.map(item => ({ item, views: totals.get(item.id)!.views }));

  // 有些平台公开接口读不到播放量，这些内容不参与跨平台比较
  const byPlatform = bestGroup(rows.filter(row => row.views > 0).map(row => ({ key: row.item.platform, value: row.views })));
  const [first, second] = byPlatform;
  if (first && second && first.avg > second.avg * 1.3) {
    const platform = platformName(first.key);
    proposals.push({
      name: tr('首发放在{platform}', { platform }), rule: tr('同一选题优先在{platform}首发，再改写分发到其他平台。', { platform }),
      evidence: tr('{platform}平均 {avg} 阅读，高于第二名{second}的 {secondAvg}', { platform, avg: Math.round(first.avg).toLocaleString('en-US'), second: platformName(second.key), secondAvg: Math.round(second.avg).toLocaleString('en-US') }), confidence: Math.min(0.85, 0.4 + first.n * 0.12), source: tr('数据复盘'),
    });
  }

  const hasViews = rows.some(row => row.views > 0);
  const hours = bestGroup(published.filter(item => item.publishedAt).map(item => ({ key: String(new Date(item.publishedAt!).getHours()), value: hasViews ? totals.get(item.id)!.views : engagement(totals.get(item.id)!) })));
  const [hour] = hours;
  if (hour && hours.length >= 2 && hour.n >= 2) {
    proposals.push({
      name: tr('{hour} 点前后发布', { hour: hour.key }), rule: tr('默认把内容排在 {hour}:00 前后发布。', { hour: hour.key }),
      evidence: tr(hasViews ? '这个时段 {n} 篇平均 {avg} 阅读' : '这个时段 {n} 篇平均 {avg} 互动', { n: hour.n, avg: Math.round(hour.avg).toLocaleString('en-US') }), confidence: 0.5, source: tr('数据复盘'),
    });
  }

  const edits = editSignals(state);
  if (edits.length >= 2) {
    const avg = edits.reduce((a, b) => a + b.ratio, 0) / edits.length;
    if (avg < 0.85) {
      proposals.push({ name: tr('初稿写短一些'), rule: tr('你通常把 AI 初稿删到原来的 {pct}%，以后初稿控制得更紧凑。', { pct: Math.round(avg * 100) }), evidence: tr('来自 {n} 次草稿修改', { n: edits.length }), confidence: Math.min(0.9, 0.5 + edits.length * 0.08), source: tr('草稿修改') });
    } else if (avg > 1.15) {
      proposals.push({ name: tr('初稿多给细节'), rule: tr('你通常把 AI 初稿扩写到原来的 {pct}%，以后初稿多给具体细节和例子。', { pct: Math.round(avg * 100) }), evidence: tr('来自 {n} 次草稿修改', { n: edits.length }), confidence: Math.min(0.9, 0.5 + edits.length * 0.08), source: tr('草稿修改') });
    }
  }

  const known = new Set(state.skills.map(skill => skill.name));
  return proposals.filter(row => !known.has(row.name));
}

/** 面向复盘页的汇总：概览、趋势、平台分布和排行。 */
export function computeInsights(state: WorkbenchState): WorkbenchInsights {
  const metrics = countedMetrics(state);
  const onlyReal = !metrics.some(metric => metric.sample);
  const totals = itemTotals(metrics);
  const daily = new Map<string, { date: string; views: number; engaged: number }>();
  for (const metric of metrics) {
    const day = localDay(metric.date);
    const entry = daily.get(day) ?? { date: day, views: 0, engaged: 0 };
    entry.views += metric.views || 0;
    entry.engaged += engagement(metric);
    daily.set(day, entry);
  }
  const platforms = new Map<string, WorkbenchInsights['platforms'][number]>();
  for (const metric of metrics) {
    const entry = platforms.get(metric.platform) ?? { platform: metric.platform, views: 0, engaged: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
    for (const key of TOTAL_KEYS) entry[key] += metric[key] || 0;
    entry.engaged += engagement(metric);
    platforms.set(metric.platform, entry);
  }
  const items = liveItems(state);
  const top = items
    .filter(item => totals.has(item.id))
    .map(item => { const total = totals.get(item.id)!; return { id: item.id, title: item.title, platform: item.platform ?? null, ...total, engaged: engagement(total) }; })
    .sort((a, b) => (b.views - a.views) || (b.engaged - a.engaged));
  const views = metrics.reduce((sum, metric) => sum + (metric.views || 0), 0);
  const engaged = metrics.reduce((total, metric) => total + engagement(metric), 0);
  // 互动率只算读得到播放量的内容，否则分子分母对不上
  const withViews = metrics.filter(metric => metric.views > 0);
  const accounts = state.accounts.filter(account => (onlyReal ? !account.sample : true));
  return {
    views, engaged, engagementRate: views ? withViews.reduce((total, metric) => total + engagement(metric), 0) / views : 0,
    published: items.filter(item => item.status === 'published' && (onlyReal ? !item.sample : true)).length,
    followers: accounts.reduce((sum, account) => sum + (account.followers || 0), 0),
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    platforms: [...platforms.values()].sort((a, b) => (b.views - a.views) || (b.engaged - a.engaged)),
    top,
    hasSample: metrics.some(metric => metric.sample),
  };
}

export const SKILL_NAME = 'fantay-workbench-voice';

/**
 * 把生效中的规则和自己的风格写成一个 Fantay 用户 Skill（用户 Skills 目录下的 <slug>/SKILL.md），
 * 走和设置里「导入/编辑 Skill」相同的写入函数，下次列出 Skills 时就能看到。内容由用户在界面确认后点击导出才写入。
 */
export async function exportSkill(state: WorkbenchState, userSkillsDir: string): Promise<{ name: string; path: string; rules: number; slug: string }> {
  // 示例规则不是作者的风格，不能写进真实 Skill
  const rules = state.skills.filter(skill => !skill.sample && (skill.status === 'active' || skill.status === 'exported'));
  const picked = activeStyle(state);
  const style = picked && !picked.preset && !picked.sample ? picked : null;
  const slug = slugifySkillName(SKILL_NAME);
  if (!rules.length && !style) {
    // 之前导出过的旧 Skill 不再代表现在的设置，撤掉它
    await rm(path.join(userSkillsDir, slug), { recursive: true, force: true });
    throw httpError(tr('还没有你自己的风格或规则。示例规则和模板不会被导出'), 400);
  }
  const description = tr('作者的自媒体写作风格和规则。写选题、脚本、标题或封面文案时使用。');
  const styleBlock = style ? `## ${tr('风格：{name}', { name: style.name })}\n\n${styleToVoice(style)}\n\n` : '';
  const ruleBlock = rules.length ? `## ${tr('必须遵守的规则')}\n\n${rules.map(r => `- **${r.name}**${tr('：')}${r.rule}${r.evidence ? tr('（依据：{evidence}）', { evidence: r.evidence }) : ''}`).join('\n')}\n` : '';
  const body = `# ${tr('自媒体写作风格')}\n\n${tr('由 Fantay 工作台沉淀，更新于 {date}。', { date: new Date().toISOString().slice(0, 10) })}\n\n${styleBlock}${ruleBlock}`;
  const result = await updateUserSkill(userSkillsDir, { name: SKILL_NAME, description, body });
  return { name: SKILL_NAME, path: path.join(result.dir, 'SKILL.md'), rules: rules.length, slug: result.slug };
}
