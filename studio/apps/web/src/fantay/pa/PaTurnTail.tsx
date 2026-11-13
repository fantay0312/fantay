// SPDX-License-Identifier: AGPL-3.0-only
// The one tail a task turn ends with (spec §6.4): a working line, a muted pause line, the needs-you card, a failure
// line, a cancelled caption, the project result card or the receipt, plus the channel delivery line. The working
// line's glyph is the transcript's live-mascot slot (spec §5.4): live only while Fantay's attempt runs.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Info, Pause, X } from 'lucide-react';

import { useDwell } from '../../components/chat/useDwell';
import { ChatRoot } from '../../components/chat/ChatRoot';
import { SwapLabel } from '../../components/chat/SwapLabel';
import { usePresence } from '../../hooks/usePresence';
import { useI18n, useT } from '../../i18n';
import { FantayMascot, FantayMascotStill } from '../brand/FantayMascot';
import { Button, FxLegacy, Icon, Tooltip, cn, toast } from '../ui';
import { PaAvatar } from './PaAvatar';
import { usePaStopConfirm } from './PaConfirmHost';
import { PaNeedsYouCard, PaResultCard, paAutoWait } from './PaWorkCards';
import { usePa } from './pa-context';
import { paPendingKey } from './usePaWorkspace';
import {
  budgetUse,
  canResume,
  formatDuration,
  formatTokens,
  isFantay,
  needsReconcile,
  usageSummary,
  workLine,
} from './pa-model';
import type { PaAttempt, PaConversation, PaIndex, PaTask, PaTurn, PaWorkLine, TFn } from './pa-types';
import styles from './PaConversation.module.css';

const PHASE_KEY = { respond: 'pa.work.respond', produce: 'pa.work.produce', review: 'pa.work.review' } as const;

export type PaTailKind = 'working' | 'muted' | 'needs' | 'failed' | 'cancelled' | 'result' | 'receipt';

const ACTIVE = new Set<PaTask['status']>(['queued', 'running', 'verifying', 'cancelling']);
const STOPPABLE = new Set<PaTask['status']>(['queued', 'running', 'verifying', 'waiting']);
/** How long the receipt keeps the live mascot after Fantay finishes: the pulse's gust settles in ~2.4 s, so the
 *  swap to the still lands on the rest pose instead of cutting a lift in half. */
const RECEIPT_LIVE_MS = 2600;

export function tailKindOf(task: PaTask): PaTailKind {
  if (ACTIVE.has(task.status)) return 'working';
  if (task.status === 'waiting') return paAutoWait(task) ? 'muted' : 'needs';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'cancelled') return 'cancelled';
  return task.kind === 'project' ? 'result' : 'receipt';
}

export function agentName(index: PaIndex, attempts: PaAttempt[], id: string | null | undefined): string {
  if (!id) return '';
  return index.agents.get(id)?.name ?? attempts.find((a) => a.agentSnapshot.id === id)?.agentSnapshot.name ?? '';
}

/** The connection kind, as the header subline names it ("飞书机器人", "个人微信"). */
export function platformLabel(t: ReturnType<typeof useT>, type: string | undefined): string {
  return type === 'weixin' ? t('pa.weixin') : type === 'feishu' ? t('pa.feishu') : '';
}

/** The platform itself ("飞书", "微信"), for sentences such as "不会发回飞书" or "已回复到飞书", where the
 *  connection-kind label would read "发回飞书机器人". */
export function platformName(t: ReturnType<typeof useT>, type: string | undefined): string {
  return type === 'weixin' ? t('pa.roster.weixin') : type === 'feishu' ? t('pa.roster.feishu') : '';
}

export function errorToast(error: unknown) {
  toast({ tone: 'danger', title: error instanceof Error ? error.message : String(error) });
}

/** m:ss (or h:mm:ss), written into a text node once a second without re-rendering React. */
function Elapsed({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const write = () => {
      const node = ref.current;
      if (!node) return;
      const total = Math.max(0, Math.floor((Date.now() - since) / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = String(total % 60).padStart(2, '0');
      node.textContent = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
    };
    write();
    const timer = setInterval(write, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={ref} className={styles.elapsed} aria-hidden />;
}

function workLabel(t: TFn, index: PaIndex, task: PaTask, attempts: PaAttempt[], line: PaWorkLine): string {
  if (line.kind === 'stopping') return line.unknown ? t('pa.work.stopUnconfirmed') : t('pa.work.stopping');
  if (line.kind === 'queued') {
    if (line.reason === 'conversation') return t('pa.work.queuedConversation');
    if (line.reason === 'concurrency' && line.max != null) return t('pa.work.queuedConcurrency', { max: line.max });
    return t('pa.work.queued');
  }
  const parts = [t(PHASE_KEY[line.phase], { name: agentName(index, attempts, line.agentId) })];
  // One-step work (every direct chat) would read "step 1 of 1"; the counter only appears when there is a sequence.
  if (line.total > 1) parts.push(t('pa.work.step', { step: line.step, total: line.total }));
  if (line.nextAgentId) parts.push(t('pa.work.next', { name: agentName(index, attempts, line.nextAgentId) }));
  return parts.join(' · ');
}

function workerOf(task: PaTask, attempts: PaAttempt[], line: PaWorkLine): string | null {
  if (line.kind === 'step') return line.agentId;
  const running = attempts.find((a) => a.status === 'running');
  return running?.agentSnapshot.id ?? task.participantIds[task.nextParticipant] ?? null;
}

interface WorkLineProps {
  entering: boolean;
  task: PaTask;
  attempts: PaAttempt[];
  line: PaWorkLine;
  closing: boolean;
  liveMascot: boolean;
  fantayRunning: boolean;
}

function WorkLine({ entering, task, attempts, line, closing, liveMascot, fantayRunning }: WorkLineProps) {
  const t = useT();
  const { index, nav } = usePa();
  const stop = usePaStopConfirm();
  const label = workLabel(t, index, task, attempts, line);
  const worker = workerOf(task, attempts, line);
  const workerIsFantay = isFantay(index, worker);
  const unknownStop = line.kind === 'stopping' && line.unknown;
  const pendingAmendments = task.amendments.filter((a) => a.appliedAt === null).length;
  const blockRef = useRef<HTMLDivElement>(null);
  // `inert` is not in React 18's DOM typings; a closing line is neither focusable nor read.
  useEffect(() => {
    const node = blockRef.current;
    if (!node) return;
    if (closing) node.setAttribute('inert', '');
    else node.removeAttribute('inert');
  }, [closing]);
  // A closing line hands the live slot to the receipt's pulse (spec §5.4: one live mascot in the transcript).
  const glyph = workerIsFantay ? (
    liveMascot && !closing ? (
      <FantayMascot size={24} mood={fantayRunning ? 'working' : 'idle'} />
    ) : (
      <FantayMascotStill size={24} />
    )
  ) : (
    <PaAvatar agent={worker ? index.agents.get(worker) ?? null : null} size={20} fantay={false} />
  );
  return (
    <div
      ref={blockRef}
      className={styles.workBlock}
      data-state={closing ? 'closed' : 'open'}
      data-enter={entering ? '' : undefined}
    >
      <div className={styles.workLine} data-testid="pa-work-line">
        <span className={styles.workGlyph} aria-hidden>
          {glyph}
        </span>
        <FxLegacy>
          <ChatRoot>
            <SwapLabel swapKey={label} className={styles.workSwap}>
              <span className={styles.workLabel} data-shimmer={unknownStop ? undefined : ''}>
                {label}
              </span>
            </SwapLabel>
          </ChatRoot>
        </FxLegacy>
        {unknownStop ? (
          <Tooltip label={t('pa.reconcileHelp')}>
            <span className={styles.helpGlyph} tabIndex={0} role="img" aria-label={t('pa.reconcileHelp')}>
              <Icon icon={Info} size="sm" />
            </span>
          </Tooltip>
        ) : null}
        {line.kind === 'step' ? <Elapsed since={line.startedAt} /> : null}
        <span className={styles.workActions}>
          {unknownStop ? (
            <Button
              size="sm"
              variant="ghost"
              className={styles.workAction}
              onClick={() => nav.openModal({ kind: 'reconcile', taskId: task.id })}
            >
              {t('pa.reconcile')}
            </Button>
          ) : null}
          {STOPPABLE.has(task.status) ? (
            <>
              <Button size="sm" variant="ghost" className={styles.workAction} onClick={() => stop(task.id)}>
                {t('pa.stop')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={styles.workAction}
                onClick={() => nav.openModal({ kind: 'amend', taskId: task.id })}
              >
                {t('pa.amend')}
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="link" className={styles.tailLink} onClick={() => nav.openModal({ kind: 'task', taskId: task.id })}>
            {t('pa.act.details')}
          </Button>
        </span>
      </div>
      {pendingAmendments > 0 ? (
        <p className={styles.amendCaption}>{t('pa.receipt.amendPending', { count: pendingAmendments })}</p>
      ) : null}
    </div>
  );
}

/** Fantay's receipt glyph: when it mounts right after Fantay finished, the live mascot lifts once and then the
 *  zero-JS still (its rest pose, so the swap is seamless) takes over. */
function ReceiptMascot({ fresh }: { fresh: boolean }) {
  const [live, setLive] = useState(fresh);
  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(() => setLive(false), RECEIPT_LIVE_MS);
    return () => clearTimeout(timer);
  }, [live]);
  return live ? <FantayMascot size={20} pulse={1} /> : <FantayMascotStill size={20} />;
}

export interface PaTurnTailProps {
  turn: PaTurn;
  conversation: PaConversation;
  latest: boolean;
  entering: boolean;
  /** The receipt already sits in the last reply's footer row (PaReceipt via PaMessage), so the tail skips it. */
  receiptInline?: boolean;
}

export function PaTurnTail({ turn, conversation, latest, entering, receiptInline = false }: PaTurnTailProps) {
  const task = turn.task;
  if (!task) return null;
  return (
    <TaskTail
      task={task}
      turn={turn}
      conversation={conversation}
      latest={latest}
      entering={entering}
      receiptInline={receiptInline}
    />
  );
}

/** The discussion receipt (spec §6.4): glyph, ✓, steps · duration · tokens, details. Always shown on the latest
 *  turn, on hover/focus for earlier ones. It mounts when the task completes, so a receipt that enters live means
 *  the worker just finished: Fantay's glyph then lifts once before settling into the still. */
export function PaReceipt({ task, turn, latest, entering }: { task: PaTask; turn: PaTurn; latest: boolean; entering: boolean }) {
  const t = useT();
  const { index, nav, now } = usePa();
  const attempts = turn.attempts;
  const lastAgent = [...turn.messages].reverse().find((m) => m.senderId !== 'owner');
  const lastId = lastAgent?.senderId ?? task.participantIds[task.participantIds.length - 1] ?? null;
  const fantayLast = isFantay(index, lastId);
  const usage = usageSummary(attempts);
  const duration = formatDuration(budgetUse(task, attempts, now).usedMs, t);
  return (
    <div className={styles.receipt} data-enter={entering ? '' : undefined} data-latest={latest ? '' : undefined}>
      <span className={styles.receiptGlyph} aria-hidden>
        {fantayLast ? (
          <ReceiptMascot fresh={entering} />
        ) : (
          <PaAvatar agent={lastId ? index.agents.get(lastId) ?? null : null} size={20} fantay={false} />
        )}
      </span>
      <Icon icon={Check} size="sm" className={styles.receiptCheck} />
      {/* One run of text, so its separators space exactly like the " · " inside the done copy. */}
      <span className={styles.receiptText}>
        {task.participantIds.length > 1
          ? t('pa.receipt.done', { steps: task.participantIds.length, duration })
          : t('pa.receipt.doneOne', { duration })}
        {' · '}
        {usage.unknown
          ? t('pa.receipt.usageUnknown')
          : t('pa.receipt.tokens', { count: formatTokens(usage.inputTokens + usage.outputTokens) })}
      </span>
      <span aria-hidden className={styles.receiptDot}>
        ·
      </span>
      <Button
        size="sm"
        variant="link"
        className={cn(styles.tailLink, styles.receiptLink)}
        onClick={() => nav.openModal({ kind: 'task', taskId: task.id })}
      >
        {t('pa.act.details')}
      </Button>
    </div>
  );
}

function TaskTail({ task, turn, conversation, latest, entering, receiptInline }: PaTurnTailProps & { task: PaTask }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, data, nav } = usePa();
  const attempts = turn.attempts;
  const kind = tailKindOf(task);
  const line = workLine(task, index, data.control);
  const lastLine = useRef<PaWorkLine | null>(null);
  if (line) lastLine.current = line;
  const presence = usePresence(kind === 'working', 160);
  const fantayRunning = attempts.some((a) => a.status === 'running' && isFantay(index, a.agentSnapshot.id));
  const liveMascot = useDwell(fantayRunning, 600);
  const colon = locale.startsWith('zh') ? '：' : ': ';

  const startAgain = () =>
    nav.fillComposer(task.conversationId, {
      text: task.goal,
      localOnly: task.dataClass === 'local_only',
      completionCriterion: task.completionCriteria?.join('\n'),
      project: task.kind === 'project',
      projectName: task.projectName ?? '',
      replyTo: null,
      request: null,
    });
  const details = () => nav.openModal({ kind: 'task', taskId: task.id });

  let body: ReactNode = null;
  if (presence.mounted && lastLine.current) {
    body = (
      <WorkLine
        entering={entering}
        task={task}
        attempts={attempts}
        line={lastLine.current}
        closing={presence.closing}
        liveMascot={liveMascot}
        fantayRunning={fantayRunning}
      />
    );
  } else if (kind === 'muted') {
    const paused = paAutoWait(task) === 'paused';
    body = (
      <div className={styles.mutedLine} data-enter={entering ? '' : undefined}>
        <Icon icon={Pause} size="sm" />
        <span>{t(paused ? 'pa.wait.paused.title' : 'pa.wait.device.title')}</span>
        {paused ? (
          <Button
            size="sm"
            variant="link"
            className={styles.tailLink}
            loading={data.pending.has(paPendingKey.control())}
            onClick={() => void data.actions.patchControl({ paused: false }).catch(errorToast)}
          >
            {t('pa.resumeAll')}
          </Button>
        ) : null}
      </div>
    );
  } else if (kind === 'needs') {
    body = <PaNeedsYouCard task={task} capped />;
  } else if (kind === 'failed') {
    const resumable = canResume(task, attempts);
    body = (
      <div className={styles.failLine} data-enter={entering ? '' : undefined}>
        <Icon icon={X} size="sm" className={styles.failIcon} />
        <p className={styles.failText}>
          {t('pa.word.failed')}
          {task.error ? `${colon}${task.error}` : ''}
        </p>
        <span className={styles.workActions}>
          {/* An interrupted run whose end is unconfirmed: checking it first is what makes Resume possible and
              keeps the work from running twice (the daemon reconciles failed tasks too). Outlined pills, the
              needs-you and result cards' secondary shape, so a turn's next steps share one button family. */}
          {needsReconcile(task, attempts) ? (
            <Button
              size="sm"
              variant="secondary"
              className={styles.workAction}
              onClick={() => nav.openModal({ kind: 'reconcile', taskId: task.id })}
            >
              {t('pa.reconcile')}
            </Button>
          ) : null}
          {resumable ? (
            <Button
              size="sm"
              variant="secondary"
              className={styles.workAction}
              loading={data.pending.has(paPendingKey.resume(task.id))}
              onClick={() => void data.actions.resumeTask(task.id).catch(errorToast)}
            >
              {t('pa.resume')}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" className={styles.workAction} onClick={startAgain}>
              {t('pa.act.startAgain')}
            </Button>
          )}
          <Button size="sm" variant="link" className={styles.tailLink} onClick={details}>
            {t('pa.act.details')}
          </Button>
        </span>
      </div>
    );
  } else if (kind === 'cancelled') {
    body = (
      <div className={styles.cancelLine} data-enter={entering ? '' : undefined}>
        <span>{t(task.stopConfirmation === 'unknown' ? 'pa.word.stopUnconfirmed' : 'pa.word.cancelled')}</span>
        <Button size="sm" variant="link" className={styles.tailLink} onClick={startAgain}>
          {t('pa.act.startAgain')}
        </Button>
      </div>
    );
  } else if (kind === 'result') {
    body = <PaResultCard task={task} />;
  } else if (kind === 'receipt' && !receiptInline) {
    body = <PaReceipt task={task} turn={turn} latest={latest} entering={entering || liveMascot} />;
  }

  const channelLine = task.channelId ? <ChannelLine task={task} conversation={conversation} /> : null;
  if (!body && !channelLine) return null;
  return (
    <div className={styles.tail}>
      {body}
      {channelLine}
    </div>
  );
}

function ChannelLine({ task, conversation }: { task: PaTask; conversation: PaConversation }) {
  const t = useT();
  const { index, nav } = usePa();
  const rows = index.outbox.filter((row) => row.taskId === task.id);
  if (rows.length === 0) return null;
  const channel = index.channels.get(task.channelId ?? conversation.channelId ?? '');
  const platform = platformName(t, channel?.type);
  if (rows.some((row) => row.state === 'unknown' || row.state === 'failed')) {
    return (
      <Button
        size="sm"
        variant="link"
        className={cn(styles.tailLink, styles.channelWarn)}
        onClick={() => nav.setInspector(true, 'approvals')}
      >
        {t('pa.receipt.deliveryUnknown', { platform })}
      </Button>
    );
  }
  if (rows.some((row) => row.state === 'sent')) {
    return <p className={styles.channelLine}>{t('pa.receipt.replied', { platform })}</p>;
  }
  return null;
}
