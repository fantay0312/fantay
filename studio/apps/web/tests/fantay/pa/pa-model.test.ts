// SPDX-License-Identifier: Apache-2.0
// Pure Fantay workspace rules (spec §15, §20.2): resume eligibility, wait causes, reconcile, separators,
// responder prediction, the project gate, mentions, request identity, identity helpers and budgets.
import { describe, expect, it } from 'vitest';
import type {
  PaAttempt,
  PaChannelSnapshot,
  PaControl,
  PaConversation,
  PaGroup,
  PaMemory,
  PaMessage,
  PaSnapshot,
  PaTask,
  PersonalAgent,
} from '@open-design/contracts';

import {
  agentCanServe,
  agentStatus,
  budgetUse,
  buildIndex,
  buildTurns,
  canResume,
  conversationKind,
  conversationTitle,
  effectiveWaitKind,
  expiresAt,
  findFantay,
  formatBytes,
  formatDuration,
  formatTokens,
  hueIndex,
  isNeedsYouTask,
  lastPreview,
  memoryScopeName,
  mentionQuery,
  needsReconcile,
  needsSeparator,
  needsYou,
  predictResponders,
  projectGate,
  requestFor,
  resumeBlock,
  separatorLabel,
  subjectOf,
  taskPhase,
  timeBudgetSpent,
  unavailableParticipant,
  unwrapStructured,
  usageSummary,
  waitInfo,
  workLine,
} from '../../../src/fantay/pa/pa-model';
import type { PaComposerDraft, TFn } from '../../../src/fantay/pa/pa-types';

const stamp = { createdAt: 1, updatedAt: 1, revision: 1 };
const NO_CHANNELS: PaChannelSnapshot = { channels: [], inbox: [], outbox: [] };

/** A translator that echoes the key and its variables, so tests read which copy was chosen. */
const t = ((key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}${JSON.stringify(vars)}` : key) as unknown as TFn;

function agent(id: string, name: string, extra: Partial<PersonalAgent> = {}): PersonalAgent {
  return {
    ...stamp,
    id,
    name,
    avatar: '',
    role: 'role',
    enabled: true,
    tools: ['respond', 'create_project'],
    model: { runtime: 'claude', modelId: 'sonnet' },
    ...extra,
  };
}

function task(extra: Partial<PaTask> = {}): PaTask {
  return {
    ...stamp,
    id: 't1',
    requestId: 'request-1',
    conversationId: 'direct',
    goal: 'Write a brief',
    kind: 'discussion',
    projectName: '',
    projectId: null,
    projectConversationId: null,
    status: 'waiting',
    waitingReason: null,
    error: null,
    participantIds: ['a'],
    nextParticipant: 0,
    budget: { maxAttempts: 3, timeoutMs: 300000 },
    authorization: { localProject: false, externalWrites: false, version: 1, revoked: false },
    amendments: [],
    evidence: [],
    ...extra,
  };
}

function attempt(extra: Partial<PaAttempt> = {}): PaAttempt {
  return {
    ...stamp,
    id: 'att1',
    taskId: 't1',
    runId: 'run1',
    nodeId: 'local',
    protocolVersion: 1,
    agentSnapshot: agent('a', 'Writer'),
    phase: 'respond',
    status: 'completed',
    taskRevision: 1,
    startedAt: 1000,
    endedAt: 4000,
    output: '',
    error: null,
    usage: { inputTokens: 100, outputTokens: 50, visibility: 'reported' },
    ...extra,
  };
}

function message(id: string, extra: Partial<PaMessage> = {}): PaMessage {
  return {
    ...stamp,
    id,
    conversationId: 'direct',
    taskId: null,
    senderId: 'owner',
    content: 'hello',
    targetAgentIds: [],
    replyTo: null,
    ...extra,
  };
}

const writer = agent('a', 'Writer');
const reviewer = agent('b', 'Reviewer', { model: { runtime: 'claude', modelId: 'haiku' } });
const researcher = agent('c', 'Researcher', { model: { runtime: 'ollama', modelId: 'qwen' } });

function group(extra: Partial<PaGroup> = {}): PaGroup {
  return {
    ...stamp,
    id: 'g',
    name: 'Studio',
    memberIds: ['a', 'b'],
    moderatorId: 'a',
    mode: 'discussion',
    conversationId: 'group-chat',
    ...extra,
  };
}

const direct: PaConversation = { ...stamp, id: 'direct', title: 'Writer', agentId: 'a', groupId: null };
const groupChat: PaConversation = { ...stamp, id: 'group-chat', title: 'Studio', agentId: null, groupId: 'g' };

function snapshot(extra: Partial<PaSnapshot> = {}): PaSnapshot {
  return {
    agents: [writer, reviewer, researcher],
    groups: [group()],
    conversations: [direct, groupChat],
    messages: [],
    tasks: [],
    attempts: [],
    artifacts: [],
    memories: [],
    node: { id: 'local', protocolVersion: 1, location: 'local', available: true, capabilities: [], heartbeatAt: 1 },
    ...extra,
  };
}

const control: PaControl = {
  ...stamp,
  id: 'control',
  backgroundEnabled: true,
  paused: false,
  suspended: false,
  maxConcurrent: 2,
  defaultMaxAttempts: 6,
  defaultTimeoutMs: 300000,
  waitingExpiryMs: 86_400_000,
  activeCount: 0,
  pendingCount: 0,
  lastResumeAt: null,
};

/** Wait reasons as SVC `pauseWork` writes them. */
const PAUSED_REASON = 'PA 已暂停，等待恢复';
const DEVICE_REASON = '设备休眠，等待唤醒后核对';
/** A legacy timed-out run can have uncounted gaps between attempts. */
const timedOut = [attempt({ id: '1', startedAt: 0, endedAt: 150_000 }), attempt({ id: '2', startedAt: 151_000, endedAt: 299_000, error: '本次执行达到时间上限；已有成果保留' })];

const draft = (extra: Partial<PaComposerDraft> = {}): PaComposerDraft => ({
  text: '',
  replyTo: null,
  project: false,
  projectName: '',
  request: null,
  ...extra,
});

describe('canResume / resumeBlock', () => {
  it('allows waiting and failed tasks with nothing blocking', () => {
    expect(canResume(task(), [attempt()])).toBe(true);
    expect(canResume(task({ status: 'failed' }), [attempt({ status: 'failed' })])).toBe(true);
    expect(resumeBlock(task(), [attempt()])).toBeNull();
  });

  it('refuses statuses the daemon never resumes', () => {
    for (const status of ['queued', 'running', 'verifying', 'completed', 'cancelling', 'cancelled'] as const)
      expect(canResume(task({ status }), [])).toBe(false);
  });

  it('reports each block in the daemon order', () => {
    const revoked = task({ authorization: { localProject: false, externalWrites: false, version: 2, revoked: true } });
    expect(resumeBlock(revoked, [attempt({ status: 'interrupted' })])).toBe('revoked');
    expect(resumeBlock(task({ stopConfirmation: 'unknown' }), [])).toBe('unconfirmed');
    expect(resumeBlock(task(), [attempt({ status: 'interrupted' })])).toBe('unconfirmed');
    expect(resumeBlock(task(), [attempt({ status: 'running', endedAt: null })])).toBe('running');
    const capped = [attempt({ id: '1' }), attempt({ id: '2' }), attempt({ id: '3' })];
    expect(resumeBlock(task(), capped)).toBe('cap');
    expect(canResume(task(), capped)).toBe(false);
    expect(canResume(revoked, [])).toBe(false);
  });

  it('refuses a task whose time budget is spent (its resumed run would stop at once)', () => {
    expect(resumeBlock(task(), timedOut)).toBeNull(); // Time budget is checked separately.
    expect(canResume(task(), timedOut)).toBe(false);
    expect(canResume(task({ status: 'failed', error: '等待已超过设定期限；目标和已有成果保留，可手动恢复' }), timedOut)).toBe(false);
    expect(canResume(task({ waitingReason: '本次执行达到时间上限；已有成果保留' }), [attempt()])).toBe(false);
  });
});

describe('timeBudgetSpent', () => {
  it('uses exact recorded duration and recognizes a persisted timeout', () => {
    expect(timeBudgetSpent(task(), [attempt()])).toBe(false);
    expect(timeBudgetSpent(task(), timedOut)).toBe(true);
    const recorded = attempt({ startedAt: 0, endedAt: 10, durationMs: 300_000 });
    expect(timeBudgetSpent(task(), [recorded])).toBe(true);
    // Attempts the daemon left without an end count as zero, as in SVC run.
    expect(timeBudgetSpent(task(), [attempt({ status: 'failed', startedAt: 0, endedAt: null })])).toBe(false);
    expect(timeBudgetSpent(task({ budget: { maxAttempts: 3, timeoutMs: 1000 } }), [])).toBe(false);
    expect(timeBudgetSpent(task({ budget: { maxAttempts: 3, timeoutMs: 1000 } }), [attempt({ startedAt: 0, endedAt: 960 })])).toBe(false);
    expect(timeBudgetSpent(task({ timeBudgetExhausted: true }), [])).toBe(true);
  });

  it('trusts the daemon texts for either time-limit failure', () => {
    expect(timeBudgetSpent(task({ waitingReason: '本次执行达到时间上限；已有成果保留' }), [])).toBe(true);
    expect(timeBudgetSpent(task({ status: 'failed', error: '本任务累计执行时间已达到上限，请新建任务' }), [])).toBe(true);
    expect(timeBudgetSpent(task({ waitingReason: '已达到本任务尝试次数上限' }), [])).toBe(false);
  });
});

describe('effectiveWaitKind', () => {
  it('trusts a pause or sleep kind only while the reason still says so', () => {
    expect(effectiveWaitKind(task({ waitKind: 'paused', waitingReason: PAUSED_REASON }))).toBe('paused');
    expect(effectiveWaitKind(task({ waitKind: 'paused', waitingReason: 'Fantay 已暂停，等待恢复' }))).toBe('paused');
    expect(effectiveWaitKind(task({ waitKind: 'device', waitingReason: DEVICE_REASON }))).toBe('device');
    expect(effectiveWaitKind(task({ waitKind: 'device', waitingReason: '审阅发现待改进项：x' }))).toBeUndefined();
    expect(effectiveWaitKind(task({ waitKind: 'paused', waitingReason: null }))).toBeUndefined();
    expect(effectiveWaitKind(task({ waitKind: 'login' }))).toBe('login');
    expect(effectiveWaitKind(task({ status: 'failed', waitKind: 'budget' }))).toBeUndefined();
  });
});

describe('agentCanServe / unavailableParticipant', () => {
  it('mirrors the agent check of SVC assertAuthorized', () => {
    expect(agentCanServe(writer, 'project')).toBe(true);
    expect(agentCanServe(agent('x', 'X', { enabled: false }), 'discussion')).toBe(false);
    expect(agentCanServe(agent('x', 'X', { tools: ['create_project'] }), 'discussion')).toBe(false);
    expect(agentCanServe(agent('x', 'X', { tools: ['respond'] }), 'discussion')).toBe(true);
    expect(agentCanServe(agent('x', 'X', { tools: ['respond'] }), 'project')).toBe(false);
    expect(agentCanServe(undefined, 'discussion')).toBe(false);
  });

  it('names the first participant that cannot serve', () => {
    const agents = new Map([
      ['a', writer],
      ['b', agent('b', 'Reviewer', { tools: ['respond'] })],
      ['c', agent('c', 'Researcher', { enabled: false })],
    ]);
    expect(unavailableParticipant(agents, ['a', 'b'], 'discussion')).toBeNull();
    expect(unavailableParticipant(agents, ['a', 'b', 'c'], 'project')).toBe('b');
    expect(unavailableParticipant(agents, ['a', 'c'], 'discussion')).toBe('c');
    expect(unavailableParticipant(agents, ['a', 'gone'], 'discussion')).toBe('gone');
  });
});

describe('needsReconcile', () => {
  it('is true for an unconfirmed stop or an interrupted attempt on an unfinished task', () => {
    expect(needsReconcile(task({ stopConfirmation: 'unknown' }), [])).toBe(true);
    expect(needsReconcile(task({ status: 'cancelling', stopConfirmation: 'unknown' }), [])).toBe(true);
    expect(needsReconcile(task({ status: 'failed' }), [attempt({ status: 'interrupted' })])).toBe(true);
  });

  it('is false for clean, completed or cancelled tasks', () => {
    expect(needsReconcile(task(), [attempt()])).toBe(false);
    expect(needsReconcile(task({ status: 'completed', stopConfirmation: 'unknown' }), [])).toBe(false);
    expect(needsReconcile(task({ status: 'cancelled' }), [attempt({ status: 'interrupted' })])).toBe(false);
  });
});

describe('waitInfo', () => {
  it('1 · unconfirmed: unknown stop, interrupted attempt or external result', () => {
    const expected = { key: 'unconfirmed', actions: ['reconcile', 'startAgain', 'stop'] };
    expect(waitInfo(task({ stopConfirmation: 'unknown', waitingReason: 'x' }), [])).toMatchObject({ ...expected, reasonText: 'x' });
    expect(waitInfo(task(), [attempt({ status: 'interrupted' })])).toMatchObject(expected);
    expect(waitInfo(task({ waitKind: 'external_result' }), [])).toMatchObject(expected);
  });

  it('recovered: a reconciled task offers resume, or start again at the cap', () => {
    const reconciled = task({ waitKind: 'recovery', stopConfirmation: 'confirmed', waitingReason: '旧执行者已退出，已有成果已核对，可以恢复' });
    expect(waitInfo(reconciled, [attempt({ status: 'failed' })])).toEqual({
      key: 'recovered',
      reasonText: '旧执行者已退出，已有成果已核对，可以恢复',
      actions: ['resume', 'stop'],
    });
    const capped = [attempt({ id: '1' }), attempt({ id: '2' }), attempt({ id: '3' })];
    expect(waitInfo(reconciled, capped).actions).toEqual(['startAgain', 'stop']);
    expect(waitInfo({ ...reconciled, waitingReason: '未发现已启动的执行尝试，可以恢复' }, []).key).toBe('recovered');
    // The sticky waitKind does not hide a later, specific wait.
    expect(waitInfo({ ...reconciled, waitingReason: '审阅发现待改进项：Fix the title' }, []).key).toBe('review');
  });

  it('recovered needs evidence that a reconcile ran, not just the run catch defaults', () => {
    // SVC run catch: an aborted run (e.g. a memory edit) leaves waitKind 'recovery' + 'confirmed'.
    const interrupted = task({ waitKind: 'recovery', stopConfirmation: 'confirmed', waitingReason: '执行已中断；已有成果保留' });
    expect(waitInfo(interrupted, [attempt({ status: 'failed' })])).toEqual({
      key: 'other',
      reasonText: '执行已中断；已有成果保留',
      actions: ['resume', 'amend', 'stop'],
    });
  });

  it('2 · paused resumes Fantay; 3 · device offers nothing', () => {
    expect(waitInfo(task({ waitKind: 'paused', waitingReason: PAUSED_REASON }), [])).toMatchObject({ key: 'paused', actions: ['resumeFantay'] });
    expect(waitInfo(task({ waitKind: 'device', waitingReason: DEVICE_REASON }), [])).toMatchObject({ key: 'device', actions: [] });
  });

  it('a stale pause or sleep kind does not hide the wait that followed it', () => {
    // Device slept mid-review, woke (auto-resume), then the reviewer asked for changes: the kind is still 'device'.
    const review = task({ waitKind: 'device', waitingReason: '审阅发现待改进项：Fix the title' });
    expect(waitInfo(review, [attempt()])).toEqual({ key: 'review', reasonText: 'Fix the title', actions: ['continueReview', 'amend', 'stop'] });
    const later = task({ waitKind: 'paused', waitingReason: '后台已重启；请核对已有成果后恢复' });
    expect(waitInfo(later, [])).toMatchObject({ key: 'other', actions: ['resume', 'amend', 'stop'] });
  });

  it('reason rules come before a login or budget kind kept from an earlier wait', () => {
    const review = '审阅发现待改进项：Fix the title';
    expect(waitInfo(task({ waitKind: 'login', waitingReason: review }), [attempt()]).key).toBe('review');
    expect(waitInfo(task({ waitKind: 'budget', waitingReason: '相关记忆已修正或删除；恢复后将使用新的上下文重新执行' }), [attempt()]).key).toBe('memory');
    const amended = task({ waitKind: 'login', amendments: [{ revision: 2, content: 'more', receivedAt: 2, appliedAt: null }] });
    expect(waitInfo(amended, []).key).toBe('amended');
  });

  it('4 · login opens model settings, then resume (start again when refused)', () => {
    expect(waitInfo(task({ waitKind: 'login' }), [])).toMatchObject({ key: 'login', actions: ['modelSettings', 'resume'] });
    const capped = [attempt({ id: '1' }), attempt({ id: '2' }), attempt({ id: '3' })];
    expect(waitInfo(task({ waitKind: 'login' }), capped).actions).toEqual(['modelSettings', 'startAgain']);
  });

  it('5 · budget resumes when allowed, else starts again', () => {
    expect(waitInfo(task({ waitKind: 'budget' }), [attempt()]).actions).toEqual(['resume']);
    const capped = [attempt({ id: '1' }), attempt({ id: '2' }), attempt({ id: '3' })];
    expect(waitInfo(task({ waitKind: 'budget' }), capped)).toMatchObject({ key: 'budget', actions: ['startAgain'] });
  });

  it('5 · a spent time budget starts again instead of resuming, whatever kind was kept', () => {
    const timeout = '本次执行达到时间上限；已有成果保留';
    expect(waitInfo(task({ waitKind: 'budget', waitingReason: timeout }), timedOut)).toEqual({
      key: 'budget',
      reasonText: timeout,
      actions: ['startAgain'],
    });
    // A login kind kept from an earlier wait does not turn a timeout into a model problem.
    expect(waitInfo(task({ waitKind: 'login', waitingReason: timeout }), timedOut)).toMatchObject({ key: 'budget', actions: ['startAgain'] });
    // A generic wait on a spent budget reads as the budget; reason-specific waits keep their copy, but none
    // offers a Resume that would stop at once.
    expect(waitInfo(task({ waitingReason: '后台已重启' }), timedOut)).toMatchObject({ key: 'budget', actions: ['startAgain'] });
    const amended = task({ amendments: [{ revision: 2, content: 'more', receivedAt: 2, appliedAt: null }] });
    expect(waitInfo(amended, timedOut)).toMatchObject({ key: 'amended', actions: ['startAgain'] });
    const review = task({ waitingReason: '审阅发现待改进项：Fix the title' });
    expect(waitInfo(review, timedOut).actions).toEqual(['startAgain', 'amend', 'stop']);
  });

  it('6 · review shows the text after the colon', () => {
    expect(waitInfo(task({ waitingReason: '审阅发现待改进项：Fix the title' }), [])).toEqual({
      key: 'review',
      reasonText: 'Fix the title',
      actions: ['continueReview', 'amend', 'stop'],
    });
  });

  it('7 · amended, 8 · revoked, 9 · memory, 10 · other', () => {
    const amended = task({ amendments: [{ revision: 2, content: 'more', receivedAt: 2, appliedAt: null }] });
    expect(waitInfo(amended, [])).toMatchObject({ key: 'amended', actions: ['resume'] });
    const revoked = task({ waitingReason: '智能体 Writer 已停用或权限已撤销' });
    // Without the live agents the wait keeps pointing at the agent.
    expect(waitInfo(revoked, [])).toEqual({ key: 'revoked', reasonText: '智能体 Writer 已停用或权限已撤销', actions: ['openAgent', 'stop'] });
    expect(waitInfo(task({ waitingReason: '相关记忆已修正或删除；恢复后将使用新的上下文重新执行' }), [])).toMatchObject({
      key: 'memory',
      actions: ['resume'],
    });
    expect(waitInfo(task({ waitingReason: '后台已重启' }), [])).toEqual({
      key: 'other',
      reasonText: '后台已重启',
      actions: ['resume', 'amend', 'stop'],
    });
  });

  it('8 · revoked points at the agent while one cannot serve, and resumes once all can', () => {
    const reason = '智能体 Writer 已停用或权限已撤销';
    const waiting = task({ waitingReason: reason, participantIds: ['a', 'b'] });
    const disabled = { agents: new Map([['a', agent('a', 'Writer', { enabled: false })], ['b', reviewer]]) };
    expect(waitInfo(waiting, [], disabled)).toEqual({ key: 'revoked', reasonText: reason, actions: ['openAgent', 'stop'] });
    const noTool = { agents: new Map([['a', writer], ['b', agent('b', 'Reviewer', { tools: [] })]]) };
    expect(waitInfo(waiting, [], noTool).key).toBe('revoked');
    // A project also needs create_project from every participant (SVC assertAuthorized).
    const respondOnly = { agents: new Map([['a', writer], ['b', agent('b', 'Reviewer', { tools: ['respond'] })]]) };
    expect(waitInfo({ ...waiting, kind: 'project' }, [], respondOnly).key).toBe('revoked');
    expect(waitInfo(waiting, [], respondOnly).key).toBe('other');
    // Re-enabled: the daemon would accept Resume (the task was never revoked), so the stale reason no longer blocks.
    const enabled = { agents: new Map([['a', writer], ['b', reviewer]]) };
    expect(waitInfo(waiting, [], enabled)).toEqual({ key: 'other', reasonText: reason, actions: ['resume', 'amend', 'stop'] });
    // An unavailable agent outranks pending additions: resuming would stop at the same agent again.
    const amended = { ...waiting, amendments: [{ revision: 2, content: 'more', receivedAt: 2, appliedAt: null }] };
    expect(waitInfo(amended, [], disabled).key).toBe('revoked');
    expect(waitInfo(amended, [], enabled)).toMatchObject({ key: 'amended', actions: ['resume'] });
  });

  it('reads waitKind only while waiting and drops stop/amend for failed tasks', () => {
    const failed = task({ status: 'failed', waitKind: 'paused', error: 'boom' });
    expect(waitInfo(failed, [])).toMatchObject({ key: 'other', actions: ['resume'] });
  });
});

describe('expiresAt', () => {
  it('adds the control expiry to waitingSince, or uses the daemon value', () => {
    expect(expiresAt(task({ waitingSince: 1000 }), control)).toBe(1000 + 86_400_000);
    expect(expiresAt(task({ waitingSince: 1000, expiresAt: 5000 }), control)).toBe(5000);
  });

  it('falls back to updatedAt like SVC expireWaitingTasks when no waitingSince was written', () => {
    // A first review wait (SVC run) never sets waitingSince, yet the daemon still expires it.
    expect(expiresAt(task({ updatedAt: 7000, waitingReason: '审阅发现待改进项：x' }), control)).toBe(7000 + 86_400_000);
  });

  it('is null for waits that never expire or when data is missing', () => {
    expect(expiresAt(task({ waitingSince: 1, waitKind: 'paused', waitingReason: PAUSED_REASON }), control)).toBeNull();
    expect(expiresAt(task({ waitingSince: 1, waitKind: 'device', waitingReason: DEVICE_REASON }), control)).toBeNull();
    // SVC expireWaitingTasks skips on the stored kind even when it is stale, so these never expire either.
    expect(expiresAt(task({ waitingSince: 1, waitKind: 'device', waitingReason: '审阅发现待改进项：x' }), control)).toBeNull();
    expect(expiresAt(task({ waitingSince: 1, stopConfirmation: 'unknown' }), control)).toBeNull();
    expect(expiresAt(task({ waitingSince: 1 }), null)).toBeNull();
    expect(expiresAt(task({ waitingSince: 1, status: 'failed' }), control)).toBeNull();
  });
});

describe('needs you', () => {
  it('includes actionable waits and resumable failures, not auto-resuming waits', () => {
    expect(isNeedsYouTask(task(), [])).toBe(true);
    expect(isNeedsYouTask(task({ waitKind: 'paused', waitingReason: PAUSED_REASON }), [])).toBe(false);
    expect(isNeedsYouTask(task({ waitKind: 'device', waitingReason: DEVICE_REASON }), [])).toBe(false);
    expect(isNeedsYouTask(task({ status: 'failed' }), [])).toBe(true);
  });

  it('includes a later wait that inherited a stale pause or sleep kind', () => {
    expect(isNeedsYouTask(task({ waitKind: 'device', waitingReason: '审阅发现待改进项：x' }), [attempt()])).toBe(true);
    expect(isNeedsYouTask(task({ waitKind: 'paused', waitingReason: '后台已重启' }), [])).toBe(true);
  });

  it('includes failed tasks that need their interrupted run checked, not failures nothing can continue', () => {
    expect(isNeedsYouTask(task({ status: 'failed', stopConfirmation: 'unknown' }), [])).toBe(true);
    expect(isNeedsYouTask(task({ status: 'failed' }), [attempt({ status: 'interrupted' })])).toBe(true);
    const capped = [attempt({ id: '1' }), attempt({ id: '2' }), attempt({ id: '3' })];
    expect(isNeedsYouTask(task({ status: 'failed' }), capped)).toBe(false);
    expect(isNeedsYouTask(task({ status: 'failed', error: '等待已超过设定期限；目标和已有成果保留，可手动恢复' }), timedOut)).toBe(false);
  });

  it('orders approvals, then deliveries, then tasks', () => {
    const channels: PaChannelSnapshot = {
      channels: [],
      inbox: [
        { ...stamp, id: 'in1', channelId: 'ch', providerMessageId: 'p', senderId: 's', chatId: 'c', threadId: null, receivedAt: 1, taskId: null, state: 'approval', error: null, preview: 'x' },
      ],
      outbox: [
        { ...stamp, id: 'out1', channelId: 'ch', authorizationVersion: 1, taskId: null, inboxId: 'in1', requestId: 'r', state: 'unknown', providerMessageId: null, attempts: 1, nextAttemptAt: 0, error: null, sentAt: null, preview: 'y' },
      ],
    };
    const index = buildIndex(snapshot({ tasks: [task()] }), channels, []);
    expect(needsYou(index).map((need) => need.kind)).toEqual(['approval', 'delivery', 'task']);
    expect(index.needs).toHaveLength(3);
  });

  it('lists a failed task with an unconfirmed stop next to the waits', () => {
    const failed = task({ id: 't2', status: 'failed', stopConfirmation: 'unknown', updatedAt: 5 });
    const stopped = task({ id: 't3', status: 'failed', authorization: { localProject: false, externalWrites: false, version: 2, revoked: true } });
    const index = buildIndex(snapshot({ tasks: [task(), failed, stopped] }), NO_CHANNELS, []);
    expect(index.needs.map((need) => (need.kind === 'task' ? need.task.id : need.kind))).toEqual(['t2', 't1']);
  });
});

describe('needsSeparator / separatorLabel', () => {
  const at = (h: number, m: number, day = 10) => new Date(2026, 10, day, h, m).getTime();

  it('separates the first message, a 15-minute gap and a new local day', () => {
    expect(needsSeparator(null, at(9, 0))).toBe(true);
    expect(needsSeparator(at(9, 0), at(9, 14))).toBe(false);
    expect(needsSeparator(at(9, 0), at(9, 14) + 59_000)).toBe(false);
    expect(needsSeparator(at(9, 0), at(9, 15))).toBe(true);
    expect(needsSeparator(at(23, 55, 9), at(0, 5, 10))).toBe(true);
  });

  it('labels today, yesterday, this week, this year and earlier', () => {
    const now = at(15, 0);
    expect(separatorLabel(at(14, 5), now, 'en', t)).toBe('pa.time.today{"time":"14:05"}');
    expect(separatorLabel(at(9, 12, 9), now, 'en', t)).toBe('pa.time.yesterday{"time":"09:12"}');
    expect(separatorLabel(at(18, 30, 6), now, 'en', t)).toBe('Fri 18:30');
    expect(separatorLabel(at(18, 30, 6), now, 'zh-CN', t)).toBe('周五 18:30');
    expect(separatorLabel(new Date(2026, 9, 3, 18, 30).getTime(), now, 'en', t)).toBe('Oct 3, 18:30');
    expect(separatorLabel(new Date(2026, 10, 3, 18, 30).getTime(), now, 'zh-CN', t)).toBe('11月3日 18:30');
    expect(separatorLabel(new Date(2025, 10, 3, 18, 30).getTime(), now, 'en', t)).toBe('Nov 3, 2025');
    expect(separatorLabel(new Date(2025, 10, 3, 18, 30).getTime(), now, 'zh-CN', t)).toBe('2025年11月3日');
  });
});

describe('predictResponders', () => {
  it('answers with the agent being replied to', () => {
    const index = buildIndex(snapshot({ messages: [message('m1', { conversationId: 'group-chat', senderId: 'b' })] }), NO_CHANNELS, []);
    expect(predictResponders(index, groupChat, { text: 'Thoughts?', replyTo: 'm1', project: false })).toEqual({
      ids: ['b'],
      reviewerId: null,
      ordered: false,
    });
  });

  it('answers with @-mentioned members', () => {
    const index = buildIndex(snapshot(), NO_CHANNELS, []);
    expect(predictResponders(index, groupChat, { text: 'Ask @Reviewer please', replyTo: null, project: false }).ids).toEqual(['b']);
  });

  it('answers with everyone for @全体 and with the moderator in a discussion', () => {
    const index = buildIndex(snapshot(), NO_CHANNELS, []);
    expect(predictResponders(index, groupChat, { text: '@全体 hello', replyTo: null, project: false }).ids).toEqual(['a', 'b']);
    expect(predictResponders(index, groupChat, { text: 'hello', replyTo: null, project: false })).toEqual({
      ids: ['a'],
      reviewerId: null,
      ordered: false,
    });
  });

  it('answers with all members in collaboration, in member order', () => {
    const index = buildIndex(snapshot({ groups: [group({ mode: 'collaboration', memberIds: ['b', 'a', 'c'] })] }), NO_CHANNELS, []);
    expect(predictResponders(index, groupChat, { text: 'go', replyTo: null, project: false })).toEqual({
      ids: ['b', 'a', 'c'],
      reviewerId: null,
      ordered: true,
    });
  });

  it('orders review mode and projects as others, moderator, reviewer', () => {
    const reviewGroup = group({ mode: 'review', memberIds: ['b', 'a', 'c'], moderatorId: 'a', reviewerId: 'b' });
    const index = buildIndex(snapshot({ groups: [reviewGroup] }), NO_CHANNELS, []);
    expect(predictResponders(index, groupChat, { text: 'go', replyTo: null, project: false })).toEqual({
      ids: ['c', 'a', 'b'],
      reviewerId: 'b',
      ordered: true,
    });
    const discussion = buildIndex(snapshot({ groups: [group({ memberIds: ['a', 'b', 'c'] })] }), NO_CHANNELS, []);
    // Without an explicit reviewer the last non-moderator member reviews.
    expect(predictResponders(discussion, groupChat, { text: 'Build it', replyTo: null, project: true })).toEqual({
      ids: ['b', 'a', 'c'],
      reviewerId: 'c',
      ordered: true,
    });
  });

  it('answers with the only agent in a direct conversation', () => {
    const index = buildIndex(snapshot(), NO_CHANNELS, []);
    expect(predictResponders(index, direct, { text: 'hi', replyTo: null, project: false }).ids).toEqual(['a']);
  });
});

describe('projectGate', () => {
  it('refuses direct and channel conversations', () => {
    const channelChat: PaConversation = { ...groupChat, id: 'ch-chat', channelId: 'ch' };
    const index = buildIndex(snapshot({ conversations: [direct, groupChat, channelChat] }), NO_CHANNELS, []);
    expect(projectGate(index, direct)).toEqual({ ok: false, reason: 'notGroup' });
    expect(projectGate(index, channelChat)).toEqual({ ok: false, reason: 'notGroup' });
  });

  it('needs two members on different models', () => {
    const solo = buildIndex(snapshot({ groups: [group({ memberIds: ['a'] })] }), NO_CHANNELS, []);
    expect(projectGate(solo, groupChat)).toEqual({ ok: false, reason: 'members' });
    const same = buildIndex(
      snapshot({ agents: [writer, agent('b', 'Reviewer')], groups: [group()] }),
      NO_CHANNELS,
      [],
    );
    expect(projectGate(same, groupChat)).toEqual({ ok: false, reason: 'sameModel' });
    const ok = buildIndex(snapshot(), NO_CHANNELS, []);
    expect(projectGate(ok, groupChat)).toEqual({ ok: true, producerId: 'a', reviewerId: 'b' });
  });

  it('refuses when a participant is disabled or lacks the project tools', () => {
    const gate = (agents: PersonalAgent[], memberIds = ['a', 'b']) =>
      projectGate(buildIndex(snapshot({ agents, groups: [group({ memberIds })] }), NO_CHANNELS, []), groupChat);
    const noProject = agent('b', 'Reviewer', { tools: ['respond'], model: { runtime: 'claude', modelId: 'haiku' } });
    expect(gate([writer, noProject])).toEqual({ ok: false, reason: 'unavailable', agentId: 'b' });
    expect(gate([agent('a', 'Writer', { enabled: false }), reviewer])).toEqual({ ok: false, reason: 'unavailable', agentId: 'a' });
    // Every participant runs in a project, not only the producer and reviewer, and the first one in run order
    // (others, moderator, reviewer: here b, a, c) is named.
    expect(gate([writer, noProject, researcher], ['a', 'b', 'c'])).toEqual({ ok: false, reason: 'unavailable', agentId: 'b' });
    expect(gate([agent('a', 'Writer', { enabled: false }), noProject, researcher], ['a', 'b', 'c'])).toEqual({
      ok: false,
      reason: 'unavailable',
      agentId: 'b',
    });
    // A same-model pair is refused at submit, so it is reported first.
    expect(gate([writer, agent('b', 'Reviewer', { enabled: false })])).toEqual({ ok: false, reason: 'sameModel' });
  });
});

describe('mentionQuery', () => {
  it('finds an @ at the start or after whitespace up to the caret', () => {
    expect(mentionQuery('@Re', 3)).toEqual({ start: 0, query: 'Re' });
    expect(mentionQuery('hi @', 4)).toEqual({ start: 3, query: '' });
    expect(mentionQuery('hi @Rev more', 7)).toEqual({ start: 3, query: 'Rev' });
    expect(mentionQuery('你好\n@审', 5)).toEqual({ start: 3, query: '审' });
  });

  it('ignores an @ inside a word, after whitespace, or with no @ at all', () => {
    expect(mentionQuery('mail@host', 9)).toBeNull();
    expect(mentionQuery('@Rev done', 9)).toBeNull();
    expect(mentionQuery('plain text', 5)).toBeNull();
  });
});

describe('requestFor', () => {
  const body = { conversationId: 'direct', goal: 'Hi', targetAgentIds: [], kind: 'discussion' as const, budget: { maxAttempts: 6, timeoutMs: 300000 } };

  it('reuses the request id for an identical body', () => {
    const first = requestFor(draft(), body);
    expect(first.id.length).toBeGreaterThanOrEqual(8);
    expect(requestFor(draft({ request: first }), { ...body })).toEqual(first);
  });

  it('creates a new id when the body changes', () => {
    const first = requestFor(draft(), body);
    const second = requestFor(draft({ request: first }), { ...body, goal: 'Hi there' });
    expect(second.id).not.toBe(first.id);
    expect(second.fingerprint).toBe(JSON.stringify({ ...body, goal: 'Hi there' }));
  });
});

describe('identity', () => {
  it('finds Fantay by the sentinel avatar, else the first agent', () => {
    const fantay = agent('f', 'Fantay', { avatar: 'fantay' });
    expect(findFantay([writer, fantay])?.id).toBe('f');
    expect(findFantay([writer, reviewer])?.id).toBe('a');
    expect(findFantay([])).toBeNull();
  });

  it('hashes ids onto five stable hues', () => {
    expect(hueIndex('agent-1')).toBe(hueIndex('agent-1'));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const hue = hueIndex(`agent-${i}`);
      expect(hue).toBeGreaterThanOrEqual(1);
      expect(hue).toBeLessThanOrEqual(5);
      seen.add(hue);
    }
    expect(seen.size).toBe(5);
    // FNV-1a 32-bit of "a" is 0xe40c292c (3826002220) → 3826002220 % 5 + 1.
    expect(hueIndex('a')).toBe((3826002220 % 5) + 1);
  });

  it('classifies and titles conversations', () => {
    const channelChat: PaConversation = { ...stamp, id: 'ch1', title: '产品群', agentId: 'a', groupId: null, channelId: 'ch' };
    const index = buildIndex(snapshot({ agents: [agent('a', 'Fantay'), reviewer], conversations: [direct, groupChat, channelChat] }), NO_CHANNELS, []);
    expect(conversationKind(direct)).toBe('direct');
    expect(conversationKind(groupChat)).toBe('group');
    expect(conversationKind(channelChat)).toBe('channel');
    expect(conversationTitle(index, direct)).toBe('Fantay'); // the live name, not the stored title
    expect(conversationTitle(index, channelChat)).toBe('产品群');
    expect(subjectOf(index, groupChat)).toMatchObject({ kind: 'group' });
    expect(subjectOf(index, channelChat)).toMatchObject({ kind: 'agent', agent: { id: 'a' } });
    expect(index.channelConversations.map((c) => c.id)).toEqual(['ch1']);
    expect(index.directByAgent.get('a')?.map((c) => c.id)).toEqual(['direct']);
  });

  it('orders direct chats by messages and tasks, not by a rename that bumped updatedAt', () => {
    // The identity migration renamed both chats (updatedAt ≈ migration time, in row order); real use is older.
    const older: PaConversation = { ...direct, id: 'older', createdAt: 10, updatedAt: 9_000 };
    const newer: PaConversation = { ...direct, id: 'newer', createdAt: 20, updatedAt: 9_001 };
    const index = buildIndex(
      snapshot({
        conversations: [older, newer, groupChat],
        messages: [message('m1', { conversationId: 'older', createdAt: 500 }), message('m2', { conversationId: 'newer', createdAt: 300 })],
      }),
      NO_CHANNELS,
      [],
    );
    expect(index.directByAgent.get('a')?.map((c) => c.id)).toEqual(['older', 'newer']);
    expect(index.lastActivity.get('older')).toBe(500);
    // An empty chat counts from its creation.
    expect(index.lastActivity.get('group-chat')).toBe(groupChat.createdAt);
  });
});

describe('unwrapStructured', () => {
  it('keeps ordinary text', () => {
    expect(unwrapStructured('Hello **world**')).toEqual({ kind: 'text', text: 'Hello **world**' });
    expect(unwrapStructured('{not json')).toEqual({ kind: 'text', text: '{not json' });
    expect(unwrapStructured('{"title":"x"}')).toEqual({ kind: 'text', text: '{"title":"x"}' });
  });

  it('unwraps a JSON summary with issues and a verdict, fenced or not', () => {
    expect(unwrapStructured('{"summary":"Looks good","issues":[],"approved":true}')).toEqual({
      kind: 'structured',
      summary: 'Looks good',
      issues: [],
      approved: true,
    });
    expect(unwrapStructured('```json\n{"summary":"Fix it","issues":["A",2,"B"]}\n```')).toEqual({
      kind: 'structured',
      summary: 'Fix it',
      issues: ['A', 'B'],
      approved: null,
    });
  });
});

describe('budgetUse / usageSummary / formatting', () => {
  it('sums attempt time, using now for a running attempt', () => {
    const attempts = [attempt({ startedAt: 1000, endedAt: 4000 }), attempt({ id: '2', status: 'running', startedAt: 5000, endedAt: null })];
    expect(budgetUse(task(), attempts, 9000)).toEqual({ attempts: 2, maxAttempts: 3, usedMs: 3000 + 4000, timeoutMs: 300000 });
    const paused = { ...attempt({ startedAt: 0, endedAt: 10_000 }), durationMs: 2000 } as PaAttempt;
    expect(budgetUse(task(), [paused], 0).usedMs).toBe(2000);
  });

  it('sums tokens, keeps cost only when every attempt reports it, flags unknown usage', () => {
    const reported = attempt({ usage: { inputTokens: 1000, outputTokens: 200, costUsd: '0.01', visibility: 'reported' } });
    expect(usageSummary([reported, { ...reported, id: '2' }])).toEqual({ inputTokens: 2000, outputTokens: 400, costUsd: '0.02', unknown: false });
    const unknown = attempt({ id: '3', usage: { visibility: 'unknown' } });
    expect(usageSummary([reported, unknown])).toEqual({ inputTokens: 1000, outputTokens: 200, costUsd: null, unknown: true });
    expect(usageSummary([])).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null, unknown: false });
  });

  it('flags reported usage without token counts as unknown, never zero', () => {
    // Ollama reports `visibility: 'reported'` but omits prompt_eval_count for a cached prompt.
    const cached = attempt({ usage: { outputTokens: 80, visibility: 'reported' } });
    expect(usageSummary([cached]).unknown).toBe(true);
    expect(usageSummary([attempt({ usage: { inputTokens: 10, visibility: 'reported' } })]).unknown).toBe(true);
    expect(usageSummary([attempt()]).unknown).toBe(false);
  });

  it('formats tokens, bytes and durations', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
    expect(formatBytes(12_800)).toBe('12.5 KB');
    expect(formatDuration(42_000, t)).toBe('pa.dur.seconds{"s":42}');
    expect(formatDuration(125_000, t)).toBe('pa.dur.minutes{"m":2,"s":5}');
    expect(formatDuration(3_900_000, t)).toBe('pa.dur.hours{"h":1,"m":5}');
  });
});

describe('turns, phases and work lines', () => {
  it('groups messages by task and orders turns by their first message', () => {
    const index = buildIndex(
      snapshot({
        tasks: [task({ id: 't1', createdAt: 10, status: 'completed' })],
        messages: [
          message('m2', { taskId: 't1', senderId: 'a', createdAt: 30 }),
          message('m1', { taskId: 't1', createdAt: 10 }),
          message('m0', { createdAt: 5 }),
        ],
      }),
      NO_CHANNELS,
      [],
    );
    const turns = buildTurns(index, 'direct');
    expect(turns.map((turn) => turn.key)).toEqual(['m:m0', 't:t1']);
    expect(turns[1]!.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('derives the phase like the daemon run loop', () => {
    const index = buildIndex(snapshot({ groups: [group({ mode: 'review' })] }), NO_CHANNELS, []);
    const project = task({ kind: 'project', conversationId: 'group-chat', participantIds: ['a', 'b'], reviewRequired: true });
    expect(taskPhase({ ...project, nextParticipant: 0 }, index)).toBe('produce');
    expect(taskPhase({ ...project, nextParticipant: 1 }, index)).toBe('review');
    const reviewMode = task({ conversationId: 'group-chat', participantIds: ['a', 'b'] });
    expect(taskPhase({ ...reviewMode, nextParticipant: 1 }, index)).toBe('review');
    expect(taskPhase(task(), index)).toBe('respond');
  });

  it('explains why a task is queued and who is working', () => {
    const earlier = task({ id: 't0', status: 'running', createdAt: 1 });
    const queued = task({ id: 't1', status: 'queued', createdAt: 2 });
    const index = buildIndex(snapshot({ tasks: [earlier, queued] }), NO_CHANNELS, []);
    expect(workLine(queued, index, control)).toEqual({ kind: 'queued', reason: 'conversation', max: 2 });
    const alone = buildIndex(snapshot({ tasks: [queued] }), NO_CHANNELS, []);
    expect(workLine(queued, alone, { ...control, activeCount: 2 })).toMatchObject({ reason: 'concurrency' });
    expect(workLine(queued, alone, null)).toMatchObject({ reason: 'none', max: null });
    const running = task({ status: 'running', participantIds: ['a', 'b'], updatedAt: 77 });
    const runningIndex = buildIndex(snapshot({ tasks: [running] }), NO_CHANNELS, []);
    expect(workLine(running, runningIndex, control)).toEqual({
      kind: 'step',
      agentId: 'a',
      phase: 'respond',
      step: 1,
      total: 2,
      nextAgentId: 'b',
      startedAt: 77,
    });
    expect(workLine(task({ status: 'cancelling', stopConfirmation: 'unknown' }), runningIndex, control)).toEqual({ kind: 'stopping', unknown: true });
    expect(workLine(task({ status: 'completed' }), runningIndex, control)).toBeNull();
  });
});

describe('previews, scope names and status', () => {
  it('prefers live task state over the last message', () => {
    const base = snapshot({ messages: [message('m1', { senderId: 'a', content: '## Heading\n**Bold** reply' })] });
    expect(lastPreview(buildIndex(base, NO_CHANNELS, []), direct)).toEqual({ kind: 'text', text: 'Heading Bold reply', sender: 'a' });
    const running = snapshot({ tasks: [task({ status: 'running' })] });
    expect(lastPreview(buildIndex(running, NO_CHANNELS, []), direct)).toEqual({ kind: 'working', agentId: 'a' });
    // A failure nothing can continue (cancelled authorization) previews as failed; one needing a check is a need.
    const revoked = { localProject: false, externalWrites: false as const, version: 2, revoked: true };
    const failed = snapshot({ tasks: [task({ status: 'failed', error: 'x'.repeat(60), authorization: revoked })] });
    expect(lastPreview(buildIndex(failed, NO_CHANNELS, []), direct)).toEqual({ kind: 'failed', error: 'x'.repeat(40) });
    const unchecked = snapshot({ tasks: [task({ status: 'failed', error: 'x', stopConfirmation: 'unknown' })] });
    expect(lastPreview(buildIndex(unchecked, NO_CHANNELS, []), direct)).toEqual({ kind: 'needs' });
    expect(lastPreview(buildIndex(snapshot(), NO_CHANNELS, []), direct)).toEqual({ kind: 'empty' });
  });

  it('names memory scopes, never ids', () => {
    const index = buildIndex(snapshot(), NO_CHANNELS, []);
    const memory = (scope: PaMemory['scope'], scopeId: string | null): PaMemory => ({ ...stamp, id: 'm', content: 'c', source: 's', scope, scopeId });
    expect(memoryScopeName(index, memory('private', null), [], t)).toBe('pa.scope.private');
    expect(memoryScopeName(index, memory('agent', 'b'), [], t)).toBe('pa.scope.agent{"name":"Reviewer"}');
    expect(memoryScopeName(index, memory('group', 'g'), [], t)).toBe('pa.scope.group{"name":"Studio"}');
    expect(memoryScopeName(index, memory('project', 'p'), [{ id: 'p', name: 'Reading club' } as never], t)).toBe('pa.scope.project{"name":"Reading club"}');
    expect(memoryScopeName(index, memory('agent', 'gone'), [], t)).toBe('pa.scope.deleted');
  });

  it('reports the subject status by precedence', () => {
    const subject = { kind: 'agent' as const, agent: writer };
    const idle = buildIndex(snapshot(), NO_CHANNELS, []);
    expect(agentStatus(idle, { control, load: 'ready' }, subject)).toEqual({ tone: 'done', key: 'pa.status.idle', vars: {} });
    expect(agentStatus(idle, { control, load: 'offline' }, subject).key).toBe('pa.status.offline');
    expect(agentStatus(idle, { control: { ...control, paused: true }, load: 'ready' }, subject).key).toBe('pa.status.paused');
    const waiting = buildIndex(snapshot({ tasks: [task()] }), NO_CHANNELS, []);
    expect(agentStatus(waiting, { control, load: 'ready' }, subject)).toEqual({ tone: 'warning', key: 'pa.status.needs', vars: { count: 1 } });
    const working = buildIndex(snapshot({ tasks: [task({ status: 'running', goal: '一二三四五六七八九十一二三四五六七八九十' })] }), NO_CHANNELS, []);
    expect(agentStatus(working, { control, load: 'ready' }, subject)).toEqual({
      tone: 'running',
      key: 'pa.status.working',
      vars: { goal: '一二三四五六七八九十一二三四五六七八…' },
    });
  });
});
