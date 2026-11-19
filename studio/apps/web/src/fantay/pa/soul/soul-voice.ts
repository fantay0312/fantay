// SPDX-License-Identifier: AGPL-3.0-only
// Fantay Soul, stage 2: voice replies (STAGE2 5.8, 12.1). Three small module-level stores:
//   - `soulAudio`: the one HTMLAudioElement of the app (one message plays at a time) and the 自动朗读 queue;
//   - the speech items per mounted conversation (`useSoulSpeech`): what the daemon has generated, remembered with the
//     message revision and the speaker's voice they were made for, and the generating / failed state of a click;
//   - the speech status (`useSoulSpeechStatus`): one shared read, cached 60 s, re-read on window focus.
// Honesty: a bar exists only for audio the daemon really generated; nothing is synthesised in the browser, and audio is
// generated only on a click or under 自动朗读. No browser speech synthesis, no placeholder sound.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { SOUL_LIMITS, speechText } from '@open-design/contracts/soul';

import { errorToast } from '../PaTurnTail';
import { paSoulSpeechUrl } from '../pa-api';
import { usePa } from '../pa-context';
import type { PaActions, PaConversation, PaIndex, PaMessage, PaSpeechItem, PaSpeechStatus, PaVoice } from '../pa-types';
import { characterOf, chatOf } from './soul-model';

// ---------------------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------------------

export interface SoulAudioState {
  messageId: string | null;
  phase: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  currentTime: number;
  duration: number | null;
  blocked: boolean;
}

const AUDIO_IDLE: SoulAudioState = { messageId: null, phase: 'idle', currentTime: 0, duration: null, blocked: false };

let audioState: SoulAudioState = AUDIO_IDLE;
const audioListeners = new Set<() => void>();
let element: HTMLAudioElement | null = null;
let elementUnavailable = false;
let currentUrl: string | null = null;

/** One queued 自动朗读 message: `run` generates its audio and answers its URL (null when nothing came of it). */
interface AutoItem {
  messageId: string;
  run(): Promise<string | null>;
}
let autoQueue: AutoItem[] = [];
let autoBusy = false;
/** Moves on every pause and stop, so a generation that finishes after the queue was cleared never plays. */
let autoEpoch = 0;

function setAudio(patch: Partial<SoulAudioState>): void {
  const next = { ...audioState, ...patch };
  if (
    next.messageId === audioState.messageId &&
    next.phase === audioState.phase &&
    next.currentTime === audioState.currentTime &&
    next.duration === audioState.duration &&
    next.blocked === audioState.blocked
  )
    return;
  audioState = next;
  for (const listener of [...audioListeners]) listener();
}

function finite(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The app's audio element, created on first use. Null where `Audio` does not exist (a test environment). */
function audioElement(): HTMLAudioElement | null {
  if (element) return element;
  if (elementUnavailable) return null;
  if (typeof Audio === 'undefined') {
    elementUnavailable = true;
    return null;
  }
  let made: HTMLAudioElement;
  try {
    made = new Audio();
  } catch {
    elementUnavailable = true;
    return null;
  }
  made.preload = 'auto';
  const mine = () => audioState.messageId !== null;
  made.addEventListener('loadedmetadata', () => mine() && setAudio({ duration: finite(made.duration) }));
  made.addEventListener('durationchange', () => mine() && setAudio({ duration: finite(made.duration) }));
  made.addEventListener('timeupdate', () => mine() && setAudio({ currentTime: made.currentTime }));
  made.addEventListener('play', () => mine() && audioState.phase !== 'loading' && setAudio({ phase: 'playing', blocked: false }));
  made.addEventListener('playing', () => mine() && setAudio({ phase: 'playing', blocked: false }));
  made.addEventListener('pause', () => {
    // A pause that is the end of the file is followed by `ended`; a pause while a new file loads is the old one's.
    if (mine() && !made.ended && audioState.phase !== 'loading') setAudio({ phase: 'paused' });
  });
  made.addEventListener('ended', () => {
    if (!mine()) return;
    setAudio({ phase: 'idle', currentTime: 0 });
    void pumpAuto();
  });
  made.addEventListener('error', () => {
    if (!mine()) return;
    setAudio({ phase: 'error', blocked: false });
    void pumpAuto();
  });
  element = made;
  return made;
}

async function play(messageId: string, url: string): Promise<boolean> {
  const el = audioElement();
  if (!el) {
    currentUrl = null;
    setAudio({ messageId, phase: 'error', currentTime: 0, duration: null, blocked: false });
    return false;
  }
  if (audioState.messageId !== messageId || currentUrl !== url) {
    currentUrl = url;
    setAudio({ messageId, phase: 'loading', currentTime: 0, duration: null, blocked: false });
    el.src = url;
  } else if (el.ended) {
    // Only a file that played to its end starts over; a seek after the end (phase still idle) plays from there.
    el.currentTime = 0;
  }
  try {
    await el.play();
    if (audioState.messageId === messageId && currentUrl === url && audioState.phase !== 'playing') setAudio({ phase: 'playing', blocked: false });
    return true;
  } catch (error) {
    if (audioState.messageId !== messageId || currentUrl !== url) return false; // another message took over
    const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
    if (name === 'AbortError') return false; // interrupted by a pause or a new source
    if (name === 'NotAllowedError') {
      setAudio({ phase: 'paused', blocked: true });
      return false;
    }
    setAudio({ phase: 'error', blocked: false });
    return false;
  }
}

function clearAuto(): void {
  autoQueue = [];
  autoEpoch += 1;
}

function pause(): void {
  clearAuto();
  element?.pause();
  if (audioState.messageId && (audioState.phase === 'playing' || audioState.phase === 'loading')) setAudio({ phase: 'paused' });
}

/** Starts the next 自动朗读 message when nothing plays: generated first (one at a time), then played. */
async function pumpAuto(): Promise<void> {
  if (autoBusy) return;
  if (audioState.phase !== 'idle' && audioState.phase !== 'error') return;
  const next = autoQueue.shift();
  if (!next) return;
  autoBusy = true;
  const epoch = autoEpoch;
  let url: string | null = null;
  try {
    url = await next.run();
  } catch {
    url = null;
  }
  autoBusy = false;
  if (epoch !== autoEpoch) return;
  if (!url) return pumpAuto();
  if (audioState.phase !== 'idle' && audioState.phase !== 'error') {
    // Something else started while this one was generated: it plays after that one.
    const ready = url;
    autoQueue.unshift({ messageId: next.messageId, run: async () => ready });
    return;
  }
  const started = await play(next.messageId, url);
  if (!started && epoch === autoEpoch && audioState.phase === 'error') void pumpAuto();
}

function enqueueAuto(item: AutoItem): void {
  if (autoQueue.some((queued) => queued.messageId === item.messageId)) return;
  autoQueue.push(item);
  void pumpAuto();
}

export const soulAudio = {
  subscribe(listener: () => void): () => void {
    audioListeners.add(listener);
    return () => {
      audioListeners.delete(listener);
    };
  },
  get(): SoulAudioState {
    return audioState;
  },
  /** False when the browser refused to start (phase 'paused', blocked) or the file could not play. */
  play,
  toggle(messageId: string, url: string): void {
    const same = audioState.messageId === messageId && currentUrl === url;
    if (same && (audioState.phase === 'playing' || audioState.phase === 'loading')) pause();
    else void play(messageId, url);
  },
  /** Pausing also clears the 自动朗读 queue. */
  pause,
  /** Ignored while the duration is unknown. */
  seek(ratio: number): void {
    const el = element;
    const duration = audioState.duration;
    if (!el || duration === null || !audioState.messageId || !Number.isFinite(ratio)) return;
    const at = Math.min(1, Math.max(0, ratio)) * duration;
    el.currentTime = at;
    setAudio({ currentTime: at });
  },
  /** Pause, forget the message, clear the 自动朗读 queue (leaving a conversation). */
  stop(): void {
    clearAuto();
    element?.pause();
    setAudio(AUDIO_IDLE);
  },
};

export function useSoulAudio(): SoulAudioState {
  return useSyncExternalStore(soulAudio.subscribe, soulAudio.get, () => AUDIO_IDLE);
}

// ---------------------------------------------------------------------------------------------------------
// Speech items per conversation
// ---------------------------------------------------------------------------------------------------------

export interface SoulSpeechEntry {
  item: PaSpeechItem | null;
  phase: 'none' | 'generating' | 'ready' | 'failed';
  error: string | null;
}

const SPEECH_NONE: SoulSpeechEntry = { item: null, phase: 'none', error: null };
const SPEECH_GENERATING: SoulSpeechEntry = { item: null, phase: 'generating', error: null };
const REREAD_MS = 300;

interface Remembered {
  item: PaSpeechItem;
  /** The message revision and the speaker's voice the audio was made for. */
  revision: number;
  voice: string;
  addedAt: number;
}

interface SpeechConversation {
  items: Map<string, Remembered>;
  pending: Map<string, { phase: 'generating' | 'failed'; error: string | null }>;
  inflight: Map<string, Promise<void>>;
  autoSeen: Set<string>;
  mounts: number;
  read: 'none' | 'reading' | 'done';
  reread: ReturnType<typeof setTimeout> | null;
  version: number;
}

const conversations = new Map<string, SpeechConversation>();
const speechListeners = new Set<() => void>();

function subscribeSpeech(listener: () => void): () => void {
  speechListeners.add(listener);
  return () => {
    speechListeners.delete(listener);
  };
}

function bump(state: SpeechConversation): void {
  state.version += 1;
  for (const listener of [...speechListeners]) listener();
}

function conversationState(conversationId: string): SpeechConversation {
  let state = conversations.get(conversationId);
  if (!state) {
    state = { items: new Map(), pending: new Map(), inflight: new Map(), autoSeen: new Set(), mounts: 0, read: 'none', reread: null, version: 0 };
    conversations.set(conversationId, state);
  }
  return state;
}

function voiceKey(index: PaIndex, message: PaMessage): string {
  return JSON.stringify(characterOf(index, message.senderId)?.voice ?? null);
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error ?? '');
}

/** `made` is the message revision and voice a generation was asked for; without it, the message's current ones (a
 *  list read: the daemon lists only audio whose text and voice still match). */
function remember(items: Map<string, Remembered>, item: PaSpeechItem, index: PaIndex, at: number, made?: { revision: number; voice: string }): void {
  const message = index.messages.get(item.messageId);
  if (message) items.set(item.messageId, { item, revision: made?.revision ?? message.revision, voice: made?.voice ?? voiceKey(index, message), addedAt: at });
}

/** The ready item of a message: remembered for its current revision and its speaker's current voice. */
function readyItem(state: SpeechConversation | undefined, message: PaMessage, index: PaIndex): PaSpeechItem | null {
  const remembered = state?.items.get(message.id);
  if (!remembered || remembered.revision !== message.revision || remembered.voice !== voiceKey(index, message)) return null;
  return remembered.item;
}

async function readList(conversationId: string, actions: Pick<PaActions, 'listSpeech'>, indexOf: () => PaIndex): Promise<void> {
  const state = conversations.get(conversationId);
  if (!state || state.read === 'reading') return;
  state.read = 'reading';
  const startedAt = Date.now();
  try {
    const items = await actions.listSpeech(conversationId);
    if (conversations.get(conversationId) !== state) return;
    const index = indexOf();
    const next = new Map<string, Remembered>();
    // What a click produced while the list was in flight is newer than the list.
    for (const [id, kept] of state.items) if (kept.addedAt >= startedAt) next.set(id, kept);
    for (const item of Array.isArray(items) ? items : []) if (!next.has(item.messageId)) remember(next, item, index, startedAt - 1);
    state.items = next;
    bump(state);
  } catch {
    // The list only restores bars after a reload; 朗读 still works without it.
  } finally {
    if (conversations.get(conversationId) === state) state.read = 'done';
  }
}

/** Revision rule: an item whose message changed (edited, re-selected) or whose speaker's voice changed is dropped, and
 *  the list is read again 300 ms later (the daemon lists it again when its key still matches). */
function checkRevisions(conversationId: string, index: PaIndex, actions: Pick<PaActions, 'listSpeech'>, indexOf: () => PaIndex): void {
  const state = conversations.get(conversationId);
  if (!state || state.items.size === 0) return;
  let changed = false;
  let stale = false;
  for (const [id, kept] of [...state.items]) {
    const message = index.messages.get(id);
    if (!message) {
      state.items.delete(id);
      changed = true;
    } else if (kept.revision !== message.revision || kept.voice !== voiceKey(index, message)) {
      state.items.delete(id);
      changed = true;
      stale = true;
    }
  }
  if (!changed) return;
  bump(state);
  if (!stale) return;
  if (state.reread) clearTimeout(state.reread);
  state.reread = setTimeout(() => {
    state.reread = null;
    if (conversations.get(conversationId) === state && state.read !== 'reading') void readList(conversationId, actions, indexOf);
  }, REREAD_MS);
}

/** Voice items of one conversation. Several components may call it for the same conversation; they share one store,
 *  and the list is read once per mounted conversation (when its 语音回复 is not 关). */
export function useSoulSpeech(conversationId: string): {
  entry(message: PaMessage): SoulSpeechEntry;
  speak(messageId: string, options?: { play?: boolean }): Promise<void>;
  autoSpeak(messageId: string): void;
} {
  const { data, index } = usePa();
  const indexRef = useRef(index);
  indexRef.current = index;
  const actionsRef = useRef(data.actions);
  actionsRef.current = data.actions;
  const off = (chatOf(index, conversationId).voiceReplies ?? 'manual') === 'off';
  const offRef = useRef(off);
  offRef.current = off;
  const version = useSyncExternalStore(
    subscribeSpeech,
    () => conversations.get(conversationId)?.version ?? -1,
    () => -1,
  );

  useEffect(() => {
    const state = conversationState(conversationId);
    state.mounts += 1;
    return () => {
      state.mounts -= 1;
      if (state.mounts > 0) return;
      if (state.reread) clearTimeout(state.reread);
      if (conversations.get(conversationId) === state) conversations.delete(conversationId);
    };
  }, [conversationId]);

  useEffect(() => {
    if (off) return;
    const state = conversationState(conversationId);
    if (state.read === 'none') void readList(conversationId, actionsRef.current, () => indexRef.current);
  }, [conversationId, off]);

  useEffect(() => {
    checkRevisions(conversationId, index, actionsRef.current, () => indexRef.current);
  }, [conversationId, index]);

  return useMemo(() => {
    const speak = async (messageId: string, options?: { play?: boolean }): Promise<void> => {
      const play = options?.play !== false;
      const state = conversationState(conversationId);
      const message = indexRef.current.messages.get(messageId);
      const ready = message ? readyItem(state, message, indexRef.current) : null;
      if (ready) {
        if (play) await soulAudio.play(messageId, paSoulSpeechUrl(ready.id));
        return;
      }
      let job = state.inflight.get(messageId);
      if (!job) {
        // The daemon reads the text and the voice when the request arrives: audio for a reply edited (or re-voiced)
        // while it was generated is remembered for the old revision, so no bar shows it for the new text.
        const made = message ? { revision: message.revision, voice: voiceKey(indexRef.current, message) } : undefined;
        job = (async () => {
          state.pending.set(messageId, { phase: 'generating', error: null });
          bump(state);
          try {
            const item = await actionsRef.current.speak(messageId);
            state.pending.delete(messageId);
            remember(state.items, item, indexRef.current, Date.now(), made);
            bump(state);
          } catch (error) {
            state.pending.set(messageId, { phase: 'failed', error: messageOf(error) });
            bump(state);
            errorToast(error);
            throw error;
          } finally {
            state.inflight.delete(messageId);
          }
        })();
        state.inflight.set(messageId, job);
      }
      try {
        await job;
      } catch {
        return; // the entry and the toast carry the failure
      }
      // Left the conversation while it was generated (its store went with the last mounted view): nothing plays where
      // no bar could show it.
      if (conversations.get(conversationId) !== state || state.mounts === 0) return;
      const now = indexRef.current.messages.get(messageId);
      const item = now ? readyItem(state, now, indexRef.current) : null;
      if (play && item) await soulAudio.play(messageId, paSoulSpeechUrl(item.id));
    };
    return {
      entry(message: PaMessage): SoulSpeechEntry {
        if (offRef.current) return SPEECH_NONE;
        const state = conversations.get(conversationId);
        const pending = state?.pending.get(message.id);
        if (pending?.phase === 'generating') return SPEECH_GENERATING;
        const item = readyItem(state, message, indexRef.current);
        if (item) return { item, phase: 'ready', error: null };
        if (pending?.phase === 'failed') return { item: null, phase: 'failed', error: pending.error };
        return SPEECH_NONE;
      },
      speak,
      autoSpeak(messageId: string): void {
        const state = conversationState(conversationId);
        if (state.autoSeen.has(messageId)) return;
        state.autoSeen.add(messageId);
        enqueueAuto({
          messageId,
          run: async () => {
            await speak(messageId, { play: false });
            const message = indexRef.current.messages.get(messageId);
            const item = message ? readyItem(conversations.get(conversationId), message, indexRef.current) : null;
            return item ? paSoulSpeechUrl(item.id) : null;
          },
        });
      },
    };
    // `version` re-creates the object after a store change, so a consumer memoised on it sees fresh entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, version, off]);
}

// ---------------------------------------------------------------------------------------------------------
// Voice sample (试听)
// ---------------------------------------------------------------------------------------------------------

/** The audio store's id of the voice sample: it plays through the app's one audio element like a reply, and the
 *  transcript's "this reply is gone" rule leaves it alone. */
export const SOUL_SAMPLE_AUDIO_ID = 'voice-sample';

/** 试听 in the profile editor: the voice as picked (saved or not) reads `text`. One click generates the sample (or
 *  takes the daemon's cached one) and plays it; a click while it sounds stops it. Generated only on that click. */
export function useSoulVoiceSample(): { phase: 'idle' | 'generating' | 'playing'; toggle(voice: PaVoice, text: string): void } {
  const { data } = usePa();
  const actionsRef = useRef(data.actions);
  actionsRef.current = data.actions;
  const audio = useSoulAudio();
  const [generating, setGenerating] = useState(false);
  /** Moves on every click and on unmount, so an answer nobody waits for any more never plays. */
  const request = useRef(0);
  const sounding = audio.messageId === SOUL_SAMPLE_AUDIO_ID && (audio.phase === 'playing' || audio.phase === 'loading');

  useEffect(
    () => () => {
      request.current += 1;
      if (soulAudio.get().messageId === SOUL_SAMPLE_AUDIO_ID) soulAudio.stop();
    },
    [],
  );

  const toggle = useCallback((voice: PaVoice, text: string) => {
    request.current += 1;
    const mine = request.current;
    const state = soulAudio.get();
    if (state.messageId === SOUL_SAMPLE_AUDIO_ID && (state.phase === 'playing' || state.phase === 'loading')) {
      soulAudio.pause();
      return;
    }
    setGenerating(true);
    actionsRef.current
      .previewSpeech({ model: voice.model, voice: voice.voice, language: voice.language, text })
      .then((item) => {
        if (request.current === mine) void soulAudio.play(SOUL_SAMPLE_AUDIO_ID, paSoulSpeechUrl(item.id));
      })
      .catch((error: unknown) => {
        if (request.current === mine) errorToast(error);
      })
      .finally(() => {
        if (request.current === mine) setGenerating(false);
      });
  }, []);

  return { phase: generating ? 'generating' : sounding ? 'playing' : 'idle', toggle };
}

// ---------------------------------------------------------------------------------------------------------
// Speech status
// ---------------------------------------------------------------------------------------------------------

const STATUS_TTL_MS = 60_000;
let statusValue: PaSpeechStatus | null = null;
let statusReadAt = 0;
let statusInflight = false;
let statusMounts = 0;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let statusActions: Pick<PaActions, 'speechStatus'> | null = null;
const statusListeners = new Set<() => void>();

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function normalizeStatus(value: unknown): PaSpeechStatus {
  const raw = value && typeof value === 'object' ? (value as Partial<PaSpeechStatus>) : {};
  const fallback = raw.default && typeof raw.default === 'object' && typeof raw.default.model === 'string' ? raw.default : null;
  return { available: raw.available === true, models: Array.isArray(raw.models) ? raw.models : [], default: fallback };
}

/** The voice a character's replies are read with: its own, else the status's default (the signed-in TokenToSea
 *  account's default speech model), else none. */
export function soulVoiceFor(index: PaIndex, agentId: string, status: PaSpeechStatus | null): PaVoice | null {
  return characterOf(index, agentId)?.voice ?? status?.default ?? null;
}

/** One shared read; `force` skips the 60 s cache (window focus). A failed read leaves the last value. */
function readStatus(force: boolean): void {
  const actions = statusActions;
  if (!actions || statusInflight) return;
  if (!force && Date.now() - statusReadAt < STATUS_TTL_MS) return;
  statusInflight = true;
  statusReadAt = Date.now();
  void actions
    .speechStatus()
    .then((value) => {
      const next = normalizeStatus(value);
      if (JSON.stringify(next) === JSON.stringify(statusValue)) return;
      statusValue = next;
      for (const listener of [...statusListeners]) listener();
    })
    .catch(() => {})
    .finally(() => {
      statusInflight = false;
    });
}

const onWindowFocus = () => readStatus(true);

/** The speech status (which speech models exist and which are set up). Null until the first read answers. */
export function useSoulSpeechStatus(): PaSpeechStatus | null {
  const { data } = usePa();
  statusActions = data.actions;
  const value = useSyncExternalStore(subscribeStatus, () => statusValue, () => null);
  useEffect(() => {
    statusMounts += 1;
    if (statusMounts === 1) {
      if (typeof window !== 'undefined') window.addEventListener('focus', onWindowFocus);
      statusTimer = setInterval(() => readStatus(false), STATUS_TTL_MS);
    }
    readStatus(false);
    return () => {
      statusMounts -= 1;
      if (statusMounts > 0) return;
      if (typeof window !== 'undefined') window.removeEventListener('focus', onWindowFocus);
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
    };
  }, []);
  return value;
}

// ---------------------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------------------

export type SoulVoiceGate =
  | { kind: 'off' | 'not-speakable' | 'local-only' | 'too-long' | 'no-voice' | 'no-provider' }
  | { kind: 'ready'; auto: boolean };

const SPOKEN_CACHE_MAX = 500;
const spokenCache = new Map<string, number>();

/** Code points of the spoken text of a message's content (memoised; 0 = nothing to read). */
function spokenLength(content: string): number {
  const cached = spokenCache.get(content);
  if (cached !== undefined) return cached;
  const length = Array.from(speechText(content)).length;
  if (spokenCache.size >= SPOKEN_CACHE_MAX) spokenCache.delete(spokenCache.keys().next().value as string);
  spokenCache.set(content, length);
  return length;
}

/** Whether 朗读 is offered for a message, and why not. The order is the menu's: 关, not a reply, nothing to read, local
 *  only (every speech service is remote, so such a reply is never sent to one, not even under 自动朗读), too long, no
 *  voice, no speech service. */
export function soulVoiceGate(index: PaIndex, conversation: PaConversation, message: PaMessage, status: PaSpeechStatus | null): SoulVoiceGate {
  const mode = chatOf(index, conversation.id).voiceReplies ?? 'manual';
  if (mode === 'off') return { kind: 'off' };
  const kind = message.soul?.kind;
  if (message.senderId === 'owner' || (kind !== 'chat' && kind !== 'greeting')) return { kind: 'not-speakable' };
  const length = spokenLength(message.content);
  if (length === 0) return { kind: 'not-speakable' };
  if (message.dataClass === 'local_only') return { kind: 'local-only' };
  if (length > SOUL_LIMITS.speechChars) return { kind: 'too-long' };
  const voice = soulVoiceFor(index, message.senderId, status);
  if (!voice) return { kind: 'no-voice' };
  if (!status?.available || !status.models.some((model) => model.id === voice.model && model.configured)) return { kind: 'no-provider' };
  return { kind: 'ready', auto: mode === 'auto' };
}

export function __resetSoulVoiceForTests(): void {
  element?.pause();
  element = null;
  elementUnavailable = false;
  currentUrl = null;
  autoQueue = [];
  autoBusy = false;
  autoEpoch += 1;
  audioState = AUDIO_IDLE;
  for (const state of conversations.values()) if (state.reread) clearTimeout(state.reread);
  conversations.clear();
  statusValue = null;
  statusReadAt = 0;
  statusInflight = false;
  spokenCache.clear();
  for (const listener of [...audioListeners]) listener();
  for (const listener of [...speechListeners]) listener();
  for (const listener of [...statusListeners]) listener();
}
