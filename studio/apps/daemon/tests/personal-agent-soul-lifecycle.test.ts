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
  type PaChatState,
  type PaChatWire,
  type PaConversation,
  type PaFeedItem,
  type PaMessage,
  type PaRoutine,
  type PaTask,
  type PersonalAgent,
} from '@open-design/contracts';
import { closeDatabase, openDatabase, type SqliteDb } from '../src/db.js';
import { registerPersonalAgentRoutes } from '../src/routes/personal-agent.js';
import { paClaudeStructured, type PaModelResult, type PaModelRuntime } from '../src/runtimes/personal-agent.js';
import type { PersonalAgentChannels } from '../src/services/personal-agent-channels.js';
import { paDigest } from '../src/services/personal-agent-gateway.js';
import { PersonalAgentService } from '../src/services/personal-agent-service.js';
import { PaError } from '../src/storage/personal-agent-store.js';

let root: string, db: SqliteDb, core: PersonalAgentService, server: http.Server | null = null;
const execute = vi.fn<PaModelRuntime['execute']>();
const reply = (text: string): PaModelResult => ({ text, usage: { visibility: 'unknown' } });
const construct = () => new PersonalAgentService({
  db, dataDir: root, projectsDir: join(root, 'projects'), runtime: { models: async () => [], execute }, rng: () => 0.42,
});
const status = (id: string) => core.store.require<PaTask>('tasks', id).status;
const waitFor = async (id: string, state: PaTask['status']) => vi.waitFor(() => expect(status(id)).toBe(state));
const messagesOf = (conversationId: string) =>
  core.store.list<PaMessage>('messages').filter((message) => message.conversationId === conversationId);
const fantay = () => core.store.list<PersonalAgent>('agents').find((agent) => agent.avatar === 'fantay')!;

/** A carded agent and its first direct conversation, which resolves to companion mode. */
function companion(model: PersonalAgent['model'] = { runtime: 'claude', modelId: 'sonnet' }): { agent: PersonalAgent; conversation: PaConversation } {
  const agent = core.createAgent({ name: '小月', role: '陪伴聊天的朋友', avatar: '', enabled: true, tools: ['respond'], model });
  core.soul.saveCharacter(agent.id, { description: '住在窗边工作室，说话轻声慢气。' });
  return { agent, conversation: core.createConversation(agent.id) };
}
const chat = (conversationId: string, goal = '今天有点累', extra: Record<string, unknown> = {}) =>
  core.submit(paTaskInputSchema.parse({ requestId: crypto.randomUUID(), conversationId, goal, kind: 'chat', ...extra }));
const work = (conversationId: string, goal = 'Draft the brief') =>
  core.submit(paTaskInputSchema.parse({ requestId: crypto.randomUUID(), conversationId, goal }));

/** Holds every model call until the test settles it; an abort rejects it like a real runtime. */
type Held = { resolve: (value: PaModelResult) => void; prompt: string; chat: PaChatWire | undefined };
let held: Held[] = [];
const hold = () => execute.mockImplementation((_model, prompt, _runId, signal, limits) => new Promise<PaModelResult>((resolve, reject) => {
  held.push({ resolve, prompt, chat: limits?.chat });
  signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
}));
const heldFor = (text: string) => held.find((item) => item.prompt.includes(text))!;

const DAY = 86_400_000;
/** A fixed-offset zone whose local hour is `hour` right now (Etc/GMT-N is UTC+N), so time-of-day guards are deterministic. */
const zoneAt = (hour: number): string => {
  let offset = hour - new Date().getUTCHours();
  if (offset < -12) offset += 24;
  return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
};
const reachout = (conversationId: string, timezone = zoneAt(12)) => core.saveRoutine({
  name: '先开口', prompt: 'REACHOUT_NOTE 问问 TA 今天过得怎么样', conversationId, time: '12:00', timezone, enabled: true,
  soul: { kind: 'reachout' },
});
const routineOf = (id: string) => core.store.require<PaRoutine>('routines', id);
const runReachout = (id: string) => core.runRoutine(id, routineOf(id).revision);

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
const getJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return await response.json() as T;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pa-soul-life-'));
  db = openDatabase(root, { dataDir: root });
  held = [];
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

describe('PA soul chat lifecycle', () => {
  it('stops an Ollama chat reply as cancelled with a confirmed stop', async () => {
    const { conversation } = companion({ runtime: 'ollama', modelId: 'qwen3' });
    execute.mockImplementationOnce((_model, _prompt, _runId, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    const task = chat(conversation.id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]![4]?.chat).toBeDefined();
    core.cancel(task.id);
    await waitFor(task.id, 'cancelled');
    expect(core.store.require<PaTask>('tasks', task.id).stopConfirmation).toBe('confirmed');
    expect(core.store.listTaskAttempts<PaAttempt>(task.id).map((attempt) => attempt.status)).toEqual(['cancelled']);
  });

  it('fails a dispatched chat attempt at restart and requeues the turn without reconciliation', async () => {
    const { agent, conversation } = companion();
    await core.setControl({ paused: true });
    const task = chat(conversation.id);
    const attempt = core.store.create<PaAttempt>('attempts', {
      taskId: task.id, runId: crypto.randomUUID(), nodeId: core.node.id, protocolVersion: 1,
      agentSnapshot: agent, phase: 'respond', status: 'running', taskRevision: task.revision,
      startedAt: Date.now(), endedAt: null, output: '', error: null, usage: { visibility: 'unknown' },
      authority: { principal: { kind: 'owner', id: 'owner' }, agentId: agent.id, authorizationVersion: 1, participantIndex: 0, capabilities: ['respond'] },
    });
    core.store.event(task.id, 'gateway.model_dispatched', { attemptId: attempt.id }, `${attempt.id}:model-dispatched`);
    core.store.update<PaTask>('tasks', task.id, { status: 'running' });
    await core.shutdown();
    core = construct();
    expect(core.store.require<PaAttempt>('attempts', attempt.id).status).toBe('failed');
    expect(core.store.require<PaTask>('tasks', task.id)).toMatchObject({ status: 'queued', stopConfirmation: 'confirmed' });
    await core.setControl({ paused: false });
    await waitFor(task.id, 'completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(core.store.events(task.id).some((event) => event.kind === 'task.recovery_required')).toBe(false);
  });

  it('fails a chat turn instead of waiting, retries it on resume and refuses a stale retry', async () => {
    const { conversation } = companion();
    execute.mockRejectedValueOnce(new PaError('模型不可用', 503, 'PA_MODEL_UNAVAILABLE'));
    const first = chat(conversation.id, '第一句');
    await waitFor(first.id, 'failed');
    core.resume(first.id);
    await waitFor(first.id, 'completed');
    execute.mockRejectedValueOnce(new PaError('模型不可用', 503, 'PA_MODEL_UNAVAILABLE'));
    const second = chat(conversation.id, '第二句');
    await waitFor(second.id, 'failed');
    await core.setControl({ paused: true });
    chat(conversation.id, '第三句');
    expect(() => core.resume(second.id)).toThrow(expect.objectContaining({ status: 409, code: 'PA_SOUL_STALE' }));
    expect(status(second.id)).toBe('failed');
  });

  it('keeps a chat reply running when a recalled memory changes and commits the reply', async () => {
    const { agent, conversation } = companion();
    const memory = core.saveMemory({ content: '喜欢雨天散步', source: 'owner', scope: 'agent', scopeId: agent.id });
    hold();
    const task = chat(conversation.id, '雨天散步怎么样');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(core.store.listTaskAttempts<PaAttempt>(task.id)[0]?.memoryRefs?.map((ref) => ref.id)).toContain(memory.id);
    core.saveMemory({ content: '喜欢晴天散步', source: 'owner', scope: 'agent', scopeId: agent.id }, memory.id, memory.revision);
    expect(status(task.id)).toBe('running');
    held[0]!.resolve(reply('那下雨的时候我们一起出去走走。'));
    await waitFor(task.id, 'completed');
    expect(messagesOf(conversation.id).filter((message) => message.senderId === agent.id).map((message) => message.content))
      .toEqual(['那下雨的时候我们一起出去走走。']);
  });

  it('refuses amend on a chat turn and expires a waiting chat turn after ten minutes', async () => {
    const { agent, conversation } = companion();
    await core.setControl({ paused: true });
    const old = chat(conversation.id);
    expect(() => core.amend(old.id, '再补充一句', old.revision)).toThrow(expect.objectContaining({ status: 400 }));
    const young = chat(core.createConversation(agent.id).id);
    const task = work(core.snapshot().conversations[0]!.id);
    for (const [id, age] of [[old.id, 601000], [young.id, 540000], [task.id, 601000]] as const)
      core.store.update<PaTask>('tasks', id, { status: 'waiting', waitKind: 'login', waitingSince: Date.now() - age });
    (core as unknown as { expireWaitingTasks(): void }).expireWaitingTasks();
    expect(status(old.id)).toBe('failed');
    expect(status(young.id)).toBe('waiting');
    expect(status(task.id)).toBe('waiting');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps a local-only message out of a standard chat prompt', async () => {
    const { agent, conversation } = companion();
    core.soul.saveCharacter(agent.id, { stateSchema: [{ key: 'place', kind: 'text', label: '地点', initial: '家' }] }, core.soul.character(agent.id)!.revision);
    for (const [content, dataClass] of [['LOCAL_ONLY_SENTINEL', 'local_only'], ['STANDARD_SENTINEL', 'standard']] as const)
      core.store.create<PaMessage>('messages', {
        conversationId: conversation.id, taskId: null, senderId: 'owner', content, dataClass,
        targetAgentIds: [], replyTo: null, soul: { kind: 'chat' },
      });
    // A local-only reply's state ops stay out of the folded state a standard prompt prints.
    core.store.create<PaMessage>('messages', {
      conversationId: conversation.id, taskId: null, senderId: agent.id, content: '好的', dataClass: 'local_only',
      targetAgentIds: [], replyTo: null, soul: { kind: 'chat', stateOps: [{ key: 'place', op: 'set', value: 'LOCAL_STATE_SENTINEL' }] },
    });
    const task = chat(conversation.id, '你还记得吗');
    await waitFor(task.id, 'completed');
    const [, prompt, , , limits] = execute.mock.calls[0]!;
    expect(prompt).toContain('STANDARD_SENTINEL');
    expect(prompt).not.toContain('LOCAL_ONLY_SENTINEL');
    expect(JSON.stringify(limits?.chat)).toContain('STANDARD_SENTINEL');
    expect(JSON.stringify(limits?.chat)).not.toContain('LOCAL_ONLY_SENTINEL');
    expect(prompt).not.toContain('LOCAL_STATE_SENTINEL');
    expect(JSON.stringify(limits?.chat)).not.toContain('LOCAL_STATE_SENTINEL');
  });

  it('runs chat turns in their own lane of two beside the work limit', async () => {
    const { agent } = companion();
    hold();
    const jobs = [core.createConversation(fantay().id), core.createConversation(fantay().id)].map((item) => work(item.id));
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(core.control().maxConcurrent).toBe(2);
    const turns = ['第一段对话', '第二段对话', '第三段对话'].map((goal) => chat(core.createConversation(agent.id).id, goal));
    await vi.waitFor(() => expect(held).toHaveLength(4));
    expect(turns.map((turn) => status(turn.id))).toEqual(['running', 'running', 'queued']);
    expect(held.slice(0, 2).every((item) => item.chat === undefined)).toBe(true);
    heldFor('第一段对话').resolve(reply('先回你一句。'));
    await waitFor(turns[0]!.id, 'completed');
    await vi.waitFor(() => expect(held).toHaveLength(5));
    expect(status(turns[2]!.id)).toBe('running');
    for (const item of held.slice(0, 2)) item.resolve(reply('Done'));
    heldFor('第二段对话').resolve(reply('好。'));
    heldFor('第三段对话').resolve(reply('好的。'));
    for (const id of [...jobs, ...turns].map((item) => item.id)) await waitFor(id, 'completed');
  });

  it('coalesces rapid messages into the queued turn and answers each burst once', async () => {
    const { agent, conversation } = companion();
    await core.setControl({ paused: true });
    const first = chat(conversation.id, '在吗');
    const repeatId = crypto.randomUUID();
    const second = chat(conversation.id, '想和你说件事', { requestId: repeatId });
    expect(second.id).toBe(first.id);
    const owners = () => messagesOf(conversation.id).filter((message) => message.senderId === 'owner');
    expect(owners().map((message) => message.taskId)).toEqual([first.id, first.id]);
    expect(chat(conversation.id, '想和你说件事', { requestId: repeatId }).id).toBe(first.id);
    expect(owners()).toHaveLength(2);
    expect(core.store.list<PaTask>('tasks').filter((task) => task.kind === 'chat')).toHaveLength(1);
    hold();
    await core.setControl({ paused: false });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]!.prompt).toContain('在吗');
    expect(held[0]!.prompt).toContain('想和你说件事');
    const later = ['你忙吗', '那我等你', '不急'].map((goal) => chat(conversation.id, goal));
    expect(new Set(later.map((task) => task.id)).size).toBe(1);
    expect(later[0]!.id).not.toBe(first.id);
    held[0]!.resolve(reply('在的。'));
    await waitFor(first.id, 'completed');
    await vi.waitFor(() => expect(held).toHaveLength(2));
    for (const goal of ['你忙吗', '那我等你', '不急']) expect(held[1]!.prompt).toContain(goal);
    held[1]!.resolve(reply('不忙，你说。'));
    await waitFor(later[0]!.id, 'completed');
    expect(messagesOf(conversation.id).filter((message) => message.senderId === agent.id)).toHaveLength(2);
    expect(core.store.list<PaTask>('tasks').filter((task) => task.kind === 'chat')).toHaveLength(2);
  });

  it('fails a footer-only reply with PA_INVALID_OUTPUT and stores no bubble', async () => {
    const { agent, conversation } = companion();
    execute.mockResolvedValueOnce(reply('<turn_meta>\nmood: 开心\n</turn_meta>'));
    const task = chat(conversation.id);
    await waitFor(task.id, 'failed');
    expect(core.store.events(task.id).filter((event) => event.kind === 'task.interrupted').at(-1)?.data)
      .toMatchObject({ code: 'PA_INVALID_OUTPUT' });
    expect(messagesOf(conversation.id).filter((message) => message.senderId === agent.id)).toHaveLength(0);
  });

  it('audits a chat dispatch with the flat prompt digest and a digest of the redacted wire', async () => {
    const { conversation } = companion();
    const task = chat(conversation.id, '晚安 password: hunter2hunter2');
    await waitFor(task.id, 'completed');
    const [, prompt, , , limits] = execute.mock.calls[0]!;
    const wire = limits?.chat;
    expect(wire).toMatchObject({ system: expect.any(String), messages: expect.any(Array), transcript: expect.any(String), stop: expect.any(Array) });
    const dispatched = core.store.events(task.id).find((event) => event.kind === 'gateway.model_dispatched')?.data as Record<string, unknown>;
    expect(dispatched.requestDigest).toBe(paDigest(prompt));
    expect(dispatched.chatDigest).toBe(paDigest(JSON.stringify(wire)));
    expect(`${prompt}${JSON.stringify(wire)}`).not.toContain('hunter2hunter2');
  });

  it('chooses the Claude system-prompt wire only when every condition holds', () => {
    const wire: PaChatWire = { system: '你是小月。', messages: [], transcript: '', stop: [] };
    expect(paClaudeStructured(wire, 'darwin', true)).toBe(true);
    expect(paClaudeStructured(undefined, 'darwin', true)).toBe(false);
    expect(paClaudeStructured(wire, 'darwin', false)).toBe(false);
    expect(paClaudeStructured(wire, 'win32', true)).toBe(false);
    expect(paClaudeStructured({ ...wire, system: 'x'.repeat(100_000) }, 'linux', true)).toBe(true);
    expect(paClaudeStructured({ ...wire, system: 'x'.repeat(100_001) }, 'linux', true)).toBe(false);
  });

  it('hides chat turns from feed, activity, devices and the finished snapshot while work keeps its behaviour', async () => {
    const { agent, conversation } = companion();
    const turn = chat(conversation.id, '今天下雨了');
    await waitFor(turn.id, 'completed');
    const job = work(conversation.id, '整理一份雨天出行清单');
    await waitFor(job.id, 'completed');
    const [, workPrompt, , , workLimits] = execute.mock.calls[1]!;
    expect(workPrompt).toContain('Task goal');
    expect(workLimits?.chat).toBeUndefined();
    expect(core.store.require<PaTask>('tasks', job.id).evidence).toContain('成员回答已持久保存；未执行外部操作');
    expect(core.store.require<PaTask>('tasks', turn.id).evidence).toContain('对话回复已保存');
    const snapshot = core.snapshot();
    expect(snapshot.tasks.map((task) => task.id)).toEqual([job.id]);
    expect(snapshot.attempts.map((attempt) => attempt.taskId)).toEqual([job.id]);
    expect(snapshot.messages.filter((message) => message.taskId === turn.id).map((message) => message.senderId)).toEqual(['owner', agent.id]);
    const base = await listen();
    const feed = await getJson<{ items: PaFeedItem[]; nextBefore: number | null }>(`${base}/api/pa/feed`);
    expect(feed.items.some((item) => item.taskId === job.id)).toBe(true);
    expect(feed.items.some((item) => item.taskId === turn.id)).toBe(false);
    // 2100 chat events newer than the work events: the scan runs out, but the cursor keeps older work reachable.
    core.store.transaction(() => {
      for (let index = 0; index < 2100; index += 1) core.store.event(turn.id, 'task.accepted', {});
    });
    let page = await getJson<{ items: PaFeedItem[]; nextBefore: number | null }>(`${base}/api/pa/feed`);
    expect(page.items).toHaveLength(0);
    expect(page.nextBefore).not.toBeNull();
    page = await getJson<{ items: PaFeedItem[]; nextBefore: number | null }>(`${base}/api/pa/feed?before=${page.nextBefore}`);
    expect(page.items.some((item) => item.taskId === job.id)).toBe(true);
    expect(page.nextBefore).toBeNull();
    await core.setControl({ paused: true });
    const pending = chat(conversation.id, '还在吗');
    expect(status(pending.id)).toBe('queued');
    expect(await getJson(`${base}/api/pa/activity`)).toEqual({ running: 0, waiting: 0 });
    const device = await getJson<{ tasks: Array<{ id: string }> }>(`${base}/api/pa/device`);
    expect(device.tasks.map((task) => task.id)).toEqual([job.id]);
    const full = await getJson<{ tag: string; tasks: PaTask[] }>(`${base}/api/pa`);
    expect(full.tag).toBe(core.snapshotTag());
    expect(full.tasks.map((task) => task.id)).toEqual([job.id, pending.id]);
    expect(await getJson(`${base}/api/pa?since=${encodeURIComponent(full.tag)}`)).toEqual({ unchanged: true, tag: full.tag });
  });

  it('lets a work task in a companion chat read the replies already shown there', async () => {
    const { agent, conversation } = companion();
    // Pinned, so the work turn reads it whatever it asks; an unpinned memory is read only when relevant.
    const memory = core.saveMemory({ content: '喜欢雨天散步', source: 'owner', scope: 'agent', scopeId: agent.id, pinned: true });
    execute.mockResolvedValueOnce(reply('CHAT_REPLY_SENTINEL 那下雨的时候我们一起出去走走。'));
    const turn = chat(conversation.id, '雨天散步怎么样');
    await waitFor(turn.id, 'completed');
    const answer = messagesOf(conversation.id).find((message) => message.senderId === agent.id)!;
    expect(answer.memoryRefs?.map((ref) => ref.id)).toContain(memory.id);
    core.saveMemory({ content: '喜欢晴天散步', source: 'owner', scope: 'agent', scopeId: agent.id }, memory.id, memory.revision);
    execute.mockResolvedValueOnce(reply('WORK_REPLY_SENTINEL 清单：伞、雨靴。'));
    const job = work(conversation.id, '整理一份雨天出行清单');
    await waitFor(job.id, 'completed');
    const [, workPrompt] = execute.mock.calls[1]!;
    expect(workPrompt).toContain('雨天散步怎么样');
    expect(workPrompt).toContain('CHAT_REPLY_SENTINEL');
    // The reply's stale memory ref is not copied into the work attempt, so the work commit is not refused.
    expect(core.memoryRefsCurrent(core.store.listTaskAttempts<PaAttempt>(job.id)[0]?.memoryRefs)).toBe(true);
    // A work reply keeps its memory gate after hide and unhide give it a soul.
    const workReply = messagesOf(conversation.id).find((message) => message.content.includes('WORK_REPLY_SENTINEL'))!;
    expect(workReply.memoryRefs?.map((ref) => ref.id)).toContain(memory.id);
    const current = core.memories().find((item) => item.id === memory.id)!;
    core.saveMemory({ content: '喜欢阴天散步', source: 'owner', scope: 'agent', scopeId: agent.id }, memory.id, current.revision);
    core.soul.editMessage(workReply.id, { hidden: true }, workReply.revision);
    core.soul.editMessage(workReply.id, { hidden: false }, core.store.require<PaMessage>('messages', workReply.id).revision);
    const again = work(conversation.id, '再整理一份出行清单');
    await waitFor(again.id, 'completed');
    // The reply is gone from the conversation history the model reads. The bot's own record of that task is a
    // separate memory: the corrected memory was only pinned, not recalled for it, so the record is still recalled.
    const lastPrompt = execute.mock.calls.at(-1)![1] as string;
    expect(lastPrompt.replace(/<memory>[\s\S]*?<\/memory>/g, '')).not.toContain('WORK_REPLY_SENTINEL');
    expect(lastPrompt).toContain('<memory>');
  });

  it('fails a paused chat turn at once when a newer message overtook it before resume', async () => {
    const { agent, conversation } = companion();
    hold();
    const first = chat(conversation.id, '第一句');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await core.setControl({ paused: true });
    expect(core.store.require<PaTask>('tasks', first.id)).toMatchObject({ status: 'waiting', waitKind: 'paused' });
    const second = chat(conversation.id, '第二句');
    expect(second.id).not.toBe(first.id);
    await core.setControl({ paused: false });
    expect(core.store.require<PaTask>('tasks', first.id)).toMatchObject({ status: 'failed', error: '后面已经有新消息了，请重新发送' });
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(held[1]!.prompt).toContain('第二句');
    held[1]!.resolve(reply('我在，慢慢说。'));
    await waitFor(second.id, 'completed');
    expect(status(first.id)).toBe('failed');
    expect(messagesOf(conversation.id).filter((message) => message.senderId === agent.id).map((message) => message.content))
      .toEqual(['我在，慢慢说。']);
  });

  it('requeues a live chat reply on a graceful shutdown (R1) and answers it after restart', async () => {
    const { agent, conversation } = companion();
    hold();
    const task = chat(conversation.id, '还在吗');
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await core.shutdown();
    expect(core.store.require<PaTask>('tasks', task.id)).toMatchObject({ status: 'queued', stopConfirmation: 'confirmed' });
    expect(core.store.listTaskAttempts<PaAttempt>(task.id).map((attempt) => attempt.status)).toEqual(['failed']);
    expect(messagesOf(conversation.id).some((message) => message.senderId === agent.id)).toBe(false);
    core = construct();
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1]!.resolve(reply('在的。'));
    await waitFor(task.id, 'completed');
    expect(messagesOf(conversation.id).filter((message) => message.senderId === agent.id).map((message) => message.content)).toEqual(['在的。']);
  });

  it('lets 重试 run a timed-out or attempt-exhausted chat turn again', async () => {
    const { agent, conversation } = companion();
    execute.mockRejectedValueOnce(new PaError('模型不可用', 503, 'PA_MODEL_UNAVAILABLE'));
    const task = chat(conversation.id, '在吗');
    await waitFor(task.id, 'failed');
    // As if the turn had used its whole time and every attempt.
    const attempts = core.store.listTaskAttempts<PaAttempt>(task.id);
    core.store.update<PaAttempt>('attempts', attempts[0]!.id, { durationMs: 10 * 60_000, error: '回复超时了，可以重试' });
    core.store.update<PaTask>('tasks', task.id, { budget: { maxAttempts: 1, timeoutMs: 120_000 } });
    core.resume(task.id);
    await waitFor(task.id, 'completed');
    expect(core.store.require<PaTask>('tasks', task.id).budget).toEqual({ maxAttempts: 4, timeoutMs: 10 * 60_000 + 120_000 });
    expect(messagesOf(conversation.id).some((message) => message.senderId === agent.id)).toBe(true);
  });

  it('speaks first on a reachout routine, survives a failed turn and stops at two proactive replies a day', async () => {
    const { agent, conversation } = companion();
    const routine = reachout(conversation.id);
    execute.mockRejectedValueOnce(new PaError('模型不可用', 503, 'PA_MODEL_UNAVAILABLE'));
    const broken = runReachout(routine.id);
    await waitFor(broken.id, 'failed');
    const first = runReachout(routine.id);
    expect(first).toMatchObject({ kind: 'chat', goal: '先开口', routineId: routine.id, soul: { directive: 'reachout', hiddenOwner: true } });
    await waitFor(first.id, 'completed');
    expect(execute.mock.calls.at(-1)![1]).toContain('REACHOUT_NOTE');
    const second = runReachout(routine.id);
    await waitFor(second.id, 'completed');
    expect(messagesOf(conversation.id).some((message) => message.senderId === 'owner')).toBe(false);
    expect(messagesOf(conversation.id).filter((message) => message.senderId === agent.id).map((message) => message.soul?.proactive))
      .toEqual([true, true]);
    const calls = execute.mock.calls.length;
    expect(() => runReachout(routine.id)).toThrow(expect.objectContaining({ status: 409, message: '今天已经主动开口两次了' }));
    core.tickRoutines(routineOf(routine.id).nextRunAt!);
    expect(routineOf(routine.id)).toMatchObject({ lastError: '今天已经主动开口两次了', lastTaskId: second.id });
    expect(execute.mock.calls.length).toBe(calls);
    expect(core.store.list<PaTask>('tasks').filter((task) => task.routineId === routine.id)).toHaveLength(3);
  });

  it('holds a reachout in quiet hours, outside chat mode, after three unanswered ones and for a day after a crisis turn', async () => {
    const { agent, conversation } = companion();
    const night = reachout(conversation.id, zoneAt(2));
    core.tickRoutines(night.nextRunAt!);
    expect(routineOf(night.id).lastError).toBe('现在是安静时段，先开口已跳过');
    const workConversation = core.snapshot().conversations.find((item) => item.agentId === fantay().id)!;
    expect(() => runReachout(reachout(workConversation.id).id))
      .toThrow(expect.objectContaining({ status: 409, message: '这个对话不在聊天模式，先开口已跳过' }));
    for (const days of [3, 2, 1])
      core.store.create<PaMessage>('messages', {
        conversationId: conversation.id, taskId: null, senderId: agent.id, content: `早安 ${days}`,
        targetAgentIds: [], replyTo: null, soul: { kind: 'chat', proactive: true, at: Date.now() - days * DAY },
      });
    const day = reachout(conversation.id);
    expect(() => runReachout(day.id)).toThrow(expect.objectContaining({ message: '最近三次先开口都还没有回应，先开口已暂停' }));
    const turn = chat(conversation.id, '我不想活了');
    await waitFor(turn.id, 'completed');
    core.tickRoutines(routineOf(day.id).nextRunAt!);
    expect(routineOf(day.id).lastError).toBe('最近的对话需要先照顾好情绪，先开口已暂停');
    expect(core.store.list<PaTask>('tasks').filter((task) => task.routineId)).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(1);
    core.store.update<PaChatState>('chat_state', conversation.id, { careAt: Date.now() - DAY - 60000 });
    const fired = runReachout(day.id);
    await waitFor(fired.id, 'completed');
    expect(messagesOf(conversation.id).find((message) => message.taskId === fired.id)?.soul?.proactive).toBe(true);
  });
});
