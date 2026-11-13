// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceContextItem } from '@open-design/contracts';

import {
  getEditorContext,
  resetEditorContextsForTests,
  setEditorContext,
  useEditorContext,
} from '../../../src/fantay/editors/editor-context-store';

const FRAME: WorkspaceContextItem = {
  id: 'design:home.fig#frame-1',
  kind: 'file',
  label: 'Frame 1',
  path: 'designs/home.fig',
  title: 'Frame 1 in designs/home.fig',
};

describe('editor context store', () => {
  afterEach(() => {
    cleanup();
    resetEditorContextsForTests();
  });

  it('records and clears the context of one editor file', () => {
    setEditorContext('p1', 'designs/home.fig', FRAME);
    expect(getEditorContext('p1', 'designs/home.fig')).toBe(FRAME);

    setEditorContext('p1', 'designs/home.fig', null);
    expect(getEditorContext('p1', 'designs/home.fig')).toBeNull();
  });

  it('keeps projects and files apart', () => {
    setEditorContext('p1', 'designs/home.fig', FRAME);
    expect(getEditorContext('p2', 'designs/home.fig')).toBeNull();
    expect(getEditorContext('p1', 'designs/other.fig')).toBeNull();
    expect(getEditorContext('p1', null)).toBeNull();
    expect(getEditorContext('p1', undefined)).toBeNull();
    expect(getEditorContext('p1', '')).toBeNull();
  });

  it('updates subscribed hooks for the matching file only', () => {
    const active = renderHook(() => useEditorContext('p1', 'designs/home.fig'));
    const other = renderHook(() => useEditorContext('p1', 'index.html'));

    act(() => setEditorContext('p1', 'designs/home.fig', FRAME));
    expect(active.result.current).toBe(FRAME);
    expect(other.result.current).toBeNull();

    act(() => setEditorContext('p1', 'designs/home.fig', null));
    expect(active.result.current).toBeNull();
  });

  it('follows the file name passed to the hook (the active tab)', () => {
    setEditorContext('p1', 'designs/home.fig', FRAME);
    const hook = renderHook(({ fileName }: { fileName: string | null }) => useEditorContext('p1', fileName), {
      initialProps: { fileName: null as string | null },
    });
    expect(hook.result.current).toBeNull();
    hook.rerender({ fileName: 'designs/home.fig' });
    expect(hook.result.current).toBe(FRAME);
  });

  it('does not notify for an equal item', () => {
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useEditorContext('p1', 'designs/home.fig');
    });
    act(() => setEditorContext('p1', 'designs/home.fig', FRAME));
    const rendersAfterSet = renders;

    act(() => setEditorContext('p1', 'designs/home.fig', { ...FRAME }));
    expect(renders).toBe(rendersAfterSet);
    expect(hook.result.current).toBe(FRAME);

    act(() => setEditorContext('p1', 'designs/home.fig', { ...FRAME, label: 'Frame 2' }));
    expect(hook.result.current?.label).toBe('Frame 2');
  });

  it('forgets everything on reset', () => {
    const hook = renderHook(() => useEditorContext('p1', 'designs/home.fig'));
    act(() => setEditorContext('p1', 'designs/home.fig', FRAME));
    act(() => resetEditorContextsForTests());
    expect(hook.result.current).toBeNull();
  });

  it('server-renders without context (B2 getServerSnapshot)', () => {
    setEditorContext('p1', 'designs/home.fig', FRAME);
    function Probe() {
      return createElement('span', null, useEditorContext('p1', 'designs/home.fig')?.label ?? 'none');
    }
    expect(renderToString(createElement(Probe))).toBe('<span>none</span>');
  });
});
