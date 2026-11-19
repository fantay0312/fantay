// SPDX-License-Identifier: AGPL-3.0-only
// Drawing a Mermaid file with pele: precheck, load the code for the detected kind only, wait for
// the interface font, render in an idle slot, sanitise. pele is synchronous and fast (a 300-node
// flowchart lays out in a few milliseconds), but it measures every label with the page's fonts, so
// it runs here on the main thread, where Inter and the CJK system fonts are the ones the reader
// sees; an idle slot keeps it off the frame that opens the tab. Its own limits bound the work:
// source length, edge count and output length.
// What is drawn is kept per file outside React, so a tab switch or an agent's rewrite (both
// unmount the viewer) shows the last good drawing at once, and a version that does not parse
// never replaces it.
import type { MathResolver, RenderOptions } from 'pele/lazy';

import { loadMathEngine, mathEngineReady } from '../../math/engine';
import { createLabelMath, type LabelMath } from './label-math';
import { describeDiagramError, precheckDiagram, type DiagramProblem } from './problems';
import { sanitizeDiagramSvg } from './sanitize-svg';

/** Characters of source pele will draw: its own default, the limit its security guide sets. */
export const MAX_DRAW_CHARS = 50_000;

export interface DiagramDrawing {
  /** The source this was drawn from. */
  source: string;
  /** The sanitised drawing, detached. Insert a clone, never this element. */
  svg: SVGSVGElement;
  width: number;
  height: number;
  /** pele's kind (`flowchart`, `sequence` …). */
  type: string;
  /** Addresses of the links in the drawing (inert; copied on click). */
  links: string[];
  /** True when a label holds a typeset formula (the drawing then carries HTML inside the SVG). */
  math: boolean;
  /** The width the layout was asked to keep to (see `DrawLayout`), or null when it was free. */
  layoutWidth: number | null;
}

export interface DrawLayout {
  /**
   * The room the drawing has, in px. A drawing that would be wider is laid out again to keep to it
   * where its kind can: a C4 diagram wraps its rows, a sequence diagram narrows its lanes, and in a
   * narrow room (under 640) a left-to-right flowchart turns top to bottom and a journey or a
   * timeline stacks. A reader then gets words at their real size in a narrow panel instead of a
   * wide picture shrunk to a third. A kind that cannot be narrower stays as it is (the stage then
   * zooms out). Leave it out for the layout exactly as written, which is what an export uses.
   */
  maxWidth?: number | null;
}

/** The narrowest and widest rooms a layout is asked to keep to. */
const MIN_LAYOUT_WIDTH = 280;
const MAX_LAYOUT_WIDTH = 2400;

/** The layout width for a stage `available` px wide, in steps, so a resize does not redraw on every pixel. */
export function layoutWidthFor(available: number): number | null {
  if (!(available > 0)) return null;
  return Math.min(MAX_LAYOUT_WIDTH, Math.max(MIN_LAYOUT_WIDTH, Math.floor(available / 40) * 40));
}

/** User Timing entry covering render + sanitise, for profiling (`performance.getEntriesByName`). */
export const DRAW_MEASURE = 'fantay:diagram-draw';

export type DrawOutcome =
  | { ok: true; drawing: DiagramDrawing }
  | { ok: false; problem: DiagramProblem; type: string | null };

export interface DiagramFonts {
  ui: string;
  mono: string;
}

type Pele = typeof import('pele/lazy');
let peleModule: Promise<Pele> | null = null;

function loadPele(): Promise<Pele> {
  peleModule ??= import('pele/lazy').catch((error: unknown) => {
    peleModule = null;
    throw error;
  });
  return peleModule;
}

/** Resolves in the next idle period (or after a frame where there is no idle callback). */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(() => resolve(), { timeout: 160 });
    else window.setTimeout(resolve, 16);
  });
}

/** The interface fonts as resolved stacks, so pele measures with exactly what the page draws. */
export function interfaceFonts(): DiagramFonts {
  const style = getComputedStyle(document.documentElement);
  return {
    ui: style.getPropertyValue('--font-ui').trim() || 'system-ui, sans-serif',
    mono: style.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace',
  };
}

/** pele draws sub- and superscript at size / 1.2 (its `bm`). */
const SCRIPT_SCALE = 1.2;
/** The weight `--pele-bold-weight` gives bold text in this viewer's theme. */
const BOLD_WEIGHT = 600;
const STYLE_BOLD = 1;
const STYLE_ITALIC = 2;
const STYLE_MONO = 4;
const STYLE_SCRIPT = 8 | 16;

type TextMeasurer = NonNullable<RenderOptions['measurer']>;

/**
 * Label widths from a canvas, cached for one drawing. pele's own canvas measurer asks
 * `document.fonts.check()` before caching each width, and in Chromium that call costs about
 * 0.7 ms (measured: 2 s for 3,000 calls, against 1–2 µs for `measureText`); a 300-node flowchart
 * spent 120 ms there. The fonts the drawing needs are loaded before it is measured (see
 * `loadFonts`), so the check is not needed here. Bold is measured at the weight the theme draws.
 */
export function canvasMeasurer(fonts: DiagramFonts): TextMeasurer | undefined {
  const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!context) return undefined;
  const widths = new Map<string, number>();
  let current = '';
  return {
    width(text, size, style) {
      const px = style & STYLE_SCRIPT ? size / SCRIPT_SCALE : size;
      const font = `${style & STYLE_ITALIC ? 'italic ' : ''}${style & STYLE_BOLD ? `${BOLD_WEIGHT} ` : ''}${px}px ${style & STYLE_MONO ? fonts.mono : fonts.ui}`;
      const key = `${font}\n${text}`;
      let width = widths.get(key);
      if (width === undefined) {
        if (font !== current) {
          context.font = font;
          current = font;
        }
        width = context.measureText(text).width;
        widths.set(key, width);
      }
      return width;
    },
  };
}

/** Loads the faces (and unicode-range subsets) the drawing's characters need, regular and bold. */
async function loadFonts(source: string, fonts: DiagramFonts): Promise<void> {
  const set = typeof document === 'undefined' ? undefined : document.fonts;
  if (!set) return;
  const characters = Array.from(new Set(Array.from(source.replace(/\s+/g, '')))).slice(0, 4000).join('');
  try {
    await Promise.all([
      set.load(`14px ${fonts.ui}`, characters),
      set.load(`${BOLD_WEIGHT} 14px ${fonts.ui}`, characters),
      set.load(`14px ${fonts.mono}`, characters),
    ]);
  } catch {
    /* A face that cannot load is measured with its fallback, which is also what is drawn. */
  }
}

let renderCount = 0;

/**
 * The house defaults for the kinds whose stock drawing reads poorly here. pele merges the file's own
 * front matter over these section by section, so an author who sets a section keeps their settings.
 *  - quadrant chart: room above the title, labels a step smaller than the title, a point that reads
 *    at a glance;
 *  - sankey: labels outside the flows with a paper halo, so a name is never set over a ribbon.
 */
const DIAGRAM_DEFAULTS: NonNullable<RenderOptions['config']> = {
  quadrantChart: {
    titlePadding: 28,
    titleFontSize: 15,
    quadrantLabelFontSize: 13,
    quadrantTextTopPadding: 12,
    xAxisLabelFontSize: 12,
    yAxisLabelFontSize: 12,
    xAxisLabelPadding: 10,
    yAxisLabelPadding: 10,
    pointLabelFontSize: 12,
    pointRadius: 5,
    pointTextPadding: 6,
  },
  sankey: {
    labelStyle: 'outlined',
    nodeWidth: 12,
    nodePadding: 14,
  },
};

/**
 * The options every drawing uses. Nothing here comes from the file: pele's guide says diagram
 * authors must never supply `options` or `options.config`.
 */
export function diagramRenderOptions(
  fonts: DiagramFonts,
  idPrefix: string,
  extra: { math?: MathResolver; maxWidth?: number | null; type?: string | null } = {},
): RenderOptions {
  return {
    config: DIAGRAM_DEFAULTS,
    math: extra.math,
    maxWidth: extra.maxWidth ?? undefined,
    measurer: canvasMeasurer(fonts),
    fontFamily: fonts.ui,
    fontFamilyMono: fonts.mono,
    // Identifiers read as code; messages and labels stay in the interface font (Chinese reads better).
    monospace: ['members', 'attributes', 'files'],
    // A C4 box holds four lines, three of them captions; a step larger keeps the captions readable.
    fontSize: extra.type === 'c4' ? 15 : 14,
    padding: 24,
    idPrefix,
    // The stage sizes the drawing itself (`responsive` only adds a max-width style). With a
    // `maxWidth` under pele's breakpoint (640) a drawing too wide for it may also turn: a
    // left-to-right flowchart runs top to bottom, a journey stacks. Without `maxWidth` nothing turns.
    responsive: false,
    limit: MAX_DRAW_CHARS,
    // Links are kept so they can be shown and copied; the sanitiser makes them inert. Pictures are
    // never drawn: an image address would load from the network or the app's own origin.
    links: true,
    images: false,
  };
}

/** One pending draw; set `cancelled` to drop its result. */
export interface DrawJob {
  cancelled: boolean;
}

/** Draws `source`, or says why it cannot. Resolves null when the job was cancelled. */
export async function drawDiagram(source: string, job: DrawJob, layout: DrawLayout = {}): Promise<DrawOutcome | null> {
  const early = precheckDiagram(source);
  if (early) return { ok: false, problem: early, type: null };

  let pele: Pele;
  try {
    pele = await loadPele();
  } catch {
    return job.cancelled ? null : { ok: false, problem: { kind: 'failed' }, type: null };
  }
  if (job.cancelled) return null;

  const type = pele.detectType(source);
  if (type !== null) {
    let loaded = false;
    try {
      loaded = await pele.load(type);
    } catch {
      loaded = false;
    }
    if (job.cancelled) return null;
    if (!loaded) return { ok: false, problem: { kind: 'unsupported', type }, type };
  }

  // Labels are measured once; a font still loading would give widths the page does not draw.
  const fonts = interfaceFonts();
  // A formula in a label (`$$…$$`) needs the engine; without it pele writes the formula as its source.
  const wantsMath = source.includes('$$');
  await Promise.all([loadFonts(source, fonts), wantsMath ? loadMathEngine() : undefined]);
  await idle();
  if (job.cancelled) return null;

  const math: LabelMath | null = wantsMath && mathEngineReady() ? createLabelMath() : null;
  try {
    renderCount += 1;
    const layoutWidth = layout.maxWidth != null && layout.maxWidth > 0 ? layout.maxWidth : null;
    const options = diagramRenderOptions(fonts, `fantay-dg${renderCount}`, { math: math?.resolver, maxWidth: layoutWidth, type });
    if (math) {
      // The first pass finds the formulas, which asks for their fonts; the pass below measures them set.
      try {
        pele.render(source, options);
      } catch {
        /* The pass below reports it. */
      }
      await math.settle();
      if (job.cancelled) return null;
    }

    const started = performance.now();
    let svg: string;
    let width: number;
    let height: number;
    let kind: string;
    try {
      const result = pele.render(source, options);
      ({ svg, width, height } = result);
      kind = result.type;
    } catch (error) {
      return { ok: false, problem: describeDiagramError(error, source), type };
    }
    const clean = sanitizeDiagramSvg(svg);
    if (clean && math) math.place(clean.svg);
    try {
      performance.measure(DRAW_MEASURE, { start: started, end: performance.now() });
    } catch {
      /* User Timing is optional. */
    }
    if (!clean || !(width > 0) || !(height > 0)) return { ok: false, problem: { kind: 'failed' }, type };
    return {
      ok: true,
      drawing: { source, svg: clean.svg, width, height, type: kind, links: clean.links, math: math?.used() ?? false, layoutWidth },
    };
  } finally {
    math?.dispose();
  }
}

// ── the last good drawing of each file ───────────────────────────────────────────────────────────

const MAX_KEPT = 12;
const kept = new Map<string, DiagramDrawing>();

export function keptDrawing(key: string): DiagramDrawing | null {
  return kept.get(key) ?? null;
}

export function keepDrawing(key: string, drawing: DiagramDrawing): void {
  kept.delete(key);
  kept.set(key, drawing);
  if (kept.size > MAX_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest !== undefined) kept.delete(oldest);
  }
}

/** Test seam. */
export function forgetDrawings(): void {
  kept.clear();
}
