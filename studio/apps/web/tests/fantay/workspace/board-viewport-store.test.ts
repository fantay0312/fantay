// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getBoardViewport,
  publishBoardViewport,
  resetBoardViewportForTests,
  useBoardViewport,
} from '../../../src/fantay/workspace/board-viewport-store';

const SNAPSHOT = { projectId: 'p1', zoom: 0.5, minZoom: 0.05, maxZoom: 8 };

describe('board viewport store', () => {
  afterEach(() => {
    cleanup();
    resetBoardViewportForTests();
  });

  it('starts empty', () => {
    expect(getBoardViewport()).toBeNull();
    expect(renderHook(() => useBoardViewport('p1')).result.current).toBeNull();
  });

  it('delivers the published snapshot to hooks of the same project only', () => {
    const own = renderHook(() => useBoardViewport('p1'));
    const other = renderHook(() => useBoardViewport('p2'));

    act(() => publishBoardViewport(SNAPSHOT));
    expect(own.result.current).toEqual(SNAPSHOT);
    expect(other.result.current).toBeNull();
  });

  it('clears on null (inactive or unmounted board)', () => {
    const own = renderHook(() => useBoardViewport('p1'));
    act(() => publishBoardViewport(SNAPSHOT));
    act(() => publishBoardViewport(null));
    expect(own.result.current).toBeNull();
    expect(getBoardViewport()).toBeNull();
  });

  it('copies the snapshot and skips value-equal publishes', () => {
    const input = { ...SNAPSHOT };
    let renders = 0;
    const own = renderHook(() => {
      renders += 1;
      return useBoardViewport('p1');
    });
    act(() => publishBoardViewport(input));
    const first = own.result.current;
    input.zoom = 4;
    expect(getBoardViewport()?.zoom).toBe(0.5);

    const rendersBefore = renders;
    act(() => publishBoardViewport({ ...SNAPSHOT }));
    expect(own.result.current).toBe(first);
    expect(renders).toBe(rendersBefore);

    act(() => publishBoardViewport({ ...SNAPSHOT, zoom: 1 }));
    expect(own.result.current?.zoom).toBe(1);
  });

  it('server-renders without a snapshot (B2 getServerSnapshot)', () => {
    publishBoardViewport(SNAPSHOT);
    function Probe() {
      const viewport = useBoardViewport('p1');
      return createElement('span', null, viewport ? String(viewport.zoom) : 'none');
    }
    expect(renderToString(createElement(Probe))).toBe('<span>none</span>');
  });
});
