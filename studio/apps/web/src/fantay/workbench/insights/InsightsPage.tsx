// fx-governance-allow-raw: a top-content row is a whole ranked row with a cover, which no button primitive models
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 复盘 — one sentence on how the published content did, KPI blocks, the daily
 * trend, platform split, best content, suggestions learned from the data, the writing rules
 * (exportable as a Fantay Skill), the creator's accounts, and three ways to get data in.
 * 小红书 / 抖音 imports carry no view counts; then everything is compared by engagement.
 * Derived from dsh-media-desk client/insights.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardPaste, Plus, UserPlus } from 'lucide-react';
import type { WorkbenchInsights } from '@open-design/contracts';
import { Button, EmptyState, Icon, Segmented, SegmentedItem, Skeleton, cn } from '../../ui';
import { workbenchApi } from '../api';
import { useL, useWorkbenchLang } from '../lang';
import { compact, displayItem, fmtDate, platformName } from '../shared/format';
import { errorMessage, workbench } from '../store';
import type { WorkbenchPageProps } from '../types';
import { coverUrl, useWorkbenchPageData } from '../pages-shared/data';
import { ItemCover } from '../pages-shared/ItemCover';
import page from '../pages-shared/page.module.css';
import { AccountsTile } from './AccountsTile';
import { CsvDialog, MetricDialog } from './DataDialogs';
import { RulesTile, SuggestionsTile } from './RulesPanel';
import { TrendChart } from './TrendChart';
import styles from './InsightsPage.module.css';

const clip = (text: string, n: number) => (Array.from(text).length > n ? `${Array.from(text).slice(0, n).join('').trimEnd()}…` : text);

export function InsightsPage({ active, openItem, openImport }: WorkbenchPageProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const { state, items, loading, error } = useWorkbenchPageData();
  const [data, setData] = useState<WorkbenchInsights | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState<'metric' | 'csv' | null>(null);
  const [field, setField] = useState<'views' | 'engaged'>('views');
  const [show, setShow] = useState<'chart' | 'table'>('chart');
  const fetched = useRef<unknown[]>([]);

  // Re-read the summary whenever the data it is computed from changes, but only while visible.
  const metrics = state?.metrics;
  const allItems = state?.items;
  const accounts = state?.accounts;
  useEffect(() => {
    if (!active || !metrics) return undefined;
    const deps = [metrics, allItems, accounts, retry];
    if (data && deps.every((dep, i) => dep === fetched.current[i])) return undefined;
    let alive = true;
    workbenchApi
      .insights()
      .then((next) => {
        if (!alive) return;
        fetched.current = deps;
        setData(next);
        setFetchError(null);
      })
      .catch((err: unknown) => {
        if (alive) setFetchError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
    // `data` is read only to know whether a first result exists
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, metrics, allItems, accounts, retry]);

  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const hasMetrics = Boolean(metrics?.length);
  const hasViews = Boolean(data && data.views > 0);
  const shownField = hasViews ? field : 'engaged';
  const barKey: 'views' | 'engaged' = data && data.platforms.length && data.platforms.every((p) => p.views > 0) ? 'views' : 'engaged';

  const actions = (
    <div className={page.heroActions}>
      <Button variant="primary" onClick={openImport}>
        <Icon icon={UserPlus} />
        {L('导入账号', 'Import account')}
      </Button>
      <Button variant="secondary" onClick={() => setDialog('metric')}>
        <Icon icon={Plus} />
        {L('手动录入', 'Add manually')}
      </Button>
      <Button variant="secondary" onClick={() => setDialog('csv')}>
        <Icon icon={ClipboardPaste} />
        {L('粘贴 CSV', 'Paste CSV')}
      </Button>
    </div>
  );

  const dialogs = (
    <>
      <MetricDialog open={dialog === 'metric'} onClose={() => setDialog(null)} items={items} />
      <CsvDialog open={dialog === 'csv'} onClose={() => setDialog(null)} />
    </>
  );

  if (loading || error !== null) {
    return (
      <div className={page.page}>
        <div className={page.inner}>
          {error !== null ? (
            <div className={page.centerState}>
              <EmptyState
                variant="dashed"
                title={L('没能读取工作台', 'Could not load the workbench')}
                description={error || undefined}
                action={<Button variant="primary" onClick={() => void workbench.refresh()}>{L('重试', 'Retry')}</Button>}
              />
            </div>
          ) : (
            <InsightsSkeleton />
          )}
        </div>
      </div>
    );
  }

  const skills = state?.skills ?? [];
  const rulesRow = (
    <div className={styles.row}>
      <RulesTile skills={skills} />
      <AccountsTile accounts={accounts ?? []} onImport={openImport} />
    </div>
  );

  // No data yet: the invitation, then the rules and accounts that still matter.
  if (!hasMetrics) {
    return (
      <div className={page.page}>
        <div className={cn(page.inner, styles.stack)}>
          <section className={cn(page.tile, page.hero, page.rise, styles.heroEmpty)}>
            <div className={page.heroCopy}>
              <h1 className={page.heroLine}>
                {L('发布之后，把数据录进来，', 'After you publish, bring the numbers in')}
                <br />
                <b>{L('这里就开始替你复盘。', 'and this page starts reviewing for you.')}</b>
              </h1>
              {actions}
            </div>
          </section>
          <div className={styles.row}>
            <SuggestionsTile skills={skills} includeSamples />
            <AccountsTile accounts={accounts ?? []} onImport={openImport} />
          </div>
          <RulesTile skills={skills} />
        </div>
        {dialogs}
      </div>
    );
  }

  if (!data) {
    return (
      <div className={page.page}>
        <div className={page.inner}>
          {fetchError ? (
            <div className={page.centerState}>
              <EmptyState
                variant="dashed"
                title={L('没能算出复盘', 'Could not compute the review')}
                description={fetchError}
                action={<Button variant="primary" onClick={() => setRetry((n) => n + 1)}>{L('重试', 'Retry')}</Button>}
              />
            </div>
          ) : (
            <InsightsSkeleton />
          )}
        </div>
        {dialogs}
      </div>
    );
  }

  const top = data.top.filter((row) => byId.has(row.id));
  const best = top[0];
  const bestItem = best ? byId.get(best.id) : undefined;
  const heroPic = bestItem && coverUrl(bestItem);
  const realFollowers = data.followers > 0;
  const points = data.daily.map((row) => ({ date: row.date, value: row[shownField], secondary: shownField === 'views' ? row.engaged : undefined }));
  const peak = points.reduce((m, p) => Math.max(m, p.value), 0);
  const unitText = (value: number, kind: 'views' | 'engaged') =>
    kind === 'views'
      ? L(`${value.toLocaleString()} 播放`, `${value.toLocaleString()} view${value === 1 ? '' : 's'}`)
      : L(`${value.toLocaleString()} 互动`, `${value.toLocaleString()} engagement${value === 1 ? '' : 's'}`);
  const maxBar = Math.max(1, ...data.platforms.map((p) => p[barKey]));
  const platforms = [...data.platforms].sort((a, b) => b[barKey] - a[barKey]);

  return (
    <div className={page.page}>
      <div className={cn(page.inner, styles.stack)}>
        <section className={cn(page.tile, page.hero, page.rise)}>
          <div className={page.heroCopy}>
            <h1 className={page.heroLine}>
              <b>{L(`${data.published} 条内容`, `${data.published} post${data.published === 1 ? '' : 's'}`)}</b>{' '}
              {L('带来了', 'brought in')}{' '}
              <b>
                {hasViews
                  ? L(`${compact(data.views, lang)} 次播放`, `${compact(data.views, lang)} view${data.views === 1 ? '' : 's'}`)
                  : L(`${compact(data.engaged, lang)} 次互动`, `${compact(data.engaged, lang)} engagement${data.engaged === 1 ? '' : 's'}`)}
              </b>
              {best ? L('，', ', ') : L('。', '.')}
              {best ? (
                <>
                  <br />
                  {L('表现最好的是', 'the best was')}
                  {heroPic ? <img className={page.heroPic} src={heroPic} alt="" draggable={false} /> : ' '}
                  <b>{clip(best.title, lang === 'en' ? 34 : 16)}</b>
                  {L('。', '.')}
                </>
              ) : null}
            </h1>
            {data.hasSample ? (
              <p className={styles.sampleHint}>
                {L('现在显示的是示例数据。录入、粘贴或导入你自己的数据后，这里会换成你的。', 'You are looking at sample data. Add, paste or import your own and it takes over.')}
              </p>
            ) : null}
            {actions}
          </div>
          {data.hasSample ? <span className={page.heroCorner}>{L('示例数据', 'Sample data')}</span> : null}
        </section>

        <dl className={cn(page.kpis, page.rise)} style={{ animationDelay: '40ms' }}>
          <div className={page.kpi}>
            <dt>{L('播放', 'Views')}</dt>
            <dd>{hasViews ? compact(data.views, lang) : '—'}</dd>
            {!hasViews ? <dd className={page.kpiNote}>{L('平台没给播放量，按互动算', 'No view counts; compared by engagement')}</dd> : null}
          </div>
          <div className={page.kpi}>
            <dt>{L('互动', 'Engagement')}</dt>
            <dd>{compact(data.engaged, lang)}</dd>
            <dd className={page.kpiNote}>{L('赞、评、转、藏合计', 'Likes, comments, shares, saves')}</dd>
          </div>
          <div className={page.kpi}>
            <dt>{L('互动率', 'Engagement rate')}</dt>
            <dd>
              {hasViews ? (data.engagementRate * 100).toFixed(1) : '—'}
              {hasViews ? <small>%</small> : null}
            </dd>
            <dd className={page.kpiNote}>{hasViews ? L('互动 ÷ 播放', 'Engagement ÷ views') : L('需要播放量', 'Needs view counts')}</dd>
          </div>
          <div className={page.kpi}>
            <dt>{L('已发布', 'Published')}</dt>
            <dd>
              {data.published}
              {lang === 'zh' ? <small>条</small> : null}
            </dd>
            <dd className={page.kpiNote}>{L(`${data.platforms.length} 个平台`, `${data.platforms.length} platform${data.platforms.length === 1 ? '' : 's'}`)}</dd>
          </div>
          <div className={page.kpi}>
            <dt>{L('粉丝', 'Followers')}</dt>
            <dd>{realFollowers ? compact(data.followers, lang) : '—'}</dd>
            <dd className={page.kpiNote}>{realFollowers ? L(`${(accounts ?? []).length} 个账号合计`, `Across ${(accounts ?? []).length} account${(accounts ?? []).length === 1 ? '' : 's'}`) : L('导入账号后显示', 'Shown after importing an account')}</dd>
          </div>
        </dl>

        <div className={styles.row}>
          <section className={cn(page.tile, page.rise, styles.trend)} aria-label={shownField === 'views' ? L('每日播放', 'Daily views') : L('每日互动', 'Daily engagement')}>
            <header className={page.tileHead}>
              <h2 className={page.tileTitle}>{shownField === 'views' ? L('每日播放', 'Daily views') : L('每日互动', 'Daily engagement')}</h2>
              <span className={page.tileMeta}>{points.length ? L(`${points.length} 天 · 峰值 ${compact(peak, lang)}`, `${points.length} days · peak ${compact(peak, lang)}`) : null}</span>
              <span className={page.grow} />
              {hasViews ? (
                <Segmented size="sm" value={field} onValueChange={(v) => setField(v === 'engaged' ? 'engaged' : 'views')} aria-label={L('指标', 'Measure')}>
                  <SegmentedItem value="views">{L('播放', 'Views')}</SegmentedItem>
                  <SegmentedItem value="engaged">{L('互动', 'Engagement')}</SegmentedItem>
                </Segmented>
              ) : null}
              <Segmented size="sm" value={show} onValueChange={(v) => setShow(v === 'table' ? 'table' : 'chart')} aria-label={L('显示方式', 'View')}>
                <SegmentedItem value="chart">{L('图', 'Chart')}</SegmentedItem>
                <SegmentedItem value="table">{L('表', 'Table')}</SegmentedItem>
              </Segmented>
            </header>
            {!points.length ? (
              <p className={cn(styles.quietLine, styles.padded)}>{L('还没有按天的数据。', 'No daily data yet.')}</p>
            ) : show === 'chart' ? (
              <div className={styles.chartBox}>
                <TrendChart
                  key={shownField}
                  points={points}
                  lang={lang}
                  label={
                    shownField === 'views'
                      ? L(`每日播放趋势，共 ${points.length} 天，峰值 ${compact(peak, lang)}`, `Daily views over ${points.length} days, peak ${compact(peak, lang)}`)
                      : L(`每日互动趋势，共 ${points.length} 天，峰值 ${compact(peak, lang)}`, `Daily engagement over ${points.length} days, peak ${compact(peak, lang)}`)
                  }
                  valueText={(v) => unitText(v, shownField)}
                  {...(shownField === 'views' ? { secondaryText: (v: number) => unitText(v, 'engaged') } : {})}
                />
              </div>
            ) : (
              <div className={styles.tableBox}>
                <table className={styles.plainTable}>
                  <thead>
                    <tr>
                      <th>{L('日期', 'Date')}</th>
                      {hasViews ? <th className={styles.isNum}>{L('播放', 'Views')}</th> : null}
                      <th className={styles.isNum}>{L('互动', 'Engagement')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.daily].reverse().map((row) => (
                      <tr key={row.date}>
                        <td>{fmtDate(`${row.date.slice(0, 10)}T12:00:00`, lang)}</td>
                        {hasViews ? <td className={styles.isNum}>{row.views.toLocaleString()}</td> : null}
                        <td className={styles.isNum}>{row.engaged.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={cn(page.tile, page.rise, styles.platforms)} aria-label={L('平台分布', 'By platform')} style={{ animationDelay: '60ms' }}>
            <header className={page.tileHead}>
              <h2 className={page.tileTitle}>{L('平台分布', 'By platform')}</h2>
              <span className={page.tileMeta}>{barKey === 'views' ? L('按播放', 'by views') : L('按互动', 'by engagement')}</span>
            </header>
            {platforms.length ? (
              <ul className={styles.bars}>
                {platforms.map((p) => (
                  <li key={p.platform}>
                    <span className={styles.barName}>{platformName(p.platform, lang)}</span>
                    <b className={styles.barValue}>{compact(p[barKey], lang)}</b>
                    <span className={styles.barTrack}>
                      <i style={{ width: `${(p[barKey] / maxBar) * 100}%` }} />
                    </span>
                    <small className={styles.barSub}>
                      {[
                        barKey === 'engaged' && p.views ? L(`${compact(p.views, lang)} 播放`, `${compact(p.views, lang)} views`) : null,
                        L(`${compact(p.likes, lang)} 赞`, `${compact(p.likes, lang)} likes`),
                        L(`${compact(p.comments, lang)} 评`, `${compact(p.comments, lang)} comments`),
                        L(`${compact(p.saves, lang)} 藏`, `${compact(p.saves, lang)} saves`),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={cn(styles.quietLine, styles.padded)}>{L('还没有平台数据。', 'No platform data yet.')}</p>
            )}
          </section>
        </div>

        <div className={styles.row}>
          <section className={cn(page.tile, page.rise, styles.top)} aria-label={L('表现最好的内容', 'Best performing')} style={{ animationDelay: '80ms' }}>
            <header className={page.tileHead}>
              <h2 className={page.tileTitle}>{L('表现最好的内容', 'Best performing')}</h2>
            </header>
            {top.length ? (
              <ol className={styles.topList}>
                {top.slice(0, 6).map((row, index) => {
                  const item = byId.get(row.id);
                  return (
                    <li key={row.id}>
                      <button type="button" className={styles.topRow} onClick={() => openItem(row.id)} disabled={!item}>
                        <span className={styles.topRank}>{index + 1}</span>
                        {item ? <ItemCover item={item} className={styles.topThumb} /> : <span className={styles.topThumb} />}
                        <span className={styles.topTitle}>
                          <strong>{item ? displayItem(item).title : row.title}</strong>
                          <small>
                            {[
                              row.platform ? platformName(row.platform, lang) : null,
                              L(`${compact(row.likes, lang)} 赞`, `${compact(row.likes, lang)} likes`),
                              L(`${compact(row.comments, lang)} 评论`, `${compact(row.comments, lang)} comments`),
                              L(`${compact(row.saves, lang)} 收藏`, `${compact(row.saves, lang)} saves`),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </small>
                        </span>
                        <span className={styles.topValue}>
                          <b>{compact(row.views || row.engaged, lang)}</b>
                          <small>{row.views ? L('播放', 'views') : L('互动', 'engaged')}</small>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className={cn(styles.quietLine, styles.padded)}>{L('把数据关联到内容后，这里会排出表现最好的几篇。', 'Link data to your content and the best pieces rank here.')}</p>
            )}
          </section>
          <SuggestionsTile skills={skills} includeSamples={data.hasSample} className={styles.advice} />
        </div>

        {rulesRow}
      </div>
      {dialogs}
    </div>
  );
}

function InsightsSkeleton() {
  return (
    <div className={styles.stack} aria-busy>
      <Skeleton shape="card" style={{ minHeight: 168 }} />
      <div className={page.kpis}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} shape="row" index={i} style={{ height: 84 }} />
        ))}
      </div>
      <div className={styles.row}>
        <Skeleton shape="card" style={{ minHeight: 300 }} />
        <Skeleton shape="card" index={1} style={{ minHeight: 300 }} />
      </div>
    </div>
  );
}
