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
import { usePaWorkspace } from '../../../src/fantay/pa/usePaWorkspace';

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
