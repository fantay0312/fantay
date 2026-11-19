// SPDX-License-Identifier: AGPL-3.0-only
// Mermaid blocks in a Markdown document whose preview is an HTML string (the document viewer in
// `components/FileViewer.tsx`). `drawDocumentDiagram` works on the parsed preview (an inert
// document): a ```mermaid block gets its drawing, made and sanitised by the diagram viewer's own
// code, next to its source, which stays in the block (hidden) for the copy button. A block that
// does not draw stays code, with one line saying why; when the block had a drawing a moment ago
// (the reader is editing it), that drawing stays and the line says it is the previous version, as
// in the diagram viewer. The preview loads this file only when a document has such a block.
// Formulas are in `math/document-math.ts`.
import { drawDiagram, layoutWidthFor, type DiagramDrawing } from '../viewers/diagram/render';
import theme from '../viewers/diagram/theme.module.css';
import styles from './embed.module.css';

/** True for the `<code>` of a ```mermaid block. */
export function isDiagramCode(code: Element): boolean {
  return /(?:^|\s)(?:language|lang)-mermaid(?:\s|$)/i.test(code.getAttribute('class') ?? '');
}

export interface DocumentDiagramOptions {
  /** The width of the column the figure sits in, in px; null for the layout as written. */
  availableWidth: number | null;
  /** The figure's accessible name and the block's label, from pele's kind. */
  kindLabel(type: string): string;
  /** The line under the bar when the block does not draw; `line` is where the parser stopped. */
  failedNote(line: number | null): string;
  /** The same, when the previous version's drawing is shown instead of the source. */
  staleNote(line: number | null): string;
}

/** On the block's wrapper: `drawn`, `stale` (the previous drawing stands in) or `failed`. */
export const DIAGRAM_BLOCK_ATTR = 'data-markdown-diagram';
const FIGURE_ATTR = 'data-markdown-figure';
/** The figure's own padding on both sides (`.figure` in the stylesheet). */
const FIGURE_PADDING = 32;

function figureOf(drawing: DiagramDrawing, label: string, owner: Document): HTMLElement {
  const figure = owner.createElement('div');
  figure.className = `${styles.figure ?? ''} ${styles.documentFigure ?? ''} ${theme.theme ?? ''}`;
  figure.setAttribute('role', 'img');
  figure.setAttribute('aria-label', label);
  figure.setAttribute(FIGURE_ATTR, drawing.type);
  const holder = owner.createElement('div');
  holder.className = styles.drawing ?? '';
  const svg = owner.importNode(drawing.svg, true);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  holder.append(svg);
  figure.append(holder);
  return figure;
}

/**
 * The figures a preview shows now, one entry per ```mermaid block in document order (null where
 * the block has none), so a block that stops drawing can keep the one it had.
 */
export function figuresByBlock(root: ParentNode, blockSelector: string): Array<Element | null> {
  const figures: Array<Element | null> = [];
  for (const block of Array.from(root.querySelectorAll(blockSelector))) {
    const code = block.querySelector('pre > code');
    if (code && isDiagramCode(code)) figures.push(block.querySelector(`[${FIGURE_ATTR}]`));
  }
  return figures;
}

function noteOf(text: string, owner: Document): HTMLElement {
  const note = owner.createElement('p');
  note.className = styles.documentNote ?? '';
  note.setAttribute('role', 'note');
  note.textContent = text;
  return note;
}

/**
 * Draws the diagram of one ```mermaid block into `block` (the wrapper the preview puts around a
 * `<pre>`). Returns true when the block was changed. `labelAttribute` is the attribute the preview
 * shows as the block's language; `previous` is the figure this block showed before this edit.
 */
export async function drawDocumentDiagram(
  block: HTMLElement,
  code: HTMLElement,
  labelAttribute: string,
  options: DocumentDiagramOptions,
  previous: Element | null = null,
): Promise<boolean> {
  const source = (code.textContent ?? '').replace(/\n$/, '');
  if (source.trim() === '') {
    // Nothing to draw: the (empty) block is shown as it is, not left as a frame waiting for a drawing.
    block.setAttribute(DIAGRAM_BLOCK_ATTR, 'failed');
    return true;
  }
  const maxWidth = options.availableWidth === null ? null : layoutWidthFor(options.availableWidth - FIGURE_PADDING);
  const outcome = await drawDiagram(source, { cancelled: false }, { maxWidth });
  if (outcome === null) return false;
  const owner = block.ownerDocument;
  const pre = code.closest('pre');
  if (outcome.ok) {
    const label = options.kindLabel(outcome.drawing.type);
    if (pre) pre.hidden = true;
    block.append(figureOf(outcome.drawing, label, owner));
    block.setAttribute(DIAGRAM_BLOCK_ATTR, 'drawn');
    block.setAttribute(labelAttribute, label);
    return true;
  }
  const problem = outcome.problem;
  const line = problem.kind === 'syntax' || problem.kind === 'semantic' ? problem.line : null;
  if (previous) {
    // The text being written does not draw yet: the drawing it had stays, and one line says so.
    if (pre) pre.hidden = true;
    block.append(noteOf(options.staleNote(line), owner), owner.importNode(previous, true));
    block.setAttribute(DIAGRAM_BLOCK_ATTR, 'stale');
    const label = previous.getAttribute('aria-label');
    if (label) block.setAttribute(labelAttribute, label);
    return true;
  }
  pre?.before(noteOf(options.failedNote(line), owner));
  block.setAttribute(DIAGRAM_BLOCK_ATTR, 'failed');
  return true;
}
