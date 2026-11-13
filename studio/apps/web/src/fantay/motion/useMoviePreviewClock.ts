// SPDX-License-Identifier: AGPL-3.0-only
// rAF clock for film preview playback (spec 07 §3.3). Owns `time` / `playing` and is decoupled
// from the iframe: callers forward the transitions to `MoviePreviewFrame` (`onPlay` → seek + play,
// `onPause` → pause + seek, `onSeek` → seek). While playing, time = start + elapsed; at the end a
// looping clock wraps silently (GSAP `repeat(-1)` wraps the frame itself), otherwise it stops at
// `duration` and the next `play()` restarts from 0. Each callback fires once per transition.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface MoviePreviewClock {
  time: number;
  playing: boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(time: number): void;
}

export interface MoviePreviewClockOptions {
  duration: number;
  loop: boolean;
  initialTime?: number;
  onPlay?: (time: number) => void;
  onPause?: (time: number) => void;
  onSeek?: (time: number) => void;
  /** Test seams. */
  now?: () => number;
  requestFrame?: (cb: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}

function clamp(value: number, duration: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.max(0, duration), value));
}

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const defaultRequestFrame = (cb: FrameRequestCallback) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : (setTimeout(() => cb(defaultNow()), 16) as unknown as number);
const defaultCancelFrame = (id: number) => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id);
};

export function useMoviePreviewClock(options: MoviePreviewClockOptions): MoviePreviewClock {
  const { duration, loop, initialTime = 0 } = options;
  const [time, setTime] = useState(() => clamp(initialTime, duration));
  const [playing, setPlaying] = useState(false);

  const latest = useRef(options);
  latest.current = options;
  const live = useRef({ time: clamp(initialTime, duration), playing: false, startTime: 0, t0: 0, frame: null as number | null });

  const now = () => (latest.current.now ?? defaultNow)();

  const stopFrames = useCallback(() => {
    const frame = live.current.frame;
    if (frame !== null) (latest.current.cancelFrame ?? defaultCancelFrame)(frame);
    live.current.frame = null;
  }, []);

  const commit = useCallback((next: number) => {
    live.current.time = next;
    setTime(next);
  }, []);

  const tick = useCallback(() => {
    const state = live.current;
    if (!state.playing) return;
    const { duration: length, loop: looping } = latest.current;
    let next = state.startTime + (now() - state.t0) / 1000;
    if (length > 0 && next >= length) {
      if (looping) {
        next %= length;
      } else {
        state.playing = false;
        state.frame = null;
        commit(length);
        setPlaying(false);
        latest.current.onPause?.(length);
        return;
      }
    }
    commit(next);
    state.frame = (latest.current.requestFrame ?? defaultRequestFrame)(tick);
    // `now` is read through the latest options; tick itself is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit]);

  const play = useCallback(() => {
    const state = live.current;
    const length = latest.current.duration;
    if (state.playing || !(length > 0)) return;
    const start = state.time >= length ? 0 : state.time;
    state.playing = true;
    state.startTime = start;
    state.t0 = now();
    commit(start);
    setPlaying(true);
    latest.current.onPlay?.(start);
    stopFrames();
    state.frame = (latest.current.requestFrame ?? defaultRequestFrame)(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit, stopFrames, tick]);

  const pause = useCallback(() => {
    const state = live.current;
    if (!state.playing) return;
    const length = latest.current.duration;
    let current = state.startTime + (now() - state.t0) / 1000;
    current = length > 0 ? (latest.current.loop ? current % length : Math.min(current, length)) : 0;
    state.playing = false;
    stopFrames();
    commit(current);
    setPlaying(false);
    latest.current.onPause?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commit, stopFrames]);

  const seek = useCallback(
    (target: number) => {
      const state = live.current;
      const next = clamp(target, latest.current.duration);
      if (state.playing) {
        state.playing = false;
        stopFrames();
        setPlaying(false);
        latest.current.onPause?.(next);
      }
      commit(next);
      latest.current.onSeek?.(next);
    },
    [commit, stopFrames],
  );

  const toggle = useCallback(() => {
    if (live.current.playing) pause();
    else play();
  }, [pause, play]);

  // A shorter film keeps the clock inside it.
  useEffect(() => {
    if (live.current.time > Math.max(0, duration)) commit(clamp(live.current.time, duration));
  }, [duration, commit]);

  useEffect(() => stopFrames, [stopFrames]);

  return useMemo(() => ({ time, playing, play, pause, toggle, seek }), [time, playing, play, pause, toggle, seek]);
}
