// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { Profiler, createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardDocument, BoardNodeDraft } from '@open-design/contracts';

import { BoardView, type BoardViewProps } from '../../../src/fantay/board/BoardView';
import type { BoardCommands } from '../../../src/fantay/board/commands/board-commands';
import type { BoardFocusIntent } from '../../../src/fantay/board/data/types';
import { BOARD_INTERACTIVE_ATTR } from '../../../src/fantay/board/extensions';
import { resolvePointerTarget } from '../../../src/fantay/board/interaction/pointer';
import { resetFantayCommandsForTests, runFantayCommand } from '../../../src/fantay/shell/commands';
import { getBoardViewport, resetBoardViewportForTests } from '../../../src/fantay/workspace/board-viewport-store';
import {
  createFakeDataStore,
  createFrameQueue,
  createManualTimers,
  dataValue,
  frameDraft,
  groupDraft,
  makeBoard,
  noteDraft,
  PROJECT_ID,
  type FakeDataStore,
} from './engine-fixtures';

const STAGE = { w: 1200, h: 800 };

/* jsdom has no layout: the board stage reports a fixed size, every other element 0 */
const sizeDescriptors = {
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
};

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'board-stage' ? STAGE.w : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.testid === 'board-stage' ? STAGE.h : 0;
    },
  });
});

afterAll(() => {
  if (sizeDescriptors.clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', sizeDescriptors.clientWidth);
  if (sizeDescriptors.clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', sizeDescriptors.clientHeight);
});

beforeEach(() => {
  resetFantayCommandsForTests();
  resetBoardViewportForTests();
});

afterEach(() => {
  cleanup();
  resetFantayCommandsForTests();
  resetBoardViewportForTests();
});

/** 12 frames in a row and 3 notes below them. */
function fixtureBoard(): BoardDocument {
  const drafts: BoardNodeDraft[] = [];
  for (let index = 0; index < 12; index += 1) drafts.push(frameDraft(`n_f${index}`, index * 1600, 0, `page-${index}.html`));
  for (let index = 0; index < 3; index += 1) drafts.push(noteDraft(`n_note${index}`, index * 400, 1200, `note ${index}`));
  return makeBoard(drafts);
}

interface Harness {
  data: FakeDataStore;
  frames: ReturnType<typeof createFrameQueue>;
  timers: ReturnType<typeof createManualTimers>;
  commands: () => BoardCommands;
  props: BoardViewProps;
  rerender(next: Partial<BoardViewProps>): void;
  commits: { count: number };
  flush(ms?: number): void;
}

function mount(options: {
  board?: BoardDocument;
  viewport?: { centerX: number; centerY: number; zoom: number } | null;
  host?: NonNullable<Parameters<typeof dataValue>[1]>['host'];
  focusIntent?: BoardFocusIntent | null;
  ack?: (nonce: number) => void;
  onSelectionChange?: (ids: readonly string[]) => void;
  files?: BoardViewProps['files'];
} = {}): Harness {
  const data = createFakeDataStore(options.board ?? fixtureBoard(), { initialViewport: options.viewport === undefined ? { centerX: 720, centerY: 450, zoom: 1 } : options.viewport });
  const frames = createFrameQueue();
  const timers = createManualTimers();
  const commandsRef = createRef<BoardCommands>();
  const commits = { count: 0 };
  const props: BoardViewProps = {
    data: dataValue(data, { host: options.host, focusIntent: options.focusIntent ?? null, ...(options.ack ? { ack: options.ack } : {}) }),
    files: options.files ?? [],
    filesAuthoritative: false,
    filesRefreshKey: 0,
    liveArtifacts: [],
    workspaceContext: null,
    commandsRef,
    onOpenInFiles: vi.fn(),
    ...(options.onSelectionChange ? { onSelectionChange: options.onSelectionChange } : {}),
    engineOptions: {
      now: timers.now,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      camera: { reducedMotion: () => true, density: true },
    },
  };
  const tree = (current: BoardViewProps) => (
    <Profiler id="board" onRender={() => { commits.count += 1; }}>
      <BoardView {...current} />
    </Profiler>
  );
  let current = props;
  const view = render(tree(current));
  const flush = (ms = 0): void => {
    act(() => {
      frames.flush();
      if (ms > 0) timers.advance(ms);
      frames.flush();
    });
  };
  flush(300);
  return {
    data,
    frames,
    timers,
    commands: () => commandsRef.current!,
    props,
    commits,
    flush,
    rerender(next) {
      current = { ...current, ...next };
      view.rerender(tree(current));
    },
  };
}

function nodeElement(id: string): HTMLElement {
  const el = screen.getAllByTestId('board-node').find((node) => node.dataset.nodeId === id);
  if (!el) throw new Error(`node ${id} not rendered`);
  return el;
}

const renderedIds = () => screen.queryAllByTestId('board-node').map((node) => node.dataset.nodeId);

describe('BoardView', () => {
  it('starts from the 04 initial viewport and renders only the culled visible nodes', () => {
    const h = mount();
    expect(h.commands().camera.get()).toEqual({ x: 600 - 720, y: 400 - 450, zoom: 1 });
    // view 120..1320 × 50..850 plus 300 px overscan: two of the 15 nodes
    expect(renderedIds()).toEqual(['n_f0', 'n_f1']);
    expect(screen.getByTestId('board-root')).toHaveAttribute('role', 'application');
    expect(screen.getByTestId('board-world').style.transform).toBe('translate(-120px, -50px) scale(1)');
  });

  it('fits the content when there is no saved viewport; tiny nodes render as LOD rects', () => {
    const h = mount({ viewport: null });
    const cam = h.commands().camera.get();
    expect(cam.zoom).toBeLessThan(0.1);
    // everything fits: all 15 nodes are visible (frames and the notes below)
    expect(renderedIds()).toHaveLength(15);
    // notes are 280 px wide → < 24 screen px at this zoom: flat LOD rects without labels or faces
    const lod = screen.queryAllByTestId('board-node-lod').map((el) => el.closest('[data-board-node]')?.getAttribute('data-node-id'));
    expect(lod.sort()).toEqual(['n_note0', 'n_note1', 'n_note2']);
    expect(screen.queryByTestId('board-note')).toBeNull();
  });

  it('leaves presses inside data-board-interactive regions to their content (R6)', () => {
    const region = document.createElement('div');
    region.setAttribute(BOARD_INTERACTIVE_ATTR, '');
    const button = document.createElement('span');
    region.append(button);
    const node = document.createElement('div');
    node.setAttribute('data-board-node', '');
    node.setAttribute('data-node-id', 'n_x');
    node.append(region);
    const plain = document.createElement('span');
    node.append(plain);
    expect(resolvePointerTarget(button)).toEqual({ kind: 'interactive' });
    expect(resolvePointerTarget(plain)).toEqual({ kind: 'node', id: 'n_x' });
    const h = mount();
    const stage = screen.getByTestId('board-stage');
    stage.append(node);
    act(() => {
      fireEvent.pointerDown(button, { pointerId: 8, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 8, clientX: 200, clientY: 200 });
      h.frames.flush();
    });
    expect(screen.queryByTestId('board-marquee')).toBeNull();
    expect(h.commands().getSelection()).toEqual([]);
  });

  it('commits nothing to React during 60 camera sets (I2)', () => {
    const h = mount();
    const camera = h.commands().camera;
    const start = camera.get();
    h.commits.count = 0;
    act(() => {
      for (let step = 1; step <= 60; step += 1) {
        camera.set({ x: start.x - step, y: start.y - step * 0.5, zoom: start.zoom });
        h.frames.flush();
      }
    });
    expect(h.commits.count).toBe(0);
    expect(screen.getByTestId('board-world').style.transform).toBe(`translate(${start.x - 60}px, ${start.y - 30}px) scale(1)`);
    expect(screen.getByTestId('board-root').style.getPropertyValue('--vx')).toBe(`${start.x - 60}px`);
    // settle with the same zoom: still nothing to commit
    h.flush(300);
    expect(h.commits.count).toBe(0);
    // a pan that changes the visible set does commit
    act(() => {
      camera.set({ x: -3000, y: start.y, zoom: 1 });
      h.frames.flush();
    });
    expect(h.commits.count).toBeGreaterThan(0);
    // the live n_f0 stays mounted until the camera settles (the live set is frozen while it moves)
    expect(renderedIds()).toEqual(['n_f0', 'n_f1', 'n_f2']);
    h.flush(250);
    expect(renderedIds()).toEqual(['n_f1', 'n_f2']);
  });

  it('keeps the live set while the camera moves and recomputes it on settle (03 §3.5)', () => {
    const h = mount();
    const live = () => screen.getAllByTestId('board-node').filter((node) => node.dataset.live === 'true').map((node) => node.dataset.nodeId);
    expect(live()).toEqual(['n_f0']);
    act(() => {
      h.commands().camera.set({ x: -3200, y: -50, zoom: 1 });
      h.frames.flush();
    });
    // the visible set follows the camera at once; the live slot does not move mid-gesture
    expect(renderedIds()).toEqual(['n_f0', 'n_f1', 'n_f2']);
    expect(live()).toEqual(['n_f0']);
    h.flush(250);
    expect(live()).toEqual(['n_f2']);
    expect(renderedIds()).toEqual(['n_f1', 'n_f2']);
  });

  it('demotes every live surface 5 s after the board becomes inactive (R6)', () => {
    const h = mount();
    const liveCount = () => screen.getAllByTestId('board-node').filter((node) => node.dataset.live === 'true').length;
    expect(liveCount()).toBe(1);
    act(() => {
      h.rerender({ data: { ...h.props.data, host: { ...h.props.data.host, active: false } } });
    });
    h.flush(4_999);
    expect(liveCount()).toBe(1);
    h.flush(1);
    expect(liveCount()).toBe(0);
  });

  it('a press on the canvas ends inline editing and keeps the edit (rename, note text)', () => {
    const h = mount();
    const stage = screen.getByTestId('board-stage');
    act(() => {
      h.commands().startRename('n_f0');
    });
    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: 'Hero page' } });
    act(() => {
      fireEvent.pointerDown(stage, { pointerId: 21, button: 0, clientX: 600, clientY: 780 });
      fireEvent.pointerUp(window, { pointerId: 21, clientX: 600, clientY: 780 });
    });
    h.flush();
    expect(h.data.applyCalls.at(-1)?.ops).toEqual([{ op: 'update', id: 'n_f0', patch: { title: 'Hero page' } }]);
    expect(screen.queryByRole('textbox')).toBeNull();
    // the board, not a control that kept focus, gets the next keys
    expect(document.activeElement).toBe(screen.getByTestId('board-root'));
    act(() => {
      h.commands().startTextEdit('n_note0');
    });
    h.flush();
    const editor = screen.getByRole('textbox', { name: 'Note' });
    fireEvent.change(editor, { target: { value: 'Keep me' } });
    act(() => {
      fireEvent.pointerDown(stage, { pointerId: 22, button: 0, clientX: 600, clientY: 780 });
      fireEvent.pointerUp(window, { pointerId: 22, clientX: 600, clientY: 780 });
    });
    h.flush();
    expect(h.data.applyCalls.at(-1)?.ops).toEqual([{ op: 'update', id: 'n_note0', patch: { text: 'Keep me' } }]);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a double-click on a group body (canvas for the pointer) selects the group', () => {
    const h = mount({ board: makeBoard([groupDraft('n_g', 0, 0, 2000, 1000), { ...noteDraft('n_in', 100, 100), parentId: 'n_g' } as BoardNodeDraft]) });
    const stage = screen.getByTestId('board-stage');
    // client (900, 700) = world (1020, 750): inside the group, outside its note
    act(() => {
      fireEvent.doubleClick(stage, { clientX: 900, clientY: 700 });
    });
    expect(h.commands().getSelection()).toEqual(['n_g']);
  });

  it('text shapes follow their content height after an edit (autosize, not undoable)', () => {
    const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>();
    class FakeResizeObserver {
      private readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() };
        observers.add(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.add(target);
      }
      unobserve(target: Element) {
        this.entry.targets.delete(target);
      }
      disconnect() {
        observers.delete(this.entry);
      }
    }
    const resizeAll = (): void => {
      for (const entry of [...observers]) {
        entry.callback([...entry.targets].map((target) => ({ target }) as ResizeObserverEntry), {} as ResizeObserver);
      }
    };
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // jsdom has no layout: 30 px per text line inside a shape face
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.closest('[data-testid="board-shape"]') ? (this.textContent ?? '').split('\n').length * 30 : 0;
      },
    });
    try {
      const textStyle = { fontSize: 24, fontWeight: 500, align: 'left', color: 'ink' };
      const h = mount({ board: makeBoard([{ kind: 'shape', id: 'n_text', x: 100, y: 100, w: 240, h: 30, shape: 'text', text: 'one', textStyle } as BoardNodeDraft]) });
      act(() => resizeAll());
      expect(h.data.apply).not.toHaveBeenCalled(); // one line = the node height
      act(() => {
        h.commands().startTextEdit('n_text');
      });
      h.flush();
      const editor = screen.getByRole('textbox');
      fireEvent.change(editor, { target: { value: 'one\ntwo\nthree' } });
      act(() => {
        fireEvent.blur(editor);
      });
      h.flush();
      expect(h.data.applyCalls.at(-1)?.ops).toEqual([{ op: 'update', id: 'n_text', patch: { text: 'one\ntwo\nthree' } }]);
      act(() => resizeAll());
      h.flush();
      expect(h.data.applyCalls.at(-1)?.ops).toEqual([{ op: 'update', id: 'n_text', patch: { h: 90 } }]);
      expect(h.data.applyCalls.at(-1)?.options).toMatchObject({ undoable: false, label: 'autosize' });
    } finally {
      vi.unstubAllGlobals();
      delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });

  it('keeps at most four live surfaces with ten frames on screen (R6)', () => {
    const drafts: BoardNodeDraft[] = [];
    for (let index = 0; index < 10; index += 1) drafts.push(frameDraft(`n_s${index}`, (index % 5) * 460, Math.floor(index / 5) * 340, `s-${index}.html`, { w: 400, h: 300 }));
    mount({ board: makeBoard(drafts), viewport: { centerX: 1100, centerY: 300, zoom: 0.5 } });
    expect(renderedIds()).toHaveLength(10);
    const live = screen.getAllByTestId('board-node').filter((node) => node.dataset.live === 'true');
    expect(live).toHaveLength(4);
    // the shield is up on live nodes (they show an iframe in the node-chrome faces)
    expect(screen.getAllByTestId('board-node-shield')).toHaveLength(4);
  });

  it('creates a note with N + click and removes it with mod+Z (undo through the 04 store)', () => {
    const h = mount();
    const root = screen.getByTestId('board-root');
    const stage = screen.getByTestId('board-stage');
    fireEvent.pointerDown(root, { pointerId: 9, button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 5, clientY: 5 });
    act(() => {
      fireEvent.keyDown(root, { key: 'n' });
    });
    expect(stage).toHaveAttribute('data-tool', 'note');
    act(() => {
      fireEvent.pointerDown(stage, { pointerId: 1, button: 0, clientX: 400, clientY: 300 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 300 });
    });
    h.flush();
    expect(h.data.apply).toHaveBeenCalledTimes(1);
    const [add] = h.data.applyCalls[0]!.ops;
    expect(add).toMatchObject({ op: 'add', node: { kind: 'note', x: 400 + 120 - 140, y: 300 + 50 - 110, text: '' } });
    expect(h.data.applyCalls[0]!.options).toMatchObject({ undoable: true, label: 'create' });
    const noteId = add!.op === 'add' ? add!.node.id! : '';
    expect(renderedIds()).toContain(noteId);
    // the new note is in edit mode; leaving it keeps an empty note
    const editor = screen.getByRole('textbox', { name: 'Note' });
    act(() => {
      fireEvent.keyDown(editor, { key: 'Escape' });
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    act(() => {
      fireEvent.keyDown(root, { key: 'z', ctrlKey: true });
    });
    h.flush();
    expect(h.data.undo).toHaveBeenCalledTimes(1);
    expect(renderedIds()).not.toContain(noteId);
  });

  it('Tab cycles the selection in reading order, Delete removes it from the board, Escape clears', () => {
    const h = mount();
    const root = screen.getByTestId('board-root');
    fireEvent.pointerDown(root, { pointerId: 11, button: 0, clientX: 1, clientY: 1 });
    act(() => {
      fireEvent.keyDown(root, { key: 'Tab' });
    });
    expect(h.commands().getSelection()).toEqual(['n_f0']);
    act(() => {
      fireEvent.keyDown(root, { key: 'Tab' });
    });
    expect(h.commands().getSelection()).toEqual(['n_f1']);
    act(() => {
      fireEvent.keyDown(root, { key: 'Delete' });
    });
    expect(h.data.applyCalls.at(-1)!.ops).toEqual([{ op: 'remove', ids: ['n_f1'] }]);
    act(() => {
      fireEvent.keyDown(root, { key: 'Tab' });
    });
    act(() => {
      fireEvent.keyDown(root, { key: 'Escape' });
    });
    expect(h.commands().getSelection()).toEqual([]);
  });

  it('drags a node with a live preview and applies one move on release', () => {
    const selections: Array<readonly string[]> = [];
    const h = mount({ onSelectionChange: (ids) => selections.push(ids) });
    const node = nodeElement('n_f0');
    act(() => {
      fireEvent.pointerDown(node, { pointerId: 2, button: 0, clientX: 300, clientY: 300 });
    });
    expect(selections.at(-1)).toEqual(['n_f0']);
    act(() => {
      fireEvent.pointerMove(window, { pointerId: 2, clientX: 320, clientY: 310 });
      h.frames.flush();
      fireEvent.pointerMove(window, { pointerId: 2, clientX: 400, clientY: 350 });
      h.frames.flush();
    });
    // preview only: nothing applied yet, the node is drawn at the preview rect
    expect(h.data.apply).not.toHaveBeenCalled();
    expect(nodeElement('n_f0').style.left).toBe('100px');
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 2, clientX: 400, clientY: 350 });
    });
    h.flush();
    expect(h.data.apply).toHaveBeenCalledTimes(1);
    expect(h.data.applyCalls[0]!.ops).toEqual([{ op: 'move', moves: [{ id: 'n_f0', x: 100, y: 50 }] }]);
    expect(nodeElement('n_f0').style.left).toBe('100px');
  });

  it('resizes from a handle with one update on release', () => {
    const h = mount();
    act(() => {
      h.commands().select(['n_f0']);
    });
    h.flush();
    const handle = screen.getByTestId('board-handle-se');
    act(() => {
      fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 1320, clientY: 850 });
      fireEvent.pointerMove(window, { pointerId: 3, clientX: 1100, clientY: 700 });
      h.frames.flush();
    });
    expect(screen.getByTestId('board-resize-badge')).toHaveTextContent('1220 × 750');
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 3, clientX: 1100, clientY: 700 });
    });
    h.flush();
    expect(h.data.apply).toHaveBeenCalledTimes(1);
    expect(h.data.applyCalls[0]!.ops).toEqual([{ op: 'update', id: 'n_f0', patch: { w: 1220, h: 750, device: 'custom' } }]);
  });

  it('marquee-selects on the background and clears with a plain click', () => {
    const h = mount();
    const stage = screen.getByTestId('board-stage');
    act(() => {
      fireEvent.pointerDown(stage, { pointerId: 4, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 4, clientX: 200, clientY: 200 });
      h.frames.flush();
    });
    expect(screen.getByTestId('board-marquee')).toBeInTheDocument();
    act(() => {
      fireEvent.pointerUp(window, { pointerId: 4, clientX: 200, clientY: 200 });
    });
    h.flush();
    expect(h.commands().getSelection()).toEqual(['n_f0']);
    expect(screen.queryByTestId('board-marquee')).toBeNull();
    act(() => {
      fireEvent.pointerDown(stage, { pointerId: 5, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerUp(window, { pointerId: 5, clientX: 10, clientY: 10 });
    });
    expect(h.commands().getSelection()).toEqual([]);
  });

  it('publishes the viewport on settle while active and saves it to the 04 store', () => {
    const h = mount();
    expect(getBoardViewport()).toEqual({ projectId: PROJECT_ID, zoom: 1, minZoom: 0.05, maxZoom: 8 });
    act(() => {
      h.commands().camera.zoomTo(2);
    });
    expect(getBoardViewport()?.zoom).toBe(1); // not before settle
    h.flush(250);
    expect(getBoardViewport()?.zoom).toBe(2);
    expect(h.data.viewports.at(-1)).toEqual({ centerX: 720, centerY: 450, zoom: 2 });
  });

  it('registers fantay.board.* commands only while active (B5) and publishes null when inactive', () => {
    const h = mount();
    expect(runFantayCommand('fantay.board.zoomIn')).toBe(true);
    expect(h.commands().camera.get().zoom).toBeCloseTo(1.25, 9);
    expect(runFantayCommand('fantay.board.zoomTo', { zoom: 0.5 })).toBe(true);
    expect(h.commands().camera.get().zoom).toBe(0.5);
    act(() => {
      h.rerender({ data: { ...h.props.data, host: { ...h.props.data.host, active: false } } });
    });
    h.flush();
    expect(runFantayCommand('fantay.board.zoomIn')).toBe(false);
    expect(h.commands().camera.get().zoom).toBe(0.5);
    expect(getBoardViewport()).toBeNull();
    act(() => {
      h.rerender({ data: { ...h.props.data, host: { ...h.props.data.host, active: true } } });
    });
    h.flush();
    expect(runFantayCommand('fantay.board.zoomFit')).toBe(true);
  });

  it('inserts files through fantay.board.insertFiles (one node per path)', () => {
    const h = mount();
    act(() => {
      expect(runFantayCommand('fantay.board.insertFiles', { paths: ['page-0.html', 'cover.png'] })).toBe(true);
    });
    h.flush();
    expect(h.data.apply).toHaveBeenCalledTimes(1);
    const ops = h.data.applyCalls[0]!.ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'add', ifAbsent: true, node: { kind: 'image', ref: { path: 'cover.png' } } });
  });

  it('executes a fly-to focus intent, selects its nodes and acknowledges it', () => {
    const ack = vi.fn();
    const h = mount({
      focusIntent: { nonce: 7, nodeIds: ['n_f5', 'n_gone'], primaryNodeId: 'n_f5', behavior: 'fly-to', source: 'open-request' },
      ack,
    });
    expect(ack).toHaveBeenCalledWith(7);
    expect(h.commands().getSelection()).toEqual(['n_f5']);
    const cam = h.commands().camera.get();
    const centerX = (5 * 1600 + 720) * cam.zoom + cam.x;
    expect(centerX).toBeCloseTo(STAGE.w / 2, 3);
    expect(renderedIds()).toContain('n_f5');
  });

  it('shows the reveal pill for a reveal-pill intent and flies on click', () => {
    const ack = vi.fn();
    const h = mount({
      focusIntent: { nonce: 3, nodeIds: ['n_f9'], primaryNodeId: 'n_f9', behavior: 'reveal-pill', source: 'run-finished' },
      ack,
    });
    expect(ack).toHaveBeenCalledWith(3);
    const pill = screen.getByTestId('board-focus-pill');
    expect(pill).toHaveAttribute('data-state', 'open');
    expect(h.commands().getSelection()).toEqual([]);
    act(() => {
      fireEvent.click(pill.querySelector('button')!);
    });
    h.flush();
    expect(pill).toHaveAttribute('data-state', 'closed');
    expect(h.commands().getSelection()).toEqual(['n_f9']);
    expect(renderedIds()).toContain('n_f9');
  });

  it('read-only boards select but never move nodes', () => {
    const h = mount({ host: { readOnly: true } });
    const node = nodeElement('n_f0');
    act(() => {
      fireEvent.pointerDown(node, { pointerId: 6, button: 0, clientX: 300, clientY: 300 });
      fireEvent.pointerMove(window, { pointerId: 6, clientX: 400, clientY: 400 });
      h.frames.flush();
      fireEvent.pointerUp(window, { pointerId: 6, clientX: 400, clientY: 400 });
    });
    h.flush();
    expect(h.commands().getSelection()).toEqual(['n_f0']);
    expect(h.data.apply).not.toHaveBeenCalled();
    expect(screen.getByTestId('board-root')).toHaveAttribute('data-readonly');
  });

  it('shows labels with the file name above frames and announces the selection', () => {
    const h = mount();
    const label = screen.getAllByTestId('board-node-label').find((el) => el.dataset.nodeId === 'n_f0')!;
    expect(label).toHaveTextContent('page-0.html');
    act(() => {
      h.commands().select(['n_f0']);
    });
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('page-0.html');
    expect(nodeElement('n_f0')).toHaveAttribute('aria-current', 'true');
  });
});
