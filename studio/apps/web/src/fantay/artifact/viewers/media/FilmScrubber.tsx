// SPDX-License-Identifier: AGPL-3.0-only
// The film's scrubber: a thin rail over the picture showing how much has loaded and how much has
// played. It thickens under the pointer, the film follows a drag frame by frame, and the time under
// the pointer is named above it. The fill is moved through two custom properties, set every frame
// while the film plays, so the rail is smooth without re-rendering the player.
'use client';

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import styles from './FilmScrubber.module.css';
import { formatMediaTime } from './media-time';
import { useScrub } from './use-scrub';

export interface FilmScrubberProps {
  /** Seconds; 0 while unknown. */
  duration: number;
  time: number;
  playing: boolean;
  /** Changes whenever more of the file has loaded. */
  loadedTick: number;
  liveTime(): number;
  liveLoaded(): number;
  onSeek(time: number): void;
  onSeekBy(seconds: number): void;
  onDragChange(dragging: boolean): void;
  label: string;
}

export function FilmScrubber(props: FilmScrubberProps): JSX.Element {
  const { duration, time, playing, loadedTick, onSeek, onSeekBy, onDragChange, label } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrub = useScrub<HTMLDivElement>({ duration, live: true, onSeek, onSeekBy, onDragChange });

  const inputRef = useRef({ ...props, drag: scrub.drag });
  inputRef.current = { ...props, drag: scrub.drag };

  const place = useCallback((): void => {
    const root = rootRef.current;
    const input = inputRef.current;
    if (!root) return;
    const length = input.duration;
    const played = length > 0 ? (input.drag ?? Math.min(1, (input.playing ? input.liveTime() : input.time) / length)) : 0;
    const loaded = length > 0 ? Math.min(1, input.liveLoaded() / length) : 0;
    root.style.setProperty('--played', played.toFixed(4));
    root.style.setProperty('--loaded', Math.max(played, loaded).toFixed(4));
  }, []);

  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function step() {
      place();
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, place]);

  useLayoutEffect(place, [place, duration, time, loadedTick, scrub.drag, playing]);

  const shown = scrub.drag ?? scrub.hover;
  const ready = duration > 0;

  return (
    <div
      ref={rootRef}
      className={styles.scrubber}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(Math.min(time, duration))}
      aria-valuetext={`${formatMediaTime(time, duration)} / ${formatMediaTime(duration)}`}
      aria-disabled={!ready || undefined}
      data-ready={ready || undefined}
      data-dragging={scrub.drag !== null || undefined}
      data-media-scrubber=""
      {...scrub.handlers}
    >
      <div className={styles.rail}>
        <div className={styles.loaded} />
        <div className={styles.played} />
      </div>
      <div className={styles.thumb} />
      <span
        className={styles.hint}
        data-visible={(ready && shown !== null) || undefined}
        style={{ left: `clamp(20px, ${((shown ?? 0) * 100).toFixed(2)}%, calc(100% - 20px))` }}
        aria-hidden="true"
      >
        {formatMediaTime((shown ?? 0) * duration, duration)}
      </span>
    </div>
  );
}
