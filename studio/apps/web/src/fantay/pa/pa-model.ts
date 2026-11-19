// SPDX-License-Identifier: AGPL-3.0-only
// Pure derivations for the Fantay workspace (spec §15, §19.3). No React, no I/O: every function takes the
// snapshot (or the index built from it) and returns plain data, so the rules are unit-tested in isolation.
//
// Several functions mirror daemon rules so the UI never offers what the daemon would refuse. The mirrored
// source is `apps/daemon/src/services/personal-agent-service.ts` (abbreviated SVC below); each mirror names
// the SVC method it follows. When the daemon changes, update the mirror and its test together.
import { paRemainingTime } from '@open-design/contracts';
import { builtinPresets, isInContext } from '@open-design/contracts/soul';
import type {
  PaAgentStatus,
  PaAttempt,
  PaChannel,
  PaChannelSnapshot,
  PaComposerDraft,
  PaControl,
  PaConversation,
  PaData,
  PaGroup,
  PaIndex,
  PaMemory,
  PaMemoryCandidate,
  PaMessage,
  PaModelOption,
  PaNeed,
  PaPhase,
  PaPreview,
  PaResumeBlock,
  PaSnapshot,
  PaSoulSnapshot,
  PaSubject,
  PaTask,
  PaTaskInput,
  PaTurn,
  PaWaitAction,
  PaWaitInfo,
  PaWaitKey,
  PaWorkLine,
  PersonalAgent,
  Project,
  TFn,
} from './pa-types';

type TKey = Parameters<TFn>[0];

/** SVC `terminal`. */
const TERMINAL = new Set<PaTask['status']>(['completed', 'failed', 'cancelled']);
/** Statuses that hold a conversation's single execution slot or wait for one (SVC `pump` serialises them). */
const ACTIVE = new Set<PaTask['status']>(['queued', 'running', 'verifying', 'cancelling']);
/** Stop and amend are offered only here (spec §15.3; SVC `amend` refuses terminal and cancelling). */
const STOPPABLE = new Set<PaTask['status']>(['queued', 'running', 'verifying', 'waiting']);
const MINUTE = 60_000;
const DAY = 86_400_000;
const SEPARATOR_GAP = 15 * MINUTE;

const EMPTY_LIST: never[] = [];

/** SVC `modelKey`: two agents "share a model" when runtime and model id are equal. */
function modelKey(agent: Pick<PersonalAgent, 'model'>): string {
  return `${agent.model.runtime}/${agent.model.modelId}`;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Stable ascending sort by a numeric key (ties keep snapshot order, which is the daemon's rowid order). */
function sortAsc<T>(list: T[], key: (item: T) => number): T[] {
  return list
    .map((item, order) => ({ item, order, at: key(item) }))
    .sort((a, b) => a.at - b.at || a.order - b.order)
    .map((entry) => entry.item);
}

// ---------------------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------------------

/** Builds every lookup the views need from one snapshot (and the paired soul snapshot). Callers memoise it on data
 *  identity. `locale` is the prompt locale of the UI: it names the built-in style presets. */
export function buildIndex(
  s: PaSnapshot,
  ch: PaChannelSnapshot,
  models: PaModelOption[],
  soul?: PaSoulSnapshot | null,
  locale: 'zh' | 'en' = 'zh',
): PaIndex {
  const agents = new Map(s.agents.map((agent) => [agent.id, agent]));
  const groups = new Map(s.groups.map((group) => [group.id, group]));
  const conversations = new Map(s.conversations.map((conversation) => [conversation.id, conversation]));

  const groupByConversation = new Map<string, PaGroup>();
  for (const group of s.groups) groupByConversation.set(group.conversationId, group);
  // A channel conversation routed to a group carries that group's id (SVC `channelConversation`).
  for (const conversation of s.conversations) {
    const group = conversation.groupId ? groups.get(conversation.groupId) : undefined;
    if (group && !groupByConversation.has(conversation.id)) groupByConversation.set(conversation.id, group);
  }

  const messages = new Map(s.messages.map((message) => [message.id, message]));
  const messagesByConversation = new Map<string, PaMessage[]>();
  for (const message of sortAsc(s.messages, (m) => m.createdAt)) push(messagesByConversation, message.conversationId, message);

  const tasks = new Map(s.tasks.map((task) => [task.id, task]));
  const tasksByConversation = new Map<string, PaTask[]>();
  for (const task of sortAsc(s.tasks, (t) => t.createdAt)) push(tasksByConversation, task.conversationId, task);

  const attemptsByTask = new Map<string, PaAttempt[]>();
  for (const attempt of sortAsc(s.attempts, (a) => a.startedAt)) push(attemptsByTask, attempt.taskId, attempt);

  const artifactsByTask = new Map<string, PaSnapshot['artifacts']>();
  for (const artifact of sortAsc(s.artifacts, (a) => a.createdAt)) push(artifactsByTask, artifact.taskId, artifact);

  const memories = new Map(s.memories.map((memory) => [memory.id, memory]));
  const memoryRefCount = new Map<string, number>();
  for (const message of s.messages)
    for (const ref of message.memoryRefs ?? EMPTY_LIST) memoryRefCount.set(ref.id, (memoryRefCount.get(ref.id) ?? 0) + 1);

  const modelMap = new Map(models.map((option) => [`${option.runtime}/${option.modelId}`, option]));
  const channels = new Map(ch.channels.map((channel) => [channel.id, channel]));

  // Seeded from createdAt, not updatedAt: renames and the identity migration (SVC constructor) bump a
  // conversation's updatedAt without any activity. Messages and tasks supply the real activity.
  const lastActivity = new Map<string, number>();
  const bump = (id: string, at: number) => {
    if (at > (lastActivity.get(id) ?? Number.NEGATIVE_INFINITY)) lastActivity.set(id, at);
  };
  for (const conversation of s.conversations) bump(conversation.id, conversation.createdAt);
  for (const message of s.messages) bump(message.conversationId, message.createdAt);
  for (const task of s.tasks) bump(task.conversationId, task.updatedAt);
  const activityOf = (conversation: PaConversation) => lastActivity.get(conversation.id) ?? conversation.createdAt;
  const byActivityDesc = (list: PaConversation[]) => sortAsc(list, (c) => -activityOf(c));

  const directByAgent = new Map<string, PaConversation[]>();
  for (const conversation of s.conversations)
    if (conversationKind(conversation) === 'direct' && conversation.agentId) push(directByAgent, conversation.agentId, conversation);
  // Enterprise mode: the member's own chat with an agent comes before any shared room of that agent.
  const ownFirst = (list: PaConversation[]) => [...list.filter((c) => c.principalId), ...list.filter((c) => !c.principalId)];
  for (const [agentId, list] of directByAgent) directByAgent.set(agentId, ownFirst(byActivityDesc(list)));

  // Soul layer. Chat turns never reach a work surface: those read `workTasks`; `tasks` stays complete for lookups.
  const workTasks = new Map(s.tasks.filter((task) => !isChatTask(task)).map((task) => [task.id, task]));
  const personaList = soul?.personas ?? EMPTY_LIST;
  const candidatesByMessage = new Map<string, PaMemoryCandidate[]>();
  for (const candidate of s.memoryCandidates ?? EMPTY_LIST)
    if (candidate.status === 'pending' && candidate.sourceMessageId) push(candidatesByMessage, candidate.sourceMessageId, candidate);

  const index: PaIndex = {
    agents,
    groups,
    groupByConversation,
    conversations,
    messages,
    messagesByConversation,
    tasks,
    tasksByConversation,
    attemptsByTask,
    artifactsByTask,
    memories,
    memoryRefCount,
    models: modelMap,
    channels,
    inbox: ch.inbox,
    outbox: ch.outbox,
    fantay: findFantay(s.agents),
    directByAgent,
    channelConversations: byActivityDesc(s.conversations.filter((c) => conversationKind(c) === 'channel')),
    lastActivity,
    needs: [],
    workTasks,
    characters: new Map((soul?.characters ?? EMPTY_LIST).map((character) => [character.id, character])),
    lorebooks: new Map((soul?.lorebooks ?? EMPTY_LIST).map((book) => [book.id, book])),
    personas: new Map(personaList.map((persona) => [persona.id, persona])),
    defaultPersona: personaList.find((persona) => persona.isDefault) ?? null,
    presets: new Map([...builtinPresets(locale), ...(soul?.presets ?? EMPTY_LIST)].map((preset) => [preset.id, preset])),
    chats: new Map((soul?.chats ?? EMPTY_LIST).map((chat) => [chat.id, chat])),
    candidatesByMessage,
    enterprise: s.mode === 'enterprise',
    canManageLibrary: s.mode !== 'enterprise' || s.member?.canManageLibrary === true,
  };
  index.needs = needsYou(index);
  return index;
}

/** A companion turn (`kind: 'chat'`). No work surface lists one. */
export function isChatTask(task: PaTask): boolean {
  return task.kind === 'chat';
}

// ---------------------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------------------

/** Spec §5.1: the agent wearing the `fantay` sentinel avatar, else the first agent (the daemon lists the seeded
 *  main assistant first, rows by rowid), so installs the identity migration has not reached still have one. */
export function findFantay(agents: PersonalAgent[]): PersonalAgent | null {
  return agents.find((agent) => agent.avatar === 'fantay') ?? agents[0] ?? null;
}

export function isFantay(index: PaIndex, agentId: string | null | undefined): boolean {
  return Boolean(agentId) && index.fantay?.id === agentId;
}

/** FNV-1a 32-bit of the id, folded onto the five PA identity hues (spec §5.5). Stable across sessions. */
export function hueIndex(id: string): 1 | 2 | 3 | 4 | 5 {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ((hash % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

// ---------------------------------------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------------------------------------

/** A channel conversation is a channel conversation even when it is routed to a group or an agent. */
export function conversationKind(c: PaConversation): 'direct' | 'group' | 'channel' {
  if (c.channelId) return 'channel';
  return c.groupId ? 'group' : 'direct';
}

/** Direct: the live agent name (renames propagate; the stored title is a copy taken at creation). Group: the
 *  group name. Channel: the stored title (the channel name at the time the chat arrived). */
export function conversationTitle(index: PaIndex, c: PaConversation): string {
  const kind = conversationKind(c);
  if (kind === 'direct') return (c.agentId && index.agents.get(c.agentId)?.name) || c.title;
  if (kind === 'group') return (c.groupId && index.groups.get(c.groupId)?.name) || c.title;
  return c.title;
}

/** Spec §8.1: direct → its agent; group → its group; channel → its group, else its agent. */
export function subjectOf(index: PaIndex, c: PaConversation): PaSubject | null {
  const group = c.groupId ? index.groups.get(c.groupId) : undefined;
  if (group) return { kind: 'group', group };
  const agent = c.agentId ? index.agents.get(c.agentId) : undefined;
  return agent ? { kind: 'agent', agent } : null;
}

/** Plain one-line text from Markdown, for list previews. */
export function previewText(content: string): string {
  const unwrapped = unwrapStructured(content);
  const text = unwrapped.kind === 'structured' ? unwrapped.summary : unwrapped.text;
  return text
    .replace(/```[\w-]*\n?/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function runningAttempt(attempts: readonly PaAttempt[]): PaAttempt | undefined {
  for (let i = attempts.length - 1; i >= 0; i -= 1) if (attempts[i]!.status === 'running') return attempts[i];
  return undefined;
}

/** The roster row's second line: live state first, then the last message (spec §3.3 item 6). Live states read work
 *  tasks only; the last message is the newest one in the model context (not hidden, the selected variant). Companion
 *  conversations use `soulPreview` (soul/soul-model.ts) instead. */
export function lastPreview(index: PaIndex, c: PaConversation): PaPreview {
  const tasks = index.tasksByConversation.get(c.id) ?? EMPTY_LIST;
  const latestFirst = tasks.filter((task) => !isChatTask(task)).reverse();
  const working = latestFirst.find((task) => task.status === 'running' || task.status === 'verifying');
  if (working) {
    const attempt = runningAttempt(index.attemptsByTask.get(working.id) ?? EMPTY_LIST);
    return { kind: 'working', agentId: attempt?.agentSnapshot.id ?? working.participantIds[working.nextParticipant] ?? '' };
  }
  if (latestFirst.some((task) => task.status === 'queued')) return { kind: 'queued' };
  if (latestFirst.some((task) => isNeedsYouTask(task, index.attemptsByTask.get(task.id) ?? EMPTY_LIST))) return { kind: 'needs' };
  const latest = latestFirst[0];
  if (latest?.status === 'failed') return { kind: 'failed', error: (latest.error ?? '').slice(0, 40) };
  const messages = index.messagesByConversation.get(c.id) ?? EMPTY_LIST;
  const lookup = (id: string) => index.messages.get(id);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (isInContext(message, lookup)) return { kind: 'text', text: previewText(message.content), sender: message.senderId };
  }
  return { kind: 'empty' };
}

/** Spec §6.2: messages sharing a task form one turn; a message without a task is a turn of its own; turns are
 *  ordered by their first message. A task whose messages are missing still gets a turn at its creation time.
 *  Soul rules: messages outside the model context (hidden, non-selected variants) are dropped; a message of a chat
 *  task, or of a task missing from the snapshot (finished chat tasks are left out), is a turn of its own. */
export function buildTurns(index: PaIndex, conversationId: string): PaTurn[] {
  const turns: PaTurn[] = [];
  const byTask = new Map<string, PaTurn>();
  const turnFor = (taskId: string, startedAt: number): PaTurn => {
    let turn = byTask.get(taskId);
    if (!turn) {
      turn = {
        key: `t:${taskId}`,
        task: index.tasks.get(taskId) ?? null,
        messages: [],
        attempts: index.attemptsByTask.get(taskId) ?? [],
        artifacts: index.artifactsByTask.get(taskId) ?? [],
        startedAt,
      };
      byTask.set(taskId, turn);
      turns.push(turn);
    }
    return turn;
  };
  const lookup = (id: string) => index.messages.get(id);
  for (const message of index.messagesByConversation.get(conversationId) ?? EMPTY_LIST) {
    if (!isInContext(message, lookup)) continue;
    const task = message.taskId ? index.tasks.get(message.taskId) : undefined;
    if (task && !isChatTask(task)) turnFor(task.id, message.createdAt).messages.push(message);
    else turns.push({ key: `m:${message.id}`, task: null, messages: [message], attempts: [], artifacts: [], startedAt: message.createdAt });
  }
  for (const task of index.tasksByConversation.get(conversationId) ?? EMPTY_LIST)
    if (!isChatTask(task)) turnFor(task.id, task.createdAt);
  return sortAsc(turns, (turn) => turn.startedAt);
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** True for the first message, a new local day, or a gap of ≥ 15 minutes. */
export function needsSeparator(prevAt: number | null, at: number): boolean {
  if (prevAt === null) return true;
  if (!sameLocalDay(prevAt, at)) return true;
  return at - prevAt >= SEPARATOR_GAP;
}

function fmt(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

/** Spec §6.2 separator labels: today / yesterday (i18n keys), this week (weekday + time), this year (month day
 *  + time), earlier (full date). Everything except the two keys comes from Intl in the active locale. */
export function separatorLabel(at: number, now: number, locale: string, t: TFn): string {
  const time = fmt(locale, CLOCK).format(at);
  const today = startOfLocalDay(now);
  if (at >= today) return t('pa.time.today', { time });
  if (at >= today - DAY) return t('pa.time.yesterday', { time });
  // Weekday and clock are joined by hand: zh-CN's combined pattern drops the space (周五18:30).
  if (at >= today - 6 * DAY) return `${fmt(locale, { weekday: 'short' }).format(at)} ${time}`;
  if (new Date(at).getFullYear() === new Date(now).getFullYear())
    return fmt(locale, { month: 'short', day: 'numeric', ...CLOCK }).format(at);
  return fmt(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(at);
}

/** Spec §3.3 roster time: today `14:05`, this week `周二`, older `11月3日` (with the year when not this year). */
export function formatRowTime(at: number, now: number, locale: string): string {
  const today = startOfLocalDay(now);
  if (at >= today) return fmt(locale, CLOCK).format(at);
  if (at >= today - 6 * DAY) return fmt(locale, { weekday: 'short' }).format(at);
  if (new Date(at).getFullYear() === new Date(now).getFullYear()) return fmt(locale, { month: 'short', day: 'numeric' }).format(at);
  return fmt(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(at);
}

// ---------------------------------------------------------------------------------------------------------
// Task semantics (spec §15)
// ---------------------------------------------------------------------------------------------------------

/** Mirror of the phase choice in SVC `run`: the review step is the last participant when the task requires
 *  review (`reviewRequired`, set at submit for projects and multi-member review-mode groups); a project's
 *  second-to-last participant produces files; everyone else responds. A running attempt's own phase wins. */
export function taskPhase(task: PaTask, index: PaIndex): PaPhase {
  const attempt = runningAttempt(index.attemptsByTask.get(task.id) ?? EMPTY_LIST);
  if (attempt) return attempt.phase;
  const total = task.participantIds.length;
  const step = task.nextParticipant;
  const group = index.groupByConversation.get(task.conversationId);
  const reviewRequired = task.reviewRequired ?? (task.kind === 'project' || (group?.mode === 'review' && total > 1));
  if (reviewRequired && step === total - 1) return 'review';
  if (task.kind === 'project' && step === total - 2) return 'produce';
  return 'respond';
}

/** The working line of an active turn (spec §15.1). Null for tasks that are not queued, running, verifying
 *  or cancelling. */
export function workLine(task: PaTask, index: PaIndex, control: PaControl | null): PaWorkLine | null {
  if (task.status === 'cancelling') return { kind: 'stopping', unknown: task.stopConfirmation === 'unknown' };
  if (task.status === 'queued') {
    // SVC `pump`: a task waits while an earlier task of the same conversation still holds or awaits the slot.
    const blocked = (index.tasksByConversation.get(task.conversationId) ?? EMPTY_LIST).some(
      (other) => other.id !== task.id && ACTIVE.has(other.status) && other.createdAt < task.createdAt,
    );
    const max = control?.maxConcurrent ?? null;
    if (blocked) return { kind: 'queued', reason: 'conversation', max };
    if (control && control.activeCount >= control.maxConcurrent) return { kind: 'queued', reason: 'concurrency', max };
    return { kind: 'queued', reason: 'none', max };
  }
  if (task.status === 'running' || task.status === 'verifying') {
    const attempt = runningAttempt(index.attemptsByTask.get(task.id) ?? EMPTY_LIST);
    return {
      kind: 'step',
      agentId: attempt?.agentSnapshot.id ?? task.participantIds[task.nextParticipant] ?? '',
      phase: taskPhase(task, index),
      step: task.nextParticipant + 1,
      total: task.participantIds.length,
      nextAgentId: task.participantIds[task.nextParticipant + 1] ?? null,
      startedAt: attempt?.startedAt ?? task.updatedAt,
    };
  }
  return null;
}

/** Why Resume would be refused, in the order SVC `resume` checks (revoked, unknown stop / interrupted run,
 *  still running, attempt cap). Status is not part of the answer; `canResume` adds it. */
export function resumeBlock(task: PaTask, attempts: PaAttempt[]): PaResumeBlock | null {
  if (task.authorization.revoked) return 'revoked';
  if (task.stopConfirmation === 'unknown' || attempts.some((a) => a.status === 'interrupted')) return 'unconfirmed';
  if (attempts.some((a) => a.status === 'running')) return 'running';
  const max = task.budget?.maxAttempts;
  if (max !== undefined && attempts.length >= max) return 'cap';
  return null;
}

export function timeBudgetSpent(task: PaTask, attempts: readonly PaAttempt[]): boolean {
  return paRemainingTime(task, attempts) <= 0;
}

/** SVC `resume` admits only waiting or failed tasks with budget remaining and no execution conflict. */
export function canResume(task: PaTask, attempts: PaAttempt[]): boolean {
  return (
    (task.status === 'waiting' || task.status === 'failed') &&
    resumeBlock(task, attempts) === null &&
    !timeBudgetSpent(task, attempts)
  );
}

/** Mirror of the agent check in SVC `assertAuthorized`: enabled, allowed to respond, and allowed to create
 *  projects when the task is a project. An agent that no longer exists cannot serve either. */
export function agentCanServe(agent: PersonalAgent | undefined, kind: PaTask['kind']): boolean {
  if (!agent || !agent.enabled || !agent.tools.includes('respond')) return false;
  return kind !== 'project' || agent.tools.includes('create_project');
}

/** The first of `participantIds` that SVC `assertAuthorized` would refuse, or null when every one can serve. */
export function unavailableParticipant(
  agents: ReadonlyMap<string, PersonalAgent>,
  participantIds: readonly string[],
  kind: PaTask['kind'],
): string | null {
  return participantIds.find((id) => !agentCanServe(agents.get(id), kind)) ?? null;
}

/** Mirror of SVC `reconcileTask`: it does work only when the stop is unconfirmed or an attempt was
 *  interrupted; completed and cancelled tasks are past reconciling. */
export function needsReconcile(task: PaTask, attempts: PaAttempt[]): boolean {
  if (task.status === 'completed' || task.status === 'cancelled') return false;
  return task.stopConfirmation === 'unknown' || attempts.some((a) => a.status === 'interrupted');
}

/** The daemon never clears `waitKind` on resume (SVC `resume`), and later wait writers keep the stale value
 *  (SVC run catch: `waitKind: task.waitKind ?? …`). Trust a stored pause/sleep kind only while the current
 *  reason still says so (SVC `pauseWork` writes '…已暂停…' / '设备休眠…'). Every UI reader of `waitKind` goes
 *  through this. */
export function effectiveWaitKind(task: PaTask): PaTask['waitKind'] | undefined {
  if (task.status !== 'waiting') return undefined;
  const kind = task.waitKind;
  const reason = task.waitingReason ?? '';
  if (kind === 'paused') return reason.includes('已暂停') ? 'paused' : undefined;
  if (kind === 'device') return reason.startsWith('设备休眠') ? 'device' : undefined;
  return kind;
}

/** Reasons only SVC `reconcileTask` writes, after it checked the old executor (or found none). */
const RECONCILED_REASON = /^(?:旧执行者已退出|未发现已启动的执行尝试)/;

/** Spec §15.2 + addendum §C.1. Takes the first matching rule. The daemon keeps the last `waitKind` through
 *  resume and later waits (SVC `resume`, SVC `run` catch), so the kind is read through `effectiveWaitKind`
 *  and the reason-specific rules (review, revoked, amended, memory) come before the kinds that can be stale
 *  (budget, login). Actions that need Resume become Start again when the daemon would refuse it, or when the
 *  time budget is spent (`canResume`); Stop and Amend are dropped for statuses that cannot take them.
 *
 *  Pass `index` (or anything with the live `agents`) so a wait caused by a disabled or de-permissioned agent
 *  offers Resume once every participant can serve again; without it that wait keeps Open agent + Stop. */
export function waitInfo(task: PaTask, attempts: PaAttempt[], index?: Pick<PaIndex, 'agents'> | null): PaWaitInfo {
  const kind = effectiveWaitKind(task);
  const reason = task.waitingReason;
  const resumable = canResume(task, attempts);
  const finish = (key: PaWaitKey, actions: PaWaitAction[], reasonText: string | null = reason): PaWaitInfo => {
    const out: PaWaitAction[] = [];
    for (const action of actions) {
      const next = (action === 'resume' || action === 'continueReview') && !resumable ? 'startAgain' : action;
      if ((next === 'stop' || next === 'amend') && !STOPPABLE.has(task.status)) continue;
      if (!out.includes(next)) out.push(next);
    }
    return { key, reasonText, actions: out };
  };
  if (task.stopConfirmation === 'unknown' || attempts.some((a) => a.status === 'interrupted') || kind === 'external_result')
    return finish('unconfirmed', ['reconcile', 'startAgain', 'stop']);
  if (kind === 'paused') return finish('paused', ['resumeFantay']);
  if (kind === 'device') return finish('device', []);
  if (reason?.startsWith('审阅发现')) {
    const colon = reason.indexOf('：');
    return finish('review', ['continueReview', 'amend', 'stop'], colon >= 0 ? reason.slice(colon + 1) : reason);
  }
  // SVC `updateAgent` / `assertAuthorized` write this reason but never revoke the task, so `resume` accepts it.
  // While a participant still cannot serve, the run would stop at it again: point at the agent. Once all can
  // serve (the owner re-enabled it), the stale reason no longer blocks anything and the later rules decide.
  // Checked before `amended`: resuming an amended task would fail the same way while an agent is unavailable.
  if (
    reason?.includes('已停用或权限已撤销') &&
    (!index || unavailableParticipant(index.agents, task.participantIds, task.kind) !== null)
  )
    return finish('revoked', ['openAgent', 'stop']);
  if (task.amendments.some((a) => a.appliedAt === null)) return finish('amended', ['resume']);
  if (reason?.startsWith('相关记忆')) return finish('memory', ['resume']);
  // A spent time budget reads as a budget wait whatever kind the daemon kept (SVC `run` catch keeps an older
  // kind); `finish` turns its Resume into Start again (`canResume`).
  if (kind === 'budget' || timeBudgetSpent(task, attempts)) return finish('budget', ['resume']);
  if (kind === 'login') return finish('login', ['modelSettings', 'resume']);
  // Addendum §C.1 "recovered": only with evidence that a reconcile ran (its reason). SVC `run` catch also
  // writes waitKind 'recovery' + stopConfirmation 'confirmed' for any interrupted run, which was never checked.
  if (task.stopConfirmation === 'confirmed' && RECONCILED_REASON.test(reason ?? ''))
    return finish('recovered', ['resume', 'stop']);
  return finish('other', ['resume', 'amend', 'stop']);
}

/** When an untouched wait ends (SVC `expireWaitingTasks`): the daemon's own `expiresAt` when it writes one,
 *  else `(waitingSince ?? updatedAt) + waitingExpiryMs`, as the daemon computes it (several wait writers never
 *  set `waitingSince`). Never for paused, device or unconfirmed waits, which do not expire. The paused/device
 *  test reads the stored `waitKind` on purpose: SVC `expireWaitingTasks` skips on it even when it is stale, so
 *  such a wait really never expires. */
export function expiresAt(task: PaTask, control: PaControl | null): number | null {
  if (task.status !== 'waiting') return null;
  if (task.waitKind === 'paused' || task.waitKind === 'device') return null;
  if (task.stopConfirmation === 'unknown' || task.waitKind === 'external_result') return null;
  if (typeof task.expiresAt === 'number') return task.expiresAt;
  if (!control) return null;
  return (task.waitingSince ?? task.updatedAt) + control.waitingExpiryMs;
}

/** Spec §3.4: waiting tasks that need the owner (live paused/device waits resume on their own), plus failed
 *  tasks the daemon would resume or that need their interrupted run checked first (SVC `reconcileTask`
 *  accepts failed tasks). */
export function isNeedsYouTask(task: PaTask, attempts: PaAttempt[]): boolean {
  if (task.status === 'waiting') {
    const kind = effectiveWaitKind(task);
    return kind !== 'paused' && kind !== 'device';
  }
  return task.status === 'failed' && (canResume(task, attempts) || needsReconcile(task, attempts));
}

/** Spec §3.4: channel approvals, then uncertain deliveries, then tasks; each group newest first. */
export function needsYou(index: PaIndex): PaNeed[] {
  const channel = (id: string): PaChannel | null => index.channels.get(id) ?? null;
  const approvals = sortAsc(
    index.inbox.filter((row) => row.state === 'approval' && row.approvalActionable !== false),
    (row) => -row.receivedAt,
  ).map((inbox): PaNeed => ({ kind: 'approval', inbox, channel: channel(inbox.channelId) }));
  const deliveries = sortAsc(
    index.outbox.filter((row) => row.state === 'unknown' || row.state === 'failed'),
    (row) => -row.updatedAt,
  ).map((outbox): PaNeed => ({ kind: 'delivery', outbox, channel: channel(outbox.channelId) }));
  const tasks = sortAsc(
    [...index.workTasks.values()].filter((task) => isNeedsYouTask(task, index.attemptsByTask.get(task.id) ?? EMPTY_LIST)),
    (task) => -(task.waitingSince ?? task.updatedAt),
  ).map((task): PaNeed => ({ kind: 'task', task }));
  return [...approvals, ...deliveries, ...tasks];
}

// ---------------------------------------------------------------------------------------------------------
// Composer (spec §7, §15.4)
// ---------------------------------------------------------------------------------------------------------

function groupOf(index: PaIndex, c: PaConversation): PaGroup | null {
  return index.groupByConversation.get(c.id) ?? (c.groupId ? index.groups.get(c.groupId) ?? null : null);
}

/** SVC `participants` ordering: with more than one participant in a project or review-mode group, the
 *  moderator and reviewer go last (moderator, then reviewer). */
function orderParticipants(group: PaGroup | null, selected: string[], project: boolean): string[] {
  if (!group || selected.length <= 1 || !(project || group.mode === 'review')) return selected;
  const reviewer = group.reviewerId ?? group.memberIds.filter((id) => id !== group.moderatorId).at(-1);
  if (!reviewer || !selected.includes(reviewer) || !selected.includes(group.moderatorId)) return selected;
  return [...selected.filter((id) => id !== reviewer && id !== group.moderatorId), group.moderatorId, reviewer];
}

/** Mirror of SVC `participants` for a send with `targetAgentIds: []`: the reply target's agent, else the
 *  `@name` mentions, else everyone (project, collaboration, review, or `@全体`), else the moderator. */
export function predictResponders(
  index: PaIndex,
  c: PaConversation,
  d: Pick<PaComposerDraft, 'text' | 'replyTo' | 'project'>,
): { ids: string[]; reviewerId: string | null; ordered: boolean } {
  const group = groupOf(index, c);
  const members = group?.memberIds ?? (c.agentId ? [c.agentId] : []);
  const project = d.project;
  const goal = d.text.trim();
  let selected: string[] = [];
  const parent = d.replyTo ? index.messages.get(d.replyTo) : undefined;
  if (parent && parent.senderId !== 'owner') selected = [parent.senderId];
  if (!selected.length)
    selected = members.filter((id) => {
      const name = index.agents.get(id)?.name;
      return Boolean(name) && goal.includes(`@${name}`);
    });
  if (!selected.length) {
    const everyone = project || group?.mode === 'collaboration' || group?.mode === 'review' || goal.includes('@全体');
    const lead = group?.moderatorId ?? members[0];
    selected = everyone ? [...members] : lead ? [lead] : [];
  }
  const ids = orderParticipants(group, selected, project);
  const reviewed = ids.length > 1 && (project || group?.mode === 'review');
  return { ids, reviewerId: reviewed ? ids[ids.length - 1]! : null, ordered: ids.length > 1 };
}

/** Mirror of the project checks in SVC `participants`: groups only, at least two participants, and the
 *  producer (second-to-last) and reviewer (last) on different models. Then the run-time check of SVC
 *  `assertAuthorized`, which a project runs for every participant: each must be enabled with `respond` and
 *  `create_project`, else the submit is accepted and the run stops partway (`unavailable`, first such agent). */
export function projectGate(
  index: PaIndex,
  c: PaConversation,
):
  | { ok: true; producerId: string; reviewerId: string }
  | { ok: false; reason: 'notGroup' | 'members' | 'sameModel' }
  | { ok: false; reason: 'unavailable'; agentId: string } {
  const group = conversationKind(c) === 'group' ? groupOf(index, c) : null;
  if (!group) return { ok: false, reason: 'notGroup' };
  const ids = orderParticipants(group, [...group.memberIds], true);
  if (ids.length < 2) return { ok: false, reason: 'members' };
  const producerId = ids[ids.length - 2]!;
  const reviewerId = ids[ids.length - 1]!;
  const producer = index.agents.get(producerId);
  const reviewer = index.agents.get(reviewerId);
  if (!producer || !reviewer) return { ok: false, reason: 'members' };
  if (modelKey(producer) === modelKey(reviewer)) return { ok: false, reason: 'sameModel' };
  const unavailable = unavailableParticipant(index.agents, ids, 'project');
  if (unavailable !== null) return { ok: false, reason: 'unavailable', agentId: unavailable };
  return { ok: true, producerId, reviewerId };
}

/** An `@` at the start of the text or after whitespace, with no whitespace between it and the caret. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const end = Math.max(0, Math.min(caret, text.length));
  for (let i = end - 1; i >= 0; i -= 1) {
    const c = text[i]!;
    if (/\s/.test(c)) return null;
    if (c === '@') {
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null;
      return { start: i, query: text.slice(i + 1, end) };
    }
  }
  return null;
}

export function newRequestId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `pa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Spec §7.2: an identical body reuses the stored request id (the daemon's idempotency key, SVC `submit`),
 *  so a retry after a lost response never creates a second task; any change gets a fresh id. */
export function requestFor(draft: PaComposerDraft, body: Omit<PaTaskInput, 'requestId'>): { id: string; fingerprint: string } {
  const fingerprint = JSON.stringify(body);
  if (draft.request && draft.request.fingerprint === fingerprint) return draft.request;
  return { id: newRequestId(), fingerprint };
}

// ---------------------------------------------------------------------------------------------------------
// Budget, usage, structured replies (spec §15.5, §6.3)
// ---------------------------------------------------------------------------------------------------------

/** Mirror of the time budget in SVC `run`: the sum of each attempt's duration (its recorded `durationMs`
 *  when the daemon wrote one, else end − start, with `now` for a running attempt). */
export function budgetUse(
  task: PaTask,
  attempts: PaAttempt[],
  now: number,
): { attempts: number; maxAttempts: number | null; usedMs: number; timeoutMs: number | null } {
  const usedMs = attempts.reduce((sum, attempt) => {
    const recorded = (attempt as PaAttempt & { durationMs?: number }).durationMs;
    const ms = typeof recorded === 'number' ? recorded : (attempt.endedAt ?? now) - attempt.startedAt;
    return sum + Math.max(0, ms);
  }, 0);
  return {
    attempts: attempts.length,
    maxAttempts: task.budget?.maxAttempts ?? null,
    usedMs,
    timeoutMs: task.budget?.timeoutMs ?? null,
  };
}

/** Token totals; cost only when every attempt reported one; `unknown` when any attempt's usage was not
 *  reported, or was reported without both token counts (Ollama omits `prompt_eval_count` for a cached
 *  prompt), so missing counts are never shown as zero. */
export function usageSummary(attempts: PaAttempt[]): { inputTokens: number; outputTokens: number; costUsd: string | null; unknown: boolean } {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let costKnown = attempts.length > 0;
  let unknown = false;
  for (const attempt of attempts) {
    const usage = attempt.usage;
    if (!usage || usage.visibility === 'unknown' || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens))
      unknown = true;
    inputTokens += usage?.inputTokens ?? 0;
    outputTokens += usage?.outputTokens ?? 0;
    const value = usage?.costUsd === undefined ? Number.NaN : Number(usage.costUsd);
    if (Number.isFinite(value)) cost += value;
    else costKnown = false;
  }
  return { inputTokens, outputTokens, costUsd: costKnown ? String(Number(cost.toFixed(6))) : null, unknown };
}

/** A reply that is a JSON object with a string `summary` (review and produce steps, SVC `run`) shows as its
 *  summary, issues and verdict; anything else is text. Code fences around the JSON are tolerated. */
export function unwrapStructured(
  content: string,
): { kind: 'text'; text: string } | { kind: 'structured'; summary: string; issues: string[]; approved: boolean | null } {
  const trimmed = content.trim();
  const body = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!body.startsWith('{')) return { kind: 'text', text: content };
  try {
    const data: unknown = JSON.parse(body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { kind: 'text', text: content };
    const record = data as Record<string, unknown>;
    if (typeof record.summary !== 'string') return { kind: 'text', text: content };
    const issues = Array.isArray(record.issues) ? record.issues.filter((item): item is string => typeof item === 'string') : [];
    return { kind: 'structured', summary: record.summary, issues, approved: typeof record.approved === 'boolean' ? record.approved : null };
  } catch {
    return { kind: 'text', text: content };
  }
}

/** A memory's scope as words, never an id: 私有 / 智能体 · 审阅者 / 群组 · 协作工作室 / 项目 · 名称. A target that
 *  no longer exists reads "Deleted target". Project names come from the projects list, else a task's name. */
export function memoryScopeName(index: PaIndex, m: PaMemory, projects: readonly Project[], t: TFn): string {
  if (m.scope === 'private') return t('pa.scope.private');
  const id = m.scopeId;
  if (!id) return t('pa.scope.deleted');
  if (m.scope === 'agent') {
    const agent = index.agents.get(id);
    return agent ? t('pa.scope.agent', { name: agent.name }) : t('pa.scope.deleted');
  }
  if (m.scope === 'group') {
    const group = index.groups.get(id);
    return group ? t('pa.scope.group', { name: group.name }) : t('pa.scope.deleted');
  }
  const project = projects.find((p) => p.id === id);
  const name = project?.name ?? [...index.tasks.values()].find((task) => task.projectId === id)?.projectName;
  return name ? t('pa.scope.project', { name }) : t('pa.scope.deleted');
}

/** Does the task involve this subject? Agents: a participant or the owner of the conversation. Groups: any
 *  conversation routed to the group (its own chat and channel chats bound to it). */
function involves(index: PaIndex, task: PaTask, subject: PaSubject): boolean {
  const conversation = index.conversations.get(task.conversationId);
  if (subject.kind === 'agent') return task.participantIds.includes(subject.agent.id) || conversation?.agentId === subject.agent.id;
  return conversation?.groupId === subject.group.id || index.groupByConversation.get(task.conversationId)?.id === subject.group.id;
}

/** The inspector's work list: this conversation's tasks, or every task involving the subject. Newest
 *  activity first. Work tasks only (chat turns are not tasks to the owner). */
export function tasksForSubject(index: PaIndex, subject: PaSubject, scope: 'conversation' | 'all', conversationId: string): PaTask[] {
  const list =
    scope === 'conversation'
      ? (index.tasksByConversation.get(conversationId) ?? EMPTY_LIST).filter((task) => !isChatTask(task) && involves(index, task, subject))
      : [...index.workTasks.values()].filter((task) => involves(index, task, subject));
  return sortAsc(list, (task) => -task.updatedAt);
}

/** Channel rows (approvals, deliveries) that belong to the subject: the channel routes to it. For Fantay,
 *  rows whose channel cannot be resolved are included too (spec §8.5). */
function needTargetsSubject(index: PaIndex, need: PaNeed, subject: PaSubject): boolean {
  if (need.kind === 'task') return involves(index, need.task, subject);
  const channel = need.channel;
  if (!channel) return subject.kind === 'agent' && isFantay(index, subject.agent.id);
  return subject.kind === 'agent'
    ? channel.targetKind === 'agent' && channel.targetId === subject.agent.id
    : channel.targetKind === 'group' && channel.targetId === subject.group.id;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/** The subject's status line (spec §8.2), first match wins; it also feeds the roster's Fantay card. The
 *  result is a key into the shell dictionary plus its variables. */
export function agentStatus(index: PaIndex, data: Pick<PaData, 'control' | 'load'>, subject: PaSubject): PaAgentStatus {
  if (data.load === 'offline') return { tone: 'muted', key: 'pa.status.offline', vars: {} };
  if (subject.kind === 'agent' && !subject.agent.enabled) return { tone: 'muted', key: 'pa.disabled', vars: {} };
  if (data.control?.paused) return { tone: 'muted', key: 'pa.status.paused', vars: {} };
  if (data.control?.suspended) return { tone: 'muted', key: 'pa.status.asleep', vars: {} };
  const needs = index.needs.filter((need) => needTargetsSubject(index, need, subject)).length;
  if (needs > 0) return { tone: 'warning', key: 'pa.status.needs', vars: { count: needs } };
  const mine = tasksForSubject(index, subject, 'all', '');
  const working = mine.find((task) => task.status === 'running' || task.status === 'verifying');
  if (working) {
    const reviewing = working.status === 'verifying' || taskPhase(working, index) === 'review';
    return { tone: 'running', key: reviewing ? 'pa.status.reviewing' : 'pa.status.working', vars: { goal: clip(working.goal, 18) } };
  }
  const queued = mine.filter((task) => task.status === 'queued').length;
  if (queued > 0) return { tone: 'idle', key: 'pa.status.queued', vars: { count: queued } };
  return { tone: 'done', key: 'pa.status.idle', vars: {} };
}

/** Renders an `agentStatus` result. */
export function statusText(status: PaAgentStatus, t: TFn): string {
  return t(status.key as TKey, status.vars);
}

// ---------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------

export function formatDuration(ms: number, t: TFn): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return t('pa.dur.seconds', { s: total });
  if (total < 3600) return t('pa.dur.minutes', { m: Math.floor(total / 60), s: total % 60 });
  return t('pa.dur.hours', { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60) });
}

/** 1234 → 1.2k, 1500000 → 1.5M (en and zh alike). */
export function formatTokens(n: number): string {
  const value = Math.max(0, Math.round(n));
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** KB with one decimal (MB once a file passes 1024 KB). */
export function formatBytes(n: number): string {
  const kb = Math.max(0, n) / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** True while a task occupies or awaits its conversation's execution slot. */
export function isActiveTask(task: PaTask): boolean {
  return ACTIVE.has(task.status);
}

/** True for completed, failed and cancelled tasks. */
export function isTerminalTask(task: PaTask): boolean {
  return TERMINAL.has(task.status);
}

export type { TKey as PaTKey };
