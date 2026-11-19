// SPDX-License-Identifier: AGPL-3.0-only
// Seeking by hand, shared by the audio waveform and the film's scrubber: press anywhere on the track
// to go there, drag to look for a place, and the usual slider keys. The track is the element the
// handlers are put on; positions are fractions of its width (0 at the left edge, 1 at the right).
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { SEEK_STEP_SECONDS, fractionAt } from './media-time';

export interface ScrubOptions {
  /** Seconds; 0 while unknown, and then the track does nothing. */
  duration: number;
  /**
   * True: the file follows the pointer while it drags (a film, where every position shows a frame).
   * False: the file moves once, on release (sound, where a drag would stutter).
   */
  live: boolean;
  onSeek(time: number): void;
  onSeekBy(seconds: number): void;
  onDragChange?(dragging: boolean): void;
}

export interface ScrubHandlers<E extends HTMLElement> {
  onPointerDown(event: PointerEvent<E>): void;
  onPointerMove(event: PointerEvent<E>): void;
  onPointerUp(event: PointerEvent<E>): void;
  onPointerCancel(event: PointerEvent<E>): void;
  onPointerLeave(event: PointerEvent<E>): void;
  onKeyDown(event: KeyboardEvent<E>): void;
}

export interface Scrub<E extends HTMLElement> {
  /** Where the pointer is along the track while it is over it; null otherwise. */
  hover: number | null;
  /** Where the drag is; null when nothing is being dragged. */
  drag: number | null;
  handlers: ScrubHandlers<E>;
}

export function useScrub<E extends HTMLElement>(options: ScrubOptions): Scrub<E> {
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const pointerRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const position = useCallback((event: PointerEvent<E>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return fractionAt(event.clientX, rect.left, rect.width);
  }, []);

  const handlers = useMemo<ScrubHandlers<E>>(
    () => ({
      onPointerDown: (event) => {
        const { duration, live, onSeek, onDragChange } = optionsRef.current;
        if (event.button !== 0 || !(duration > 0)) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        pointerRef.current = event.pointerId;
        const at = position(event);
        setDrag(at);
        setHover(at);
        onDragChange?.(true);
        if (live) onSeek(at * duration);
      },
      onPointerMove: (event) => {
        const { duration, live, onSeek } = optionsRef.current;
        if (!(duration > 0)) return;
        const at = position(event);
        setHover(at);
        if (pointerRef.current !== event.pointerId) return;
        setDrag(at);
        if (live) onSeek(at * duration);
      },
      onPointerUp: (event) => {
        if (pointerRef.current !== event.pointerId) return;
        const { duration, onSeek, onDragChange } = optionsRef.current;
        pointerRef.current = null;
        setDrag(null);
        // A finger leaves no pointer behind to hover with.
        if (event.pointerType !== 'mouse') setHover(null);
        onSeek(position(event) * duration);
        onDragChange?.(false);
      },
      onPointerCancel: (event) => {
        if (pointerRef.current !== event.pointerId) return;
        pointerRef.current = null;
        setDrag(null);
        setHover(null);
        optionsRef.current.onDragChange?.(false);
      },
      onPointerLeave: () => {
        if (pointerRef.current === null) setHover(null);
      },
      onKeyDown: (event) => {
        const { duration, onSeek, onSeekBy } = optionsRef.current;
        if (!(duration > 0) || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === 'ArrowRight') onSeekBy(SEEK_STEP_SECONDS);
        else if (event.key === 'ArrowLeft') onSeekBy(-SEEK_STEP_SECONDS);
        else if (event.key === 'PageUp') onSeekBy(duration / 10);
        else if (event.key === 'PageDown') onSeekBy(-duration / 10);
        else if (event.key === 'Home') onSeek(0);
        else if (event.key === 'End') onSeek(duration);
        else return;
        // Handled here: the player around the track must not seek a second time.
        event.preventDefault();
        event.stopPropagation();
      },
    }),
    [position],
  );

  return { hover, drag, handlers };
}
