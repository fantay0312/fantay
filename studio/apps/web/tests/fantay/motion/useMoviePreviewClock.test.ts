// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMoviePreviewClock, type MoviePreviewClockOptions } from '../../../src/fantay/motion/useMoviePreviewClock';

/** A manual animation-frame scheduler with a controllable clock (ms). */
function fakeFrames() {
  let now = 0;
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  return {
    now: () => now,
    requestFrame: (cb: FrameRequestCallback) => {
      const id = next++;
      queue.set(id, cb);
      return id;
    },
    cancelFrame: (id: number) => {
      queue.delete(id);
    },
    pending: () => queue.size,
    /** Advances time by `ms` and runs the frames that were queued before. */
    step(ms: number) {
      now += ms;
      const due = [...queue.entries()];
      queue.clear();
      for (const [, cb] of due) cb(now);
    },
  };
}

function setup(options: Partial<MoviePreviewClockOptions> & { duration: number; loop: boolean }) {
  const frames = fakeFrames();
  const onPlay = vi.fn();
  const onPause = vi.fn();
  const onSeek = vi.fn();
  const hook = renderHook((props: Partial<MoviePreviewClockOptions>) =>
    useMoviePreviewClock({
      onPlay,
      onPause,
      onSeek,
      now: frames.now,
      requestFrame: frames.requestFrame,
      cancelFrame: frames.cancelFrame,
      ...options,
      ...props,
    }),
  );
  return { hook, frames, onPlay, onPause, onSeek };
}

afterEach(cleanup);

describe('useMoviePreviewClock', () => {
  it('advances with elapsed time while playing', () => {
    const { hook, frames, onPlay } = setup({ duration: 10, loop: false, initialTime: 1 });
    expect(hook.result.current.time).toBe(1);
    act(() => hook.result.current.play());
    expect(hook.result.current.playing).toBe(true);
    expect(onPlay).toHaveBeenCalledWith(1);
    act(() => frames.step(500));
    expect(hook.result.current.time).toBeCloseTo(1.5);
    act(() => frames.step(1000));
    expect(hook.result.current.time).toBeCloseTo(2.5);
  });

  it('wraps around the duration while looping, without callbacks', () => {
    const { hook, frames, onPause, onSeek } = setup({ duration: 4, loop: true });
    act(() => hook.result.current.play());
    act(() => frames.step(3000));
    act(() => frames.step(2500));
    expect(hook.result.current.time).toBeCloseTo(1.5);
    expect(hook.result.current.playing).toBe(true);
    expect(onPause).not.toHaveBeenCalled();
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('stops at the end without looping and restarts from 0 on the next play', () => {
    const { hook, frames, onPlay, onPause } = setup({ duration: 2, loop: false });
    act(() => hook.result.current.play());
    act(() => frames.step(1500));
    act(() => frames.step(1500));
    expect(hook.result.current.time).toBe(2);
    expect(hook.result.current.playing).toBe(false);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenLastCalledWith(2);
    expect(frames.pending()).toBe(0);
    act(() => hook.result.current.play());
    expect(onPlay).toHaveBeenLastCalledWith(0);
    expect(hook.result.current.time).toBe(0);
  });

  it('clamps seeks and pauses playback first', () => {
    const { hook, frames, onPause, onSeek } = setup({ duration: 5, loop: false });
    act(() => hook.result.current.play());
    act(() => frames.step(1000));
    act(() => hook.result.current.seek(9));
    expect(hook.result.current.playing).toBe(false);
    expect(hook.result.current.time).toBe(5);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(5);
    act(() => hook.result.current.seek(-2));
    expect(hook.result.current.time).toBe(0);
    expect(onSeek).toHaveBeenLastCalledWith(0);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(frames.pending()).toBe(0);
  });

  it('fires each callback once per transition', () => {
    const { hook, frames, onPlay, onPause } = setup({ duration: 6, loop: false });
    act(() => {
      hook.result.current.play();
      hook.result.current.play();
    });
    expect(onPlay).toHaveBeenCalledTimes(1);
    act(() => frames.step(1000));
    act(() => {
      hook.result.current.pause();
      hook.result.current.pause();
    });
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledWith(1);
    act(() => hook.result.current.toggle());
    expect(onPlay).toHaveBeenCalledTimes(2);
    expect(onPlay).toHaveBeenLastCalledWith(1);
  });

  it('does not play an empty film', () => {
    const { hook, onPlay } = setup({ duration: 0, loop: false });
    act(() => hook.result.current.play());
    expect(hook.result.current.playing).toBe(false);
    expect(onPlay).not.toHaveBeenCalled();
  });
});
