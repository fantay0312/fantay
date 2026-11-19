// SPDX-License-Identifier: AGPL-3.0-only
// In-memory PaTransport over a PaFixture (spec §20.3): 120 ms latency, the GET routes the workspace polls, and
// just enough mutation (send, stop, resume, agent/group/memory/control edits) for the bench to feel alive.
// The soul routes (ARCH 4.10, 5.8) run real engine logic in `createSoulLab` at the end of this file.
import type {
  PaAttempt,
  PaChannel,
  PaChannelLogin,
  PaChannelPairing,
  PaCharacter,
  PaCharacterView,
  PaChatView,
  PaControl,
  PaConversation,
  PaDeck,
  PaLorebook,
  PaLorebookSummary,
  PaMemory,
  PaMemoryCandidate,
  PaMessage,
  PaMessageSoul,
  PaModel,
  PaOutputPage,
  PaPersona,
  PaPreserved,
  PaRoutine,
  PaSoulLiveText,
  PaSoulTrace,
  PaSpeechItem,
  PaSpeechStatus,
  PaStateOp,
  PaStylePreset,
  PaTask,
  PaTaskSoul,
  PaUserStateOp,
  PersonalAgent,
} from '@open-design/contracts';
import {
  PA_DEFAULT_CHAT_SETTINGS,
  PA_EMOTIONS,
  PA_EVENT_TURNS,
  PA_STARTERS,
  SOUL_LIMITS,
  activateLore,
  applyOp,
  availableDecks,
  chatStateSlots,
  detectCrisis,
  drawCard,
  drawInterlude,
  exportCharacterCard,
  exportWorldInfo,
  foldChatState,
  importWorldInfo,
  liveReplyText,
  mentionedMembers,
  mentionsEveryone,
  paCharacterInputSchema,
  paCharacterPatchSchema,
  paChatSettingsPatchSchema,
  paLorebookInputSchema,
  paLorebookPatchSchema,
  paPersonaInputSchema,
  paPersonaPatchSchema,
  paSpritesSchema,
  paStateOpInputSchema,
  paStylePresetInputSchema,
  paStylePresetPatchSchema,
  parseCharacterCard,
  parseSoulReply,
  pickNaturalSpeaker,
  reanchorUserOps,
  resolveChatMode,
  resolveMetaParts,
  resolvePreset,
  rollDice,
  seededRng,
  slotIdOf,
  speechSampleText,
  speechText,
  storyText,
  visibleSlots,
  messageAt,
  type LoreBookLike,
  type PaStarterCharacter,
  type SoulReply,
  type SoulReplyContext,
} from '@open-design/contracts/soul';
import { PaRequestError } from '../pa-api';
import type { PaTaskEvent, PaTransport } from '../pa-types';
import type { PaFixture } from './fixtures';
import {
  CRISIS_REPLY,
  emptyChatView,
  emptySoulSnapshot,
  greetingText,
  labSpeechItem,
  lorebookSummary,
  starterOf,
  starterRecords,
  starterReplies,
} from './soul-fixtures';

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
  /** Timing of a chat turn (ARCH 5.8): queued → running after `startMs` (600), each reply `replyMs` (1400) later; a
   *  turn that is already running in the fixture replies `liveMs` (12000) after the first snapshot read. Stage 2 live
   *  text: the picked raw reply is appended every `streamStepMs` (90; 0 = no live text, dots only), spread evenly over
   *  the reply's delay; with `streamHoldAt` (0–1) the stream stops at that share of the text and the turn stays
   *  running. */
  chatDelays?: { startMs?: number; replyMs?: number; liveMs?: number; streamStepMs?: number; streamHoldAt?: number };
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
    soulLab.start();
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

  /** A running `respond` attempt of `worker`, added to the snapshot. */
  const runningAttempt = (task: PaTask, worker: PersonalAgent): PaAttempt => {
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
    return attempt;
  };

  const startTask = (task: PaTask) => {
    const worker = state.snapshot.agents.find((a) => a.id === task.participantIds[0]) ?? state.snapshot.agents[0];
    if (!worker || task.status !== 'queued') return;
    touch(task, { status: 'running' });
    runningAttempt(task, worker);
  };

  const soulLab = createSoulLab({
    state,
    id,
    stamp,
    touch,
    later,
    runningAttempt,
    delays: {
      startMs: options.chatDelays?.startMs ?? 600,
      replyMs: options.chatDelays?.replyMs ?? 1400,
      liveMs: options.chatDelays?.liveMs ?? 12_000,
      streamStepMs: Math.max(0, options.chatDelays?.streamStepMs ?? 90),
      ...(options.chatDelays?.streamHoldAt !== undefined ? { streamHoldAt: Math.min(1, Math.max(0, options.chatDelays.streamHoldAt)) } : {}),
    },
  });

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
      if (path === '/soul' || path.startsWith('/soul/')) return out(soulLab.get(path, url));
      return out({});
    }

    // A companion message keeps `kind: 'chat'`: coalescing, typing and a canned reply (ARCH 5.8).
    if (verb === 'POST' && path === '/tasks' && data.kind === 'chat') return out(soulLab.sendChat(data));

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
      if (task?.kind === 'chat') return out(soulLab.taskAction(task, action[2]!));
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

    // 朗读 answers after a generation delay, so it is the one asynchronous soul route.
    if (verb === 'POST' && path === '/soul/speech') return out(await soulLab.speakMessage(data));
    if (verb === 'POST' && path === '/soul/speech/preview') return out(await soulLab.previewSpeech(data));
    if (path.startsWith('/soul/')) return out(soulLab.mutate(verb, path, data));
    const candidate = /^\/memory-candidates\/([^/]+)\/resolve$/.exec(path);
    if (verb === 'POST' && candidate) return out(soulLab.resolveCandidate(decodeURIComponent(candidate[1]!), data.accept === true));

    // The daemon's greeting hook runs for a new direct conversation of an agent with a card.
    if (verb === 'POST' && path === '/conversations') return out(soulLab.newConversation(String(data.agentId ?? '')));

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
        soulLab.cloneCharacter(source.id, copy.id);
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
        chatMode: data.chatMode === 'companion' ? 'companion' : 'work',
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

// ---- soul routes ---------------------------------------------------------------------------------------------------

type SoulBody = Record<string, any>;

/** What the soul lab borrows from the transport. */
interface SoulLabContext {
  state: PaFixture;
  id(prefix: string): string;
  stamp(): { createdAt: number; updatedAt: number; revision: number };
  touch<T extends { revision: number; updatedAt: number }>(record: T, patch: Partial<T>): T;
  later(ms: number, fn: () => void): void;
  runningAttempt(task: PaTask, worker: PersonalAgent): PaAttempt;
  delays: { startMs: number; replyMs: number; liveMs: number; streamStepMs: number; streamHoldAt?: number };
}

/** The live buffer of a running attempt (the daemon's PaSoulLive): the picked raw reply and how much of it has
 *  "arrived" so far. */
interface LabLive {
  attemptId: string;
  taskId: string;
  agentId: string;
  conversationId: string;
  chars: string[];
  shown: number;
  seq: number;
}

/** How long 朗读 takes to "generate" in the lab. */
const LAB_SPEECH_MS = 700;

/** The structural part of a zod schema the lab needs. */
interface BodyParser<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ message: string; path: ReadonlyArray<string | number> }> } };
}

/** Throws the daemon's error envelope as the real `paRequest` would surface it. */
function refuse(status: number, code: string, message: string): never {
  throw new PaRequestError(message, code, status);
}

/** Parses a request body; `data:` asset ids (lab uploads) skip the stored-file id pattern and are kept as sent. */
function parseBody<T>(schema: BodyParser<T>, body: unknown, assetKeys: readonly string[] = []): T {
  const rest: Record<string, unknown> = body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {};
  const inline: Record<string, unknown> = {};
  for (const key of assetKeys) {
    const value = rest[key];
    if (typeof value === 'string' && value.startsWith('data:')) {
      inline[key] = value;
      delete rest[key];
    }
  }
  const parsed = schema.safeParse(rest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refuse(400, 'PA_INVALID_REQUEST', `请求内容无效：${issue ? `${issue.path.join('.') || '内容'} ${issue.message}` : '格式不对'}`);
  }
  return { ...parsed.data, ...inline } as T;
}

/** Removes the items of `list` that `keep` rejects, in place. */
function drop<T>(list: T[], keep: (item: T) => boolean): number {
  let removed = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (!keep(list[index]!)) {
      list.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
const STORY_KINDS: ReadonlySet<string> = new Set(['roll', 'draw', 'event']);
const ASSET_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);
const IMPORT_ERRORS: Record<string, string> = {
  'bad-json': '不是有效的 JSON',
  'too-large': '文件太大',
  'not-object': '内容不是对象',
  'no-name': '缺少名字',
  'unsupported-format': '格式不受支持',
};

/** The soul half of the fixture transport (ARCH 5.8): the soul snapshot and its version, chat turns with canned
 *  replies parsed by the real reply parser, message mutations, play, branches, imports and exports. */
function createSoulLab(ctx: SoulLabContext) {
  const { state, id, stamp, touch, later, delays } = ctx;
  const snap = state.snapshot;
  const soul = (state.soul ??= emptySoulSnapshot('lab'));
  const docs = (state.lorebookDocs ??= []);
  const traces = (state.traces ??= {});
  const candidates = (snap.memoryCandidates ??= []);
  const baseVersion = soul.version;
  let bumps = 0;
  snap.soulVersion = soul.version;
  /** Every change to the soul snapshot moves its version, so the workspace fetches GET /soul again. */
  const bump = () => {
    bumps += 1;
    soul.version = `${baseVersion}.${bumps}`;
    snap.soulVersion = soul.version;
  };
  const rng = seededRng('lab');
  const secrets = new Map<string, string>();                 // draw message id -> card secret (service state)
  const preserved = new Map<string, PaPreserved>();          // agent id -> preserved card data of an import
  const turns = new Map<string, number>();                   // canned-reply rotation per agent
  const finished = new Map<string, PaTask>();                // chat tasks that left the snapshot
  const starting = new Set<string>();                        // chat tasks whose start is scheduled
  const picked = new Map<string, string>();                  // attempt id -> the raw reply it streams and commits
  const live = new Map<string, LabLive>();                   // conversation id -> the running attempt's live buffer
  // message id -> generated audio, with the text and voice it was made for (the daemon's soul_speech key)
  const speech = new Map<string, { item: PaSpeechItem; content: string; voice: string }>();
  const now = () => Date.now();

  // ---- lookups
  const agentOf = (agentId: string | null | undefined) => (agentId ? snap.agents.find((a) => a.id === agentId) : undefined);
  const characterOf = (agentId: string | null | undefined) => (agentId ? soul.characters.find((c) => c.id === agentId) ?? null : null);
  const chatOf = (conversationId: string) => soul.chats.find((c) => c.id === conversationId) ?? null;
  const groupOf = (conv: PaConversation) => (conv.groupId ? snap.groups.find((g) => g.id === conv.groupId) ?? null : null);
  const conversationOf = (conversationId: string) =>
    snap.conversations.find((c) => c.id === conversationId) ?? refuse(404, 'PA_NOT_FOUND', '对话不存在');
  const messageOf = (messageId: string) => snap.messages.find((m) => m.id === messageId) ?? refuse(404, 'PA_NOT_FOUND', '消息不存在');
  const messagesOf = (conversationId: string) => snap.messages.filter((m) => m.conversationId === conversationId);
  const taskOf = (taskId: string) => snap.tasks.find((t) => t.id === taskId);
  const docOf = (lorebookId: string) => docs.find((b) => b.id === lorebookId) ?? refuse(404, 'PA_NOT_FOUND', '世界书不存在');
  const fantayModel = (): PaModel => snap.agents.find((a) => a.avatar === 'fantay')?.model ?? { runtime: 'claude', modelId: 'sonnet' };
  const checkRevision = (record: { revision: number }, revision: unknown) => {
    if (typeof revision === 'number' && revision !== record.revision) refuse(409, 'PA_REVISION_CONFLICT', '内容已被修改，请刷新后再试');
  };
  const ensureChat = (conversationId: string): PaChatView => {
    let chat = chatOf(conversationId);
    if (!chat) {
      chat = emptyChatView(conversationId, now());
      soul.chats.push(chat);
    }
    return chat;
  };
  const modeOf = (conv: PaConversation) => {
    const group = groupOf(conv);
    return resolveChatMode({
      explicit: chatOf(conv.id)?.mode ?? null,
      channel: Boolean(conv.channelId),
      memberIds: group ? group.memberIds : null,
      agentId: conv.agentId,
      hasCard: (agentId) => characterOf(agentId) !== null,
    });
  };
  const requireCompanion = (conv: PaConversation) => {
    if (modeOf(conv) !== 'companion') refuse(400, 'PA_SOUL_MODE', '这个对话不在聊天模式');
  };
  const hasFantay = (conv: PaConversation) => {
    const group = groupOf(conv);
    return (group ? group.memberIds : conv.agentId ? [conv.agentId] : []).some((agentId) => agentOf(agentId)?.avatar === 'fantay');
  };
  const assertIdle = (conversationId: string) => {
    const busy = snap.tasks.some((t) => t.conversationId === conversationId && t.kind === 'chat' && (t.status === 'queued' || t.status === 'running'));
    if (busy) refuse(409, 'PA_SOUL_BUSY', 'TA 还在回复，等说完再试');
  };
  const personaFor = (conv: PaConversation): PaPersona | null => {
    const pinned = chatOf(conv.id)?.personaId ?? (conv.groupId ? null : characterOf(conv.agentId)?.personaId ?? null);
    return soul.personas.find((p) => p.id === pinned) ?? soul.personas.find((p) => p.isDefault) ?? null;
  };
  const presetFor = (conv: PaConversation, agentId: string | null) =>
    resolvePreset(chatOf(conv.id)?.presetId ?? characterOf(agentId)?.presetId, soul.presets, 'zh');
  const namesFor = (conv: PaConversation, agent: PersonalAgent) => {
    const persona = personaFor(conv);
    return { char: characterOf(agent.id)?.nickname || agent.name, user: persona?.name || '你', persona: persona?.description ?? '' };
  };
  /** Direct chat: the character's decks, then built-ins. Room: every member's decks, then built-ins. */
  const decksFor = (conv: PaConversation): PaDeck[] => {
    const group = groupOf(conv);
    if (!group) return availableDecks(characterOf(conv.agentId));
    return availableDecks({ decks: group.memberIds.flatMap((agentId) => characterOf(agentId)?.decks ?? []) });
  };
  const latestDirect = (agentId: string): PaConversation | null =>
    snap.conversations
      .filter((c) => c.agentId === agentId && !c.groupId && !c.channelId)
      .reduce<PaConversation | null>((best, c) => (!best || c.createdAt > best.createdAt ? c : best), null);
  const summarize = (book: PaLorebook) => {
    const summary = lorebookSummary(book);
    const at = soul.lorebooks.findIndex((s) => s.id === book.id);
    if (at >= 0) soul.lorebooks[at] = summary;
    else soul.lorebooks.push(summary);
    return summary;
  };

  // ---- conversations and greetings
  const greet = (conv: PaConversation): void => {
    const agent = agentOf(conv.agentId);
    const character = conv.groupId ? null : characterOf(conv.agentId);
    if (!agent || !character) return;
    ensureChat(conv.id);
    bump();
    if (!character.firstMessage.trim()) return;
    snap.messages.push({
      ...stamp(),
      id: id('m'),
      conversationId: conv.id,
      taskId: null,
      senderId: agent.id,
      content: greetingText(character.firstMessage, namesFor(conv, agent), now(), conv.id),
      targetAgentIds: [],
      replyTo: null,
      soul: { kind: 'greeting', greetingIndex: 0, ...(character.openers.length > 0 ? { choices: [...character.openers] } : {}) },
    });
  };
  const newConversation = (agentId: string): PaConversation => {
    const conv: PaConversation = { ...stamp(), id: id('conv'), title: agentOf(agentId)?.name ?? 'Fantay', agentId, groupId: null };
    snap.conversations.push(conv);
    greet(conv);
    return conv;
  };

  // ---- chat turns: queued → running after startMs → one reply per speaker every replyMs → removed from the snapshot
  const memberNames = (members: readonly PersonalAgent[]) =>
    members.map((m) => ({ id: m.id, names: [m.name, characterOf(m.id)?.nickname ?? ''].filter(Boolean) }));
  const speakersFor = (conv: PaConversation, goal: string, targets: readonly string[], crisis: boolean): string[] => {
    const group = groupOf(conv);
    let speakers: string[];
    if (!group) speakers = conv.agentId ? [conv.agentId] : [];
    else {
      const members = group.memberIds
        .map((agentId) => agentOf(agentId))
        .filter((a): a is PersonalAgent => Boolean(a?.enabled && a.tools.includes('respond')));
      const eligible = new Set(members.map((m) => m.id));
      const named = mentionedMembers(goal, memberNames(members));
      const strategy = chatOf(conv.id)?.groupStrategy ?? 'natural';
      if (targets.some((t) => eligible.has(t))) speakers = targets.filter((t) => eligible.has(t));
      else if (named.length > 0) speakers = named;
      else if (mentionsEveryone(goal) || strategy === 'list') speakers = members.map((m) => m.id);
      else if (strategy === 'manual') speakers = eligible.has(group.moderatorId) ? [group.moderatorId] : members.slice(0, 1).map((m) => m.id);
      else {
        const history = messagesOf(conv.id);
        const newest = history[history.length - 1];
        const previous = newest && newest.senderId !== 'owner' ? newest.senderId : null;
        const picked = pickNaturalSpeaker(members.map((m) => ({ id: m.id, talkativeness: characterOf(m.id)?.talkativeness ?? 0.5 })), previous, rng);
        speakers = picked ? [picked] : [];
      }
    }
    return (crisis ? speakers.slice(0, 1) : speakers).slice(0, SOUL_LIMITS.speakersPerTurn);
  };
  const chatTask = (conversationId: string, goal: string, requestId: string, speakers: string[], taskSoul?: PaTaskSoul): PaTask => {
    const task: PaTask = {
      ...stamp(),
      id: id('tk'),
      requestId,
      conversationId,
      goal,
      kind: 'chat',
      ...(taskSoul ? { soul: taskSoul } : {}),
      projectName: '',
      projectId: null,
      projectConversationId: null,
      status: 'queued',
      waitingReason: null,
      error: null,
      participantIds: speakers,
      nextParticipant: 0,
      budget: { maxAttempts: speakers.length + 2, timeoutMs: Math.min(1_800_000, 120_000 * speakers.length) },
      authorization: { localProject: false, externalWrites: false, version: 1, revoked: false },
      amendments: [],
      evidence: [],
    };
    snap.tasks.push(task);
    pump(conversationId);
    return task;
  };
  /** One active chat task per conversation: the oldest queued one starts once nothing runs. */
  const pump = (conversationId: string): void => {
    const chats = snap.tasks.filter((t) => t.conversationId === conversationId && t.kind === 'chat');
    if (chats.some((t) => t.status === 'running' || starting.has(t.id))) return;
    const next = chats.find((t) => t.status === 'queued');
    if (!next) return;
    starting.add(next.id);
    later(delays.startMs, () => {
      starting.delete(next.id);
      if (taskOf(next.id) !== next || next.status !== 'queued') return pump(conversationId);
      touch(next, { status: 'running' });
      speak(next);
    });
  };
  const speak = (task: PaTask): void => {
    const who = agentOf(task.participantIds[task.nextParticipant]);
    if (!who) return finish(task);
    const attempt = ctx.runningAttempt(task, who);
    stream(task, attempt, delays.replyMs);
    if (delays.streamHoldAt === undefined) later(delays.replyMs, () => commit(task, attempt));
  };
  /** Finished and cancelled chat tasks leave the snapshot with their attempts (ADDENDUM 3); their messages stay. */
  const finish = (task: PaTask, status: 'completed' | 'cancelled' = 'completed'): void => {
    drop(snap.tasks, (t) => t !== task);
    drop(snap.attempts, (a) => a.taskId !== task.id);
    endLive((entry) => entry.taskId === task.id);
    finished.set(task.id, { ...task, status, updatedAt: now() });
    pump(task.conversationId);
  };

  // ---- live text (stage 2): the daemon's PaSoulLive over the canned raw reply
  const careOf = (task: PaTask): 'crisis' | 'none' =>
    snap.messages.some((m) => m.taskId === task.id && m.senderId === 'owner' && m.soul?.care === 'crisis') ? 'crisis' : 'none';
  /** The parse context of a reply: what commit hands parseSoulReply, and what the live text runs through. */
  const replyContext = (conv: PaConversation, agent: PersonalAgent, care: 'crisis' | 'none'): SoulReplyContext => {
    const character = characterOf(agent.id);
    const group = groupOf(conv);
    const preset = presetFor(conv, agent.id);
    return {
      schema: group ? [] : character?.stateSchema ?? [],
      parts: resolveMetaParts({ preset, character, chat: chatOf(conv.id) ?? PA_DEFAULT_CHAT_SETTINGS, group: group !== null, care }),
      speakerNames: [agent.name, character?.nickname ?? ''].filter(Boolean),
      userName: personaFor(conv)?.name || '你',
      otherNames: group ? group.memberIds.filter((m) => m !== agent.id).map((m) => agentOf(m)?.name ?? '').filter(Boolean) : [],
      format: preset.format,
      decks: decksFor(conv).map((deck) => ({ id: deck.id, name: deck.name })),
    };
  };
  /** The raw reply of an attempt, picked once: the stream shows it and commit stores it. */
  const rawFor = (task: PaTask, attempt: PaAttempt): string => {
    let raw = picked.get(attempt.id);
    if (raw === undefined) {
      raw = careOf(task) === 'crisis' ? CRISIS_REPLY : nextReply(attempt.agentSnapshot);
      picked.set(attempt.id, raw);
    }
    return raw;
  };
  const endLive = (match: (entry: LabLive) => boolean): void => {
    for (const [conversationId, entry] of [...live]) {
      if (!match(entry)) continue;
      live.delete(conversationId);
      picked.delete(entry.attemptId);
    }
  };
  /** Appends the next slice of the picked reply every streamStepMs, the reply spread evenly over `durationMs`. With
   *  streamHoldAt the stream stops at that share and the turn is never committed (screenshots). */
  const stream = (task: PaTask, attempt: PaAttempt, durationMs: number): void => {
    const chars = Array.from(rawFor(task, attempt));
    if (delays.streamStepMs <= 0) return;
    const steps = Math.max(1, Math.floor(durationMs / delays.streamStepMs));
    const per = Math.max(1, Math.ceil(chars.length / steps));
    const stopAt = delays.streamHoldAt === undefined ? chars.length : Math.round(chars.length * delays.streamHoldAt);
    const entry: LabLive = { attemptId: attempt.id, taskId: task.id, agentId: attempt.agentSnapshot.id, conversationId: task.conversationId, chars, shown: 0, seq: 0 };
    live.set(task.conversationId, entry);
    const step = () => {
      if (live.get(entry.conversationId) !== entry || entry.shown >= stopAt) return;
      entry.shown = Math.min(stopAt, entry.shown + per);
      entry.seq += 1;
      if (entry.shown < stopAt) later(delays.streamStepMs, step);
    };
    later(delays.streamStepMs, step);
  };
  /** GET /soul/live: the newest attempt of the conversation, `unchanged` for a matching attempt and seq. */
  const readLive = (url: URL): { live: PaSoulLiveText | null } => {
    const conversationId = url.searchParams.get('conversationId') ?? '';
    const attempt = url.searchParams.get('attempt');
    const seqText = url.searchParams.get('seq');
    const seq = seqText === null ? null : Number(seqText);
    if (!conversationId || conversationId.length > 100 || (attempt !== null && attempt.length > 100) || (seq !== null && !(Number.isSafeInteger(seq) && seq >= 0))) {
      return refuse(400, 'PA_INVALID_REQUEST', '请求内容无效：conversationId');
    }
    const entry = live.get(conversationId);
    if (!entry) return { live: null };
    const head = { attemptId: entry.attemptId, taskId: entry.taskId, agentId: entry.agentId, seq: entry.seq };
    if (attempt !== null && seq !== null && attempt === entry.attemptId && seq === entry.seq) return { live: { ...head, unchanged: true } };
    const conv = snap.conversations.find((c) => c.id === conversationId);
    const agent = agentOf(entry.agentId);
    const task = taskOf(entry.taskId);
    let text = '';
    try {
      if (conv && agent && task) text = liveReplyText(entry.chars.slice(0, entry.shown).join(''), replyContext(conv, agent, careOf(task))).slice(0, SOUL_LIMITS.messageContent);
    } catch {
      text = '';
    }
    return { live: { ...head, text } };
  };
  const nextReply = (agent: PersonalAgent): string => {
    const origin = characterOf(agent.id)?.origin;
    const list = state.replies?.[agent.id] ?? starterReplies(origin?.format === 'starter' ? origin.name : '', now());
    const turn = turns.get(agent.id) ?? 0;
    turns.set(agent.id, turn + 1);
    return list[turn % list.length] ?? '嗯，我在。';
  };
  const dueEnd = (day: string) => {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, 23, 59, 59, 999).getTime();
  };
  const fold = (text: string) => text.normalize('NFKC').trim();
  /** Remember lines become pending candidates under the reply; duplicates of known memories are skipped. */
  const propose = (task: PaTask, attempt: PaAttempt, conversationId: string, items: SoulReply['remember']) => {
    const agentId = attempt.agentSnapshot.id;
    const known = new Set([
      ...snap.memories.filter((m) => m.scope === 'agent' && m.scopeId === agentId).map((m) => fold(m.content)),
      ...candidates.filter((c) => c.conversationId === conversationId && c.status === 'pending').map((c) => fold(c.content)),
    ]);
    items.forEach((item, n) => {
      if (known.has(fold(item.text))) return;
      known.add(fold(item.text));
      const candidate: PaMemoryCandidate = {
        ...stamp(),
        id: `${attempt.id}:${n}`,
        taskId: task.id,
        attemptId: attempt.id,
        content: item.text,
        dataClass: 'standard',
        status: 'pending',
        kind: item.kind,
        dueAt: item.due ? dueEnd(item.due) : null,
        sourceMessageId: attempt.id,
        agentId,
        conversationId,
      };
      candidates.push(candidate);
    });
    const pending = candidates.filter((c) => c.conversationId === conversationId && c.status === 'pending');
    const excess = new Set(pending.slice(0, Math.max(0, pending.length - SOUL_LIMITS.pendingCandidates)));
    drop(candidates, (c) => !excess.has(c));
  };
  const postEvent = (conversationId: string, event: { id: string; title: string; summary: string }, phase: 'accepted' | 'ended', requestId: string): PaMessage => {
    const message: PaMessage = {
      ...stamp(),
      id: id('m'),
      conversationId,
      taskId: null,
      senderId: 'owner',
      content: storyText({ kind: 'event', title: event.title, phase }, 'zh'),
      targetAgentIds: [],
      replyTo: null,
      soul: { kind: 'event', requestId, event: { id: event.id, title: event.title, summary: event.summary, phase } },
    };
    snap.messages.push(message);
    return message;
  };
  /** An accepted interlude lasts PA_EVENT_TURNS turns; the last one posts the ended story item. */
  const tickInterlude = (conversationId: string) => {
    const chat = chatOf(conversationId);
    const event = chat?.activeEvent;
    if (!chat || !event) return;
    if (event.remainingTurns > 1) touch(chat, { activeEvent: { ...event, remainingTurns: event.remainingTurns - 1 } });
    else {
      touch(chat, { activeEvent: null });
      postEvent(conversationId, event, 'ended', id('req'));
    }
    bump();
  };
  const commit = (task: PaTask, attempt: PaAttempt): void => {
    if (taskOf(task.id) !== task || task.status !== 'running' || attempt.status !== 'running') return;
    const conv = snap.conversations.find((c) => c.id === task.conversationId);
    if (!conv) return finish(task);
    const agent = attempt.agentSnapshot;
    const group = groupOf(conv);
    const context = replyContext(conv, agent, careOf(task));
    const parts = context.parts;
    const raw = rawFor(task, attempt);
    endLive((entry) => entry.attemptId === attempt.id);
    const reply = parseSoulReply(raw, context);
    const at = now();
    if (reply.empty) {
      touch(attempt, { status: 'failed', endedAt: at, output: raw, error: '回复内容为空，请重试' });
      touch(task, { status: 'failed', error: '回复内容为空，请重试' });
      return pump(conv.id);
    }
    const root = task.soul?.regenerateOf ? snap.messages.find((m) => m.id === task.soul?.regenerateOf) : undefined;
    const replySoul: PaMessageSoul = {
      kind: 'chat',
      footer: reply.footer,
      ...(reply.mood !== undefined ? { mood: reply.mood } : {}),
      ...(parts.state && !group && reply.stateOps.length > 0 ? { stateOps: reply.stateOps } : {}),
      ...(reply.choices.length > 0 ? { choices: reply.choices } : {}),
      ...(reply.play.length > 0 ? { play: reply.play } : {}),
      ...(root ? { variantOf: root.id } : {}),
      ...(task.soul?.directive === 'reachout' ? { proactive: true } : {}),
    };
    snap.messages.push({
      ...stamp(),
      id: attempt.id,
      conversationId: conv.id,
      taskId: task.id,
      senderId: agent.id,
      content: reply.text.slice(0, SOUL_LIMITS.messageContent),
      targetAgentIds: [],
      replyTo: null,
      model: agent.model,
      attemptId: attempt.id,
      soul: replySoul,
    });
    if (root) touch(root, { soul: { ...(root.soul ?? { kind: 'chat' }), activeVariant: attempt.id } });
    if (parts.remember) propose(task, attempt, conv.id, reply.remember);
    touch(attempt, { status: 'completed', endedAt: at, output: raw });
    touch(task, { nextParticipant: task.nextParticipant + 1 });
    if (task.nextParticipant < task.participantIds.length) return speak(task);
    tickInterlude(conv.id);
    finish(task);
  };

  const sendChat = (data: SoulBody): PaTask => {
    const conv = conversationOf(String(data.conversationId ?? ''));
    if (conv.channelId) refuse(400, 'PA_SOUL_MODE', '渠道会话不能用聊天模式');
    requireCompanion(conv);
    const goal = String(data.goal ?? '').trim();
    if (!goal) refuse(400, 'PA_INVALID_REQUEST', '消息不能为空');
    const requestId = String(data.requestId ?? id('req'));
    const sent = snap.messages.find((m) => m.conversationId === conv.id && m.soul?.requestId === requestId);
    const earlier = sent?.taskId ? taskOf(sent.taskId) ?? finished.get(sent.taskId) : undefined;
    if (earlier) return earlier;
    const targets: string[] = Array.isArray(data.targetAgentIds) ? data.targetAgentIds.filter((x: unknown): x is string => typeof x === 'string') : [];
    const replyTo = typeof data.replyTo === 'string' ? data.replyTo : null;
    const group = groupOf(conv);
    const ownerTexts = messagesOf(conv.id)
      .filter((m) => m.senderId === 'owner' && m.soul?.kind === 'chat')
      .map((m) => m.content)
      .reverse();
    const preset = presetFor(conv, group ? null : conv.agentId);
    const crisis = detectCrisis([goal, ...ownerTexts.slice(0, 2)], { fiction: preset.id === 'builtin:game-master' }).level === 'crisis';
    // Coalescing (ARCH 4.5): a queued, unstarted plain chat task absorbs the message.
    const target = snap.tasks.find((t) => t.conversationId === conv.id && t.kind === 'chat' && t.status === 'queued' && !t.soul);
    const members = group ? group.memberIds.map((m) => agentOf(m)).filter((a): a is PersonalAgent => Boolean(a)) : [];
    const plain = !group || (targets.length === 0 && !replyTo && !mentionsEveryone(goal) && mentionedMembers(goal, memberNames(members)).length === 0);
    let task = target && plain ? target : undefined;
    if (!task) {
      const speakers = speakersFor(conv, goal, targets, crisis);
      if (speakers.length === 0) refuse(400, 'PA_SOUL_NO_SPEAKER', '没有可以回复的角色');
      task = chatTask(conv.id, goal, requestId, speakers);
    }
    snap.messages.push({
      ...stamp(),
      id: id('m'),
      conversationId: conv.id,
      taskId: task.id,
      senderId: 'owner',
      content: goal,
      targetAgentIds: targets,
      replyTo,
      soul: { kind: 'chat', personaId: personaFor(conv)?.id ?? null, requestId, ...(crisis ? { care: 'crisis' as const } : {}) },
    });
    return task;
  };
  const continueTurn = (conv: PaConversation, requestId: string, agentId: string | undefined, directive: 'continue' | 'reachout'): PaTask => {
    const same = snap.tasks.find((t) => t.requestId === requestId) ?? [...finished.values()].find((t) => t.requestId === requestId);
    if (same) return same;
    requireCompanion(conv);
    assertIdle(conv.id);
    const goal = directive === 'reachout' ? '先开口' : '接着说';
    const speakers = agentId ? [agentId] : speakersFor(conv, goal, [], false);
    if (speakers.length === 0) refuse(400, 'PA_SOUL_NO_SPEAKER', '没有可以接话的角色');
    return chatTask(conv.id, goal, requestId, speakers, { directive, hiddenOwner: true });
  };
  /** 重试 resumes only while the turn's own message is still the newest (ARCH 4.4 R6). */
  const assertResumable = (task: PaTask) => {
    const history = messagesOf(task.conversationId);
    const slots = visibleSlots(history);
    const newest = slots[slots.length - 1]?.selected;
    const stale = task.soul?.hiddenOwner
      ? history.some((m) => m.taskId !== task.id && m.soul?.hidden !== true && m.createdAt > task.createdAt)
      : !newest || newest.taskId !== task.id;
    if (stale) refuse(409, 'PA_SOUL_STALE', '后面已经有新消息了，请重新发送');
  };
  const taskAction = (task: PaTask, action: string): unknown => {
    if (action === 'cancel') {
      finish(task, 'cancelled');
      return { ...task, status: 'cancelled' };
    }
    if (action === 'resume') {
      if (task.status !== 'failed' && task.status !== 'waiting') return task;
      assertResumable(task);
      touch(task, { status: 'queued', error: null, waitingReason: null });
      pump(task.conversationId);
      return task;
    }
    return refuse(400, 'PA_INVALID_REQUEST', '对话回复不能补充要求或重新分派');
  };
  /** Chat turns already queued or running in the fixture: the running one streams its reply over `liveMs` and then
   *  replies (unless the stream is held). */
  const start = () => {
    for (const task of [...snap.tasks]) {
      if (task.kind !== 'chat') continue;
      if (task.status === 'queued') pump(task.conversationId);
      if (task.status !== 'running') continue;
      const running = snap.attempts.find((a) => a.taskId === task.id && a.status === 'running');
      if (!running) {
        speak(task);
        continue;
      }
      stream(task, running, delays.liveMs);
      if (delays.streamHoldAt === undefined) later(delays.liveMs, () => commit(task, running));
    }
  };

  // ---- message mutations
  const mutable = (message: PaMessage): PaConversation => {
    const conv = conversationOf(message.conversationId);
    requireCompanion(conv);
    assertIdle(conv.id);
    const own = message.taskId ? taskOf(message.taskId) : undefined;
    if (own && own.kind !== 'chat') refuse(409, 'PA_SOUL_MESSAGE', '工作任务里的消息不能在这里修改');
    if (own && !TERMINAL.has(own.status)) refuse(409, 'PA_SOUL_MESSAGE', '这条消息的回复还没有结束');
    return conv;
  };
  const editMessage = (messageId: string, data: SoulBody): PaMessage => {
    const message = messageOf(messageId);
    mutable(message);
    checkRevision(message, data.revision);
    const next: PaMessageSoul = { ...(message.soul ?? { kind: 'chat' }) };
    let content = message.content;
    if (typeof data.content === 'string') {
      if (STORY_KINDS.has(next.kind)) refuse(409, 'PA_SOUL_MESSAGE', '故事条目不能编辑');
      content = data.content.trim().slice(0, SOUL_LIMITS.messageContent);
      if (!content) refuse(400, 'PA_INVALID_REQUEST', '内容不能为空');
      if (content !== message.content) next.edited = true;
    }
    if (data.hidden === true) next.hidden = true;
    if (data.hidden === false) delete next.hidden;
    return touch(message, { content, soul: next });
  };
  const deleteMessage = (messageId: string, data: SoulBody) => {
    const message = messageOf(messageId);
    const conv = mutable(message);
    checkRevision(message, data.revision);
    const slots = visibleSlots(messagesOf(conv.id));
    const chat = chatOf(conv.id);
    let ops: PaUserStateOp[] = chat?.userStateOps ?? [];
    const variants = snap.messages.filter((m) => m.conversationId === conv.id && m.id !== message.id && m.soul?.variantOf === message.id);
    drop(snap.messages, (m) => m !== message);
    const promoted = variants.find((v) => v.id === message.soul?.activeVariant) ?? variants[0];
    if (promoted) {
      // The root goes: the selected (else the earliest) variant becomes the root of the slot.
      const promotedSoul: PaMessageSoul = { ...(promoted.soul ?? { kind: 'chat' }) };
      delete promotedSoul.variantOf;
      delete promotedSoul.activeVariant;
      touch(promoted, { soul: promotedSoul });
      for (const sibling of variants) if (sibling !== promoted) touch(sibling, { soul: { ...(sibling.soul ?? { kind: 'chat' }), variantOf: promoted.id } });
      ops = reanchorUserOps(ops, { renamed: message.id, to: promoted.id });
    } else if (message.soul?.variantOf) {
      const root = snap.messages.find((m) => m.id === message.soul?.variantOf);
      if (root?.soul?.activeVariant === message.id) {
        const rootSoul: PaMessageSoul = { ...root.soul };
        delete rootSoul.activeVariant;
        touch(root, { soul: rootSoul });
      }
    } else {
      const at = slots.findIndex((s) => s.slotId === message.id);
      ops = reanchorUserOps(ops, { removed: message.id, previous: at > 0 ? slots[at - 1]!.slotId : null });
    }
    secrets.delete(message.id);
    speech.delete(message.id);
    delete traces[message.id];
    const removedMemories = data.forget === true ? drop(snap.memories, (m) => m.sourceMessageId !== message.id) : 0;
    if (chat && JSON.stringify(ops) !== JSON.stringify(chat.userStateOps)) {
      touch(chat, { userStateOps: ops });
      bump();
    }
    return { ok: true, removedMemories };
  };
  const selectVariant = (rootId: string, data: SoulBody): PaMessage => {
    const root = messageOf(rootId);
    const conv = conversationOf(root.conversationId);
    requireCompanion(conv);
    assertIdle(conv.id);
    if (typeof data.messageId === 'string') {
      const known = data.messageId === root.id || snap.messages.some((m) => m.id === data.messageId && m.soul?.variantOf === root.id);
      if (!known) refuse(409, 'PA_SOUL_VARIANT', '这不是这条消息的另一个说法');
      const next: PaMessageSoul = { ...(root.soul ?? { kind: 'chat' }) };
      if (data.messageId === root.id) delete next.activeVariant;
      else next.activeVariant = data.messageId;
      return touch(root, { soul: next });
    }
    // Another greeting: rewritten in place from the card, while nothing follows it.
    const index = Number(data.greetingIndex);
    const character = characterOf(root.senderId);
    const agent = agentOf(root.senderId);
    if (root.soul?.kind !== 'greeting' || root.soul.greetingIndex === undefined || !character || !agent) {
      return refuse(409, 'PA_SOUL_VARIANT', '只有开场白可以这样切换');
    }
    const template = Number.isInteger(index) ? [character.firstMessage, ...character.alternateGreetings][index] : undefined;
    if (template === undefined) return refuse(409, 'PA_SOUL_VARIANT', '没有这一版开场白');
    const slots = visibleSlots(messagesOf(conv.id));
    if (slots.findIndex((s) => s.slotId === root.id) < slots.length - 1) refuse(409, 'PA_SOUL_VARIANT', '开场白后面已经有消息了');
    const next: PaMessageSoul = { ...root.soul, greetingIndex: index };
    if (index === 0 && character.openers.length > 0) next.choices = [...character.openers];
    else delete next.choices;
    return touch(root, { content: greetingText(template, namesFor(conv, agent), now(), conv.id), soul: next });
  };
  const reveal = (messageId: string): PaMessage => {
    const message = messageOf(messageId);
    const conv = conversationOf(message.conversationId);
    assertIdle(conv.id);
    const current = message.soul;
    const draw = current?.kind === 'draw' ? current.draw : undefined;
    if (!current || !draw) return refuse(409, 'PA_SOUL_MESSAGE', '只有抽到的牌可以揭晓');
    const secret =
      secrets.get(message.id) ?? decksFor(conv).find((d) => d.id === draw.deckId)?.cards.find((card) => card.title === draw.title)?.secret;
    if (!secret) return refuse(409, 'PA_SOUL_MESSAGE', '这张牌没有只有 TA 知道的内容');
    secrets.delete(message.id);
    return touch(message, { soul: { ...current, draw: { ...draw, secret } } });
  };
  const branch = (conversationId: string, data: SoulBody): PaConversation => {
    const conv = conversationOf(conversationId);
    if (!conv.agentId || conv.groupId) refuse(400, 'PA_INVALID_REQUEST', '只有单聊可以开支线');
    requireCompanion(conv);
    assertIdle(conv.id);
    const slots = visibleSlots(messagesOf(conv.id));
    const upTo = slots.findIndex((s) => s.slotId === slotIdOf(messageOf(String(data.messageId ?? ''))));
    if (upTo < 0) refuse(404, 'PA_NOT_FOUND', '消息不存在');
    const at = now();
    const copy: PaConversation = { ...stamp(), id: id('conv'), title: `${agentOf(conv.agentId)?.name ?? conv.title} · 支线`, agentId: conv.agentId, groupId: null };
    snap.conversations.push(copy);
    const remap = new Map<string, string>();
    for (const slot of slots.slice(0, upTo + 1)) {
      const original = slot.selected;
      const kept: PaMessageSoul = { ...(original.soul ?? { kind: 'chat' }) };
      delete kept.variantOf;
      delete kept.activeVariant;
      delete kept.requestId;
      const next: PaMessage = {
        ...stamp(),
        id: id('m'),
        conversationId: copy.id,
        taskId: null,
        senderId: original.senderId,
        content: original.content,
        targetAgentIds: [],
        replyTo: null,
        ...(original.model ? { model: original.model } : {}),
        ...(original.dataClass ? { dataClass: original.dataClass } : {}),
        soul: { ...kept, at: messageAt(original), copiedFrom: original.id },
      };
      snap.messages.push(next);
      remap.set(slot.slotId, next.id);
      const secret = secrets.get(original.id);
      if (secret) secrets.set(next.id, secret);
    }
    const source = chatOf(conv.id);
    soul.chats.push({
      ...(source ? structuredClone(source) : emptyChatView(copy.id, at)),
      id: copy.id,
      createdAt: at,
      updatedAt: at,
      revision: 1,
      activeEvent: null,
      candidateEvent: null,
      branchOf: { conversationId: conv.id, messageId: String(data.messageId) },
      userStateOps: (source?.userStateOps ?? []).flatMap((op) => {
        if (op.after === null) return [{ ...op }];
        const after = remap.get(op.after);
        return after ? [{ ...op, after }] : [];
      }),
    });
    bump();
    return copy;
  };

  // ---- generation and play
  const regenerate = (data: SoulBody): PaTask => {
    const conv = conversationOf(String(data.conversationId ?? ''));
    requireCompanion(conv);
    assertIdle(conv.id);
    const slotId = slotIdOf(messageOf(String(data.messageId ?? '')));
    const slots = visibleSlots(messagesOf(conv.id));
    const last = slots[slots.length - 1];
    if (!last || last.slotId !== slotId || last.selected.senderId === 'owner' || last.selected.soul?.kind !== 'chat') {
      return refuse(409, 'PA_SOUL_VARIANT', '只能给最新的一条回复换个说法');
    }
    if (last.variants.length >= SOUL_LIMITS.variantsPerSlot) refuse(409, 'PA_SOUL_LIMIT', '这条回复的说法已经够多了');
    return chatTask(conv.id, '换个说法', String(data.requestId ?? id('req')), [last.selected.senderId], { regenerateOf: slotId, hiddenOwner: true });
  };
  const story = (conversationId: string, content: string, storySoul: PaMessageSoul): PaMessage => {
    const message: PaMessage = { ...stamp(), id: id('m'), conversationId, taskId: null, senderId: 'owner', content, targetAgentIds: [], replyTo: null, soul: storySoul };
    snap.messages.push(message);
    return message;
  };
  /** Idempotency of story requests (ARCH 4.6): the message that already carries this request id. */
  const storyOf = (conversationId: string, requestId: string) =>
    messagesOf(conversationId).find((m) => m.soul?.requestId === requestId && STORY_KINDS.has(m.soul.kind));
  const roll = (data: SoulBody) => {
    const conv = conversationOf(String(data.conversationId ?? ''));
    requireCompanion(conv);
    const requestId = String(data.requestId ?? id('req'));
    const earlier = storyOf(conv.id, requestId);
    if (earlier) return { message: earlier, task: null };
    assertIdle(conv.id);
    const label = typeof data.label === 'string' && data.label.trim() ? data.label.trim().slice(0, 40) : undefined;
    const result = rollDice(String(data.notation ?? ''), rng, typeof data.dc === 'number' ? data.dc : undefined);
    if (!result) return refuse(400, 'PA_INVALID_REQUEST', '骰子的写法不对，比如 d20 或 2d6+1');
    const message = story(conv.id, storyText({ kind: 'roll', roll: result, ...(label ? { label } : {}) }, 'zh'), {
      kind: 'roll',
      requestId,
      roll: { ...result, ...(label ? { label } : {}) },
    });
    const task = data.respond === false ? null : continueTurn(conv, `${requestId}:respond`, undefined, 'continue');
    return { message, task };
  };
  const draw = (data: SoulBody) => {
    const conv = conversationOf(String(data.conversationId ?? ''));
    requireCompanion(conv);
    const requestId = String(data.requestId ?? id('req'));
    const earlier = storyOf(conv.id, requestId);
    if (earlier) return { message: earlier, task: null };
    assertIdle(conv.id);
    const deck = decksFor(conv).find((d) => d.id === data.deckId) ?? refuse(404, 'PA_NOT_FOUND', '没有这副牌');
    const { card } = drawCard(deck, rng);
    const message = story(conv.id, storyText({ kind: 'draw', deckName: deck.name, title: card.title, text: card.text }, 'zh'), {
      kind: 'draw',
      requestId,
      draw: { deckId: deck.id, deckName: deck.name, title: card.title, text: card.text, ...(card.secret ? { hasSecret: true } : {}) },
    });
    if (card.secret) secrets.set(message.id, card.secret);
    const task = data.respond === false ? null : continueTurn(conv, `${requestId}:respond`, undefined, 'continue');
    return { message, task };
  };
  const eventAction = (data: SoulBody) => {
    const conv = conversationOf(String(data.conversationId ?? ''));
    requireCompanion(conv);
    const requestId = String(data.requestId ?? id('req'));
    const action = String(data.action ?? '');
    if (action === 'accept' || action === 'stop') assertIdle(conv.id);
    const chat = ensureChat(conv.id);
    let message: PaMessage | null = null;
    let task: PaTask | null = null;
    if (action === 'draw') {
      const exclude = [chat.candidateEvent?.id, chat.activeEvent?.id].filter((x): x is string => Boolean(x));
      const beat = drawInterlude(exclude, rng);
      touch(chat, { candidateEvent: { id: beat.id, title: beat.title.zh, summary: beat.summary.zh } });
    } else if (action === 'skip') {
      touch(chat, { candidateEvent: null });
    } else if (action === 'accept') {
      const candidate = chat.candidateEvent ?? refuse(400, 'PA_INVALID_REQUEST', '现在没有可以接受的小插曲');
      touch(chat, { activeEvent: { ...candidate, remainingTurns: PA_EVENT_TURNS }, candidateEvent: null });
      message = postEvent(conv.id, candidate, 'accepted', requestId);
      if (data.respond !== false) task = continueTurn(conv, `${requestId}:respond`, undefined, 'continue');
    } else if (action === 'stop') {
      const active = chat.activeEvent ?? refuse(400, 'PA_INVALID_REQUEST', '现在没有进行中的小插曲');
      touch(chat, { activeEvent: null });
      message = postEvent(conv.id, active, 'ended', requestId);
    } else {
      refuse(400, 'PA_INVALID_REQUEST', '未知的小插曲操作');
    }
    bump();
    return { chat, message, task };
  };

  // ---- chat settings and story state
  const saveChat = (conversationId: string, data: SoulBody): PaChatView => {
    const conv = conversationOf(conversationId);
    const { revision, ...rest } = data;
    const patch = parseBody(paChatSettingsPatchSchema, rest);
    if (patch.mode === 'companion' && hasFantay(conv)) refuse(409, 'PA_SOUL_FANTAY', 'Fantay 不进入聊天模式');
    const existing = chatOf(conv.id);
    let chat: PaChatView;
    if (existing) {
      checkRevision(existing, revision);
      chat = touch(existing, patch);
    } else {
      chat = { ...emptyChatView(conv.id, now()), ...patch };
      soul.chats.push(chat);
    }
    bump();
    return chat;
  };
  const applyStateOps = (data: SoulBody): PaChatView => {
    const conv = conversationOf(String(data.conversationId ?? ''));
    requireCompanion(conv);
    const character = conv.groupId ? null : characterOf(conv.agentId);
    if (!character || character.stateSchema.length === 0) return refuse(409, 'PA_SOUL_STATE', '这个对话没有状态栏');
    const raw: unknown[] = Array.isArray(data.ops) ? data.ops : [];
    if (raw.length < 1 || raw.length > SOUL_LIMITS.stateOpsPerCall) refuse(400, 'PA_INVALID_REQUEST', '一次只能改 1 到 16 项');
    const schema = character.stateSchema;
    const history = messagesOf(conv.id);
    const slots = visibleSlots(history);
    const after = slots[slots.length - 1]?.slotId ?? null;
    const chat = ensureChat(conv.id);
    let list: PaUserStateOp[] = [...chat.userStateOps];
    for (const item of raw) {
      const op: PaStateOp = parseBody(paStateOpInputSchema, item);
      if (!applyOp(schema, foldChatState(schema, chatStateSlots(history), list), op, 'user')) {
        refuse(400, 'PA_INVALID_REQUEST', `「${op.key}」不能这样改`);
      }
      if (op.op === 'set') list = list.filter((o) => !(o.after === after && o.key === op.key));
      list.push({ ...op, after });
    }
    if (list.length > SOUL_LIMITS.userStateOps) refuse(409, 'PA_SOUL_LIMIT', '手动改过的状态太多了');
    touch(chat, { userStateOps: list });
    bump();
    return chat;
  };

  // ---- characters, starters, cards
  /** First card of an agent: conversations that already hold work stay in work mode (ARCH 1.2). */
  const keepWorkChats = (agentId: string) => {
    for (const conv of snap.conversations) {
      const group = groupOf(conv);
      const concerned = group
        ? group.memberIds.includes(agentId) && group.memberIds.every((m) => characterOf(m) !== null)
        : conv.agentId === agentId && !conv.channelId;
      if (!concerned || chatOf(conv.id)?.mode) continue;
      if (!snap.messages.some((m) => m.conversationId === conv.id && m.taskId)) continue;
      touch(ensureChat(conv.id), { mode: 'work' });
    }
  };
  const saveCharacter = (agentId: string, data: SoulBody): PaCharacterView => {
    const agent = agentOf(agentId) ?? refuse(404, 'PA_NOT_FOUND', '角色不存在');
    if (agent.avatar === 'fantay') refuse(409, 'PA_SOUL_FANTAY', 'Fantay 不使用角色设定');
    const { revision, sprites: spriteBody, ...rest } = data;
    // Sprites are checked on their own: lab uploads are `data:` ids, which skip the stored-file id pattern per key.
    const sprites = spriteBody === undefined ? null : parseBody(paSpritesSchema, spriteBody, PA_EMOTIONS);
    const existing = characterOf(agentId);
    let view: PaCharacterView;
    if (existing) {
      checkRevision(existing, revision);
      view = touch(existing, { ...parseBody(paCharacterPatchSchema, rest, ['portraitAssetId']), ...(sprites ? { sprites } : {}) });
    } else {
      view = {
        ...parseBody(paCharacterInputSchema, rest, ['portraitAssetId']),
        ...(sprites ? { sprites } : {}),
        ...stamp(),
        id: agentId,
        origin: { format: 'native', name: agent.name, importedAt: now() },
        needsReview: [],
        preservedKeys: [],
      };
      soul.characters.push(view);
      keepWorkChats(agentId);
    }
    bump();
    return view;
  };
  const removeCharacter = (agentId: string, data: SoulBody) => {
    const character = characterOf(agentId) ?? refuse(404, 'PA_NOT_FOUND', '这个角色没有角色设定');
    checkRevision(character, data.revision);
    drop(soul.characters, (c) => c !== character);
    preserved.delete(agentId);
    const removedMemories = data.forgetMemories === true ? drop(snap.memories, (m) => !(m.scope === 'agent' && m.scopeId === agentId)) : 0;
    bump();
    return { ok: true, removedMemories };
  };
  const cloneCharacter = (sourceId: string, copyId: string) => {
    const source = characterOf(sourceId);
    if (!source) return;
    soul.characters.push({ ...structuredClone(source), ...stamp(), id: copyId });
    const kept = preserved.get(sourceId);
    if (kept) preserved.set(copyId, structuredClone(kept));
    bump();
  };
  const installCharacter = (starter: PaStarterCharacter) => {
    const existing = soul.characters.find((c) => c.origin?.format === 'starter' && c.origin.name === starter.id);
    const existingAgent = existing ? agentOf(existing.id) : undefined;
    if (existing && existingAgent) {
      const lorebooks = soul.lorebooks.filter((s) => existing.lorebookIds.includes(s.id));
      return { agent: existingAgent, character: existing, lorebooks };
    }
    // Starters ship without portrait art (ADDENDUM 11): the UI draws the monogram cover.
    const records = starterRecords(starter, { agentId: id('ag'), lorebookId: id('lb') }, now(), { model: fantayModel() });
    snap.agents.push(records.agent);
    const lorebooks: PaLorebookSummary[] = [];
    if (records.lorebook) {
      docs.push(records.lorebook);
      lorebooks.push(summarize(records.lorebook));
    }
    soul.characters.push(records.character);
    newConversation(records.agent.id);
    return { agent: records.agent, character: records.character, lorebooks };
  };
  const installStarter = (starterId: string) => {
    const starter = PA_STARTERS.find((s) => s.id === starterId) ?? refuse(404, 'PA_NOT_FOUND', '没有这个入门角色');
    if (starter.kind === 'character') {
      const result = installCharacter(starter);
      const conversation = latestDirect(result.agent.id) ?? newConversation(result.agent.id);
      bump();
      return { agents: [result.agent], characters: [result.character], lorebooks: result.lorebooks, group: null, conversation };
    }
    const members = starter.group.members.map((memberId) => ({ starterId: memberId, ...installCharacter(starterOf(memberId)) }));
    const agentFor = (memberId: string) => members.find((m) => m.starterId === memberId)?.agent.id;
    const memberIds = members.map((m) => m.agent.id);
    let group = snap.groups.find(
      (g) => g.name === starter.group.name && g.memberIds.length === memberIds.length && memberIds.every((m) => g.memberIds.includes(m)),
    );
    let conversation: PaConversation;
    if (group) conversation = conversationOf(group.conversationId);
    else {
      const groupId = id('grp');
      conversation = { ...stamp(), id: id('conv'), title: starter.group.name, agentId: null, groupId };
      group = {
        ...stamp(),
        id: groupId,
        name: starter.group.name,
        memberIds,
        moderatorId: agentFor(starter.group.moderator) ?? memberIds[0] ?? '',
        reviewerId: null,
        mode: 'discussion',
        conversationId: conversation.id,
      };
      snap.groups.push(group);
      snap.conversations.push(conversation);
      soul.chats.push({ ...emptyChatView(conversation.id, now()), ...parseBody(paChatSettingsPatchSchema, starter.chat) });
      snap.messages.push({
        ...stamp(),
        id: id('m'),
        conversationId: conversation.id,
        taskId: null,
        senderId: agentFor(starter.opening.from) ?? memberIds[0] ?? 'owner',
        content: starter.opening.text,
        targetAgentIds: [],
        replyTo: null,
        soul: { kind: 'greeting', choices: [...starter.opening.openers] },
      });
    }
    bump();
    return {
      agents: members.map((m) => m.agent),
      characters: members.map((m) => m.character),
      lorebooks: members.flatMap((m) => m.lorebooks),
      group,
      conversation,
    };
  };
  const importCard = (data: SoulBody) => {
    const at = now();
    const fileName = typeof data.fileName === 'string' ? data.fileName : undefined;
    const preview = parseCharacterCard(data.card, { ...(fileName ? { fileName } : {}), now: at });
    if (!preview.ok) return refuse(422, 'PA_SOUL_IMPORT', `角色卡无法导入：${IMPORT_ERRORS[preview.error] ?? preview.error}`);
    let agent: PersonalAgent;
    // With agentId of an agent that already has a card the import overwrites it (addendum 9), as the daemon does:
    // the card's fields, origin and review items are replaced; persona, non-card world books, autoMemory, the portrait
    // (when the import brings none) and the style (when the card names none) stay. `revision` must match when sent.
    let previous: PaCharacterView | null = null;
    if (typeof data.agentId === 'string') {
      agent = agentOf(data.agentId) ?? refuse(404, 'PA_NOT_FOUND', '角色不存在');
      if (agent.avatar === 'fantay') refuse(409, 'PA_SOUL_FANTAY', 'Fantay 不使用角色卡');
      previous = characterOf(agent.id);
      if (previous) checkRevision(previous, data.revision);
    } else {
      const model = data.model && typeof data.model.runtime === 'string' && typeof data.model.modelId === 'string' ? (data.model as PaModel) : fantayModel();
      agent = {
        ...stamp(),
        id: id('ag'),
        name: preview.name.slice(0, 60),
        role: `角色扮演：${preview.name}。${preview.character.tagline}`.slice(0, 4000),
        avatar: '',
        model,
        enabled: true,
        tools: ['respond'],
      };
      snap.agents.push(agent);
    }
    const sent = data.portrait && typeof data.portrait.mime === 'string' && typeof data.portrait.data === 'string' ? data.portrait : null;
    const portrait = sent ?? preview.portrait;
    const sprites = parseBody(paSpritesSchema, data.sprites ?? {}, PA_EMOTIONS);
    let lorebook: PaLorebookSummary | null = null;
    if (preview.lorebook && preview.lorebookMeta) {
      const book: PaLorebook = { ...preview.lorebook, ...stamp(), id: id('lb'), ...preview.lorebookMeta };
      docs.push(book);
      lorebook = summarize(book);
    }
    const embedded = lorebook ? [lorebook.id] : [];
    const fields = {
      ...preview.character,
      portraitAssetId: portrait ? `data:${portrait.mime};base64,${portrait.data}` : previous?.portraitAssetId ?? null,
      lorebookIds: previous
        ? [...new Set([...previous.lorebookIds.filter((bookId) => docs.find((b) => b.id === bookId)?.origin?.format !== 'card'), ...embedded])]
        : [...preview.character.lorebookIds, ...embedded],
      ...(previous ? { personaId: previous.personaId, presetId: preview.character.presetId ?? previous.presetId, autoMemory: previous.autoMemory } : {}),
      // Stage 2: the archive's sprites when it brought any, else the character's own; an overwrite keeps the voice.
      sprites: Object.keys(sprites).length > 0 ? sprites : previous?.sprites ?? {},
      ...(previous ? { voice: previous.voice ?? null } : {}),
      origin: preview.meta.origin,
      needsReview: preview.meta.needsReview,
      preservedKeys: preview.preservedKeys,
    };
    const character: PaCharacterView = previous ? touch(previous, fields) : { ...fields, ...stamp(), id: agent.id };
    if (!previous) {
      soul.characters.push(character);
      if (typeof data.agentId === 'string') keepWorkChats(agent.id);
    }
    preserved.set(agent.id, preview.meta.preserved);
    let conversation: PaConversation;
    if (typeof data.agentId === 'string') {
      const current = latestDirect(agent.id);
      conversation = current ?? newConversation(agent.id);
      if (current && messagesOf(current.id).length === 0) greet(current);
    } else conversation = newConversation(agent.id);
    bump();
    return {
      agent,
      character,
      lorebook,
      conversation,
      report: { needsReview: preview.meta.needsReview, preservedKeys: preview.preservedKeys, lorebookNeedsReview: preview.lorebookMeta?.needsReview ?? [] },
    };
  };
  const exportCard = (agentId: string, includeQuarantined: boolean) => {
    const view = characterOf(agentId) ?? refuse(404, 'PA_NOT_FOUND', '这个角色没有角色设定');
    const agent = agentOf(agentId) ?? refuse(404, 'PA_NOT_FOUND', '角色不存在');
    const { preservedKeys: _keys, ...rest } = view;
    const character: PaCharacter = { ...rest, preserved: preserved.get(agentId) ?? {} };
    const lorebooks = view.lorebookIds.flatMap((lorebookId) => docs.filter((b) => b.id === lorebookId));
    return exportCharacterCard({ name: agent.name, character, lorebooks, now: now(), includeQuarantined });
  };

  // ---- world books, personas, presets
  const saveLorebook = (lorebookId: string | null, data: SoulBody): PaLorebookSummary => {
    const { revision, ...rest } = data;
    let book: PaLorebook;
    if (lorebookId === null) {
      const doc = parseBody(paLorebookInputSchema, rest);
      book = { ...doc, ...stamp(), id: id('lb'), origin: { format: 'native', name: doc.name }, preserved: {}, needsReview: [] };
      docs.push(book);
    } else {
      book = docOf(lorebookId);
      checkRevision(book, revision);
      touch(book, parseBody(paLorebookPatchSchema, rest));
    }
    const summary = summarize(book);
    bump();
    return summary;
  };
  const removeLorebook = (lorebookId: string, data: SoulBody) => {
    const book = docOf(lorebookId);
    checkRevision(book, data.revision);
    drop(docs, (b) => b !== book);
    drop(soul.lorebooks, (s) => s.id !== book.id);
    for (const character of soul.characters) {
      if (character.lorebookIds.includes(book.id)) touch(character, { lorebookIds: character.lorebookIds.filter((x) => x !== book.id) });
    }
    const prefix = `${book.id}:`;
    for (const chat of soul.chats) {
      if (!chat.lorebookIds.includes(book.id) && !chat.disabledLoreEntryIds.some((key) => key.startsWith(prefix))) continue;
      touch(chat, {
        lorebookIds: chat.lorebookIds.filter((x) => x !== book.id),
        disabledLoreEntryIds: chat.disabledLoreEntryIds.filter((key) => !key.startsWith(prefix)),
      });
    }
    bump();
    return { ok: true };
  };
  const importWorld = (data: SoulBody) => {
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : undefined;
    const fileName = typeof data.fileName === 'string' ? data.fileName : undefined;
    const preview = importWorldInfo(data.world, { ...(name ? { name } : {}), ...(fileName ? { fileName } : {}) });
    if (!preview.ok) return refuse(422, 'PA_SOUL_IMPORT', `世界书无法导入：${IMPORT_ERRORS[preview.error] ?? preview.error}`);
    const book: PaLorebook = { ...preview.lorebook, ...stamp(), id: id('lb'), ...preview.meta };
    docs.push(book);
    const summary = summarize(book);
    const character = typeof data.agentId === 'string' ? characterOf(data.agentId) : null;
    if (character) touch(character, { lorebookIds: [...character.lorebookIds, book.id] });
    bump();
    return { lorebook: summary, report: preview.meta.needsReview };
  };
  /** 触发测试: one book at rank 1, no timers; regex keys outside the safe subset report that they need the daemon. */
  const testLorebook = (data: SoulBody) => {
    const book: LoreBookLike = data.lorebook ? { ...parseBody(paLorebookInputSchema, data.lorebook), id: 'draft' } : docOf(String(data.lorebookId ?? ''));
    const messages: string[] = (Array.isArray(data.messages) ? data.messages : []).filter((x: unknown): x is string => typeof x === 'string').slice(0, 20);
    const names = data.names && typeof data.names.char === 'string' && typeof data.names.user === 'string' ? data.names : { char: '', user: '' };
    const result = activateLore({
      books: [{ book, rank: 1 }],
      disabled: new Set(),
      messages,
      extraScan: [],
      index: typeof data.index === 'number' ? data.index : messages.length,
      timers: {},
      names: { char: String(names.char), user: String(names.user) },
      rng: seededRng('test'),
    });
    return { trace: result.trace, used: result.used, limit: result.limit };
  };
  const savePersona = (personaId: string | null, data: SoulBody): PaPersona => {
    const { revision, ...rest } = data;
    let persona: PaPersona;
    if (personaId === null) {
      persona = { ...parseBody(paPersonaInputSchema, rest, ['avatarAssetId']), ...stamp(), id: id('ps') };
      if (soul.personas.length === 0) persona.isDefault = true;
      soul.personas.push(persona);
    } else {
      persona = soul.personas.find((p) => p.id === personaId) ?? refuse(404, 'PA_NOT_FOUND', '人设不存在');
      checkRevision(persona, revision);
      touch(persona, parseBody(paPersonaPatchSchema, rest, ['avatarAssetId']));
    }
    if (persona.isDefault) for (const other of soul.personas) if (other !== persona && other.isDefault) touch(other, { isDefault: false });
    bump();
    return persona;
  };
  const removePersona = (personaId: string, data: SoulBody) => {
    const persona = soul.personas.find((p) => p.id === personaId) ?? refuse(404, 'PA_NOT_FOUND', '人设不存在');
    checkRevision(persona, data.revision);
    drop(soul.personas, (p) => p !== persona);
    for (const character of soul.characters) if (character.personaId === persona.id) touch(character, { personaId: null });
    for (const chat of soul.chats) if (chat.personaId === persona.id) touch(chat, { personaId: null });
    if (persona.isDefault) {
      const oldest = soul.personas.reduce<PaPersona | null>((best, p) => (!best || p.createdAt < best.createdAt ? p : best), null);
      if (oldest) touch(oldest, { isDefault: true });
    }
    bump();
    return { ok: true };
  };
  const savePreset = (presetId: string | null, data: SoulBody): PaStylePreset => {
    if (presetId?.startsWith('builtin:')) refuse(400, 'PA_INVALID_REQUEST', '内置文风不能修改，可以复制一份来改');
    const { revision, ...rest } = data;
    let preset: PaStylePreset;
    if (presetId === null) {
      preset = { ...parseBody(paStylePresetInputSchema, rest), ...stamp(), id: id('pr') };
      soul.presets.push(preset);
    } else {
      preset = soul.presets.find((p) => p.id === presetId) ?? refuse(404, 'PA_NOT_FOUND', '文风不存在');
      checkRevision(preset, revision);
      touch(preset, parseBody(paStylePresetPatchSchema, rest));
    }
    bump();
    return preset;
  };
  const removePreset = (presetId: string, data: SoulBody) => {
    if (presetId.startsWith('builtin:')) refuse(400, 'PA_INVALID_REQUEST', '内置文风不能删除');
    const preset = soul.presets.find((p) => p.id === presetId) ?? refuse(404, 'PA_NOT_FOUND', '文风不存在');
    checkRevision(preset, data.revision);
    drop(soul.presets, (p) => p !== preset);
    for (const character of soul.characters) if (character.presetId === preset.id) touch(character, { presetId: null });
    for (const chat of soul.chats) if (chat.presetId === preset.id) touch(chat, { presetId: null });
    bump();
    return { ok: true };
  };

  // ---- traces, assets, memory candidates
  const traceFor = (messageId: string): PaSoulTrace | null => {
    const own = traces[messageId];
    if (own) return own;
    const conversationId = snap.messages.find((m) => m.id === messageId)?.conversationId;
    const all = Object.values(traces);
    return all.find((t) => t.conversationId === conversationId) ?? all[0] ?? null;
  };
  const preview = (data: SoulBody): PaSoulTrace | null => {
    const conversationId = String(data.conversationId ?? '');
    const all = Object.values(traces);
    const base = all.find((t) => t.conversationId === conversationId) ?? all[0];
    if (!base) return null;
    const { messageId: _messageId, footer: _footer, ...rest } = base;
    return { ...rest, conversationId, at: now() };
  };
  const uploadAsset = (data: SoulBody) => {
    const mime = String(data.mime ?? '');
    if (!ASSET_MIMES.has(mime) || typeof data.data !== 'string' || !data.data) refuse(400, 'PA_SOUL_ASSET', '只支持 PNG、JPEG 或 WebP 图片');
    return { id: `data:${mime};base64,${data.data}` };
  };
  const resolveCandidate = (candidateId: string, accept: boolean) => {
    const item = candidates.find((c) => c.id === candidateId) ?? refuse(404, 'PA_NOT_FOUND', '这条建议已经处理过了');
    drop(candidates, (c) => c !== item);
    if (!accept) return { ...item, status: 'dismissed' };
    const name = characterOf(item.agentId)?.nickname || agentOf(item.agentId)?.name || '角色';
    const memory: PaMemory = {
      ...stamp(),
      id: id('mem'),
      content: item.content,
      source: `对话 · ${name}`,
      scope: 'agent',
      scopeId: item.agentId ?? null,
      kind: item.kind ?? 'fact',
      dataClass: item.dataClass,
      sourceMessageId: item.sourceMessageId ?? item.attemptId,
      ...(item.dueAt != null ? { dueAt: item.dueAt } : {}),
    };
    snap.memories.push(memory);
    return { ...item, status: 'accepted', memoryId: memory.id };
  };

  // ---- voice replies (stage 2): the daemon's speech gate in short form; the audio is the lab tone
  const speechStatus = (): PaSpeechStatus => state.speech?.status ?? { available: false, models: [] };
  const voiceKeyOf = (agentId: string) => JSON.stringify(characterOf(agentId)?.voice ?? null);
  const voiceRepliesOf = (conversationId: string) => chatOf(conversationId)?.voiceReplies ?? 'manual';
  for (const item of state.speech?.items ?? []) {
    const message = snap.messages.find((m) => m.id === item.messageId);
    if (message) speech.set(message.id, { item, content: message.content, voice: voiceKeyOf(message.senderId) });
  }
  /** A stored item still matches its message's text and its speaker's voice (else it is regenerated). */
  const speechFor = (message: PaMessage): PaSpeechItem | null => {
    const kept = speech.get(message.id);
    return kept && kept.content === message.content && kept.voice === voiceKeyOf(message.senderId) ? kept.item : null;
  };
  const listSpeech = (url: URL) => {
    const conversationId = url.searchParams.get('conversationId') ?? '';
    if (!conversationId || conversationId.length > 100) return refuse(400, 'PA_INVALID_REQUEST', '请求内容无效：conversationId');
    if (voiceRepliesOf(conversationId) === 'off') return { items: [] };
    const items = messagesOf(conversationId).flatMap((message) => {
      const item = characterOf(message.senderId)?.voice ? speechFor(message) : null;
      return item ? [{ ...item, cached: true }] : [];
    });
    return { items };
  };
  const speechVoices = (url: URL) => {
    const model = url.searchParams.get('model') ?? '';
    if (!model || model.length > 120) return refuse(400, 'PA_INVALID_REQUEST', '请求内容无效：model');
    const voices = state.speech?.voices;
    return { model, voices: voices && Object.hasOwn(voices, model) ? voices[model] ?? [] : [] };
  };
  const speakMessage = async (data: SoulBody): Promise<PaSpeechItem> => {
    const messageId = typeof data.messageId === 'string' ? data.messageId : '';
    if (!messageId || messageId.length > 100) return refuse(400, 'PA_INVALID_REQUEST', '请求内容无效：messageId');
    const message = messageOf(messageId);
    const kind = message.soul?.kind;
    if (message.senderId === 'owner' || (kind !== 'chat' && kind !== 'greeting')) refuse(400, 'PA_SOUL_SPEECH', '这条消息不能朗读');
    if (voiceRepliesOf(message.conversationId) === 'off') refuse(409, 'PA_SOUL_SPEECH_OFF', '这个对话关闭了语音回复');
    const voice = characterOf(message.senderId)?.voice ?? null;
    if (!voice) return refuse(409, 'PA_SOUL_VOICE_UNSET', '这个角色还没有设置声音');
    const status = speechStatus();
    if (!status.available || !status.models.some((model) => model.id === voice.model && model.configured)) {
      refuse(409, 'PA_SOUL_SPEECH_UNAVAILABLE', '没有可用的语音服务，请先在设置里添加语音提供商');
    }
    const spoken = speechText(message.content);
    if (!spoken) refuse(400, 'PA_SOUL_SPEECH', '这条消息不能朗读');
    if (Array.from(spoken).length > SOUL_LIMITS.speechChars) refuse(413, 'PA_SOUL_SPEECH_LONG', '这条太长，不能朗读');
    const cached = speechFor(message);
    if (cached) return { ...cached, cached: true };
    await new Promise((resolve) => setTimeout(resolve, LAB_SPEECH_MS));
    const item = labSpeechItem(message.id, spoken);
    speech.set(message.id, { item, content: message.content, voice: voiceKeyOf(message.senderId) });
    return item;
  };

  /** 试听: the daemon's checks in short form; one lab tone per voice, answered from the cache the second time. */
  const previews = new Map<string, PaSpeechItem>();
  const previewSpeech = async (data: SoulBody): Promise<Omit<PaSpeechItem, 'messageId'>> => {
    const model = typeof data.model === 'string' ? data.model : '';
    if (!model || model.length > 120) return refuse(400, 'PA_INVALID_REQUEST', '请求内容无效：model');
    const status = speechStatus();
    if (!status.available || !status.models.some((item) => item.id === model && item.configured)) {
      refuse(409, 'PA_SOUL_SPEECH_UNAVAILABLE', '没有可用的语音服务，请先在设置里添加语音提供商');
    }
    const language = typeof data.language === 'string' ? data.language : '';
    const spoken = speechText(typeof data.text === 'string' ? data.text : '') || speechSampleText(language);
    const key = JSON.stringify([model, data.voice ?? '', language, spoken]);
    const strip = ({ messageId: _messageId, ...rest }: PaSpeechItem) => rest;
    const cached = previews.get(key);
    if (cached) return { ...strip(cached), cached: true };
    await new Promise((resolve) => setTimeout(resolve, LAB_SPEECH_MS));
    const item = labSpeechItem('', spoken);
    previews.set(key, item);
    return strip(item);
  };

  // ---- routing
  const conversation = (data: SoulBody) => conversationOf(String(data.conversationId ?? ''));
  type Route = readonly [verb: string, pattern: RegExp, run: (params: string[], data: SoulBody) => unknown];
  const routes: readonly Route[] = [
    ['POST', /^\/soul\/characters\/import$/, (_p, data) => importCard(data)],
    ['PUT', /^\/soul\/characters\/([^/]+)$/, ([agentId], data) => saveCharacter(agentId!, data)],
    ['DELETE', /^\/soul\/characters\/([^/]+)$/, ([agentId], data) => removeCharacter(agentId!, data)],
    ['POST', /^\/soul\/starters\/([^/]+)\/install$/, ([starterId]) => installStarter(starterId!)],
    ['POST', /^\/soul\/lorebooks\/import$/, (_p, data) => importWorld(data)],
    ['POST', /^\/soul\/lorebooks\/test$/, (_p, data) => testLorebook(data)],
    ['POST', /^\/soul\/lorebooks$/, (_p, data) => saveLorebook(null, data)],
    ['PATCH', /^\/soul\/lorebooks\/([^/]+)$/, ([lorebookId], data) => saveLorebook(lorebookId!, data)],
    ['DELETE', /^\/soul\/lorebooks\/([^/]+)$/, ([lorebookId], data) => removeLorebook(lorebookId!, data)],
    ['POST', /^\/soul\/personas$/, (_p, data) => savePersona(null, data)],
    ['PATCH', /^\/soul\/personas\/([^/]+)$/, ([personaId], data) => savePersona(personaId!, data)],
    ['DELETE', /^\/soul\/personas\/([^/]+)$/, ([personaId], data) => removePersona(personaId!, data)],
    ['POST', /^\/soul\/presets$/, (_p, data) => savePreset(null, data)],
    ['PATCH', /^\/soul\/presets\/([^/]+)$/, ([presetId], data) => savePreset(presetId!, data)],
    ['DELETE', /^\/soul\/presets\/([^/]+)$/, ([presetId], data) => removePreset(presetId!, data)],
    ['PUT', /^\/soul\/chats\/([^/]+)$/, ([conversationId], data) => saveChat(conversationId!, data)],
    ['POST', /^\/soul\/chat\/state$/, (_p, data) => applyStateOps(data)],
    ['POST', /^\/soul\/assets$/, (_p, data) => uploadAsset(data)],
    ['PATCH', /^\/soul\/messages\/([^/]+)$/, ([messageId], data) => editMessage(messageId!, data)],
    ['DELETE', /^\/soul\/messages\/([^/]+)$/, ([messageId], data) => deleteMessage(messageId!, data)],
    ['POST', /^\/soul\/messages\/([^/]+)\/variant$/, ([messageId], data) => selectVariant(messageId!, data)],
    ['POST', /^\/soul\/messages\/([^/]+)\/reveal$/, ([messageId]) => reveal(messageId!)],
    ['POST', /^\/soul\/chat\/regenerate$/, (_p, data) => regenerate(data)],
    [
      'POST',
      /^\/soul\/chat\/continue$/,
      (_p, data) =>
        continueTurn(
          conversation(data),
          String(data.requestId ?? id('req')),
          typeof data.agentId === 'string' ? data.agentId : undefined,
          data.directive === 'reachout' ? 'reachout' : 'continue',
        ),
    ],
    ['POST', /^\/soul\/chat\/roll$/, (_p, data) => roll(data)],
    ['POST', /^\/soul\/chat\/draw$/, (_p, data) => draw(data)],
    ['POST', /^\/soul\/chat\/event$/, (_p, data) => eventAction(data)],
    ['POST', /^\/soul\/chat\/preview$/, (_p, data) => preview(data)],
    ['POST', /^\/soul\/conversations\/([^/]+)\/branch$/, ([conversationId], data) => branch(conversationId!, data)],
  ];
  const mutate = (verb: string, path: string, data: SoulBody): unknown => {
    for (const [method, pattern, run] of routes) {
      if (method !== verb) continue;
      const match = pattern.exec(path);
      if (match) return run(match.slice(1).map((part) => decodeURIComponent(part)), data);
    }
    return { ok: true };
  };
  const get = (path: string, url: URL): unknown => {
    if (path === '/soul') return soul;
    if (path === '/soul/live') return readLive(url);
    if (path === '/soul/speech/status') return speechStatus();
    if (path === '/soul/speech/voices') return speechVoices(url);
    if (path === '/soul/speech') return listSpeech(url);
    const book = /^\/soul\/lorebooks\/([^/]+)(\/export)?$/.exec(path);
    if (book) {
      const doc = docOf(decodeURIComponent(book[1]!));
      return book[2] ? exportWorldInfo(doc) : doc;
    }
    const card = /^\/soul\/characters\/([^/]+)\/export$/.exec(path);
    if (card) return exportCard(decodeURIComponent(card[1]!), url.searchParams.get('quarantine') === '1');
    const trace = /^\/soul\/trace\/([^/]+)$/.exec(path);
    if (trace) return traceFor(decodeURIComponent(trace[1]!));
    return refuse(404, 'PA_NOT_FOUND', '没有这个接口');
  };

  return { get, mutate, sendChat, speakMessage, previewSpeech, taskAction, start, newConversation, cloneCharacter, resolveCandidate };
}
