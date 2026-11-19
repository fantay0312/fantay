import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  paTaskInputSchema,
  type PaCharacterView,
  type PaChatState,
  type PaChatWire,
  type PaConversation,
  type PaEntity,
  type PaFeedItem,
  type PaMemoryCandidate,
  type PaMessage,
  type PaSnapshot,
  type PaSoulTrace,
  type PaSoulTraceLore,
  type PaTask,
  type PersonalAgent,
} from '@open-design/contracts';
import { PA_PLACEHOLDER_PNG, chatStateSlots, foldChatState, messageAt, stateRecord } from '@open-design/contracts/soul';
import { closeDatabase, openDatabase, type SqliteDb } from '../src/db.js';
import { registerPersonalAgentRoutes } from '../src/routes/personal-agent.js';
import type { PaModelResult, PaModelRuntime } from '../src/runtimes/personal-agent.js';
import { createPaKernel } from '../src/services/pa/kernel.js';
import type { PersonalAgentChannels } from '../src/services/personal-agent-channels.js';
import { paDigest } from '../src/services/personal-agent-gateway.js';
import { PersonalAgentService } from '../src/services/personal-agent-service.js';
import { paLoreRegexBudget, paLoreRegexTest } from '../src/services/personal-agent-soul-regex.js';
import { PaError } from '../src/storage/personal-agent-store.js';

let root: string, db: SqliteDb, core: PersonalAgentService, server: http.Server | null = null;
let rngValue = 0.42;
let replies: Array<string | PaModelResult> = [];
let calls: Array<{ prompt: string; chat: PaChatWire | undefined }> = [];
let gate: Promise<void> | null = null;
let release: () => void = () => {};
const execute = vi.fn<PaModelRuntime['execute']>();
const result = (text: string): PaModelResult => ({ text, usage: { visibility: 'unknown' } });
const construct = () => new PersonalAgentService({
  db, dataDir: root, projectsDir: join(root, 'projects'), runtime: { models: async () => [], execute }, rng: () => rngValue,
});

const TERMINAL = ['completed', 'failed', 'cancelled', 'waiting'];
const TRUST = [{ key: 'trust', kind: 'number', label: '信任', initial: 0, min: 0, max: 10 }];
const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '林雾',
    description: '{{char}} 是海港灯塔的守灯人，话不多。',
    personality: '安静，记性好',
    scenario: '雨夜的灯塔',
    first_mes: '你来了，{{user}}。灯刚点上。',
    mes_example: '',
    creator_notes: '测试用角色卡',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['又是雨天。'],
    tags: ['灯塔', '治愈'],
    creator: 'tester',
    character_version: '1.0',
    extensions: { talkativeness: 0.6, fixture_tool: { mode: 'kept' } },
    character_book: {
      name: '灯塔',
      entries: [{ keys: ['灯塔'], content: '灯塔建于一百年前。', enabled: true, insertion_order: 10, extensions: {} }],
    },
  },
};

/** Holds the next model calls until `release()` is called. */
function holdNext(): void {
  gate = new Promise<void>((resolve) => {
    release = () => { gate = null; resolve(); };
  });
}
function refused(fn: () => unknown): { status: number; code: string } {
  try {
    fn();
  } catch (error) {
    if (error instanceof PaError) return { status: error.status, code: error.code };
    throw error;
  }
  throw new Error('expected a PaError');
}
const agentOf = (name: string): PersonalAgent => core.createAgent({
  name, role: `${name}的角色`, avatar: '', enabled: true, tools: ['respond'], model: { runtime: 'claude', modelId: 'sonnet' },
});
function companion(name = '小月', card: Record<string, unknown> = {}): { agent: PersonalAgent; conversation: PaConversation } {
  const agent = agentOf(name);
  core.soul.saveCharacter(agent.id, { description: `${name}住在窗边工作室。`, ...card });
  return { agent, conversation: core.createConversation(agent.id) };
}
const chat = (conversationId: string, goal: string, extra: Record<string, unknown> = {}) =>
  core.submit(paTaskInputSchema.parse({ requestId: randomUUID(), conversationId, goal, kind: 'chat', ...extra }));
const work = (conversationId: string, goal: string) =>
  core.submit(paTaskInputSchema.parse({ requestId: randomUUID(), conversationId, goal }));
const status = (id: string) => core.store.require<PaTask>('tasks', id).status;
async function settled(id: string): Promise<PaTask> {
  await vi.waitFor(() => expect(TERMINAL).toContain(status(id)));
  return core.store.require<PaTask>('tasks', id);
}
async function turn(conversationId: string, goal: string, reply?: string | PaModelResult): Promise<PaTask> {
  if (reply !== undefined) replies.push(reply);
  const done = await settled(chat(conversationId, goal).id);
  expect(done.status, done.error ?? '').toBe('completed');
  return done;
}
const messagesOf = (conversationId: string) => core.store.listConversationMessages<PaMessage>(conversationId);
const lastFrom = (conversationId: string, senderId: string) =>
  messagesOf(conversationId).filter((message) => message.senderId === senderId).at(-1)!;
const message = (id: string) => core.store.require<PaMessage>('messages', id);
const setChat = (conversationId: string, patch: Record<string, unknown>) => {
  const view = core.soul.chatView(conversationId);
  return core.soul.saveChat(conversationId, patch, view.revision || undefined);
};
const fantay = () => core.store.list<PersonalAgent>('agents').find((agent) => agent.avatar === 'fantay')!;

async function listen(service: PersonalAgentService = core): Promise<string> {
  const app = express();
  app.use('/api/pa/soul', express.json({ limit: '24mb' }));
  app.use(express.json());
  registerPersonalAgentRoutes(app, {
    personalAgent: service,
    personalAgentChannels: { pendingApprovalCount: () => 0 } as unknown as PersonalAgentChannels,
  });
  const started = await new Promise<http.Server>((resolve) => {
    const listening: http.Server = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  server = started;
  return `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
}
const send = (url: string, method: string, body?: unknown) => fetch(url, {
  method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pa-soul-'));
  db = openDatabase(root, { dataDir: root });
  rngValue = 0.42;
  replies = [];
  calls = [];
  gate = null;
  execute.mockReset().mockImplementation(async (_model, prompt, _runId, _signal, limits) => {
    calls.push({ prompt, chat: limits?.chat });
    if (gate) await gate;
    const next = replies.shift() ?? '嗯，我在。';
    return typeof next === 'string' ? result(next) : next;
  });
  core = construct();
});
afterEach(async () => {
  release();
  if (server) {
    const closing = server;
    server = null;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  await core.shutdown();
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

describe('PA soul service', () => {
  it('imports a V2 card with its world book and greeting, and refuses a card for Fantay', () => {
    const before = core.snapshot().soulVersion;
    const imported = core.soul.importCard({ card: V2_CARD, fileName: 'lighthouse.json' });
    expect(imported.agent.name).toBe('林雾');
    expect(imported.character.autoMemory).toBe(false);
    expect(imported.character.origin?.format).toBe('ccv2');
    expect(imported.lorebook?.entryCount).toBe(1);
    expect(imported.character.lorebookIds).toEqual([imported.lorebook!.id]);
    expect(imported.character.preservedKeys.length).toBeGreaterThan(0);
    const greeting = messagesOf(imported.conversation.id);
    expect(greeting).toHaveLength(1);
    expect(greeting[0]!.soul).toMatchObject({ kind: 'greeting', greetingIndex: 0 });
    expect(greeting[0]!.content).toBe('你来了，你。灯刚点上。');
    expect(core.soul.modeOf(imported.conversation)).toBe('companion');
    expect(core.snapshot().soulVersion).not.toBe(before);
    expect(refused(() => core.soul.saveCharacter(fantay().id, { description: 'x' }))).toEqual({ status: 409, code: 'PA_SOUL_FANTAY' });
    expect(refused(() => core.soul.importCard({ card: V2_CARD, agentId: fantay().id }))).toEqual({ status: 409, code: 'PA_SOUL_FANTAY' });
    expect(refused(() => core.soul.importCard({ card: { spec: 'chara_card_v2' } })).status).toBe(422);
  });

  it('overwrites the card of an existing character on import and keeps the agent bindings', () => {
    const imported = core.soul.importCard({ card: V2_CARD, fileName: 'lighthouse.json' });
    const agentId = imported.agent.id;
    const cardBook = imported.lorebook!.id;
    const persona = core.soul.savePersona({ name: '阿树', description: '喜欢爬山的程序员' });
    const own = core.soul.saveLorebook({ name: '工作室', entries: [{ id: 'lamp', keys: ['台灯'], content: '台灯是外婆留下的旧物。' }] });
    const bound = core.soul.saveCharacter(agentId, { personaId: persona.id, lorebookIds: [cardBook, own.id], autoMemory: true },
      imported.character.revision);
    const agents = core.store.list<PersonalAgent>('agents').length;
    const books = core.store.list('lorebooks').length;
    const updated = { ...V2_CARD, data: { ...V2_CARD.data, description: '{{char}} 搬去了山顶的气象站。', tags: ['气象站'],
      character_book: { name: '气象站', entries: [{ keys: ['气象站'], content: '气象站在山顶。', enabled: true, insertion_order: 10, extensions: {} }] } } };
    expect(refused(() => core.soul.importCard({ card: updated, agentId, revision: bound.revision - 1 })))
      .toEqual({ status: 409, code: 'PA_REVISION_CONFLICT' });
    expect(core.store.list('lorebooks')).toHaveLength(books);
    const replaced = core.soul.importCard({ card: updated, fileName: 'station.json', agentId, revision: bound.revision });
    expect(replaced.agent.id).toBe(agentId);
    expect(core.store.list<PersonalAgent>('agents')).toHaveLength(agents);
    expect(replaced.character.description).toContain('气象站');
    expect(replaced.character).toMatchObject({ tags: ['气象站'], personaId: persona.id, autoMemory: true, origin: { format: 'ccv2', name: 'station.json' } });
    expect(replaced.character.lorebookIds).toEqual([own.id, replaced.lorebook!.id]);
    expect(core.soul.lorebook(cardBook).id).toBe(cardBook);
    expect(replaced.conversation.id).toBe(imported.conversation.id);
    expect(messagesOf(imported.conversation.id)).toHaveLength(1);
    expect(core.soul.modeOf(replaced.conversation)).toBe('companion');
  });

  it('installs starters idempotently and builds a room with its opening', () => {
    const first = core.soul.installStarter('xiaoyue');
    const second = core.soul.installStarter('xiaoyue');
    expect(second.agents[0]!.id).toBe(first.agents[0]!.id);
    expect(second.conversation.id).toBe(first.conversation.id);
    const greeting = messagesOf(first.conversation.id)[0]!;
    expect(greeting.soul?.kind).toBe('greeting');
    expect(greeting.soul?.choices?.length).toBeGreaterThan(0);
    const room = core.soul.installStarter('tea-room');
    expect(room.agents).toHaveLength(2);
    expect(room.group?.memberIds).toContain(first.agents[0]!.id);
    const opening = messagesOf(room.conversation.id);
    expect(opening).toHaveLength(1);
    expect(opening[0]!.senderId).toBe(first.agents[0]!.id);
    expect(opening[0]!.soul).toMatchObject({ kind: 'greeting' });
    expect(core.soul.modeOf(room.conversation)).toBe('companion');
    expect(core.soul.chatView(room.conversation.id).scenario).toContain('窗边工作室');
    expect(core.soul.installStarter('tea-room').group?.id).toBe(room.group?.id);
    expect(refused(() => core.soul.installStarter('nobody')).status).toBe(404);
  });

  it('stores a parsed chat reply and sends a character prompt without task framing', async () => {
    const preset = core.soul.savePreset({ name: '测试文风', suggestChoices: true });
    core.soul.savePersona({ name: '阿树', description: '喜欢爬山的程序员' });
    const book = core.soul.saveLorebook({ name: '工作室', entries: [{ id: 'lamp', keys: ['台灯'], content: '台灯是外婆留下的旧物。' }] });
    const { agent, conversation } = companion('小月', { stateSchema: TRUST, presetId: preset.id, lorebookIds: [book.id] });
    await turn(conversation.id, '你的台灯好看', '*放下笔* 你来啦，台灯刚修好。\n\n<turn_meta>\nmood: 开心\ntrust: +2\nchoices: 聊聊台灯 | 去喝茶\n</turn_meta>');
    const reply = lastFrom(conversation.id, agent.id);
    expect(reply.content).toBe('*放下笔* 你来啦，台灯刚修好。');
    expect(reply.soul).toMatchObject({
      kind: 'chat', footer: 'ok', mood: '开心',
      stateOps: [{ key: 'trust', op: 'delta', value: 2 }], choices: ['聊聊台灯', '去喝茶'],
    });
    const prompt = calls[0]!.prompt;
    for (const text of ['小月住在窗边工作室', '喜欢爬山的程序员', '台灯是外婆留下的旧物', '阿树', '小月']) expect(prompt).toContain(text);
    expect(prompt).not.toContain('Task goal');
    expect(prompt).not.toContain('Completion criteria');
    const long = '长'.repeat(9000);
    await turn(conversation.id, '说长一点', long);
    expect(lastFrom(conversation.id, agent.id).content).toBe(long);
    setChat(conversation.id, { turnRecord: 'off' });
    await turn(conversation.id, '再说一句');
    expect(calls.at(-1)!.chat!.system).not.toContain('turn_meta');
    expect(calls[0]!.chat!.system).toContain('turn_meta');
  });

  it('passes a structured wire whose system text is stable across turns', async () => {
    const { conversation } = companion();
    await turn(conversation.id, '早上好');
    await turn(conversation.id, '今天下雨了');
    const [first, second] = calls;
    for (const call of [first!, second!]) {
      expect(call.chat).toBeDefined();
      expect(call.chat!.messages.length).toBeGreaterThan(0);
      expect(typeof call.chat!.transcript).toBe('string');
      expect(Array.isArray(call.chat!.stop)).toBe(true);
    }
    expect(second!.chat!.system).toBe(first!.chat!.system);
    expect(second!.chat!.messages.at(-1)!.content).toContain('今天下雨了');
  });

  it('merges partial saves, requires revisions and keeps chat settings writable while a reply lands', async () => {
    const base = await listen();
    const imported = core.soul.importCard({ card: V2_CARD });
    const url = `${base}/api/pa/soul/characters/${imported.agent.id}`;
    const missing = await send(url, 'PUT', { nickname: '阿雾' });
    expect(missing.status).toBe(409);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe('PA_REVISION_CONFLICT');
    const saved = await send(url, 'PUT', { nickname: '阿雾', revision: imported.character.revision });
    expect(saved.status).toBe(200);
    const view = await saved.json() as PaCharacterView;
    expect(view.nickname).toBe('阿雾');
    expect(view.tags).toEqual(imported.character.tags);
    expect(view.lorebookIds).toEqual(imported.character.lorebookIds);
    expect(view.preservedKeys).toEqual(imported.character.preservedKeys);
    expect(view.description).toBe(imported.character.description);
    expect((await send(url, 'PUT', { nickname: 'x', revision: imported.character.revision })).status).toBe(409);
    const conversationId = imported.conversation.id;
    const before = core.soul.chatView(conversationId);
    expect(before.revision).toBeGreaterThan(0);
    holdNext();
    const task = chat(conversationId, '在吗');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    expect((await settled(task.id)).status).toBe('completed');
    const put = await send(`${base}/api/pa/soul/chats/${conversationId}`, 'PUT', { scenario: '雨停了', revision: before.revision });
    expect(put.status).toBe(200);
    expect((await put.json() as { scenario: string }).scenario).toBe('雨停了');
  });

  it('stores and serves portrait assets with strict ids and types', async () => {
    const base = await listen();
    const data = Buffer.from(PA_PLACEHOLDER_PNG).toString('base64');
    const created = await send(`${base}/api/pa/soul/assets`, 'POST', { mime: 'image/png', data });
    expect(created.status).toBe(200);
    const { id } = await created.json() as { id: string };
    expect(id).toMatch(/\.png$/);
    const served = await fetch(`${base}/api/pa/soul/assets/${id}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PA_PLACEHOLDER_PNG);
    const traversal = await fetch(`${base}/api/pa/soul/assets/..%2Fsecret.png`);
    expect(traversal.status).toBe(400);
    expect((await traversal.json() as { error: { code: string } }).error.code).toBe('PA_SOUL_ASSET');
    const mismatched = await send(`${base}/api/pa/soul/assets`, 'POST', { mime: 'image/jpeg', data });
    expect(mismatched.status).toBe(400);
  });

  it('serves stage 1 rows with the stage 2 defaults and round-trips sprites', () => {
    const { agent, conversation } = companion();
    setChat(conversation.id, { scenario: '雨夜' });
    // Rewrite both rows the way stage 1 stored them: no sprites, no voice, no voiceReplies.
    const rewrite = (collection: 'characters' | 'chat_settings', id: string, drop: string[]) => {
      const { id: _id, createdAt: _c, updatedAt: _u, revision: _r, ...rest } = core.store.require<PaEntity & Record<string, unknown>>(collection, id);
      for (const key of drop) delete rest[key];
      core.store.remove(collection, id);
      core.store.create<PaEntity>(collection, rest, id);
    };
    rewrite('characters', agent.id, ['sprites', 'voice']);
    rewrite('chat_settings', conversation.id, ['voiceReplies']);
    expect(core.store.require<PaEntity>('characters', agent.id)).not.toHaveProperty('sprites');
    const view = core.soul.character(agent.id)!;
    expect(view).toMatchObject({ sprites: {}, voice: null });
    expect(core.soul.snapshot().characters.find((item) => item.id === agent.id)).toMatchObject({ sprites: {}, voice: null });
    expect(core.soul.chatView(conversation.id).voiceReplies).toBe('manual');
    expect(core.soul.snapshot().chats.find((item) => item.id === conversation.id)?.voiceReplies).toBe('manual');
    const missing = `${randomUUID()}.png`;
    expect(refused(() => core.soul.saveCharacter(agent.id, { sprites: { happy: missing } }, view.revision)))
      .toEqual({ status: 400, code: 'PA_INVALID_REQUEST' });
    const data = Buffer.from(PA_PLACEHOLDER_PNG).toString('base64');
    const happy = core.soul.saveAsset({ mime: 'image/png', data }).id;
    const sad = core.soul.saveAsset({ mime: 'image/png', data }).id;
    const saved = core.soul.saveCharacter(agent.id, { sprites: { happy, sad }, voice: { model: 'minimax-tts' } }, view.revision);
    expect(saved.sprites).toEqual({ happy, sad });
    expect(saved.voice).toEqual({ model: 'minimax-tts', voice: '', language: '' });
    expect(core.soul.character(agent.id)!.sprites).toEqual({ happy, sad });
    expect(() => core.soul.saveCharacter(agent.id, { sprites: { joyful: happy } }, saved.revision)).toThrow();
  });

  it('stores sprites an import brings and keeps sprites and voice on an overwrite without them', async () => {
    const base = await listen();
    const data = Buffer.from(PA_PLACEHOLDER_PNG).toString('base64');
    const happy = core.soul.saveAsset({ mime: 'image/png', data }).id;
    const shy = core.soul.saveAsset({ mime: 'image/png', data }).id;
    expect(refused(() => core.soul.importCard({ card: V2_CARD, sprites: { joyful: happy } as Record<string, string> })))
      .toEqual({ status: 400, code: 'PA_INVALID_REQUEST' });
    expect(refused(() => core.soul.importCard({ card: V2_CARD, sprites: { happy: `${randomUUID()}.png` } })))
      .toEqual({ status: 400, code: 'PA_INVALID_REQUEST' });
    const agents = core.store.list<PersonalAgent>('agents').length;
    const response = await send(`${base}/api/pa/soul/characters/import`, 'POST', { card: V2_CARD, sprites: { happy, shy } });
    expect(response.status).toBe(200);
    const imported = await response.json() as { agent: PersonalAgent; character: PaCharacterView };
    expect(core.store.list<PersonalAgent>('agents')).toHaveLength(agents + 1);
    expect(imported.character.sprites).toEqual({ happy, shy });
    expect(imported.character.voice).toBeNull();
    const badKey = await send(`${base}/api/pa/soul/characters/import`, 'POST', { card: V2_CARD, sprites: { joyful: happy } });
    expect(badKey.status).toBe(400);
    const agentId = imported.agent.id;
    const voiced = core.soul.saveCharacter(agentId, { voice: { model: 'minimax-tts', voice: 'female-shaonv', language: 'zh' } },
      imported.character.revision);
    const kept = core.soul.importCard({ card: V2_CARD, agentId, revision: voiced.revision });
    expect(kept.character.sprites).toEqual({ happy, shy });
    expect(kept.character.voice).toEqual({ model: 'minimax-tts', voice: 'female-shaonv', language: 'zh' });
    const replaced = core.soul.importCard({ card: V2_CARD, agentId, sprites: { sad: shy } });
    expect(replaced.character.sprites).toEqual({ sad: shy });
    expect(replaced.character.voice).toEqual(kept.character.voice);
  });

  it('keeps existing task conversations in work mode when an agent gets its first card', async () => {
    const agent = agentOf('老周');
    const old = core.createConversation(agent.id);
    expect((await settled(work(old.id, 'Draft the brief').id)).status).toBe('completed');
    core.soul.saveCharacter(agent.id, { description: '老周是钟楼旧档室的管理员。' });
    expect(core.soul.chatView(old.id).mode).toBe('work');
    expect(core.soul.modeOf(old)).toBe('work');
    expect(core.soul.modeOf(core.createConversation(agent.id))).toBe('companion');
  });

  it('keeps a companion chat in companion mode when its card is removed and added again', async () => {
    const { agent, conversation } = companion('小周');
    await turn(conversation.id, '你好');
    core.soul.removeCharacter(agent.id, core.soul.character(agent.id)!.revision, false);
    core.soul.saveCharacter(agent.id, { description: '小周回来了。' });
    expect(core.soul.modeOf(core.store.require<PaConversation>('conversations', conversation.id))).toBe('companion');
  });

  it('regenerates into a selected variant, folds the selected variant and promotes it when the root is deleted', async () => {
    const { agent, conversation } = companion('小月', { stateSchema: TRUST, firstMessage: '你好呀' });
    const schema = core.soul.character(agent.id)!.stateSchema;
    const fold = () => stateRecord(foldChatState(schema, chatStateSlots(messagesOf(conversation.id)),
      core.soul.chatView(conversation.id).userStateOps));
    const greeting = messagesOf(conversation.id)[0]!;
    expect(refused(() => core.soul.regenerate(conversation.id, greeting.id, randomUUID()))).toEqual({ status: 409, code: 'PA_SOUL_VARIANT' });
    await turn(conversation.id, '第一句', '好的。\n\n<turn_meta>\ntrust: +2\n</turn_meta>');
    const root = lastFrom(conversation.id, agent.id);
    core.soul.applyStateOps(conversation.id, [{ key: 'trust', op: 'delta', value: 1 }]);
    replies.push('换个说法。\n\n<turn_meta>\ntrust: +5\n</turn_meta>');
    expect((await settled(core.soul.regenerate(conversation.id, root.id, randomUUID()).id)).status).toBe('completed');
    const variant = lastFrom(conversation.id, agent.id);
    expect(variant.soul?.variantOf).toBe(root.id);
    expect(message(root.id).soul?.activeVariant).toBe(variant.id);
    expect(fold()).toEqual({ trust: 6 });
    expect(core.soul.deleteMessage(root.id, message(root.id).revision, false).ok).toBe(true);
    expect(message(variant.id).soul?.variantOf).toBeUndefined();
    expect(core.soul.chatView(conversation.id).userStateOps[0]!.after).toBe(variant.id);
    expect(fold()).toEqual({ trust: 6 });
    await turn(conversation.id, '第二句');
    const newest = lastFrom(conversation.id, agent.id);
    expect(refused(() => core.soul.regenerate(conversation.id, variant.id, randomUUID()))).toEqual({ status: 409, code: 'PA_SOUL_VARIANT' });
    holdNext();
    const running = chat(conversation.id, '第三句');
    await vi.waitFor(() => expect(status(running.id)).toBe('running'));
    expect(refused(() => core.soul.regenerate(conversation.id, newest.id, randomUUID()))).toEqual({ status: 409, code: 'PA_SOUL_BUSY' });
    release();
    await settled(running.id);
  });

  it('switches a greeting from the card and refuses once the chat has started', async () => {
    const { agent, conversation } = companion('小月', {
      firstMessage: '早上好，{{user}}', alternateGreetings: ['晚上好，{{user}}'], openers: ['在吗'],
    });
    const greeting = messagesOf(conversation.id)[0]!;
    expect(greeting.content).toBe('早上好，你');
    expect(greeting.soul?.choices).toEqual(['在吗']);
    const switched = core.soul.selectVariant(greeting.id, { greetingIndex: 1 });
    expect(switched.content).toBe('晚上好，你');
    expect(switched.soul).toMatchObject({ greetingIndex: 1 });
    expect(switched.soul?.choices).toBeUndefined();
    await turn(conversation.id, '你好');
    expect(lastFrom(conversation.id, agent.id).soul?.kind).toBe('chat');
    expect(refused(() => core.soul.selectVariant(greeting.id, { greetingIndex: 0 }))).toEqual({ status: 409, code: 'PA_SOUL_VARIANT' });
  });

  it('applies edits, hiding and deletion to later prompts, work prompts included, and forgets only on request', async () => {
    const { agent, conversation } = companion();
    await turn(conversation.id, '第一句：蓝色的伞', 'R1 的回答');
    const first = messagesOf(conversation.id).find((item) => item.content.includes('蓝色的伞'))!;
    const edited = core.soul.editMessage(first.id, { content: '第一句：红色的伞' }, first.revision);
    expect(edited.soul?.edited).toBe(true);
    const reply = lastFrom(conversation.id, agent.id);
    expect(core.soul.editMessage(reply.id, { hidden: true }, reply.revision).soul?.hidden).toBe(true);
    await turn(conversation.id, '第二句');
    expect(calls.at(-1)!.prompt).toContain('第一句：红色的伞');
    expect(calls.at(-1)!.prompt).not.toContain('蓝色的伞');
    expect(calls.at(-1)!.prompt).not.toContain('R1 的回答');
    expect((await settled(work(conversation.id, '整理一下我们聊过的内容').id)).status).toBe('completed');
    expect(calls.at(-1)!.prompt).toContain('Task goal');
    expect(calls.at(-1)!.prompt).not.toContain('R1 的回答');
    const kept = core.saveMemory({ content: '喜欢红色的伞', source: '测试', scope: 'agent', scopeId: agent.id, sourceMessageId: first.id });
    expect(core.soul.deleteMessage(first.id, message(first.id).revision, false).removedMemories).toBe(0);
    expect(core.memories().some((memory) => memory.id === kept.id)).toBe(true);
    await turn(conversation.id, '第三句');
    expect(calls.at(-1)!.prompt).not.toContain('第一句：红色的伞');
    const second = messagesOf(conversation.id).find((item) => item.content === '第二句')!;
    const sourced = core.saveMemory({ content: '第二句的记忆', source: '测试', scope: 'agent', scopeId: agent.id, sourceMessageId: second.id });
    expect(core.soul.deleteMessage(second.id, second.revision, true).removedMemories).toBe(1);
    // Forgetting puts the memory away: it is kept, archived, and no longer recalled.
    expect(core.memories().find((memory) => memory.id === sourced.id)).toMatchObject({ status: 'archived', content: '第二句的记忆' });
    expect(core.memories().find((memory) => memory.id === kept.id)!.status).toBe('active');
  });

  it('rolls and draws story items, responds once, stays idempotent and keeps a deck secret out of the message', async () => {
    const secret = '钥匙能打开地下室';
    const { conversation } = companion('小月', {
      decks: [{ id: 'fate', name: '命运', cards: [
        { title: '旧钥匙', text: '一把生锈的钥匙', secret }, { title: '新钥匙', text: '一把发亮的钥匙', secret },
      ] }],
    });
    const rolled = core.soul.roll(conversation.id, { notation: 'd20', dc: 10, respond: false, requestId: 'roll-request-1' });
    expect(rolled.task).toBeNull();
    expect(rolled.message.soul?.kind).toBe('roll');
    expect(rolled.message.content).toContain('d20');
    expect(execute).not.toHaveBeenCalled();
    const again = core.soul.roll(conversation.id, { notation: 'd20', dc: 10, respond: false, requestId: 'roll-request-1' });
    expect(again.message.id).toBe(rolled.message.id);
    expect(messagesOf(conversation.id).filter((item) => item.soul?.kind === 'roll')).toHaveLength(1);
    const drawn = core.soul.draw(conversation.id, { deckId: 'fate', requestId: 'draw-request-1' });
    expect(drawn.message.soul?.draw).toMatchObject({ deckId: 'fate', hasSecret: true });
    expect(drawn.message.soul?.draw?.secret).toBeUndefined();
    expect(drawn.message.content).not.toContain(secret);
    expect(drawn.task).not.toBeNull();
    expect((await settled(drawn.task!.id)).status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(calls[0]!.prompt).toContain(secret);
    // The respond turn is told to react to the draw, not just to carry on.
    expect(calls[0]!.prompt).toContain('先对这个结果作出反应');
    expect(calls[0]!.prompt).not.toContain('没有说话');
    expect(core.store.require<PaTask>('tasks', drawn.task!.id).soul).toMatchObject({ directive: 'react', directiveText: drawn.message.content });
    expect(core.soul.draw(conversation.id, { deckId: 'fate', requestId: 'draw-request-1' }).task?.id).toBe(drawn.task!.id);
    const revealed = core.soul.revealDraw(drawn.message.id);
    expect(revealed.soul?.draw?.secret).toBe(secret);
    expect(core.store.require<PaChatState>('chat_state', conversation.id).secrets).toEqual({});
  });

  it('runs an interlude for three turns with a director note and ends it automatically', async () => {
    const { agent, conversation } = companion();
    const drawn = core.soul.eventAction(conversation.id, { action: 'draw', requestId: 'event-draw-1' });
    expect(drawn.chat.candidateEvent).not.toBeNull();
    const accepted = core.soul.eventAction(conversation.id, { action: 'accept', respond: false, requestId: 'event-accept-1' });
    expect(accepted.message?.soul?.event?.phase).toBe('accepted');
    expect(accepted.chat.activeEvent?.remainingTurns).toBe(3);
    expect(accepted.chat.candidateEvent).toBeNull();
    await turn(conversation.id, '然后呢');
    expect(calls.at(-1)!.prompt).toContain('小插曲进行中');
    expect(core.soul.chatView(conversation.id).activeEvent?.remainingTurns).toBe(2);
    // A regenerate replaces the turn, so it does not count down the interlude.
    const answer = lastFrom(conversation.id, agent.id);
    for (const requestId of ['event-regen-1', 'event-regen-2'])
      expect((await settled(core.soul.regenerate(conversation.id, answer.id, requestId).id)).status).toBe('completed');
    expect(core.soul.chatView(conversation.id).activeEvent?.remainingTurns).toBe(2);
    await turn(conversation.id, '继续');
    await turn(conversation.id, '最后');
    expect(core.soul.chatView(conversation.id).activeEvent).toBeNull();
    const ended = messagesOf(conversation.id).at(-1)!;
    expect(ended.soul?.kind).toBe('event');
    expect(ended.soul?.event?.phase).toBe('ended');
  });

  it('branches selected messages with their time, origin, user state ops and settings', async () => {
    const { agent, conversation } = companion('小月', { stateSchema: TRUST, firstMessage: '你好呀' });
    const schema = core.soul.character(agent.id)!.stateSchema;
    await turn(conversation.id, '第一句', '好。\n\n<turn_meta>\ntrust: +2\n</turn_meta>');
    const point = lastFrom(conversation.id, agent.id);
    core.soul.applyStateOps(conversation.id, [{ key: 'trust', op: 'delta', value: 1 }]);
    await turn(conversation.id, '第二句', '嗯。\n\n<turn_meta>\ntrust: +3\n</turn_meta>');
    setChat(conversation.id, { scenario: '雨夜' });
    const branch = core.soul.branch(conversation.id, point.id);
    const copies = messagesOf(branch.id);
    const originals = messagesOf(conversation.id).slice(0, 3);
    expect(copies).toHaveLength(3);
    copies.forEach((copy, index) => {
      expect(copy.taskId).toBeNull();
      expect(copy.soul?.copiedFrom).toBe(originals[index]!.id);
      expect(copy.soul?.at).toBe(messageAt(originals[index]!));
      expect(copy.content).toBe(originals[index]!.content);
    });
    const view = core.soul.chatView(branch.id);
    expect(view.scenario).toBe('雨夜');
    expect(view.branchOf).toEqual({ conversationId: conversation.id, messageId: point.id });
    expect(view.userStateOps.map((op) => op.after)).toEqual([copies[2]!.id]);
    const sourceSlots = chatStateSlots(messagesOf(conversation.id));
    const upTo = sourceSlots.slice(0, sourceSlots.findIndex((slot) => slot.slotId === point.id) + 1);
    const sourceOps = core.soul.chatView(conversation.id).userStateOps
      .filter((op) => op.after === null || upTo.some((slot) => slot.slotId === op.after));
    const atPoint = stateRecord(foldChatState(schema, upTo, sourceOps));
    expect(stateRecord(foldChatState(schema, chatStateSlots(copies), view.userStateOps))).toEqual(atPoint);
    expect(atPoint).toEqual({ trust: 3 });
  });

  it('chooses room speakers by mention, list, natural order and manual moderator, without a state contract', async () => {
    const xiao = companion('小月', { stateSchema: TRUST }).agent;
    const lan = companion('阿岚').agent;
    const zhou = companion('周').agent;
    const room = core.createGroup({ name: '茶话会', memberIds: [xiao.id, lan.id, zhou.id], moderatorId: xiao.id, mode: 'discussion' });
    const roomId = room.conversationId;
    expect(core.soul.modeOf(core.store.require<PaConversation>('conversations', roomId))).toBe('companion');
    expect((await turn(roomId, '阿岚，你今天去哪了')).participantIds).toEqual([lan.id]);
    expect((await turn(roomId, '@周 在吗')).participantIds).toEqual([zhou.id]);
    setChat(roomId, { groupStrategy: 'manual' });
    expect((await turn(roomId, '周在吗')).participantIds).toEqual([xiao.id]);
    expect(calls.at(-1)!.chat!.system).not.toContain('trust |');
    setChat(roomId, { groupStrategy: 'list' });
    const listed = await turn(roomId, '大家好');
    expect(listed.participantIds).toEqual([xiao.id, lan.id, zhou.id]);
    expect(messagesOf(roomId).filter((item) => item.taskId === listed.id && item.senderId !== 'owner').map((item) => item.senderId))
      .toEqual([xiao.id, lan.id, zhou.id]);
    setChat(roomId, { groupStrategy: 'natural' });
    rngValue = 0.99;
    expect((await turn(roomId, '随便聊聊')).participantIds).toHaveLength(1);
    const more = [companion('阿青').agent, companion('阿白').agent];
    const big = core.createGroup({
      name: '大桌', memberIds: [xiao.id, lan.id, zhou.id, ...more.map((agent) => agent.id)], moderatorId: xiao.id, mode: 'discussion',
    });
    setChat(big.conversationId, { groupStrategy: 'list' });
    expect((await turn(big.conversationId, '都来说一句')).participantIds).toHaveLength(4);
  });

  it('keeps a replaced reply\'s memory suggestion pending on regenerate and ignores punctuation when deduping', async () => {
    const { agent, conversation } = companion();
    const pending = () => core.store.list<PaMemoryCandidate>('memory_candidates')
      .filter((item) => item.conversationId === conversation.id && item.status === 'pending');
    await turn(conversation.id, '周六去看展吗', '好呀。\n\n<turn_meta>\nremember: promise | 2026-11-21 | 周六一起去看老海报展，很期待\n</turn_meta>');
    const root = lastFrom(conversation.id, agent.id);
    expect(pending().map((item) => item.sourceMessageId)).toEqual([root.id]);
    replies.push('嗯嗯。\n\n<turn_meta>\nremember: promise | 2026-11-21 | 周六一起去看老海报展，很期待！\nremember: preference | 喜欢老海报\n</turn_meta>');
    expect((await settled(core.soul.regenerate(conversation.id, root.id, randomUUID()).id)).status).toBe('completed');
    const variant = lastFrom(conversation.id, agent.id);
    // Regenerating is about wording: the earlier suggestion waits for the owner, and the same sentence is not asked twice.
    expect(pending().map((item) => [item.sourceMessageId, item.content])).toEqual([
      [root.id, '周六一起去看老海报展，很期待'], [variant.id, '喜欢老海报'],
    ]);
    core.soul.selectVariant(root.id, { messageId: root.id });
    expect(pending().map((item) => item.sourceMessageId)).toEqual([root.id, variant.id]);
    expect(core.store.list<PaMemoryCandidate>('memory_candidates').some((item) => item.status === 'dismissed')).toBe(false);
    await turn(conversation.id, '那就说定了', '说定了。\n\n<turn_meta>\nremember: promise | 2026-11-21 | 周六 一起去看老海报展 很期待\n</turn_meta>');
    expect(pending()).toHaveLength(2);
  });

  it('proposes and accepts memory candidates, never drops one for a count, and recalls the right memories', async () => {
    const { agent, conversation } = companion();
    await turn(conversation.id, '周六去看海吗', '好呀，说定了。\n\n<turn_meta>\nmood: 开心\nremember: promise | 2026-11-21 | 周六一起去看海\n</turn_meta>');
    const reply = lastFrom(conversation.id, agent.id);
    const candidate = core.store.list<PaMemoryCandidate>('memory_candidates').find((item) => item.conversationId === conversation.id)!;
    expect(candidate).toMatchObject({
      status: 'pending', kind: 'promise', sourceMessageId: reply.id, agentId: agent.id,
      dueAt: new Date(2026, 10, 21, 23, 59, 59, 999).getTime(),
    });
    const accepted = core.resolveMemoryCandidate(candidate.id, candidate.revision, true);
    // A resolved candidate keeps its text.
    expect(accepted).toMatchObject({ status: 'accepted', content: '周六一起去看海' });
    const memory = core.memories().find((item) => item.id === accepted.memoryId)!;
    expect(memory).toMatchObject({ scope: 'agent', scopeId: agent.id, kind: 'promise', source: '对话 · 小月', sourceMessageId: reply.id });
    const filler = Array.from({ length: 12 }, (_, index) => core.store.create<PaMemoryCandidate>('memory_candidates', {
      taskId: 'filler', attemptId: 'filler', content: `旧候选 ${index}`, dataClass: 'standard', status: 'pending',
      conversationId: conversation.id, agentId: agent.id,
    }));
    await turn(conversation.id, '我喜欢茉莉花', '记住了。\n\n<turn_meta>\nremember: preference | 喜欢茉莉花\n</turn_meta>');
    const pending = core.store.list<PaMemoryCandidate>('memory_candidates')
      .filter((item) => item.conversationId === conversation.id && item.status === 'pending');
    expect(pending).toHaveLength(13);
    expect(core.store.require<PaMemoryCandidate>('memory_candidates', filler[0]!.id)).toMatchObject({ status: 'pending', content: '旧候选 0' });
    core.saveMemory({ content: 'Quarterly revenue spreadsheet', source: '测试', scope: 'private', scopeId: null });
    await turn(conversation.id, '晚安');
    expect(calls.at(-1)!.prompt).toContain('周六一起去看海');
    expect(calls.at(-1)!.prompt).not.toContain('Quarterly revenue');
    const lan = companion('阿岚').agent;
    const room = core.createGroup({ name: '散步', memberIds: [agent.id, lan.id], moderatorId: agent.id, mode: 'discussion' });
    setChat(room.conversationId, { groupStrategy: 'manual' });
    await turn(room.conversationId, '出发吧');
    expect(calls.at(-1)!.prompt).toContain('周六一起去看海');
  });

  it('handles crisis text with care, no footer contract and one room speaker, and ignores 想死你了', async () => {
    const { conversation } = companion();
    await turn(conversation.id, '我不想活了');
    const owner = messagesOf(conversation.id).find((item) => item.content === '我不想活了')!;
    expect(owner.soul?.care).toBe('crisis');
    expect(calls.at(-1)!.prompt).toContain('可能是真实的自伤或轻生念头');
    expect(calls.at(-1)!.prompt).not.toContain('<turn_meta>');
    const other = companion('阿岚').conversation;
    await turn(other.id, '想死你了');
    expect(messagesOf(other.id).find((item) => item.content === '想死你了')!.soul?.care).toBeUndefined();
    expect(calls.at(-1)!.prompt).not.toContain('可能是真实的自伤或轻生念头');
    const a = companion('阿青').agent;
    const b = companion('阿白').agent;
    const room = core.createGroup({ name: '夜谈', memberIds: [a.id, b.id], moderatorId: a.id, mode: 'discussion' });
    setChat(room.conversationId, { groupStrategy: 'list' });
    expect((await turn(room.conversationId, '我不想活了')).participantIds).toHaveLength(1);
  });

  it('records traces of what the runtime sent, keeps five, previews without writing and tests regex keys in the vm', async () => {
    const book = core.soul.saveLorebook({ name: '工作室', entries: [
      { id: 'lamp', keys: ['台灯'], content: '台灯是外婆留下的旧物。' },
      { id: 'volcano', keys: ['火山'], content: '火山在很远的地方。' },
    ] });
    const { agent, conversation } = companion('小月', { lorebookIds: [book.id] });
    await turn(conversation.id, '台灯亮了', { ...result('嗯。'), wire: 'structured' });
    const first = lastFrom(conversation.id, agent.id);
    const trace = core.soul.trace(first.id)!;
    expect(trace.wire).toBe('structured');
    expect(trace.messageId).toBe(first.id);
    expect(trace.speaker.agentId).toBe(agent.id);
    expect(trace.lore.some((entry: PaSoulTraceLore) => entry.entryId === 'lamp' && entry.status === 'included')).toBe(true);
    expect(trace.lore.every((entry: PaSoulTraceLore) => entry.status !== 'inactive')).toBe(true);
    expect(trace.loreInactive).toBeGreaterThan(0);
    for (const goal of ['二', '三', '四', '五', '六']) await turn(conversation.id, goal);
    const traces = core.store.list<PaSoulTrace & PaEntity>('soul_traces').filter((item) => item.conversationId === conversation.id);
    expect(traces).toHaveLength(5);
    expect(core.soul.trace(first.id)).toBeNull();
    const state = core.store.require<PaChatState>('chat_state', conversation.id);
    const count = messagesOf(conversation.id).length;
    const preview = core.soul.preview(conversation.id, { draft: '台灯还亮着吗' });
    expect(preview.speaker.agentId).toBe(agent.id);
    expect(preview.messageId).toBeUndefined();
    // The draft is one more message: included plus hidden never exceeds the total.
    expect(preview.history.total).toBe(count + 1);
    expect(preview.history.included + preview.history.hidden).toBeLessThanOrEqual(preview.history.total);
    expect(core.store.require<PaChatState>('chat_state', conversation.id).revision).toBe(state.revision);
    expect(messagesOf(conversation.id)).toHaveLength(count);
    expect(core.store.list('soul_traces')).toHaveLength(5);
    const base = await listen();
    const tested = await send(`${base}/api/pa/soul/lorebooks/test`, 'POST', {
      lorebook: { name: '草稿', entries: [{ id: 're', keys: ['/台灯+/'], content: '灯' }] }, messages: ['我打开了台灯'],
    });
    expect(tested.status).toBe(200);
    const body = await tested.json() as { trace: PaSoulTraceLore[]; used: number; limit: number };
    expect(body.trace[0]).toMatchObject({ entryId: 're', status: 'included' });
    expect(paLoreRegexTest('(a+)+$', '', `${'a'.repeat(32)}!`)).toBeNull();
    expect(paLoreRegexTest('(a+)+$', '', 'aaa')).toBeNull();
    // One budget per build: distinct catastrophic keys stop running once the total is spent.
    const budgeted = paLoreRegexBudget(60);
    const started = performance.now();
    const results = Array.from({ length: 20 }, (_, index) => budgeted(`(a+)+b${index}`, '', 'a'.repeat(40)));
    expect(performance.now() - started).toBeLessThan(400);
    expect(results.every((result) => result === null)).toBe(true);
    expect(budgeted('a', '', 'a')).toBeNull();
  });

  it('hides chat tasks from feed, activity and finished snapshots, and tracks the since tag', async () => {
    const base = await listen();
    const { agent, conversation } = companion();
    const done = await turn(conversation.id, '你好');
    const snapshot = await (await fetch(`${base}/api/pa`)).json() as PaSnapshot;
    expect(snapshot.tasks.some((task) => task.id === done.id)).toBe(false);
    expect(snapshot.attempts.some((attempt) => attempt.taskId === done.id)).toBe(false);
    expect(snapshot.messages.some((item) => item.taskId === done.id && item.senderId === agent.id)).toBe(true);
    const feed = await (await fetch(`${base}/api/pa/feed`)).json() as { items: PaFeedItem[] };
    expect(feed.items.some((item) => item.taskId === done.id)).toBe(false);
    holdNext();
    const running = chat(conversation.id, '还在吗');
    await vi.waitFor(() => expect(status(running.id)).toBe('running'));
    const activity = await (await fetch(`${base}/api/pa/activity`)).json() as { running: number };
    expect(activity.running).toBe(0);
    release();
    await settled(running.id);
    const tag = (await (await fetch(`${base}/api/pa`)).json() as PaSnapshot).tag!;
    expect(await (await fetch(`${base}/api/pa?since=${encodeURIComponent(tag)}`)).json()).toEqual({ unchanged: true, tag });
    const version = core.snapshot().soulVersion;
    core.store.update<PaChatState>('chat_state', conversation.id, { loreTimers: { 'book:entry': { at: 1, stickyEnd: 3, cooldownEnd: 0 } } });
    expect(core.snapshotTag()).toBe(tag);
    expect(core.snapshot().soulVersion).toBe(version);
    setChat(conversation.id, { scenario: '傍晚' });
    const changed = await (await fetch(`${base}/api/pa?since=${encodeURIComponent(tag)}`)).json() as PaSnapshot & { unchanged?: boolean };
    expect(changed.unchanged).toBeUndefined();
    expect(changed.tag).not.toBe(tag);
    expect(changed.soulVersion).not.toBe(version);
  });

  it('refuses chat turns outside a local companion conversation', () => {
    const plain = agentOf('助手');
    const workConversation = core.createConversation(plain.id);
    expect(refused(() => chat(workConversation.id, '你好'))).toEqual({ status: 400, code: 'PA_SOUL_MODE' });
    const { agent, conversation } = companion();
    const input = paTaskInputSchema.parse({ requestId: randomUUID(), conversationId: conversation.id, goal: '你好', kind: 'chat' });
    expect(refused(() => core.submit(input, undefined, undefined, { kind: 'device', id: 'laptop' })))
      .toEqual({ status: 403, code: 'PA_SOUL_ORIGIN' });
    const channel = core.store.create<PaConversation>('conversations', {
      title: '渠道', agentId: agent.id, groupId: null, channelId: 'channel-1', externalThreadId: 'thread-1',
    });
    expect(refused(() => chat(channel.id, '你好'))).toEqual({ status: 400, code: 'PA_SOUL_MODE' });
    expect(refused(() => chat(conversation.id, '你好', { completionCriteria: ['done'] }))).toEqual({ status: 400, code: 'PA_SOUL_MODE' });
    expect(refused(() => chat(conversation.id, '你好', { execution: { target: 'local', script: 'echo hi' } })))
      .toEqual({ status: 400, code: 'PA_SOUL_MODE' });
    expect(core.store.list<PaTask>('tasks').filter((task) => task.kind === 'chat')).toHaveLength(0);
  });

  it('enterprise mode: admins manage the library, each member owns their chats, personas and memories', async () => {
    const tokens = { boss: '', alice: '', bob: '', curator: '', guest: '' } as Record<string, string>;
    for (const id of Object.keys(tokens)) tokens[id] = randomBytes(32).toString('base64url');
    const secret = join(root, 'gateway.secret');
    writeFileSync(secret, randomBytes(32).toString('base64url'), { mode: 0o600 });
    const configPath = join(root, 'enterprise.json');
    const quota = { calls: 100, cpuMs: 5000000, costMicros: 1000000 };
    const expiresAt = Date.now() + 120000;
    const member = (id: string, role: string, permissions: string[] = []) =>
      ({ id, role, group: 'all', tokenSha256: paDigest(tokens[id]!), grantVersion: 1, expiresAt, permissions });
    writeFileSync(configPath, JSON.stringify({
      version: 1, mode: 'enterprise',
      enterprise: {
        tenantId: 'soul-tenant',
        members: [
          member('boss', 'admin'), member('alice', 'operator'), member('bob', 'operator'),
          member('curator', 'operator', ['library.manage']), member('guest', 'viewer'),
        ],
        budgets: { tenant: quota, groups: { all: quota }, roles: { admin: quota, operator: quota, viewer: quota } },
        gateway: {
          endpoint: 'http://127.0.0.1:1/model', secret: { type: 'file', path: secret },
          models: [{ id: 'test', maxTokens: 1024, reserveCostMicros: 10 }],
        },
      },
    }), { mode: 0o600 });
    const kernel = createPaKernel({ configPath, db, dataDir: root, projectsDir: join(root, 'projects'), localRuntime: { models: async () => [], execute } });
    const service = new PersonalAgentService({
      db: kernel.storage.db, dataDir: kernel.storage.dataDir, projectsDir: kernel.storage.projectsDir, runtime: kernel.credentials.runtime, kernel,
    });
    try {
      const base = await listen(service);
      const call = async (who: string, method: string, route: string, payload?: unknown) => {
        const response = await fetch(`${base}/api/pa${route}`, {
          method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        return { status: response.status, body: await response.json() as any };
      };
      expect((await fetch(`${base}/api/pa/soul`)).status).toBe(401);
      // A portrait loads without a token (its id is the capability); an unknown one is simply not found.
      expect((await fetch(`${base}/api/pa/soul/assets/${randomUUID()}.png`)).status).toBe(404);
      expect((await call('alice', 'GET', '/mode')).body).toMatchObject({ mode: 'enterprise', role: 'operator', memberId: 'alice', canManageLibrary: false });
      expect((await call('curator', 'GET', '/mode')).body.canManageLibrary).toBe(true);

      // The library: written by the admin and the curator, read by everyone.
      for (const who of ['alice', 'guest']) {
        const denied = await call(who, 'POST', '/soul/characters/import', { card: V2_CARD });
        expect(denied.status, who).toBe(403);
        expect(denied.body.error.code).toBe('PA_CAPABILITY_DENIED');
        expect((await call(who, 'POST', '/soul/starters/xiaoyue/install', {})).status, who).toBe(403);
        expect((await call(who, 'POST', '/soul/lorebooks', { name: 'x', entries: [] })).status, who).toBe(403);
      }
      const imported = await call('boss', 'POST', '/soul/characters/import', { card: V2_CARD });
      expect(imported.status).toBe(200);
      const agentId: string = imported.body.agent.id;
      expect(imported.body.conversation.principalId).toBe('boss');
      const edited = await call('curator', 'PUT', `/soul/characters/${agentId}`, { tagline: '由策展人修订', revision: imported.body.character.revision });
      expect(edited.status).toBe(200);
      expect((await call('alice', 'PUT', `/soul/characters/${agentId}`, { tagline: 'x', revision: edited.body.revision })).status).toBe(403);
      expect((await call('alice', 'GET', `/soul/characters/${agentId}/export`)).status).toBe(403);
      for (const who of ['alice', 'guest']) {
        const soul = await call(who, 'GET', '/soul');
        expect(soul.body.characters.map((item: { id: string }) => item.id), who).toEqual([agentId]);
      }

      // Conversations: opened by the member, private to the member.
      expect((await call('guest', 'POST', '/conversations', { agentId })).status).toBe(403);
      const aliceChat = (await call('alice', 'POST', '/conversations', { agentId })).body as PaConversation;
      expect(aliceChat.principalId).toBe('alice');
      expect(service.soul.modeOf(aliceChat)).toBe('companion');
      const shared = service.store.list<PaConversation>('conversations').find(item => !item.principalId)!;
      expect(service.soul.modeOf(shared)).toBe('work');
      const view = async (who: string) => (await call(who, 'GET', '')).body as PaSnapshot;
      const alice = await view('alice');
      expect(alice.member).toEqual({ id: 'alice', role: 'operator', canManageLibrary: false });
      expect(alice.soulVersion).toBeTruthy();
      expect(alice.conversations.some(item => item.id === aliceChat.id)).toBe(true);
      expect(alice.messages.filter(item => item.conversationId === aliceChat.id).map(item => item.soul?.kind)).toEqual(['greeting']);
      for (const who of ['bob', 'boss', 'guest']) {
        const other = await view(who);
        expect(other.conversations.some(item => item.id === aliceChat.id), who).toBe(false);
        expect(other.messages.some(item => item.conversationId === aliceChat.id), who).toBe(false);
      }
      const turnInput = { requestId: randomUUID(), conversationId: aliceChat.id, goal: '今天过得怎么样', kind: 'chat' };
      expect((await call('bob', 'POST', '/tasks', turnInput)).status).toBe(404);
      expect((await call('bob', 'POST', '/tasks', { ...turnInput, kind: 'discussion' })).status).toBe(404);
      const accepted = await call('alice', 'POST', '/tasks', turnInput);
      expect(accepted.status).toBe(200);
      expect(accepted.body.principal).toMatchObject({ kind: 'enterprise', id: 'alice' });
      // Not even the admin opens a member's companion chat: no settings, no turn, no message.
      for (const who of ['bob', 'boss']) {
        expect((await call(who, 'PUT', `/soul/chats/${aliceChat.id}`, { nudge: '' })).status, who).toBe(403);
        expect((await call(who, 'GET', `/tasks/${accepted.body.id}`)).status, who).toBe(404);
        expect((await call(who, 'POST', '/soul/chat/continue', { conversationId: aliceChat.id, requestId: randomUUID() })).status, who).toBe(403);
        expect((await view(who)).tasks.some(item => item.id === accepted.body.id), who).toBe(false);
      }

      // Personas and what a character remembers: one member's, invisible to the others and to the admin.
      const persona = await call('alice', 'POST', '/soul/personas', { name: '阿离', description: '夜班护士' });
      expect(persona.status).toBe(200);
      expect(persona.body.principalId).toBe('alice');
      expect((await call('bob', 'GET', '/soul')).body.personas).toEqual([]);
      expect((await call('bob', 'PATCH', `/soul/personas/${persona.body.id}`, { name: 'x', revision: persona.body.revision })).status).toBe(404);
      expect((await call('guest', 'POST', '/soul/personas', { name: 'x', description: '' })).status).toBe(403);
      expect((await call('bob', 'POST', '/soul/personas', { name: '阿渡', description: '' })).body.isDefault).toBe(true);
      const memory = await call('alice', 'POST', '/memories', { content: '她喜欢喝热可可', scope: 'agent', scopeId: agentId, source: '测试' });
      expect(memory.status).toBe(200);
      expect(memory.body.principalId).toBe('alice');
      for (const who of ['bob', 'boss']) {
        expect((await view(who)).memories.some(item => item.id === memory.body.id), who).toBe(false);
        expect((await call(who, 'GET', `/memories/${memory.body.id}/history`)).status, who).toBe(404);
      }
      expect((await view('alice')).memories.some(item => item.id === memory.body.id)).toBe(true);
      // A member's own notes are theirs too: the admin neither reads, edits nor archives them.
      const note = await call('alice', 'POST', '/memories', { content: '体检约在周四上午', scope: 'private', scopeId: null, source: '测试' });
      expect(note.status).toBe(200);
      expect(note.body.principalId).toBe('alice');
      const edit = { content: '改掉', scope: 'private' as const, scopeId: null, source: '测试', revision: note.body.revision };
      for (const who of ['bob', 'boss']) {
        expect((await view(who)).memories.some(item => item.id === note.body.id), who).toBe(false);
        expect((await call(who, 'GET', `/memories/${note.body.id}/history`)).status, who).toBe(404);
        expect((await call(who, 'PATCH', `/memories/${note.body.id}`, edit)).status, who).toBe(404);
        expect((await call(who, 'DELETE', `/memories/${note.body.id}`)).status, who).toBe(404);
        // The service holds the same line for any caller that names a member.
        expect(refused(() => service.saveMemory(edit, note.body.id, note.body.revision, who)), who).toEqual({ status: 404, code: 'PA_NOT_FOUND' });
        expect(refused(() => service.memoryHistory(note.body.id, who)), who).toEqual({ status: 404, code: 'PA_NOT_FOUND' });
        expect(refused(() => service.deleteMemory(note.body.id, who)), who).toEqual({ status: 404, code: 'PA_NOT_FOUND' });
      }
      expect(service.memoryById(note.body.id)).toMatchObject({ content: '体检约在周四上午', status: 'active' });
      expect((await call('alice', 'GET', `/memories/${note.body.id}/history`)).body).toHaveLength(1);
      expect((await call('alice', 'DELETE', `/memories/${note.body.id}`)).status).toBe(200);
      expect(service.memoryById(note.body.id)?.status).toBe('archived');
      // Memory shared across members stays closed.
      expect((await call('alice', 'POST', '/memories', { content: '共享', scope: 'group', scopeId: shared.groupId ?? 'x', source: '测试' })).status).toBe(403);
    } finally {
      await service.shutdown();
      kernel.storage.close();
    }
  });
});
