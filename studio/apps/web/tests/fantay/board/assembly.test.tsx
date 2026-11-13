// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stableBoardId } from '@open-design/contracts';

import {
  applyBoardInsertCommand,
  deriveBuildingState,
  useBoardFocusRequest,
  useBoardInsertBridge,
} from '../../../src/fantay/board/assembly';
import type { BoardCommands } from '../../../src/fantay/board/commands/board-commands';
import {
  queueBoardInsert,
  resetWorkspaceBusForTests,
  sendWorkspaceCommand,
} from '../../../src/fantay/workspace/workspace-bus';
import { makeBoard, createFakeDataStore } from './engine-fixtures';

afterEach(() => {
  cleanup();
  resetWorkspaceBusForTests();
});

describe('deriveBuildingState', () => {
  it('returns empty paths when neither runInFlight nor streaming is active', () => {
    const state = deriveBuildingState({
      runInFlight: false,
      streaming: false,
      runSteps: [{ id: 's1', category: 'write', toolName: 'Write', target: 'index.html', anchor: null }],
      files: [{ name: 'index.html', size: 100, mtime: 1, kind: 'html', mime: 'text/html' }],
      messages: [],
    });
    expect(state.buildingPaths.size).toBe(0);
    expect(state.buildingAgentName).toBeUndefined();
  });

  it('collects active write/edit step paths and running tool_use targets with agent name', () => {
    const state = deriveBuildingState({
      runInFlight: true,
      streaming: true,
      runSteps: [
        { id: 's1', category: 'write', toolName: 'Write', target: 'index.html', anchor: null },
        { id: 's2', category: 'read', toolName: 'Read', target: 'styles.css', anchor: null },
      ],
      files: [
        { name: 'index.html', size: 100, mtime: 1, kind: 'html', mime: 'text/html' },
        { name: 'pages/about.html', size: 200, mtime: 2, kind: 'html', mime: 'text/html' },
      ],
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          agentName: 'Designer',
          createdAt: 1,
          events: [
            { kind: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: 'pages/about.html' } },
          ],
        },
      ],
    });
    expect([...state.buildingPaths]).toEqual(['index.html', 'pages/about.html']);
    expect(state.buildingAgentName).toBe('Designer');
  });
});

describe('applyBoardInsertCommand & useBoardInsertBridge', () => {
  it('maps all 7 FantayNodeDraft kinds into board ops, deduplicates existing nodes, and adds lineage edges for design drafts', () => {
    const initial = makeBoard([
      { id: 'n_img_source', kind: 'image', x: 100, y: 100, w: 640, h: 640, ref: { path: 'assets/source.png' } },
    ]);
    const store = createFakeDataStore(initial);
    const select = vi.fn();
    const focusNodes = vi.fn(() => true);
    const camera = {
      get: () => ({ x: 0, y: 0, zoom: 1 }),
      stageSize: () => ({ w: 1200, h: 800 }),
    } as unknown as BoardCommands['camera'];

    const touched = applyBoardInsertCommand(
      {
        type: 'board.insert',
        projectId: 'p-1',
        drafts: [
          { kind: 'image', path: 'assets/source.png', provenance: { source: 'material', materialId: 'mat-1', license: 'CC0' } },
          { kind: 'video', path: 'clips/intro.mp4', title: 'Intro' },
          { kind: 'frame', path: 'index.html', title: 'Home' },
          { kind: 'design', path: 'designs/hero.fig', title: 'Hero', sourceNodeId: 'n_img_source' },
          { kind: 'motion', projectId: 'p-1', path: 'movie-studio.json', title: 'Film' },
          { kind: 'web', url: 'https://example.com', title: 'Example' },
          { kind: 'note', text: 'Remember this', title: 'Memo' },
        ],
      },
      { store, commands: { camera, select, focusNodes } },
    );

    expect(touched).toHaveLength(7);
    expect(touched[0]).toBe('n_img_source');
    const board = store.getState().board!;
    const sourceImg = board.nodes.find((n) => n.id === 'n_img_source');
    expect(sourceImg?.provenance).toEqual({ source: 'material', materialId: 'mat-1', license: 'CC0' });

    const designNode = board.nodes.find((n) => n.kind === 'design' && n.ref.path === 'designs/hero.fig');
    expect(designNode).toBeDefined();
    expect(board.edges.some((e) => e.kind === 'lineage' && e.from === 'n_img_source' && e.to === designNode!.id)).toBe(true);

    const motionNode = board.nodes.find((n) => n.kind === 'motion');
    expect(motionNode?.id).toBe(stableBoardId('n', 'movie:p-1'));
    expect(select).toHaveBeenCalledWith(touched, { reveal: true });
  });

  it('drains queued board inserts on mount and handles live board.insert commands for its projectId only', () => {
    const store = createFakeDataStore(makeBoard([]));
    const select = vi.fn();
    const commandsRef = {
      current: {
        camera: { get: () => ({ x: 0, y: 0, zoom: 1 }), stageSize: () => ({ w: 1200, h: 800 }) },
        select,
        focusNodes: vi.fn(() => true),
      } as unknown as BoardCommands,
    };

    queueBoardInsert({
      type: 'board.insert',
      projectId: 'p-1',
      drafts: [{ kind: 'note', text: 'Queued note' }],
    });

    renderHook(() =>
      useBoardInsertBridge({
        projectId: 'p-1',
        boardReady: true,
        readOnly: false,
        store,
        commandsRef,
      }),
    );

    expect(store.getState().board!.nodes.some((n) => n.kind === 'note' && n.text === 'Queued note')).toBe(true);

    let handledOther = false;
    let handledOwn = false;
    act(() => {
      handledOther = sendWorkspaceCommand({
        type: 'board.insert',
        projectId: 'other-project',
        drafts: [{ kind: 'note', text: 'Other' }],
      });
      handledOwn = sendWorkspaceCommand({
        type: 'board.insert',
        projectId: 'p-1',
        drafts: [{ kind: 'design', path: 'designs/live.op', title: 'Live OP' }],
      });
    });

    expect(handledOther).toBe(false);
    expect(handledOwn).toBe(true);
    expect(
      store.getState().board!.nodes.some((n) => n.kind === 'design' && n.ref.path === 'designs/live.op' && n.format === 'op'),
    ).toBe(true);
  });
});

describe('useBoardFocusRequest', () => {
  it('selects and flies to the project motion node once per focusRequest nonce', () => {
    const motionId = stableBoardId('n', 'movie:p-1');
    const store = createFakeDataStore(
      makeBoard([
        { id: motionId, kind: 'motion', x: 200, y: 120, w: 480, h: 314, source: { type: 'movie', projectId: 'p-1' } },
      ]),
    );
    const select = vi.fn();
    const focusNodes = vi.fn(() => true);
    const commandsRef = {
      current: { select, focusNodes } as unknown as BoardCommands,
    };

    const { rerender } = renderHook(
      ({ nonce }) =>
        useBoardFocusRequest({
          projectId: 'p-1',
          boardReady: true,
          focusRequest: { kind: 'motion', nonce },
          store,
          commandsRef,
        }),
      { initialProps: { nonce: 1 } },
    );

    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith([motionId]);
    expect(focusNodes).toHaveBeenCalledWith([motionId], { animate: true });

    rerender({ nonce: 1 });
    expect(select).toHaveBeenCalledTimes(1);

    rerender({ nonce: 2 });
    expect(select).toHaveBeenCalledTimes(2);
  });
});
