// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from eta apps/web/src/components/workspace/pane.ts @ 793ded7c (MIT): a column a person drags
// to size, and the state of the line they drag: pointer capture, arrow keys that step the way the
// pointer would, and a width remembered when the drag lands. Added here: `reset` (double-click).
// The width lives in localStorage because it belongs to this screen, not to the person's work.
import { useCallback, useEffect, useRef, useState, type HTMLAttributes } from 'react';

export interface PaneWidth {
  width: number;
  dragging: boolean;
  /** Forgets the chosen width, so the pane returns to `fallback`. */
  reset(): void;
  /** Spread on the divider: pointer capture, moves, release, and arrow keys. */
  dividerProps: HTMLAttributes<HTMLDivElement> & {
    role: 'separator';
    tabIndex: 0;
    'aria-orientation': 'vertical';
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    'data-dragging': boolean;
  };
}

export function usePaneWidth(options: {
  storageKey: string;
  min: number;
  max: number;
  fallback: number;
  /** Which edge the divider is on. Dragging left grows a right-hand pane. */
  edge?: 'left' | 'right';
}): PaneWidth {
  const { storageKey, min, max, fallback } = options;
  const grow = options.edge === 'right' ? -1 : 1;
  const clamp = useCallback((value: number) => Math.min(max, Math.max(min, Math.round(value))), [min, max]);
  const read = useCallback(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored > 0 ? clamp(stored) : undefined;
    } catch {
      return undefined;
    }
  }, [storageKey, clamp]);

  const [chosen, setChosen] = useState(read);
  const width = chosen ?? fallback;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | undefined>(undefined);

  useEffect(() => {
    // A release outside the divider (capture lost, pointer cancelled) must still end the drag.
    const stop = () => {
      if (dragRef.current === undefined) return;
      dragRef.current = undefined;
      setDragging(false);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  // Saved when the drag ends, not on every pixel: the value that matters is where it landed.
  const remember = useCallback(
    (next: number) => {
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* storage is off limits (private mode) */
      }
    },
    [storageKey],
  );

  const reset = useCallback(() => {
    setChosen(undefined);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* storage is off limits (private mode) */
    }
  }, [storageKey]);

  return {
    width,
    dragging,
    reset,
    dividerProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
      'data-dragging': dragging,
      tabIndex: 0,
      // The keyboard's way to drag: arrows step 16px the way the pointer would move, Home and End
      // go to the ends. Each press lands, so each press is remembered.
      onKeyDown: (event) => {
        const step = 16;
        const next =
          event.key === 'ArrowLeft'
            ? clamp(width - grow * step)
            : event.key === 'ArrowRight'
              ? clamp(width + grow * step)
              : event.key === 'Home'
                ? min
                : event.key === 'End'
                  ? max
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        setChosen(next);
        remember(next);
      },
      onPointerDown: (event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = { startX: event.clientX, startWidth: width };
        setDragging(true);
      },
      onPointerMove: (event) => {
        const current = dragRef.current;
        if (current === undefined) return;
        setChosen(clamp(current.startWidth + grow * (event.clientX - current.startX)));
      },
      onPointerUp: (event) => {
        if (dragRef.current === undefined) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        dragRef.current = undefined;
        setDragging(false);
        // A press that never moved chose nothing, so it does not pin the default.
        if (chosen !== undefined) remember(chosen);
      },
      onDoubleClick: reset,
    },
  };
}
