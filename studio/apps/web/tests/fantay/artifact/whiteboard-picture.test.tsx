// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The whiteboard's picture keeping, with the drawing library replaced: a version is drawn once and
// kept, the last good picture is back on screen at once after a remount, a draw that takes too long
// ends in its own phase, and a failed draw says so.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WhiteboardPicture } from '../../../src/fantay/artifact/viewers/whiteboard/draw';
import type { WhiteboardScene } from '../../../src/fantay/artifact/viewers/whiteboard/scene';

const drawScene = vi.fn<(scene: WhiteboardScene, dark: boolean) => Promise<WhiteboardPicture | null>>();
vi.mock('../../../src/fantay/artifact/viewers/whiteboard/draw', () => ({ drawScene: (scene: WhiteboardScene, dark: boolean) => drawScene(scene, dark) }));

const { DRAW_TIME_LIMIT_MS, forgetWhiteboardPictures, useWhiteboardPicture } = await import(
  '../../../src/fantay/artifact/viewers/whiteboard/use-whiteboard-picture'
);

const SCENE: WhiteboardScene = { elements: [{ type: 'rectangle' }], files: {}, background: '#ffffff', authoredDark: false };

function picture(label: string): WhiteboardPicture {
  return { svg: new Blob([`<svg>${label}</svg>`], { type: 'image/svg+xml' }), width: 100, height: 50, origin: { x: 0, y: 0 }, paper: true };
}

let urls = 0;
beforeEach(() => {
  forgetWhiteboardPictures();
  drawScene.mockReset();
  urls = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:picture-${(urls += 1)}`, revokeObjectURL: () => undefined }));
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: () => Promise.resolve() });
});

afterEach(() => {
  vi.useRealTimers();
});

function use(renderKey: string, scene: WhiteboardScene | null = SCENE, enabled = true) {
  return renderHook((props: { renderKey: string; scene: WhiteboardScene | null }) =>
    useWhiteboardPicture({ fileKey: 'p\nboard.excalidraw', renderKey: props.renderKey, scene: props.scene, dark: false, enabled }),
  { initialProps: { renderKey, scene } });
}

describe('useWhiteboardPicture', () => {
  it('draws a version once and shows it', async () => {
    drawScene.mockResolvedValue(picture('one'));
    const view = use('p\nboard.excalidraw\nv1\nlight');
    await waitFor(() => expect(view.result.current.shown?.key).toBe('p\nboard.excalidraw\nv1\nlight'));
    expect(drawScene).toHaveBeenCalledTimes(1);
    view.unmount();

    // A remount (a tab switch) shows the same picture before anything is fetched or drawn.
    const again = use('p\nboard.excalidraw\npending\nlight', null);
    expect(again.result.current.shown?.key).toBe('p\nboard.excalidraw\nv1\nlight');
    again.rerender({ renderKey: 'p\nboard.excalidraw\nv1\nlight', scene: SCENE });
    expect(drawScene).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous picture on screen while a new version is drawn', async () => {
    drawScene.mockResolvedValueOnce(picture('one'));
    const view = use('k\nv1');
    await waitFor(() => expect(view.result.current.shown?.key).toBe('k\nv1'));
    let finish: (value: WhiteboardPicture) => void = () => undefined;
    drawScene.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    view.rerender({ renderKey: 'k\nv2', scene: { ...SCENE } });
    expect(view.result.current.shown?.key).toBe('k\nv1');
    expect(['drawing', 'slow']).toContain(view.result.current.phase);
    await act(async () => finish(picture('two')));
    await waitFor(() => expect(view.result.current.shown?.key).toBe('k\nv2'));
  });

  it('ends a draw that takes too long in the timeout phase', async () => {
    vi.useFakeTimers();
    drawScene.mockReturnValue(new Promise(() => undefined));
    const view = use('k\nslow');
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(view.result.current.phase).toBe('slow');
    await act(async () => {
      vi.advanceTimersByTime(DRAW_TIME_LIMIT_MS);
    });
    expect(view.result.current.phase).toBe('timeout');
    expect(view.result.current.shown).toBeNull();
  });

  it('reports a failed draw and draws nothing while disabled', async () => {
    drawScene.mockRejectedValue(new Error('library'));
    const view = use('k\nbroken');
    await waitFor(() => expect(view.result.current.phase).toBe('failed'));

    drawScene.mockClear();
    use('k\nhidden', SCENE, false);
    expect(drawScene).not.toHaveBeenCalled();
  });
});
