import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  drainQueuedBoardInserts,
  hasWorkspaceSubscriber,
  queueBoardInsert,
  resetWorkspaceBusForTests,
  sendWorkspaceCommand,
  subscribeWorkspaceCommand,
  type FantayNodeDraft,
  type WorkspaceCommandOf,
} from '../../../src/fantay/workspace/workspace-bus';

function insert(projectId: string, drafts: FantayNodeDraft[]): WorkspaceCommandOf<'board.insert'> {
  return { type: 'board.insert', projectId, drafts };
}

describe('workspace command bus', () => {
  afterEach(() => {
    resetWorkspaceBusForTests();
  });

  it('returns false without a subscriber', () => {
    expect(sendWorkspaceCommand({ type: 'workspace.openEditor', projectId: 'p1', fileName: 'movie-studio.json' })).toBe(false);
    expect(hasWorkspaceSubscriber('workspace.openEditor')).toBe(false);
  });

  it('delivers typed commands to subscribers of that type and reports the handled flag', () => {
    const openEditor = vi.fn(() => true);
    const view = vi.fn(() => false);
    subscribeWorkspaceCommand('workspace.openEditor', openEditor);
    subscribeWorkspaceCommand('workspace.view', view);

    expect(sendWorkspaceCommand({ type: 'workspace.openEditor', projectId: 'p1', fileName: 'movie-studio.json' })).toBe(true);
    expect(openEditor).toHaveBeenCalledWith({ type: 'workspace.openEditor', projectId: 'p1', fileName: 'movie-studio.json' });
    expect(view).not.toHaveBeenCalled();

    expect(sendWorkspaceCommand({ type: 'workspace.view', projectId: 'p1', view: 'board', focus: { kind: 'motion' } })).toBe(false);
    expect(view).toHaveBeenCalledTimes(1);
  });

  it('asks the latest subscriber first and falls back to earlier ones (stack order)', () => {
    const calls: string[] = [];
    subscribeWorkspaceCommand('board.insert', (command) => {
      calls.push(`first:${command.projectId}`);
      return command.projectId === 'p1';
    });
    subscribeWorkspaceCommand('board.insert', (command) => {
      calls.push(`second:${command.projectId}`);
      return command.projectId === 'p2';
    });

    expect(sendWorkspaceCommand(insert('p2', []))).toBe(true);
    expect(calls).toEqual(['second:p2']);

    calls.length = 0;
    expect(sendWorkspaceCommand(insert('p1', []))).toBe(true);
    expect(calls).toEqual(['second:p1', 'first:p1']);

    calls.length = 0;
    expect(sendWorkspaceCommand(insert('p3', []))).toBe(false);
    expect(calls).toEqual(['second:p3', 'first:p3']);
  });

  it('treats only an explicit true as handled', () => {
    subscribeWorkspaceCommand('sidebar.focus', () => undefined as unknown as boolean);
    expect(sendWorkspaceCommand({ type: 'sidebar.focus', section: 'motion' })).toBe(false);
  });

  it('unsubscribes (idempotently) and tracks subscriber presence', () => {
    const handler = vi.fn(() => true);
    const unsubscribe = subscribeWorkspaceCommand('sidebar.focus', handler);
    expect(hasWorkspaceSubscriber('sidebar.focus')).toBe(true);

    unsubscribe();
    unsubscribe();
    expect(hasWorkspaceSubscriber('sidebar.focus')).toBe(false);
    expect(sendWorkspaceCommand({ type: 'sidebar.focus', section: 'motion' })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a subscriber unsubscribe while a command is being delivered', () => {
    const later = vi.fn(() => false);
    let unsubscribeLater: () => void = () => undefined;
    subscribeWorkspaceCommand('workspace.view', () => true);
    unsubscribeLater = subscribeWorkspaceCommand('workspace.view', () => {
      unsubscribeLater();
      return later();
    });
    expect(sendWorkspaceCommand({ type: 'workspace.view', projectId: 'p1', view: 'files' })).toBe(true);
    expect(later).toHaveBeenCalledTimes(1);
    expect(hasWorkspaceSubscriber('workspace.view')).toBe(true);
  });

  it('queues board inserts per project and drains them oldest first', () => {
    const image = insert('p1', [{ kind: 'image', path: 'a.png' }]);
    const motion = insert('p1', [{ kind: 'motion', projectId: 'p1', path: 'movie-studio.json', title: 'Film' }]);
    const design = insert('p2', [{ kind: 'design', path: 'designs/home.fig', title: '首页', sourceNodeId: 'n_1' }]);
    queueBoardInsert(image);
    queueBoardInsert(design);
    queueBoardInsert(motion);

    expect(drainQueuedBoardInserts('p1')).toEqual([image, motion]);
    expect(drainQueuedBoardInserts('p1')).toEqual([]);
    expect(drainQueuedBoardInserts('p2')).toEqual([design]);
    expect(drainQueuedBoardInserts('unknown')).toEqual([]);
  });

  it('accepts every draft kind, including material provenance and R21 design drafts', () => {
    const drafts: FantayNodeDraft[] = [
      { kind: 'video', path: 'clips/a.mp4' },
      { kind: 'frame', path: 'index.html', title: 'Home' },
      { kind: 'web', url: 'https://example.com', provenance: { source: 'material', materialId: 'm1', license: 'CC0' } },
      { kind: 'note', text: 'Brief', provenance: { source: 'material', materialId: 'm2', license: 'MIT', receiptPath: 'references/r.json' } },
      { kind: 'design', path: 'designs/home.fig' },
    ];
    const handler = vi.fn(() => true);
    subscribeWorkspaceCommand('board.insert', handler);
    expect(sendWorkspaceCommand({ ...insert('p1', drafts), at: { x: 10, y: 20 }, select: true })).toBe(true);
    expect(handler).toHaveBeenCalledWith({ type: 'board.insert', projectId: 'p1', drafts, at: { x: 10, y: 20 }, select: true });
  });
});
