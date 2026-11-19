import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  paTaskInputSchema,
  type PaAttempt,
  type PaConversation,
  type PaMessage,
  type PaSoulLiveResponse,
  type PaTask,
  type PersonalAgent,
} from '@open-design/contracts';
import { SOUL_LIMITS } from '@open-design/contracts/soul';
import { closeDatabase, openDatabase, type SqliteDb } from '../src/db.js';
import { registerPersonalAgentRoutes } from '../src/routes/personal-agent.js';
import type { PaDeltaSink, PaModelResult, PaModelRuntime } from '../src/runtimes/personal-agent.js';
import type { PersonalAgentChannels } from '../src/services/personal-agent-channels.js';
import { redactPaLiveText } from '../src/services/personal-agent-gateway.js';
import { PersonalAgentService } from '../src/services/personal-agent-service.js';
import { PaError } from '../src/storage/personal-agent-store.js';

let root: string, db: SqliteDb, core: PersonalAgentService, server: http.Server | null = null;
let clock: number | null = null;
const execute = vi.fn<PaModelRuntime['execute']>();
const reply = (text: string): PaModelResult => ({ text, usage: { visibility: 'unknown' } });
const construct = () => new PersonalAgentService({
  db, dataDir: root, projectsDir: join(root, 'projects'), runtime: { models: async () => [], execute }, rng: () => 0.42,
  now: () => clock ?? Date.now(),
});
const status = (id: string) => core.store.require<PaTask>('tasks', id).status;
const waitFor = async (id: string, state: PaTask['status']) => vi.waitFor(() => expect(status(id)).toBe(state));
const messagesOf = (conversationId: string) =>
  core.store.list<PaMessage>('messages').filter((message) => message.conversationId === conversationId);
const repliesOf = (conversationId: string, agentId: string) =>
  messagesOf(conversationId).filter((message) => message.senderId === agentId);
const attemptOf = (taskId: string) => core.store.listTaskAttempts<PaAttempt>(taskId).at(-1)!;

function companion(name = '小月'): { agent: PersonalAgent; conversation: PaConversation } {
  const agent = core.createAgent({ name, role: '陪伴聊天的朋友', avatar: '', enabled: true, tools: ['respond'], model: { runtime: 'claude', modelId: 'sonnet' } });
  core.soul.saveCharacter(agent.id, { description: '住在窗边工作室，说话轻声慢气。' });
  return { agent, conversation: core.createConversation(agent.id) };
}
const chat = (conversationId: string, goal = '今天有点累') =>
  core.submit(paTaskInputSchema.parse({ requestId: crypto.randomUUID(), conversationId, goal, kind: 'chat' }));

/** Holds every model call until the test settles it; `delta` is the sink the gateway handed the runtime. */
type Held = { resolve: (value: PaModelResult) => void; reject: (error: unknown) => void; prompt: string; delta: PaDeltaSink | undefined };
let held: Held[] = [];
const hold = () => execute.mockImplementation((_model, prompt, _runId, signal, limits) => new Promise<PaModelResult>((resolve, reject) => {
  held.push({ resolve, reject, prompt, delta: limits?.onDelta });
  signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
}));
const send = (index: number, ...chunks: string[]) => { for (const chunk of chunks) held[index]!.delta!(chunk); };

async function listen(): Promise<string> {
  const app = express();
  app.use(express.json());
  registerPersonalAgentRoutes(app, {
    personalAgent: core,
    personalAgentChannels: { pendingApprovalCount: () => 0 } as unknown as PersonalAgentChannels,
  });
  const started = await new Promise<http.Server>((resolve) => {
    const listening: http.Server = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  server = started;
  return `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
}

const STREAM = ['你好', '，在', '呢\n<turn_meta>\nmood: 开心'];
/** The whole reply: the stream above, then the footer's closing line, which has not arrived while the turn is held. */
const FULL = `${STREAM.join('')}\n</turn_meta>`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pa-soul-live-'));
  db = openDatabase(root, { dataDir: root });
  held = [];
  clock = null;
  execute.mockReset().mockResolvedValue(reply('嗯，我在。'));
  core = construct();
});
afterEach(async () => {
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  await core.shutdown();
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

describe('PA soul live text', () => {
  it('shows the visible text of a running reply and drops it once the message is stored', async () => {
    const { agent, conversation } = companion();
    hold();
    const task = chat(conversation.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(core.soulLive.read(conversation.id)).toMatchObject({ seq: 0, text: '' });
    send(0, ...STREAM);
    expect(core.soulLive.read(conversation.id)).toEqual({
      attemptId: attemptOf(task.id).id, taskId: task.id, agentId: agent.id, seq: 3, text: '你好，在呢',
    });
    held[0]!.resolve(reply(FULL));
    await waitFor(task.id, 'completed');
    expect(core.soulLive.read(conversation.id)).toBeNull();
    const stored = repliesOf(conversation.id, agent.id);
    expect(stored.map((message) => message.content)).toEqual(['你好，在呢']);
    expect(stored[0]!.soul?.mood).toBe('开心');
  });

  it('keeps the result, the receipt and the audit digests identical with and without deltas', async () => {
    const { agent } = companion();
    clock = Date.now();
    const run = async (stream: boolean) => {
      const conversation = core.createConversation(agent.id);
      let offered = false;
      execute.mockImplementationOnce(async (_model, _prompt, _runId, _signal, limits) => {
        offered = typeof limits?.onDelta === 'function';
        if (stream) for (const chunk of STREAM) limits!.onDelta!(chunk);
        return reply(FULL);
      });
      const task = chat(conversation.id);
      await waitFor(task.id, 'completed');
      const attempt = attemptOf(task.id);
      const event = (kind: string) => core.store.events(task.id).find((item) => item.kind === kind)?.data as Record<string, unknown>;
      const dispatched = event('gateway.model_dispatched');
      const received = event('gateway.model_received');
      return {
        offered,
        output: attempt.output,
        outputSha256: attempt.modelReceipt?.outputSha256,
        requestDigest: dispatched.requestDigest,
        requestBytes: dispatched.requestBytes,
        chatDigest: dispatched.chatDigest,
        outputDigest: received.outputDigest,
        content: repliesOf(conversation.id, agent.id).map((message) => message.content),
      };
    };
    const plain = await run(false);
    const streamed = await run(true);
    expect(plain.offered).toBe(true);
    expect(plain.chatDigest).toEqual(expect.any(String));
    expect(streamed).toEqual(plain);
  });

  it('does not fail the turn when the sink throws', async () => {
    const { agent, conversation } = companion();
    vi.spyOn(core.soulLive, 'append').mockImplementation(() => { throw new Error('boom'); });
    execute.mockImplementationOnce(async (_model, _prompt, _runId, _signal, limits) => {
      limits?.onDelta?.('你好');
      return reply('你好，我在。');
    });
    const task = chat(conversation.id);
    await waitFor(task.id, 'completed');
    expect(repliesOf(conversation.id, agent.id).map((message) => message.content)).toEqual(['你好，我在。']);
  });

  it('drops the live text of a stopped turn and stores no partial reply', async () => {
    const { agent, conversation } = companion();
    hold();
    const task = chat(conversation.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    send(0, '说到一半');
    expect(core.soulLive.read(conversation.id)?.text).toBe('说到一半');
    core.cancel(task.id);
    await waitFor(task.id, 'cancelled');
    expect(attemptOf(task.id).status).toBe('cancelled');
    expect(core.soulLive.read(conversation.id)).toBeNull();
    send(0, '还在写');
    expect(core.soulLive.read(conversation.id)).toBeNull();
    expect(repliesOf(conversation.id, agent.id)).toHaveLength(0);
  });

  it('drops the live text of a failed turn and stores no partial reply', async () => {
    const { agent, conversation } = companion();
    execute.mockImplementationOnce(async (_model, _prompt, _runId, _signal, limits) => {
      limits?.onDelta?.('说到一半');
      throw new PaError('模型不可用', 503, 'PA_MODEL_UNAVAILABLE');
    });
    const task = chat(conversation.id);
    await waitFor(task.id, 'failed');
    expect(core.soulLive.read(conversation.id)).toBeNull();
    expect(repliesOf(conversation.id, agent.id)).toHaveLength(0);
  });

  it('starts over on reset, stops growing at the live cap and gives each room speaker its own entry', async () => {
    const { conversation } = companion();
    hold();
    chat(conversation.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    send(0, '旧的开头');
    held[0]!.delta!('新的', { reset: true });
    expect(core.soulLive.read(conversation.id)).toMatchObject({ seq: 2, text: '新的' });
    held[0]!.delta!('x'.repeat(SOUL_LIMITS.liveChars - 1), { reset: true });
    send(0, 'yz', '多出来的');
    const capped = core.soulLive.read(conversation.id)!;
    expect(capped.seq).toBe(4);
    expect(capped.text).toHaveLength(SOUL_LIMITS.messageContent);
    expect(capped.text).not.toContain('多');
    held[0]!.delta!('重来', { reset: true });
    expect(core.soulLive.read(conversation.id)).toMatchObject({ seq: 5, text: '重来' });
    held[0]!.resolve(reply('重来。'));

    const first = companion('阿青').agent;
    const second = companion('阿白').agent;
    const room = core.createGroup({ name: '夜谈', memberIds: [first.id, second.id], moderatorId: first.id, mode: 'discussion' });
    core.soul.saveChat(room.conversationId, { groupStrategy: 'list' }, core.soul.chatView(room.conversationId).revision || undefined);
    const turn = chat(room.conversationId, '大家晚上好');
    await vi.waitFor(() => expect(held).toHaveLength(2));
    send(1, '我先说');
    const opening = core.soulLive.read(room.conversationId)!;
    expect(opening).toMatchObject({ taskId: turn.id, agentId: first.id, seq: 1, text: '我先说' });
    held[1]!.resolve(reply('我先说。'));
    await vi.waitFor(() => expect(held).toHaveLength(3));
    expect(core.soulLive.read(room.conversationId)).toMatchObject({ taskId: turn.id, agentId: second.id, seq: 0, text: '' });
    send(2, '我后说');
    const next = core.soulLive.read(room.conversationId)!;
    expect(next).toMatchObject({ agentId: second.id, seq: 1, text: '我后说' });
    expect(next.attemptId).not.toBe(opening.attemptId);
    held[2]!.resolve(reply('我后说。'));
    await waitFor(turn.id, 'completed');
    expect(core.soulLive.read(room.conversationId)).toBeNull();
  });

  it('redacts credentials in live text, including one that is still arriving', () => {
    const complete = redactPaLiveText(`密钥是 sk-ant-${'a'.repeat(24)} 记得换`);
    expect(complete).toBe('密钥是 [credential removed] 记得换');
    expect(redactPaLiveText('我的是 sk-ant-abc')).toBe('我的是 ');
    expect(redactPaLiveText('Authorization: Bearer abc')).toBe('Authorization: ');
    expect(redactPaLiveText('password: hun')).toBe('password: ');
    expect(redactPaLiveText('password: "hunter 2')).toBe('password: ');
    expect(redactPaLiveText('前面\n-----BEGIN PRIVATE KEY-----\nMIIE')).toBe('前面\n');
    for (const plain of ['今天天气很好，我们去散步吧。', 'ask-me 也可以，task 也行', 'password 是什么意思？'])
      expect(redactPaLiveText(plain)).toBe(plain);
    // the tail rules look at the end only: a long text still holds back its arriving key ...
    expect(redactPaLiveText(`${'好'.repeat(5000)} 我的是 sk-ant-abc`)).toBe(`${'好'.repeat(5000)} 我的是 `);
    // ... and hostile text at the live cap costs milliseconds per poll, not seconds
    for (const hostile of ['AKIA-'.repeat(SOUL_LIMITS.liveChars / 5), 'password=,'.repeat(SOUL_LIMITS.liveChars / 10)]) {
      const started = performance.now();
      redactPaLiveText(`${hostile} end`);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  it('stops growing the live text once a stop was asked, while the runtime is still exiting', async () => {
    const { agent, conversation } = companion();
    let exited: () => void = () => {};
    execute.mockImplementationOnce((_model, _prompt, _runId, signal, limits) => new Promise<PaModelResult>((_resolve, reject) => {
      held.push({ resolve: _resolve, reject, prompt: '', delta: limits?.onDelta });
      signal.addEventListener('abort', () => { exited = () => reject(new Error('aborted')); }, { once: true });
    }));
    const task = chat(conversation.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    send(0, '说到一半');
    core.cancel(task.id);
    expect(status(task.id)).toBe('cancelling');
    send(0, '，停下前又写了一句');
    expect(core.soulLive.read(conversation.id)?.text).toBe('说到一半');
    exited();
    await waitFor(task.id, 'cancelled');
    expect(core.soulLive.read(conversation.id)).toBeNull();
    expect(repliesOf(conversation.id, agent.id)).toHaveLength(0);
  });

  it('answers the live route over HTTP: null when idle, the text while running, unchanged when known', async () => {
    const { agent, conversation } = companion();
    const base = await listen();
    const live = async (query: string) => {
      const response = await fetch(`${base}/api/pa/soul/live?${query}`);
      return { status: response.status, body: await response.json() as PaSoulLiveResponse };
    };
    expect(await live(`conversationId=${conversation.id}`)).toEqual({ status: 200, body: { live: null } });
    expect(await live('conversationId=unknown')).toEqual({ status: 200, body: { live: null } });
    hold();
    const task = chat(conversation.id);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    send(0, ...STREAM);
    const attemptId = attemptOf(task.id).id;
    expect((await live(`conversationId=${conversation.id}`)).body).toEqual({
      live: { attemptId, taskId: task.id, agentId: agent.id, seq: 3, text: '你好，在呢' },
    });
    expect((await live(`conversationId=${conversation.id}&attempt=${attemptId}&seq=3`)).body).toEqual({
      live: { attemptId, taskId: task.id, agentId: agent.id, seq: 3, unchanged: true },
    });
    expect((await live(`conversationId=${conversation.id}&attempt=${attemptId}`)).body.live?.text).toBe('你好，在呢');
    expect((await live(`conversationId=${conversation.id}&attempt=${attemptId}&seq=2`)).body.live?.text).toBe('你好，在呢');
    for (const query of ['', 'conversationId=', `conversationId=${conversation.id}&seq=-1`, `conversationId=${conversation.id}&seq=1.5`])
      expect((await live(query)).status).toBe(400);
    held[0]!.resolve(reply(FULL));
    await waitFor(task.id, 'completed');
    expect((await live(`conversationId=${conversation.id}`)).body).toEqual({ live: null });
  });
});
