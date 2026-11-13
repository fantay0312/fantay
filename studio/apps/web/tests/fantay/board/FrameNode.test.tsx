// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardNodeDraft } from '@open-design/contracts';

import { FRAME_BRIDGE_TOKENS, FRAME_SANDBOX } from '../../../src/fantay/board/engine/frame-transport';
import { FrameSurface } from '../../../src/fantay/board/nodes/frame/FrameSurface';
import { FRAME_RELOAD_MIN_INTERVAL_MS, useFrameLive } from '../../../src/fantay/board/nodes/frame/use-frame-live';
import { installStageSize, mountBoard, type BoardHarness } from './chrome-fixtures';
import { frameDraft, makeBoard } from './engine-fixtures';

let restoreStage: () => void = () => {};
beforeAll(() => {
  restoreStage = installStageSize();
});
afterAll(() => restoreStage());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function tenFrames(): BoardNodeDraft[] {
  const drafts: BoardNodeDraft[] = [];
  for (let index = 0; index < 10; index += 1) drafts.push(frameDraft(`n_s${index}`, (index % 5) * 460, Math.floor(index / 5) * 340, `s-${index}.html`, { w: 400, h: 300 }));
  return drafts;
}

async function settle(): Promise<void> {
  // transport decisions resolve in microtasks
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function frameNode(id: string): HTMLElement {
  const node = screen.getAllByTestId('board-node').find((element) => element.dataset.nodeId === id);
  if (!node) throw new Error(`node ${id} not rendered`);
  return node;
}

function shieldOf(id: string): HTMLElement | null {
  return within(frameNode(id)).queryByTestId('board-node-shield');
}

async function mountTen(): Promise<BoardHarness> {
  const h = mountBoard({ board: makeBoard(tenFrames()), viewport: { centerX: 1100, centerY: 300, zoom: 0.5 } });
  await settle();
  return h;
}

describe('FrameNode', () => {
  it('mounts at most four iframes with ten frames on screen; the others show their cover/placeholder (R6)', async () => {
    await mountTen();
    const frames = screen.getAllByTestId('board-frame');
    expect(frames).toHaveLength(10);
    const iframes = screen.getAllByTestId('board-frame-iframe');
    expect(iframes).toHaveLength(4);
    for (const iframe of iframes) {
      expect(iframe).toHaveAttribute('sandbox', FRAME_SANDBOX);
      expect(iframe).toHaveAttribute('data-transport', 'url');
      const src = iframe.getAttribute('src') ?? '';
      for (const token of FRAME_BRIDGE_TOKENS) expect(src).toContain(`odPreviewBridge=${token}`);
      expect(src).not.toContain('buildfocus');
    }
    const idle = frames.filter((frame) => frame.dataset.live === undefined);
    expect(idle).toHaveLength(6);
    for (const frame of idle) {
      expect(within(frame).queryByTestId('board-frame-iframe')).toBeNull();
      expect(within(frame).getByTestId('board-face-placeholder')).toBeInTheDocument();
    }
  });

  it('lifts the shield for Navigate and Capture ▸ Pick, keeps it for Markup, and Space raises it again', async () => {
    const h = await mountTen();
    const live = screen.getAllByTestId('board-node').filter((node) => node.dataset.live === 'true');
    const id = live[0]!.dataset.nodeId!;
    expect(shieldOf(id)).not.toBeNull();

    act(() => h.commands().setMode(id, 'navigate'));
    expect(shieldOf(id)).toBeNull();
    // holding Space always raises the shield (pan over a live page)
    const root = screen.getByTestId('board-root');
    act(() => {
      fireEvent.pointerDown(root, { pointerId: 4, button: 0, clientX: 2, clientY: 2 });
      fireEvent.pointerUp(window, { pointerId: 4, clientX: 2, clientY: 2 });
      fireEvent.keyDown(root, { key: ' ' });
    });
    expect(shieldOf(id)).not.toBeNull();
    act(() => {
      fireEvent.keyUp(root, { key: ' ' });
    });
    expect(shieldOf(id)).toBeNull();

    act(() => h.commands().setMode(id, 'capture'));
    expect(shieldOf(id)).toBeNull();
    act(() => h.commands().setMode(id, 'capture', 'markup'));
    expect(shieldOf(id)).not.toBeNull();

    act(() => h.commands().setMode(null));
    expect(shieldOf(id)).not.toBeNull();
  });
});

function LiveHarness({ reload, live = true }: { reload: number; live?: boolean }) {
  const frame = useFrameLive({
    live,
    projectId: 'p_live',
    path: 'index.html',
    liveArtifactId: null,
    file: undefined,
    building: false,
    filesRefreshKey: 0,
    isDeckProject: false,
    projectFilePaths: null,
    workspaceContext: null,
    editingSource: null,
    reload,
  });
  return (
    <FrameSurface
      title="Home"
      width={400}
      height={300}
      layoutZoom={1}
      sandbox={FRAME_SANDBOX}
      current={frame.current}
      pending={frame.pending}
      active
      motionActive={false}
      motionMuted
      underlay={<span data-testid="underlay" />}
      ready={frame.ready}
      onFrame={() => {}}
      onFrameGone={() => {}}
      onLoad={frame.onLoad}
    />
  );
}

describe('reload without flash (03 §5.2)', () => {
  it('keeps the old iframe until the pending document loaded, then swaps (one swap per 1 200 ms)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    const view = render(<LiveHarness reload={0} />);
    await act(async () => {
      await Promise.resolve();
    });
    const first = screen.getByTestId('board-frame-iframe');
    expect(first).toHaveAttribute('data-role', 'current');
    act(() => {
      fireEvent.load(first);
      vi.advanceTimersByTime(40);
    });
    expect(screen.getByTestId('underlay').parentElement).toHaveAttribute('data-hidden');

    view.rerender(<LiveHarness reload={1} />);
    await act(async () => {
      await Promise.resolve();
    });
    // within the swap interval the new document waits
    expect(screen.getAllByTestId('board-frame-iframe')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(FRAME_RELOAD_MIN_INTERVAL_MS);
    });
    const iframes = screen.getAllByTestId('board-frame-iframe');
    expect(iframes).toHaveLength(2);
    const pending = iframes.find((iframe) => iframe.dataset.role === 'pending')!;
    expect(pending.getAttribute('src')).toContain('r=1');
    expect(iframes.find((iframe) => iframe.dataset.role === 'current')).toBe(first);

    act(() => {
      fireEvent.load(pending);
      vi.advanceTimersByTime(40);
    });
    const after = screen.getAllByTestId('board-frame-iframe');
    expect(after).toHaveLength(1);
    // the pending element itself became current: no second load
    expect(after[0]).toBe(pending);
    expect(after[0]).toHaveAttribute('data-role', 'current');
  });

  it('drops both documents when the node leaves the live set', async () => {
    const view = render(<LiveHarness reload={0} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getAllByTestId('board-frame-iframe')).toHaveLength(1);
    view.rerender(<LiveHarness reload={0} live={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByTestId('board-frame-iframe')).toBeNull();
    expect(screen.getByTestId('underlay')).toBeInTheDocument();
  });
});
