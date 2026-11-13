// SPDX-License-Identifier: AGPL-3.0-only
// In-memory PaTransport over a PaFixture (spec §20.3): 120 ms latency, the GET routes the workspace polls, and
// just enough mutation (send, stop, resume, agent/group/memory/control edits) for the bench to feel alive.
import type {
  PaAttempt,
  PaChannel,
  PaChannelLogin,
  PaChannelPairing,
  PaControl,
  PaConversation,
  PaMemory,
  PaMessage,
  PaOutputPage,
  PaRoutine,
  PaTask,
  PersonalAgent,
} from '@open-design/contracts';
import { PaRequestError } from '../pa-api';
import type { PaTaskEvent, PaTransport } from '../pa-types';
import type { PaFixture } from './fixtures';

const RUNNING = new Set(['queued', 'running', 'verifying', 'cancelling']);

/** A WeChat sign-in in progress: when it began, when the PIN was entered, and what the poll returns. */
interface LabLogin {
  begun: number;
  pinAt: number | null;
  public: PaChannelLogin;
}

/** A stand-in QR code (finder squares plus a fixed module pattern) as an inline SVG, so the bench needs no daemon
 *  image endpoint. It encodes nothing. */
const LAB_QR = (() => {
  const n = 25;
  const cells: string[] = [];
  const finder = (x: number, y: number) =>
    cells.push(`<path d="M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5z" fill-rule="evenodd"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`);
  finder(0, 0);
  finder(n - 7, 0);
  finder(0, n - 7);
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1) {
      const inFinder = (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
      if (!inFinder && (x * 31 + y * 17 + x * y) % 7 < 3) cells.push(`<rect x="${x}" y="${y}" width="1" height="1"/>`);
    }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><g fill="#111">${cells.join('')}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
})();

const OUTPUT_PARAGRAPH =
  '这一段是模拟的完整输出，用来演示分页与搜索。进程调度需要同时考虑吞吐量、响应时间与公平性，时间片轮转适合交互式任务，短作业优先能降低平均等待时间。\n';
const OUTPUT_TEXT = Array.from({ length: 160 }, (_, i) => `[${String(i + 1).padStart(3, '0')}] ${OUTPUT_PARAGRAPH}`).join('');

function outputPage(attemptId: string, offset: number, limit: number, q: string): PaOutputPage {
  const text = OUTPUT_TEXT.slice(offset, offset + limit);
  const matches: PaOutputPage['matches'] = [];
  if (q) {
    let from = 0;
    while (matches.length < 20) {
      const at = OUTPUT_TEXT.indexOf(q, from);
      if (at < 0) break;
      matches.push({ offset: at, excerpt: OUTPUT_TEXT.slice(Math.max(0, at - 20), at + q.length + 40) });
      from = at + q.length;
    }
  }
  const end = offset + text.length;
  return { attemptId, offset, nextOffset: end < OUTPUT_TEXT.length ? end : null, totalChars: OUTPUT_TEXT.length, text, matches };
}

export interface FixtureTransportOptions {
  /** Delay of every request, ms (default 120). A very large value holds the first-load state. */
  latency?: number;
  /** After this many ms every GET fails, so the workspace keeps its data and shows the stale state. */
  failAfterMs?: number;
}

/** What the real `paRequest` throws when the daemon behind the web proxy is down. */
const DOWN = 'Fantay request failed (502)';

export function createFixtureTransport(fixture: PaFixture, options: FixtureTransportOptions = {}): PaTransport {
  const latency = options.latency ?? 120;
  const failAt = options.failAfterMs === undefined ? null : Date.now() + options.failAfterMs;
  const state = structuredClone(fixture);
  let counter = 0;
  const id = (prefix: string) => `${prefix}-lab-${++counter}`;
  const stamp = () => {
    const at = Date.now();
    return { createdAt: at, updatedAt: at, revision: 1 };
  };
  const touch = <T extends { revision: number; updatedAt: number }>(record: T, patch: Partial<T>): T => Object.assign(record, patch, { revision: record.revision + 1, updatedAt: Date.now() });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const taskOf = (taskId: string) => state.snapshot.tasks.find((t) => t.id === taskId);

  /* Scheduled replies (fixture.arrivals) start counting at the first snapshot read, so they land after the
     workspace has taken its seen baseline. */
  let arrivalsScheduled = false;
  const scheduleArrivals = () => {
    if (arrivalsScheduled) return;
    arrivalsScheduled = true;
    for (const arrival of state.arrivals ?? []) {
      later(arrival.afterMs, () => {
        const at = Date.now();
        state.snapshot.messages.push({ ...arrival.message, createdAt: at, updatedAt: at });
        const task = arrival.completes ? taskOf(arrival.completes) : undefined;
        if (!task) return;
        touch(task, { status: 'completed', nextParticipant: task.participantIds.length });
        for (const attempt of state.snapshot.attempts) {
          if (attempt.taskId === task.id && attempt.status === 'running') touch(attempt, { status: 'completed', endedAt: at });
        }
      });
    }
  };

  const startTask = (task: PaTask) => {
    const worker = state.snapshot.agents.find((a) => a.id === task.participantIds[0]) ?? state.snapshot.agents[0];
    if (!worker || task.status !== 'queued') return;
    touch(task, { status: 'running' });
    const attempt: PaAttempt = {
      ...stamp(),
      id: id('at'),
      taskId: task.id,
      runId: id('run'),
      nodeId: 'local',
      protocolVersion: 1,
      agentSnapshot: worker,
      phase: 'respond',
      status: 'running',
      taskRevision: task.revision,
      startedAt: Date.now(),
      endedAt: null,
      output: '',
      error: null,
      usage: { visibility: 'unknown' },
    };
    state.snapshot.attempts.push(attempt);
  };

  const activity = () => {
    const tasks = state.snapshot.tasks;
    return { running: tasks.filter((t) => RUNNING.has(t.status)).length, waiting: tasks.filter((t) => t.status === 'waiting').length +
      state.channels.inbox.filter(row => row.state === 'approval' && row.approvalActionable !== false).length };
  };

  /** The event kinds the daemon writes (SVC `submit` task.accepted, node `claim` node.claimed, the executor's
   *  node.result / node.cancelled, SVC `run` task.interrupted / task.completed, `amend` task.amended, `cancel`
   *  task.cancel_requested),
   *  in time order. */
  const taskEvents = (taskId: string): PaTaskEvent[] => {
    const task = taskOf(taskId);
    if (!task) return [];
    const raw: Array<Omit<PaTaskEvent, 'sequence'>> = [
      { id: `${taskId}-accepted`, kind: 'task.accepted', at: task.createdAt, data: { participantIds: task.participantIds } },
    ];
    for (const a of state.snapshot.attempts.filter((item) => item.taskId === taskId)) {
      raw.push({ id: `${a.id}-claimed`, kind: 'node.claimed', at: a.startedAt, data: { attemptId: a.id } });
      if (a.endedAt === null) continue;
      if (a.status === 'interrupted') raw.push({ id: `${a.id}-interrupted`, kind: 'task.interrupted', at: a.endedAt, data: { message: a.error ?? '' } });
      else if (a.status === 'cancelled') raw.push({ id: `${a.id}-cancelled`, kind: 'node.cancelled', at: a.endedAt, data: { attemptId: a.id } });
      else raw.push({ id: `${a.id}-result`, kind: 'node.result', at: a.endedAt, data: { attemptId: a.id, status: a.status } });
    }
    for (const amendment of task.amendments) {
      raw.push({ id: `${taskId}-amend-${amendment.revision}`, kind: 'task.amended', at: amendment.receivedAt, data: { content: amendment.content } });
    }
    if (task.status === 'cancelled' || task.status === 'cancelling') raw.push({ id: `${taskId}-cancel`, kind: 'task.cancel_requested', at: task.updatedAt, data: {} });
    if (task.status === 'completed') raw.push({ id: `${taskId}-completed`, kind: 'task.completed', at: task.updatedAt, data: {} });
    return raw.sort((a, b) => a.at - b.at).map((event, i) => ({ ...event, sequence: i + 1 }));
  };

  /* ── channels: create, pairing and the WeChat sign-in (QR → scanned → PIN → confirmed), mirroring the
     channels service closely enough for the channel modal's whole flow to run on the bench ── */
  const channelOf = (channelId: string) => state.channels.channels.find((c) => c.id === channelId);
  const logins = new Map<string, LabLogin>();
  const fail = (message: string): never => {
    throw new Error(message);
  };
  const loginState = (channelId: string): PaChannelLogin => {
    const channel = channelOf(channelId);
    const login = logins.get(channelId);
    if (!channel) return fail('连接不存在');
    if (!login) {
      const confirmed = channel.credentialConfigured && channel.status !== 'login_required';
      return { channelId, status: confirmed ? 'confirmed' : 'expired', expiresAt: 0, qrImagePath: null, message: confirmed ? '已绑定微信账号' : '请重新获取二维码' };
    }
    const elapsed = Date.now() - login.begun;
    if (login.pinAt !== null && Date.now() - login.pinAt > 1500 && login.public.status !== 'confirmed') {
      touch(channel, { enabled: true, credentialConfigured: true, status: 'connected', accountLabel: 'wxid_lab_bot', allowedSenderIds: ['wxid_owner'], remoteChatId: 'wxid_owner', authorizationVersion: channel.authorizationVersion + 1, lastError: null, verification: { ...channel.verification, reloginAt: Date.now() } });
      login.public = { ...login.public, status: 'confirmed', qrImagePath: null, message: '微信已绑定；请在微信专用会话发送一条消息开始验证' };
    } else if (login.pinAt === null && elapsed > 8000) {
      login.public = { ...login.public, status: 'verify_code', message: '请在此输入手机显示的验证码' };
    } else if (login.pinAt === null && elapsed > 4000) {
      login.public = { ...login.public, status: 'scanned', message: '已扫描，请在手机确认' };
    }
    return login.public;
  };

  const transport = async <T,>(rawPath = '', method = 'GET', body?: unknown): Promise<T> => {
    await new Promise((resolve) => setTimeout(resolve, latency));
    const url = new URL(rawPath, 'http://lab.local');
    const path = url.pathname === '/' ? '' : url.pathname;
    const verb = method.toUpperCase();
    const data = (body ?? {}) as Record<string, any>;
    const out = (value: unknown) => structuredClone(value) as T;

    if (verb === 'GET') {
      if (state.offline || (failAt !== null && Date.now() >= failAt)) throw new Error(DOWN);
      if (path === '') {
        scheduleArrivals();
        return out(state.snapshot);
      }
      if (path === '/models') return out(state.models);
      if (path === '/control') return out(state.control);
      if (path === '/channels') return out(state.channels);
      if (path === '/activity') return out(activity());
      if (path === '/feed' || path.startsWith('/feed?')) return out({ items: [], nextBefore: null });
      if (path === '/channels/local-feishu-apps') return out([{ appId: 'cli_a1b2c3', label: '本机飞书应用 · Fantay 机器人' }]);
      const loginPoll = /^\/channels\/([^/]+)\/login$/.exec(path);
      if (loginPoll) return out(loginState(loginPoll[1]!));
      const events = /^\/tasks\/([^/]+)\/events$/.exec(path);
      if (events) return out(taskEvents(events[1]!));
      const output = /^\/attempts\/([^/]+)\/output$/.exec(path);
      if (output) {
        return out(outputPage(output[1]!, Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('limit') ?? 4000), url.searchParams.get('q') ?? ''));
      }
      return out({});
    }

    if (verb === 'POST' && path === '/tasks') {
      const at = Date.now();
      const conv = state.snapshot.conversations.find((c) => c.id === data.conversationId);
      const group = conv?.groupId ? state.snapshot.groups.find((g) => g.id === conv.groupId) : null;
      const participants = group ? [group.moderatorId] : conv?.agentId ? [conv.agentId] : [];
      const taskId = id('tk');
      const task: PaTask = {
        ...stamp(),
        id: taskId,
        requestId: String(data.requestId ?? id('req')),
        conversationId: String(data.conversationId),
        goal: String(data.goal ?? ''),
        kind: data.kind === 'project' ? 'project' : 'discussion',
        projectName: String(data.projectName ?? ''),
        projectId: null,
        projectConversationId: null,
        status: 'queued',
        waitingReason: null,
        error: null,
        participantIds: participants,
        nextParticipant: 0,
        budget: { maxAttempts: 6, timeoutMs: 300000 },
        authorization: { localProject: data.kind === 'project', externalWrites: false, version: 1, revoked: false },
        amendments: [],
        evidence: [],
      };
      const message: PaMessage = {
        ...stamp(),
        id: id('m'),
        conversationId: task.conversationId,
        taskId,
        senderId: 'owner',
        content: task.goal,
        targetAgentIds: [],
        replyTo: typeof data.replyTo === 'string' ? data.replyTo : null,
        createdAt: at,
      };
      state.snapshot.tasks.push(task);
      state.snapshot.messages.push(message);
      later(1500, () => startTask(task));
      return out(task);
    }

    const action = /^\/tasks\/([^/]+)\/(cancel|resume|amend|reconcile)$/.exec(path);
    if (verb === 'POST' && action) {
      const task = taskOf(action[1]!);
      if (task) {
        if (action[2] === 'cancel') touch(task, { status: 'cancelled', waitingReason: null });
        if (action[2] === 'resume') touch(task, { status: 'running', waitingReason: null, error: null });
        if (action[2] === 'reconcile') {
          // SVC `reconcileTask` over the claude adapter: a run still being stopped is still alive on this device
          // ('running', refused even with a confirmation); an interrupted run cannot be observed ('unknown') until
          // the owner confirms it ended.
          if (task.status === 'cancelling') throw new PaRequestError('旧执行者仍在运行，不能重新分派', 'PA_EXECUTOR_RUNNING', 409);
          if (data.confirmedStopped !== true) {
            throw new PaRequestError('此适配器无法自动确认远端结果，请在服务端核对后明确确认，未自动重试', 'PA_RECOVERY_REQUIRED', 409);
          }
          for (const attempt of state.snapshot.attempts) {
            if (attempt.taskId === task.id && attempt.status === 'interrupted') touch(attempt, { status: 'failed', error: '已核对本机执行者退出；旧尝试未重放' });
          }
          touch(task, { status: 'waiting', waitKind: 'recovery', stopConfirmation: 'confirmed', waitingSince: Date.now(), error: null, waitingReason: '旧执行者已退出，已有成果已核对，可以恢复' });
        }
        if (action[2] === 'amend') task.amendments.push({ revision: task.amendments.length + 1, content: String(data.content ?? ''), receivedAt: Date.now(), appliedAt: null });
      }
      return out(task ?? {});
    }

    if (verb === 'POST' && path === '/conversations') {
      const agent = state.snapshot.agents.find((a) => a.id === data.agentId);
      const conv: PaConversation = { ...stamp(), id: id('conv'), title: agent?.name ?? 'Fantay', agentId: String(data.agentId ?? ''), groupId: null };
      state.snapshot.conversations.push(conv);
      return out(conv);
    }

    const routineRun = /^\/routines\/([^/]+)\/run$/.exec(path);
    if (verb === 'POST' && routineRun) {
      const routines = (state.snapshot.routines ??= []);
      const routine = routines.find((r) => r.id === routineRun[1]);
      if (!routine) return fail('例行任务不存在');
      const conv = state.snapshot.conversations.find((c) => c.id === routine.conversationId);
      const participants = conv?.agentId ? [conv.agentId] : [];
      const taskId = id('tk');
      const task: PaTask = {
        ...stamp(),
        id: taskId,
        requestId: id('req'),
        conversationId: routine.conversationId,
        goal: routine.prompt,
        kind: 'discussion',
        projectName: '',
        projectId: null,
        projectConversationId: null,
        status: 'queued',
        waitingReason: null,
        error: null,
        participantIds: participants,
        nextParticipant: 0,
        budget: { maxAttempts: 6, timeoutMs: 300000 },
        authorization: { localProject: false, externalWrites: false, version: 1, revoked: false },
        amendments: [],
        evidence: [],
      };
      state.snapshot.tasks.push(task);
      touch(routine, { lastTaskId: taskId });
      later(800, () => startTask(task));
      return out(routine);
    }

    const collection = /^\/(agents|groups|memories|goals|routines)(?:\/([^/]+))?(\/clone)?$/.exec(path);
    if (collection) {
      const key = collection[1] as 'agents' | 'groups' | 'memories' | 'goals' | 'routines';
      if (key === 'goals') state.snapshot.goals ??= [];
      if (key === 'routines') state.snapshot.routines ??= [];
      const list = state.snapshot[key] as Array<{ id: string; revision: number; updatedAt: number }>;
      const target = collection[2] ? list.find((r) => r.id === collection[2]) : undefined;
      if (verb === 'POST' && !collection[2]) {
        const extra =
          key === 'routines'
            ? { nextRunAt: data.enabled ? Date.now() + 8 * 3600_000 : null, lastError: null, lastTaskId: null }
            : {};
        const record = { ...stamp(), id: id(key.slice(0, 2)), ...extra, ...data } as { id: string; revision: number; updatedAt: number };
        if (key === 'groups') {
          const conv: PaConversation = { ...stamp(), id: id('conv'), title: String(data.name ?? ''), agentId: null, groupId: record.id };
          state.snapshot.conversations.push(conv);
          Object.assign(record, { conversationId: conv.id });
        }
        list.push(record);
        return out(record);
      }
      if (verb === 'POST' && collection[3] && target) {
        const source = target as unknown as PersonalAgent;
        const copy: PersonalAgent = { ...source, ...stamp(), id: id('ag'), name: `${source.name.slice(0, 55)} 副本`, avatar: source.avatar === 'fantay' ? '' : source.avatar };
        state.snapshot.agents.push(copy);
        return out(copy);
      }
      if (verb === 'PATCH' && target) {
        const patch = { ...data };
        delete patch.revision;
        if (key === 'routines' && typeof patch.enabled === 'boolean') {
          (patch as Partial<PaRoutine>).nextRunAt = patch.enabled ? Date.now() + 8 * 3600_000 : null;
        }
        return out(touch(target, patch as never));
      }
      if (verb === 'DELETE' && target) {
        list.splice(list.indexOf(target), 1);
        if (key === 'memories') state.snapshot.memories = state.snapshot.memories.filter((m: PaMemory) => m.id !== target.id);
        return out({ ok: true });
      }
    }

    if (verb === 'POST' && path === '/channels') {
      const type = data.type === 'weixin' ? 'weixin' : 'feishu';
      const channel: PaChannel = {
        ...stamp(),
        id: id('ch'),
        type,
        name: String(data.name ?? ''),
        targetKind: data.targetKind === 'group' ? 'group' : 'agent',
        targetId: String(data.targetId ?? ''),
        enabled: false,
        allowProject: data.allowProject === true,
        shareGroupMemory: data.shareGroupMemory === true,
        allowedSenderIds: [],
        remoteChatId: null,
        tenantId: null,
        authorizationVersion: 1,
        status: 'disconnected',
        credentialConfigured: false,
        accountLabel: null,
        lastReceivedAt: null,
        lastSentAt: null,
        lastError: null,
        capabilities: { direct: true, groups: type === 'feishu', threads: type === 'feishu', files: false, unsolicited: false },
        verification: { inboundAt: null, outboundAt: null, reconnectAt: null, reloginAt: null },
      };
      state.channels.channels.push(channel);
      return out(channel);
    }

    const channelAction = /^\/channels\/([^/]+)(?:\/(feishu|connect|disconnect|pair|login|login\/pin))?$/.exec(path);
    if (channelAction && channelAction[1] !== 'inbox' && channelAction[1] !== 'outbox') {
      const channel = channelOf(channelAction[1]!) ?? fail('连接不存在');
      const step = channelAction[2];
      const reauthorize = { authorizationVersion: channel.authorizationVersion + 1 };
      if (verb === 'PATCH' && !step) return out(touch(channel, { ...(data as Partial<PaChannel>), ...reauthorize }));
      if (verb === 'POST' && step === 'feishu') {
        touch(channel, { enabled: true, credentialConfigured: true, status: 'connected', accountLabel: 'Fantay 机器人', lastError: null, ...reauthorize, verification: { ...channel.verification, reconnectAt: Date.now() } });
        return out(channel);
      }
      if (verb === 'POST' && step === 'connect') {
        touch(channel, { status: 'connected', lastError: null, verification: { ...channel.verification, reconnectAt: Date.now() } });
        return out(state.channels);
      }
      if (verb === 'POST' && step === 'disconnect') {
        const forget = data.forget === true;
        logins.delete(channel.id);
        touch(channel, { enabled: false, status: 'disconnected', ...reauthorize, ...(forget ? { credentialConfigured: false, accountLabel: null, allowedSenderIds: [], remoteChatId: null, tenantId: null } : {}) });
        return out(channel);
      }
      if (verb === 'POST' && step === 'pair') {
        if (channel.type !== 'feishu' || !channel.enabled || !channel.credentialConfigured) throw new Error('请先连接飞书机器人');
        counter += 1;
        const code = Array.from({ length: 24 }, (_, i) => ((i * 7 + counter) % 16).toString(16)).join('');
        const pairing: PaChannelPairing = { channelId: channel.id, code: `绑定 ${code}`, expiresAt: Date.now() + 10 * 60_000 };
        return out(pairing);
      }
      if (verb === 'POST' && step === 'login') {
        if (channel.type !== 'weixin') throw new Error('此连接不是个人微信');
        const login: LabLogin = {
          begun: Date.now(),
          pinAt: null,
          public: { channelId: channel.id, status: 'waiting', expiresAt: Date.now() + 5 * 60_000, qrImagePath: LAB_QR, message: '请用自己的微信扫描二维码，并在手机确认连接' },
        };
        logins.set(channel.id, login);
        touch(channel, { status: 'login_required' });
        return out(login.public);
      }
      if (verb === 'POST' && step === 'login/pin') {
        const login = logins.get(channel.id);
        if (!login || login.public.status !== 'verify_code' || !/^\d{4,10}$/.test(String(data.pin ?? ''))) throw new Error('请输入手机显示的有效验证码');
        login.pinAt = Date.now();
        return out(login.public);
      }
    }

    const approve = /^\/channels\/inbox\/([^/]+)\/approve$/.exec(path);
    if (verb === 'POST' && approve) {
      const row = state.channels.inbox.find((item) => item.id === approve[1]);
      if (row) touch(row, { state: data.approved === true ? 'accepted' : 'ignored', error: data.approved === true ? null : '已拒绝' });
      return out({ ok: true });
    }
    const resolve = /^\/channels\/outbox\/([^/]+)\/resolve$/.exec(path);
    if (verb === 'POST' && resolve) {
      const row = state.channels.outbox.find((item) => item.id === resolve[1]) ?? fail('发送记录不存在');
      if (data.action === 'retry') {
        const channel = state.channels.channels.find(item => item.id === row.channelId);
        if (!channel?.enabled || channel.authorizationVersion !== row.authorizationVersion) fail('账号或授权已改变，不能重发旧操作');
        touch(row, { state: 'pending', error: null });
        later(1200, () => touch(row, { state: 'sent', sentAt: Date.now() }));
      } else touch(row, { state: 'sent', sentAt: Date.now(), error: null });
      return out(row);
    }

    if (verb === 'PATCH' && path === '/control') {
      touch(state.control as PaControl, Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Partial<PaControl>);
      return out(state.control);
    }

    return out({ ok: true });
  };
  return transport as PaTransport;
}
