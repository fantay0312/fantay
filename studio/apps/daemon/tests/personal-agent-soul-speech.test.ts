import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paTaskInputSchema, type PaConversation, type PaMessage, type PaSpeechItem, type PaSpeechStatus, type PaTask, type PersonalAgent } from '@open-design/contracts';
import { PA_PLACEHOLDER_PNG, readZipIndex } from '@open-design/contracts/soul';
import { closeDatabase, openDatabase, type SqliteDb } from '../src/db.js';
import { registerPersonalAgentRoutes } from '../src/routes/personal-agent.js';
import type { PaModelResult, PaModelRuntime } from '../src/runtimes/personal-agent.js';
import type { PersonalAgentChannels } from '../src/services/personal-agent-channels.js';
import { runPersonalAgent, runPersonalAgentCommand } from '../src/services/personal-agent-cli.js';
import { PersonalAgentService } from '../src/services/personal-agent-service.js';
import type { TokenToSeaModel } from '../src/integrations/tokentosea-runtime.js';
import {
  sniffPaAudio, synthesizeTokenToSeaSpeech, tokenToSeaSpeechOperation, tokenToSeaSpeechStatus,
  type PaSpeechAccount, type PaSpeechPort,
} from '../src/services/personal-agent-soul-speech.js';
import { PaError } from '../src/storage/personal-agent-store.js';

let root: string, db: SqliteDb, core: PersonalAgentService, server: http.Server | null = null;
let replies: string[] = [];
let hold: Promise<void> | null = null;
let release: () => void = () => {};
let failure: Error | null = null;
const execute = vi.fn<PaModelRuntime['execute']>();
const result = (text: string): PaModelResult => ({ text, usage: { visibility: 'unknown' } });

const STATUS: PaSpeechStatus = {
  available: true,
  models: [
    { id: 'minimax-tts', label: 'MiniMax · minimax-tts', provider: 'minimax', configured: true, voices: 'free' },
    { id: 'elevenlabs-v3', label: 'ElevenLabs · elevenlabs-v3', provider: 'elevenlabs', configured: false, voices: 'list' },
  ],
};
const VOICE = { model: 'minimax-tts', voice: 'female-shaonv', language: '' };
/** 300 bytes that read as MP3 (an ID3 tag), different per call so a regenerated file is a new file. */
let serial = 0;
const audio = () => {
  serial += 1;
  const bytes = Buffer.alloc(300, serial % 250);
  bytes.write('ID3', 0, 'latin1');
  return bytes;
};
const synthesize = vi.fn<PaSpeechPort['synthesize']>();
const fake: PaSpeechPort = {
  status: async () => STATUS,
  voices: async (model) => (model === 'elevenlabs-v3' ? [{ id: 'v-1', name: 'Rachel' }] : []),
  synthesize,
};

function holdSpeech(): void {
  hold = new Promise<void>((resolve) => {
    release = () => { hold = null; resolve(); };
  });
}
async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PaError) return { status: error.status, code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a PaError');
}
const speechDir = () => join(root, 'pa', 'soul', 'speech');
const files = () => (existsSync(speechDir()) ? readdirSync(speechDir()) : []);
const messagesOf = (conversationId: string) => core.store.listConversationMessages<PaMessage>(conversationId);
const greetingOf = (conversation: PaConversation) => messagesOf(conversation.id).find((message) => message.soul?.kind === 'greeting')!;
const message = (id: string) => core.store.require<PaMessage>('messages', id);

function companion(card: Record<string, unknown> = {}): { agent: PersonalAgent; conversation: PaConversation } {
  const agent = core.createAgent({
    name: '小月', role: '小月的角色', avatar: '', enabled: true, tools: ['respond'], model: { runtime: 'claude', modelId: 'sonnet' },
  });
  core.soul.saveCharacter(agent.id, { description: '小月住在窗边工作室。', firstMessage: '你来啦，今天下雨了。', voice: VOICE, ...card });
  return { agent, conversation: core.createConversation(agent.id) };
}
const setChat = (conversationId: string, patch: Record<string, unknown>) =>
  core.soul.saveChat(conversationId, patch, core.soul.chatView(conversationId).revision || undefined);
const setVoice = (agentId: string, voice: unknown) =>
  core.soul.saveCharacter(agentId, { voice }, core.soul.character(agentId)!.revision);
async function turn(conversationId: string, reply: string): Promise<PaTask> {
  replies.push(reply);
  const task = core.submit(paTaskInputSchema.parse({ requestId: randomUUID(), conversationId, goal: '在吗', kind: 'chat' }));
  await vi.waitFor(() => expect(['completed', 'failed', 'cancelled']).toContain(core.store.require<PaTask>('tasks', task.id).status));
  const done = core.store.require<PaTask>('tasks', task.id);
  expect(done.status, done.error ?? '').toBe('completed');
  return done;
}

/** Test-only zip writer: stored entries, or raw deflate when `deflate` is set. */
function zipOf(entries: Array<{ name: string; data: Uint8Array; deflate?: boolean }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const stored = entry.deflate ? deflateRawSync(entry.data) : Buffer.from(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, stored);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(stored.length, 20);
    head.writeUInt32LE(entry.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
/** Runs `od pa …` against the test server and returns what it printed. */
async function cli(args: string[]): Promise<{ log: string[]; errors: string[]; out: string }> {
  const log: string[] = [], errors: string[] = [];
  let out = '';
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...items: unknown[]) => { log.push(items.map(String).join(' ')); });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...items: unknown[]) => { errors.push(items.map(String).join(' ')); });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  });
  try {
    await runPersonalAgent(args);
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    writeSpy.mockRestore();
  }
  return { log, errors, out };
}

async function listen(before?: (app: express.Express) => void): Promise<string> {
  const app = express();
  before?.(app);
  app.use('/api/pa/soul', express.json({ limit: '24mb' }));
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pa-soul-speech-'));
  db = openDatabase(root, { dataDir: root });
  replies = [];
  hold = null;
  failure = null;
  execute.mockReset().mockImplementation(async () => result(replies.shift() ?? '嗯，我在。'));
  synthesize.mockReset().mockImplementation(async () => {
    if (hold) await hold;
    if (failure) throw failure;
    return { bytes: audio(), ext: 'mp3', mime: 'audio/mpeg' };
  });
  core = new PersonalAgentService({
    db, dataDir: root, projectsDir: join(root, 'projects'), runtime: { models: async () => [], execute },
  });
});
afterEach(async () => {
  vi.useRealTimers();
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

describe('PA soul speech', () => {
  it('is unavailable without a port', async () => {
    const { conversation } = companion();
    expect(await core.soul.speechStatus()).toEqual({ available: false, models: [] });
    expect(await core.soul.speechVoices('minimax-tts')).toEqual({ model: 'minimax-tts', voices: [] });
    expect(await refusal(core.soul.speak(greetingOf(conversation).id)))
      .toMatchObject({ status: 409, code: 'PA_SOUL_SPEECH_UNAVAILABLE' });
    expect(core.soul.listSpeech(conversation.id)).toEqual([]);
  });

  it('checks a message in the documented order', async () => {
    core.soul.attachSpeech(fake);
    const { agent, conversation } = companion();
    await turn(conversation.id, '*放下笔* 你来啦。');
    const owner = messagesOf(conversation.id).find((item) => item.senderId === 'owner')!;
    const greeting = greetingOf(conversation);
    expect(await refusal(core.soul.speak('missing'))).toMatchObject({ status: 404, code: 'PA_NOT_FOUND', message: '消息不存在' });
    expect(await refusal(core.soul.speak(owner.id))).toMatchObject({ status: 400, code: 'PA_SOUL_SPEECH' });
    setChat(conversation.id, { voiceReplies: 'off' });
    expect(await refusal(core.soul.speak(greeting.id))).toMatchObject({ status: 409, code: 'PA_SOUL_SPEECH_OFF' });
    setChat(conversation.id, { voiceReplies: 'manual' });
    setVoice(agent.id, null);
    expect(await refusal(core.soul.speak(greeting.id))).toMatchObject({ status: 409, code: 'PA_SOUL_VOICE_UNSET' });
    setVoice(agent.id, { model: 'elevenlabs-v3' });
    expect(await refusal(core.soul.speak(greeting.id))).toMatchObject({ status: 409, code: 'PA_SOUL_SPEECH_UNAVAILABLE' });
    setVoice(agent.id, VOICE);
    core.soul.editMessage(greeting.id, { content: '```\nconst x = 1;\n```' }, greeting.revision);
    expect(await refusal(core.soul.speak(greeting.id))).toMatchObject({ status: 400, code: 'PA_SOUL_SPEECH' });
    core.soul.editMessage(greeting.id, { content: '好'.repeat(2001) }, message(greeting.id).revision);
    expect(await refusal(core.soul.speak(greeting.id))).toMatchObject({ status: 413, code: 'PA_SOUL_SPEECH_LONG' });
    expect(synthesize).not.toHaveBeenCalled();
    const reply = messagesOf(conversation.id).find((item) => item.senderId === agent.id && item.soul?.kind === 'chat')!;
    expect((await core.soul.speak(reply.id)).cached).toBe(false);
    expect(synthesize).toHaveBeenCalledWith({ model: 'minimax-tts', voice: 'female-shaonv', language: 'zh', text: '你来啦。' });
  });

  it('never sends a local-only reply to the speech service', async () => {
    core.soul.attachSpeech(fake);
    const agent = core.createAgent({
      name: '小月', role: '小月的角色', avatar: '', enabled: true, tools: ['respond'], model: { runtime: 'ollama', modelId: 'qwen' },
    });
    core.soul.saveCharacter(agent.id, { description: '小月住在窗边工作室。', firstMessage: '你来啦。', voice: VOICE });
    const conversation = core.createConversation(agent.id);
    replies.push('这是只在本机的回复。');
    const task = core.submit(paTaskInputSchema.parse({ requestId: randomUUID(), conversationId: conversation.id, goal: '在吗', kind: 'chat', dataClass: 'local_only' }));
    await vi.waitFor(() => expect(core.store.require<PaTask>('tasks', task.id).status).toBe('completed'));
    const reply = messagesOf(conversation.id).find((item) => item.senderId === agent.id && item.soul?.kind === 'chat')!;
    expect(reply.dataClass).toBe('local_only');
    expect(await refusal(core.soul.speak(reply.id))).toMatchObject({ status: 409, code: 'PA_SOUL_SPEECH_LOCAL' });
    expect(synthesize).not.toHaveBeenCalled();
    expect(core.soul.listSpeech(conversation.id)).toEqual([]);
  });

  it('generates once, then serves the cached file and lists it', async () => {
    core.soul.attachSpeech(fake);
    const { conversation } = companion();
    const greeting = greetingOf(conversation);
    const first = await core.soul.speak(greeting.id);
    expect(first).toMatchObject({ messageId: greeting.id, mime: 'audio/mpeg', bytes: 300, cached: false });
    expect(first.id).toMatch(/^[0-9a-f]{64}\.mp3$/);
    expect(files()).toEqual([first.id]);
    expect(synthesize).toHaveBeenCalledTimes(1);
    const second = await core.soul.speak(greeting.id);
    expect(second).toEqual({ ...first, cached: true });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(core.soul.listSpeech(conversation.id)).toEqual([{ ...first, cached: true }]);
    expect(core.soul.readSpeech(first.id)).toMatchObject({ mime: 'audio/mpeg', bytes: 300 });
  });

  it('drops audio that no longer matches the text or the voice, and replaces the file', async () => {
    core.soul.attachSpeech(fake);
    const { agent, conversation } = companion();
    const greeting = greetingOf(conversation);
    const first = await core.soul.speak(greeting.id);
    core.soul.editMessage(greeting.id, { content: '雨停了。' }, greeting.revision);
    expect(core.soul.listSpeech(conversation.id)).toEqual([]);
    const edited = await core.soul.speak(greeting.id);
    expect(edited.cached).toBe(false);
    expect(edited.id).not.toBe(first.id);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(files()).toEqual([edited.id]);
    setVoice(agent.id, { ...VOICE, voice: 'male-qn' });
    expect(core.soul.listSpeech(conversation.id)).toEqual([]);
    const revoiced = await core.soul.speak(greeting.id);
    expect(revoiced.cached).toBe(false);
    expect(files()).toEqual([revoiced.id]);
    expect(core.soul.listSpeech(conversation.id)).toEqual([{ ...revoiced, cached: true }]);
  });

  it('shares one generation per key and refuses a third distinct one while two run', async () => {
    core.soul.attachSpeech(fake);
    const conversations = [companion(), companion(), companion()].map(({ conversation }) => conversation);
    const [a, b, c] = conversations.map((conversation) => greetingOf(conversation));
    holdSpeech();
    const first = core.soul.speak(a!.id);
    const joined = core.soul.speak(a!.id);
    const other = core.soul.speak(b!.id);
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    expect(await refusal(core.soul.speak(c!.id))).toMatchObject({ status: 429, code: 'PA_SOUL_SPEECH_BUSY' });
    release();
    const [one, two, three] = await Promise.all([first, joined, other]);
    expect(one).toEqual(two);
    expect(three!.messageId).toBe(b!.id);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect((await core.soul.speak(c!.id)).cached).toBe(false);
  });

  it('answers 502 with a redacted message when the port fails, and 504 after the wait while the cache still fills', async () => {
    core.soul.attachSpeech(fake);
    const { conversation } = companion();
    const greeting = greetingOf(conversation);
    failure = new Error('upstream 401: api_key=sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    const failed = await refusal(core.soul.speak(greeting.id));
    expect(failed).toMatchObject({ status: 502, code: 'PA_SOUL_SPEECH_FAILED' });
    expect(failed.message).toMatch(/^语音生成失败：/);
    expect(failed.message).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(failed.message).toContain('[credential removed]');
    expect(files()).toEqual([]);
    failure = null;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    holdSpeech();
    const slow = core.soul.speak(greeting.id);
    const settled = refusal(slow);
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(90000);
    expect(await settled).toMatchObject({ status: 504, code: 'PA_SOUL_SPEECH_TIMEOUT' });
    vi.useRealTimers();
    release();
    await vi.waitFor(() => expect(core.soul.listSpeech(conversation.id)).toHaveLength(1));
    expect((await core.soul.speak(greeting.id)).cached).toBe(true);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('recognises the four audio containers and nothing else', () => {
    const bytes = (...parts: Array<string | number[]>) =>
      new Uint8Array(parts.flatMap((part) => (typeof part === 'string' ? [...part].map((char) => char.charCodeAt(0)) : part)));
    expect(sniffPaAudio(bytes('ID3', [3, 0]))).toEqual({ ext: 'mp3', mime: 'audio/mpeg' });
    expect(sniffPaAudio(bytes([0xff, 0xfb, 0x90, 0x00]))).toEqual({ ext: 'mp3', mime: 'audio/mpeg' });
    expect(sniffPaAudio(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toEqual({ ext: 'wav', mime: 'audio/wav' });
    expect(sniffPaAudio(bytes('OggS', [0, 2]))).toEqual({ ext: 'ogg', mime: 'audio/ogg' });
    expect(sniffPaAudio(bytes([0, 0, 0, 0x20], 'ftypM4A '))).toEqual({ ext: 'm4a', mime: 'audio/mp4' });
    for (const garbage of [bytes(), bytes([0xff, 0x10]), bytes('RIFF', [0, 0, 0, 0], 'WEBP'), bytes('<html>'), bytes([0x89], 'PNG')])
      expect(sniffPaAudio(garbage)).toBeNull();
  });

  it('removes the row and the file when the message is deleted', async () => {
    core.soul.attachSpeech(fake);
    const { conversation } = companion();
    const greeting = greetingOf(conversation);
    const item = await core.soul.speak(greeting.id);
    expect(core.store.has('soul_speech', greeting.id)).toBe(true);
    core.soul.deleteMessage(greeting.id, message(greeting.id).revision, false);
    expect(core.store.has('soul_speech', greeting.id)).toBe(false);
    expect(files()).not.toContain(item.id);
    expect(await refusal(Promise.resolve().then(() => core.soul.readSpeech(item.id)))).toMatchObject({ status: 404, code: 'PA_NOT_FOUND' });
  });

  it('reads a voice sample for the editor, cached by voice and text and tied to no message', async () => {
    core.soul.attachSpeech(fake);
    const { conversation } = companion();
    const first = await core.soul.previewSpeech({ model: 'minimax-tts', voice: 'female-shaonv', language: 'zh' });
    expect(first).toMatchObject({ mime: 'audio/mpeg', bytes: 300, cached: false });
    expect(synthesize).toHaveBeenLastCalledWith({ model: 'minimax-tts', voice: 'female-shaonv', language: 'zh', text: '你好，这是我的声音。今天想聊点什么？' });
    expect(await core.soul.previewSpeech({ model: 'minimax-tts', voice: 'female-shaonv', language: 'zh' })).toEqual({ ...first, cached: true });
    expect(synthesize).toHaveBeenCalledTimes(1);
    // An unsaved voice and the editor's own line: markup is stripped, the language follows the text.
    const other = await core.soul.previewSpeech({ model: 'minimax-tts', voice: 'male-qn', text: '**你好**，我是小月。' });
    expect(other.id).not.toBe(first.id);
    expect(synthesize).toHaveBeenLastCalledWith({ model: 'minimax-tts', voice: 'male-qn', language: 'zh', text: '你好，我是小月。' });
    expect(core.soul.listSpeech(conversation.id)).toEqual([]);
    expect(core.store.list('soul_speech')).toHaveLength(0);
    expect(core.soul.readSpeech(first.id)).toMatchObject({ mime: 'audio/mpeg', bytes: 300 });
    expect(await refusal(core.soul.previewSpeech({ model: 'elevenlabs-v3' }))).toMatchObject({ status: 409, code: 'PA_SOUL_SPEECH_UNAVAILABLE' });
    await expect(core.soul.previewSpeech({ model: 'minimax-tts', text: 'x'.repeat(121) })).rejects.toThrow();
    core.soul.attachSpeech(null);
    expect(await refusal(core.soul.previewSpeech({ model: 'minimax-tts' }))).toMatchObject({ status: 409, code: 'PA_SOUL_SPEECH_UNAVAILABLE' });
  });

  it('sweeps images and audio nothing refers to once they are old, and leaves the rest', async () => {
    core.soul.attachSpeech(fake);
    const { agent, conversation } = companion();
    const image = () => core.soul.saveAsset({ mime: 'image/png', data: Buffer.from(PA_PLACEHOLDER_PNG).toString('base64') }).id;
    const [used, replaced, uploading] = [image(), image(), image()];
    core.soul.saveCharacter(agent.id, { portraitAssetId: used }, core.soul.character(agent.id)!.revision);
    const greeting = greetingOf(conversation);
    const spoken = await core.soul.speak(greeting.id);
    const sample = await core.soul.previewSpeech({ model: 'minimax-tts' });
    const freshSample = await core.soul.previewSpeech({ model: 'minimax-tts', voice: 'male-qn' });
    const assetDir = join(root, 'pa', 'soul', 'assets');
    writeFileSync(join(assetDir, 'notes.txt'), 'not ours');
    const old = new Date(Date.now() - 8 * 86_400_000);
    for (const file of [join(assetDir, used), join(assetDir, replaced), join(assetDir, 'notes.txt'), join(speechDir(), spoken.id), join(speechDir(), sample.id)])
      utimesSync(file, old, old);

    expect(core.soul.sweepFiles()).toEqual({ images: 1, audio: 1 });
    expect(core.soul.sweepFiles()).toBeNull();                       // at most once per six hours
    expect(readdirSync(assetDir).sort()).toEqual([used, uploading, 'notes.txt'].sort());
    expect(files().sort()).toEqual([spoken.id, freshSample.id].sort());

    // Audio whose message is gone: its row and its file go at once, whatever their age.
    core.store.remove('messages', greeting.id);
    expect(core.soul.sweepFiles(true)).toEqual({ images: 0, audio: 1 });
    expect(core.store.has('soul_speech', greeting.id)).toBe(false);
    expect(files()).toEqual([freshSample.id]);
  });

  it('reads a character without a voice of its own with the default voice of the status', async () => {
    const withDefault: PaSpeechPort = { ...fake, status: async () => ({ ...STATUS, default: { model: 'minimax-tts', voice: '', language: '' } }) };
    core.soul.attachSpeech(withDefault);
    const { agent, conversation } = companion();
    setVoice(agent.id, null);
    const greeting = greetingOf(conversation);
    const item = await core.soul.speak(greeting.id);
    expect(synthesize).toHaveBeenLastCalledWith({ model: 'minimax-tts', voice: '', language: 'zh', text: '你来啦，今天下雨了。' });
    expect(core.soul.listSpeech(conversation.id)).toEqual([{ ...item, cached: true }]);
    // The character's own voice wins, and is a different file.
    setVoice(agent.id, VOICE);
    expect((await core.soul.speak(greeting.id)).id).not.toBe(item.id);
    // Without a default the same character cannot be read aloud.
    setVoice(agent.id, null);
    core.soul.attachSpeech(fake);
    expect(await refusal(core.soul.speak(greeting.id))).toMatchObject({ status: 409, code: 'PA_SOUL_VOICE_UNSET' });
    expect(core.soul.listSpeech(conversation.id)).toEqual([]);
  });

  it('turns read-aloud off per chat', async () => {
    core.soul.attachSpeech(fake);
    const { conversation } = companion();
    const greeting = greetingOf(conversation);
    await core.soul.speak(greeting.id);
    setChat(conversation.id, { voiceReplies: 'off' });
    expect(await refusal(core.soul.speak(greeting.id))).toMatchObject({ status: 409, code: 'PA_SOUL_SPEECH_OFF' });
    expect(core.soul.listSpeech(conversation.id)).toEqual([]);
    expect(core.soul.chatView(conversation.id).voiceReplies).toBe('off');
  });

  it('serves status, generation and the audio over HTTP with byte ranges', async () => {
    core.soul.attachSpeech(fake);
    const base = await listen();
    const { conversation } = companion();
    const greeting = greetingOf(conversation);
    const api = `${base}/api/pa/soul/speech`;
    expect(await (await fetch(`${api}/status`)).json()).toEqual(STATUS);
    expect(await (await fetch(`${api}/voices?model=elevenlabs-v3`)).json())
      .toEqual({ model: 'elevenlabs-v3', voices: [{ id: 'v-1', name: 'Rachel' }] });
    expect((await fetch(`${api}/voices`)).status).toBe(400);
    const post = (payload: unknown) => fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    expect((await post({ messageId: greeting.id, extra: 1 })).status).toBe(400);
    const created = await post({ messageId: greeting.id });
    expect(created.status).toBe(200);
    const item = await created.json() as PaSpeechItem;
    expect(item).toMatchObject({ messageId: greeting.id, cached: false, bytes: 300 });
    expect(await (await fetch(`${api}?conversationId=${encodeURIComponent(conversation.id)}`)).json())
      .toEqual({ items: [{ ...item, cached: true }] });
    const whole = await fetch(`${api}/${item.id}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('audio/mpeg');
    expect(whole.headers.get('x-content-type-options')).toBe('nosniff');
    expect(whole.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(whole.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    const body = new Uint8Array(await whole.arrayBuffer());
    expect(body).toHaveLength(300);
    expect(new TextDecoder().decode(body.slice(0, 3))).toBe('ID3');
    const part = await fetch(`${api}/${item.id}`, { headers: { Range: 'bytes=2-9' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 2-9/300');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(body.slice(2, 10));
    const open = await fetch(`${api}/${item.id}`, { headers: { Range: 'bytes=290-' } });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe('bytes 290-299/300');
    for (const range of ['bytes=300-', 'bytes=9-2', 'items=0-1', 'bytes=0-1,4-5']) {
      const refused = await fetch(`${api}/${item.id}`, { headers: { Range: range } });
      expect(refused.status, range).toBe(416);
      expect(refused.headers.get('content-range')).toBe('bytes */300');
    }
    const bad = await fetch(`${api}/..%2Fsecret.mp3`);
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: { code: string } }).error.code).toBe('PA_SOUL_ASSET');
    expect((await fetch(`${api}/${'0'.repeat(64)}.mp3`)).status).toBe(404);
    const unknown = await post({ messageId: 'missing' });
    expect(unknown.status).toBe(404);
  });

  it('reaches speech and assets from the CLI', async () => {
    core.soul.attachSpeech(fake);
    const base = await listen();
    const flags = ['--daemon-url', base, '--json'];
    const { conversation } = companion();
    const greeting = greetingOf(conversation);
    expect(JSON.parse((await cli(['speech-status', ...flags])).log[0]!)).toEqual(STATUS);
    expect(JSON.parse((await cli(['speech-voices', '--model', 'elevenlabs-v3', ...flags])).log[0]!).voices).toHaveLength(1);
    const out = join(root, 'speak.mp3');
    expect(JSON.parse((await cli(['speak', greeting.id, '--out', out, ...flags])).log[0]!))
      .toEqual({ written: out, bytes: 300, cached: false });
    expect(readFileSync(out).subarray(0, 3).toString('latin1')).toBe('ID3');
    expect(JSON.parse((await cli(['speak', greeting.id, ...flags])).log[0]!)).toMatchObject({ cached: true });
    expect(JSON.parse((await cli(['speech-list', conversation.id, ...flags])).log[0]!).items).toHaveLength(1);
    const sample = join(root, 'sample.mp3');
    expect(JSON.parse((await cli(['speech-preview', '--model', 'minimax-tts', '--voice', 'female-shaonv', '--out', sample, ...flags])).log[0]!))
      .toEqual({ written: sample, bytes: 300, cached: false });
    expect(JSON.parse((await cli(['speech-preview', '--model', 'minimax-tts', '--voice', 'female-shaonv', ...flags])).log[0]!)).toMatchObject({ cached: true });
    const png = join(root, 'sprite.png');
    writeFileSync(png, PA_PLACEHOLDER_PNG);
    const uploaded = JSON.parse((await cli(['asset-upload', '--file', png, ...flags])).log[0]!) as { id: string };
    expect(uploaded.id).toMatch(/\.png$/);
    const text = join(root, 'note.txt');
    writeFileSync(text, 'not an image');
    await expect(cli(['asset-upload', '--file', text, ...flags])).rejects.toThrow(/PNG, JPEG or WebP/);
  });

  it('prints a daemon refusal as a message with exit code 1, never a stack trace', async () => {
    const base = await listen();
    const errors: string[] = [];
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      errors.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    const before = process.exitCode;
    try {
      await runPersonalAgentCommand(['speak', 'missing', '--daemon-url', base, '--json']);
      expect(process.exitCode).toBe(1);
      process.exitCode = before;
      await runPersonalAgentCommand(['speak', 'missing', '--daemon-url', base]);
      expect(process.exitCode).toBe(1);
    } finally {
      errorSpy.mockRestore();
      process.exitCode = before;
    }
    expect(errors).toEqual([`${JSON.stringify({ ok: false, error: { message: '消息不存在' } })}\n`, '消息不存在\n']);
  });

  it('imports a CHARX archive from the CLI with its portrait and sprites', async () => {
    const base = await listen();
    const card = {
      spec: 'chara_card_v3', spec_version: '3.0',
      data: {
        name: '林雾', description: '海港灯塔的守灯人。', first_mes: '灯刚点上。',
        assets: [
          { type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' },
          { type: 'emotion', uri: 'embeded://assets/emotion/happy.png', name: 'happy', ext: 'png' },
          { type: 'emotion', uri: 'embedded://assets/emotion/sad_01.png', name: 'sad_01', ext: 'png' },
          { type: 'background', uri: 'embeded://assets/bg/night.png', name: 'night', ext: 'png' },
        ],
      },
    };
    const archive = zipOf([
      { name: 'card.json', data: Buffer.from(JSON.stringify(card), 'utf8'), deflate: true },
      { name: 'assets/icon/images/main.png', data: PA_PLACEHOLDER_PNG, deflate: true },
      { name: 'assets/emotion/happy.png', data: PA_PLACEHOLDER_PNG },
      { name: 'assets/emotion/sad_01.png', data: PA_PLACEHOLDER_PNG, deflate: true },
      { name: 'assets/bg/night.png', data: PA_PLACEHOLDER_PNG },
      { name: 'module.risum', data: Buffer.from('module') },
    ]);
    const file = join(root, 'lighthouse.charx');
    writeFileSync(file, archive);
    const run = await cli(['character-import', '--card', file, '--daemon-url', base, '--json']);
    const imported = JSON.parse(run.log[0]!) as { agent: PersonalAgent; character: { sprites: Record<string, string>; portraitAssetId: string | null } };
    expect(Object.keys(imported.character.sprites).sort()).toEqual(['happy', 'sad']);
    expect(imported.character.portraitAssetId).toMatch(/\.png$/);
    expect(core.soul.character(imported.agent.id)!.sprites).toEqual(imported.character.sprites);
    expect(run.errors.some((line) => line.includes('module.risum') && line.includes('not-referenced'))).toBe(true);
    expect(run.errors.some((line) => line.includes('assets/bg/night.png'))).toBe(true);
    const broken = join(root, 'broken.charx');
    writeFileSync(broken, zipOf([{ name: 'readme.txt', data: Buffer.from('no card') }]));
    await expect(cli(['character-import', '--card', broken, '--daemon-url', base])).rejects.toThrow('The CHARX file cannot be read (no-card)');
  });

  it('exports a CHARX archive from the CLI with the stored portrait and sprites', async () => {
    const base = await listen();
    const { agent } = companion();
    const image = () => core.soul.saveAsset({ mime: 'image/png', data: Buffer.from(PA_PLACEHOLDER_PNG).toString('base64') }).id;
    core.soul.saveCharacter(agent.id, { portraitAssetId: image(), sprites: { happy: image() } }, core.soul.character(agent.id)!.revision);
    const out = join(root, 'xiaoyue.charx');
    const run = await cli(['character-export', agent.id, '--charx', out, '--daemon-url', base, '--json']);
    expect(JSON.parse(run.log[0]!)).toMatchObject({ written: out, portrait: true, sprites: ['happy'] });
    const index = readZipIndex(new Uint8Array(readFileSync(out)));
    expect(index.ok && index.entries.map((entry) => entry.name)).toEqual(['card.json', 'assets/icon/main.png', 'assets/emotion/happy.png']);
    // The archive imports again as a new character with the same pictures.
    const again = await cli(['character-import', '--card', out, '--daemon-url', base, '--json']);
    const imported = JSON.parse(again.log[0]!) as { character: { portraitAssetId: string | null; sprites: Record<string, string> } };
    expect(imported.character.portraitAssetId).toMatch(/\.png$/);
    expect(Object.keys(imported.character.sprites)).toEqual(['happy']);
  });

  it('follows the live text from the CLI until the turn ends', async () => {
    const frames = [
      { live: { attemptId: 'a1', taskId: 't1', agentId: 'g1', seq: 1, text: '你好' } },
      { live: { attemptId: 'a1', taskId: 't1', agentId: 'g1', seq: 2, text: '你好，在' } },
      { live: { attemptId: 'a1', taskId: 't1', agentId: 'g1', seq: 2, unchanged: true } },
      { live: { attemptId: 'a1', taskId: 't1', agentId: 'g1', seq: 3, text: '重来' } },
      { live: null },
      { live: { attemptId: 'a2', taskId: 't1', agentId: 'g2', seq: 1, text: '我也在' } },
      { live: null },
      { live: null },
    ];
    const queries: string[] = [];
    const base = await listen((app) => app.get('/api/pa/soul/live', (req, res) => {
      queries.push(new URLSearchParams(req.query as Record<string, string>).toString());
      res.json(frames[Math.min(queries.length - 1, frames.length - 1)]);
    }));
    const run = await cli(['live', 'c-1', '--follow', '--daemon-url', base]);
    expect(run.out).toBe('你好，在\n重来\n我也在\n');
    expect(queries).toHaveLength(frames.length);
    expect(queries[0]).toBe('conversationId=c-1');
    expect(queries[2]).toBe('conversationId=c-1&attempt=a1&seq=2');
    expect(queries[5]).toBe('conversationId=c-1');
    const once = await cli(['live', 'c-1', '--daemon-url', base, '--json']);
    expect(JSON.parse(once.log[0]!)).toEqual({ live: null });
  });
});

describe('TokenToSea speech', () => {
  const example = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ path: '/v1/audio/speech', mode: 'json', body, ...extra });
  const speechModel = (model: string, extra: Partial<TokenToSeaModel> = {}): TokenToSeaModel => ({
    id: `official:${model}`, model, name: model, priceVersion: 'v1', modality: 'speech', executionKind: 'official', status: 'active',
    examples: [example({ model, input: '你好，欢迎使用语音服务。', voice: 'longanhuan', response_format: 'wav' })],
    systemVoices: ['longanhuan', 'longanyang'], ...extra,
  });
  const CATALOGUE: TokenToSeaModel[] = [
    speechModel('speech-2.8-hd', { systemVoices: ['male-qn-qingse'] }),
    speechModel('cosyvoice-v3-flash'),
    speechModel('deepseek-tts', { examples: [{ path: '/v1/tools/tts', mode: 'json', body: { text: '你好', voice_id: 'stella', format: 'wav' } }], systemVoices: ['stella', 'tide'] }),
    // Not offered: needs a cloned voice, is prompt-style, is withdrawn, or is not a speech model.
    speechModel('cosyvoice-v3.5-flash', { examples: [example({ model: 'cosyvoice-v3.5-flash', input: '你好', voice: '{{VOICE_ID}}' }, { requirements: ['VOICE_ID'] })] }),
    speechModel('qwen-audio-3.1-tts-next', { examples: [example({ model: 'qwen-audio-3.1-tts-next', text_prompt: '请用平静的语气说：你好' })] }),
    speechModel('speech-01-hd', { available: false }),
    speechModel('glm-asr-2512', { modality: 'asr' }),
  ];
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(64, 1)]);
  const ASSET = `asset_${'a'.repeat(64)}`;
  function accountOf(options: { signedIn?: boolean; statuses?: string[]; budget?: number } = {}) {
    const calls: Array<{ resource: string; method: string; body: unknown }> = [];
    const statuses = [...(options.statuses ?? ['running', 'succeeded'])];
    const account: PaSpeechAccount = {
      current: () => (options.signedIn === false ? null : { user: { id: 'u-1' } }),
      models: async () => CATALOGUE,
      authorizationBudget: async () => options.budget ?? 100,
      json: async <T,>(resource: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> => {
        calls.push({ resource, method, body });
        if (resource === 'official/prepare') return { id: 'run-1' } as T;
        if (resource === 'official/runs/run-1') {
          const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
          return { status, output: { data: [{ asset_id: ASSET, mime_type: 'audio/wav' }] } } as T;
        }
        if (resource === `official/runs/run-1/assets/${ASSET}`) return { url: 'https://media.cos.ap-nanjing.myqcloud.com/a.wav?sig=1' } as T;
        return {} as T;
      },
    };
    return { account, calls };
  }

  it('offers the models with a plain verified speech operation and prefers CosyVoice Flash as the default', async () => {
    expect(CATALOGUE.map((model) => (tokenToSeaSpeechOperation(model) ? model.model : null)).filter(Boolean))
      .toEqual(['speech-2.8-hd', 'cosyvoice-v3-flash', 'deepseek-tts']);
    expect(tokenToSeaSpeechOperation(CATALOGUE[2]!)).toMatchObject({ path: '/v1/tools/tts', textField: 'text', voiceField: 'voice_id', voices: ['stella', 'tide'] });
    const status = await tokenToSeaSpeechStatus(accountOf().account);
    expect(status.models).toEqual([
      { id: 'tokentosea/speech-2.8-hd', label: 'TokenToSea · speech-2.8-hd', provider: 'tokentosea', configured: true, voices: 'free' },
      { id: 'tokentosea/cosyvoice-v3-flash', label: 'TokenToSea · cosyvoice-v3-flash', provider: 'tokentosea', configured: true, voices: 'list' },
      { id: 'tokentosea/deepseek-tts', label: 'TokenToSea · deepseek-tts', provider: 'tokentosea', configured: true, voices: 'list' },
    ]);
    expect(status.default).toEqual({ model: 'tokentosea/cosyvoice-v3-flash', voice: '', language: '' });
    expect(await tokenToSeaSpeechStatus(accountOf({ signedIn: false }).account)).toEqual({ models: [], default: null });
    expect(await tokenToSeaSpeechStatus(undefined)).toEqual({ models: [], default: null });
  });

  it('runs the published operation with the text and the voice replaced, and downloads the archived audio', async () => {
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => { fetched.push(String(url)); return new Response(wav); }));
    try {
      const { account, calls } = accountOf();
      const bytes = await synthesizeTokenToSeaSpeech(account, { model: 'tokentosea/cosyvoice-v3-flash', voice: 'longanyang', text: '你来啦。' });
      expect(sniffPaAudio(bytes)).toEqual({ ext: 'wav', mime: 'audio/wav' });
      const prepare = calls.find((call) => call.resource === 'official/prepare')!.body as Record<string, unknown>;
      expect(prepare).toMatchObject({ model: 'cosyvoice-v3-flash', priceVersion: 'v1', path: '/v1/audio/speech', mode: 'json', maxCostUsd: '1.000000' });
      const invoke = calls.find((call) => call.resource === 'official/runs/run-1/invoke')!.body;
      expect(invoke).toEqual({ input: { model: 'cosyvoice-v3-flash', input: '你来啦。', voice: 'longanyang', response_format: 'wav' } });
      expect(fetched).toEqual(['https://media.cos.ap-nanjing.myqcloud.com/a.wav?sig=1']);

      // No voice picked keeps the example's own; a tool-style operation has no `model` field to fill.
      const second = accountOf();
      await synthesizeTokenToSeaSpeech(second.account, { model: 'tokentosea/deepseek-tts', voice: '', text: '在的。' });
      expect(second.calls.find((call) => call.resource === 'official/runs/run-1/invoke')!.body).toEqual({ input: { text: '在的。', voice_id: 'stella', format: 'wav' } });
      expect(second.calls.find((call) => call.resource === 'official/prepare')!.body).toMatchObject({ path: '/v1/tools/tts' });

      await expect(synthesizeTokenToSeaSpeech(accountOf({ statuses: ['failed'] }).account, { model: 'tokentosea/cosyvoice-v3-flash', voice: '', text: 'x' })).rejects.toThrow(/failed/);
      await expect(synthesizeTokenToSeaSpeech(accountOf({ budget: 0 }).account, { model: 'tokentosea/cosyvoice-v3-flash', voice: '', text: 'x' })).rejects.toThrow(/balance/);
      await expect(synthesizeTokenToSeaSpeech(accountOf().account, { model: 'tokentosea/cosyvoice-v3.5-flash', voice: '', text: 'x' })).rejects.toThrow(/not available/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
