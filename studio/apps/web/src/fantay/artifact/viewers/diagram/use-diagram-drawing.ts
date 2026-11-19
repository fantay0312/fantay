// SPDX-License-Identifier: AGPL-3.0-only
// The drawing a viewer shows, and why the newest text did not draw. The rule that makes an agent's
// rewrite safe to watch: a version that cannot be drawn never replaces one that could. The last
// good drawing stays, and `failed` says (for the newest text only) what went wrong, so the viewer
// can say so in one line; a later version that draws clears it.
import { useEffect, useState } from 'react';

import type { DiagramProblem } from './problems';
import { drawDiagram, keepDrawing, keptDrawing, type DiagramDrawing } from './render';

export interface DiagramFailure {
  source: string;
  problem: DiagramProblem;
  /** The kind pele detected, when it got that far. */
  type: string | null;
}

export interface DiagramDrawingState {
  /** The last good drawing of this file; it may be of an older version than `source`. */
  drawing: DiagramDrawing | null;
  /** Why the current text did not draw; null while it draws or when it did. */
  failed: DiagramFailure | null;
  /** True while the current text is being drawn. */
  pending: boolean;
}

interface Held {
  key: string;
  drawing: DiagramDrawing | null;
  failed: DiagramFailure | null;
}

/**
 * `source` is the file's text, or null while it is not loaded; nothing is drawn while `active` is
 * false. `layoutWidth` is the room the drawing has (`layoutWidthFor`), or null for a free layout;
 * when it changes the same text is laid out again, and the drawing on screen stays until the new
 * one is ready.
 */
export function useDiagramDrawing(key: string, source: string | null, active: boolean, layoutWidth: number | null = null): DiagramDrawingState {
  const [held, setHeld] = useState<Held>(() => ({ key, drawing: keptDrawing(key), failed: null }));
  const current: Held = held.key === key ? held : { key, drawing: keptDrawing(key), failed: null };
  if (held.key !== key) setHeld(current);

  useEffect(() => {
    if (!active || source === null) return;
    const kept = keptDrawing(key);
    if (kept && kept.source === source && kept.layoutWidth === layoutWidth) {
      setHeld((previous) => (previous.key === key && previous.drawing === kept && previous.failed === null ? previous : { key, drawing: kept, failed: null }));
      return;
    }
    const job = { cancelled: false };
    void drawDiagram(source, job, { maxWidth: layoutWidth }).then((outcome) => {
      if (job.cancelled || outcome === null) return;
      if (outcome.ok) {
        keepDrawing(key, outcome.drawing);
        setHeld({ key, drawing: outcome.drawing, failed: null });
      } else {
        setHeld({ key, drawing: keptDrawing(key), failed: { source, problem: outcome.problem, type: outcome.type } });
      }
    });
    return () => {
      job.cancelled = true;
    };
  }, [key, source, active, layoutWidth]);

  const failed = current.failed !== null && current.failed.source === source ? current.failed : null;
  const pending = source !== null && failed === null && current.drawing?.source !== source;
  return { drawing: current.drawing, failed, pending };
}
