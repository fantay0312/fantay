// SPDX-License-Identifier: AGPL-3.0-only
// Task detail modal (spec §10): one surface for a task's status, budget, progress, attempts,
// evidence, files, channel delivery, authorization and event log, plus the full-output view of an
// attempt, which replaces the body while the header stays.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronRight,
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
  Pause,
  type LucideIcon,
} from 'lucide-react';
import { useI18n, useT } from '../../i18n';
import { paPagesEn } from '../../i18n/pa-ui/pages';
import type { Dict } from '../../i18n/types';
import {
  Button,
  Callout,
  Icon,
  MetaLine,
  Modal,
  ModalActions,
  ModalSpacer,
  ModalTitle,
  Progress,
  SearchField,
  Skeleton,
  Spinner,
  cn,
  toast,
} from '../ui';
import { PaAvatar } from './PaAvatar';
import { usePaStopConfirm } from './PaConfirmHost';
import { PaDisclosure } from './PaDisclosure';
import { PaDeliveryCard, PaNeedsYouCard, PaStatusGlyph, PaStatusWord, paAutoWait } from './PaWorkCards';
import { usePa } from './pa-context';
import { downloadPaArtifact } from './pa-api';
import {
  budgetUse,
  canResume,
  conversationTitle,
  effectiveWaitKind,
  formatBytes,
  formatDuration,
  formatTokens,
  isFantay,
  needsReconcile,
  waitInfo,
} from './pa-model';
import type {
  PaArtifact,
  PaAttempt,
  PaChannelOutbox,
  PaIndex,
  PaOutputPage,
  PaPhase,
  PaTask,
  PaTaskEvent,
  PaWaitAction,
  TFn,
} from './pa-types';
import styles from './PaTaskModal.module.css';

/** Characters per output page; the daemon caps a page at 32 000. */
const OUTPUT_LIMIT = 16000;
/** Characters of context loaded ahead of a picked search match, so it does not open mid-sentence. */
const MATCH_LEAD = 240;
/** Match rows listed before "show all". */
const MATCHES_SHOWN = 8;
const LIVE_STATUSES: ReadonlySet<PaTask['status']> = new Set(['queued', 'running', 'verifying', 'waiting']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── time formatting (local; Intl formatters cached per locale) ────────────────────────────── */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${locale}|${key}`;
  let value = formatters.get(id);
  if (!value) {
    try {
      value = new Intl.DateTimeFormat(locale, options);
    } catch {
      value = new Intl.DateTimeFormat('en', options);
    }
    formatters.set(id, value);
  }
  return value;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** `14:05` (24-hour clock). */
export function formatClock(at: number, locale: string): string {
  return formatter(locale, 'clock', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}

/** `11月8日` / `Nov 8`, with the year when it is not the current one. */
export function formatDay(at: number, now: number, locale: string): string {
  const date = new Date(at);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return thisYear
    ? formatter(locale, 'day', { month: 'short', day: 'numeric' }).format(date)
    : formatter(locale, 'dayYear', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

/** Today: `14:05`; otherwise `11月8日 14:05`. */
export function formatStamp(at: number, now: number, locale: string): string {
  const time = formatClock(at, locale);
  return sameDay(new Date(at), new Date(now)) ? time : `${formatDay(at, now, locale)} ${time}`;
}

/* ── artifact row (§12.4 anatomy; shared with the 任务 page 成果 segment) ─────────────────── */

function fileIcon(name: string): LucideIcon {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'html' || ext === 'htm') return FileCode;
  if (ext === 'md' || ext === 'txt') return FileText;
  if (ext === 'css' || ext === 'js' || ext === 'json' || ext === 'ts') return FileCode2;
  if (ext === 'svg' || ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif') return FileImage;
  return File;
}

/** One deliverable file: type icon, name over its project path, size and short hash. Opens the project at that file. */
export function PaArtifactRow({ artifact, onOpen }: { artifact: PaArtifact; onOpen(): void }) {
  const name = artifact.path.split('/').pop() || artifact.path;
  return (
    <Button variant="bare" className={styles.fileRow} onClick={artifact.privateStorage || artifact.dataClass === 'local_only'
      ? () => void downloadPaArtifact(artifact.id, name).catch(error => toast({ tone: 'danger', title: errorMessage(error) }))
      : onOpen} title={artifact.path} data-testid="pa-artifact-row">
      <Icon icon={fileIcon(name)} size={16} className={styles.fileIcon} />
      <span className={styles.fileText}>
        <span className={styles.fileName}>{name}</span>
        <span className={styles.filePath}>{artifact.path}</span>
      </span>
      <span className={styles.fileSize}>{formatBytes(artifact.bytes)}</span>
      <span className={styles.fileHash}>{artifact.sha256.slice(0, 8)}</span>
    </Button>
  );
}

/* ── modal shell ───────────────────────────────────────────────────────────────────────────── */

export function PaTaskModal({ open, onClose, taskId, output }: { open: boolean; onClose(): void; taskId: string; output?: string }) {
  const { index } = usePa();
  const t = useT();
  const task = index.tasks.get(taskId) ?? null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      className={styles.modal}
      data-testid="pa-task"
      data-status={task?.status}
      aria-describedby={undefined}
    >
      {task ? (
        // Keyed so the view, the event log and the output paging reset when another task or attempt is opened.
        <TaskSurface key={`${taskId}\u0000${output ?? ''}`} task={task} initialOutput={output ?? null} onClose={onClose} />
      ) : (
        <>
          <header className={styles.header}>
            <ModalTitle>{t('pa.taskDetail.title')}</ModalTitle>
          </header>
          <div className={styles.body}>
            <SkeletonLines count={3} />
          </div>
        </>
      )}
    </Modal>
  );
}

function TaskSurface({ task, initialOutput, onClose }: { task: PaTask; initialOutput: string | null; onClose(): void }) {
  const { index } = usePa();
  const [outputId, setOutputId] = useState<string | null>(initialOutput);
  const [swapped, setSwapped] = useState(false);
  const attempts = index.attemptsByTask.get(task.id) ?? EMPTY_ATTEMPTS;
  const artifacts = index.artifactsByTask.get(task.id) ?? EMPTY_ARTIFACTS;
  const show = (id: string | null) => {
    setSwapped(true);
    setOutputId(id);
  };
  return (
    <>
      <TaskHeader task={task} attempts={attempts} onClose={onClose} />
      {outputId ? (
        <OutputView
          key={outputId}
          attemptId={outputId}
          attempt={attempts.find((a) => a.id === outputId) ?? null}
          animate={swapped}
          onBack={() => show(null)}
        />
      ) : (
        <>
          <TaskDetail task={task} attempts={attempts} artifacts={artifacts} animate={swapped} onOutput={(id) => show(id)} />
          <TaskFooter task={task} attempts={attempts} artifacts={artifacts} onClose={onClose} />
        </>
      )}
    </>
  );
}

const EMPTY_ATTEMPTS: PaAttempt[] = [];
const EMPTY_ARTIFACTS: PaArtifact[] = [];

/* ── header ────────────────────────────────────────────────────────────────────────────────── */

function TaskHeader({ task, attempts, onClose }: { task: PaTask; attempts: PaAttempt[]; onClose(): void }) {
  const { index, nav, now } = usePa();
  const t = useT();
  const { locale } = useI18n();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [task.goal, expanded]);

  const conversation = index.conversations.get(task.conversationId) ?? null;
  return (
    <header className={styles.header}>
      <ModalTitle ref={titleRef} className={cn(styles.goal, expanded && styles.goalOpen)}>
        {task.goal}
      </ModalTitle>
      {clamped ? (
        <Button variant="link" size="sm" className={styles.expand} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? t('pa.chat.collapse') : t('pa.chat.expand')}
        </Button>
      ) : null}
      {task.completionCriteria?.length ? (
        <ul className={styles.criteriaList} aria-label={t('pa.composer.completionCriteria')}>
          {task.completionCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}
        </ul>
      ) : null}
      <div className={styles.statusRow}>
        <span className={styles.status}>
          <PaStatusGlyph task={task} attempts={attempts} size={14} />
          <PaStatusWord task={task} attempts={attempts} />
        </span>
        <MetaLine className={styles.meta}>
          {conversation ? <span className={styles.metaPart}>{conversationTitle(index, conversation)}</span> : null}
          <span className={styles.metaFixed}>{formatStamp(task.createdAt, now, locale)}</span>
          <span className={styles.metaFixed}>
            {task.kind === 'project' ? t('pa.taskDetail.kindProject') : t('pa.taskDetail.kindDiscussion')}
          </span>
        </MetaLine>
        <Button
          variant="link"
          size="sm"
          className={styles.openInChat}
          onClick={() => {
            nav.openTaskTurn(task.id);
            onClose();
          }}
        >
          {t('pa.tasks.openInChat')}
        </Button>
      </div>
    </header>
  );
}

/* ── detail body ───────────────────────────────────────────────────────────────────────────── */

function Section({ title, count, children, testId }: { title: ReactNode; count?: number; children: ReactNode; testId?: string }) {
  return (
    <section className={styles.section} data-testid={testId}>
      <h3 className={styles.sectionTitle}>
        {title}
        {count !== undefined ? <span className={styles.sectionCount}>{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** A budget limit reads as a round figure: `5 分钟`, not `5 分 0 秒`. */
function formatLimit(ms: number, t: TFn): string {
  if (ms >= 60_000 && ms < 3_600_000 && ms % 60_000 === 0) return t('pa.taskDetail.minutes', { m: ms / 60_000 });
  return formatDuration(ms, t);
}

function AuthCell({ label, allowed, t }: { label: string; allowed: boolean; t: TFn }) {
  return (
    <div className={styles.authCell} data-allowed={allowed ? 'true' : 'false'}>
      <span className={styles.authKey}>{label}</span>
      <span className={styles.authValue}>{allowed ? t('pa.taskDetail.allowed') : t('pa.taskDetail.notAllowed')}</span>
    </div>
  );
}

function TaskDetail({
  task,
  attempts,
  artifacts,
  animate,
  onOutput,
}: {
  task: PaTask;
  attempts: PaAttempt[];
  artifacts: PaArtifact[];
  animate: boolean;
  onOutput(attemptId: string): void;
}) {
  const { index, now, onOpenProject } = usePa();
  const t = useT();
  const { locale } = useI18n();
  const use = budgetUse(task, attempts, now);
  const files = useMemo(() => [...artifacts].sort((a, b) => a.createdAt - b.createdAt), [artifacts]);
  const outbox = useMemo(() => (task.channelId ? index.outbox.filter((row) => row.taskId === task.id) : []), [index, task]);
  // An exhausted budget is only warm while it is what the task waits on (needs you); otherwise it stays ink.
  const budgetWait = effectiveWaitKind(task) === 'budget';
  const attemptsLabel = t('pa.taskDetail.attempts', { used: use.attempts, max: use.maxAttempts ?? '—' });
  const timeLabel = t('pa.taskDetail.time', {
    used: formatDuration(use.usedMs, t),
    limit: use.timeoutMs ? formatLimit(use.timeoutMs, t) : '—',
  });

  return (
    <div className={cn(styles.body, animate && styles.swapIn)}>
      <StuckLine task={task} attempts={attempts} />

      <Section title={t('pa.taskDetail.budget')}>
        <div className={cn(styles.group, styles.budget)}>
          <div className={styles.budgetRow}>
            <span className={styles.budgetLabel}>{attemptsLabel}</span>
            <Progress
              value={use.maxAttempts ? use.attempts : 0}
              max={use.maxAttempts ?? 1}
              aria-label={attemptsLabel}
              indicatorClassName={budgetWait && use.maxAttempts !== null && use.attempts >= use.maxAttempts ? styles.meterWarn : undefined}
            />
          </div>
          <div className={styles.budgetRow}>
            <span className={styles.budgetLabel}>{timeLabel}</span>
            <Progress
              value={use.timeoutMs ? use.usedMs : 0}
              max={use.timeoutMs ?? 1}
              aria-label={timeLabel}
              indicatorClassName={budgetWait && use.timeoutMs !== null && use.usedMs >= use.timeoutMs ? styles.meterWarn : undefined}
            />
          </div>
        </div>
      </Section>

      {task.participantIds.length > 0 ? (
        <Section title={t('pa.taskDetail.progress')}>
          <div className={styles.group}>
            {task.participantIds.map((agentId, i) => (
              <ParticipantRow key={`${agentId}:${i}`} task={task} attempts={attempts} index={index} position={i} t={t} />
            ))}
          </div>
        </Section>
      ) : null}

      {task.amendments.length > 0 ? (
        <Section title={t('pa.taskDetail.amendments')} count={task.amendments.length}>
          <div className={styles.group}>
            {task.amendments.map((amendment) => (
              <div key={amendment.revision} className={styles.amendRow}>
                <p className={styles.amendText}>{amendment.content}</p>
                <MetaLine>
                  <span className={amendment.appliedAt === null ? styles.amendPending : undefined}>
                    {amendment.appliedAt === null ? t('pa.received') : t('pa.applied')}
                  </span>
                  <span>{formatStamp(amendment.appliedAt ?? amendment.receivedAt, now, locale)}</span>
                </MetaLine>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t('pa.taskDetail.attemptList')} count={attempts.length || undefined}>
        {attempts.length === 0 ? (
          <div className={styles.group}>
            <p className={cn(styles.quiet, styles.quietRow)}>{t('pa.taskDetail.noAttempts')}</p>
          </div>
        ) : (
          <div className={styles.group}>
            {attempts.map((attempt) => (
              <AttemptRow key={attempt.id} attempt={attempt} now={now} t={t} onOutput={() => onOutput(attempt.id)} />
            ))}
          </div>
        )}
      </Section>

      {task.evidence.length > 0 ? (
        <Section title={t('pa.evidence')}>
          {/* A ✓ only once the task completed; before that, evidence can be a reviewer's open issue, not a pass. */}
          <ul className={cn(styles.group, styles.checklist)}>
            {task.evidence.map((line, i) => (
              <li key={i} className={styles.checkItem}>
                {task.status === 'completed' ? (
                  <Icon icon={Check} size={14} className={styles.checkIcon} />
                ) : (
                  <span className={styles.checkBullet} aria-hidden />
                )}
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {files.length > 0 ? (
        <Section title={t('pa.taskDetail.files')} count={files.length}>
          <div className={styles.fileList}>
            {files.map((artifact) => (
              <PaArtifactRow key={artifact.id} artifact={artifact} onOpen={() => onOpenProject(artifact.projectId, artifact.path)} />
            ))}
          </div>
        </Section>
      ) : null}

      {task.channelId && outbox.length > 0 ? (
        <Section title={t('pa.taskDetail.delivery')}>
          {/* Unknown or failed sends need you and get the warm card; the rest are quiet rows in one hairline block. */}
          <div className={styles.deliveryStack}>
            {outbox.filter(deliveryNeedsYou).map((row) => (
              <PaDeliveryCard key={row.id} outbox={row} />
            ))}
            {outbox.some((row) => !deliveryNeedsYou(row)) ? (
              <div className={styles.group}>
                {outbox
                  .filter((row) => !deliveryNeedsYou(row))
                  .map((row) => (
                    <DeliveryRow key={row.id} row={row} now={now} locale={locale} />
                  ))}
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      <Section title={t('pa.taskDetail.authTitle')}>
        <div className={cn(styles.group, styles.auth)} data-revoked={task.authorization.revoked ? 'true' : undefined}>
          <div className={styles.authCells}>
            <AuthCell label={t('pa.taskDetail.localProject')} allowed={task.authorization.localProject} t={t} />
            <AuthCell label={t('pa.taskDetail.externalWrites')} allowed={task.authorization.externalWrites} t={t} />
          </div>
          {task.authorization.revoked ? (
            <p className={styles.revoked}>
              <Icon icon={CircleAlert} size={14} />
              <span>{t('pa.taskDetail.revoked')}</span>
            </p>
          ) : null}
        </div>
      </Section>

      <EventLog taskId={task.id} />
    </div>
  );
}

/** A status note at the top of the body, shaped like the needs-you card: a glyph, a title in the tone colour,
    then the detail. `failed` is the --accent-ink tint, `warn` the needs-you warmth, `idle` a quiet hairline. */
function StuckNote({
  tone,
  icon,
  title,
  children,
  role,
}: {
  tone: 'failed' | 'warn' | 'idle';
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  role?: 'status';
}) {
  return (
    <div className={styles.note} data-tone={tone} role={role}>
      <Icon icon={icon} size={16} className={styles.noteIcon} />
      <div className={styles.noteBody}>
        <p className={styles.noteTitle}>{title}</p>
        {children}
      </div>
    </div>
  );
}

/** Why the task is stuck: the needs-you card while it waits on the owner, a note when it waits on its own,
    failed, or could not confirm a stop. A failure that needs the interrupted run checked says why first, so
    the footer's 核对中断执行 is not a mystery. */
function StuckLine({ task, attempts }: { task: PaTask; attempts: PaAttempt[] }) {
  const t = useT();
  if (task.status === 'waiting') {
    const autoWait = paAutoWait(task);
    if (autoWait) {
      return <StuckNote tone="idle" icon={Pause} title={autoWait === 'paused' ? t('pa.wait.paused.title') : t('pa.wait.device.title')} />;
    }
    return <PaNeedsYouCard task={task} />;
  }
  if (task.status === 'failed') {
    return (
      <StuckNote tone="failed" icon={CircleX} title={t('pa.word.failed')} role="status">
        {task.error ? <p className={styles.noteText}>{task.error}</p> : null}
        {needsReconcile(task, attempts) ? <p className={styles.noteHint}>{t('pa.wait.unconfirmed.body')}</p> : null}
      </StuckNote>
    );
  }
  if (task.status === 'cancelling' && task.stopConfirmation === 'unknown') {
    return <StuckNote tone="warn" icon={CircleAlert} title={t('pa.work.stopUnconfirmed')} />;
  }
  return null;
}

/** Phase of the i-th participant: its latest attempt's phase, else the daemon's ordering rule (§15.1). */
function participantPhase(task: PaTask, index: PaIndex, attempts: PaAttempt[], position: number): PaPhase {
  const agentId = task.participantIds[position];
  for (let i = attempts.length - 1; i >= 0; i -= 1) {
    const attempt = attempts[i];
    if (attempt && attempt.agentSnapshot.id === agentId) return attempt.phase;
  }
  const total = task.participantIds.length;
  if (task.kind === 'project') {
    if (position === total - 1) return 'review';
    if (position === total - 2) return 'produce';
    return 'respond';
  }
  const group = index.groupByConversation.get(task.conversationId);
  if (group?.mode === 'review' && total > 1 && position === total - 1) return 'review';
  return 'respond';
}

type StepState = 'done' | 'current' | 'next';

function StepGlyph({ task, state }: { task: PaTask; state: StepState }) {
  if (state === 'done') return <Icon icon={CircleCheck} size={16} className={styles.glyphDone} />;
  if (state === 'next') return <Icon icon={Circle} size={16} className={styles.glyphIdle} />;
  switch (task.status) {
    case 'running':
    case 'verifying':
      return <Spinner size="xs" className={styles.glyphRun} />;
    case 'waiting':
      return paAutoWait(task) ? (
        <Icon icon={Pause} size={16} className={styles.glyphIdle} />
      ) : (
        <Icon icon={CircleAlert} size={16} className={styles.glyphWarn} />
      );
    case 'failed':
      return <Icon icon={CircleX} size={16} className={styles.glyphFail} />;
    case 'cancelling':
    case 'cancelled':
      return <Icon icon={CircleSlash} size={16} className={styles.glyphIdle} />;
    default:
      return <Icon icon={Circle} size={16} className={styles.glyphIdle} />;
  }
}

function ParticipantRow({
  task,
  attempts,
  index,
  position,
  t,
}: {
  task: PaTask;
  attempts: PaAttempt[];
  index: PaIndex;
  position: number;
  t: TFn;
}) {
  const agentId = task.participantIds[position] ?? '';
  const snapshot = [...attempts].reverse().find((a) => a.agentSnapshot.id === agentId)?.agentSnapshot ?? null;
  const agent = index.agents.get(agentId) ?? snapshot;
  const state: StepState =
    task.status === 'completed' || position < task.nextParticipant
      ? 'done'
      : position === task.nextParticipant
        ? 'current'
        : 'next';
  const phase = participantPhase(task, index, attempts, position);
  return (
    <div className={styles.stepRow} data-state={state}>
      <StepGlyph task={task} state={state} />
      <PaAvatar agent={agent} size={20} fantay={isFantay(index, agentId)} dim={agent ? !agent.enabled : false} />
      <span className={styles.stepName}>
        <span className={styles.stepAgent}>{agent?.name ?? '—'}</span>
        <span className={styles.stepPhase}>{t(`pa.phase.${phase}`)}</span>
      </span>
      <span className={styles.stepState}>
        {state === 'done' ? t('pa.taskDetail.done') : state === 'current' ? t('pa.taskDetail.current') : t('pa.taskDetail.next')}
      </span>
    </div>
  );
}

function AttemptGlyph({ attempt }: { attempt: PaAttempt }) {
  switch (attempt.status) {
    case 'running':
      return <Spinner size="xs" className={styles.glyphRun} />;
    case 'completed':
      return <Icon icon={CircleCheck} size={16} className={styles.glyphDone} />;
    case 'failed':
      return <Icon icon={CircleX} size={16} className={styles.glyphFail} />;
    case 'interrupted':
      return <Icon icon={CircleAlert} size={16} className={styles.glyphWarn} />;
    default:
      return <Icon icon={CircleSlash} size={16} className={styles.glyphIdle} />;
  }
}

/** A reported token count, or '—' when the runtime reported usage without that number (Ollama omits the prompt
 *  count for a cached prompt): a missing count is unknown, never zero. */
function tokenCount(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatTokens(value) : '—';
}

function AttemptRow({ attempt, now, t, onOutput }: { attempt: PaAttempt; now: number; t: TFn; onOutput(): void }) {
  const usage = attempt.usage;
  // Nothing to show as counts when usage is unknown, or reported with neither number.
  const noCounts = usage.visibility === 'unknown' || (usage.inputTokens === undefined && usage.outputTokens === undefined);
  const duration = formatDuration(Math.max(0, (attempt.endedAt ?? now) - attempt.startedAt), t);
  return (
    <div className={styles.attemptRow} data-status={attempt.status}>
      <span className={styles.attemptGlyph}>
        <AttemptGlyph attempt={attempt} />
      </span>
      <div className={styles.attemptMain}>
        <div className={styles.attemptHead}>
          <span className={styles.attemptName}>{attempt.agentSnapshot.name}</span>
          <span className={styles.attemptPhase}>{t(`pa.phase.${attempt.phase}`)}</span>
          {attempt.status === 'interrupted' ? <span className={styles.interrupted}>{t('pa.taskDetail.interrupted')}</span> : null}
        </div>
        <MetaLine className={styles.attemptMeta}>
          <span className={styles.mono}>
            {t('pa.taskDetail.configured', {
              configured: attempt.agentSnapshot.model.modelId,
              resolved: attempt.resolvedModel ?? '—',
            })}
          </span>
          <span className={styles.metaFixed}>{duration}</span>
          {/* Separate children: MetaLine puts its dot between direct children, and a fragment counts as one. */}
          {noCounts ? (
            <span className={styles.metaFixed}>{t('pa.unknownUsage')}</span>
          ) : (
            <span className={styles.metaFixed}>{t('pa.taskDetail.tokensIn', { count: tokenCount(usage.inputTokens) })}</span>
          )}
          {noCounts ? null : (
            <span className={styles.metaFixed}>{t('pa.taskDetail.tokensOut', { count: tokenCount(usage.outputTokens) })}</span>
          )}
          {usage.visibility !== 'unknown' && usage.costUsd !== undefined ? (
            <span className={styles.metaFixed}>{`$${usage.costUsd}`}</span>
          ) : null}
        </MetaLine>
        {attempt.error ? <p className={styles.attemptError}>{attempt.error}</p> : null}
      </div>
      <Button variant="bare" size="sm" className={styles.attemptAction} onClick={onOutput}>
        {t('pa.chat.fullOutput')}
        <Icon icon={ChevronRight} size={14} className={styles.attemptChevron} />
      </Button>
    </div>
  );
}

const OUTBOX_STATE_KEY: Record<Exclude<PaChannelOutbox['state'], 'unknown' | 'failed'>, keyof Dict> = {
  sent: 'pa.sent',
  sending: 'pa.sending',
  pending: 'pa.pending',
  cancelled: 'pa.cancelled',
};

function deliveryNeedsYou(row: PaChannelOutbox): boolean {
  return row.state === 'unknown' || row.state === 'failed';
}

/** A send that needs nothing from you: sent, sending, pending or cancelled, as one quiet row. */
function DeliveryRow({ row, now, locale }: { row: PaChannelOutbox; now: number; locale: string }) {
  const { index } = usePa();
  const t = useT();
  if (row.state === 'unknown' || row.state === 'failed') return null;
  const channel = index.channels.get(row.channelId);
  return (
    <div className={styles.deliveryLine} data-state={row.state}>
      {row.state === 'sent' ? (
        <Icon icon={Check} size={12} className={styles.checkIcon} />
      ) : (
        <Icon icon={Circle} size={12} className={styles.glyphIdle} />
      )}
      <MetaLine className={styles.deliveryMeta}>
        <span className={styles.metaFixed}>{t(OUTBOX_STATE_KEY[row.state])}</span>
        {channel ? <span className={styles.metaFixed}>{channel.name}</span> : null}
        <span className={styles.metaFixed}>{formatStamp(row.sentAt ?? row.updatedAt, now, locale)}</span>
        {row.preview ? <span className={styles.metaPart}>{row.preview}</span> : null}
      </MetaLine>
    </div>
  );
}

/* ── event log ─────────────────────────────────────────────────────────────────────────────── */

const EVENT_KEYS: ReadonlySet<string> = new Set(Object.keys(paPagesEn).filter((key) => key.startsWith('pa.event.')));

function eventLabel(kind: string, t: TFn): string {
  const key = `pa.event.${kind}`;
  return EVENT_KEYS.has(key) ? t(key as keyof Dict) : kind;
}

function eventTone(kind: string): 'done' | 'failed' | 'warn' | 'plain' {
  if (kind === 'task.completed' || kind === 'artifacts.verified' || kind === 'channel.send_receipt' || kind === 'task.recovery_verified') {
    return 'done';
  }
  if (kind === 'task.interrupted' || kind === 'node.cancelled') return 'failed';
  if (
    kind === 'task.recovery_required' ||
    kind === 'task.resume_blocked' ||
    kind === 'task.wait_expired' ||
    kind === 'channel.send_unconfirmed' ||
    kind === 'task.paused'
  ) {
    return 'warn';
  }
  return 'plain';
}

/** A short human detail carried by some events (an interruption message, an owner note, an amendment, why a
    resume was refused). `task.paused` carries a machine reason (`paused` / `device`), so `reason` is read only here. */
function eventDetail(kind: string, data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const fields = kind === 'task.resume_blocked' ? (['reason'] as const) : (['message', 'note', 'content'] as const);
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

type EventState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; events: PaTaskEvent[] }
  | { status: 'error'; message: string };

function EventLog({ taskId }: { taskId: string }) {
  const { data, now } = usePa();
  const t = useT();
  const { locale } = useI18n();
  const actions = useRef(data.actions);
  actions.current = data.actions;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<EventState>({ status: 'idle' });

  const load = () => {
    setState({ status: 'loading' });
    actions.current
      .taskEvents(taskId)
      .then((events) => {
        if (!mounted.current) return;
        setState({ status: 'ready', events: events.filter((event) => event.kind !== 'node.heartbeat') });
      })
      .catch((error: unknown) => {
        if (mounted.current) setState({ status: 'error', message: errorMessage(error) });
      });
  };

  return (
    <PaDisclosure
      label={t('pa.taskDetail.events')}
      count={state.status === 'ready' ? state.events.length : undefined}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && (state.status === 'idle' || state.status === 'error')) load();
      }}
      className={styles.events}
    >
      {state.status === 'loading' || state.status === 'idle' ? (
        <SkeletonLines count={3} />
      ) : state.status === 'error' ? (
        <p className={styles.eventsError}>{state.message}</p>
      ) : state.events.length === 0 ? (
        <p className={styles.quiet}>{t('pa.taskDetail.eventsEmpty')}</p>
      ) : (
        <ol className={styles.timeline}>
          {state.events.map((event) => {
            const detail = eventDetail(event.kind, event.data);
            return (
              <li key={event.id} className={styles.event} data-tone={eventTone(event.kind)}>
                <time className={styles.eventTime} dateTime={new Date(event.at).toISOString()} title={formatStamp(event.at, now, locale)}>
                  {formatClock(event.at, locale)}
                </time>
                <span className={styles.eventRail} aria-hidden>
                  <span className={styles.eventDot} />
                </span>
                <span className={styles.eventText}>
                  {eventLabel(event.kind, t)}
                  {detail ? <span className={styles.eventDetail}>{detail}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </PaDisclosure>
  );
}

function SkeletonLines({ count }: { count: number }) {
  return (
    <div className={styles.skeletons}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} shape="line" index={i} className={i === count - 1 ? styles.skeletonShort : undefined} />
      ))}
    </div>
  );
}

/* ── footer ────────────────────────────────────────────────────────────────────────────────── */

type ResumeAction = 'resume' | 'startAgain' | 'resumeFantay';

/** Which resume-type action the footer offers, following §15.2/§15.3: never Resume when the daemon would refuse it. */
function resumeActionFor(task: PaTask, attempts: PaAttempt[], index: PaIndex): ResumeAction | null {
  if (task.status === 'waiting') {
    const actions = waitInfo(task, attempts, index).actions;
    if (actions.includes('resumeFantay')) return 'resumeFantay';
    if (actions.includes('resume') || actions.includes('continueReview')) return canResume(task, attempts) ? 'resume' : 'startAgain';
    if (actions.includes('startAgain')) return 'startAgain';
    return null;
  }
  if (task.status === 'failed') return canResume(task, attempts) ? 'resume' : 'startAgain';
  if (task.status === 'cancelled') return 'startAgain';
  return null;
}

const NO_ACTIONS: ReadonlySet<PaWaitAction> = new Set();

/** The actions the needs-you card at the top of the body already offers (it renders for a waiting task unless it
    is paused or waits for the device), mapped the way the card maps them. The footer does not repeat these, so the
    same action never appears twice under two names. */
function cardActions(task: PaTask, attempts: PaAttempt[], index: PaIndex): ReadonlySet<PaWaitAction> {
  if (task.status !== 'waiting' || paAutoWait(task)) return NO_ACTIONS;
  const resumable = canResume(task, attempts);
  return new Set(
    waitInfo(task, attempts, index).actions.map((action): PaWaitAction =>
      !resumable && (action === 'resume' || action === 'continueReview') ? 'startAgain' : action,
    ),
  );
}

function TaskFooter({
  task,
  attempts,
  artifacts,
  onClose,
}: {
  task: PaTask;
  attempts: PaAttempt[];
  artifacts: PaArtifact[];
  onClose(): void;
}) {
  const { data, index, nav, onOpenProject } = usePa();
  const t = useT();
  const stop = usePaStopConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = LIVE_STATUSES.has(task.status);
  const inCard = cardActions(task, attempts, index);
  const showStop = live && !inCard.has('stop');
  const showAmend = live && !inCard.has('amend');
  const reconcile = needsReconcile(task, attempts) && !inCard.has('reconcile');
  const offered = resumeActionFor(task, attempts, index);
  const resume =
    offered && !(offered === 'resume' ? inCard.has('resume') || inCard.has('continueReview') : inCard.has(offered)) ? offered : null;
  const canOpenProject = task.projectId && task.dataClass !== 'local_only' && data.snapshot?.mode !== 'enterprise';
  const primary: 'openProject' | 'reconcile' | ResumeAction | null = canOpenProject ? 'openProject' : reconcile ? 'reconcile' : resume;
  const lastArtifact = artifacts.reduce<PaArtifact | null>((last, item) => (!last || item.createdAt >= last.createdAt ? item : last), null);
  const pending = (key: string) => busy === key || data.pending.has(`${key}:${task.id}`);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setError(null);
    setBusy(key);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const startAgain = () => {
    nav.fillComposer(task.conversationId, {
      text: task.goal,
      localOnly: task.dataClass === 'local_only',
      completionCriterion: task.completionCriteria?.join('\n'),
      project: task.kind === 'project',
      projectName: task.projectName,
      replyTo: null,
      request: null,
    });
    onClose();
  };

  const reconcileButton = reconcile ? (
    <Button
      variant={primary === 'reconcile' ? 'primary' : 'default'}
      onClick={() => nav.openModal({ kind: 'reconcile', taskId: task.id })}
    >
      {t('pa.reconcile')}
    </Button>
  ) : null;
  const resumeButton = resume === 'resume' ? (
    <Button
      variant={primary === 'resume' ? 'primary' : 'default'}
      loading={pending('resume')}
      onClick={() => void run('resume', () => data.actions.resumeTask(task.id))}
    >
      {t('pa.resume')}
    </Button>
  ) : resume === 'resumeFantay' ? (
    <Button
      variant={primary === 'resumeFantay' ? 'primary' : 'default'}
      loading={pending('control')}
      onClick={() => void run('control', () => data.actions.patchControl({ paused: false }))}
    >
      {t('pa.resumeAll')}
    </Button>
  ) : resume === 'startAgain' ? (
    <Button variant={primary === 'startAgain' ? 'primary' : 'default'} onClick={startAgain}>
      {t('pa.act.startAgain')}
    </Button>
  ) : null;

  return (
    <div className={styles.footerWrap}>
      {error ? (
        <Callout tone="error" className={styles.footerError} role="alert">
          {error}
        </Callout>
      ) : null}
      <ModalActions className={styles.footer}>
        {showStop ? (
          <Button variant="ghost" className={styles.stop} onClick={() => stop(task.id)} loading={data.pending.has(`stop:${task.id}`)}>
            {t('pa.stop')}
          </Button>
        ) : null}
        <ModalSpacer />
        <Button variant="ghost" onClick={onClose}>
          {t('pa.taskDetail.close')}
        </Button>
        {showAmend ? (
          <Button variant="default" onClick={() => nav.openModal({ kind: 'amend', taskId: task.id })}>
            {t('pa.amend')}
          </Button>
        ) : null}
        {/* The primary action sits rightmost: reconcile goes after resume when it leads. */}
        {primary === 'reconcile' ? (
          <>
            {resumeButton}
            {reconcileButton}
          </>
        ) : (
          <>
            {reconcileButton}
            {resumeButton}
          </>
        )}
        {canOpenProject ? (
          <Button variant="primary" onClick={() => onOpenProject(task.projectId!, lastArtifact?.path)}>
            {t('pa.openProject')}
          </Button>
        ) : null}
      </ModalActions>
    </div>
  );
}

/* ── output view ───────────────────────────────────────────────────────────────────────────── */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wraps every case-insensitive occurrence of `query` in <mark>, matching the daemon's search. `base` is the
    absolute offset of `text`; the occurrence that starts at `current` is marked as the picked match. */
function highlight(text: string, query: string, base = 0, current: number | null = null): ReactNode {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'giu'));
  if (parts.length === 1) return text;
  let at = base;
  return parts.map((part, i) => {
    const start = at;
    at += part.length;
    if (i % 2 === 0) return part;
    return (
      <mark key={i} data-current={start === current ? 'true' : undefined}>
        {part}
      </mark>
    );
  });
}

/** The daemon's excerpt starts up to 80 characters before the match. Find the occurrence closest to that point
    (so a differently cut excerpt still works) and keep ~24 characters of lead-in, so the match stays in view. */
function excerptFrom(match: { offset: number; excerpt: string }, query: string): string {
  const text = match.excerpt;
  const expected = Math.min(80, match.offset);
  let found = -1;
  if (query) {
    const matcher = new RegExp(escapeRegExp(query), 'giu');
    for (let hit = matcher.exec(text); hit; hit = matcher.exec(text)) {
      if (found < 0 || Math.abs(hit.index - expected) < Math.abs(found - expected)) found = hit.index;
      if (hit[0].length === 0) matcher.lastIndex += 1;
    }
  }
  const at = found >= 0 ? found : expected;
  const start = Math.max(0, at - 24);
  const absoluteStart = match.offset - at + start;
  return `${absoluteStart > 0 ? '…' : ''}${text.slice(start).replace(/\s+/g, ' ')}`;
}

function OutputView({
  attemptId,
  attempt,
  animate,
  onBack,
}: {
  attemptId: string;
  attempt: PaAttempt | null;
  animate: boolean;
  onBack(): void;
}) {
  const { data } = usePa();
  const t = useT();
  const { locale } = useI18n();
  const actions = useRef(data.actions);
  actions.current = data.actions;
  const sequence = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  /** Where the body scrolls once the next page lands: the top (first load, a new search), the text (paging), or
      the picked match. */
  const scrollTo = useRef<'top' | 'text' | 'current'>('top');
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [matches, setMatches] = useState<PaOutputPage['matches'] | null>(null);
  const [matchesOpen, setMatchesOpen] = useState(true);
  /** The daemon returns up to 50 matches; the list shows the first few until asked, so the text stays near. */
  const [allMatches, setAllMatches] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  const [page, setPage] = useState<PaOutputPage | null>(null);
  const [loading, setLoading] = useState<'page' | 'search' | null>('page');
  const [error, setError] = useState<string | null>(null);

  const load = (offset: number, search?: string) => {
    const id = (sequence.current += 1);
    setLoading(search === undefined ? 'page' : 'search');
    setError(null);
    actions.current
      .attemptOutput(attemptId, { offset, limit: OUTPUT_LIMIT, ...(search ? { q: search } : {}) })
      .then((next) => {
        if (id !== sequence.current) return;
        setPage(next);
        if (search !== undefined) {
          setMatches(search ? next.matches : null);
          setMatchesOpen(true);
          setAllMatches(false);
        }
      })
      .catch((cause: unknown) => {
        if (id === sequence.current) setError(errorMessage(cause));
      })
      .finally(() => {
        if (id === sequence.current) setLoading(null);
      });
  };

  useEffect(() => {
    load(0);
    return () => {
      sequence.current += 1;
    };
    // `load` reads the latest actions through a ref; only the attempt changes what is fetched.
  }, [attemptId]);

  // Scroll inside the modal body only (scrollIntoView would also move the page behind the modal).
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!page || !body) return;
    const place = (target: HTMLElement, align: 'start' | 'center') => {
      const frame = body.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      const delta = rect.top - frame.top - (align === 'center' ? (frame.height - rect.height) / 2 : 12);
      body.scrollTo?.({ top: body.scrollTop + delta });
    };
    const mark = scrollTo.current === 'current' ? body.querySelector<HTMLElement>('mark[data-current]') : null;
    if (mark) place(mark, 'center');
    else if (scrollTo.current === 'text' && preRef.current) place(preRef.current, 'start');
    else body.scrollTo?.({ top: 0 });
  }, [page]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = query.trim().slice(0, 200);
    setActiveQuery(next);
    setCurrent(null);
    scrollTo.current = 'top';
    load(0, next);
  };

  const pick = (offset: number) => {
    setCurrent(offset);
    setMatchesOpen(false);
    scrollTo.current = 'current';
    load(Math.max(0, offset - MATCH_LEAD));
  };

  const turn = (offset: number) => {
    scrollTo.current = 'text';
    load(offset);
  };

  const from = page && page.text.length > 0 ? page.offset + 1 : (page?.offset ?? 0);
  const to = page ? page.offset + page.text.length : 0;
  const paged = page ? page.offset > 0 || page.nextOffset !== null : false;
  const number = (n: number) => n.toLocaleString(locale);

  return (
    <>
      <div ref={bodyRef} className={cn(styles.body, styles.outputBody, animate && styles.swapIn)} data-testid="pa-task-output">
        <div className={styles.outputTop}>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <Icon icon={ArrowLeft} size="sm" />
            {t('pa.output.back')}
          </Button>
          <span className={styles.outputAttempt}>
            {attempt ? `${attempt.agentSnapshot.name} · ${t(`pa.phase.${attempt.phase}`)}` : t('pa.output.title')}
          </span>
        </div>
        <form className={styles.outputSearch} role="search" onSubmit={submit}>
          <SearchField
            className={styles.searchField}
            value={query}
            maxLength={200}
            placeholder={t('pa.searchOutput')}
            aria-label={t('pa.searchOutput')}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button type="submit" variant="default" loading={loading === 'search'}>
            {t('pa.search')}
          </Button>
        </form>
        {error ? (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        ) : null}
        {matches ? (
          matches.length === 0 ? (
            <p className={styles.noMatches}>{t('pa.output.noMatches')}</p>
          ) : (
            <PaDisclosure
              label={t('pa.output.matches', { count: matches.length })}
              open={matchesOpen}
              onOpenChange={setMatchesOpen}
              className={styles.matches}
            >
              <div className={styles.matchList}>
                {(allMatches ? matches : matches.slice(0, MATCHES_SHOWN)).map((match) => (
                  <Button
                    key={match.offset}
                    variant="bare"
                    size="sm"
                    className={styles.match}
                    data-current={match.offset === current ? 'true' : undefined}
                    onClick={() => pick(match.offset)}
                  >
                    <span className={styles.matchOffset}>{number(match.offset)}</span>
                    <span className={styles.matchExcerpt}>{highlight(excerptFrom(match, activeQuery), activeQuery)}</span>
                  </Button>
                ))}
                {!allMatches && matches.length > MATCHES_SHOWN ? (
                  <Button variant="bare" size="sm" className={cn(styles.match, styles.matchMore)} onClick={() => setAllMatches(true)}>
                    {t('pa.output.allMatches', { count: matches.length })}
                  </Button>
                ) : null}
              </div>
            </PaDisclosure>
          )
        ) : null}
        {page ? (
          <pre ref={preRef} className={styles.pre} aria-busy={loading === 'page' || undefined}>
            {highlight(page.text, activeQuery, page.offset, current)}
          </pre>
        ) : error ? null : (
          <SkeletonLines count={6} />
        )}
      </div>
      <ModalActions className={styles.footer}>
        <span className={styles.range}>
          {page ? t('pa.output.range', { from: number(from), to: number(to), total: number(page.totalChars) }) : null}
        </span>
        <ModalSpacer />
        {paged ? (
          <>
            <Button size="sm" disabled={!page || page.offset === 0} onClick={() => page && turn(Math.max(0, page.offset - OUTPUT_LIMIT))}>
              {t('pa.previousPage')}
            </Button>
            <Button size="sm" disabled={!page || page.nextOffset === null} onClick={() => page?.nextOffset != null && turn(page.nextOffset)}>
              {t('pa.nextPage')}
            </Button>
          </>
        ) : null}
      </ModalActions>
    </>
  );
}
