import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  notifyBoardProjectStreamReady,
  publishBoardProjectEvent,
  resetBoardProjectEventsForTests,
  subscribeBoardProjectEvents,
} from '../../../src/fantay/board/data/board-events';

const frame = (projectId: string, revision: number) => JSON.stringify({
  type: 'board-changed',
  projectId,
  revision,
  reason: 'patch',
  actor: { kind: 'user', clientId: 'c-1' },
  at: 1,
});

afterEach(() => {
  resetBoardProjectEventsForTests();
  vi.restoreAllMocks();
});

describe('board project bus', () => {
  it('fans board-changed frames out per project', () => {
    const p1 = vi.fn();
    const p1b = vi.fn();
    const p2 = vi.fn();
    subscribeBoardProjectEvents('p1', p1);
    subscribeBoardProjectEvents('p1', p1b);
    subscribeBoardProjectEvents('p2', p2);
    publishBoardProjectEvent('p1', frame('p1', 4));
    expect(p1).toHaveBeenCalledWith({
      type: 'board-changed',
      payload: { type: 'board-changed', projectId: 'p1', revision: 4, reason: 'patch', actor: { kind: 'user', clientId: 'c-1' }, at: 1 },
    });
    expect(p1b).toHaveBeenCalledTimes(1);
    expect(p2).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON, other event types and frames of another project', () => {
    const listener = vi.fn();
    subscribeBoardProjectEvents('p1', listener);
    expect(() => publishBoardProjectEvent('p1', '{not json')).not.toThrow();
    publishBoardProjectEvent('p1', JSON.stringify({ type: 'file-changed', projectId: 'p1', revision: 1 }));
    publishBoardProjectEvent('p1', frame('p2', 1));
    publishBoardProjectEvent('p1', JSON.stringify({ type: 'board-changed', projectId: 'p1', revision: 'x' }));
    publishBoardProjectEvent('p1', 'null');
    expect(listener).not.toHaveBeenCalled();
  });

  it('announces stream-ready and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBoardProjectEvents('p1', listener);
    notifyBoardProjectStreamReady('p1');
    expect(listener).toHaveBeenCalledWith({ type: 'stream-ready' });
    unsubscribe();
    notifyBoardProjectStreamReady('p1');
    publishBoardProjectEvent('p1', frame('p1', 2));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering when one listener throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const healthy = vi.fn();
    subscribeBoardProjectEvents('p1', () => {
      throw new Error('boom');
    });
    subscribeBoardProjectEvents('p1', healthy);
    expect(() => notifyBoardProjectStreamReady('p1')).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
