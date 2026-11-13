// SPDX-License-Identifier: AGPL-3.0-only
// Layout mode of the Fantay workspace from its own width (spec §4.1). A ResizeObserver watches the host; until
// it reports a width (jsdom, first paint) the layout is computed for 1280 px: full roster, docked inspector.
import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';

import type { PaLayout } from './pa-types';

export const PA_DEFAULT_WIDTH = 1280;
/** Roster column widths per mode (the sheet mode has no column). */
export const PA_ROSTER_WIDTH = { full: 260, rail: 64, sheet: 0 } as const;
/** Docked inspector: default, resize range, and the chat column it must leave. */
export const PA_INSPECTOR = { default: 340, min: 300, max: 420, chatMin: 420, floating: 340 } as const;

/** Breakpoints of spec §4.1: ≥980 docked (260 roster + ≥420 chat + ≥300 inspector); 900–979 floating; 720–899 rail; <720 sheet. */
export function layoutFor(width: number): PaLayout {
  if (width >= 980) return { width, roster: 'full', inspector: 'docked' };
  if (width >= 900) return { width, roster: 'full', inspector: 'floating' };
  if (width >= 720) return { width, roster: 'rail', inspector: 'floating' };
  return { width, roster: 'sheet', inspector: 'floating' };
}

/** The docked width actually used: the remembered preference clamped to 300–420 and to what leaves the chat
 *  column at least 520 px. */
export function dockedInspectorWidth(layout: PaLayout, preferred: number): number {
  const main = layout.width - PA_ROSTER_WIDTH[layout.roster];
  const max = Math.max(PA_INSPECTOR.min, Math.min(PA_INSPECTOR.max, main - PA_INSPECTOR.chatMin));
  return Math.round(Math.max(PA_INSPECTOR.min, Math.min(max, preferred)));
}

/** The floating inspector's width: 340, or `W − 24` on a narrow sheet layout. */
export function floatingInspectorWidth(layout: PaLayout): number {
  return Math.max(240, Math.min(PA_INSPECTOR.floating, layout.width - 24));
}

/** Watches `ref` and returns the layout mode for its width. A width of 0 (the view hidden with
 *  `display:none` while another tab is active) is ignored, so a hidden view keeps its last layout. */
export function usePaLayout(ref: RefObject<HTMLElement | null>): PaLayout {
  const [width, setWidth] = useState(PA_DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const apply = (next: number) => {
      if (next > 0) setWidth((current) => (Math.round(next) === current ? current : Math.round(next)));
    };
    apply(node.getBoundingClientRect().width);
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) apply(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  // One object per width, so consumers comparing layouts by identity re-render only when the width changes.
  return useMemo(() => layoutFor(width), [width]);
}
