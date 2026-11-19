// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// usePaWorkspace (spec §17.1): an idle poll whose only change is the node heartbeat keeps the snapshot (and the
// PaData the context hands every consumer) as it was, and a slow read can never roll back a newer one.
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createContext, useContext, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaControl, PaSnapshot, PaTask } from '@open-design/contracts';

import { PaTransportProvider } from '../../../src/fantay/pa/pa-transport';
import type { PaData, PaTransport } from '../../../src/fantay/pa/pa-types';
import { paPendingKey, usePaWorkspace } from '../../../src/fantay/pa/usePaWorkspace';

vi.mock('../../../src/fantay/pa/pa-activity', () => ({ refreshPaActivity: vi.fn() }));

const stamp = { createdAt: 1, updatedAt: 1, revision: 1 };

const control: PaControl = {
  ...stamp,
  id: 'control',
  backgroundEnabled: true,
  paused: false,
  suspended: false,
  maxConcurrent: 2,
  defaultMaxAttempts: 6,
  defaultTimeoutMs: 300000,
  waitingExpiryMs: 86_400_000,
  activeCount: 0,
  pendingCount: 0,
  lastResumeAt: null,
};

function task(status: PaTask['status'], revision: number): PaTask {
  return {
    ...stamp,
    revision,
    id: 't1',
    requestId: 'request-1',
    conversationId: 'direct',
    goal: 'Write a brief',
    kind: 'discussion',
    projectName: '',
    projectId: null,
    projectConversationId: null,
    status,
    waitingReason: null,
    error: null,
    participantIds: ['a'],
    nextParticipant: 0,
    budget: { maxAttempts: 3, timeoutMs: 300000 },
    authorization: { localProject: false, externalWrites: false, version: 1, revoked: false },
    amendments: [],
    evidence: [],
  };
}

/** A fresh object per read, as the daemon sends: same content, a heartbeat stamped with the read time. */
function snapshot(heartbeatAt: number, tasks: PaTask[] = [task('running', 1)]): PaSnapshot {
  return {
    agents: [
      {
        ...stamp,
        id: 'a',
        name: 'Writer',
        avatar: 'W',
        role: 'Write',
        enabled: true,
        tools: ['respond'],
        model: { runtime: 'claude', modelId: 'sonnet' },
      },
    ],
    groups: [],
    conversations: [{ ...stamp, id: 'direct', title: 'Writer', agentId: 'a', groupId: null }],
    messages: [],
    tasks,
    attempts: [],
    artifacts: [],
    memories: [],
    node: { id: 'local', protocolVersion: 1, location: 'local', available: true, capabilities: ['respond'], heartbeatAt },
  };
}

type Handler = (path: string, method: string) => unknown;

/** Mounts the hook the way the workspace does: its PaData goes into a context, and a consumer below counts
 *  its own renders (the roster, transcript and inspector are such consumers). */
function mount(handler: Handler) {
  const transport = vi.fn((path = '', method = 'GET') => Promise.resolve(handler(path, method))) as unknown as PaTransport;
  const DataContext = createContext<PaData | null>(null);
  const seen: { data: PaData | null; consumerRenders: number } = { data: null, consumerRenders: 0 };
  function Host({ children }: { children: ReactNode }) {
    const data = usePaWorkspace(true);
    seen.data = data;
    return <DataContext.Provider value={data}>{children}</DataContext.Provider>;
  }
  function Consumer() {
    useContext(DataContext);
    seen.consumerRenders += 1;
    return null;
  }
  render(
    <PaTransportProvider transport={transport}>
      <Host>
        <Consumer />
      </Host>
    </PaTransportProvider>,
  );
  return { seen, transport };
}

/** Lets pending promises settle and runs the timers due in `ms`. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function auxiliary(path: string): unknown {
  if (path === '/control') return { ...control };
  if (path === '/channels') return { channels: [], inbox: [], outbox: [] };
  if (path === '/models') return [];
  return {};
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('usePaWorkspace change detection', () => {
  it('keeps the snapshot and PaData, and re-renders no consumer, when a poll only moves the node heartbeat', async () => {
    let beat = 1000;
    const { seen, transport } = mount((path) => (path === '' ? snapshot((beat += 2000)) : auxiliary(path)));
    await advance(0);
    const first = seen.data!;
    expect(first.snapshot?.tasks).toHaveLength(1);
    const settled = seen.consumerRenders;

    await advance(2000);
    await advance(2000);
    await advance(2000);

    const snapshotReads = vi.mocked(transport).mock.calls.filter(([path, method]) => (path ?? '') === '' && (method ?? 'GET') === 'GET');
    expect(snapshotReads.length).toBeGreaterThanOrEqual(4);
    expect(seen.data!.snapshot).toBe(first.snapshot);
    expect(seen.data).toBe(first);
    expect(seen.consumerRenders).toBe(settled);
  });

  it('keeps the node object when the snapshot changed elsewhere', async () => {
    let beat = 1000;
    let status: PaTask['status'] = 'running';
    const { seen } = mount((path) => (path === '' ? snapshot((beat += 2000), [task(status, status === 'running' ? 1 : 2)]) : auxiliary(path)));
    await advance(0);
    const first = seen.data!.snapshot!;

    status = 'completed';
    await advance(2000);

    const next = seen.data!.snapshot!;
    expect(next).not.toBe(first);
    expect(next.tasks[0]!.status).toBe('completed');
    expect(next.node).toBe(first.node);
  });
});

describe('usePaWorkspace read ordering', () => {
  it('drops a slow poll that resolves after the re-read following a mutation', async () => {
    let state: 'before' | 'after' = 'before';
    const slow: Array<(value: unknown) => void> = [];
    let holdNextRead = false;
    const transport = vi.fn((path = '', method = 'GET') => {
      if (path === '' && method === 'GET') {
        const value = snapshot(1000, [task(state === 'before' ? 'running' : 'cancelled', state === 'before' ? 1 : 2)]);
        if (holdNextRead) {
          holdNextRead = false;
          return new Promise((resolve) => slow.push(() => resolve(value)));
        }
        return Promise.resolve(value);
      }
      if (path.endsWith('/cancel')) {
        state = 'after';
        return Promise.resolve({});
      }
      return Promise.resolve(auxiliary(path));
    }) as unknown as PaTransport;
    const wrapper = ({ children }: { children: ReactNode }) => <PaTransportProvider transport={transport}>{children}</PaTransportProvider>;
    const { result } = renderHook(() => usePaWorkspace(true), { wrapper });
    await advance(0);
    expect(result.current.snapshot?.tasks[0]!.status).toBe('running');

    // The next poll is sent before the Stop and answers with the pre-Stop state, but only after the re-read.
    holdNextRead = true;
    await advance(2000);
    expect(slow).toHaveLength(1);
    await act(async () => {
      await result.current.actions.stopTask('t1');
    });
    expect(result.current.snapshot?.tasks[0]!.status).toBe('cancelled');

    await act(async () => {
      slow[0]!(undefined);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.snapshot?.tasks[0]!.status).toBe('cancelled');
    expect(result.current.snapshot?.tasks[0]!.revision).toBe(2);
  });
});

// ---- soul data layer (ARCH 5.5): since-tag, paired soul snapshot, fast poll, kick ----

function soulSnapshot(version: string, characterIds: string[] = []) {
  return {
    version,
    characters: characterIds.map((id) => ({ ...stamp, id })),
    lorebooks: [],
    personas: [],
    presets: [],
    chats: [],
  };
}

function chatTask(status: PaTask['status']): PaTask {
  return { ...task(status, 1), id: 'c1', kind: 'chat' };
}

type Call = Parameters<PaTransport>;
const snapshotReads = (transport: PaTransport) =>
  (vi.mocked(transport).mock.calls as Call[]).filter(([path, method]) => /^(\?since=.*)?$/.test(path ?? '') && (method ?? 'GET') === 'GET');
const soulReadsOf = (transport: PaTransport) => (vi.mocked(transport).mock.calls as Call[]).filter(([path]) => path === '/soul');

describe('usePaWorkspace since-tag', () => {
  it('sends the last tag and keeps everything on an unchanged answer', async () => {
    const { seen, transport } = mount((path) => {
      if (path === '') return { ...snapshot(1000), tag: 'tag-1' };
      if (path === '?since=tag-1') return { unchanged: true, tag: 'tag-1' };
      return auxiliary(path);
    });
    await advance(0);
    const first = seen.data!;
    expect(first.snapshot?.tasks).toHaveLength(1);
    expect(first.snapshot).not.toHaveProperty('tag');

    await advance(2000);
    await advance(2000);
    const paths = snapshotReads(transport).map(([path]) => path ?? '');
    expect(paths[0]).toBe('');
    expect(paths.slice(1)).toEqual(['?since=tag-1', '?since=tag-1']);
    expect(seen.data!.snapshot).toBe(first.snapshot);
    expect(seen.data).toBe(first);
  });
});

describe('usePaWorkspace soul snapshot', () => {
  it('fetches the soul snapshot when soulVersion changes and applies both in the same render', async () => {
    let version = 'v1';
    const pairs: Array<[string | null, string | null]> = [];
    const transport = vi.fn((path = '', method = 'GET') => {
      if (path === '' && method === 'GET') return Promise.resolve({ ...snapshot(1000), soulVersion: version });
      if (path === '/soul') return Promise.resolve(soulSnapshot(version, version === 'v2' ? ['a'] : []));
      return Promise.resolve(auxiliary(path));
    }) as unknown as PaTransport;
    function Host() {
      const data = usePaWorkspace(true);
      if (data.snapshot) pairs.push([data.snapshot.soulVersion ?? null, data.soul?.version ?? null]);
      return null;
    }
    render(
      <PaTransportProvider transport={transport}>
        <Host />
      </PaTransportProvider>,
    );
    await advance(0);
    expect(pairs.at(-1)).toEqual(['v1', 'v1']);
    expect(soulReadsOf(transport)).toHaveLength(1);

    await advance(2000); // same version: no soul read
    expect(soulReadsOf(transport)).toHaveLength(1);

    version = 'v2';
    await advance(2000);
    expect(soulReadsOf(transport)).toHaveLength(2);
    expect(pairs.at(-1)).toEqual(['v2', 'v2']);
    // No render ever saw the new main snapshot with the old soul snapshot (or the reverse).
    expect(pairs.every(([main, soul]) => main === soul)).toBe(true);
  });

  it('reads /soul in enterprise mode too, and keeps who the snapshot is for', async () => {
    const member = { id: 'alice', role: 'operator' as const, canManageLibrary: false };
    const { seen, transport } = mount((path) =>
      path === '' ? { ...snapshot(1000), mode: 'enterprise', member, soulVersion: 'v1' } : path === '/soul' ? soulSnapshot('v1') : auxiliary(path),
    );
    await advance(0);
    expect(seen.data!.snapshot).toMatchObject({ mode: 'enterprise', member });
    expect(seen.data!.soul?.version).toBe('v1');
    expect(soulReadsOf(transport)).toHaveLength(1);
  });

  it('drops a soul response older than one already applied', async () => {
    let version = 'v1';
    let holdSoul = false;
    const held: Array<() => void> = [];
    const transport = vi.fn((path = '', method = 'GET') => {
      if (path === '' && method === 'GET') return Promise.resolve({ ...snapshot(1000), soulVersion: version });
      if (path === '/soul') {
        const value = soulSnapshot(version);
        if (holdSoul) {
          holdSoul = false;
          return new Promise((resolve) => held.push(() => resolve(value)));
        }
        return Promise.resolve(value);
      }
      if (path.endsWith('/cancel')) {
        version = 'v3';
        return Promise.resolve({});
      }
      return Promise.resolve(auxiliary(path));
    }) as unknown as PaTransport;
    const wrapper = ({ children }: { children: ReactNode }) => <PaTransportProvider transport={transport}>{children}</PaTransportProvider>;
    const { result } = renderHook(() => usePaWorkspace(true), { wrapper });
    await advance(0);
    expect(result.current.soul?.version).toBe('v1');

    // The poll sees v2 and its soul read stalls; a mutation's re-read then fetches v3.
    version = 'v2';
    holdSoul = true;
    await advance(2000);
    expect(held).toHaveLength(1);
    await act(async () => {
      await result.current.actions.stopTask('t1');
    });
    expect(result.current.soul?.version).toBe('v3');

    await act(async () => {
      held[0]!();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.soul?.version).toBe('v3');
    expect(result.current.snapshot?.soulVersion).toBe('v3');
  });
});

describe('usePaWorkspace chat cadence', () => {
  it('polls every 700 ms while a chat task is queued, then returns to 2 s', async () => {
    let tasks: PaTask[] = [chatTask('queued')];
    const { transport } = mount((path) => (path === '' ? snapshot(1000, tasks) : auxiliary(path)));
    await advance(0);
    expect(snapshotReads(transport)).toHaveLength(1);
    await advance(700);
    expect(snapshotReads(transport)).toHaveLength(2);

    tasks = []; // the reply is stored; finished chat tasks leave the snapshot
    await advance(700);
    expect(snapshotReads(transport)).toHaveLength(3);
    await advance(700);
    expect(snapshotReads(transport)).toHaveLength(3);
    await advance(1300);
    expect(snapshotReads(transport)).toHaveLength(4);
  });

  it('kicks the poll after a chat send instead of waiting for the 2 s tick', async () => {
    let tasks: PaTask[] = [];
    const transport = vi.fn((path = '', method = 'GET', body?: unknown) => {
      if (path === '' && method === 'GET') return Promise.resolve(snapshot(1000, tasks));
      if (path === '/tasks' && method === 'POST') {
        tasks = [chatTask('queued')];
        return Promise.resolve({ ...chatTask('queued'), body });
      }
      return Promise.resolve(auxiliary(path));
    }) as unknown as PaTransport;
    const wrapper = ({ children }: { children: ReactNode }) => <PaTransportProvider transport={transport}>{children}</PaTransportProvider>;
    const { result } = renderHook(() => usePaWorkspace(true), { wrapper });
    await advance(0);
    expect(snapshotReads(transport)).toHaveLength(1);

    await act(async () => {
      await result.current.actions.sendChat({ conversationId: 'direct', text: '你好', requestId: 'request-chat-1' });
    });
    const post = (vi.mocked(transport).mock.calls as Call[]).find(([path, method]) => path === '/tasks' && method === 'POST');
    expect(post?.[2]).toEqual({ requestId: 'request-chat-1', conversationId: 'direct', goal: '你好', kind: 'chat', targetAgentIds: [] });
    expect(snapshotReads(transport)).toHaveLength(2); // the action's own re-read
    expect(result.current.pending.size).toBe(0);

    await advance(0); // the kicked poll runs at once
    expect(snapshotReads(transport)).toHaveLength(3);
    await advance(700);
    expect(snapshotReads(transport)).toHaveLength(4);
  });
});

describe('usePaWorkspace stage 2 actions', () => {
  function host(answers: (path: string, method: string, body: unknown) => unknown) {
    const transport = vi.fn((path = '', method = 'GET', body?: unknown) =>
      Promise.resolve(path === '' && method === 'GET' ? snapshot(1000) : answers(path, method, body) ?? auxiliary(path)),
    ) as unknown as PaTransport;
    const wrapper = ({ children }: { children: ReactNode }) => <PaTransportProvider transport={transport}>{children}</PaTransportProvider>;
    return { transport, ...renderHook(() => usePaWorkspace(true), { wrapper }) };
  }
  const calls = (transport: PaTransport, match: (path: string, method: string) => boolean) =>
    (vi.mocked(transport).mock.calls as Call[]).filter(([path, method]) => match(path ?? '', method ?? 'GET'));

  it('reads live text with and without the known attempt, passing the signal, with no re-read', async () => {
    const { transport, result } = host((path) => (path.startsWith('/soul/live') ? { live: null } : undefined));
    await advance(0);
    const before = snapshotReads(transport).length;
    const controller = new AbortController();
    await act(async () => {
      await result.current.actions.readLive('conv 1');
      await result.current.actions.readLive('conv 1', { attemptId: 'at-1', seq: 3 }, controller.signal);
    });
    const live = calls(transport, (path) => path.startsWith('/soul/live'));
    expect(live.map(([path]) => path)).toEqual(['/soul/live?conversationId=conv+1', '/soul/live?conversationId=conv+1&attempt=at-1&seq=3']);
    expect(live[1]?.[1]).toBe('GET');
    expect(live[1]?.[3]).toBe(controller.signal);
    expect(snapshotReads(transport)).toHaveLength(before);
    expect(result.current.pending.size).toBe(0);
  });

  it('reads the speech status, voices and list, and speaks under its pending key without a re-read', async () => {
    let release: (value: unknown) => void = () => {};
    const item = { messageId: 'm1', id: `${'a'.repeat(64)}.mp3`, mime: 'audio/mpeg', bytes: 300, cached: false };
    const { transport, result } = host((path, method) => {
      if (path === '/soul/speech/status') return { available: true, models: [] };
      if (path.startsWith('/soul/speech/voices')) return { model: 'elevenlabs-v3', voices: [{ id: 'v1', name: 'Voice' }] };
      if (path.startsWith('/soul/speech?')) return { items: [item] };
      if (path === '/soul/speech' && method === 'POST') return new Promise((resolve) => (release = resolve));
      return undefined;
    });
    await advance(0);
    const before = snapshotReads(transport).length;
    await act(async () => {
      expect(await result.current.actions.speechStatus()).toEqual({ available: true, models: [] });
      expect((await result.current.actions.speechVoices('a/b c')).voices).toHaveLength(1);
      expect(await result.current.actions.listSpeech('conv/1')).toEqual([item]);
    });
    expect(calls(transport, (path) => path.startsWith('/soul/speech/voices'))[0]?.[0]).toBe('/soul/speech/voices?model=a%2Fb%20c');
    expect(calls(transport, (path) => path.startsWith('/soul/speech?'))[0]?.[0]).toBe('/soul/speech?conversationId=conv%2F1');

    let spoken: Promise<unknown> = Promise.resolve();
    await act(async () => {
      spoken = result.current.actions.speak('m1');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.pending.has(paPendingKey.soulSpeech('m1'))).toBe(true);
    expect(calls(transport, (path, method) => path === '/soul/speech' && method === 'POST')[0]?.[2]).toEqual({ messageId: 'm1' });
    await act(async () => {
      release(item);
      expect(await spoken).toEqual(item);
    });
    expect(result.current.pending.size).toBe(0);
    expect(snapshotReads(transport)).toHaveLength(before);
  });

  it('a list answer that is not an object reads as no items', async () => {
    const { result } = host((path) => (path.startsWith('/soul/speech?') ? 'nope' : undefined));
    await advance(0);
    await act(async () => {
      expect(await result.current.actions.listSpeech('c')).toEqual([]);
    });
  });

  it('sends sprites with a card import only when there are some, emotion keys only', async () => {
    const { transport, result } = host((path) =>
      path === '/soul/characters/import' ? { agent: { id: 'a' }, conversation: { id: 'c' }, report: { needsReview: [], preservedKeys: [] } } : undefined,
    );
    await advance(0);
    await act(async () => {
      await result.current.actions.importCard({ card: { name: 'x' }, sprites: { happy: 'h.webp', shy: '' } });
      await result.current.actions.importCard({ card: { name: 'y' }, sprites: {} });
      await result.current.actions.importCard({ card: { name: 'z' }, sprites: { ['bogus' as 'happy']: 'b.webp' } });
      await result.current.actions.importCard({ card: { name: 'w' } });
    });
    const bodies = calls(transport, (path, method) => path === '/soul/characters/import' && method === 'POST').map(([, , body]) => body);
    expect(bodies[0]).toEqual({ card: { name: 'x' }, sprites: { happy: 'h.webp' } });
    expect(bodies.slice(1)).toEqual([{ card: { name: 'y' } }, { card: { name: 'z' } }, { card: { name: 'w' } }]);
  });
});
