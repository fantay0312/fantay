// SPDX-License-Identifier: AGPL-3.0-only
// Shared work cards (spec §12): status glyph and word, task rows, the needs-you card, channel approval and delivery
// cards, the project result card and the dated completion log. Used by the transcript (U2), the inspector (U3), the
// 任务 page and the task modal (U4). Warm colour (--warning) is reserved for needs-you; failed reads --accent-ink.
import {
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  File,
  FileCode,
  FileCode2,
  FileImage,
  FileText,
  FolderOpen,
  Pause,
  Square,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { paOutboxAuthorizationMatches } from '@open-design/contracts';

import { useI18n, useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { navigate } from '../../router';
import { Button, Icon, IconButton, MetaLine, Spinner, cn, toast } from '../ui';
import { usePa } from './pa-context';
import { downloadPaArtifact } from './pa-api';
import {
  budgetUse,
  canResume,
  conversationTitle,
  effectiveWaitKind,
  expiresAt,
  formatBytes,
  formatDuration,
  formatTokens,
  needsReconcile,
  timeBudgetSpent,
  unavailableParticipant,
  unwrapStructured,
  usageSummary,
  waitInfo,
  workLine,
} from './pa-model';
import { usePaStopConfirm } from './PaConfirmHost';
import { PaDisclosure } from './PaDisclosure';
import { paPendingKey } from './usePaWorkspace';
import type {
  PaAttempt,
  PaChannel,
  PaChannelInbox,
  PaChannelOutbox,
  PaIndex,
  PaTask,
  PaWaitAction,
  TFn,
} from './pa-types';
import styles from './PaWorkCards.module.css';

/* ── shared helpers (also used by PaInspector) ─────────────────────────────────────────────── */

/** Translates a key built at runtime. Returns null when the key is unknown, so a raw key never renders. */
export function paTryT(t: TFn, key: string, vars?: Record<string, string | number>): string | null {
  const value = t(key as keyof Dict, vars);
  return value === key ? null : value;
}

export function paPlatformName(t: TFn, channel: PaChannel | null | undefined): string {
  if (!channel) return t('pa.channel');
  return channel.type === 'feishu' ? t('pa.channelName.feishu') : t('pa.channelName.weixin');
}

/** Same local calendar day. */
function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Whole local days between two instants (0 = same day). */
export function paDayDiff(at: number, now: number): number {
  const a = new Date(at);
  const b = new Date(now);
  const startA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const startB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((startB - startA) / 86400000);
}

export function paClock(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

/** 今天 / 昨天 / 11月8日 (Today / Yesterday / Nov 8). */
export function paDayLabel(at: number, now: number, locale: string, t: TFn): string {
  const diff = paDayDiff(at, now);
  if (diff === 0) return t('pa.log.today');
  if (diff === 1) return t('pa.log.yesterday');
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at);
}

/** A short date for meta lines: the clock today, else the month and day. */
export function paShortDate(at: number, now: number, locale: string): string {
  return paDayDiff(at, now) === 0
    ? paClock(at, locale)
    : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at);
}

function relativeTime(at: number, now: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (abs < 60) return format.format(0, 'second');
  if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86400), 'day');
}

function joinNames(names: string[], locale: string): string {
  return names.join(locale.startsWith('zh') ? '、' : ', ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attemptsOf(index: PaIndex, task: PaTask): PaAttempt[] {
  return index.attemptsByTask.get(task.id) ?? [];
}

/** A wait that ends on its own: Fantay is paused or the device sleeps. Read through `effectiveWaitKind`, because the
 *  daemon leaves a stale pause/sleep kind on the task after it resumes and later waits for something else. */
export function paAutoWait(task: PaTask): 'paused' | 'device' | null {
  const kind = effectiveWaitKind(task);
  return kind === 'paused' || kind === 'device' ? kind : null;
}

/** Statuses that can still be stopped (spec §15.3). */
export function paCanStop(task: PaTask): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'verifying' || task.status === 'waiting';
}

/** The first line of a reply, Markdown marks stripped; structured reviewer JSON gives its summary. */
function firstLine(content: string): string {
  const unwrapped = unwrapStructured(content);
  const text = unwrapped.kind === 'structured' ? unwrapped.summary : unwrapped.text;
  const line = text.split('\n').find((part) => part.trim().length > 0) ?? '';
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, '')
    .replace(/[*_`]+/g, '')
    .trim();
}

/* ── 12.1 status glyph and word ───────────────────────────────────────────────────────────── */

type GlyphKind = 'queued' | 'active' | 'needs' | 'paused' | 'completed' | 'failed' | 'cancelled';

function glyphKind(task: PaTask): GlyphKind {
  switch (task.status) {
    case 'queued':
      return 'queued';
    case 'running':
    case 'verifying':
    case 'cancelling':
      return 'active';
    case 'waiting':
      return paAutoWait(task) ? 'paused' : 'needs';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'cancelled';
  }
}

const GLYPH_ICON: Record<Exclude<GlyphKind, 'active'>, LucideIcon> = {
  queued: Circle,
  needs: CircleAlert,
  paused: Pause,
  completed: CircleCheck,
  failed: CircleX,
  cancelled: CircleSlash,
};

/** The last status any glyph showed per task, so a glyph that mounts in a new place (a row moving from 进行中 to
 *  完成记录 in the same commit) still knows the completion is live. */
const lastSeenStatus = new Map<string, PaTask['status']>();

function isLiveCompletion(task: PaTask): boolean {
  const previous = lastSeenStatus.get(task.id);
  return task.status === 'completed' && previous !== undefined && previous !== 'completed';
}

/** True while this glyph should play the completion pop: only on a live transition, never for history. */
function useCheckPop(task: PaTask): boolean {
  const [seen, setSeen] = useState(() => ({ status: task.status, pop: isLiveCompletion(task) }));
  if (seen.status !== task.status) setSeen({ status: task.status, pop: task.status === 'completed' });
  useEffect(() => {
    lastSeenStatus.set(task.id, task.status);
  }, [task.id, task.status]);
  return seen.pop && task.status === 'completed';
}

export function PaStatusGlyph({ task, size = 16 }: { task: PaTask; attempts: PaAttempt[]; size?: 14 | 16 }) {
  const pop = useCheckPop(task);
  const kind = glyphKind(task);
  return (
    <span
      className={styles.glyph}
      data-kind={kind}
      data-pop={pop ? 'true' : undefined}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {kind === 'active' ? <Spinner size="xs" /> : <Icon icon={GLYPH_ICON[kind]} size={size} />}
    </span>
  );
}

export type PaWordKey =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'waiting'
  | 'waitingAuto'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'stopUnconfirmed';

export function paWordKey(task: PaTask): PaWordKey {
  switch (task.status) {
    case 'waiting':
      return paAutoWait(task) ? 'waitingAuto' : 'waiting';
    case 'cancelling':
    case 'cancelled':
      return task.stopConfirmation === 'unknown' ? 'stopUnconfirmed' : task.status;
    default:
      return task.status;
  }
}

const WORD_KEY: Record<PaWordKey, keyof Dict> = {
  queued: 'pa.word.queued',
  running: 'pa.word.running',
  verifying: 'pa.word.verifying',
  waiting: 'pa.word.waiting',
  waitingAuto: 'pa.word.waitingAuto',
  completed: 'pa.word.completed',
  failed: 'pa.word.failed',
  cancelling: 'pa.word.cancelling',
  cancelled: 'pa.word.cancelled',
  stopUnconfirmed: 'pa.word.stopUnconfirmed',
};

export function PaStatusWord({ task }: { task: PaTask; attempts: PaAttempt[] }) {
  const t = useT();
  const key = paWordKey(task);
  return (
    <span className={styles.word} data-word={key}>
      {t(WORD_KEY[key])}
    </span>
  );
}

/* ── 12.5 task row ────────────────────────────────────────────────────────────────────────── */

export function PaTaskRow({
  task,
  density,
  showConversation = false,
  onOpen,
}: {
  task: PaTask;
  density: 'compact' | 'regular';
  showConversation?: boolean;
  onOpen(): void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { index, data, now } = usePa();
  const confirmStop = usePaStopConfirm();
  const attempts = attemptsOf(index, task);

  let caption: ReactNode;
  if (density === 'compact') {
    caption = compactCaption(task, index, data.control, attempts, now, t);
  } else {
    const use = budgetUse(task, attempts, now);
    const conversation = index.conversations.get(task.conversationId);
    const title = showConversation && conversation ? conversationTitle(index, conversation) : null;
    const names = task.participantIds.map((id) => index.agents.get(id)?.name).filter((name): name is string => !!name);
    // A direct chat is titled with its agent's name, so "Fantay · Fantay" would say one thing twice.
    const showNames = names.length > 0 && !(names.length === 1 && names[0] === title);
    caption = (
      <MetaLine className={styles.rowMeta}>
        {title !== null ? <span className={styles.metaPart}>{title}</span> : null}
        {showNames ? <span className={styles.metaPart}>{joinNames(names, locale)}</span> : null}
        {use.attempts > 0 ? (
          <span className={styles.tabular}>{t('pa.row.attempts', { used: use.attempts, max: use.maxAttempts ?? '—' })}</span>
        ) : null}
        <span className={styles.tabular}>{relativeTime(task.updatedAt, now, locale)}</span>
      </MetaLine>
    );
  }

  return (
    <div className={styles.taskRow} data-density={density}>
      <Button variant="bare" className={styles.taskRowMain} onClick={onOpen}>
        <span className={styles.taskRowGlyph}>
          <PaStatusGlyph task={task} attempts={attempts} size={16} />
        </span>
        <span className={styles.taskRowText}>
          <span className={styles.taskRowGoal}>{task.goal}</span>
          <span className={styles.taskRowCaption}>{caption}</span>
        </span>
      </Button>
      <div className={styles.swap}>
        <span className={styles.swapNow}>
          <PaStatusWord task={task} attempts={attempts} />
        </span>
        <span className={styles.swapGo}>
          {paCanStop(task) ? (
            <IconButton size="xs" variant="danger" aria-label={t('pa.stop')} onClick={() => confirmStop(task.id)}>
              <Icon icon={Square} size={12} />
            </IconButton>
          ) : null}
          <IconButton size="xs" aria-label={t('pa.act.details')} onClick={onOpen}>
            <Icon icon={ChevronRight} size={14} />
          </IconButton>
        </span>
      </div>
    </div>
  );
}

function compactCaption(
  task: PaTask,
  index: PaIndex,
  control: Parameters<typeof workLine>[2],
  attempts: PaAttempt[],
  now: number,
  t: TFn,
): string {
  const line = task.status === 'queued' || task.status === 'running' || task.status === 'verifying' || task.status === 'cancelling'
    ? workLine(task, index, control)
    : null;
  if (line?.kind === 'step') {
    const elapsed = formatDuration(Math.max(0, now - line.startedAt), t);
    return line.total > 1 ? `${t('pa.work.step', { step: line.step, total: line.total })} · ${elapsed}` : elapsed;
  }
  // The status word already says 排队中 / 正在停止; the caption adds the cause when there is one, else the time.
  if (line?.kind === 'queued' && line.reason === 'conversation') return t('pa.work.queuedConversation');
  if (line?.kind === 'queued' && line.reason === 'concurrency') return t('pa.work.queuedConcurrency', { max: line.max ?? '—' });
  if (line?.kind === 'stopping' && line.unknown) return t('pa.work.stopUnconfirmed');
  const autoWait = paAutoWait(task);
  if (autoWait === 'paused') return t('pa.wait.paused.title');
  if (autoWait === 'device') return t('pa.wait.device.title');
  const started = attempts.at(-1)?.startedAt ?? task.createdAt;
  return formatDuration(Math.max(0, now - started), t);
}

/* ── shared action wiring ─────────────────────────────────────────────────────────────────── */

const ACTION_LABEL: Record<PaWaitAction, keyof Dict> = {
  reconcile: 'pa.reconcile',
  resume: 'pa.resume',
  resumeFantay: 'pa.resumeAll',
  startAgain: 'pa.act.startAgain',
  stop: 'pa.stop',
  amend: 'pa.amend',
  continueReview: 'pa.act.continueReview',
  modelSettings: 'pa.act.modelSettings',
  openAgent: 'pa.act.openAgent',
};

/** Runs one PaWaitAction for a task. Resume-type actions return a promise (shown as a busy button). */
function useWaitActionRunner() {
  const { data, index, nav } = usePa();
  const confirmStop = usePaStopConfirm();
  return (action: PaWaitAction, task: PaTask): Promise<unknown> | void => {
    switch (action) {
      case 'reconcile':
        nav.openModal({ kind: 'reconcile', taskId: task.id });
        return;
      case 'resume':
      case 'continueReview':
        return data.actions.resumeTask(task.id);
      case 'resumeFantay':
        return data.actions.patchControl({ paused: false });
      case 'startAgain':
        // Fills the composer under a fresh request; never sends on its own (spec §15.3).
        nav.fillComposer(task.conversationId, {
          text: task.goal,
          localOnly: task.dataClass === 'local_only',
          completionCriterion: task.completionCriteria?.join('\n'),
          project: task.kind === 'project',
          projectName: task.projectName ?? '',
          replyTo: null,
          request: null,
        });
        return;
      case 'stop':
        confirmStop(task.id);
        return;
      case 'amend':
        nav.openModal({ kind: 'amend', taskId: task.id });
        return;
      case 'modelSettings':
        navigate({ kind: 'home', view: 'settings' });
        return;
      case 'openAgent': {
        // The participant that keeps the task from running: disabled, or missing a tool it needs.
        const target =
          unavailableParticipant(index.agents, task.participantIds, task.kind) ??
          task.participantIds.find((id) => index.agents.has(id));
        if (target) nav.openModal({ kind: 'agent', agentId: target });
        return;
      }
    }
  };
}

function pendingKey(action: PaWaitAction, taskId: string): string | null {
  if (action === 'resume' || action === 'continueReview') return paPendingKey.resume(taskId);
  if (action === 'resumeFantay') return paPendingKey.control();
  return null;
}

/* ── 12.2 needs-you card ──────────────────────────────────────────────────────────────────── */

interface NeedView {
  tone: 'warning' | 'failed';
  title: string;
  body: string | null;
  actions: PaWaitAction[];
}

function needView(task: PaTask, attempts: PaAttempt[], index: PaIndex, now: number, t: TFn): NeedView {
  const resumable = canResume(task, attempts);
  if (task.status === 'failed') {
    // A failed task whose last run cannot be confirmed as ended is checked first (SVC `reconcileTask`).
    const recover: PaWaitAction = resumable ? 'resume' : 'startAgain';
    return {
      tone: 'failed',
      title: t('pa.word.failed'),
      body: task.error,
      actions: needsReconcile(task, attempts) ? ['reconcile', recover] : [recover],
    };
  }
  const info = waitInfo(task, attempts, index);
  const reason = info.reasonText?.trim() || null;
  let title: string;
  let body: string | null;
  if (info.key === 'revoked') {
    title = reason ?? t('pa.wait.other.title');
    body = null;
  } else {
    title = paTryT(t, `pa.wait.${info.key}.title`) ?? reason ?? t('pa.wait.other.title');
    if (info.key === 'review') {
      const cut = reason?.startsWith('审阅发现') ? reason.indexOf('：') : -1;
      body = cut >= 0 ? reason!.slice(cut + 1).trim() || null : reason;
    } else if (info.key === 'budget') {
      const use = budgetUse(task, attempts, now);
      body = timeBudgetSpent(task, attempts)
        ? t('pa.wait.budget.timeBody')
        : use.maxAttempts !== null
          ? t('pa.wait.budget.body', { used: use.attempts, max: use.maxAttempts })
          : reason;
    } else {
      body = paTryT(t, `pa.wait.${info.key}.body`) ?? reason;
    }
  }
  if (body === title) body = null;
  // Resume is never offered where the daemon would refuse it (spec §15.3).
  const actions: PaWaitAction[] = [];
  for (const action of info.actions) {
    const next = !resumable && (action === 'resume' || action === 'continueReview') ? 'startAgain' : action;
    if (!actions.includes(next)) actions.push(next);
  }
  return { tone: 'warning', title, body, actions };
}

export function PaNeedsYouCard({
  task,
  compact = false,
  showConversation = false,
  capped = false,
}: {
  task: PaTask;
  compact?: boolean;
  showConversation?: boolean;
  /** Keep to the result card's 560 px measure (the transcript), instead of filling a wide column. */
  capped?: boolean;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { index, data, nav, ui, now } = usePa();
  const run = useWaitActionRunner();
  const [busy, setBusy] = useState<PaWaitAction | null>(null);
  const attempts = attemptsOf(index, task);
  const view = needView(task, attempts, index, now, t);
  const inOwnModal = isTaskModalOpen(ui.modal, task.id);
  const expiry = task.status === 'waiting' ? expiresAt(task, data.control) : null;
  const conversation = showConversation ? index.conversations.get(task.conversationId) : undefined;
  const shown = compact ? view.actions.slice(0, 1) : view.actions;

  const click = (action: PaWaitAction) => {
    const result = run(action, task);
    if (!result) return;
    setBusy(action);
    void result
      .catch((error: unknown) => toast({ tone: 'danger', title: errorMessage(error) }))
      .finally(() => setBusy((current) => (current === action ? null : current)));
  };

  return (
    <div
      className={styles.warmCard}
      data-testid="pa-needs-card"
      data-compact={compact ? 'true' : undefined}
      data-capped={capped ? 'true' : undefined}
      data-tone={view.tone}
    >
      <div className={styles.needsTitle}>{view.title}</div>
      {/* Inside the task's own modal the goal is already the modal title. */}
      {inOwnModal ? null : <div className={styles.needsGoal}>{task.goal}</div>}
      {view.body ? <div className={styles.needsBody}>{view.body}</div> : null}
      {conversation || expiry !== null ? (
        // Where it lives and when it lapses: two quiet lines kept together under the body.
        <div className={styles.needsFoot}>
          {conversation ? <MetaLine className={styles.needsMeta}>{conversationTitle(index, conversation)}</MetaLine> : null}
          {expiry !== null ? (
            <div className={styles.needsExpiry}>{t('pa.wait.expires', { time: expiryLabel(expiry, now, locale) })}</div>
          ) : null}
        </div>
      ) : null}
      <div className={styles.cardActions} data-card-actions="">
        {shown.map((action, position) => {
          const key = pendingKey(action, task.id);
          return (
            <Button
              key={action}
              size="sm"
              // One ink pill, then outlined pills: the row keeps one shape (Button `default` is a square-cornered
              // ring, which reads as a different control beside the pill primary).
              variant={position === 0 ? 'primary' : 'secondary'}
              loading={busy === action || (key !== null && data.pending.has(key))}
              onClick={() => click(action)}
            >
              {t(ACTION_LABEL[action])}
            </Button>
          );
        })}
        {inOwnModal ? null : (
          <Button size="sm" variant="link" className={styles.detailsLink} onClick={() => nav.openModal({ kind: 'task', taskId: task.id })}>
            {t('pa.act.details')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The card is rendered inside this task's own detail modal, so a 详情 link would only reopen it. */
function isTaskModalOpen(modal: ReturnType<typeof usePa>['ui']['modal'], taskId: string): boolean {
  return modal?.kind === 'task' && modal.taskId === taskId;
}

/** The lapse time, with no-break spaces so "Nov 11 02:03" never splits across lines. */
function expiryLabel(at: number, now: number, locale: string): string {
  const clock = paClock(at, locale);
  if (paDayDiff(at, now) === 0) return clock;
  return `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(at)} ${clock}`.replace(/\s/g, ' ');
}

/* ── 12.3 approval and delivery ───────────────────────────────────────────────────────────── */

export function PaApprovalCard({ inbox }: { inbox: PaChannelInbox }) {
  const t = useT();
  const { index, data } = usePa();
  const channel = index.channels.get(inbox.channelId) ?? null;
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  // Held locally until the row leaves the snapshot (the parent stops rendering it).
  const [answered, setAnswered] = useState<'approved' | 'declined' | null>(null);

  const answer = (approved: boolean) => {
    if (busy || answered) return;
    setBusy(approved ? 'approve' : 'decline');
    void data.actions
      .answerApproval(inbox, approved)
      .then(() => setAnswered(approved ? 'approved' : 'declined'))
      .catch((error: unknown) => toast({ tone: 'danger', title: errorMessage(error) }))
      .finally(() => setBusy(null));
  };

  return (
    <div className={styles.warmCard} data-answered={answered ? 'true' : undefined}>
      <div className={styles.needsTitle}>
        {t('pa.approval.title', { platform: paPlatformName(t, channel), channel: channel?.name ?? '—' })}
      </div>
      <div className={styles.cardFaint}>{t('pa.approval.from', { sender: inbox.senderId })}</div>
      {inbox.preview ? <blockquote className={styles.quote}>{inbox.preview}</blockquote> : null}
      <div className={styles.cardFaint}>{t('pa.approval.valid')}</div>
      {answered ? (
        <div className={styles.answered} role="status">
          <Icon icon={Check} size={14} />
          {answered === 'approved' ? t('pa.approval.approved') : t('pa.approval.declined')}
        </div>
      ) : (
        <div className={styles.cardActions} data-card-actions="">
          <Button size="sm" variant="primary" loading={busy === 'approve'} disabled={busy === 'decline'} onClick={() => answer(true)}>
            {t('pa.approval.approve')}
          </Button>
          <Button size="sm" variant="secondary" loading={busy === 'decline'} disabled={busy === 'approve'} onClick={() => answer(false)}>
            {t('pa.approval.decline')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PaDeliveryCard({ outbox }: { outbox: PaChannelOutbox }) {
  const t = useT();
  const { index, data } = usePa();
  const channel = index.channels.get(outbox.channelId) ?? null;
  const [busy, setBusy] = useState<'query' | 'delivered' | 'retry' | null>(null);

  const sameAuthorization = paOutboxAuthorizationMatches(outbox, channel);
  const canQuery = sameAuthorization && channel?.type === 'feishu' && !!outbox.providerMessageId;
  const retryBlocked = !sameAuthorization || !channel?.enabled;

  const resolve = (action: 'query' | 'delivered' | 'retry') => {
    if (busy) return;
    setBusy(action);
    void data.actions
      .resolveOutbox(outbox, action)
      .catch((error: unknown) => toast({ tone: 'danger', title: errorMessage(error) }))
      .finally(() => setBusy(null));
  };

  const buttons: Array<{ action: 'query' | 'delivered' | 'retry'; label: string; blocked?: boolean }> = [
    ...(canQuery ? [{ action: 'query' as const, label: t('pa.delivery.query') }] : []),
    { action: 'delivered', label: t('pa.delivery.delivered') },
    { action: 'retry', label: t('pa.delivery.retry'), blocked: retryBlocked },
  ];

  return (
    <div className={styles.warmCard}>
      <div className={styles.needsTitle}>{outbox.state === 'failed' ? t('pa.delivery.failedTitle') : t('pa.delivery.title')}</div>
      <MetaLine className={styles.needsMeta}>
        <span>{paPlatformName(t, channel)}</span>
        {channel ? <span className={styles.metaPart}>{channel.name}</span> : null}
      </MetaLine>
      {outbox.preview ? <div className={styles.deliveryPreview}>{outbox.preview}</div> : null}
      {outbox.error ? <div className={styles.cardError}>{outbox.error}</div> : null}
      <div className={styles.needsBody}>{t('pa.deliveryHelp')}</div>
      <div className={styles.cardActions} data-card-actions="">
        {buttons.map((button, position) => (
          <Button
            key={button.action}
            size="sm"
            variant={position === 0 ? 'primary' : 'secondary'}
            loading={busy === button.action}
            disabled={button.blocked || (busy !== null && busy !== button.action)}
            disabledReason={button.blocked ? t('pa.delivery.retryBlocked') : undefined}
            onClick={() => resolve(button.action)}
          >
            {button.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/* ── 12.4 result card ─────────────────────────────────────────────────────────────────────── */

const FILE_ICON: Record<string, LucideIcon> = {
  html: FileCode,
  htm: FileCode,
  md: FileText,
  txt: FileText,
  css: FileCode2,
  js: FileCode2,
  json: FileCode2,
  svg: FileImage,
};

function fileIcon(path: string): LucideIcon {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return FILE_ICON[ext] ?? File;
}

const MAX_FILES = 4;

export function PaResultCard({ task }: { task: PaTask }) {
  const t = useT();
  const { index, data, projects, onOpenProject, nav, ui, now } = usePa();
  const attempts = attemptsOf(index, task);
  const inOwnModal = isTaskModalOpen(ui.modal, task.id);
  const artifacts =[...(index.artifactsByTask.get(task.id) ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  const projectName =
    task.projectName?.trim() || projects.find((project) => project.id === task.projectId)?.name || task.goal.slice(0, 40);
  const checks = Array.from(new Set(artifacts.flatMap((artifact) => artifact.verification)));
  const lastArtifact = artifacts.at(-1);
  const usage = usageSummary(attempts);
  const tokens = usage.unknown
    ? paTryT(t, 'pa.receipt.usageUnknown') ?? t('pa.unknownUsage')
    : paTryT(t, 'pa.receipt.tokens', { count: formatTokens(usage.inputTokens + usage.outputTokens) }) ??
      formatTokens(usage.inputTokens + usage.outputTokens);
  const duration = formatDuration(budgetUse(task, attempts, now).usedMs, t);
  const projectId = task.projectId;

  return (
    <div className={styles.resultCard} data-testid="pa-result-card">
      <div className={styles.resultHeader}>
        <span className={styles.resultTile} aria-hidden>
          <Icon icon={FolderOpen} size={16} />
        </span>
        <span className={styles.resultTitle}>{t('pa.result.title', { name: projectName })}</span>
        {checks.length ? (
          <span className={styles.verified}>
            <Icon icon={Check} size={12} />
            <span className={styles.verifiedText}>{t('pa.result.verified', { checks: checks.join(' · ') })}</span>
          </span>
        ) : (
          <span />
        )}
      </div>
      {task.evidence.length ? (
        <ul className={styles.checklist}>
          {task.evidence.map((line, position) => (
            <li key={`${position}-${line}`} className={styles.checkItem}>
              <Icon icon={Check} size={12} className={styles.checkMark} />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {artifacts.length ? (
        <div className={styles.files}>
          {artifacts.slice(0, MAX_FILES).map((artifact) => {
            const name = artifact.path.split('/').pop() ?? artifact.path;
            return (
              <Button
                key={artifact.id}
                variant="bare"
                className={styles.fileRow}
                onClick={() => artifact.privateStorage || artifact.dataClass === 'local_only'
                  ? void downloadPaArtifact(artifact.id, name).catch(error => toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) }))
                  : onOpenProject(artifact.projectId, artifact.path)}
              >
                <Icon icon={fileIcon(artifact.path)} size={16} className={styles.fileIcon} />
                <span className={styles.fileText}>
                  <span className={styles.fileName}>{name}</span>
                  <span className={styles.filePath}>{artifact.path}</span>
                </span>
                <span className={styles.fileSize}>{formatBytes(artifact.bytes)}</span>
                <span className={styles.fileHash}>{artifact.sha256.slice(0, 8)}</span>
              </Button>
            );
          })}
          {artifacts.length > MAX_FILES ? (
            <div className={styles.moreFiles}>{t('pa.result.moreFiles', { count: artifacts.length - MAX_FILES })}</div>
          ) : null}
        </div>
      ) : null}
      <div className={styles.resultFooter}>
        <MetaLine className={styles.resultMeta}>
          {t('pa.result.footer', { attempts: attempts.length, duration, tokens })}
        </MetaLine>
        {inOwnModal ? null : (
          <Button size="sm" variant="link" className={styles.detailsLink} onClick={() => nav.openModal({ kind: 'task', taskId: task.id })}>
            {t('pa.act.details')}
          </Button>
        )}
        {projectId && task.dataClass !== 'local_only' && data.snapshot?.mode !== 'enterprise' ? (
          <Button size="sm" variant="primary" onClick={() => onOpenProject(projectId, lastArtifact?.path)}>
            {t('pa.openProject')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ── 12.5 day log ─────────────────────────────────────────────────────────────────────────── */

function taskSummary(index: PaIndex, task: PaTask): string | null {
  if (task.evidence.length) return task.evidence[0] ?? null;
  const replies = (index.messagesByConversation.get(task.conversationId) ?? []).filter(
    (message) => message.taskId === task.id && message.senderId !== 'owner',
  );
  const last = replies.at(-1);
  if (last) {
    const line = firstLine(last.content);
    if (line) return line;
  }
  return task.error;
}

export function PaDayLog({
  tasks,
  openDays = 2,
  bleed = false,
  onOpenTask,
}: {
  tasks: PaTask[];
  openDays?: number;
  /** Hover fills reach 6 px past the column while labels, tiles and times stay on it (the inspector's task rows
   *  bleed the same way, so every row in a pane shares one hover edge). */
  bleed?: boolean;
  onOpenTask(taskId: string): void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const { index, now } = usePa();

  const groups: Array<{ key: string; at: number; tasks: PaTask[] }> = [];
  for (const task of [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = dayKey(task.updatedAt);
    const group = groups.at(-1);
    if (group && group.key === key) group.tasks.push(task);
    else groups.push({ key, at: task.updatedAt, tasks: [task] });
  }

  return (
    <div className={styles.dayLog} data-bleed={bleed ? 'true' : undefined}>
      {groups.map((group) => (
        <PaDisclosure
          key={group.key}
          label={paDayLabel(group.at, now, locale, t)}
          count={group.tasks.length}
          defaultOpen={paDayDiff(group.at, now) < openDays}
        >
          <div className={styles.dayRows}>
            {group.tasks.map((task) => {
              const summary = taskSummary(index, task);
              return (
                <Button key={task.id} variant="bare" className={styles.dayRow} onClick={() => onOpenTask(task.id)}>
                  <span className={styles.dayTile}>
                    <PaStatusGlyph task={task} attempts={attemptsOf(index, task)} size={14} />
                  </span>
                  <span className={styles.dayText}>
                    <span className={styles.dayGoal}>{task.goal}</span>
                    {summary ? (
                      <span className={cn(styles.daySummary, task.status === 'failed' && !task.evidence.length && styles.dayFailed)}>
                        {summary}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.dayTime}>{paClock(task.updatedAt, locale)}</span>
                </Button>
              );
            })}
          </div>
        </PaDisclosure>
      ))}
    </div>
  );
}
