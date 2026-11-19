// SPDX-License-Identifier: AGPL-3.0-only
// Lab and test fixtures for the Fantay workspace (spec §20.3). Every scenario is a function so its times are relative
// to the moment it is built; shapes match @open-design/contracts exactly.
import type {
  PaArtifact,
  PaAttempt,
  PaChannel,
  PaChannelInbox,
  PaChannelOutbox,
  PaChannelSnapshot,
  PaControl,
  PaConversation,
  PaGroup,
  PaLorebook,
  PaMemory,
  PaMessage,
  PaModelOption,
  PaRoutine,
  PaSnapshot,
  PaSoulSnapshot,
  PaSoulTrace,
  PaSpeechItem,
  PaSpeechStatus,
  PaTask,
  PersonalAgent,
  Project,
} from '@open-design/contracts';
import type { PaUiState } from '../pa-types';
import { companionChat, companionGroup, firstRunSoul, journalChat, liveChat, soulLibrary, spritesChat, storyGame, voiceChat } from './soul-fixtures';

export const PA_SCENARIO_IDS = [
  'first-run',
  'fantay-chat',
  'needs-you',
  'project-done',
  'group-three',
  'inspector',
  'connections',
  'offline',
  'long-cjk',
  'first-run-soul',
  'companion-chat',
  'story-game',
  'companion-group',
  'library',
  'live-chat',
  'voice-chat',
  'sprites-chat',
  'journal-chat',
] as const;
export type PaScenarioId = (typeof PA_SCENARIO_IDS)[number];

/** A reply that lands a while after the bench opens (after the viewer's seen baseline), so the roster shows a
 *  live preview change and an unread dot. `completes` finishes that task and its running attempts. */
export interface PaFixtureArrival {
  afterMs: number;
  message: PaMessage;
  completes?: string;
}

export interface PaFixture {
  snapshot: PaSnapshot;
  channels: PaChannelSnapshot;
  control: PaControl;
  models: PaModelOption[];
  projects: Project[];
  ui: Partial<PaUiState>;
  /** Every GET rejects (scenario `offline`). */
  offline?: boolean;
  arrivals?: PaFixtureArrival[];
  /** The soul snapshot (GET /soul); `snapshot.soulVersion` equals `soul.version`. */
  soul?: PaSoulSnapshot;
  /** Full world books behind `soul.lorebooks` (GET /soul/lorebooks/:id). */
  lorebookDocs?: PaLorebook[];
  /** Context records by agent message id (GET /soul/trace/:id). */
  traces?: Record<string, PaSoulTrace>;
  /** Canned raw replies per agent id, used in rotation; they carry `<turn_meta>` footers for the reply parser. */
  replies?: Record<string, string[]>;
  /** Stage 2 voice replies: the speech status (GET /soul/speech/status), voice lists by model and stored items. Absent:
   *  no speech service is set up. */
  speech?: { status: PaSpeechStatus; voices?: Record<string, Array<{ id: string; name: string }>>; items?: PaSpeechItem[] };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---- builders ----------------------------------------------------------------------------------------------------

function stamp(at: number) {
  return { createdAt: at, updatedAt: at, revision: 1 };
}

function agent(
  id: string,
  name: string,
  avatar: string,
  role: string,
  modelId: string,
  at: number,
  extra: Partial<PersonalAgent> = {},
): PersonalAgent {
  return {
    ...stamp(at),
    id,
    name,
    avatar,
    role,
    enabled: true,
    tools: ['respond', 'create_project'],
    model: { runtime: 'claude', modelId },
    ...extra,
  };
}

function conversation(id: string, title: string, at: number, extra: Partial<PaConversation>): PaConversation {
  return { ...stamp(at), id, title, agentId: null, groupId: null, ...extra };
}

function message(
  id: string,
  conversationId: string,
  taskId: string | null,
  senderId: string,
  content: string,
  at: number,
  extra: Partial<PaMessage> = {},
): PaMessage {
  return { ...stamp(at), id, conversationId, taskId, senderId, content, targetAgentIds: [], replyTo: null, ...extra };
}

function task(id: string, conversationId: string, goal: string, at: number, extra: Partial<PaTask> = {}): PaTask {
  return {
    ...stamp(at),
    id,
    requestId: `req-${id}-0000`,
    conversationId,
    goal,
    kind: 'discussion',
    projectName: '',
    projectId: null,
    projectConversationId: null,
    status: 'completed',
    waitingReason: null,
    error: null,
    participantIds: [],
    nextParticipant: 0,
    budget: { maxAttempts: 6, timeoutMs: 300000 },
    authorization: { localProject: false, externalWrites: false, version: 1, revoked: false },
    amendments: [],
    evidence: [],
    ...extra,
  };
}

function attempt(
  id: string,
  taskId: string,
  who: PersonalAgent,
  phase: PaAttempt['phase'],
  startedAt: number,
  extra: Partial<PaAttempt> = {},
): PaAttempt {
  // Every attempt that is not running has ended (failed and interrupted ones too), so budget time is real.
  const done = extra.status !== 'running';
  return {
    ...stamp(startedAt),
    id,
    taskId,
    runId: `run-${id}`,
    nodeId: 'local',
    protocolVersion: 1,
    agentSnapshot: who,
    phase,
    status: 'completed',
    taskRevision: 1,
    startedAt,
    endedAt: done ? startedAt + 24_000 : null,
    output: '',
    error: null,
    resolvedModel: who.model.modelId === 'haiku' ? 'claude-haiku-4-5' : 'claude-sonnet-4-5',
    usage: { inputTokens: 1800, outputTokens: 640, costUsd: '0.0091', visibility: 'reported' },
    ...extra,
  };
}

function memory(id: string, scope: PaMemory['scope'], scopeId: string | null, content: string, source: string, at: number, revision = 1): PaMemory {
  return { id, scope, scopeId, content, source, createdAt: at, updatedAt: at, revision };
}

function routine(
  id: string,
  conversationId: string,
  name: string,
  prompt: string,
  time: string,
  now: number,
  extra: Partial<PaRoutine> = {},
): PaRoutine {
  const enabled = extra.enabled ?? true;
  return {
    ...stamp(now - 7 * DAY),
    id,
    name,
    prompt,
    conversationId,
    time,
    timezone: 'Asia/Shanghai',
    enabled,
    nextRunAt: enabled ? now + 9 * HOUR : null,
    lastError: null,
    lastTaskId: null,
    ...extra,
  };
}

function control(now: number, extra: Partial<PaControl> = {}): PaControl {
  return {
    id: 'control',
    revision: 1,
    createdAt: now - 30 * DAY,
    updatedAt: now - DAY,
    backgroundEnabled: true,
    paused: false,
    suspended: false,
    maxConcurrent: 2,
    defaultMaxAttempts: 6,
    defaultTimeoutMs: 300000,
    waitingExpiryMs: 86400000,
    activeCount: 0,
    pendingCount: 0,
    lastResumeAt: null,
    ...extra,
  };
}

const DEFAULT_MODELS: PaModelOption[] = [
  { runtime: 'tokentosea', modelId: 'deepseek-chat', label: 'TokenToSea · DeepSeek', available: true },
  { runtime: 'claude', modelId: 'sonnet', label: 'Claude Sonnet', available: true },
  { runtime: 'claude', modelId: 'haiku', label: 'Claude Haiku', available: true },
  { runtime: 'claude', modelId: 'opus', label: 'Claude Opus', available: true },
  { runtime: 'codex', modelId: 'gpt-5', label: 'Codex · GPT-5', available: true },
  { runtime: 'opencode', modelId: 'openai/gpt-5', label: 'OpenCode · GPT-5', available: true },
];

function project(id: string, name: string, at: number): Project {
  return { id, name, skillId: null, designSystemId: null, createdAt: at, updatedAt: at };
}

function snapshotOf(now: number, parts: Partial<PaSnapshot>): PaSnapshot {
  return {
    agents: [],
    groups: [],
    conversations: [],
    messages: [],
    tasks: [],
    attempts: [],
    artifacts: [],
    memories: [],
    // The capability list PaLocalNode.capabilities() reports.
    node: { id: 'local', protocolVersion: 1, location: 'local', available: true, capabilities: ['text', 'project-files', 'cancel', 'review'], heartbeatAt: now - 3000 },
    ...parts,
  };
}

function fixtureOf(now: number, parts: Partial<PaSnapshot>, extra: Partial<PaFixture> = {}): PaFixture {
  return {
    snapshot: snapshotOf(now, parts),
    channels: { channels: [], inbox: [], outbox: [] },
    control: control(now),
    models: DEFAULT_MODELS,
    projects: [],
    ui: {},
    ...extra,
  };
}

function channel(id: string, type: PaChannel['type'], name: string, targetId: string, now: number, extra: Partial<PaChannel> = {}): PaChannel {
  return {
    ...stamp(now - 5 * DAY),
    id,
    type,
    name,
    targetKind: 'agent',
    targetId,
    enabled: true,
    allowProject: true,
    shareGroupMemory: false,
    chatMode: 'work',
    allowedSenderIds: ['ou_8f3a21'],
    remoteChatId: type === 'feishu' ? 'oc_5c9e1d' : null,
    tenantId: type === 'feishu' ? 'tenant_demo' : null,
    authorizationVersion: 1,
    status: 'connected',
    credentialConfigured: true,
    accountLabel: type === 'feishu' ? 'Fantay 机器人' : '微信个人号',
    lastReceivedAt: now - 12 * MIN,
    lastSentAt: now - 11 * MIN,
    lastError: null,
    capabilities: { direct: true, groups: type === 'feishu', threads: type === 'feishu', files: false, unsolicited: false },
    verification: { inboundAt: now - 12 * MIN, outboundAt: now - 11 * MIN, reconnectAt: now - 2 * HOUR, reloginAt: null },
    ...extra,
  };
}

function inbox(id: string, channelId: string, preview: string, at: number, extra: Partial<PaChannelInbox> = {}): PaChannelInbox {
  return {
    ...stamp(at),
    id,
    channelId,
    preview,
    providerMessageId: `om_${id}`,
    senderId: 'ou_8f3a21',
    chatId: 'oc_5c9e1d',
    threadId: null,
    receivedAt: at,
    taskId: null,
    state: 'accepted',
    error: null,
    ...extra,
  };
}

const owner = (id: string, conversationId: string, taskId: string | null, content: string, at: number, extra: Partial<PaMessage> = {}) =>
  message(id, conversationId, taskId, 'owner', content, at, extra);

// ---- shared cast -------------------------------------------------------------------------------------------------

/** `at` is when the cast was set up: a month ago, or minutes ago for a fresh install. */
function cast(now: number, at = now - 30 * DAY) {
  const fantay = agent('ag-fantay', 'Fantay', 'fantay', '理解目标，完成研究整理与可用的设计、文档产物。', 'sonnet', at);
  const reviewer = agent('ag-reviewer', '审阅者', '审', '独立核对成果与用户要求，指出具体问题，不以执行者的自述作为证据。', 'haiku', at + 1);
  const researcher = agent('ag-researcher', '研究员', '', '检索资料、对照来源，输出带出处的要点与结论。', 'sonnet', at + 2);
  const studio: PaGroup = {
    ...stamp(at + 3),
    id: 'grp-studio',
    name: '协作工作室',
    memberIds: [fantay.id, reviewer.id],
    moderatorId: fantay.id,
    reviewerId: reviewer.id,
    mode: 'review',
    conversationId: 'conv-studio',
  };
  const direct = conversation('conv-fantay', 'Fantay', at + 4, { agentId: fantay.id });
  const studioChat = conversation('conv-studio', '协作工作室', at + 5, { groupId: studio.id });
  return { fantay, reviewer, researcher, studio, direct, studioChat };
}

// ---- scenarios ---------------------------------------------------------------------------------------------------

function firstRun(now: number): PaFixture {
  const { fantay, reviewer, studio, direct, studioChat } = cast(now, now - 6 * MIN);
  return fixtureOf(
    now,
    { agents: [fantay, reviewer], groups: [studio], conversations: [direct, studioChat] },
    { ui: { place: 'conversation', conversationId: direct.id, inspectorOpen: false } },
  );
}

const RICH_REPLY = `### 下周复习安排

我把两门课拆成了每天两个时段，先过一遍**易错点**，再做题：

- 周一至周三：数据结构（树、图、排序）
- 周四至周六：操作系统（进程调度、内存管理）
- 周日：错题回顾与整体模拟

调度算法的模拟可以用下面这段伪代码自测：

\`\`\`
while (ready_queue not empty) {
  p = pick_by_policy(ready_queue)
  run(p, time_slice)
}
\`\`\`

参考资料见 [王道考纲解析](https://example.com/408/syllabus)，进度图示例：

![复习进度示意](https://cdn.example.com/plan/progress.png)`;

/** Fantay's direct chat, oldest first. The separator rules (spec §6.2) all occur: the first turn opens with one
 *  (yesterday), the second follows 11 min later with none, the third opens today (day change) and the running fourth
 *  comes ≥ 15 min after it. The rich Markdown reply is the newest finished turn, so it is on screen when the bench
 *  opens scrolled to the latest message, right above the working line. */
function chatData(now: number) {
  const { fantay, reviewer, researcher, studio, direct, studioChat } = cast(now);
  const t1At = now - DAY - 3 * HOUR;
  const t2At = t1At + 11 * MIN;
  const t3At = now - 2 * HOUR;
  const t4At = now - 90_000;
  const tasks = [
    task('tk-net', direct.id, '帮我整理一下计网的重点', t1At, { participantIds: [fantay.id], nextParticipant: 1 }),
    task('tk-tcp', direct.id, '传输层那部分能再展开一点吗？', t2At, { participantIds: [fantay.id], nextParticipant: 1 }),
    task('tk-plan', direct.id, '帮我把下周的复习计划理一下，数据结构和操作系统各占一半', t3At, { participantIds: [fantay.id], nextParticipant: 1 }),
    task('tk-print', direct.id, '把这些整理成一份可以打印的清单', t4At, {
      status: 'running',
      participantIds: [fantay.id],
      nextParticipant: 0,
    }),
  ];
  const attempts = [
    attempt('at-net', 'tk-net', fantay, 'respond', t1At + 3000),
    attempt('at-tcp', 'tk-tcp', fantay, 'respond', t2At + 3000, {
      memoryRefs: [{ id: 'mem-pref', revision: 3 }],
      usage: { inputTokens: 2600, outputTokens: 910, costUsd: '0.0134', visibility: 'reported' },
    }),
    attempt('at-plan', 'tk-plan', fantay, 'respond', t3At + 3000),
    attempt('at-print', 'tk-print', fantay, 'respond', now - 42_000, { status: 'running', usage: { visibility: 'unknown' } }),
  ];
  const messages = [
    owner('m1', direct.id, 'tk-net', '帮我整理一下计网的重点', t1At),
    message(
      'm2',
      direct.id,
      'tk-net',
      fantay.id,
      '计网先抓三块：\n\n1. 传输层：TCP 三次握手、拥塞控制\n2. 网络层：IP 分片、路由算法\n3. 应用层：DNS 解析流程、HTTP 状态码',
      t1At + 21_000,
      { attemptId: 'at-net', model: fantay.model },
    ),
    owner('m3', direct.id, 'tk-tcp', '传输层那部分能再展开一点吗？', t2At),
    message(
      'm4',
      direct.id,
      'tk-tcp',
      fantay.id,
      '可以。传输层建议按「先画后算」来练：先画出三次握手与四次挥手的时序图，再手算慢启动和拥塞避免阶段的窗口变化。\n\n你之前提过习惯先做真题再看笔记，所以每一块都先配了两道真题。',
      t2At + 28_000,
      { attemptId: 'at-tcp', model: fantay.model, memoryRefs: [{ id: 'mem-pref', revision: 3 }] },
    ),
    owner('m5', direct.id, 'tk-plan', '帮我把下周的复习计划理一下，数据结构和操作系统各占一半', t3At),
    message('m6', direct.id, 'tk-plan', fantay.id, RICH_REPLY, t3At + 26_000, { attemptId: 'at-plan', model: fantay.model }),
    owner('m7', direct.id, 'tk-print', '把这些整理成一份可以打印的清单', t4At),
  ];
  const memories = [memory('mem-pref', 'private', null, '复习偏好：每天先做真题，再看笔记；晚上不安排新内容。', '对话：复习计划', now - 6 * DAY, 3)];
  return { fantay, reviewer, researcher, studio, direct, studioChat, tasks, attempts, messages, memories };
}

/** The rest of the roster around the Fantay chat: a group exchange the reviewer closed three days ago, and the
 *  researcher working on a question whose answer arrives 4 s after the bench opens (shimmer, then unread). */
function rosterAround(now: number, d: ReturnType<typeof chatData>) {
  const researcherChat = conversation('conv-researcher', '研究员', now - 6 * DAY, { agentId: d.researcher.id });
  const g = now - 3 * DAY - 5 * HOUR;
  const r = now - 3 * MIN;
  const tasks = [
    task('tk-studio', d.studioChat.id, '把本周复习进度做成一页总结', g, { participantIds: [d.fantay.id, d.reviewer.id], nextParticipant: 2 }),
    task('tk-cache', researcherChat.id, '查一下 LRU 和 LFU 在考研真题里各出现过几次', r, {
      status: 'running',
      participantIds: [d.researcher.id],
      nextParticipant: 0,
    }),
  ];
  const attempts = [
    attempt('at-studio-a', 'tk-studio', d.fantay, 'respond', g + 2000),
    attempt('at-studio-b', 'tk-studio', d.reviewer, 'review', g + 40_000, { usage: { visibility: 'unknown' } }),
    attempt('at-cache', 'tk-cache', d.researcher, 'respond', r + 2000, { status: 'running', usage: { visibility: 'unknown' } }),
  ];
  const messages = [
    owner('s1', d.studioChat.id, 'tk-studio', '把本周复习进度做成一页总结', g),
    message('s2', d.studioChat.id, 'tk-studio', d.fantay.id, '本周完成数据结构 4 章、操作系统 2 章；错题集中在图的遍历与页面置换。', g + 26_000, {
      attemptId: 'at-studio-a',
      model: d.fantay.model,
    }),
    message('s3', d.studioChat.id, 'tk-studio', d.reviewer.id, '{"approved":true,"summary":"进度与错题统计一致，可以直接使用。","issues":[]}', g + 64_000, {
      attemptId: 'at-studio-b',
      model: d.reviewer.model,
    }),
    owner('r1', researcherChat.id, 'tk-cache', '查一下 LRU 和 LFU 在考研真题里各出现过几次', r),
  ];
  const arrival: PaFixtureArrival = {
    afterMs: 4000,
    completes: 'tk-cache',
    message: message('r2', researcherChat.id, 'tk-cache', d.researcher.id, '近十年真题里 LRU 出现 6 次（多为页面置换计算题），LFU 只出现 1 次，出处已附在下方。', now, {
      attemptId: 'at-cache',
      model: d.researcher.model,
    }),
  };
  return { researcherChat, tasks, attempts, messages, arrival };
}

function fantayChat(now: number): PaFixture {
  const d = chatData(now);
  const around = rosterAround(now, d);
  const routines = [
    routine('rt-morning', d.direct.id, '每日复习计划检查', '对照本周进度，整理今天上午和下午的复习重点。', '09:00', now, {
      lastTaskId: 'tk-plan',
    }),
  ];
  return fixtureOf(
    now,
    {
      agents: [d.fantay, d.reviewer, d.researcher],
      groups: [d.studio],
      conversations: [d.direct, d.studioChat, around.researcherChat],
      messages: [...d.messages, ...around.messages],
      tasks: [...d.tasks, ...around.tasks],
      attempts: [...d.attempts, ...around.attempts],
      memories: d.memories,
      routines,
    },
    {
      control: control(now, { activeCount: 2 }),
      ui: { place: 'conversation', conversationId: d.direct.id, inspectorOpen: true },
      arrivals: [around.arrival],
    },
  );
}

function needsYou(now: number): PaFixture {
  const { fantay, reviewer, researcher, studio, direct, studioChat } = cast(now);
  const feishuConv = conversation('conv-feishu', '产品群', now - 3 * HOUR, {
    channelId: 'ch-feishu',
    agentId: fantay.id,
    externalThreadId: 'oc_5c9e1d',
  });
  const researcherChat = conversation('conv-researcher', '研究员', now - 4 * DAY, { agentId: researcher.id });
  const tasks = [
    task('tk-login', direct.id, '把本周读到的三篇论文整理成摘要', now - 40 * MIN, {
      status: 'waiting',
      waitKind: 'login',
      waitingSince: now - 38 * MIN,
      waitingReason: '模型未登录：Claude Code 需要重新登录后才能继续',
      participantIds: [fantay.id],
    }),
    task('tk-review', studioChat.id, '做一个读书会的活动主页', now - 2 * HOUR, {
      status: 'waiting',
      kind: 'project',
      projectName: '读书会主页',
      waitKind: 'verification',
      waitingSince: now - 100 * MIN,
      waitingReason: '审阅发现待改进项：缺少活动时间与报名方式',
      reviewRequired: true,
      participantIds: [fantay.id, reviewer.id],
      nextParticipant: 1,
      evidence: ['审阅：缺少活动时间与报名方式'],
    }),
    task('tk-budget', researcherChat.id, '对比三种缓存淘汰策略并给出出处', now - 5 * HOUR, {
      status: 'waiting',
      waitKind: 'budget',
      waitingSince: now - 4 * HOUR,
      waitingReason: '已达到尝试次数上限，需要你决定是否继续',
      participantIds: [researcher.id],
      budget: { maxAttempts: 3, timeoutMs: 300000 },
    }),
    task('tk-failed', direct.id, '整理上周的会议纪要', now - DAY, {
      status: 'failed',
      error: '后台重启，旧执行结果待核对',
      stopConfirmation: 'unknown',
      participantIds: [fantay.id],
    }),
    // Stopped while its run was cut off: the stop is unconfirmed (the working line's stopUnconfirmed form), and
    // the bench's reconcile finds the old executor still running.
    task('tk-stopping', researcherChat.id, '整理缓存策略的参考文献', now - 15 * MIN, {
      status: 'cancelling',
      stopConfirmation: 'unknown',
      waitingReason: '旧执行者或模型服务端结果待核对',
      participantIds: [researcher.id],
      updatedAt: now - 9 * MIN,
    }),
    // The Feishu channel's permissions changed 30 min ago (authorization 1 → 2): the daemon cancelled the channel
    // task then in flight (SVC `cancel` revokes its authorization) and a pending reply (`cancelPendingOutbox`).
    task('tk-feishu-old', feishuConv.id, '把这周的评审结论同步到群里', now - 33 * MIN, {
      status: 'cancelled',
      stopConfirmation: 'confirmed',
      channelId: 'ch-feishu',
      channelAuthorizationVersion: 1,
      authorization: { localProject: false, externalWrites: false, version: 2, revoked: true },
      participantIds: [fantay.id],
      updatedAt: now - 30 * MIN,
    }),
    // A channel task accepted under the new authorization: its reply went out in two parts, one confirmed sent and
    // one whose delivery is unknown (both outbox rows carry its taskId).
    task('tk-feishu-week', feishuConv.id, '下周的发布排期发我一份', now - 20 * MIN, {
      channelId: 'ch-feishu',
      channelAuthorizationVersion: 2,
      participantIds: [fantay.id],
      nextParticipant: 1,
      updatedAt: now - 18 * MIN,
    }),
  ];
  const attempts = [
    attempt('at-login', 'tk-login', fantay, 'respond', now - 40 * MIN, { status: 'failed', error: 'Claude Code 登录已失效', usage: { visibility: 'unknown' } }),
    attempt('at-rev-1', 'tk-review', fantay, 'produce', now - 2 * HOUR),
    attempt('at-rev-2', 'tk-review', reviewer, 'review', now - 110 * MIN, { usage: { inputTokens: 900, outputTokens: 210, costUsd: '0.0021', visibility: 'reported' } }),
    attempt('at-bud', 'tk-budget', researcher, 'respond', now - 5 * HOUR, { status: 'failed', error: '输出不是可验证的结构化结果' }),
    attempt('at-failed', 'tk-failed', fantay, 'respond', now - DAY, { status: 'interrupted', endedAt: now - DAY + 40_000, error: '后台重启，旧执行结果待核对' }),
    attempt('at-stopping', 'tk-stopping', researcher, 'respond', now - 15 * MIN + 2000, {
      status: 'interrupted',
      endedAt: now - 10 * MIN,
      error: '后台重启，旧执行结果待核对',
      usage: { visibility: 'unknown' },
    }),
    attempt('at-feishu-old', 'tk-feishu-old', fantay, 'respond', now - 33 * MIN + 2000, {
      status: 'cancelled',
      endedAt: now - 30 * MIN + 1500,
      usage: { visibility: 'unknown' },
    }),
    attempt('at-feishu-week', 'tk-feishu-week', fantay, 'respond', now - 20 * MIN + 2000),
  ];
  const messages = [
    owner('n1', direct.id, 'tk-login', '把本周读到的三篇论文整理成摘要', now - 40 * MIN),
    owner('n2', studioChat.id, 'tk-review', '做一个读书会的活动主页', now - 2 * HOUR),
    message('n3', studioChat.id, 'tk-review', fantay.id, '{"summary":"已生成活动主页，包含简介、书单与往期回顾。","files":[{"path":"index.html"}]}', now - 118 * MIN, { attemptId: 'at-rev-1', model: fantay.model }),
    message(
      'n4',
      studioChat.id,
      'tk-review',
      reviewer.id,
      '{"approved":false,"summary":"页面完整但信息不全。","issues":["缺少活动时间与报名方式","书单没有标注作者"]}',
      now - 108 * MIN,
      { attemptId: 'at-rev-2', model: reviewer.model },
    ),
    owner('n5', researcherChat.id, 'tk-budget', '对比三种缓存淘汰策略并给出出处', now - 5 * HOUR),
    owner('n5b', researcherChat.id, 'tk-stopping', '整理缓存策略的参考文献', now - 15 * MIN),
    owner('n6', direct.id, 'tk-failed', '整理上周的会议纪要', now - DAY),
    owner('n7', feishuConv.id, null, '周五的评审会议帮我安排一下', now - 3 * HOUR),
    owner('n8', feishuConv.id, 'tk-feishu-old', '把这周的评审结论同步到群里', now - 33 * MIN),
    owner('n9', feishuConv.id, 'tk-feishu-week', '下周的发布排期发我一份', now - 20 * MIN),
    message(
      'n10',
      feishuConv.id,
      'tk-feishu-week',
      fantay.id,
      '下周发布排期：周四 15:00 发布 2.4，周三 18:00 冻结变更；回滚预案与值班安排见第二条。',
      now - 18 * MIN,
      { attemptId: 'at-feishu-week', model: fantay.model },
    ),
  ];
  const outboxRow = (id: string, at: number, extra: Partial<PaChannelOutbox>): PaChannelOutbox => ({
    ...stamp(at),
    id,
    channelId: 'ch-feishu',
    authorizationVersion: 2,
    taskId: null,
    inboxId: 'in-ok',
    requestId: `rq-${id}`,
    state: 'sent',
    providerMessageId: null,
    attempts: 1,
    nextAttemptAt: 0,
    error: null,
    sentAt: null,
    preview: '',
    ...extra,
  });
  const channels: PaChannelSnapshot = {
    channels: [channel('ch-feishu', 'feishu', '产品群', fantay.id, now, { authorizationVersion: 2, updatedAt: now - 30 * MIN })],
    inbox: [
      inbox('in-approve', 'ch-feishu', '/project 做一个新版官网落地页', now - 20 * MIN, { state: 'approval', approvalId: 'appr-1' }),
      inbox('in-week', 'ch-feishu', '下周的发布排期发我一份', now - 20 * MIN, { taskId: 'tk-feishu-week' }),
      inbox('in-old', 'ch-feishu', '把这周的评审结论同步到群里', now - 33 * MIN, { taskId: 'tk-feishu-old' }),
      inbox('in-status', 'ch-feishu', '/status', now - 36 * MIN),
      inbox('in-ok', 'ch-feishu', '周五的评审会议帮我安排一下', now - 3 * HOUR),
    ],
    outbox: [
      // A /status reply still pending when the permissions changed: cancelled by the daemon, with its reason.
      outboxRow('out-status', now - 35 * MIN, {
        inboxId: 'in-status',
        authorizationVersion: 1,
        state: 'cancelled',
        updatedAt: now - 30 * MIN,
        error: '渠道授权或账号已改变，旧回复不再投递',
        preview: '当前 1 项任务进行中，0 项排队。',
      }),
      outboxRow('out-week-1', now - 18 * MIN, {
        taskId: 'tk-feishu-week',
        inboxId: 'in-week',
        providerMessageId: 'om_week_1',
        sentAt: now - 18 * MIN,
        preview: '下周发布排期：周四 15:00 发布 2.4，周三 18:00 冻结变更。',
      }),
      outboxRow('out-week-2', now - 18 * MIN, {
        taskId: 'tk-feishu-week',
        inboxId: 'in-week',
        state: 'unknown',
        updatedAt: now - 17 * MIN,
        providerMessageId: 'om_week_2',
        attempts: 2,
        error: '发送结果未确认：回执超时',
        preview: '回滚预案：发布后 2 小时内观察错误率；值班：研究员、审阅者。',
      }),
      {
        ...stamp(now - 50 * MIN),
        id: 'out-unknown',
        channelId: 'ch-feishu',
        authorizationVersion: 1,
        taskId: null,
        inboxId: 'in-ok',
        requestId: 'rq-out-unknown',
        state: 'unknown',
        providerMessageId: null,
        attempts: 2,
        nextAttemptAt: 0,
        error: '发送结果未确认：连接在回执前中断',
        sentAt: null,
        preview: '已为你安排周五 15:00 的评审会议，参会人：产品组。',
      } satisfies PaChannelOutbox,
    ],
  };
  return fixtureOf(
    now,
    {
      agents: [fantay, reviewer, researcher],
      groups: [studio],
      conversations: [direct, studioChat, researcherChat, feishuConv],
      messages,
      tasks,
      attempts,
    },
    { channels, projects: [], ui: { place: 'tasks', tasksFilter: 'needs' } },
  );
}

function projectDone(now: number): PaFixture {
  const { fantay, reviewer, studio, direct, studioChat } = cast(now);
  const at = now - 25 * MIN;
  const tk = task('tk-site', studioChat.id, '做一个读书会的活动主页', at, {
    kind: 'project',
    projectName: '读书会主页',
    projectId: 'proj-reading',
    participantIds: [fantay.id, reviewer.id],
    nextParticipant: 2,
    evidence: ['3 个文件已读回并校验内容指纹', '独立模型审阅：页面结构完整，信息与要求一致'],
    authorization: { localProject: true, externalWrites: false, version: 1, revoked: false },
  });
  const attempts = [
    attempt('at-site-p', tk.id, fantay, 'produce', at + 2000, {
      endedAt: at + 95_000,
      usage: { inputTokens: 5400, outputTokens: 3100, costUsd: '0.0612', visibility: 'reported' },
    }),
    attempt('at-site-r', tk.id, reviewer, 'review', at + 98_000, { endedAt: at + 121_000, usage: { visibility: 'unknown' } }),
  ];
  const sha = (n: number) => String(n).repeat(64).slice(0, 64);
  const artifacts: PaArtifact[] = [
    ['index.html', 4820, 1],
    ['styles.css', 2310, 2],
    ['notes.md', 640, 3],
  ].map(([file, bytes, n]) => ({
    ...stamp(at + 96_000),
    id: `art-${n}`,
    taskId: tk.id,
    attemptId: 'at-site-p',
    projectId: 'proj-reading',
    path: `reading-club/${file}`,
    sha256: sha(Number(n) + 4),
    bytes: Number(bytes),
    verification: ['文件已读回', 'SHA-256 一致'],
  }));
  const messages = [
    owner('p1', studioChat.id, tk.id, '做一个读书会的活动主页，要有书单和往期回顾', at, { }),
    message(
      'p2',
      studioChat.id,
      tk.id,
      fantay.id,
      JSON.stringify({ summary: '已完成读书会活动主页：包含简介、本期书单、往期回顾与报名入口，样式单独放在 styles.css。', files: [{ path: 'index.html' }, { path: 'styles.css' }, { path: 'notes.md' }] }),
      at + 95_000,
      { attemptId: 'at-site-p', model: fantay.model },
    ),
    message(
      'p3',
      studioChat.id,
      tk.id,
      reviewer.id,
      JSON.stringify({ approved: true, summary: '页面结构完整，书单与往期回顾均与要求一致，未发现需要修改的问题。', issues: [] }),
      at + 121_000,
      { attemptId: 'at-site-r', model: reviewer.model },
    ),
  ];
  return fixtureOf(
    now,
    { agents: [fantay, reviewer], groups: [studio], conversations: [direct, studioChat], messages, tasks: [tk], attempts, artifacts },
    { projects: [project('proj-reading', '读书会主页', at)], ui: { place: 'conversation', conversationId: studioChat.id, inspectorOpen: false } },
  );
}

function groupThree(now: number): PaFixture {
  const { fantay, reviewer, researcher, direct } = cast(now);
  const group: PaGroup = {
    ...stamp(now - 9 * DAY),
    id: 'grp-release',
    name: '发布小组',
    memberIds: [fantay.id, researcher.id, reviewer.id],
    moderatorId: fantay.id,
    reviewerId: reviewer.id,
    mode: 'collaboration',
    conversationId: 'conv-release',
  };
  const chat = conversation('conv-release', '发布小组', now - 9 * DAY, { groupId: group.id });
  const a = now - 3 * HOUR;
  const b = now - 40 * MIN;
  const c = now - 2 * MIN;
  const tasks = [
    task('tk-g1', chat.id, '@研究员 先帮我查一下这周的发布节奏', a, { participantIds: [researcher.id], nextParticipant: 1, kind: 'discussion' }),
    task('tk-g2', chat.id, '把发布说明整理成对外版本', b, { participantIds: [fantay.id, reviewer.id], nextParticipant: 2 }),
    // Two additions while it runs: the first was taken in at the researcher → Fantay hand-off, the second waits for
    // the next step (the working line's "addition pending" caption; the task modal's 补充要求 list).
    task('tk-g3', chat.id, '根据研究结论起草本周发布公告', c, {
      status: 'running',
      participantIds: [researcher.id, fantay.id, reviewer.id],
      nextParticipant: 1,
      amendments: [
        { revision: 1, content: '公告里写明周三 18:00 起冻结变更。', receivedAt: c + 12_000, appliedAt: now - 20_000 },
        { revision: 2, content: '结尾加上回滚联系人：研究员。', receivedAt: now - 8_000, appliedAt: null },
      ],
    }),
  ];
  const attempts = [
    attempt('at-g1', 'tk-g1', researcher, 'respond', a + 2000),
    attempt('at-g2a', 'tk-g2', fantay, 'respond', b + 2000),
    attempt('at-g2b', 'tk-g2', reviewer, 'review', b + 40_000, { usage: { visibility: 'unknown' } }),
    attempt('at-g3a', 'tk-g3', researcher, 'respond', c + 2000, { endedAt: c + 30_000 }),
    attempt('at-g3b', 'tk-g3', fantay, 'respond', now - 20_000, { status: 'running', usage: { visibility: 'unknown' } }),
  ];
  const messages = [
    owner('g1', chat.id, 'tk-g1', '@研究员 先帮我查一下这周的发布节奏', a, { targetAgentIds: [researcher.id] }),
    message('g2', chat.id, 'tk-g1', researcher.id, '近四周的发布都集中在周四下午，平均间隔 7 天；上一版的回滚发生在发布后 2 小时内。', a + 24_000, { attemptId: 'at-g1', model: researcher.model }),
    owner('g3', chat.id, 'tk-g2', '把发布说明整理成对外版本', b),
    message('g4', chat.id, 'tk-g2', fantay.id, '对外版本已整理：保留新功能与修复项，删去内部排期与负责人信息。', b + 25_000, { attemptId: 'at-g2a', model: fantay.model }),
    message(
      'g5',
      chat.id,
      'tk-g2',
      reviewer.id,
      '{"approved":true,"summary":"没有泄露内部信息，措辞符合对外口径。","issues":[]}',
      b + 62_000,
      { attemptId: 'at-g2b', model: reviewer.model },
    ),
    owner('g6', chat.id, 'tk-g3', '根据研究结论起草本周发布公告', c, { replyTo: 'g2' }),
    message('g7', chat.id, 'tk-g3', researcher.id, '结论：本周沿用周四下午发布，并在发布前一天冻结变更。', c + 28_000, { attemptId: 'at-g3a', model: researcher.model }),
  ];
  return fixtureOf(
    now,
    { agents: [fantay, reviewer, researcher], groups: [group], conversations: [direct, chat], messages, tasks, attempts },
    { control: control(now, { activeCount: 1 }), ui: { place: 'conversation', conversationId: chat.id, inspectorOpen: true } },
  );
}

function inspectorScenario(now: number): PaFixture {
  const base = fantayChat(now);
  const d = chatData(now);
  const memories = [
    ...d.memories,
    memory('mem-agent', 'agent', 'ag-fantay', '回答计划类问题时，先给出表格再给出说明。', '对话：偏好', now - 4 * DAY),
    memory('mem-group', 'group', 'grp-studio', '协作工作室的交付物一律放在项目的 deliverables 目录。', '群组约定', now - 3 * DAY),
    memory('mem-project', 'project', 'proj-reading', '读书会主页使用暖色背景，不使用深色主题。', '项目：读书会主页', now - 2 * DAY, 2),
  ];
  const routines = [
    ...(base.snapshot.routines ?? []),
    routine('rt-evening', d.direct.id, '晚间错题归档', '汇总今天做错的真题并归档到错题本。', '21:30', now, {
      enabled: false,
    }),
  ];
  const artifacts: PaArtifact[] = [
    {
      ...stamp(now - 2 * DAY),
      id: 'art-insp-1',
      taskId: 'tk-plan',
      attemptId: 'at-plan',
      projectId: 'proj-reading',
      path: 'reading-club/index.html',
      sha256: '5'.repeat(64),
      bytes: 4820,
      verification: ['文件已读回', 'SHA-256 一致'],
    },
  ];
  // mem-pref is referenced by two replies (m4 already; add the second).
  const messages = base.snapshot.messages.map((m) => (m.id === 'm6' ? { ...m, memoryRefs: [{ id: 'mem-pref', revision: 3 }] } : m));
  const channels: PaChannelSnapshot = {
    channels: [
      channel('ch-insp-feishu', 'feishu', '产品群', d.fantay.id, now),
      channel('ch-insp-weixin', 'weixin', '个人微信', d.fantay.id, now, {
        enabled: false,
        status: 'disconnected',
        credentialConfigured: false,
        accountLabel: null,
        allowedSenderIds: [],
        lastReceivedAt: null,
        lastSentAt: null,
        capabilities: { direct: true, groups: false, threads: false, files: false, unsolicited: false },
        verification: { inboundAt: null, outboundAt: null, reconnectAt: null, reloginAt: null },
      }),
    ],
    inbox: [],
    outbox: [],
  };
  return {
    ...base,
    snapshot: { ...base.snapshot, memories, messages, routines, artifacts },
    channels,
    projects: [project('proj-reading', '读书会主页', now - 2 * DAY)],
    ui: { ...base.ui, inspectorOpen: true, inspectorTab: 'activity' },
  };
}

function connections(now: number): PaFixture {
  const { fantay, reviewer, researcher, studio, direct, studioChat } = cast(now);
  // A disabled agent, so the roster's disabled row (faint name, "· Disabled", dimmed disc) has a fixture.
  const translator = agent('ag-translator', '翻译助手', '译', '把中文材料译成英文，保留术语表。', 'haiku', now - 20 * DAY, { enabled: false });
  const feishu = channel('ch-feishu', 'feishu', '产品群', fantay.id, now);
  const weixin = channel('ch-weixin', 'weixin', '微信助手', fantay.id, now, {
    status: 'login_required',
    lastError: '微信登录已过期，请重新扫码',
    lastReceivedAt: now - 2 * DAY,
    lastSentAt: now - 2 * DAY,
    verification: { inboundAt: now - 2 * DAY, outboundAt: now - 2 * DAY, reconnectAt: null, reloginAt: null },
    capabilities: { direct: true, groups: false, threads: false, files: false, unsolicited: false },
  });
  const feishuConv = conversation('conv-feishu', '产品群', now - 12 * MIN, { channelId: feishu.id, agentId: fantay.id, externalThreadId: 'oc_5c9e1d' });
  // The Feishu chat's last exchange (the inbox history's newest row), so its roster row has a real preview.
  const feishuTask = task('tk-feishu', feishuConv.id, '帮我看一下今天的待办', now - 13 * MIN, { participantIds: [fantay.id], nextParticipant: 1 });
  const pausedTask = task('tk-paused', direct.id, '整理本周的读书笔记', now - 30 * MIN, {
    status: 'waiting',
    waitKind: 'paused',
    waitingSince: now - 29 * MIN,
    waitingReason: '后台已暂停；恢复后继续',
    participantIds: [fantay.id],
  });
  const history = Array.from({ length: 20 }, (_, i) =>
    inbox(`in-h${i}`, i % 4 === 3 ? weixin.id : feishu.id, ['帮我看一下今天的待办', '总结一下刚才的讨论', '/status', '把这段话翻译成英文'][i % 4]!, now - (i + 1) * 47 * MIN, {
      state: i % 9 === 8 ? 'ignored' : 'accepted',
    }),
  );
  const models: PaModelOption[] = [
    ...DEFAULT_MODELS,
    { runtime: 'ollama', modelId: 'qwen2.5:14b', label: 'Qwen 2.5 14B (本机)', available: false, detail: '未检测到本机 Ollama 服务，请先启动 Ollama' },
  ];
  return fixtureOf(
    now,
    {
      agents: [fantay, reviewer, researcher, translator],
      groups: [studio],
      conversations: [direct, studioChat, feishuConv],
      tasks: [pausedTask, feishuTask],
      attempts: [attempt('at-feishu', feishuTask.id, fantay, 'respond', now - 13 * MIN)],
      messages: [
        owner('c1', direct.id, pausedTask.id, '整理本周的读书笔记', now - 30 * MIN),
        owner('c2', feishuConv.id, feishuTask.id, '帮我看一下今天的待办', now - 13 * MIN),
        message('c3', feishuConv.id, feishuTask.id, fantay.id, '今天有 3 件待办：14:00 评审会、提交周报、回复读书会报名。', now - 12 * MIN, {
          attemptId: 'at-feishu',
          model: fantay.model,
        }),
      ],
    },
    {
      channels: { channels: [feishu, weixin], inbox: history, outbox: [] },
      control: control(now, { paused: true, pendingCount: 1, lastResumeAt: now - 3 * DAY }),
      models,
      ui: { place: 'connections' },
    },
  );
}

function offline(now: number): PaFixture {
  const empty = fixtureOf(now, {});
  return { ...empty, offline: true, ui: { place: 'conversation' } };
}

const CJK_SENTENCE = '这是一段用来检验排版的长文字，它会反复出现，确保标题、预览和正文在各种宽度下都不会被截断或溢出。';
function cjk(length: number): string {
  let out = '';
  while (out.length < length) out += CJK_SENTENCE;
  return out.slice(0, length);
}

function longCjk(now: number): PaFixture {
  const { fantay, reviewer, researcher, studio, direct, studioChat } = cast(now);
  const long = agent('ag-long', cjk(60), '长', cjk(120), 'sonnet', now - 5 * DAY);
  const chat = conversation('conv-long', long.name, now - 2 * HOUR, { agentId: long.id });
  // A four-member group with a long name: the cluster's "+N" face and title truncation.
  const crowd: PaGroup = {
    ...stamp(now - 4 * DAY),
    id: 'grp-crowd',
    name: cjk(40),
    memberIds: [fantay.id, long.id, researcher.id, reviewer.id],
    moderatorId: fantay.id,
    reviewerId: reviewer.id,
    mode: 'discussion',
    conversationId: 'conv-crowd',
  };
  const crowdChat = conversation('conv-crowd', crowd.name, now - 4 * DAY, { groupId: crowd.id });
  const goal = cjk(400);
  const tk = task('tk-long', chat.id, goal, now - 2 * HOUR, { participantIds: [long.id], nextParticipant: 1 });
  return fixtureOf(
    now,
    {
      agents: [fantay, reviewer, researcher, long],
      groups: [studio, crowd],
      conversations: [direct, studioChat, chat, crowdChat],
      tasks: [tk],
      attempts: [attempt('at-long', tk.id, long, 'respond', now - 2 * HOUR + 2000)],
      messages: [
        owner('l1', chat.id, tk.id, goal, now - 2 * HOUR),
        message('l2', chat.id, tk.id, long.id, cjk(2000), now - 2 * HOUR + 30_000, { attemptId: 'at-long', model: long.model }),
      ],
    },
    { ui: { place: 'conversation', conversationId: chat.id, inspectorOpen: true } },
  );
}

const BUILDERS: Record<PaScenarioId, (now: number) => PaFixture> = {
  'first-run': firstRun,
  'fantay-chat': fantayChat,
  'needs-you': needsYou,
  'project-done': projectDone,
  'group-three': groupThree,
  inspector: inspectorScenario,
  connections,
  offline,
  'long-cjk': longCjk,
  // Called lazily: ./soul-fixtures imports helpers from this file, so neither side touches the other at load time.
  'first-run-soul': (now) => firstRunSoul(now),
  'companion-chat': (now) => companionChat(now),
  'story-game': (now) => storyGame(now),
  'companion-group': (now) => companionGroup(now),
  library: (now) => soulLibrary(now),
  'live-chat': (now) => liveChat(now),
  'voice-chat': (now) => voiceChat(now),
  'sprites-chat': (now) => spritesChat(now),
  'journal-chat': (now) => journalChat(now),
};

/** Builders shared with ./soul-fixtures. */
export { DAY, HOUR, MIN, attempt, cast, control, conversation, firstRun, fixtureOf, message, stamp, task };

export function isPaScenario(value: string | null | undefined): value is PaScenarioId {
  return (PA_SCENARIO_IDS as readonly string[]).includes(value ?? '');
}

export function buildFixture(id: PaScenarioId, now: number = Date.now()): PaFixture {
  return BUILDERS[id](now);
}
