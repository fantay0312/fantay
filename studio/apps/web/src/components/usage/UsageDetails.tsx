/* SPDX-License-Identifier: AGPL-3.0-only */
/* The lower half, as tabs (CC Switch): the request log with a status filter, then the range grouped by model, source
   and project. One search box filters whichever tab is open; 导出 CSV writes exactly the rows that tab shows. */
import { useState, type ReactNode } from 'react';
import type { AiUsageRecord, AiUsageSession, AiUsageSummary, AiUsageTotals, WorkspaceCollabContext } from '@open-design/contracts';
import { ArrowLeft, Download } from 'lucide-react';
import { AgentIcon } from '../AgentIcon';
import { agentIconId } from '../../utils/agentLabels';
import { Button, Icon, IconButton, SearchField, Segmented, SegmentedItem, Tabs, TabsContent, TabsList, TabsTrigger, XIcon } from '../../fantay/ui';
import {
  count, downloadCsv, isFailed, money, moneyDigits, percent, projectLabel, providerLabel, statusLabel, statusTone, tokens,
  type MoneyDigits,
} from './usage-format';
import styles from './UsageDetails.module.css';
import { useSessionUsage } from './useSessionUsage';

type Tab = 'log' | 'models' | 'providers' | 'projects' | 'sessions';
const PAGE = 50;

const totalTokens = (totals: AiUsageTotals) => totals.inputTokens + totals.outputTokens;

export function UsageDetails({ data, zh, locale, showProjects, context }: {
  data: AiUsageSummary;
  zh: boolean;
  locale: string;
  showProjects: boolean;
  context?: WorkspaceCollabContext | null;
}) {
  const [tab, setTab] = useState<Tab>('log');
  const [status, setStatus] = useState<'all' | 'failed'>('all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [selectedSession, setSelectedSession] = useState<AiUsageSession | null>(null);
  const sessionUsage = useSessionUsage(data, selectedSession, context);
  const needle = query.trim().toLowerCase();
  const matches = (...values: Array<string | null | undefined>) => !needle || values.some(value => value?.toLowerCase().includes(needle));
  const range = `${data.scope ?? 'fantay'}_${data.from}_${data.to}`;
  const sumTokens = totalTokens(data.totals);

  const log = data.recent.filter(row =>
    (status === 'all' || isFailed(row))
    && matches(row.model, row.provider, providerLabel(row.provider), row.projectName, row.kind, row.sessionId));
  const failedLoaded = data.recent.filter(isFailed).length;
  const models = data.models.filter(row => matches(row.model, row.provider, providerLabel(row.provider)));
  const providers = data.providers.filter(row => matches(row.provider, providerLabel(row.provider)));
  const projects = data.projects.filter(row => matches(projectLabel(row.projectId, row.projectName, zh)));
  const sessions = (data.sessions ?? []).filter(row => matches(row.sessionId, row.provider, providerLabel(row.provider), ...row.models));
  const sessionLog = (sessionUsage?.data?.recent ?? []).filter(row => matches(row.model, row.sessionId, row.provider));
  const sessionDigits = moneyDigits(...sessionLog.map(row => row.reportedUsd ?? row.estimatedUsd));
  // Each table's amount columns share one precision, so the decimal points line up down the column.
  const logDigits = moneyDigits(...data.recent.map(row => row.chargedUsd ?? row.reportedUsd));
  const groupDigits = moneyDigits(...[...data.models, ...data.providers, ...data.projects].flatMap(row => [row.totals.chargedUsd, row.totals.reportedUsd]));

  const exportCsv = () => {
    if (tab === 'log' || tab === 'sessions' && selectedSession) {
      downloadCsv(`fantay-usage-requests-${range}.csv`,
        ['time', 'provider', 'model', 'project', 'kind', 'status', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'charged_usd', 'refunded_usd', 'reported_usd', 'estimated_usd', 'origin', 'session_id', 'granularity', 'request_count'],
        (tab === 'log' ? log : sessionLog).map(row => [
          new Date(row.createdAt).toISOString(), row.provider, row.model, row.projectName ?? row.projectId ?? '', row.kind, row.status,
          row.inputTokens, row.outputTokens, row.cachedTokens, row.chargedUsd, row.refundedUsd, row.reportedUsd, row.estimatedUsd, row.origin ?? 'fantay', row.sessionId ?? '', row.granularity ?? 'request', row.requestCount ?? (row.granularity==='session'?'':1),
        ]));
      return;
    }
    const header = ['requests', 'failed', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'charged_usd', 'refunded_usd', 'reported_usd', 'cost_unavailable', 'estimated_usd', 'session_summaries'];
    const figures = (t: AiUsageTotals) => [t.requests, t.failed, t.inputTokens, t.outputTokens, t.cachedTokens, t.chargedUsd, t.refundedUsd, t.reportedUsd, t.unknown, t.estimatedUsd, t.sessionRecords ?? 0];
    if (tab === 'models') downloadCsv(`fantay-usage-models-${range}.csv`, ['model', 'provider', ...header], models.map(row => [row.model, row.provider, ...figures(row.totals)]));
    if (tab === 'providers') downloadCsv(`fantay-usage-sources-${range}.csv`, ['provider', ...header], providers.map(row => [row.provider, ...figures(row.totals)]));
    if (tab === 'projects') downloadCsv(`fantay-usage-projects-${range}.csv`, ['project', 'project_id', ...header], projects.map(row => [projectLabel(row.projectId, row.projectName, zh), row.projectId ?? '', ...figures(row.totals)]));
    if (tab === 'sessions') downloadCsv(`fantay-usage-sessions-${range}.csv`, ['session_id', 'provider', 'models', 'first_used', 'last_used', ...header], sessions.map(row => [row.sessionId, row.provider, row.models.join(';'), new Date(row.firstUsedAt).toISOString(), new Date(row.lastUsedAt).toISOString(), ...figures(row.totals)]));
  };
  const rowsInTab = { log: log.length, models: models.length, providers: providers.length, projects: projects.length, sessions: selectedSession ? sessionLog.length : sessions.length }[tab];

  return (
    <section className={styles.section} aria-label={zh ? '明细' : 'Details'}>
      <h3 className={styles.heading}>{zh ? '明细' : 'Details'}</h3>
      <div className={styles.card}>
        <Tabs value={tab} onValueChange={value => { setTab(value as Tab); setShown(PAGE); }}>
          <TabsList variant="line" size="md" className={styles.tabs} aria-label={zh ? '明细类别' : 'Detail views'}>
            <TabsTrigger value="log">{zh ? '请求日志' : 'Requests'}<Count value={data.totals.requests} /></TabsTrigger>
            <TabsTrigger value="models">{zh ? '模型' : 'Models'}<Count value={data.models.length} /></TabsTrigger>
            <TabsTrigger value="providers">{zh ? '来源' : 'Sources'}<Count value={data.providers.length} /></TabsTrigger>
            {data.scope === 'device' ? <TabsTrigger value="sessions">{zh ? '会话' : 'Sessions'}<Count value={data.sessions?.length ?? 0} /></TabsTrigger> : null}
            {showProjects ? <TabsTrigger value="projects">{zh ? '项目' : 'Projects'}<Count value={data.projects.length} /></TabsTrigger> : null}
          </TabsList>

          <div className={styles.tools}>
            {tab === 'log' ? (
              <Segmented value={status} onValueChange={value => { setStatus(value as 'all' | 'failed'); setShown(PAGE); }} aria-label={zh ? '状态' : 'Status'}>
                <SegmentedItem value="all">{zh ? '全部' : 'All'}</SegmentedItem>
                <SegmentedItem value="failed">{zh ? `失败 ${count(data.totals.failed)}` : `Failed ${count(data.totals.failed)}`}</SegmentedItem>
              </Segmented>
            ) : null}
            <SearchField
              className={styles.search}
              value={query}
              onChange={event => { setQuery(event.target.value); setShown(PAGE); }}
              placeholder={zh ? '搜索模型、来源、项目、会话' : 'Search model, source, project, session'}
              aria-label={zh ? '搜索明细' : 'Search details'}
              trailing={query ? (
                <IconButton
                  size="xs"
                  aria-label={zh ? '清空搜索' : 'Clear search'}
                  onClick={() => { setQuery(''); setShown(PAGE); }}
                >
                  <XIcon />
                </IconButton>
              ) : null}
            />
            <Button className={styles.exportButton} onClick={exportCsv} disabled={rowsInTab === 0}>
              <Icon icon={Download} size="sm" />
              {zh ? '导出 CSV' : 'Export CSV'}
            </Button>
          </div>

          <TabsContent value="log" className={styles.panel}>
            {log.length ? (
              <>
                <Table className={styles.log} head={[zh ? '时间' : 'Time', zh ? '模型' : 'Model', 'Token', zh ? '费用' : 'Cost', zh ? '状态' : 'Status']}>
                  {log.slice(0, shown).map(row => <LogRow key={`${row.provider}:${row.requestKey}`} row={row} zh={zh} locale={locale} multiDay={data.from !== data.to} digits={logDigits} />)}
                </Table>
                {log.length > shown ? (
                  <Button size="sm" className={styles.more} onClick={() => setShown(value => value + PAGE)}>
                    {zh ? `显示更多（还有 ${count(log.length - shown)} 条）` : `Show more (${count(log.length - shown)} left)`}
                  </Button>
                ) : null}
              </>
            ) : <Empty zh={zh} filtered={Boolean(needle) || status === 'failed'} />}
            {data.totals.requests > data.recent.length ? (
              <p className={styles.note}>
                {zh
                  ? `日志列出最近 ${count(data.recent.length)} 条请求（共 ${count(data.totals.requests)} 条），筛选、搜索和导出都以此为限。`
                  : `The log lists the newest ${count(data.recent.length)} of ${count(data.totals.requests)} requests; filters, search and export cover those.`}
                {status === 'failed' && failedLoaded < data.totals.failed
                  ? (zh ? ` 其中可见 ${count(failedLoaded)} 次失败。` : ` ${count(failedLoaded)} failures are among them.`)
                  : ''}
              </p>
            ) : null}
          </TabsContent>

          <TabsContent value="sessions" className={styles.panel}>
            {selectedSession ? <>
              <div className={styles.sessionHead}>
                <Button size="sm" variant="ghost" className={styles.backButton} onClick={() => { setSelectedSession(null); setQuery(''); setShown(PAGE); }}>
                  <Icon icon={ArrowLeft} size="xs" />
                  {zh ? '全部会话' : 'All sessions'}
                </Button>
                <span className={styles.sessionIdentity}>
                  <AgentIcon id={agentIconId(selectedSession.provider)} size={15} />
                  <strong>{providerLabel(selectedSession.provider)}</strong>
                  <code className={styles.sessionId}>{selectedSession.sessionId}</code>
                </span>
              </div>
              {sessionUsage?.error ? <p className={styles.note} role="alert">{zh ? '读取会话失败：' : 'Could not read session: '}{sessionUsage.error}</p>
                : !sessionUsage?.data ? <p className={styles.note} role="status">{zh ? '正在读取会话用量…' : 'Loading session usage…'}</p>
                : <>
                  <dl className={styles.sessionStats}>
                    <div>
                      <dt>{zh ? '请求' : 'Requests'}</dt>
                      <dd>{count(sessionUsage.data.totals.requests)}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '输入 / 输出' : 'Input / Output'}</dt>
                      <dd>{tokens(sessionUsage.data.totals.inputTokens)} / {tokens(sessionUsage.data.totals.outputTokens)}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '缓存读取' : 'Cache read'}</dt>
                      <dd>{tokens(sessionUsage.data.totals.cachedTokens)}</dd>
                    </div>
                    <div>
                      <dt>{zh ? '报告费用' : 'Reported'}</dt>
                      <dd>{sessionUsage.data.totals.unknown >= sessionUsage.data.totals.requests ? '—' : money(sessionUsage.data.totals.reportedUsd)}</dd>
                    </div>
                    {(sessionUsage.data.totals.estimatedRequests ?? 0) > 0 ? (
                      <div>
                        <dt>{zh ? '估算价值' : 'Estimated value'}</dt>
                        <dd>{money(sessionUsage.data.totals.estimatedUsd ?? '0')}</dd>
                      </div>
                    ) : null}
                  </dl>
                  {sessionLog.length ? <Table className={styles.log} head={[zh ? '时间' : 'Time', zh ? '模型' : 'Model', 'Token', zh ? '费用' : 'Cost', zh ? '状态' : 'Status']}>
                    {sessionLog.slice(0, shown).map(row => <LogRow key={row.requestKey} row={row} zh={zh} locale={locale} multiDay={data.from !== data.to} digits={sessionDigits} />)}
                  </Table> : <Empty zh={zh} filtered={Boolean(needle)} />}
                  {sessionLog.length > shown ? <Button size="sm" className={styles.more} onClick={() => setShown(value => value + PAGE)}>{zh ? '显示更多' : 'Show more'}</Button> : null}
                  {sessionUsage.data.totals.requests > sessionUsage.data.recent.length ? <p className={styles.note}>{zh ? `汇总包含全部请求；明细和明细导出限最近 ${count(sessionUsage.data.recent.length)} 条。` : `Totals include all requests; details and their export cover the newest ${count(sessionUsage.data.recent.length)}.`}</p> : null}
                </>}
            </> : sessions.length ? <>
              <Table head={[zh ? '会话' : 'Session', zh ? '请求' : 'Requests', 'Token', zh ? '缓存读取' : 'Cache read', zh ? '报告费用' : 'Reported']}>
                {sessions.slice(0, shown).map(row => <tr key={`${row.provider}:${row.sessionId}`}>
                  <td>
                    <button
                      type="button"
                      className={styles.sessionButton}
                      title={`${providerLabel(row.provider)} · ${row.sessionId}`}
                      onClick={() => { setSelectedSession(row); setQuery(''); setShown(PAGE); }}
                    >
                      <AgentIcon id={agentIconId(row.provider)} size={14} />
                      <span className={styles.sessionLabel}>{providerLabel(row.provider)} · {row.sessionId}</span>
                    </button>
                    <small title={row.models.join(', ')}>{new Date(row.lastUsedAt).toLocaleDateString(locale)}{row.models.length ? ` · ${row.models.join(', ')}` : ''}</small>
                  </td>
                  <RequestsCell totals={row.totals} zh={zh} />
                  <td title={`${zh ? '输入 / 输出' : 'Input / output'}: ${count(row.totals.inputTokens)} / ${count(row.totals.outputTokens)}`}>{tokens(totalTokens(row.totals))}</td>
                  <td>{tokens(row.totals.cachedTokens)}</td>
                  <ReportedCell totals={row.totals} zh={zh} digits={moneyDigits(row.totals.reportedUsd, row.totals.estimatedUsd)} />
                </tr>)}
              </Table>
              {sessions.length > shown ? <Button size="sm" className={styles.more} onClick={() => setShown(value => value + PAGE)}>{zh ? '显示更多会话' : 'Show more sessions'}</Button> : null}
              <p className={styles.note}>{zh ? '会话统计覆盖所选日期内的全部请求，点击会话查看明细。' : 'Sessions include all requests in the selected date range. Select a session for details.'}</p>
            </> : <Empty zh={zh} filtered={Boolean(needle)} />}
          </TabsContent>

          <TabsContent value="models" className={styles.panel}>
            {models.length ? (
              <Table head={[zh ? '模型' : 'Model', zh ? '请求' : 'Requests', 'Token', zh ? '已扣费' : 'Charged', zh ? '报告费用' : 'Reported']}>
                {models.map(row => (
                  <tr key={`${row.provider}:${row.model}`}>
                    <td><strong title={row.model}>{row.model}</strong><small>{providerLabel(row.provider)}</small></td>
                    <RequestsCell totals={row.totals} zh={zh} />
                    <td>{tokens(totalTokens(row.totals))}{sumTokens ? <small>{percent(totalTokens(row.totals) / sumTokens)}</small> : null}</td>
                    <td>{money(row.totals.chargedUsd, groupDigits)}</td>
                    <ReportedCell totals={row.totals} zh={zh} digits={groupDigits} />
                  </tr>
                ))}
              </Table>
            ) : <Empty zh={zh} filtered={Boolean(needle)} />}
          </TabsContent>

          <TabsContent value="providers" className={styles.panel}>
            {providers.length ? (
              <Table head={[zh ? '来源' : 'Source', zh ? '请求' : 'Requests', 'Token', zh ? '已扣费' : 'Charged', zh ? '报告费用' : 'Reported']}>
                {providers.map(row => (
                  <tr key={row.provider}>
                    <td>
                      <span className={styles.source}>
                        <AgentIcon id={agentIconId(row.provider)} size={16} />
                        <strong title={row.provider}>{providerLabel(row.provider)}</strong>
                      </span>
                    </td>
                    <RequestsCell totals={row.totals} zh={zh} />
                    <td>{tokens(totalTokens(row.totals))}{sumTokens ? <small>{percent(totalTokens(row.totals) / sumTokens)}</small> : null}</td>
                    <td>{money(row.totals.chargedUsd, groupDigits)}</td>
                    <ReportedCell totals={row.totals} zh={zh} digits={groupDigits} />
                  </tr>
                ))}
              </Table>
            ) : <Empty zh={zh} filtered={Boolean(needle)} />}
          </TabsContent>

          {showProjects ? (
            <TabsContent value="projects" className={styles.panel}>
              {projects.length ? (
                <Table head={[zh ? '项目' : 'Project', zh ? '请求' : 'Requests', 'Token', zh ? '已扣费' : 'Charged', zh ? '报告费用' : 'Reported']}>
                  {projects.map(row => (
                    <tr key={row.projectId ?? 'unbound'}>
                      <td><strong>{projectLabel(row.projectId, row.projectName, zh)}</strong></td>
                      <RequestsCell totals={row.totals} zh={zh} />
                      <td>{tokens(totalTokens(row.totals))}{sumTokens ? <small>{percent(totalTokens(row.totals) / sumTokens)}</small> : null}</td>
                      <td>{money(row.totals.chargedUsd, groupDigits)}</td>
                      <ReportedCell totals={row.totals} zh={zh} digits={groupDigits} />
                    </tr>
                  ))}
                </Table>
              ) : <Empty zh={zh} filtered={Boolean(needle)} />}
            </TabsContent>
          ) : null}
        </Tabs>
      </div>
    </section>
  );
}

function Count({ value }: { value: number }) {
  return <span className={styles.count}>{count(value)}</span>;
}

function Table({ head, children, className }: { head: string[]; children: ReactNode; className?: string }) {
  return (
    <div className={styles.tableWrap}>
      <table className={`${styles.table} ${className ?? ''}`}>
        <thead>
          <tr>{head.map(label => <th key={label} scope="col">{label}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function RequestsCell({ totals, zh }: { totals: AiUsageTotals; zh: boolean }) {
  return (
    <td>
      {count(totals.requests)}
      {totals.failed ? <small className={styles.failed}>{zh ? `${count(totals.failed)} 次失败` : `${count(totals.failed)} failed`}</small> : null}
    </td>
  );
}

function ReportedCell({ totals, zh, digits }: { totals: AiUsageTotals; zh: boolean; digits: MoneyDigits }) {
  return (
    <td>
      {totals.unknown >= totals.requests && totals.requests > 0 ? '—' : money(totals.reportedUsd, digits)}
      {(totals.estimatedRequests ?? 0) > 0 ? <small>{zh ? '估算' : 'Est.'} {money(totals.estimatedUsd ?? '0', digits)}</small> : null}
      {totals.unknown ? <small>{zh ? `${count(totals.unknown)} 次未提供` : `${count(totals.unknown)} without cost`}</small> : null}
    </td>
  );
}

function LogRow({ row, zh, locale, multiDay, digits }: { row: AiUsageRecord; zh: boolean; locale: string; multiDay: boolean; digits: MoneyDigits }) {
  const at = new Date(row.createdAt);
  const time = at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const date = at.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
  const hasTokens = row.inputTokens !== null || row.outputTokens !== null;
  const tone = statusTone(row.status);
  const breakdown = [
    `${zh ? '输入' : 'Input'} ${row.inputTokens === null ? '—' : count(row.inputTokens)}`,
    `${zh ? '输出' : 'Output'} ${row.outputTokens === null ? '—' : count(row.outputTokens)}`,
    `${zh ? '缓存读取' : 'Cache read'} ${row.cachedTokens === null ? '—' : count(row.cachedTokens)}`,
  ].join(' · ');
  return (
    <tr>
      <td>
        <strong>{multiDay ? `${date} ${time}` : time}</strong>
        <small title={row.projectName ?? row.projectId}>{projectLabel(row.projectId, row.projectName, zh)}</small>
      </td>
      <td>
        <strong title={row.model}>{row.model}</strong>
        <small title={row.sessionId ? `${providerLabel(row.provider)} · ${row.sessionId}` : undefined}>
          {providerLabel(row.provider)}
          {row.granularity === 'session' ? (zh ? ' · 会话汇总' : ' · session summary') : ''}
          {row.sessionId ? ` · ${zh ? '会话' : 'Session'} ${row.sessionId}` : ''}
        </small>
      </td>
      <td title={breakdown}>
        {hasTokens ? tokens((row.inputTokens ?? 0) + (row.outputTokens ?? 0)) : '—'}
        {row.cachedTokens ? <small>{zh ? '缓存' : 'Cache'} {tokens(row.cachedTokens)}</small> : null}
      </td>
      <td>
        {row.chargedUsd !== null ? money(row.chargedUsd, digits)
          : row.reportedUsd !== null ? <>{money(row.reportedUsd, digits)}<small>{zh ? '报告' : 'reported'}</small></>
          : row.estimatedUsd != null ? <>{money(row.estimatedUsd, digits)}<small>{zh ? '估算' : 'estimated'}</small></>
          : <>—<small>{zh ? '未提供' : 'n/a'}</small></>}
      </td>
      <td>
        <span className={styles.status} data-tone={tone}>{statusLabel(row.status, zh)}</span>
      </td>
    </tr>
  );
}

function Empty({ zh, filtered }: { zh: boolean; filtered: boolean }) {
  return (
    <p className={styles.empty}>
      {filtered ? (zh ? '没有符合条件的记录' : 'Nothing matches') : (zh ? '这个范围内没有记录' : 'Nothing in this range')}
    </p>
  );
}
