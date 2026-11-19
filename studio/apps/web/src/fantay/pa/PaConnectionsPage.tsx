// SPDX-License-Identifier: AGPL-3.0-only
// 连接 page (spec §13): needs-you callout, 本机 (status, background, lifecycle, limits, capabilities),
// channels, models, the reserved cloud row and recent channel events. Also exports the channel status
// and history pieces the channel modal reuses.
import { useId, useState, type ReactNode } from 'react';
import { useI18n, useT } from '../../i18n';
import { paManageEn } from '../../i18n/pa-ui/manage';
import { navigate } from '../../router';
import { Button, Callout, ChevronRightIcon, Dot, PlusIcon, StatusLabel, Switch, cn, toast } from '../ui';
import { usePa } from './pa-context';
import { modelKeyOf, paErrorText } from './PaAgentModal';
import { PaDisclosure } from './PaDisclosure';
import type { PaChannel, PaChannelInbox, PaIndex, TFn } from './pa-types';
import styles from './PaConnectionsPage.module.css';

/* ── shared channel helpers (also used by PaChannelModal) ──────────────────────────────── */

const STATUS_KEY = {
  connected: 'pa.connected',
  connecting: 'pa.connecting',
  disconnected: 'pa.disconnected',
  login_required: 'pa.login_required',
  error: 'pa.channelError',
  // `pa.paused` reads "Fantay is paused"; a channel row needs the bare state word.
  paused: 'pa.conn.channelPaused',
} as const satisfies Record<PaChannel['status'], string>;

export function channelStatusWord(status: PaChannel['status'], t: TFn): string {
  return t(STATUS_KEY[status]);
}

/** The status word with a dot that stays visible in both themes: green when connected, the failure ink for
 *  an error, faint ink otherwise (the primitive's muted dot is the hairline colour and disappears in dark). */
export function ChannelStatusLabel({ status, className }: { status: PaChannel['status']; className?: string }) {
  const t = useT();
  return (
    <StatusLabel tone={status === 'connected' ? 'done' : 'muted'} data-status={status} className={cn(styles.status, className)}>
      {channelStatusWord(status, t)}
    </StatusLabel>
  );
}

export function platformName(type: string | undefined, t: TFn): string {
  switch (type) {
    case 'feishu': return t('pa.feishu');
    case 'weixin': return t('pa.weixin');
    case 'dingtalk': return t('pa.channel.dingtalk');
    case 'wecom': return t('pa.channel.wecom');
    case 'qq': return 'QQ';
    case 'telegram': return 'Telegram';
    case 'discord': return 'Discord';
    case 'slack': return 'Slack';
    default: return '';
  }
}

/** The routed agent or group by name, never an id. */
export function channelTargetName(channel: Pick<PaChannel, 'targetKind' | 'targetId'>, index: PaIndex): string {
  const target = channel.targetKind === 'group' ? index.groups.get(channel.targetId) : index.agents.get(channel.targetId);
  return target?.name ?? '—';
}

/** Today: `14:05`; this year: `11月8日 14:05`; older: with the year. */
export function formatStamp(at: number, locale: string, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
  if (date.toDateString() === today.toDateString()) return new Intl.DateTimeFormat(locale, time).format(date);
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    ...time,
  }).format(date);
}

const INBOX_STATE_KEY = {
  pending: 'pa.pending',
  accepted: 'pa.accepted',
  approval: 'pa.approval',
  ignored: 'pa.ignored',
  failed: 'pa.failed',
} as const satisfies Record<PaChannelInbox['state'], string>;

/** The latest 20 inbox rows (newest first), optionally for one channel. */
export function recentInbox(inbox: readonly PaChannelInbox[], channelId?: string): PaChannelInbox[] {
  return inbox
    .filter((item) => !channelId || item.channelId === channelId)
    .slice()
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 20);
}

const DAY_MS = 86_400_000;

/** `今天` / `昨天` / `11月9日 周日` (with the year when it is not this year). */
function dayLabel(at: number, locale: string, now: number, t: TFn): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return t('pa.conn.today');
  if (date.toDateString() === new Date(now - DAY_MS).toDateString()) return t('pa.conn.yesterday');
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(date);
}

const clockOf = (at: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));

/** Recent inbox rows as a day-grouped log: a day caption, then one line per event —
 *  `HH:MM  channel  state  preview … 详情` — with every column aligned across days (one subgrid). */
export function PaChannelHistory({ rows, showChannel }: { rows: readonly PaChannelInbox[]; showChannel: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, nav, now } = usePa();
  if (!rows.length) {
    return (
      <div className={cn(styles.historyGroup, styles.historyGroupEmpty)}>
        <p className={styles.historyEmpty}>{t('pa.channel.historyEmpty')}</p>
      </div>
    );
  }
  const days: Array<{ key: string; label: string; rows: PaChannelInbox[] }> = [];
  for (const item of rows) {
    const key = new Date(item.receivedAt).toDateString();
    const last = days[days.length - 1];
    if (last && last.key === key) last.rows.push(item);
    else days.push({ key, label: dayLabel(item.receivedAt, locale, now, t), rows: [item] });
  }
  return (
    <div className={cn(styles.historyGroup, showChannel && styles.historyWithChannel)}>
      {days.map((day) => (
        <div key={day.key} className={styles.historyDay}>
          <div className={styles.historyDayLabel}>{day.label}</div>
          {day.rows.map((item) => {
            const channel = index.channels.get(item.channelId);
            const text = item.error ?? item.preview;
            return (
              <div key={item.id} className={styles.historyRow}>
                <span className={styles.historyTime}>{clockOf(item.receivedAt, locale)}</span>
                {showChannel ? (
                  <span className={styles.historyChannel} title={channel?.name}>
                    {channel?.name ?? '—'}
                  </span>
                ) : null}
                <span className={styles.historyState} data-state={item.state}>
                  {t(INBOX_STATE_KEY[item.state])}
                </span>
                <span className={item.error ? styles.historyError : styles.historyText} title={text}>
                  {text}
                </span>
                <span className={styles.historyEnd}>
                  {item.taskId ? (
                    <Button
                      variant="link"
                      size="sm"
                      className={styles.historyLink}
                      onClick={() => nav.openModal({ kind: 'task', taskId: item.taskId! })}
                    >
                      {t('pa.act.details')}
                    </Button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The 最近渠道事件 disclosure: its trigger reads as a section heading (the page) or a modal section title. */
export function PaHistoryDisclosure({ rows, showChannel, variant }: { rows: readonly PaChannelInbox[]; showChannel: boolean; variant: 'page' | 'modal' }) {
  const t = useT();
  return (
    <PaDisclosure
      className={cn(styles.historyDisclosure, variant === 'page' && styles.historyDisclosurePage)}
      label={
        <span className={styles.historyTrigger}>
          {t('pa.history')}
          <span className={styles.historyCount}>{rows.length}</span>
        </span>
      }
    >
      <PaChannelHistory rows={rows} showChannel={showChannel} />
    </PaDisclosure>
  );
}

/* ── page ──────────────────────────────────────────────────────────────────────────────── */

function capabilityLabel(id: string, t: TFn): string {
  const key = `pa.conn.cap.${id}`;
  return key in paManageEn ? t(key as keyof typeof paManageEn) : id;
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PaConnectionsPage() {
  const t = useT();
  const { locale } = useI18n();
  const { data, index, nav, now } = usePa();
  const [busy, setBusy] = useState<string | null>(null);
  const backgroundId = useId();
  const control = data.control;
  const node = data.snapshot?.node ?? null;
  const channels = [...index.channels.values()];
  const needsCount = index.needs.filter((need) => need.kind === 'approval' || need.kind === 'delivery').length;
  const history = recentInbox(index.inbox);
  const stamp = (at: number | null) => (at ? formatStamp(at, locale, now) : '—');

  const act = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try {
      await work();
    } catch (caught) {
      toast({ tone: 'danger', title: paErrorText(caught, t) });
    } finally {
      setBusy(null);
    }
  };

  const running = !!control && !control.paused && !control.suspended;
  const statusWord = !control ? '—' : control.paused ? t('pa.paused') : control.suspended ? t('pa.suspended') : t('pa.conn.running');

  return (
    <div className={styles.page} data-testid="pa-connections">
      <div className={styles.inner}>
        <header className={styles.head}>
          <h2 className={styles.title}>{t('pa.connections')}</h2>
          <Button variant="brand" className="fx-page-action" onClick={() => nav.openModal({ kind: 'channel', channelId: null })}>
            <PlusIcon size="sm" />
            {t('pa.addChannel')}
          </Button>
        </header>

        {needsCount > 0 ? (
          <Callout tone="neutral" className={styles.needs}>
            <span className={styles.needsDot} aria-hidden />
            <span className={styles.needsText}>{t('pa.conn.needs', { count: needsCount })}</span>
            <Button variant="link" size="sm" className={styles.needsGo} onClick={() => nav.openPlace('tasks', { tasksFilter: 'needs' })}>
              {t('pa.conn.go')}
              <ChevronRightIcon size="xs" />
            </Button>
          </Callout>
        ) : null}

        <Section title={t('pa.conn.device')}>
          <div className={styles.group}>
            <div className={styles.row}>
              <div className={styles.rowText}>
                <StatusLabel tone={running ? 'done' : 'muted'} className={cn(styles.status, styles.statusLabel)}>
                  {statusWord}
                </StatusLabel>
                <div className={styles.rowHint}>
                  {!control
                    ? t('pa.error')
                    : control.lastResumeAt
                      ? t('pa.conn.statusLine', {
                          active: control.activeCount,
                          pending: control.pendingCount,
                          resumed: stamp(control.lastResumeAt),
                        })
                      : t('pa.conn.statusLineFresh', { active: control.activeCount, pending: control.pendingCount })}
                </div>
              </div>
              <div className={styles.rowControl}>
                <Button
                  size="sm"
                  variant="default"
                  disabled={!control}
                  loading={busy === 'pause'}
                  onClick={() => control && void act('pause', () => data.actions.patchControl({ paused: !control.paused }))}
                >
                  {control?.paused ? t('pa.resumeAll') : t('pa.pauseAll')}
                </Button>
              </div>
            </div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div id={backgroundId} className={styles.rowLabel}>
                  {t('pa.background')}
                </div>
                <div className={styles.rowHint}>{t('pa.backgroundHelp')}</div>
              </div>
              <div className={styles.rowControl}>
                <Switch
                  size="md"
                  aria-labelledby={backgroundId}
                  checked={!!control?.backgroundEnabled}
                  disabled={!control || busy === 'background'}
                  onCheckedChange={(checked) => void act('background', () => data.actions.patchControl({ backgroundEnabled: checked }))}
                />
              </div>
            </div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>{t('pa.conn.lifecycleTitle')}</div>
                <div className={styles.rowHint}>{t('pa.conn.lifecycle')}</div>
              </div>
            </div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>{t('pa.limitsForm.title')}</div>
                <div className={styles.rowHint}>
                  {control
                    ? t('pa.limitsForm.summary', {
                        c: control.maxConcurrent,
                        a: control.defaultMaxAttempts,
                        m: Math.max(1, Math.round(control.defaultTimeoutMs / 60_000)),
                        h: Math.max(1, Math.round(control.waitingExpiryMs / 3_600_000)),
                      })
                    : '—'}
                </div>
              </div>
              <div className={styles.rowControl}>
                <Button size="sm" variant="default" disabled={!control} onClick={() => nav.openModal({ kind: 'limits' })}>
                  {t('pa.conn.adjust')}
                </Button>
              </div>
            </div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>{t('pa.conn.capabilities')}</div>
                <div className={styles.rowHint}>
                  {node?.capabilities.length ? node.capabilities.map((id) => capabilityLabel(id, t)).join(' · ') : '—'}
                </div>
              </div>
            </div>
          </div>
        </Section>

        <Section title={t('pa.conn.channels')}>
          <div className={styles.group}>
            {channels.length ? (
              channels.map((channel) => {
                const pending = index.inbox.filter((item) => item.channelId === channel.id && item.state === 'approval' && item.approvalActionable !== false).length;
                const io =
                  channel.lastReceivedAt || channel.lastSentAt
                    ? t('pa.conn.lastIO', { in: stamp(channel.lastReceivedAt), out: stamp(channel.lastSentAt) })
                    : t('pa.notVerified');
                return (
                  <Button
                    key={channel.id}
                    variant="bare"
                    className={styles.channelRow}
                    onClick={() => nav.openModal({ kind: 'channel', channelId: channel.id })}
                  >
                    <span className={styles.tile} aria-hidden>
                      {platformName(channel.type, t).slice(0, 1)}
                    </span>
                    <span className={styles.channelText}>
                      <span className={styles.channelName}>{channel.name}</span>
                      <span className={styles.channelCaption}>
                        {t('pa.conn.routeTo', { name: channelTargetName(channel, index) })} · {io}
                      </span>
                      {channel.lastError ? (
                        <span className={styles.channelError} title={channel.lastError}>
                          {channel.lastError}
                        </span>
                      ) : null}
                    </span>
                    <span className={styles.channelTrail}>
                      {pending ? <span className={styles.needsChip}>{t('pa.conn.pendingChip', { count: pending })}</span> : null}
                      <ChannelStatusLabel status={channel.status} />
                      <ChevronRightIcon size="sm" className={styles.rowChevron} aria-hidden />
                    </span>
                  </Button>
                );
              })
            ) : (
              <div className={styles.row}>
                <div className={styles.rowText}>
                  <div className={styles.rowNote}>{t('pa.noChannels')}</div>
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section
          title={t('pa.conn.models')}
          action={
            <Button variant="link" size="sm" onClick={() => navigate({ kind: 'home', view: 'settings' })}>
              {t('pa.conn.openModelSettings')}
            </Button>
          }
        >
          <div className={styles.group}>
            {data.models.length ? (
              data.models.map((model) => (
                <div key={modelKeyOf(model)} className={styles.row}>
                  {/* The dot sits on the label line; a detail lines up under the label, not under the dot. */}
                  <div className={styles.rowText}>
                    <div className={styles.modelLine}>
                      <Dot tone={model.available ? 'done' : 'muted'} size="md" className={styles.modelDot} />
                      <span className={styles.rowLabel}>{model.label}</span>
                      <span className={styles.mono}>{modelKeyOf(model)}</span>
                    </div>
                    {model.detail ? <div className={cn(styles.rowHint, styles.modelDetail)}>{model.detail}</div> : null}
                  </div>
                </div>
              ))
            ) : (
              <div className={styles.row}>
                <div className={styles.rowText}>
                  <div className={styles.rowNote}>{t('pa.noModels')}</div>
                </div>
              </div>
            )}
          </div>
          <p className={styles.under}>{t('pa.modelsHint')}</p>
        </Section>

        <Section title={t('pa.conn.cloud')}>
          <div className={styles.group}>
            <div className={styles.row} aria-disabled="true">
              <div className={styles.rowText}>
                <div className={styles.rowLabelMuted}>{t('pa.conn.cloudRow')}</div>
                <div className={styles.rowHint}>{t('pa.reserved')}</div>
              </div>
            </div>
          </div>
        </Section>

        <PaHistoryDisclosure rows={history} showChannel variant="page" />
      </div>
    </div>
  );
}
