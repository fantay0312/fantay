'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '../../hooks/usePresence';
import type { CaretRect } from './LexicalComposerInput';

const GAP = 8; // gap between caret and popover edge
const MARGIN = 8; // viewport edge margin
const HARD_MAX_H = 460; // never taller than this
const MIN_W = 320;
// 460, not 420: the @ popover's seven category tabs need ~446px in English; at 420 the last one was
// cut. A narrower composer still clamps it, and the tab strip then fades its edge (mention-home.css).
const PREF_W = 460;

interface PopoverPos {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'above' | 'below';
}

// Default ABOVE the caret (composer sits at panel bottom → above never
// occludes the input line); flip BELOW only when above lacks room. Clamp
// horizontally into the viewport. Cap height; the list scrolls internally.
function computePopoverPos(
  caret: CaretRect,
  size: { width: number; height: number } | null,
  boundary: DOMRect | null,
): PopoverPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const viewportAvailableWidth = vw - MARGIN * 2;
  const boundaryAvailableWidth = boundary
    ? boundary.width - MARGIN * 2
    : viewportAvailableWidth;
  const availableWidth = Math.max(
    240,
    Math.min(viewportAvailableWidth, boundaryAvailableWidth),
  );
  const width = Math.min(PREF_W, availableWidth);

  const spaceAbove = caret.top - GAP - MARGIN;
  const spaceBelow = vh - caret.bottom - GAP - MARGIN;

  const wantedH = size?.height ?? HARD_MAX_H;
  const aboveFits = spaceAbove >= Math.min(wantedH, 160);
  const placement: 'above' | 'below' =
    aboveFits || spaceAbove >= spaceBelow ? 'above' : 'below';

  const space = placement === 'above' ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(120, Math.min(HARD_MAX_H, space));

  let top: number;
  if (placement === 'above') {
    const h = Math.min(wantedH, maxHeight);
    top = caret.top - GAP - h;
    if (top < MARGIN) top = MARGIN;
  } else {
    top = caret.bottom + GAP;
  }

  const minLeft = boundary ? Math.max(MARGIN, boundary.left + MARGIN) : MARGIN;
  const maxLeft = boundary
    ? Math.max(minLeft, Math.min(vw - MARGIN - width, boundary.right - MARGIN - width))
    : vw - MARGIN - width;
  let left = caret.left;
  if (left > maxLeft) left = maxLeft;
  if (left < minLeft) left = minLeft;

  return { left, top, width, maxHeight, placement };
}

export function CaretFloatingLayer({
  caret,
  open,
  boundaryRef,
  children,
}: {
  caret: CaretRect | null;
  open: boolean;
  boundaryRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  /*
   * Fantay 2026-11-08: fade out on close instead of vanishing, like every other composer menu.
   * While it fades, the layer shows the LAST frame it had open (children frozen, position kept):
   * the parent keeps rendering the list after closing, but with the query cleared it would
   * flash the unfiltered list (or the post-pick state) during the exit. The fading layer is inert.
   */
  const presence = usePresence(open && Boolean(caret), 150);
  const frozenChildren = useRef<ReactNode>(children);
  if (open && caret) frozenChildren.current = children;

  const reposition = useCallback(() => {
    if (!caret) return;
    const el = layerRef.current;
    const size = el ? { width: el.offsetWidth, height: el.scrollHeight } : null;
    const boundary = boundaryRef?.current?.getBoundingClientRect() ?? null;
    setPos(computePopoverPos(caret, size, boundary));
  }, [boundaryRef, caret]);

  // Measured pass on open + every caret change. useLayoutEffect avoids a
  // wrong-coordinate flash before paint.
  useLayoutEffect(() => {
    if (open && caret) reposition();
  }, [open, caret, reposition]);

  // Keep pinned while open. rAF-throttle scroll/resize. Reposition (not close)
  // so a small chat-log scroll doesn't feel broken; capture:true catches
  // ancestor scroll.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const onMove = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        reposition();
      });
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, reposition]);

  if (!presence.mounted || typeof document === 'undefined') return null;
  if (presence.closing && !pos) return null;

  return createPortal(
    <div
      ref={layerRef}
      className="caret-floating-layer"
      data-state={presence.closing ? 'closed' : 'open'}
      aria-hidden={presence.closing ? true : undefined}
      data-placement={pos?.placement ?? 'above'}
      style={
        pos
          ? {
              position: 'fixed',
              left: `${pos.left}px`,
              top: `${pos.top}px`,
              width: `${pos.width}px`,
              ['--cfl-max-h' as string]: `${pos.maxHeight}px`,
            }
          : {
              // Pre-measure off-screen so sizing causes no flash.
              position: 'fixed',
              left: '-9999px',
              top: '0px',
              width: `${PREF_W}px`,
              visibility: 'hidden',
            }
      }
    >
      {presence.closing ? frozenChildren.current : children}
    </div>,
    document.body,
  );
}
