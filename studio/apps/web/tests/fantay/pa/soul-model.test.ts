// SPDX-License-Identifier: Apache-2.0
// Fantay Soul data adapters (ARCH 5.2): mode, the companion transcript, story state, turn gates, relationship facts,
// previews, header status and the reachout row. Every rule here comes from the shared engine through the index.
import { describe, expect, it } from 'vitest';
import type {
  PaAttempt,
  PaChannelSnapshot,
  PaCharacterInput,
  PaCharacterView,
  PaChatView,
  PaConversation,
  PaGroup,
  PaMemory,
  PaMessage,
  PaMessageSoul,
  PaPersona,
  PaSnapshot,
  PaSoulSnapshot,
  PaTask,
  PersonalAgent,
} from '@open-design/contracts';
import { PA_DEFAULT_CHAT_SETTINGS, paCharacterInputSchema, paStylePresetInputSchema } from '@open-design/contracts/soul';

import { buildIndex } from '../../../src/fantay/pa/pa-model';
import {
  activeChatTask,
  canRegenerate,
  characterOf,
  chatOf,
  chatStateOf,
  conversationMode,
  displayName,
  emotionOfReply,
  headerStatus,
  installedStarter,
  needsReachoutRow,
  pendingCandidates,
  personaFor,
  presetFor,
  promisesFor,
  relationshipFacts,
  replyEffects,
  resolveChatAppearance,
  retryableChatTask,
  soulItems,
  soulPreview,
  soulTurns,
  stageSpriteSrc,
  typingAgents,
} from '../../../src/fantay/pa/soul/soul-model';

const stamp = { createdAt: 1, updatedAt: 1, revision: 1 };
const NO_CHANNELS: PaChannelSnapshot = { channels: [], inbox: [], outbox: [] };
const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 14, 21, 0).getTime();

function agent(id: string, name: string, extra: Partial<PersonalAgent> = {}): PersonalAgent {
  return { ...stamp, id, name, avatar: '', role: 'role', enabled: true, tools: ['respond'], model: { runtime: 'claude', modelId: 'sonnet' }, ...extra };
}

function character(id: string, input: PaCharacterInput = {}, extra: Partial<PaCharacterView> = {}): PaCharacterView {
  return { ...stamp, id, ...paCharacterInputSchema.parse(input), origin: null, needsReview: [], preservedKeys: [], ...extra };
}

function message(id: string, extra: Partial<PaMessage> = {}): PaMessage {
  return { ...stamp, id, conversationId: 'direct', taskId: null, senderId: 'owner', content: id, targetAgentIds: [], replyTo: null, ...extra };
}

const reply = (id: string, at: number, soul: Partial<PaMessageSoul> = {}, extra: Partial<PaMessage> = {}) =>
  message(id, { senderId: 'xy', createdAt: at, soul: { kind: 'chat', ...soul }, ...extra });
const said = (id: string, at: number, soul: Partial<PaMessageSoul> = {}) => message(id, { createdAt: at, soul: { kind: 'chat', ...soul } });

function task(id: string, extra: Partial<PaTask> = {}): PaTask {
  return {
    ...stamp,
    id,
    requestId: `request-${id}`,
    conversationId: 'direct',
    goal: 'goal',
    kind: 'chat',
    projectName: '',
    projectId: null,
    projectConversationId: null,
    status: 'queued',
    waitingReason: null,
    error: null,
    participantIds: ['xy'],
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
    id: 'att',
    taskId: 't-chat',
    runId: 'run',
    nodeId: 'local',
    protocolVersion: 1,
    agentSnapshot: agent('xy', '小月'),
    phase: 'respond',
    status: 'running',
    taskRevision: 1,
    startedAt: 1,
    endedAt: null,
    output: '',
    error: null,
    usage: { visibility: 'unknown' },
    ...extra,
  };
}

function chatView(id: string, extra: Partial<PaChatView> = {}): PaChatView {
  return { ...stamp, id, ...PA_DEFAULT_CHAT_SETTINGS, activeEvent: null, candidateEvent: null, branchOf: null, userStateOps: [], ...extra };
}

const fantay = agent('fantay', 'Fantay', { avatar: 'fantay' });
const xiaoyue = agent('xy', '小月');
const helper = agent('helper', 'Helper');
const direct: PaConversation = { ...stamp, id: 'direct', title: '小月', agentId: 'xy', groupId: null };
const work: PaConversation = { ...stamp, id: 'work', title: 'Helper', agentId: 'helper', groupId: null };
const room: PaGroup = { ...stamp, id: 'g', name: '茶话会', memberIds: ['xy', 'helper'], moderatorId: 'xy', mode: 'discussion', conversationId: 'room' };
const roomChat: PaConversation = { ...stamp, id: 'room', title: '茶话会', agentId: null, groupId: 'g' };

const SCHEMA: PaCharacterInput['stateSchema'] = [
  { key: 'hp', label: '生命', kind: 'number', initial: 10, min: 0, max: 10 },
  { key: 'bag', label: '背包', kind: 'list', initial: [] },
];

function soul(extra: Partial<PaSoulSnapshot> = {}): PaSoulSnapshot {
  return {
    version: 'v1',
    characters: [character('xy', { tagline: '窗边工作室', alternateGreetings: ['a', 'b'] })],
    lorebooks: [],
    personas: [],
    presets: [],
    chats: [],
    ...extra,
  };
}

function snapshot(extra: Partial<PaSnapshot> = {}): PaSnapshot {
  return {
    agents: [fantay, xiaoyue, helper],
    groups: [room],
    conversations: [direct, work, roomChat],
    messages: [],
    tasks: [],
    attempts: [],
    artifacts: [],
    memories: [],
    node: { id: 'local', protocolVersion: 1, location: 'local', available: true, capabilities: [], heartbeatAt: 1 },
    ...extra,
  };
}

const indexOf = (s: Partial<PaSnapshot> = {}, so: Partial<PaSoulSnapshot> = {}) => buildIndex(snapshot(s), NO_CHANNELS, [], soul(so));

describe('records and mode', () => {
  it('resolves the mode with the shared rule', () => {
    const index = indexOf();
    expect(conversationMode(index, direct)).toBe('companion');
    expect(conversationMode(index, work)).toBe('work');
    expect(conversationMode(index, roomChat)).toBe('work'); // Helper has no card
    const allCarded = indexOf({}, { characters: [character('xy'), character('helper')] });
    expect(conversationMode(allCarded, roomChat)).toBe('companion');
    const explicit = indexOf({}, { chats: [chatView('direct', { mode: 'work' })] });
    expect(conversationMode(explicit, direct)).toBe('work');
    const channel = { ...direct, id: 'wx', channelId: 'ch' };
    expect(conversationMode(indexOf({ conversations: [direct, channel] }), channel)).toBe('work');
  });

  it('enterprise mode: only a conversation the member owns is a companion chat, and the library is read-only by default', () => {
    const own: PaConversation = { ...direct, id: 'own', principalId: 'alice' };
    const member = { id: 'alice', role: 'operator' as const, canManageLibrary: false };
    const index = indexOf({ mode: 'enterprise', member, conversations: [direct, own, work, roomChat] });
    expect(conversationMode(index, own)).toBe('companion');
    expect(conversationMode(index, direct)).toBe('work'); // a shared room, whoever is in it
    expect(index.directByAgent.get('xy')?.[0]?.id).toBe('own');
    expect(index).toMatchObject({ enterprise: true, canManageLibrary: false });
    expect(indexOf({ mode: 'enterprise', member: { ...member, role: 'admin', canManageLibrary: true } }).canManageLibrary).toBe(true);
    expect(indexOf()).toMatchObject({ enterprise: false, canManageLibrary: true });
  });

  it('gives defaults with revision 0 for a chat without settings, the same object on every call', () => {
    const index = indexOf();
    const chat = chatOf(index, 'direct');
    expect(chat).toMatchObject({ id: 'direct', revision: 0, mode: null, historyBudget: 'medium', userStateOps: [] });
    expect(chatOf(index, 'direct')).toBe(chat);
    const stored = chatView('direct', { scenario: '雨夜' });
    expect(chatOf(indexOf({}, { chats: [stored] }), 'direct')).toBe(stored);
  });

  it('names a character by nickname, else the agent name', () => {
    const index = indexOf({}, { characters: [character('xy', { nickname: '月月' })] });
    expect(displayName(index, 'xy')).toBe('月月');
    expect(displayName(index, 'helper')).toBe('Helper');
    expect(characterOf(index, 'helper')).toBeNull();
    expect(characterOf(index, null)).toBeNull();
  });

  it('picks the persona: chat, then the character pin, then the default', () => {
    const persona = (id: string, name: string, isDefault = false): PaPersona => ({ ...stamp, id, name, description: `${name}的介绍`, avatarAssetId: null, isDefault });
    const personas = [persona('p1', '阿树', true), persona('p2', '旅人'), persona('p3', '侦探')];
    expect(personaFor(indexOf({}, { personas }), direct)).toEqual({ id: 'p1', name: '阿树', description: '阿树的介绍' });
    const pinned = indexOf({}, { personas, characters: [character('xy', { personaId: 'p2' })] });
    expect(personaFor(pinned, direct).id).toBe('p2');
    const chosen = indexOf({}, { personas, characters: [character('xy', { personaId: 'p2' })], chats: [chatView('direct', { personaId: 'p3' })] });
    expect(personaFor(chosen, direct).id).toBe('p3');
    expect(personaFor(indexOf(), direct)).toEqual({ id: null, name: '', description: '' });
  });

  it('picks the preset: chat, then the character, then 真人聊天, with built-ins in the index locale', () => {
    const userPreset = { ...stamp, id: 'mine', ...paStylePresetInputSchema.parse({ name: '我的' }) };
    expect(presetFor(indexOf(), direct).id).toBe('builtin:real-chat');
    expect(presetFor(buildIndex(snapshot(), NO_CHANNELS, [], soul(), 'en'), direct).name).toBe('Real chat');
    const byCard = indexOf({}, { characters: [character('xy', { presetId: 'builtin:slow-scene' })] });
    expect(presetFor(byCard, direct).id).toBe('builtin:slow-scene');
    const byChat = indexOf({}, { presets: [userPreset], characters: [character('xy', { presetId: 'builtin:slow-scene' })], chats: [chatView('direct', { presetId: 'mine' })] });
    expect(presetFor(byChat, direct).id).toBe('mine');
  });

  it('layers the appearance: default, the character, the chat', () => {
    const index = indexOf({}, { characters: [character('xy', { appearance: { theme: 'sakura', shape: 'round' } })], chats: [chatView('direct', { appearance: { shape: 'square' } })] });
    expect(resolveChatAppearance(index, direct)).toMatchObject({ theme: 'sakura', shape: 'square', font: 'kai', pattern: 'dots' });
    expect(resolveChatAppearance(index, roomChat).theme).toBe('fantay');
  });
});

describe('soulItems and soulTurns', () => {
  it('builds slots with variants, hidden items and greeting counts', () => {
    const index = indexOf({
      messages: [
        message('g0', { senderId: 'xy', createdAt: 10, soul: { kind: 'greeting', greetingIndex: 1 } }),
        said('o1', 20, { hidden: true }),
        reply('r1', 30, { activeVariant: 'r1b' }),
        reply('r1a', 40, { variantOf: 'r1' }),
        reply('r1b', 50, { variantOf: 'r1' }),
        message('roll', { createdAt: 60, soul: { kind: 'roll' } }),
      ],
    });
    const items = soulItems(index, 'direct');
    expect(items.map((item) => [item.slotId, item.role, item.message.id, item.hidden])).toEqual([
      ['g0', 'greeting', 'g0', false],
      ['o1', 'owner', 'o1', true],
      ['r1', 'agent', 'r1b', false],
      ['roll', 'story', 'roll', false],
    ]);
    expect(items[0]).toMatchObject({ variantIndex: 1, variantCount: 3 });
    expect(items[2]).toMatchObject({ variantIndex: 2, variantCount: 3 });
    expect(soulItems(index, 'direct')).toBe(items);
  });

  it('makes each work task one work turn and groups the other items into chat turns', () => {
    const index = indexOf({
      tasks: [task('t-work', { kind: 'discussion', status: 'completed', createdAt: 30 })],
      messages: [
        said('o1', 10, {}),
        reply('r1', 20, {}, { taskId: 't-finished-chat' }), // its chat task is finished and left out of the snapshot
        message('w-goal', { taskId: 't-work', createdAt: 30 }),
        message('w-reply', { taskId: 't-work', senderId: 'xy', createdAt: 40 }),
        said('o2', 50, { hidden: true }),
        reply('r2', 60),
      ],
    });
    const turns = soulTurns(index, 'direct');
    expect(turns.map((turn) => [turn.kind, turn.key, turn.startedAt])).toEqual([
      ['chat', 'c:o1', 10],
      ['work', 't:t-work', 30],
      ['chat', 'c:o2', 50],
    ]);
    const [first, middle, last] = turns;
    expect(first?.kind === 'chat' && first.items.map((item) => item.message.id)).toEqual(['o1', 'r1']);
    expect(middle?.kind === 'work' && middle.turn.messages.map((m) => m.id)).toEqual(['w-goal', 'w-reply']);
    expect(last?.kind === 'chat' && last.items.map((item) => [item.message.id, item.hidden])).toEqual([
      ['o2', true],
      ['r2', false],
    ]);
  });
});

describe('story state', () => {
  const stateful = { characters: [character('xy', { stateSchema: SCHEMA })] };
  const messages = [
    said('o1', 10),
    reply('r1', 20, { stateOps: [{ key: 'hp', op: 'delta', value: -2 }] }),
    said('o2', 30),
    reply('r2', 40, { stateOps: [{ key: 'bag', op: 'add', value: '铜钥匙' }, { key: 'hp', op: 'delta', value: -20 }] }),
  ];

  it('folds model ops and anchored user ops for a direct companion chat', () => {
    const index = indexOf({ messages }, { ...stateful, chats: [chatView('direct', { userStateOps: [{ key: 'hp', op: 'delta', value: 1, after: 'r1' }] })] });
    expect(chatStateOf(index, direct)).toMatchObject({ active: true, values: { hp: 0, bag: ['铜钥匙'] } });
    expect(chatStateOf(index, direct, 'r2').values).toEqual({ hp: 9, bag: [] });
    expect(chatStateOf(index, direct).schema.map((field) => field.key)).toEqual(['hp', 'bag']);
  });

  it('reports what a reply really changed, after clamps', () => {
    const index = indexOf({ messages }, stateful);
    const items = soulItems(index, 'direct');
    expect(replyEffects(index, direct, items[1]!)).toEqual([{ key: 'hp', label: '生命', kind: 'number', delta: -2, value: 8 }]);
    expect(replyEffects(index, direct, items[3]!)).toEqual([
      { key: 'bag', label: '背包', kind: 'list', added: ['铜钥匙'], removed: [], value: ['铜钥匙'] },
      { key: 'hp', label: '生命', kind: 'number', delta: -8, value: 0 },
    ]);
    expect(replyEffects(index, direct, items[0]!)).toEqual([]);
  });

  it('is inactive without a schema, in work mode and in rooms', () => {
    expect(chatStateOf(indexOf({ messages }), direct)).toEqual({ schema: [], values: {}, active: false });
    const workMode = indexOf({ messages }, { ...stateful, chats: [chatView('direct', { mode: 'work' })] });
    expect(chatStateOf(workMode, direct).active).toBe(false);
    expect(replyEffects(workMode, direct, soulItems(workMode, 'direct')[1]!)).toEqual([]);
    const rooms = indexOf({}, { characters: [character('xy', { stateSchema: SCHEMA }), character('helper', { stateSchema: SCHEMA })] });
    expect(chatStateOf(rooms, roomChat).active).toBe(false);
  });
});

describe('turn gates', () => {
  it('derives typing from the active chat task only', () => {
    const queued = indexOf({ tasks: [task('t-chat', { status: 'queued', participantIds: ['xy'] })] });
    expect(activeChatTask(queued, 'direct')?.id).toBe('t-chat');
    expect(typingAgents(queued, 'direct')).toEqual(['xy']);
    const running = indexOf({
      conversations: [direct, work, roomChat],
      tasks: [task('t-chat', { conversationId: 'room', status: 'running', participantIds: ['xy', 'helper'], nextParticipant: 0 })],
      attempts: [attempt({ agentSnapshot: helper })],
    });
    expect(typingAgents(running, 'room')).toEqual(['helper']);
    const workOnly = indexOf({ tasks: [task('t-work', { kind: 'discussion', status: 'running' })] });
    expect(activeChatTask(workOnly, 'direct')).toBeNull();
    expect(typingAgents(workOnly, 'direct')).toEqual([]);
  });

  it('offers retry for the newest chat task when it failed and nothing runs', () => {
    const asked = message('o1', { createdAt: 1, taskId: 't1', soul: { kind: 'chat' } });
    const failed = indexOf({ messages: [asked], tasks: [task('t1', { status: 'failed', createdAt: 1 })] });
    expect(retryableChatTask(failed, 'direct')?.id).toBe('t1');
    const newer = indexOf({ messages: [asked], tasks: [task('t1', { status: 'failed', createdAt: 1 }), task('t2', { status: 'queued', createdAt: 2 })] });
    expect(retryableChatTask(newer, 'direct')).toBeNull();
    const work = indexOf({ tasks: [task('t1', { kind: 'discussion', status: 'failed' })] });
    expect(retryableChatTask(work, 'direct')).toBeNull();
    // A later turn answered (completed tasks leave the snapshot): the failed one no longer owns the newest slot.
    const overtaken = indexOf({
      messages: [asked, message('o2', { createdAt: 5, taskId: 't2', soul: { kind: 'chat' } }), reply('r2', 6, {}, { taskId: 't2' })],
      tasks: [task('t1', { status: 'failed', createdAt: 1 })],
    });
    expect(retryableChatTask(overtaken, 'direct')).toBeNull();
    // A failed 接着说 (no owner line) stays retryable until something newer is said.
    const orphan = task('t3', { status: 'failed', createdAt: 10, soul: { directive: 'continue', hiddenOwner: true } });
    expect(retryableChatTask(indexOf({ messages: [asked], tasks: [orphan] }), 'direct')?.id).toBe('t3');
    expect(retryableChatTask(indexOf({ messages: [asked, said('o4', 20)], tasks: [orphan] }), 'direct')).toBeNull();
  });

  it('shows nobody typing while a queued turn waits behind another task of the conversation or a pause', () => {
    const queued = task('t-chat', { status: 'queued', createdAt: 5 });
    const behind = indexOf({ tasks: [task('t-work', { kind: 'discussion', status: 'running', createdAt: 1 }), queued] });
    expect(activeChatTask(behind, 'direct')?.id).toBe('t-chat');
    expect(typingAgents(behind, 'direct')).toEqual([]);
    const alone = indexOf({ tasks: [queued] });
    expect(typingAgents(alone, 'direct')).toEqual(['xy']);
    expect(typingAgents(alone, 'direct', true)).toEqual([]);
  });

  it('allows 换个说法 only on the newest visible agent chat reply while idle and below the variant cap', () => {
    const messages = [said('o1', 10), reply('r1', 20)];
    const index = indexOf({ messages });
    const items = soulItems(index, 'direct');
    expect(canRegenerate(index, 'direct', items[1]!)).toBe(true);
    expect(canRegenerate(index, 'direct', items[0]!)).toBe(false); // an owner message, and not the newest
    const later = indexOf({ messages: [...messages, said('o2', 30)] });
    expect(canRegenerate(later, 'direct', soulItems(later, 'direct')[1]!)).toBe(false);
    const busy = indexOf({ messages, tasks: [task('t-chat', { status: 'running' })] });
    expect(canRegenerate(busy, 'direct', soulItems(busy, 'direct')[1]!)).toBe(false);
    const greeting = indexOf({ messages: [message('g0', { senderId: 'xy', soul: { kind: 'greeting', greetingIndex: 0 } })] });
    expect(canRegenerate(greeting, 'direct', soulItems(greeting, 'direct')[0]!)).toBe(false);
    const variants = Array.from({ length: 11 }, (_, n) => reply(`r1v${n}`, 30 + n, { variantOf: 'r1' }));
    const full = indexOf({ messages: [...messages, ...variants] });
    expect(canRegenerate(full, 'direct', soulItems(full, 'direct')[1]!)).toBe(false);
    const workMode = indexOf({ messages }, { chats: [chatView('direct', { mode: 'work' })] });
    expect(canRegenerate(workMode, 'direct', soulItems(workMode, 'direct')[1]!)).toBe(false);
  });
});

describe('relationship, preview and status', () => {
  it('counts days from the first direct conversation and visible non-story items', () => {
    const met = new Date(2026, 10, 12, 23, 30).getTime();
    const index = indexOf({
      conversations: [{ ...direct, createdAt: met }, { ...direct, id: 'direct-2', createdAt: NOW - HOUR }, work, roomChat],
      messages: [
        said('o1', 10),
        reply('r1', 20),
        said('hidden', 30, { hidden: true }),
        message('roll', { createdAt: 40, soul: { kind: 'roll' } }),
        reply('r2', 50, {}, { conversationId: 'direct-2' }),
      ],
    });
    expect(relationshipFacts(index, 'xy', NOW)).toEqual({ firstMetAt: met, days: 3, messages: 3 });
    expect(relationshipFacts(index, 'nobody', NOW)).toEqual({ firstMetAt: null, days: 0, messages: 0 });
  });

  it('previews typing, else the newest visible line, else empty', () => {
    const typing = indexOf({ messages: [reply('r1', 20)], tasks: [task('t-chat', { status: 'queued' })] });
    expect(soulPreview(typing, direct)).toEqual({ kind: 'working', agentId: 'xy' });
    const text = indexOf({ messages: [reply('r1', 20, { mood: '开心' }, { content: '*笑* 你来啦' }), said('o1', 30, { hidden: true })] });
    expect(soulPreview(text, direct)).toEqual({ kind: 'text', text: '笑 你来啦', sender: 'xy' });
    expect(soulPreview(indexOf(), direct)).toEqual({ kind: 'empty' });
  });

  it('shows typing, failed, a fresh mood, the tagline, else nothing', () => {
    expect(headerStatus(indexOf({ tasks: [task('t-chat', { status: 'running' })] }), direct, NOW)).toEqual({ kind: 'typing', agentIds: ['xy'] });
    const asked = message('o1', { taskId: 't-chat', soul: { kind: 'chat' } });
    expect(headerStatus(indexOf({ messages: [asked], tasks: [task('t-chat', { status: 'failed' })] }), direct, NOW)).toEqual({ kind: 'failed' });
    // Held behind a running work task of the same chat: nobody is typing yet.
    const held = indexOf({ tasks: [task('t-work', { kind: 'discussion', status: 'running' }), task('t-chat', { status: 'queued', createdAt: 2 })] });
    expect(headerStatus(held, direct, NOW)).toEqual({ kind: 'tagline', text: '窗边工作室' });
    const moody = indexOf({ messages: [reply('r1', NOW - HOUR, { mood: '有点困' })] });
    expect(headerStatus(moody, direct, NOW)).toEqual({ kind: 'mood', text: '有点困' });
    const stale = indexOf({ messages: [reply('r1', NOW - 25 * HOUR, { mood: '有点困' })] });
    expect(headerStatus(stale, direct, NOW)).toEqual({ kind: 'tagline', text: '窗边工作室' });
    expect(headerStatus(indexOf(), work, NOW)).toEqual({ kind: 'none' });
  });

  it('asks for a reachout row in an idle direct companion chat quiet for over six hours', () => {
    expect(needsReachoutRow(indexOf({ messages: [reply('r1', NOW - 7 * HOUR)] }), direct, NOW)).toBe(true);
    expect(needsReachoutRow(indexOf({ messages: [reply('r1', NOW - 5 * HOUR)] }), direct, NOW)).toBe(false);
    expect(needsReachoutRow(indexOf(), direct, NOW)).toBe(false);
    const busy = indexOf({ messages: [reply('r1', NOW - 7 * HOUR)], tasks: [task('t-chat', { status: 'queued' })] });
    expect(needsReachoutRow(busy, direct, NOW)).toBe(false);
    const workMode = indexOf({ messages: [message('w', { createdAt: NOW - 7 * HOUR, conversationId: 'work' })] });
    expect(needsReachoutRow(workMode, work, NOW)).toBe(false);
  });
});

describe('memory', () => {
  it('groups pending candidates by the reply that proposed them', () => {
    const candidate = { ...stamp, taskId: 't', attemptId: 'r1', content: '周六去书摊', dataClass: 'standard' as const, kind: 'promise' as const };
    const index = indexOf({
      memoryCandidates: [
        { ...candidate, id: 'c1', status: 'pending', sourceMessageId: 'r1' },
        { ...candidate, id: 'c2', status: 'dismissed', sourceMessageId: 'r1' },
        { ...candidate, id: 'c3', status: 'pending' },
      ],
    });
    expect(pendingCandidates(index, 'r1').map((item) => item.id)).toEqual(['c1']);
    expect(pendingCandidates(index, 'other')).toEqual([]);
  });

  it('lists promises: active by due date (undated last), then kept ones', () => {
    const memory = (id: string, extra: Partial<PaMemory>): PaMemory => ({ ...stamp, id, content: id, source: 's', scope: 'agent', scopeId: 'xy', kind: 'promise', ...extra });
    const index = indexOf({
      memories: [
        memory('undated', { dueAt: null }),
        memory('later', { dueAt: NOW + 48 * HOUR }),
        memory('soon', { dueAt: NOW + HOUR }),
        memory('kept', { validUntil: NOW - HOUR }),
        memory('fact', { kind: 'fact' }),
        memory('other-agent', { scopeId: 'helper' }),
      ],
    });
    expect(promisesFor(index, 'xy', NOW).map((item) => item.id)).toEqual(['soon', 'later', 'undated', 'kept']);
  });

  it('finds an installed starter by its origin', () => {
    const index = indexOf({}, { characters: [character('xy', {}, { origin: { format: 'starter', name: 'xiaoyue', importedAt: 1 } })] });
    expect(installedStarter(index, 'xiaoyue')).toEqual({ agentId: 'xy' });
    expect(installedStarter(index, 'storyteller')).toBeNull();
  });
});

describe('sprites (stage 2)', () => {
  const asset = (n: number) => `0000000${n}-0000-4000-8000-000000000000.webp`;
  const sprites = { neutral: asset(1), happy: asset(2), shy: asset(3) };
  const withSprites = (messages: PaMessage[], extra: Partial<PaSoulSnapshot> = {}) =>
    indexOf({ messages }, { characters: [character('xy', { sprites })], ...extra });

  it('takes the emotion of the newest visible reply of that agent within 24 hours', () => {
    expect(emotionOfReply(withSprites([reply('r1', NOW - HOUR, { mood: '开心' })]), 'direct', 'xy', NOW)).toBe('happy');
    // the newest visible reply wins; a hidden newer one and the owner's lines do not count
    const layered = withSprites([
      reply('r1', NOW - 3 * HOUR, { mood: '开心' }),
      reply('r2', NOW - 2 * HOUR, { mood: '害羞地笑' }),
      reply('r3', NOW - HOUR, { mood: '生气', hidden: true }),
      said('o1', NOW - 30 * 60_000, { mood: '难过' }),
    ]);
    expect(emotionOfReply(layered, 'direct', 'xy', NOW)).toBe('shy');
    // the selected variant is the reply
    const variants = withSprites([reply('r1', NOW - HOUR, { mood: '开心', activeVariant: 'r1b' }), reply('r1b', NOW - HOUR + 1000, { mood: '有点困', variantOf: 'r1' })]);
    expect(emotionOfReply(variants, 'direct', 'xy', NOW)).toBe('sleepy');
    expect(emotionOfReply(withSprites([reply('r1', NOW - 25 * HOUR, { mood: '开心' })]), 'direct', 'xy', NOW)).toBe('neutral');
    expect(emotionOfReply(withSprites([reply('r1', NOW - HOUR)]), 'direct', 'xy', NOW)).toBe('neutral');
    expect(emotionOfReply(withSprites([]), 'direct', 'xy', NOW)).toBe('neutral');
    expect(emotionOfReply(withSprites([reply('r1', NOW - HOUR, { mood: '开心' })]), 'direct', 'helper', NOW)).toBe('neutral');
  });

  it('draws the standing picture of a direct chat: the emotion, then neutral, then the portrait, never a jump', () => {
    expect(stageSpriteSrc(withSprites([reply('r1', NOW - HOUR, { mood: '开心' })]), direct, NOW)).toBe(`/api/pa/soul/assets/${asset(2)}`);
    expect(stageSpriteSrc(withSprites([reply('r1', NOW - HOUR, { mood: '生气' })]), direct, NOW)).toBe(`/api/pa/soul/assets/${asset(1)}`);
    // a mood without an image and no 平静: the portrait, else an empty column (the stage stays, so nothing jumps)
    const noNeutral = indexOf({ messages: [reply('r1', NOW - HOUR, { mood: '生气' })] }, { characters: [character('xy', { sprites: { happy: asset(2) } })] });
    expect(stageSpriteSrc(noNeutral, direct, NOW)).toBe('');
    const withPortrait = indexOf(
      { messages: [reply('r1', NOW - HOUR, { mood: '生气' })] },
      { characters: [character('xy', { sprites: { happy: asset(2) }, portraitAssetId: asset(3) })] },
    );
    expect(stageSpriteSrc(withPortrait, direct, NOW)).toBe(`/api/pa/soul/assets/${asset(3)}`);
    expect(stageSpriteSrc(indexOf({ messages: [reply('r1', NOW - HOUR, { mood: '开心' })] }), direct, NOW)).toBeNull();
    // a stage 1 row without `sprites`
    const legacy = { ...character('xy') } as Partial<PaCharacterView>;
    delete legacy.sprites;
    expect(stageSpriteSrc(indexOf({}, { characters: [legacy as PaCharacterView] }), direct, NOW)).toBeNull();
    expect(stageSpriteSrc(withSprites([]), roomChat, NOW)).toBeNull();
  });
});
