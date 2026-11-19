/* SPDX-License-Identifier: AGPL-3.0-only */
/* One /api/usage read model feeds every figure. Estimates stay separate from reported costs and charges. */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiUsageLocalSource, AiUsageScope, AiUsageSummary, AiUsageTotals, WorkspaceCollabContext } from '@open-design/contracts';
import { ChevronRight, ReceiptText, RefreshCw } from 'lucide-react';
import { Button, Icon, IconButton, Segmented, SegmentedItem } from '../../fantay/ui';
import { useI18n } from '../../i18n';
import { workspaceProjectHeaders } from '../../collab/workspace-identity';
import { AgentIcon } from '../AgentIcon';
import { agentIconId } from '../../utils/agentLabels';
import { UsageDetails } from './UsageDetails';
import { UsageHeatmap } from './UsageHeatmap';
import { UsageInsights } from './UsageInsights';
import { UsageRangePicker } from './UsageRangePicker';
import { UsageReceiptModal } from './UsageReceiptModal';
import { UsageTrendChart } from './UsageTrendChart';
import { count, formatRange, money, moneyDigits, percent, presetRange, projectLabel, providerLabel, todayKey, tokens, type UsageRange } from './usage-format';
import styles from './UsageDashboard.module.css';

const REFRESH_MS = 30_000;
const ALL_SOURCES = '__all';
const COLLAPSED_SOURCE_LIMIT = 8;

type Activity = NonNullable<AiUsageSummary['activity']>;

export function UsageDashboard({ projectId, context, compact = false }: {
  projectId?: string;
  context?: WorkspaceCollabContext | null;
  compact?: boolean;
}) {
  const { locale } = useI18n();
  const zh = locale.startsWith('zh');
  const [today, setToday] = useState(todayKey);
  const [range, setRange] = useState<UsageRange>(() => presetRange('30d'));
  const [provider, setProvider] = useState<string | null>(null);
  const [selectedScope, setSelectedScope] = useState<AiUsageScope>('fantay');
  const scope: AiUsageScope = projectId ? 'fantay' : selectedScope;
  const [data, setData] = useState<AiUsageSummary | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [receiptOpen, setReceiptOpen] = useState(false);
  const requestPending = useRef(false);
  /** The year of activity does not follow the range, so it is re-read only on a manual refresh, a new day, or a
   *  different project / source; the 30 s refresh and range changes leave it (and the daemon's year-long sync) alone. */
  const reloadActivity = useRef(true);
  /** Which project / source the loaded activity belongs to. */
  const activityKey = useRef<string | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let delivered = false;
    const controller = new AbortController();
    const key = `${scope}\u0000${projectId ?? ''}\u0000${provider ?? ''}`;
    const withActivity = !compact && (reloadActivity.current || activityKey.current !== key);
    reloadActivity.current = false;
    setLoading(true);
    requestPending.current = true;
    const query = new URLSearchParams({
      from: range.from,
      to: range.to,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      limit: compact ? '0' : '500',
      scope,
    });
    if (projectId) query.set('projectId', projectId);
    if (provider) query.set('provider', provider);
    if (withActivity) query.set('activity', '1');
    void fetch(`/api/usage?${query}`, { headers: context ? workspaceProjectHeaders(context) : {}, signal: controller.signal })
      .then(async response => {
        const value = await response.json() as AiUsageSummary & { error?: string };
        if (!response.ok) throw new Error(value.error ?? 'Usage is unavailable');
        return value;
      })
      .then(value => {
        if (!active) return;
        setData(value);
        setError('');
        setSyncedAt(Date.now());
        setNow(Date.now());
        if (value.activity) {
          setActivity(value.activity);
          activityKey.current = key;
          delivered = true;
        }
      })
      .catch(cause => {
        if (active) setError(String(cause?.message ?? cause));
      })
      .finally(() => {
        if (active) { requestPending.current = false; setLoading(false); }
      });
    return () => {
      active = false;
      controller.abort();
      // A request that was to carry the activity but did not (superseded or failed) hands that job to the next one.
      if (withActivity && !delivered) reloadActivity.current = true;
    };
  }, [range.from, range.to, provider, projectId, context, revision, compact, scope]);

  useEffect(() => {
    const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
    const advanceRefresh = () => {
      // Past midnight a relative range (今天, 7 天 …) moves with the calendar; a custom range stays put.
      const current = todayKey();
      setToday(previous => {
        if (previous === current) return previous;
        reloadActivity.current = true;
        return current;
      });
      setRange(previous => {
        if (previous.preset === 'custom') return previous;
        const next = presetRange(previous.preset, current);
        return next.from === previous.from && next.to === previous.to ? previous : next;
      });
      setRevision(value => value + 1);
    };
    const timer = setInterval(() => {
      if (isVisible() && !requestPending.current) advanceRefresh();
    }, REFRESH_MS);
    const clock = setInterval(() => {
      if (isVisible()) setNow(Date.now());
    }, 15_000);
    const onVisibility = () => {
      if (!isVisible()) return;
      setNow(Date.now());
      if (!requestPending.current) advanceRefresh();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of data?.projects ?? []) names.set(row.projectId ?? '', projectLabel(row.projectId, row.projectName, zh));
    return names;
  }, [data, zh]);

  const sources = useMemo(() => {
    const ids = (data?.availableProviders ?? []).map(item => item.provider);
    if (provider && !ids.includes(provider)) ids.unshift(provider);
    return ids;
  }, [data, provider]);
  const sourceRequests = useMemo(() => new Map((data?.availableProviders ?? []).map(item => [item.provider, item.requests])), [data]);

  const selectDay = (day: string) => {
    setRange({ preset: 'custom', from: day, to: day });
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    summaryRef.current?.scrollIntoView?.({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  };

  const syncLabel = relativeSync(syncedAt, now, zh, locale);
  const refresh = () => {
    reloadActivity.current = true;
    setRevision(value => value + 1);
  };
  const totals = data?.totals;
  const empty = Boolean(totals && totals.requests === 0 && !totals.sessionRecords);
  const hasHistory = Boolean(activity?.days.length) || provider !== null;

  return (
    <section className={styles.dashboard} data-compact={compact} aria-busy={loading} aria-label={zh ? 'AI 用量' : 'AI usage'}>
      {projectId ? <h2 className={styles.title}>{zh ? '项目 AI 用量' : 'Project AI usage'}</h2> : null}

      <div className={styles.lead}>
        <div className={styles.controls} ref={summaryRef}>
          <div className={styles.toolbar}>
            {!projectId && !compact ? (
              <Segmented className={styles.scopeSwitch} value={scope} aria-label={zh ? '统计范围' : 'Usage scope'} onValueChange={value => {
                setSelectedScope(value as AiUsageScope);
                setData(null); setActivity(null); setProvider(null); setError(''); setSyncedAt(null);
                reloadActivity.current = true;
              }}>
                <SegmentedItem value="fantay">{zh ? '仅 Fantay' : 'Fantay only'}</SegmentedItem>
                <SegmentedItem value="device">{zh ? '本机全部' : 'This device'}</SegmentedItem>
              </Segmented>
            ) : null}
            <UsageRangePicker value={range} onChange={setRange} today={today} zh={zh} compact={compact} />
          </div>

          {!compact && sources.length > 1 ? (
            <SourceFilter sources={sources} requests={sourceRequests} value={provider} onChange={setProvider} zh={zh} />
          ) : null}
          {!compact && scope === 'device' && data?.localScan ? (
            <LocalScanDetails sources={data.localScan.sources} zh={zh} />
          ) : null}
        </div>

        {/* One group for the range's figures: what they cover and how fresh they are, the two kinds of cost, then the
            volume beneath them. */}
        <section className={styles.overview} aria-label={zh ? '概览' : 'Overview'}>
          <div className={styles.overviewHead}>
            <span className={styles.scope}>
              {scope === 'device' ? (zh ? '本机全部 · ' : 'This device · ') : ''}
              {scopeLabel(range, today, zh)}
              <span aria-hidden="true"> · </span>
              {provider ? providerLabel(provider) : (zh ? '全部来源' : 'All sources')}
            </span>
            <div className={styles.overviewActions}>
              <span className={styles.live} data-state={error ? 'error' : syncedAt === null ? 'syncing' : 'live'} title={zh ? '每 30 秒自动刷新' : 'Refreshes every 30 seconds'}>
                <span key={syncedAt ?? 0} className={styles.liveDot} aria-hidden="true" />
                {syncLabel}
              </span>
              {!compact ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className={styles.receiptTrigger}
                  disabled={!data && loading}
                  onClick={() => setReceiptOpen(true)}
                >
                  <Icon icon={ReceiptText} size="sm" />
                  {zh ? '生成小票' : 'Receipt'}
                </Button>
              ) : null}
              <IconButton size="sm" className={styles.refresh} aria-label={`${zh ? '刷新用量' : 'Refresh usage'} · ${syncLabel}`} onClick={refresh}>
                <Icon icon={RefreshCw} size="sm" className={loading ? styles.spinning : undefined} />
              </IconButton>
            </div>
          </div>
          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
          {!data && loading ? <p role="status" className={styles.status}>{zh ? '正在读取用量…' : 'Loading usage…'}</p> : null}
          {totals ? <Kpis totals={totals} zh={zh} compact={compact} /> : null}
        </section>
      </div>

      {data && totals ? (
        <>
          {empty ? (
            <div className={styles.empty}>
              <strong>{hasHistory ? (zh ? '这个范围内没有用量' : 'No usage in this range') : (zh ? '还没有用量记录' : 'No usage recorded yet')}</strong>
              <p>
                {hasHistory
                  ? (zh ? '换一个时间范围或来源看看。' : 'Try another range or source.')
                  : (zh ? '使用 AI 对话或生成素材后，会在这里显示项目、模型、Token 和费用。' : 'AI chats and media generation will appear here with their project, model, tokens and cost.')}
              </p>
            </div>
          ) : (
            <>
              <UsageTrendChart data={data} zh={zh} today={today} projectNames={projectNames} allowProjectSplit={!projectId} compact={compact} />
              {compact ? null : <UsageInsights data={data} zh={zh} today={today} showProjects={!projectId} />}
            </>
          )}
          {!compact && activity && activity.days.length ? (
            <UsageHeatmap activity={activity} zh={zh} selectedDay={range.from === range.to ? range.from : null} onSelectDay={selectDay} />
          ) : null}
          {!compact && !empty ? <UsageDetails key={`${scope}:${provider ?? ''}`} data={data} zh={zh} locale={locale} showProjects={!projectId} context={context} /> : null}
          <p className={styles.hint}>
            {zh ? '每 30 秒自动刷新。' : 'Refreshes every 30 seconds. '}
            {zh ? '扣费来自服务回执，Token 来自供应方报告（输入 + 输出，缓存读取单列）。' : 'Charges come from service receipts; tokens are provider-reported (input + output, cache reads listed apart). '}
            {data.coverageSince ? (zh ? `本范围的记录始于 ${new Date(data.coverageSince).toLocaleDateString(locale)}。` : `Records in this range start ${new Date(data.coverageSince).toLocaleDateString(locale)}. `) : ''}
            {zh
              ? 'TokenToSea 扣费按当前账号统计；CLI 和自带密钥记录属于本机历史。'
              : 'TokenToSea charges follow the current account. CLI and BYOK records belong to this device.'}
            {scope === 'device' ? (zh
              ? ' 本机全部读取受支持 Agent 的本地日志；部分记录表示扫描未覆盖完整历史。估算金额按公开价格表计算 Token 价值，不代表订阅账单或实际扣费。'
              : ' Device usage reads supported local agent logs; partial means history is incomplete. Estimates show token value at public catalog rates, not subscription bills or actual charges.') : null}
          </p>
        </>
      ) : null}

      {!compact ? (
        <UsageReceiptModal
          open={receiptOpen}
          onClose={() => setReceiptOpen(false)}
          dashboardRange={range}
          today={today}
          provider={provider}
          scope={scope}
          projectId={projectId}
          projectName={projectId ? projectNames.get(projectId) : undefined}
          context={context}
          dashboardData={data}
          activity={activity}
          zh={zh}
        />
      ) : null}
    </section>
  );
}

function scanIssueLabel(issue: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    'scan-limit': ['达到本轮扫描上限，刷新后继续', 'Scan limit; refresh to continue'],
    'file-limit': ['部分文件超过读取上限', 'Some files exceed the read limit'],
    'invalid-record': ['有未完整写入或无法解析的记录', 'Incomplete or unrecognized records'],
    'history-overlap': ['部分分叉历史无法确认归属', 'Some fork history cannot be attributed'],
    'permission': ['部分记录不可读取', 'Some records could not be read'],
    'unsupported-format': ['检测到暂不支持的数据格式', 'An unsupported format was found'],
    'incomplete-usage': ['部分调用未提供 Token', 'Some calls did not report tokens'],
  };
  return labels[issue]?.[zh ? 0 : 1] ?? issue;
}

function LocalScanDetails({ sources, zh }: { sources: AiUsageLocalSource[]; zh: boolean }) {
  const sorted = useMemo(() => {
    const rank: Record<AiUsageLocalSource['status'], number> = {
      ready: 0,
      partial: 1,
      error: 2,
      unsupported: 3,
      'not-found': 4,
    };
    return [...sources].sort((a, b) => rank[a.status] - rank[b.status] || b.records - a.records);
  }, [sources]);
  const foundCount = sources.filter(s => s.status !== 'not-found').length;

  return (
    <details className={styles.scanSources}>
      <summary>
        <Icon icon={ChevronRight} size="xs" className={styles.scanChevron} />
        <span>
          {zh
            ? `本机 Agent：已发现 ${foundCount} 类 · 查看 ${sources.length} 类扫描结果`
            : `Local agents: ${foundCount} found · ${sources.length} sources checked`}
        </span>
      </summary>
      <dl aria-label={zh ? '本地 Agent 扫描结果' : 'Local agent scan'}>
        {sorted.map(source => (
          <div key={source.provider} data-state={source.status}>
            <dt>
              <AgentIcon id={agentIconId(source.provider)} size={13} />
              <span>{providerLabel(source.provider)}</span>
            </dt>
            <dd>
              <span>
                {source.status === 'ready' ? (zh ? `${count(source.records)} 条` : `${count(source.records)} records`)
                  : source.status === 'not-found' ? (zh ? '未发现记录' : 'Not found')
                  : source.status === 'unsupported' ? (zh ? '暂无本地接口' : 'No local API')
                  : source.status === 'partial' ? (zh ? `${count(source.records)} 条 · 部分记录` : `${count(source.records)} · partial`)
                  : (zh ? '读取失败' : 'Read failed')}
              </span>
              {source.issues?.length && source.status !== 'unsupported' ? (
                <small>{source.issues.map(issue => scanIssueLabel(issue, zh)).join(' · ')}</small>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function SourceFilter({ sources, requests, value, onChange, zh }: {
  sources: string[];
  requests: Map<string, number>;
  value: string | null;
  onChange: (provider: string | null) => void;
  zh: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const canCollapse = sources.length > COLLAPSED_SOURCE_LIMIT;
  const visibleSources = useMemo(() => {
    if (!canCollapse || expanded) return sources;
    const head = sources.slice(0, COLLAPSED_SOURCE_LIMIT - 1);
    if (value && !head.includes(value) && sources.includes(value)) {
      head.push(value);
    }
    return head;
  }, [canCollapse, expanded, sources, value]);
  const hiddenCount = sources.length - visibleSources.length;

  return (
    <div className={styles.sourceBar}>
      <Segmented
        className={styles.sources}
        value={value ?? ALL_SOURCES}
        onValueChange={next => onChange(next === ALL_SOURCES ? null : next)}
        aria-label={zh ? '按来源筛选' : 'Filter by source'}
      >
        <SegmentedItem value={ALL_SOURCES}>{zh ? '全部' : 'All'}</SegmentedItem>
        {visibleSources.map(id => {
          const requestCount = requests.get(id);
          return (
            <SegmentedItem
              key={id}
              value={id}
              title={requestCount === undefined ? id : `${providerLabel(id)} (${id}) · ${count(requestCount)} ${zh ? '条记录' : requestCount === 1 ? 'record' : 'records'}`}
            >
              <AgentIcon id={agentIconId(id)} size={14} />
              <span>{providerLabel(id)}</span>
              {requestCount !== undefined && requestCount > 0 ? (
                <span className={styles.sourceCount} aria-hidden="true">{tokens(requestCount)}</span>
              ) : null}
            </SegmentedItem>
          );
        })}
      </Segmented>
      {canCollapse ? (
        <button
          type="button"
          className={styles.moreSources}
          aria-expanded={expanded}
          onClick={() => setExpanded(current => !current)}
        >
          {expanded ? (zh ? '收起' : 'Less') : (zh ? `+${hiddenCount} 更多` : `+${hiddenCount} more`)}
        </button>
      ) : null}
    </div>
  );
}

/** Where a row of items of the given widths starts new lines so that no line is wider than `room`: the fewest lines
 *  that fit, spread so the widest of them is as narrow as it can be. Returns the indexes that begin the second and
 *  later lines; none when everything fits on one line, or when one item alone is wider than the room (the row then
 *  wraps by itself). */
export function balancedBreaks(widths: readonly number[], room: number, gap: number): number[] {
  const n = widths.length;
  const span = (from: number, to: number) => {
    let total = gap * (to - from - 1);
    for (let index = from; index < to; index += 1) total += widths[index]!;
    return total;
  };
  if (n === 0 || span(0, n) <= room || widths.some(width => width > room)) return [];
  let lines = 1;
  for (let start = 0, index = 1; index < n; index += 1) {
    if (span(start, index + 1) > room) {
      lines += 1;
      start = index;
    }
  }
  // widest[line][end]: the narrowest possible widest line when the first `end` items fill `line` lines.
  const widest = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const cut = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(0));
  widest[0]![0] = 0;
  for (let line = 1; line <= lines; line += 1) {
    for (let end = line; end <= n; end += 1) {
      for (let start = line - 1; start < end; start += 1) {
        const lineWidth = span(start, end);
        if (lineWidth > room) continue;
        const value = Math.max(widest[line - 1]![start]!, lineWidth);
        if (value < widest[line]![end]!) {
          widest[line]![end] = value;
          cut[line]![end] = start;
        }
      }
    }
  }
  const breaks: number[] = [];
  for (let line = lines, end = n; line > 1; line -= 1) {
    end = cut[line]![end]!;
    breaks.unshift(end);
  }
  return breaks;
}

function relativeSync(syncedAt: number | null, now: number, zh: boolean, locale: string): string {
  if (syncedAt === null) return zh ? '同步中' : 'Syncing';
  const elapsed = Math.max(0, now - syncedAt);
  if (elapsed < 60_000) return zh ? '刚刚同步' : 'Synced just now';
  if (elapsed < 3_600_000) {
    const minutes = Math.floor(elapsed / 60_000);
    return zh ? `${minutes} 分钟前同步` : `Synced ${minutes} min ago`;
  }
  const time = new Date(syncedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return zh ? `${time} 同步` : `Synced ${time}`;
}

/** What the figures cover, in the words of the preset that chose it; a custom range names its days. */
function scopeLabel(range: UsageRange, today: string, zh: boolean): string {
  switch (range.preset) {
    case 'today': return zh ? '今天' : 'Today';
    case '7d': return zh ? '近 7 天' : 'Last 7 days';
    case '30d': return zh ? '近 30 天' : 'Last 30 days';
    case '90d': return zh ? '近 90 天' : 'Last 90 days';
    case 'mtd': return zh ? '本月' : 'This month';
    case 'last-month': return zh ? '上月' : 'Last month';
    default: return formatRange(range.from, range.to, zh, today);
  }
}

/** An amount with its dollar sign set small, so the figure reads by its digits. */
function Amount({ value }: { value: string }) {
  const match = /^(<?)\$(.+)$/.exec(value);
  if (!match) return <>{value}</>;
  return <>{match[1]}<span className={styles.currency}>$</span>{match[2]}</>;
}

function Kpis({ totals, zh, compact }: { totals: AiUsageTotals; zh: boolean; compact: boolean }) {
  const settled = totals.requests - totals.pending;
  const successRate = settled > 0 ? (settled - totals.failed) / settled : null;
  const cachePool = totals.inputTokens + totals.cachedTokens;
  const cacheShare = cachePool > 0 ? totals.cachedTokens / cachePool : null;
  const digits = moneyDigits(totals.chargedUsd, totals.reportedUsd, totals.refundedUsd);
  // Each note is its own phrase on the foot, so a narrow column wraps between them, never inside one.
  const chargedNotes = [
    Number(totals.refundedUsd) > 0 ? `${zh ? '已退款' : 'Refunded'} ${money(totals.refundedUsd, digits)}` : '',
    totals.pending ? `${zh ? '处理中' : 'Pending'} ${count(totals.pending)}` : '',
  ].filter(Boolean);
  // The pending count already sits under the charges, so the requests card keeps to failures and the success rate.
  const requestsTitle = [
    totals.failed ? (zh ? `${count(totals.failed)} 次失败` : `${count(totals.failed)} failed`) : '',
    successRate !== null ? `${zh ? '成功率' : 'success'} ${percent(successRate)}` : '',
    totals.pending ? `${zh ? '处理中' : 'pending'} ${count(totals.pending)}` : '',
  ].filter(Boolean).join(' · ') || undefined;

  const reportedUnavailable = totals.requests > 0 && totals.unknown >= totals.requests && Number(totals.reportedUsd) === 0;

  return (
    <>
      {/* The two costs stand side by side and are never added up: one is billed, the other only reported. */}
      <dl className={styles.money}>
        <div className={styles.figure}>
          <dt>{zh ? 'TokenToSea 已扣费' : 'TokenToSea charges'}</dt>
          <dd className={styles.figureValue}><Amount value={money(totals.chargedUsd, digits)} /></dd>
          <dd className={styles.figureFoot}>
            {chargedNotes.length ? chargedNotes.map(note => <span key={note}>{note}</span>) : (zh ? '来自服务回执' : 'From service receipts')}
          </dd>
        </div>
        <div className={styles.figure}>
          <dt>{zh ? '其他渠道报告费用' : 'Other reported cost'}</dt>
          <dd className={styles.figureValue} data-unavailable={reportedUnavailable || undefined}>
            {reportedUnavailable ? '—' : <Amount value={money(totals.reportedUsd, digits)} />}
          </dd>
          <dd className={styles.figureFoot}>
            {totals.unknown ? (zh ? `费用未提供 ${count(totals.unknown)}` : `Cost unavailable ${count(totals.unknown)}`) : (zh ? '供应方自报' : 'Provider-reported')}
          </dd>
        </div>
      </dl>
      {(totals.estimatedRequests ?? 0) > 0 ? (
        <div className={styles.estimate}>
          <div className={styles.estimateMeta}>
            <span className={styles.estimateLabel}>{zh ? '本地 Token 估算价值' : 'Estimated local token value'}</span>
            <span className={styles.estimateNote}>{zh ? `${count(totals.estimatedRequests ?? 0)} 条记录 · 非实际扣费` : `${count(totals.estimatedRequests ?? 0)} records · not charged`}</span>
          </div>
          <strong className={styles.estimateValue}>{money(totals.estimatedUsd ?? '0', moneyDigits(totals.estimatedUsd))}</strong>
        </div>
      ) : null}
      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>{zh ? '请求' : 'Requests'}</dt>
          <dd className={styles.statValue}>{count(totals.requests)}</dd>
          {totals.sessionRecords ? <dd className={styles.statFoot}>{zh ? `另含 ${count(totals.sessionRecords)} 条会话汇总` : `Also ${count(totals.sessionRecords)} session summaries`}</dd> : null}
          <dd className={styles.statFoot} title={requestsTitle}>
            {totals.failed ? (
              <>
                <span className={styles.failed}>{zh ? `${count(totals.failed)} 次失败` : `${count(totals.failed)} failed`}</span>
                {successRate !== null ? <span>{zh ? `成功率 ${percent(successRate)}` : `${percent(successRate)} success`}</span> : null}
              </>
            ) : settled > 0 ? (zh ? '没有失败' : 'No failures') : '—'}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Token</dt>
          <dd className={styles.statValue}>{tokens(totals.inputTokens + totals.outputTokens)}</dd>
          <dd className={styles.statFoot}>
            <span>{zh ? '输入' : 'Input'} {tokens(totals.inputTokens)}</span>
            <span>{zh ? '输出' : 'Output'} {tokens(totals.outputTokens)}</span>
          </dd>
        </div>
        {compact ? null : (
          <div
            className={styles.stat}
            title={zh
              ? '缓存读取 ÷（输入 + 缓存读取），按供应方报告值计算；各家对输入是否已含缓存的口径不同。'
              : 'Cache reads ÷ (input + cache reads), from provider-reported counts; providers differ on whether input already includes cache reads.'}
          >
            <dt>{zh ? '缓存读取' : 'Cache reads'}</dt>
            <dd className={styles.statValue}>{tokens(totals.cachedTokens)}</dd>
            <dd className={styles.statFoot}>
              <span className={styles.meter} aria-hidden="true">
                <span style={{ transform: `scaleX(${cacheShare ?? 0})` }} />
              </span>
              <span>{cacheShare === null ? '—' : `${zh ? '占输入侧' : 'of input side'} ${percent(cacheShare)}`}</span>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}
