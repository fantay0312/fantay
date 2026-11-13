// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeMotionCreate,
  getMotionCreateRequest,
  openMotionCreate,
  resetMotionCreateForTests,
  useMotionCreateRequest,
  type MotionCreateRequest,
} from '../../../src/fantay/motion/motion-create-store';

describe('motion create store', () => {
  afterEach(() => {
    cleanup();
    resetMotionCreateForTests();
  });

  it('starts without a request', () => {
    expect(getMotionCreateRequest()).toBeNull();
    expect(renderHook(() => useMotionCreateRequest()).result.current).toBeNull();
  });

  it('opens and closes the request for subscribed hooks', () => {
    const hook = renderHook(() => useMotionCreateRequest());
    const request: MotionCreateRequest = {
      target: { kind: 'new-project' },
      brief: '30 秒产品片',
      designSystemId: null,
      source: 'home-chip',
    };

    act(() => openMotionCreate(request));
    expect(hook.result.current).toEqual(request);

    act(() => closeMotionCreate());
    expect(hook.result.current).toBeNull();
  });

  it('replaces an open request with the latest one, as a new object', () => {
    const request: MotionCreateRequest = { target: { kind: 'new-project' }, source: 'home-chip' };
    openMotionCreate(request);
    const first = getMotionCreateRequest();
    expect(first).not.toBe(request);

    openMotionCreate(request);
    expect(getMotionCreateRequest()).not.toBe(first);
    expect(getMotionCreateRequest()).toEqual(request);

    openMotionCreate({ target: { kind: 'existing-project', projectId: 'p1' }, kind: 'code', source: 'board-insert' });
    expect(getMotionCreateRequest()?.target).toEqual({ kind: 'existing-project', projectId: 'p1' });
  });

  it('copies C5 footage paths so later caller mutations do not leak in', () => {
    const footagePaths = ['clips/a.mp4'];
    openMotionCreate({
      target: { kind: 'existing-project', projectId: 'p1' },
      kind: 'footage',
      footagePaths,
      source: 'board-insert',
    });
    footagePaths.push('clips/b.mp4');
    expect(getMotionCreateRequest()?.footagePaths).toEqual(['clips/a.mp4']);
  });

  it('server-renders without a request (B2 getServerSnapshot)', () => {
    openMotionCreate({ target: { kind: 'new-project' }, source: 'home-command' });
    function Probe() {
      return createElement('span', null, useMotionCreateRequest()?.source ?? 'none');
    }
    expect(renderToString(createElement(Probe))).toBe('<span>none</span>');
  });
});
