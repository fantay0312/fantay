import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetBoardProjectEventsForTests,
  subscribeBoardProjectEvents,
} from '../../src/fantay/board/data/board-events';
import { createProjectEventsConnection } from '../../src/providers/project-events';

type Listener = (evt: unknown) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners: Map<string, Set<Listener>> = new Map();
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: Listener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(cb);
  }
  removeEventListener(name: string, cb: Listener): void {
    this.listeners.get(name)?.delete(cb);
  }
  dispatch(name: string, evt: unknown): void {
    for (const cb of this.listeners.get(name) ?? []) cb(evt);
  }
  close(): void {
    this.closed = true;
  }
  get readyState(): number {
    return this.closed ? 2 : 1;
  }
}

afterEach(() => {
  MockEventSource.instances = [];
  resetBoardProjectEventsForTests();
});

describe('project events → board bus', () => {
  it('routes board-changed to the board bus and never to onChange', () => {
    const onChange = vi.fn();
    const board = vi.fn();
    subscribeBoardProjectEvents('p1', board);
    const conn = createProjectEventsConnection('p1', onChange, {
      EventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.instances[0]!;
    const payload = { type: 'board-changed', projectId: 'p1', revision: 7, reason: 'sync', actor: { kind: 'sync', clientId: 'c-2' }, at: 5 };
    es.dispatch('board-changed', { data: JSON.stringify(payload) });
    expect(board).toHaveBeenCalledWith({ type: 'board-changed', payload });
    expect(onChange).not.toHaveBeenCalled();
    conn.close();
  });

  it('notifies the board bus after the ready handshake, after onReady', () => {
    const order: string[] = [];
    subscribeBoardProjectEvents('p1', (event) => order.push(`bus:${event.type}`));
    const conn = createProjectEventsConnection('p1', () => {}, {
      EventSourceCtor: MockEventSource as unknown as typeof EventSource,
      onReady: () => order.push('onReady'),
    });
    MockEventSource.instances[0]!.dispatch('ready', {});
    expect(order).toEqual(['onReady', 'bus:stream-ready']);
    conn.close();
  });

  it('ignores a malformed board frame without breaking other events', () => {
    const onChange = vi.fn();
    const board = vi.fn();
    subscribeBoardProjectEvents('p1', board);
    const conn = createProjectEventsConnection('p1', onChange, {
      EventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.instances[0]!;
    expect(() => es.dispatch('board-changed', { data: '{oops' })).not.toThrow();
    es.dispatch('file-changed', { data: JSON.stringify({ type: 'file-changed', path: 'a.html', kind: 'change' }) });
    expect(board).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({ type: 'file-changed', path: 'a.html', kind: 'change' });
    conn.close();
  });
});
