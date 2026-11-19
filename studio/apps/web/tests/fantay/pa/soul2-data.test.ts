// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Fantay Soul stage 2 data layer (STAGE2 12.1): the live-text store and its poll, the voice gate, the speech and audio
// stores, the CHARX branch of readCardFile and webInflate.
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PaCharacterInput,
  PaCharacterView,
  PaChannelSnapshot,
  PaChatView,
  PaConversation,
  PaMessage,
  PaMessageSoul,
  PaSnapshot,
  PaSoulLiveResponse,
  PaSoulSnapshot,
  PaSpeechItem,
  PaSpeechStatus,
  PaTask,
  PersonalAgent,
} from '@open-design/contracts';
import { PA_DEFAULT_CHAT_SETTINGS, SOUL_LIMITS, crc32, paCharacterInputSchema } from '@open-design/contracts/soul';

import { PaRequestError } from '../../../src/fantay/pa/pa-api';
import { PaContext } from '../../../src/fantay/pa/pa-context';
import { buildIndex } from '../../../src/fantay/pa/pa-model';
import type { PaActions, PaContextValue, PaIndex } from '../../../src/fantay/pa/pa-types';
import { errorToast } from '../../../src/fantay/pa/PaTurnTail';
import { SOUL_MAX_CHARX_BYTES, readCardFile, webInflate } from '../../../src/fantay/pa/soul/soul-files';
import {
  SOUL_LIVE_POLL_MS,
  __resetSoulLiveForTests,
  dismissSoulLive,
  soulLiveDisplayText,
  soulLiveSeen,
  useSoulLive,
  useSoulLivePoll,
} from '../../../src/fantay/pa/soul/soul-live';
import { __resetSoulVoiceForTests, soulAudio, soulVoiceGate, useSoulSpeech } from '../../../src/fantay/pa/soul/soul-voice';

vi.mock('../../../src/fantay/pa/PaTurnTail', () => ({ errorToast: vi.fn() }));

/** Lets a chain of promise jobs settle (the 自动朗读 queue awaits several in a row). */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  });
}

// ---- fixtures ----------------------------------------------------------------------------------------------------

const stamp = { createdAt: 1, updatedAt: 1, revision: 1 };
const NO_CHANNELS: PaChannelSnapshot = { channels: [], inbox: [], outbox: [] };
const VOICE = { model: 'elevenlabs-v3', voice: 'v1', language: '' };
const READY: PaSpeechStatus = {
  available: true,
  models: [
    { id: 'elevenlabs-v3', label: 'ElevenLabs · elevenlabs-v3', provider: 'elevenlabs', configured: true, voices: 'list' },
    { id: 'gpt-4o-mini-tts', label: 'OpenAI · gpt-4o-mini-tts', provider: 'openai', configured: false, voices: 'free' },
  ],
};

function agent(id: string): PersonalAgent {
  return { ...stamp, id, name: id, avatar: '', role: 'role', enabled: true, tools: ['respond'], model: { runtime: 'claude', modelId: 'sonnet' } };
}

function character(id: string, input: PaCharacterInput = {}): PaCharacterView {
  return { ...stamp, id, ...paCharacterInputSchema.parse(input), origin: null, needsReview: [], preservedKeys: [] };
}

function chat(id: string, extra: Partial<PaChatView> = {}): PaChatView {
  return { ...stamp, id, ...PA_DEFAULT_CHAT_SETTINGS, activeEvent: null, candidateEvent: null, branchOf: null, userStateOps: [], ...extra };
}

function message(id: string, extra: Partial<PaMessage> = {}, soul: Partial<PaMessageSoul> = { kind: 'chat' }): PaMessage {
  return { ...stamp, id, conversationId: 'direct', taskId: null, senderId: 'xy', content: `${id} 你好呀`, targetAgentIds: [], replyTo: null, soul: { kind: 'chat', ...soul }, ...extra };
}

function task(status: PaTask['status'], id = 't1'): PaTask {
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
    status,
    waitingReason: null,
    error: null,
    participantIds: ['xy'],
    nextParticipant: 0,
    budget: { maxAttempts: 3, timeoutMs: 300000 },
    authorization: { localProject: false, externalWrites: false, version: 1, revoked: false },
    amendments: [],
    evidence: [],
  };
}

const direct: PaConversation = { ...stamp, id: 'direct', title: '小月', agentId: 'xy', groupId: null };

function indexOf(parts: { messages?: PaMessage[]; tasks?: PaTask[]; characters?: PaCharacterView[]; chats?: PaChatView[] } = {}): PaIndex {
  const snapshot: PaSnapshot = {
    agents: [agent('xy')],
    groups: [],
    conversations: [direct],
    messages: parts.messages ?? [],
    tasks: parts.tasks ?? [],
    attempts: [],
    artifacts: [],
    memories: [],
    node: { id: 'local', protocolVersion: 1, location: 'local', available: true, capabilities: [], heartbeatAt: 1 },
  };
  const soul: PaSoulSnapshot = {
    version: 'v1',
    characters: parts.characters ?? [character('xy', { voice: VOICE })],
    lorebooks: [],
    personas: [],
    presets: [],
    chats: parts.chats ?? [chat('direct')],
  };
  return buildIndex(snapshot, NO_CHANNELS, [], soul);
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetSoulLiveForTests();
  __resetSoulVoiceForTests();
});

// ---- live text ---------------------------------------------------------------------------------------------------

describe('live text store', () => {
  type Answer = PaSoulLiveResponse | Error;
  function setup(answers: Answer[], initial: PaIndex = indexOf({ tasks: [task('running')] })) {
    const queue = [...answers];
    const readLive = vi.fn(async (_conversationId: string, _known?: { attemptId: string; seq: number }, _signal?: AbortSignal) => {
      const next = queue.length > 1 ? queue.shift()! : queue[0] ?? { live: null };
      if (next instanceof Error) throw next;
      return next;
    });
    const refresh = vi.fn(async () => {});
    const actions = { readLive, refresh } as unknown as Pick<PaActions, 'readLive' | 'refresh'>;
    const hook = renderHook(
      ({ index }: { index: PaIndex }) => {
        useSoulLivePoll('direct', index, actions);
        return useSoulLive('direct');
      },
      { initialProps: { index: initial } },
    );
    return { ...hook, readLive, refresh };
  }
  const text = (seq: number, value: string, attemptId = 'a1'): PaSoulLiveResponse => ({ live: { attemptId, taskId: 't1', agentId: 'xy', seq, text: value } });
  const same = (seq: number, attemptId = 'a1'): PaSoulLiveResponse => ({ live: { attemptId, taskId: 't1', agentId: 'xy', seq, unchanged: true } });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('shows the text, keeps it on unchanged, follows growth, and sends the known attempt and seq', async () => {
    const { result, readLive } = setup([text(1, '你好'), same(1), text(2, '你好，在呢')]);
    await advance(0);
    expect(result.current).toEqual({ attemptId: 'a1', taskId: 't1', agentId: 'xy', seq: 1, text: '你好', tone: 'live' });
    expect(readLive.mock.calls[0]![1]).toBeUndefined();
    expect(soulLiveSeen('a1')).toBe(true);
    await advance(SOUL_LIVE_POLL_MS);
    expect(readLive).toHaveBeenCalledTimes(2);
    expect(readLive.mock.calls[1]![1]).toEqual({ attemptId: 'a1', seq: 1 });
    expect(result.current?.text).toBe('你好');
    await advance(SOUL_LIVE_POLL_MS);
    expect(result.current?.text).toBe('你好，在呢');
    expect(result.current?.seq).toBe(2);
  });

  it('keeps the text on null, asks for one re-read, and drops it when the stored reply arrives', async () => {
    const { result, refresh, rerender } = setup([text(1, '你好'), { live: null }]);
    await advance(0);
    await advance(SOUL_LIVE_POLL_MS * 3);
    expect(result.current?.text).toBe('你好');
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ index: indexOf({ messages: [message('a1', { taskId: 't1' })] }) });
    expect(result.current).toBeNull();
  });

  it('turns into a stopped draft when the task leaves, and goes when the next turn starts', async () => {
    const { result, readLive, rerender } = setup([text(1, '写到一半')]);
    await advance(0);
    rerender({ index: indexOf() });
    expect(result.current?.tone).toBe('stopped');
    expect(result.current?.text).toBe('写到一半');
    const calls = readLive.mock.calls.length;
    await advance(SOUL_LIVE_POLL_MS * 4);
    expect(readLive).toHaveBeenCalledTimes(calls); // no poll without a running turn
    rerender({ index: indexOf({ tasks: [task('queued', 't2')] }) });
    expect(result.current).toBeNull();
  });

  it('a task being cancelled is stopped too, and 收起 dismisses the draft', async () => {
    const { result, rerender } = setup([text(1, '写到一半')]);
    await advance(0);
    rerender({ index: indexOf({ tasks: [task('cancelling')] }) });
    expect(result.current?.tone).toBe('stopped');
    act(() => dismissSoulLive('direct'));
    expect(result.current).toBeNull();
  });

  it('turns into a failed draft when the task fails, and goes when it is retried', async () => {
    const { result, rerender } = setup([text(1, '写到一半')]);
    await advance(0);
    rerender({ index: indexOf({ tasks: [task('failed')] }) });
    expect(result.current?.tone).toBe('failed');
    rerender({ index: indexOf({ tasks: [task('queued')] }) });
    expect(result.current).toBeNull();
  });

  it('shows nothing for empty text, replaces the entry for another attempt, and clears a restarted message', async () => {
    const { result } = setup([text(1, ''), text(2, '第一位'), text(1, '第二位', 'a2'), text(2, '', 'a2')]);
    await advance(0);
    expect(result.current).toBeNull();
    await advance(SOUL_LIVE_POLL_MS);
    expect(result.current?.text).toBe('第一位');
    await advance(SOUL_LIVE_POLL_MS);
    expect(result.current?.attemptId).toBe('a2');
    await advance(SOUL_LIVE_POLL_MS);
    expect(result.current).toBeNull();
  });

  it('does not poll a queued turn', async () => {
    const { readLive } = setup([text(1, 'x')], indexOf({ tasks: [task('queued')] }));
    await advance(SOUL_LIVE_POLL_MS * 4);
    expect(readLive).not.toHaveBeenCalled();
  });

  it('stops polling for the session on a 404', async () => {
    const { readLive, unmount } = setup([new PaRequestError('missing', null, 404)]);
    await advance(0);
    await advance(SOUL_LIVE_POLL_MS * 8);
    expect(readLive).toHaveBeenCalledTimes(1);
    unmount();
    const again = setup([text(1, 'x')]);
    await advance(SOUL_LIVE_POLL_MS * 4);
    expect(again.readLive).not.toHaveBeenCalled();
  });

  it('backs off to 1000 ms after three failures in a row, and returns to 250 ms after a success', async () => {
    const boom = new Error('offline');
    const { readLive } = setup([boom, boom, boom, boom, text(1, '回来了'), text(2, '回来了呀')]);
    await advance(0);
    await advance(SOUL_LIVE_POLL_MS * 2);
    expect(readLive).toHaveBeenCalledTimes(3);
    await advance(SOUL_LIVE_POLL_MS);
    expect(readLive).toHaveBeenCalledTimes(3); // waiting 1000 ms now
    await advance(1000 - SOUL_LIVE_POLL_MS);
    expect(readLive).toHaveBeenCalledTimes(4);
    await advance(1000);
    expect(readLive).toHaveBeenCalledTimes(5); // the success
    await advance(SOUL_LIVE_POLL_MS);
    expect(readLive).toHaveBeenCalledTimes(6);
  });

  it('waits while the window is hidden and resumes when it is shown', async () => {
    let state: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    try {
      const { readLive } = setup([text(1, 'x')]);
      await advance(SOUL_LIVE_POLL_MS * 4);
      expect(readLive).not.toHaveBeenCalled();
      state = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(readLive).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('aborts the request and removes the entry on unmount', async () => {
    const { result, readLive, unmount } = setup([text(1, '你好')]);
    await advance(0);
    expect(result.current?.text).toBe('你好');
    const signal = readLive.mock.calls[0]![2] as AbortSignal | undefined;
    unmount();
    expect(signal?.aborted).toBe(true);
    const probe = renderHook(() => useSoulLive('direct'));
    expect(probe.result.current).toBeNull();
  });
});

// ---- voice gate --------------------------------------------------------------------------------------------------

describe('soulVoiceGate', () => {
  const reply = message('r1');
  const gate = (parts: Parameters<typeof indexOf>[0], msg: PaMessage = reply, status: PaSpeechStatus | null = READY) => soulVoiceGate(indexOf(parts), direct, msg, status);

  it('answers every kind in order', () => {
    expect(gate({ chats: [chat('direct', { voiceReplies: 'off' })] })).toEqual({ kind: 'off' });
    expect(gate({}, message('o1', { senderId: 'owner' }))).toEqual({ kind: 'not-speakable' });
    expect(gate({}, message('roll', {}, { kind: 'roll' }))).toEqual({ kind: 'not-speakable' });
    expect(gate({}, message('code', { content: '```\nconst a = 1;\n```' }))).toEqual({ kind: 'not-speakable' });
    // a local-only reply never goes to a (remote) speech service, not even under 自动朗读
    expect(gate({}, message('local', { dataClass: 'local_only' }))).toEqual({ kind: 'local-only' });
    expect(gate({ chats: [chat('direct', { voiceReplies: 'auto' })] }, message('local', { dataClass: 'local_only' }))).toEqual({ kind: 'local-only' });
    expect(gate({}, message('long', { content: '好'.repeat(SOUL_LIMITS.speechChars + 1) }))).toEqual({ kind: 'too-long' });
    expect(gate({ characters: [character('xy')] })).toEqual({ kind: 'no-voice' });
    expect(gate({}, reply, null)).toEqual({ kind: 'no-provider' });
    expect(gate({}, reply, { ...READY, available: false })).toEqual({ kind: 'no-provider' });
    expect(gate({ characters: [character('xy', { voice: { model: 'gpt-4o-mini-tts' } })] })).toEqual({ kind: 'no-provider' });
    expect(gate({})).toEqual({ kind: 'ready', auto: false });
    expect(gate({ chats: [chat('direct', { voiceReplies: 'auto' })] })).toEqual({ kind: 'ready', auto: true });
    expect(gate({}, message('g0', {}, { kind: 'greeting', greetingIndex: 0 }))).toEqual({ kind: 'ready', auto: false });
  });

  it('reads a stage 1 chat row without voiceReplies as 点了才读', () => {
    const legacy = chat('direct') as Partial<PaChatView>;
    delete legacy.voiceReplies;
    expect(gate({ chats: [legacy as PaChatView] })).toEqual({ kind: 'ready', auto: false });
  });
});

// ---- speech and audio stores -------------------------------------------------------------------------------------

class FakeAudio {
  static instances: FakeAudio[] = [];
  static refuse = false;
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  ended = false;
  paused = true;
  preload = '';
  private listeners = new Map<string, Array<() => void>>();
  constructor() {
    FakeAudio.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  play(): Promise<void> {
    if (FakeAudio.refuse) return Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
    this.paused = false;
    this.ended = false;
    this.emit('play');
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit('pause');
  }
  finish() {
    this.ended = true;
    this.paused = true;
    this.emit('pause');
    this.emit('ended');
  }
}

describe('speech and audio stores', () => {
  const item = (messageId: string, n = 1): PaSpeechItem => ({ messageId, id: `${String(n).repeat(64)}.mp3`, mime: 'audio/mpeg', bytes: 300, cached: true });

  function setup(index: PaIndex, overrides: Partial<Record<'listSpeech' | 'speak', (...args: never[]) => unknown>> = {}) {
    const listSpeech = vi.fn(overrides.listSpeech ?? (async () => [] as PaSpeechItem[]));
    const speak = vi.fn(overrides.speak ?? (async (messageId: string) => ({ ...item(messageId, 7), cached: false })));
    let value = { data: { actions: { listSpeech, speak } }, index } as unknown as PaContextValue;
    const wrapper = ({ children }: { children: ReactNode }) => createElement(PaContext.Provider, { value }, children);
    const hook = renderHook(() => useSoulSpeech('direct'), { wrapper });
    return {
      ...hook,
      listSpeech,
      speak,
      setIndex(next: PaIndex) {
        value = { ...value, index: next } as PaContextValue;
        hook.rerender();
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    FakeAudio.instances = [];
    FakeAudio.refuse = false;
    vi.stubGlobal('Audio', FakeAudio);
    vi.mocked(errorToast).mockClear();
  });

  it('reads the list once per mounted conversation, and not at all when 语音回复 is 关', async () => {
    const r1 = message('r1');
    const on = setup(indexOf({ messages: [r1] }), { listSpeech: async () => [item('r1')] });
    await advance(0);
    expect(on.listSpeech).toHaveBeenCalledTimes(1);
    expect(on.result.current.entry(r1)).toEqual({ item: item('r1'), phase: 'ready', error: null });
    on.rerender();
    await advance(0);
    expect(on.listSpeech).toHaveBeenCalledTimes(1);
    on.unmount();
    const off = setup(indexOf({ messages: [r1], chats: [chat('direct', { voiceReplies: 'off' })] }), { listSpeech: async () => [item('r1')] });
    await advance(0);
    expect(off.listSpeech).not.toHaveBeenCalled();
    expect(off.result.current.entry(r1).phase).toBe('none');
  });

  it('drops an item whose message revision or voice changed and reads the list again 300 ms later', async () => {
    const r1 = message('r1');
    let listed: PaSpeechItem[] = [item('r1')];
    const store = setup(indexOf({ messages: [r1] }), { listSpeech: async () => listed });
    await advance(0);
    expect(store.result.current.entry(r1).phase).toBe('ready');

    // a revision change the daemon still lists (hidden toggled): gone at once, back after the debounced re-read
    listed = [item('r1', 2)];
    const hidden = { ...r1, revision: 2 };
    store.setIndex(indexOf({ messages: [hidden] }));
    expect(store.result.current.entry(hidden).phase).toBe('none');
    await advance(299);
    expect(store.listSpeech).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(store.listSpeech).toHaveBeenCalledTimes(2);
    expect(store.result.current.entry(hidden).item?.id).toBe(item('r1', 2).id);

    // a new voice for the speaker: no bar until 朗读 again (the daemon no longer lists the old file)
    listed = [];
    const revoiced = indexOf({ messages: [hidden], characters: [character('xy', { voice: { ...VOICE, voice: 'v2' } })] });
    store.setIndex(revoiced);
    expect(store.result.current.entry(hidden).phase).toBe('none');
    await advance(300);
    expect(store.listSpeech).toHaveBeenCalledTimes(3);
    expect(store.result.current.entry(hidden).phase).toBe('none');
  });

  it('朗读 generates once, plays, and plays the stored file on the next click', async () => {
    const r1 = message('r1');
    let release: () => void = () => {};
    const store = setup(indexOf({ messages: [r1] }), {
      speak: (messageId: string) => new Promise<PaSpeechItem>((resolve) => (release = () => resolve({ ...item(messageId, 7), cached: false }))),
    });
    await advance(0);
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = store.result.current.speak('r1');
    });
    expect(store.result.current.entry(r1).phase).toBe('generating');
    act(() => void store.result.current.speak('r1')); // joins the running request
    await act(async () => {
      release();
      await done;
    });
    expect(store.speak).toHaveBeenCalledTimes(1);
    expect(store.result.current.entry(r1)).toMatchObject({ phase: 'ready', item: { id: item('r1', 7).id } });
    expect(soulAudio.get()).toMatchObject({ messageId: 'r1', phase: 'playing' });
    expect(FakeAudio.instances[0]!.src).toBe(`/api/pa/soul/speech/${item('r1', 7).id}`);

    soulAudio.pause();
    expect(soulAudio.get().phase).toBe('paused');
    await act(async () => {
      await store.result.current.speak('r1');
    });
    expect(store.speak).toHaveBeenCalledTimes(1);
    expect(soulAudio.get().phase).toBe('playing');
  });

  it('does not play audio that finished generating after the conversation was left', async () => {
    const r1 = message('r1');
    let release: () => void = () => {};
    const store = setup(indexOf({ messages: [r1] }), {
      speak: (messageId: string) => new Promise<PaSpeechItem>((resolve) => (release = () => resolve({ ...item(messageId, 7), cached: false }))),
    });
    await advance(0);
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = store.result.current.speak('r1');
    });
    store.unmount();
    await act(async () => {
      release();
      await done;
    });
    expect(soulAudio.get().messageId).toBeNull();
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it('remembers audio for the revision and voice it was asked for, so an edit during generation shows no bar', async () => {
    const r1 = message('r1');
    let release: () => void = () => {};
    const store = setup(indexOf({ messages: [r1] }), {
      speak: (messageId: string) => new Promise<PaSpeechItem>((resolve) => (release = () => resolve({ ...item(messageId, 7), cached: false }))),
    });
    await advance(0);
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = store.result.current.speak('r1');
    });
    const edited = { ...r1, revision: 2, content: '改过的句子' };
    store.setIndex(indexOf({ messages: [edited] }));
    await act(async () => {
      release();
      await done;
    });
    expect(store.result.current.entry(edited).phase).toBe('none');
    expect(soulAudio.get().messageId).toBeNull();
  });

  it('plays from a position picked after the clip ended', async () => {
    await act(async () => {
      await soulAudio.play('r1', 'data:audio/wav;base64,AA');
    });
    const audio = FakeAudio.instances[0]!;
    audio.duration = 4;
    audio.emit('durationchange');
    audio.finish();
    expect(soulAudio.get()).toMatchObject({ messageId: 'r1', phase: 'idle' });
    soulAudio.seek(0.5);
    audio.ended = false; // a seek leaves the end, as in a browser
    expect(audio.currentTime).toBe(2);
    await act(async () => {
      await soulAudio.play('r1', 'data:audio/wav;base64,AA');
    });
    expect(audio.currentTime).toBe(2);
    expect(soulAudio.get().phase).toBe('playing');
    // without a seek, a clip that ended starts over
    audio.finish();
    await act(async () => {
      await soulAudio.play('r1', 'data:audio/wav;base64,AA');
    });
    expect(audio.currentTime).toBe(0);
  });

  it('a failure lands in the entry and a toast', async () => {
    const r1 = message('r1');
    const store = setup(indexOf({ messages: [r1] }), { speak: async () => Promise.reject(new Error('语音生成失败：quota')) });
    await advance(0);
    await act(async () => {
      await store.result.current.speak('r1');
    });
    expect(store.result.current.entry(r1)).toEqual({ item: null, phase: 'failed', error: '语音生成失败：quota' });
    expect(errorToast).toHaveBeenCalledTimes(1);
  });

  it('a refused autoplay leaves the bar paused and blocked', async () => {
    FakeAudio.refuse = true;
    await act(async () => {
      expect(await soulAudio.play('r1', 'data:audio/wav;base64,AA')).toBe(false);
    });
    expect(soulAudio.get()).toMatchObject({ messageId: 'r1', phase: 'paused', blocked: true });
  });

  it('reports an error when there is no audio element', async () => {
    vi.stubGlobal('Audio', undefined);
    __resetSoulVoiceForTests();
    await act(async () => {
      expect(await soulAudio.play('r1', 'data:audio/wav;base64,AA')).toBe(false);
    });
    expect(soulAudio.get().phase).toBe('error');
  });

  it('自动朗读 plays in arrival order, one at a time; pausing clears the queue; stop forgets the message', async () => {
    const r1 = message('r1');
    const r2 = message('r2');
    const r3 = message('r3');
    const store = setup(indexOf({ messages: [r1, r2, r3] }));
    await advance(0);
    act(() => {
      store.result.current.autoSpeak('r1');
      store.result.current.autoSpeak('r2');
      store.result.current.autoSpeak('r1'); // at most once
    });
    await flush();
    expect(store.speak.mock.calls.map(([id]) => id)).toEqual(['r1']);
    expect(soulAudio.get()).toMatchObject({ messageId: 'r1', phase: 'playing' });
    act(() => FakeAudio.instances[0]!.finish());
    await flush();
    expect(store.speak.mock.calls.map(([id]) => id)).toEqual(['r1', 'r2']);
    expect(soulAudio.get()).toMatchObject({ messageId: 'r2', phase: 'playing' });

    act(() => {
      store.result.current.autoSpeak('r3');
      soulAudio.pause();
      FakeAudio.instances[0]!.finish();
    });
    await flush();
    expect(store.speak).toHaveBeenCalledTimes(2);
    act(() => soulAudio.stop());
    expect(soulAudio.get()).toEqual({ messageId: null, phase: 'idle', currentTime: 0, duration: null, blocked: false });
  });

  it('seeks only once the duration is known', async () => {
    await act(async () => {
      await soulAudio.play('r1', 'data:audio/wav;base64,AA');
    });
    soulAudio.seek(0.5);
    expect(FakeAudio.instances[0]!.currentTime).toBe(0);
    FakeAudio.instances[0]!.duration = 10;
    act(() => FakeAudio.instances[0]!.emit('loadedmetadata'));
    act(() => soulAudio.seek(0.5));
    expect(FakeAudio.instances[0]!.currentTime).toBe(5);
    expect(soulAudio.get()).toMatchObject({ currentTime: 5, duration: 10 });
  });
});

// ---- CHARX -------------------------------------------------------------------------------------------------------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4]);

/** A test-only zip writer: stored entries, or raw deflate through node:zlib. */
function zip(entries: Array<{ name: string; data: Uint8Array; deflate?: boolean }>): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const body = entry.deflate ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, method, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, entry.data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, body);
    const record = new Uint8Array(46 + name.length);
    const c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, method, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, entry.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += local.length + body.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const part of [...chunks, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const card = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '小雨',
    description: '雨天开书店的店主。',
    personality: '安静，爱笑。',
    scenario: '',
    first_mes: '欢迎光临。',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '1.0',
    extensions: {},
    assets: [
      { type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' },
      { type: 'emotion', uri: 'embeded://assets/emotion/happy.png', name: 'happy', ext: 'png' },
      { type: 'emotion', uri: 'embedded://assets/emotion/sad.webp', name: 'sad_01', ext: 'webp' },
    ],
  },
};
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const fileOf = (bytes: Uint8Array, name: string) => new File([new Uint8Array(bytes)], name);
const nodeInflate = (data: Uint8Array, max: number) => new Uint8Array(inflateRawSync(data, { maxOutputLength: max + 1 }));

describe('readCardFile on CHARX', () => {
  beforeEach(() => {
    // jsdom has no canvas: the portrait re-encode fails and the card still imports.
    vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.reject(new Error('no canvas'))));
  });

  it('reads the card, the portrait and the sprites, and reports the other files', async () => {
    const archive = zip([
      { name: 'card.json', data: json(card), deflate: true },
      { name: 'assets/icon/images/main.png', data: PNG },
      { name: 'assets/emotion/happy.png', data: PNG, deflate: true },
      { name: 'assets/emotion/sad.webp', data: WEBP },
      { name: 'module.risum', data: new Uint8Array([1, 2, 3]) },
    ]);
    const inflate = vi.fn(nodeInflate);
    const read = await readCardFile(fileOf(archive, '小雨.charx'), 1000, { inflate });
    expect(read.preview.ok).toBe(true);
    expect(read.charxError).toBeUndefined();
    expect(read.card).toMatchObject({ data: { name: '小雨' } });
    expect(read.portrait).toBeNull();
    expect(read.charx?.portrait).toBeInstanceOf(Blob);
    expect(read.charx?.sprites.map((sprite) => [sprite.emotion, sprite.blob.type])).toEqual([
      ['happy', 'image/png'],
      ['sad', 'image/webp'],
    ]);
    expect(read.charx?.report).toContainEqual({ path: 'module.risum', action: 'skipped', reason: 'not-referenced' });
    expect(inflate).toHaveBeenCalledTimes(2); // card.json and the deflated sprite; nothing else is inflated
  });

  it('takes the CHARX branch for a zip that is not named .charx', async () => {
    const read = await readCardFile(fileOf(zip([{ name: 'card.json', data: json(card) }]), 'card.zip'), 1000, { inflate: nodeInflate });
    expect(read.preview.ok).toBe(true);
    expect(read.charx?.sprites).toEqual([]);
    expect(read.charx?.report.some((row) => row.reason === 'missing')).toBe(true);
  });

  it('maps archive errors and card errors', async () => {
    const corrupt = await readCardFile(fileOf(new Uint8Array([1, 2, 3, 4]), 'broken.charx'), 1000, { inflate: nodeInflate });
    expect(corrupt.charxError).toBe('corrupt');
    expect(corrupt.preview.ok).toBe(false);
    const noCard = await readCardFile(fileOf(zip([{ name: 'other.json', data: json(card) }]), 'x.charx'), 1000, { inflate: nodeInflate });
    expect(noCard.charxError).toBe('no-card');
    const badJson = await readCardFile(fileOf(zip([{ name: 'card.json', data: new TextEncoder().encode('{nope') }]), 'x.charx'), 1000, { inflate: nodeInflate });
    expect(badJson.charxError).toBeUndefined();
    expect(badJson.preview).toMatchObject({ ok: false, error: 'bad-json' });
    const notCard = await readCardFile(fileOf(zip([{ name: 'card.json', data: json([1, 2, 3]) }]), 'x.charx'), 1000, { inflate: nodeInflate });
    expect(notCard.preview).toMatchObject({ ok: false, error: 'not-object' });
    expect(notCard.charx).toBeUndefined();
  });

  it('refuses a CHARX over 64 MB without reading it, while PNG and JSON keep the 20 MB limit', async () => {
    const big = fileOf(new Uint8Array(4), 'big.charx');
    Object.defineProperty(big, 'size', { value: SOUL_MAX_CHARX_BYTES + 1 });
    expect((await readCardFile(big, 1000)).preview).toMatchObject({ ok: false, error: 'too-large' });
    const midsize = fileOf(new Uint8Array(4), 'mid.json');
    Object.defineProperty(midsize, 'size', { value: 30 * 1024 * 1024 });
    expect((await readCardFile(midsize, 1000)).preview).toMatchObject({ ok: false, error: 'too-large' });
    expect(SOUL_MAX_CHARX_BYTES).toBe(SOUL_LIMITS.charxBytes);
  });
});

describe('webInflate', () => {
  const available = typeof DecompressionStream !== 'undefined';

  it.skipIf(!available)('inflates node:zlib output and stops after maxOutput + 1 bytes', async () => {
    // Compared as plain arrays: under jsdom, node:zlib and TextEncoder hand out typed arrays of another realm.
    const source = '晒过太阳的纸。'.repeat(500);
    const text = Array.from(new TextEncoder().encode(source));
    const packed = new Uint8Array(deflateRawSync(source));
    const full = await webInflate(packed, text.length);
    expect(full).toBeInstanceOf(Uint8Array);
    expect(Array.from(full)).toEqual(text);
    const capped = await webInflate(packed, 100);
    expect(capped.length).toBe(101);
    expect(Array.from(capped)).toEqual(text.slice(0, 101));
  });

  it.skipIf(!available)('rejects damaged data', async () => {
    await expect(webInflate(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]), 100)).rejects.toBeTruthy();
  });

  it.skipIf(!available)('feeds a deflate bomb in slices and stops writing once the cap is reached', async () => {
    // 1 GiB of zeros in about 1 MB: 1024 sync-flushed blocks of 1 MiB each, then an empty final block.
    const block = deflateRawSync(Buffer.alloc(1024 * 1024), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    const bomb = new Uint8Array(Buffer.concat([...Array.from({ length: 1024 }, () => block), Buffer.from([0x03, 0x00])]));
    const Real = DecompressionStream;
    const written: number[] = [];
    // The real inflater behind a tap that records what webInflate writes.
    class Recording {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<Uint8Array>;
      constructor(format: CompressionFormat) {
        const real = new Real(format);
        const tap = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            written.push(chunk.byteLength);
            controller.enqueue(chunk);
          },
        });
        void tap.readable.pipeTo(real.writable as WritableStream<Uint8Array>).catch(() => {});
        this.readable = real.readable as ReadableStream<Uint8Array>;
        this.writable = tap.writable;
      }
    }
    vi.stubGlobal('DecompressionStream', Recording);
    const out = await webInflate(bomb, 1024 * 1024);
    expect(out.length).toBe(1024 * 1024 + 1);
    expect(Math.max(...written)).toBeLessThanOrEqual(16 * 1024);
    expect(written.reduce((sum, size) => sum + size, 0)).toBeLessThan(bomb.length / 4);
  });

  it('throws inflate-unavailable without DecompressionStream', async () => {
    vi.stubGlobal('DecompressionStream', undefined);
    await expect(webInflate(new Uint8Array([1]), 10)).rejects.toThrow('inflate-unavailable');
  });
});

describe('soulLiveDisplayText', () => {
  it('holds back an action still open on the last line, and a lone trailing asterisk', () => {
    expect(soulLiveDisplayText('真的吗！快说说。\n\n*她把手里的样张放下')).toBe('真的吗！快说说。');
    expect(soulLiveDisplayText('她揉了揉眼睛。*打了个')).toBe('她揉了揉眼睛。');
    expect(soulLiveDisplayText('嗯*')).toBe('嗯');
    expect(soulLiveDisplayText('*')).toBe('');
  });

  it('keeps closed actions, text after them and lines without asterisks', () => {
    expect(soulLiveDisplayText('*她把样张放下*')).toBe('*她把样张放下*');
    expect(soulLiveDisplayText('*揉眼睛*，画完')).toBe('*揉眼睛*，画完');
    expect(soulLiveDisplayText('*一*\n画完就去睡')).toBe('*一*\n画完就去睡');
    expect(soulLiveDisplayText('5 * 3 = 15')).toBe('5 * 3 = 15');
  });
});
