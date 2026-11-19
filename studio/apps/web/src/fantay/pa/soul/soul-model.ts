// SPDX-License-Identifier: AGPL-3.0-only
// Fantay Soul: pure adapters from the PA index to the shared rules of "@open-design/contracts/soul". No React, no I/O.
// Mode, variants, context and the state fold are never re-implemented here; they come from the engine, so the web
// and the daemon agree by construction.
import {
  PA_DEFAULT_CHAT_SETTINGS,
  PA_DEFAULT_PRESET_ID,
  SOUL_LIMITS,
  chatStateSlots,
  emotionOf,
  foldChatState,
  messageAt,
  opEffects,
  resolveAppearance,
  resolveChatMode,
  resolveNames,
  resolvePreset,
  spriteFor,
  stateRecord,
  visibleSlots,
} from '@open-design/contracts/soul';
import type { PaEmotion, PaResolvedAppearance, PaStateField, PaStateValue, StateEffect, StateSlot } from '@open-design/contracts/soul';

import { paSoulAssetUrl } from '../pa-api';
import { buildTurns, conversationKind, isChatTask, previewText } from '../pa-model';
import type {
  PaCharacterView,
  PaChatView,
  PaConversation,
  PaGroup,
  PaIndex,
  PaMemory,
  PaMemoryCandidate,
  PaMessage,
  PaPreview,
  PaSprites,
  PaStylePreset,
  PaTask,
  PaTurn,
} from '../pa-types';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MOOD_FRESH_MS = 24 * HOUR;
const REACHOUT_GAP_MS = 6 * HOUR;
const EMPTY: never[] = [];

// ---------------------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------------------

/** One default view per index and conversation, so a consumer that compares by identity sees a stable object. */
const defaultChats = new WeakMap<PaIndex, Map<string, PaChatView>>();

/** The chat view of a conversation; the defaults with `revision: 0` when it has no settings row. */
export function chatOf(index: PaIndex, conversationId: string): PaChatView {
  const stored = index.chats.get(conversationId);
  if (stored) return stored;
  let cache = defaultChats.get(index);
  if (!cache) {
    cache = new Map();
    defaultChats.set(index, cache);
  }
  let chat = cache.get(conversationId);
  if (!chat) {
    chat = {
      id: conversationId,
      createdAt: 0,
      updatedAt: 0,
      revision: 0,
      ...PA_DEFAULT_CHAT_SETTINGS,
      lorebookIds: [],
      disabledLoreEntryIds: [],
      appearance: {},
      activeEvent: null,
      candidateEvent: null,
      branchOf: null,
      userStateOps: [],
    };
    cache.set(conversationId, chat);
  }
  return chat;
}

function groupOf(index: PaIndex, conversation: PaConversation): PaGroup | null {
  return index.groupByConversation.get(conversation.id) ?? (conversation.groupId ? index.groups.get(conversation.groupId) ?? null : null);
}

/** `resolveChatMode` over the index: in enterprise mode a conversation no member owns is a shared work room; then the
 *  explicit chat mode, then channel (work unless the channel's 聊天模式 is on), then "every member has a card". */
export function conversationMode(index: PaIndex, conversation: PaConversation): 'work' | 'companion' {
  const group = groupOf(index, conversation);
  return resolveChatMode({
    sharedRoom: index.enterprise && !conversation.principalId,
    explicit: index.chats.get(conversation.id)?.mode ?? null,
    channel: Boolean(conversation.channelId),
    channelCompanion: conversation.channelId ? index.channels.get(conversation.channelId)?.chatMode === 'companion' : false,
    memberIds: group ? group.memberIds : conversation.groupId ? [] : null,
    agentId: conversation.agentId,
    hasCard: (agentId) => index.characters.has(agentId),
  });
}

export function characterOf(index: PaIndex, agentId: string | null | undefined): PaCharacterView | null {
  return agentId ? index.characters.get(agentId) ?? null : null;
}

/** The URL of an agent's character portrait, or null (group clusters draw it in place of the paper face). */
export function portraitSrc(index: PaIndex, agentId: string): string | null {
  return paSoulAssetUrl(characterOf(index, agentId)?.portraitAssetId);
}

/** The character's nickname, else the agent name (the engine's `{{char}}` rule). */
export function displayName(index: PaIndex, agentId: string): string {
  const agentName = index.agents.get(agentId)?.name ?? '';
  return resolveNames({ agentName, nickname: characterOf(index, agentId)?.nickname ?? null, locale: 'zh' }).char;
}

/** The direct conversation's character (groups have none of their own). */
function directCharacter(index: PaIndex, conversation: PaConversation): PaCharacterView | null {
  return conversationKind(conversation) === 'direct' ? characterOf(index, conversation.agentId) : null;
}

/** Daemon `personaFor`: the chat's persona, else the character's pin (direct chats), else the default persona. */
export function personaFor(index: PaIndex, conversation: PaConversation): { id: string | null; name: string; description: string } {
  const chat = chatOf(index, conversation.id);
  const pinned = directCharacter(index, conversation)?.personaId ?? null;
  const persona =
    (chat.personaId ? index.personas.get(chat.personaId) : undefined) ??
    (pinned ? index.personas.get(pinned) : undefined) ??
    index.defaultPersona;
  return persona ? { id: persona.id, name: persona.name, description: persona.description } : { id: null, name: '', description: '' };
}

/** Daemon `presetFor`: the chat's preset, else the speaker's character default, else 真人聊天. `index.presets` holds the
 *  built-ins in the UI's prompt locale plus the user presets. */
export function presetFor(index: PaIndex, conversation: PaConversation, agentId?: string): PaStylePreset {
  const chat = chatOf(index, conversation.id);
  const character = characterOf(index, agentId ?? (conversationKind(conversation) === 'direct' ? conversation.agentId : null));
  const ref = chat.presetId ?? character?.presetId ?? null;
  return (ref ? index.presets.get(ref) : undefined) ?? index.presets.get(PA_DEFAULT_PRESET_ID) ?? resolvePreset(null, [], 'zh');
}

/** Theme layers: default < the direct character's appearance < the chat's appearance. */
export function resolveChatAppearance(index: PaIndex, conversation: PaConversation): PaResolvedAppearance {
  return resolveAppearance(directCharacter(index, conversation)?.appearance, chatOf(index, conversation.id).appearance);
}

// ---------------------------------------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------------------------------------

export interface PaSoulItem {
  slotId: string;
  message: PaMessage;
  root: PaMessage;
  variants: PaMessage[];
  /** 0-based. Greetings count the card's greetings (`greetingIndex`); other slots count their stored variants. */
  variantIndex: number;
  variantCount: number;
  role: 'owner' | 'agent' | 'story' | 'greeting';
  hidden: boolean;
  at: number;
}

export type PaSoulTurn =
  | { kind: 'chat'; key: string; items: PaSoulItem[]; startedAt: number }
  | { kind: 'work'; key: string; turn: PaTurn; startedAt: number };

const STORY_KINDS = new Set(['roll', 'draw', 'event']);

function roleOf(message: PaMessage): PaSoulItem['role'] {
  const kind = message.soul?.kind;
  if (kind && STORY_KINDS.has(kind)) return 'story';
  if (message.senderId === 'owner') return 'owner';
  return kind === 'greeting' ? 'greeting' : 'agent';
}

const itemsCache = new WeakMap<PaIndex, Map<string, PaSoulItem[]>>();

/** Every slot of the conversation in time order (the engine's `visibleSlots`), hidden slots included. */
export function soulItems(index: PaIndex, conversationId: string): PaSoulItem[] {
  let cache = itemsCache.get(index);
  if (!cache) {
    cache = new Map();
    itemsCache.set(index, cache);
  }
  const cached = cache.get(conversationId);
  if (cached) return cached;
  const items = visibleSlots(index.messagesByConversation.get(conversationId) ?? EMPTY).map((slot): PaSoulItem => {
    const greeting = slot.root.soul?.kind === 'greeting' ? slot.root.soul.greetingIndex : undefined;
    let variantIndex = Math.max(0, slot.variants.indexOf(slot.selected));
    let variantCount = slot.variants.length;
    if (greeting !== undefined) {
      variantCount = 1 + (characterOf(index, slot.root.senderId)?.alternateGreetings.length ?? 0);
      variantIndex = Math.min(Math.max(0, greeting), variantCount - 1);
    }
    return {
      slotId: slot.slotId,
      message: slot.selected,
      root: slot.root,
      variants: slot.variants,
      variantIndex,
      variantCount,
      role: roleOf(slot.selected),
      hidden: slot.hidden,
      at: slot.at,
    };
  });
  cache.set(conversationId, items);
  return items;
}

/** A message of a work task (present in the snapshot with kind !== 'chat') belongs to that task's work turn. */
function workTaskOf(index: PaIndex, message: PaMessage): PaTask | null {
  return message.taskId ? index.workTasks.get(message.taskId) ?? null : null;
}

/** The companion transcript: consecutive soul items form one chat turn; each work task is one work turn (today's
 *  `PaTurn`) at the time of its first message. Turns are ordered by `startedAt`. */
export function soulTurns(index: PaIndex, conversationId: string): PaSoulTurn[] {
  const entries: Array<{ at: number; item?: PaSoulItem; turn?: PaTurn }> = [];
  for (const item of soulItems(index, conversationId)) if (!workTaskOf(index, item.message)) entries.push({ at: item.at, item });
  for (const turn of buildTurns(index, conversationId))
    if (turn.task && index.workTasks.has(turn.task.id)) entries.push({ at: turn.startedAt, turn });
  const ordered = entries.map((entry, order) => ({ entry, order })).sort((a, b) => a.entry.at - b.entry.at || a.order - b.order);
  const turns: PaSoulTurn[] = [];
  let open: Extract<PaSoulTurn, { kind: 'chat' }> | null = null;
  for (const { entry } of ordered) {
    if (entry.item) {
      if (!open) {
        open = { kind: 'chat', key: `c:${entry.item.slotId}`, items: [], startedAt: entry.item.at };
        turns.push(open);
      }
      open.items.push(entry.item);
    } else if (entry.turn) {
      open = null;
      turns.push({ kind: 'work', key: entry.turn.key, turn: entry.turn, startedAt: entry.turn.startedAt });
    }
  }
  return turns;
}

// ---------------------------------------------------------------------------------------------------------
// Story state
// ---------------------------------------------------------------------------------------------------------

const slotsCache = new WeakMap<PaIndex, Map<string, StateSlot[]>>();

function stateSlotsOf(index: PaIndex, conversationId: string): StateSlot[] {
  let cache = slotsCache.get(index);
  if (!cache) {
    cache = new Map();
    slotsCache.set(index, cache);
  }
  let slots = cache.get(conversationId);
  if (!slots) {
    slots = chatStateSlots(index.messagesByConversation.get(conversationId) ?? EMPTY);
    cache.set(conversationId, slots);
  }
  return slots;
}

/** The state schema in force: a direct companion chat whose character defines one; otherwise none. */
function activeSchema(index: PaIndex, conversation: PaConversation): PaStateField[] {
  if (conversationKind(conversation) !== 'direct' || conversationMode(index, conversation) !== 'companion') return EMPTY;
  return directCharacter(index, conversation)?.stateSchema ?? EMPTY;
}

/** Folded story state, up to (not including) `upToSlotId` when given. `active` only for a direct companion chat whose
 *  character has a non-empty schema; otherwise the schema is empty and so are the values. */
export function chatStateOf(
  index: PaIndex,
  conversation: PaConversation,
  upToSlotId?: string,
): { schema: PaStateField[]; values: Record<string, PaStateValue>; active: boolean } {
  const schema = activeSchema(index, conversation);
  if (schema.length === 0) return { schema: EMPTY, values: {}, active: false };
  const folded = foldChatState(
    schema,
    stateSlotsOf(index, conversation.id),
    chatOf(index, conversation.id).userStateOps,
    upToSlotId !== undefined ? { upTo: upToSlotId } : undefined,
  );
  return { schema, values: stateRecord(folded), active: true };
}

/** What a reply's state ops really changed (the delta line under it), against the state before its slot. */
export function replyEffects(index: PaIndex, conversation: PaConversation, item: PaSoulItem): StateEffect[] {
  const ops = item.message.soul?.stateOps ?? EMPTY;
  if (ops.length === 0) return EMPTY;
  const schema = activeSchema(index, conversation);
  if (schema.length === 0) return EMPTY;
  const before = foldChatState(schema, stateSlotsOf(index, conversation.id), chatOf(index, conversation.id).userStateOps, {
    upTo: item.slotId,
  });
  return opEffects(schema, before, ops, 'model');
}

// ---------------------------------------------------------------------------------------------------------
// Turn gates
// ---------------------------------------------------------------------------------------------------------

function chatTasks(index: PaIndex, conversationId: string): PaTask[] {
  return (index.tasksByConversation.get(conversationId) ?? EMPTY).filter(isChatTask);
}

/** The newest chat task of the conversation that is queued or running. */
export function activeChatTask(index: PaIndex, conversationId: string): PaTask | null {
  const tasks = chatTasks(index, conversationId);
  for (let i = tasks.length - 1; i >= 0; i -= 1) {
    const task = tasks[i]!;
    if (task.status === 'queued' || task.status === 'running') return task;
  }
  return null;
}

const HOLDS_SLOT = new Set<PaTask['status']>(['running', 'verifying', 'cancelling']);

/** A queued turn the daemon cannot start yet: its `pump` runs one task per conversation, so an earlier queued task or
 *  any running one of the same conversation (a long work task handed over with 作为任务交给 TA) holds it back.
 *  `tasks` are the conversation's tasks. */
export function heldBehind(task: PaTask, tasks: readonly PaTask[]): boolean {
  if (task.status !== 'queued') return false;
  return tasks.some((other) => other.id !== task.id
    && (HOLDS_SLOT.has(other.status) || (other.status === 'queued' && other.createdAt < task.createdAt)));
}

/** Who is typing: the running attempt's agent of the active chat task, else its next participant. Derived state only;
 *  the transcript draws the typing bubble as its own element and never synthesises a message for it. A queued turn
 *  that is held back (another task of the conversation first, or PA paused) shows nobody typing: the character is not
 *  doing anything yet (honest indicators). */
export function typingAgents(index: PaIndex, conversationId: string, paused = false): string[] {
  const task = activeChatTask(index, conversationId);
  if (!task) return EMPTY;
  if (task.status === 'queued' && (paused || heldBehind(task, index.tasksByConversation.get(conversationId) ?? EMPTY))) return EMPTY;
  const attempts = index.attemptsByTask.get(task.id) ?? EMPTY;
  for (let i = attempts.length - 1; i >= 0; i -= 1) if (attempts[i]!.status === 'running') return [attempts[i]!.agentSnapshot.id];
  const next = task.participantIds[task.nextParticipant];
  return next ? [next] : EMPTY;
}

/** The newest chat task when it failed, no chat task is active and it still owns the newest visible slot (重试 =
 *  `resumeTask`). The slot test is the daemon's `assertResumable`, so a turn overtaken by a later reply is never
 *  offered 重试 (completed turns leave the snapshot, so "newest task" alone would stay failed forever). */
export function retryableChatTask(index: PaIndex, conversationId: string): PaTask | null {
  if (activeChatTask(index, conversationId)) return null;
  const newest = chatTasks(index, conversationId).at(-1);
  if (newest?.status !== 'failed') return null;
  const visible = soulItems(index, conversationId).filter((item) => !item.hidden);
  const stale = newest.soul?.hiddenOwner
    ? visible.some((item) => item.message.taskId !== newest.id && messageAt(item.message) > newest.createdAt)
    : visible[visible.length - 1]?.message.taskId !== newest.id;
  return stale ? null : newest;
}

/** 换个说法: the newest slot of a companion chat, a visible agent chat reply, no chat turn running, variants left. */
export function canRegenerate(index: PaIndex, conversationId: string, item: PaSoulItem): boolean {
  const conversation = index.conversations.get(conversationId);
  if (!conversation || conversationMode(index, conversation) !== 'companion') return false;
  const items = soulItems(index, conversationId);
  if (items[items.length - 1]?.slotId !== item.slotId || item.hidden) return false;
  if (item.message.senderId === 'owner' || item.message.soul?.kind !== 'chat') return false;
  if (activeChatTask(index, conversationId)) return false;
  return item.variants.length < SOUL_LIMITS.variantsPerSlot;
}

// ---------------------------------------------------------------------------------------------------------
// Relationship and status
// ---------------------------------------------------------------------------------------------------------

function startOfLocalDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** 认识第 N 天 · N 条消息: from the agent's direct conversations. `messages` counts visible, non-story items. */
export function relationshipFacts(index: PaIndex, agentId: string, now: number): { firstMetAt: number | null; days: number; messages: number } {
  const conversations = index.directByAgent.get(agentId) ?? EMPTY;
  if (conversations.length === 0) return { firstMetAt: null, days: 0, messages: 0 };
  const firstMetAt = Math.min(...conversations.map((conversation) => conversation.createdAt));
  const days = Math.max(0, Math.round((startOfLocalDay(now) - startOfLocalDay(firstMetAt)) / DAY)) + 1;
  let messages = 0;
  for (const conversation of conversations)
    for (const item of soulItems(index, conversation.id)) if (!item.hidden && item.role !== 'story') messages += 1;
  return { firstMetAt, days, messages };
}

function newestVisible(index: PaIndex, conversationId: string, accept: (item: PaSoulItem) => boolean = () => true): PaSoulItem | null {
  const items = soulItems(index, conversationId);
  for (let i = items.length - 1; i >= 0; i -= 1) if (!items[i]!.hidden && accept(items[i]!)) return items[i]!;
  return null;
}

/** The roster second line of a companion chat: typing while a chat turn is queued or running (the UI prints
 *  正在输入…), else the newest visible line, else empty. */
export function soulPreview(index: PaIndex, conversation: PaConversation, paused = false): PaPreview {
  const typing = typingAgents(index, conversation.id, paused);
  if (typing.length > 0) return { kind: 'working', agentId: typing[0] ?? '' };
  const item = newestVisible(index, conversation.id);
  return item ? { kind: 'text', text: previewText(item.message.content), sender: item.message.senderId } : { kind: 'empty' };
}

/** The chat header's status line. Never "online". */
export function headerStatus(
  index: PaIndex,
  conversation: PaConversation,
  now: number,
  paused = false,
): { kind: 'typing'; agentIds: string[] } | { kind: 'failed' } | { kind: 'mood'; text: string } | { kind: 'tagline'; text: string } | { kind: 'none' } {
  const typing = typingAgents(index, conversation.id, paused);
  if (typing.length > 0) return { kind: 'typing', agentIds: typing };
  if (retryableChatTask(index, conversation.id)) return { kind: 'failed' };
  const reply = newestVisible(index, conversation.id, (item) => item.role === 'agent');
  const mood = reply?.message.soul?.mood?.trim();
  if (reply && mood && now - messageAt(reply.message) < MOOD_FRESH_MS) return { kind: 'mood', text: mood };
  const tagline = directCharacter(index, conversation)?.tagline.trim();
  return tagline ? { kind: 'tagline', text: tagline } : { kind: 'none' };
}

// ---------------------------------------------------------------------------------------------------------
// Sprites (stage 2)
// ---------------------------------------------------------------------------------------------------------

/** The emotion of the agent's newest visible reply in the conversation when it is younger than 24 h; else 'neutral'.
 *  The same reply and window as the header's mood line; a running turn keeps the last stored reply's emotion. */
export function emotionOfReply(index: PaIndex, conversationId: string, agentId: string, now: number): PaEmotion {
  const reply = freshReplyOf(index, conversationId, agentId, now);
  return reply ? emotionOf(reply.message.soul?.mood) : 'neutral';
}

/** The mood word the character wrote in the reply `emotionOfReply` reads, while it is fresh; null otherwise. */
export function replyMood(index: PaIndex, conversationId: string, agentId: string, now: number): string | null {
  return freshReplyOf(index, conversationId, agentId, now)?.message.soul?.mood?.trim() || null;
}

/** The agent's newest visible reply when it is younger than the mood window (the header's mood line uses the same). */
function freshReplyOf(index: PaIndex, conversationId: string, agentId: string, now: number): PaSoulItem | null {
  const reply = newestVisible(index, conversationId, (item) => item.role === 'agent' && item.message.senderId === agentId);
  return reply && now - messageAt(reply.message) < MOOD_FRESH_MS ? reply : null;
}

/** Which sprite the header, the hero and the standing picture draw for an emotion (`spriteFor`): its own, else 平静,
 *  else none (the portrait). */
export function shownSprite(sprites: PaSprites | null | undefined, emotion: PaEmotion): PaEmotion | null {
  if (sprites?.[emotion]) return emotion;
  return sprites?.neutral ? 'neutral' : null;
}

/** The standing picture of a direct chat whose character has at least one sprite: the sprite for that emotion, else
 *  the neutral sprite, else the portrait (the header's order), else '' (the column stays, empty, so the transcript
 *  never jumps sideways when a reply's mood has no image). Null when there is no stage: not a direct chat, or no
 *  sprite at all. */
export function stageSpriteSrc(index: PaIndex, conversation: PaConversation, now: number): string | null {
  if (conversationKind(conversation) !== 'direct' || !conversation.agentId) return null;
  const character = characterOf(index, conversation.agentId);
  const sprites = character?.sprites;
  if (!sprites || !Object.values(sprites).some(Boolean)) return null;
  const sprite = spriteFor(sprites, emotionOfReply(index, conversation.id, conversation.agentId, now));
  return paSoulAssetUrl(sprite ?? character?.portraitAssetId) ?? '';
}

/** 让 TA 先开口 row: a direct companion chat, idle, whose newest item is older than six hours. */
export function needsReachoutRow(index: PaIndex, conversation: PaConversation, now: number): boolean {
  if (conversationKind(conversation) !== 'direct' || conversationMode(index, conversation) !== 'companion') return false;
  if (activeChatTask(index, conversation.id)) return false;
  const items = soulItems(index, conversation.id);
  const newest = items[items.length - 1];
  if (!newest) return false;
  return now - Math.max(newest.at, messageAt(newest.message)) > REACHOUT_GAP_MS;
}

// ---------------------------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------------------------

/** Pending 想记下 candidates proposed by one reply. */
export function pendingCandidates(index: PaIndex, messageId: string): PaMemoryCandidate[] {
  return index.candidatesByMessage.get(messageId) ?? EMPTY;
}

function fulfilled(memory: PaMemory, now: number): boolean {
  return typeof memory.validUntil === 'number' && memory.validUntil <= now;
}

/** 约定 of a character: active ones first (soonest `dueAt` first, undated last), then kept ones (newest first). */
export function promisesFor(index: PaIndex, agentId: string, now: number): PaMemory[] {
  const promises = [...index.memories.values()].filter(
    (memory) => memory.scope === 'agent' && memory.scopeId === agentId && memory.kind === 'promise',
  );
  const active = promises
    .filter((memory) => !fulfilled(memory, now))
    .sort((a, b) => (a.dueAt ?? Number.POSITIVE_INFINITY) - (b.dueAt ?? Number.POSITIVE_INFINITY) || a.createdAt - b.createdAt);
  const kept = promises.filter((memory) => fulfilled(memory, now)).sort((a, b) => (b.validUntil ?? 0) - (a.validUntil ?? 0));
  return [...active, ...kept];
}

/** The installed character of a starter, matched by its import origin. */
export function installedStarter(index: PaIndex, starterId: string): { agentId: string } | null {
  for (const character of index.characters.values())
    if (character.origin?.format === 'starter' && character.origin.name === starterId) return { agentId: character.id };
  return null;
}
