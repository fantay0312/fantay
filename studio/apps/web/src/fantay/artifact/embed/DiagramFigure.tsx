// SPDX-License-Identifier: AGPL-3.0-only
// A Mermaid block drawn inside running text (a chat message, a note): the same drawing the diagram
// viewer makes (`viewers/diagram/render.ts`: pele, sanitised, laid out for the room it has), as a
// figure that is as wide as the text column at most and never enlarged. The block around it owns
// the words and the controls; this component only draws, and says how it went.
// A drawing is kept by its text, so a message that is drawn again (every streamed word, every
// scroll back into view) shows its diagram at once.
'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { layoutWidthFor } from '../viewers/diagram/render';
import theme from '../viewers/diagram/theme.module.css';
import { useDiagramDrawing } from '../viewers/diagram/use-diagram-drawing';
import styles from './embed.module.css';

/** A resize settles for this long before the diagram is laid out for the new width. */
const RELAYOUT_MS = 160;

export type DiagramFigureOutcome =
  /** pele's kind (`flowchart`, `sequence` …). */
  | { status: 'drawn'; type: string }
  /** The text does not draw; `line` is where the parser stopped, when it says. */
  | { status: 'failed'; line: number | null };

export interface DiagramFigureProps {
  source: string;
  /** Accessible name of the figure. */
  label: string;
  onOutcome?(outcome: DiagramFigureOutcome): void;
}

/** A short key for a text: FNV-1a over its characters, with its length. */
export function textKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

export default function DiagramFigure({ source, label, onOutcome }: DiagramFigureProps): JSX.Element {
  const figureRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** The room the layout is drawn for; null until the figure has been measured. */
  const [room, setRoom] = useState<number | null>(null);

  useLayoutEffect(() => {
    const figure = figureRef.current;
    if (!figure) return;
    const measure = (): number | null => {
      const box = getComputedStyle(figure);
      return layoutWidthFor(figure.clientWidth - Number.parseFloat(box.paddingLeft || '0') - Number.parseFloat(box.paddingRight || '0'));
    };
    setRoom(measure());
    if (typeof ResizeObserver === 'undefined') return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setRoom(measure()), RELAYOUT_MS);
    });
    observer.observe(figure);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const { drawing, failed } = useDiagramDrawing(`embed\n${textKey(source)}`, source, room !== null, room);
  const shown = drawing !== null && drawing.source === source ? drawing : null;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!shown) {
      host.replaceChildren();
      return;
    }
    const svg = shown.svg.cloneNode(true) as SVGSVGElement;
    // The figure carries the role and the name; the drawing is its picture.
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    host.replaceChildren(svg);
  }, [shown]);

  const outcome = useRef(onOutcome);
  outcome.current = onOutcome;
  const drawnType = shown?.type ?? null;
  const failedLine = failed && !shown ? (failed.problem.kind === 'syntax' || failed.problem.kind === 'semantic' ? failed.problem.line : null) : undefined;
  useEffect(() => {
    if (drawnType !== null) outcome.current?.({ status: 'drawn', type: drawnType });
    else if (failedLine !== undefined) outcome.current?.({ status: 'failed', line: failedLine });
  }, [drawnType, failedLine]);

  return (
    <div ref={figureRef} className={`${styles.figure} ${theme.theme ?? ''}`} role="img" aria-label={label} data-diagram-figure={shown ? 'drawn' : 'pending'}>
      <div ref={hostRef} className={styles.drawing} />
    </div>
  );
}
