// SPDX-License-Identifier: AGPL-3.0-only
// Mermaid files (`.mmd`, `.mermaid`): the diagram, drawn by pele, as one object on a quiet ground,
// with the source one click away. It opens fitted to the stage and never enlarged past 100% (when
// fitting the whole drawing would make its words too small it opens as wide as the stage instead);
// pinch or ⌘-scroll zooms around the pointer, dragging pans, a double click goes back to fit (or
// to 100% from fit), the keyboard pans with the arrows and zooms with +, − and 0 (with or without
// ⌘/Ctrl). The drawing is vector at every zoom: the frame is resized and the SVG redrawn, never
// scaled as a bitmap. The layout is asked to keep to the stage's width (`DrawLayout`), so a kind that
// can be narrower (C4, sequence, journey, timeline…) is laid out for the panel and read at its real
// size; when the panel is resized the same text is laid out again and the old drawing stays until
// the new one is ready.
// Zoom is the image viewer's model, not pele's own `enableZoom`: one feel for every picture-like
// tab, the shared zoom control in the bar, and zoom and pan kept per file like every other viewer
// (pele's zoom draws its own buttons inside the diagram and keeps its state to itself).
// Colours are pele's CSS variables mapped to the product tokens in the stylesheet, so the drawing
// is ink on paper in light and dark and follows a theme change without being drawn again. The SVG
// goes into the page only after `diagram/sanitize-svg.ts`; links in it never navigate, a click
// copies the address, as in the PDF viewer.
// A rewrite that does not parse keeps the last good drawing and says so in one line.
'use client';

import { Copy, FileDown, FileText, FileWarning, Image as ImageIcon, ImageDown, TriangleAlert, Workflow } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { useT } from '../../../i18n';
import { copyText, downloadBlob } from '../../board/interaction/file-actions';
import { Button } from '../../ui';
import { ArtifactShell, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { ArtifactZoom, nextZoomStep } from '../shell/ArtifactZoom';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, formatBytes, useArtifactText } from '../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { exportDiagram, rasterizeSvg } from './diagram/export';
import { clampZoom, fitZoom, openZoom, pointAt, scrollFor, type Point, type Size } from './diagram/geometry';
import { diagramKindKey } from './diagram/kinds';
import { ProblemPanel } from './diagram/ProblemPanel';
import type { DiagramProblem } from './diagram/problems';
import { drawDiagram, layoutWidthFor, type DiagramDrawing } from './diagram/render';
import { revealSourceLine } from './diagram/reveal-line';
import theme from './diagram/theme.module.css';
import { useDiagramDrawing } from './diagram/use-diagram-drawing';
import styles from './DiagramViewer.module.css';
import { CodePane } from './parts/CodePane';

/** Source past this is not fetched; the frame says the file is too large. */
const MAX_SOURCE_BYTES = 1024 * 1024;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
/** Arrow keys pan by this much; with Shift, four times as far. */
const PAN_STEP = 64;
const HINT_MS = 1600;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The class that maps pele's variables to the product tokens; exports read their colours through it. */
const THEME_CLASS = theme.theme ?? '';
/** The ground the stage keeps around the drawing on each side (`.plane`'s padding). */
const STAGE_PADDING = 24;
/** A resize settles for this long before the diagram is laid out for the new width. */
const RELAYOUT_MS = 140;
/** A drawing that has not been laid out for the stage after this long is shown as it is. */
const SETTLE_MS = 700;
/** The stage's width the last time a diagram was measured, so the next one is laid out for it at once. */
let rememberedStageWidth = 0;

type DiagramMode = 'diagram' | 'source';

interface Hint {
  /** Pointer position inside the stage; null puts the hint at the top centre. */
  at: Point | null;
  text: string;
  show: boolean;
}

function baseName(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export default function DiagramViewer({ projectId, file, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const [mode, setMode] = useArtifactViewState<DiagramMode>(projectId, file.name, 'mode', 'diagram');
  const text = useArtifactText(projectId, file, { enabled: active, maxBytes: MAX_SOURCE_BYTES });
  const raw = text.source.status === 'ready' ? text.source.data : null;
  /** The room the layout is drawn for; null until a stage has been measured once. */
  const [layoutWidth, setLayoutWidth] = useState<number | null>(() => layoutWidthFor(rememberedStageWidth - STAGE_PADDING * 2));
  const { drawing, failed, pending } = useDiagramDrawing(`${projectId}\n${file.name}`, raw, active, layoutWidth);
  const showingSource = mode === 'source';
  const showingDrawing = !showingSource && drawing !== null;

  // ── "drawing…" only after the grace period ──────────────────────────────────────────────────
  const waiting = !showingSource && drawing === null && pending;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), ARTIFACT_SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  // ── size and zoom ─────────────────────────────────────────────────────────────────────────────
  // The stage element is held in state as well as a ref: it mounts later than the viewer whenever
  // the frame shows a state first, and measuring, wheel zoom and the reader's place follow it.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportElement, setViewportElement] = useState<HTMLDivElement | null>(null);
  const attachViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
    setViewportElement(element);
  }, []);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  /** null = fit to the stage; a number = that zoom, kept across resizes, tab switches and updates. */
  const [zoom, setZoom] = useArtifactViewState<number | null>(projectId, file.name, 'zoom', null);
  /** The drawing point to keep under the pointer when the zoom changes. */
  const anchorRef = useRef<{ point: Point; at: Point } | null>(null);

  const width = drawing?.width ?? 0;
  const height = drawing?.height ?? 0;
  const size = useMemo<Size | null>(() => (width > 0 && height > 0 ? { width, height } : null), [width, height]);
  const measured = viewport.width > 0 && viewport.height > 0;
  const fit = size && measured ? openZoom(size, viewport) : 1;
  // The reader can still step out until the whole drawing is in view.
  const minZoom = Math.min(MIN_ZOOM, size && measured ? fitZoom(size, viewport) : 1);
  const scale = zoom ?? fit;

  useLayoutEffect(() => {
    const element = viewportElement;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      if (element.clientWidth > 0) rememberedStageWidth = element.clientWidth;
      setViewport({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewportElement]);

  // The layout follows the stage's width: at once the first time, after the resize has settled later.
  const wantedLayout = measured ? layoutWidthFor(viewport.width - STAGE_PADDING * 2) : layoutWidth;
  useEffect(() => {
    if (wantedLayout === layoutWidth) return;
    if (layoutWidth === null) {
      setLayoutWidth(wantedLayout);
      return;
    }
    const timer = window.setTimeout(() => setLayoutWidth(wantedLayout), RELAYOUT_MS);
    return () => window.clearTimeout(timer);
  }, [wantedLayout, layoutWidth]);

  // The frame appears once the drawing is the one laid out for this stage, so the first thing the
  // reader sees is not a wide layout about to be replaced.
  const settledRef = useRef(false);
  const [settleTimedOut, setSettleTimedOut] = useState(false);
  if (measured && drawing !== null && drawing.layoutWidth === wantedLayout) settledRef.current = true;
  const settled = settledRef.current || settleTimedOut;
  useEffect(() => {
    if (!measured || settled) return;
    const timer = window.setTimeout(() => setSettleTimedOut(true), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [measured, settled]);

  /**
   * The zoom as last asked for. A pinch sends several wheel events per frame, before React has
   * drawn the previous one; reading this instead of `scale` lets them compound.
   */
  const liveScaleRef = useRef(scale);
  liveScaleRef.current = scale;

  const zoomAt = useCallback(
    (next: number | null, clientX?: number, clientY?: number) => {
      const element = viewportRef.current;
      const clamped = next === null ? null : clampZoom(next, minZoom, MAX_ZOOM);
      if (element && size) {
        const rect = element.getBoundingClientRect();
        const box = { width: element.clientWidth, height: element.clientHeight };
        const at = {
          x: clientX === undefined ? box.width / 2 : clientX - rect.left,
          y: clientY === undefined ? box.height / 2 : clientY - rect.top,
        };
        const target = clamped ?? openZoom(size, box);
        if (Math.abs(target - liveScaleRef.current) > 1e-6) {
          // While an anchor is still waiting to be applied, the scroll position is stale: keep its point.
          const pending = anchorRef.current;
          const point = pending ? pending.point : pointAt({ x: element.scrollLeft, y: element.scrollTop }, at, box, size, liveScaleRef.current);
          anchorRef.current = { point, at };
          liveScaleRef.current = target;
        }
      }
      setZoom(clamped);
    },
    [size, minZoom, setZoom],
  );

  // After the zoom has been applied, scroll so the anchored point is back under the pointer.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const anchor = anchorRef.current;
    if (!element || !anchor || !size) return;
    anchorRef.current = null;
    const scroll = scrollFor(anchor.point, anchor.at, { width: element.clientWidth, height: element.clientHeight }, size, scale);
    element.scrollLeft = scroll.x;
    element.scrollTop = scroll.y;
  }, [scale, size]);

  // ── the reader's place: the drawing point at the centre of the stage, per file ──────────────────
  const restoreRef = useRef(true);
  const drawnSource = drawing?.source ?? null;
  useLayoutEffect(() => {
    restoreRef.current = true;
  }, [drawnSource, viewportElement]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || !size || !measured || !restoreRef.current) return;
    restoreRef.current = false;
    if (zoom === null) return;
    const centre = readArtifactViewState<Point>(projectId, file.name, 'centre');
    if (!centre) return;
    const box = { width: element.clientWidth, height: element.clientHeight };
    const scroll = scrollFor(centre, { x: box.width / 2, y: box.height / 2 }, box, size, scale);
    element.scrollLeft = scroll.x;
    element.scrollTop = scroll.y;
  }, [size, measured, zoom, scale, projectId, file.name]);

  const scrollFrame = useRef(0);
  const onScroll = (): void => {
    if (scrollFrame.current) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const element = viewportRef.current;
      if (!element || !size || restoreRef.current) return;
      const box = { width: element.clientWidth, height: element.clientHeight };
      const centre = pointAt({ x: element.scrollLeft, y: element.scrollTop }, { x: box.width / 2, y: box.height / 2 }, box, size, scale);
      writeArtifactViewState(projectId, file.name, 'centre', centre);
    });
  };
  useEffect(() => () => window.cancelAnimationFrame(scrollFrame.current), []);

  // Pinch and ⌘/Ctrl-scroll zoom. The listener is not passive: the page must not zoom instead.
  useEffect(() => {
    const element = viewportElement;
    if (!element || !size) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAt(liveScaleRef.current * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [viewportElement, size, zoomAt]);

  // ── panning ───────────────────────────────────────────────────────────────────────────────────
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null);
  const draggedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const pannable =
    size !== null && measured && (size.width * scale + 48 > viewport.width + 1 || size.height * scale + 48 > viewport.height + 1);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    draggedRef.current = false;
    if (event.button !== 0 || !pannable) return;
    const element = event.currentTarget;
    dragRef.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop, id: event.pointerId };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!dragging) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      // Captured only once the pointer has really moved, so a plain click still reaches a link.
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    event.currentTarget.scrollLeft = drag.left - dx;
    event.currentTarget.scrollTop = drag.top - dy;
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.id !== event.pointerId) return;
    dragRef.current = null;
    if (dragging) {
      draggedRef.current = true;
      event.currentTarget.releasePointerCapture(event.pointerId);
      setDragging(false);
    }
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!size) return;
    if (zoom === null && fit < 1) zoomAt(1, event.clientX, event.clientY);
    else zoomAt(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!size || event.altKey) return;
    const command = event.metaKey || event.ctrlKey;
    const { key } = event;
    if (key === '+' || key === '=') zoomAt(nextZoomStep(scale, 1, minZoom, MAX_ZOOM));
    else if (key === '-' || key === '_') zoomAt(nextZoomStep(scale, -1, minZoom, MAX_ZOOM));
    else if (key === '0') zoomAt(null);
    else if (key === '1' && !command) zoomAt(1);
    else if (!command && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown')) {
      const step = event.shiftKey ? PAN_STEP * 4 : PAN_STEP;
      event.currentTarget.scrollBy({
        left: key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0,
        top: key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0,
      });
    } else return;
    event.preventDefault();
  };

  // ── the drawing itself ────────────────────────────────────────────────────────────────────────
  const [drawingHost, setDrawingHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const host = drawingHost;
    if (!host || !drawing) return;
    const svg = drawing.svg.cloneNode(true) as SVGSVGElement;
    // The stage carries the role and the name; the drawing is its picture.
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const link of Array.from(svg.querySelectorAll('a[data-diagram-link]'))) {
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = t('artifact.pdf.linkExternal', { url: link.getAttribute('data-diagram-link') ?? '' });
      link.insertBefore(title, link.firstChild);
    }
    host.replaceChildren(svg);
  }, [drawing, drawingHost, t]);

  // ── hints next to the thing (a copied link, a copied picture) ──────────────────────────────────
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<Hint | null>(null);
  const hintTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    },
    [],
  );
  const showHint = useCallback((message: string, client?: Point) => {
    const root = rootRef.current;
    let at: Point | null = null;
    if (root && client) {
      const rect = root.getBoundingClientRect();
      at = { x: Math.min(rect.width - 12, Math.max(12, client.x - rect.left)), y: Math.max(36, client.y - rect.top) };
    }
    setHint({ at, text: message, show: true });
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint((previous) => (previous ? { ...previous, show: false } : previous)), HINT_MS);
  }, []);

  const onClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (draggedRef.current) return;
    const link = (event.target as Element | null)?.closest?.('[data-diagram-link]');
    const url = link?.getAttribute('data-diagram-link');
    if (!url) return;
    event.preventDefault();
    const client = { x: event.clientX, y: event.clientY };
    // Never followed: the address goes to the clipboard and the reader decides where to open it.
    void copyText(url).then((copied) => {
      if (copied) showHint(t('artifact.pdf.linkCopied'), client);
    });
  };

  // ── source view, and "查看源码" at a line ──────────────────────────────────────────────────────
  const sourceHostRef = useRef<HTMLDivElement | null>(null);
  const [reveal, setReveal] = useState<number | null>(null);
  const openSource = useCallback(
    (line: number | null) => {
      setReveal(line);
      setMode('source');
    },
    [setMode],
  );
  useEffect(() => {
    const host = sourceHostRef.current;
    if (!showingSource || raw === null || reveal === null || !host) return;
    return revealSourceLine(host, reveal, () => setReveal(null));
  }, [showingSource, raw, reveal]);

  // ── actions ───────────────────────────────────────────────────────────────────────────────────
  const name = baseName(file.name);
  const copySource = useCallback(async () => {
    if (raw !== null && (await copyText(raw))) showHint(t('artifact.diagram.copiedSource'));
  }, [raw, showHint, t]);

  /**
   * The drawing as it leaves the app: laid out as written, not for this panel's width, so the same
   * file gives the same picture whatever size the panel happens to be.
   */
  const drawingToExport = useCallback(async (): Promise<DiagramDrawing | null> => {
    if (!drawing) return null;
    if (drawing.layoutWidth === null) return drawing;
    const outcome = await drawDiagram(drawing.source, { cancelled: false });
    return outcome?.ok ? outcome.drawing : drawing;
  }, [drawing]);

  const exportPng = useCallback(async (): Promise<Blob> => {
    const picture = await drawingToExport();
    if (!picture) throw new Error('no drawing');
    return rasterizeSvg(await exportDiagram(picture, THEME_CLASS), picture.width, picture.height);
  }, [drawingToExport]);

  const copyImage = useCallback(() => {
    if (!drawing) return;
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      showHint(t('artifact.diagram.copyImageFailed'));
      return;
    }
    try {
      // The PNG is handed over as a promise so the clipboard write stays inside the click.
      const png = exportPng();
      navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(
        () => showHint(t('artifact.diagram.copiedImage')),
        () => showHint(t('artifact.diagram.copyImageFailed')),
      );
    } catch {
      showHint(t('artifact.diagram.copyImageFailed'));
    }
  }, [drawing, exportPng, showHint, t]);

  const saveSvg = useCallback(async () => {
    const picture = await drawingToExport();
    if (!picture) return;
    downloadBlob(new Blob([await exportDiagram(picture, THEME_CLASS)], { type: 'image/svg+xml' }), `${name}.svg`);
  }, [drawingToExport, name]);

  const savePng = useCallback(async () => {
    if (!drawing) return;
    try {
      downloadBlob(await exportPng(), `${name}.png`);
    } catch {
      /* The drawing could not be encoded: the SVG is still available from the same menu. */
    }
  }, [drawing, exportPng, name]);

  const menu = useMemo<ArtifactMenuEntry[]>(
    () => [
      { id: 'copy-source', label: t('artifact.diagram.copySource'), icon: Copy, onSelect: () => void copySource(), disabled: raw === null },
      { id: 'copy-image', label: t('artifact.image.copy'), icon: ImageIcon, onSelect: copyImage, disabled: drawing === null },
      { id: 'save-svg', label: t('artifact.diagram.saveSvg'), icon: FileDown, onSelect: () => void saveSvg(), disabled: drawing === null, separated: true },
      { id: 'save-png', label: t('artifact.diagram.savePng'), icon: ImageDown, onSelect: () => void savePng(), disabled: drawing === null },
      ...fileActions.menu.map((entry, index) => (index === 0 ? { ...entry, separated: true } : entry)),
    ],
    [t, copySource, raw, copyImage, drawing, saveSvg, savePng, fileActions.menu],
  );

  // ── words ─────────────────────────────────────────────────────────────────────────────────────
  const kind = drawing?.type ?? failed?.type ?? null;
  const kindName = t(diagramKindKey(kind));
  const facts = [kind ? kindName : null, formatBytes(file.size)].filter(Boolean).join(' · ');

  const problemState = (problem: DiagramProblem): ArtifactShellState => {
    const toSource = { label: t('artifact.notebook.showSource'), onSelect: () => openSource(null) };
    switch (problem.kind) {
      case 'empty':
        return { kind: 'notice', icon: FileText, title: t('artifact.text.empty') };
      case 'no-content':
        return { kind: 'notice', icon: Workflow, title: t('artifact.diagram.error.noContent'), description: t('artifact.diagram.error.noContentHint'), action: toSource };
      case 'unknown-type':
        return {
          kind: 'notice',
          icon: Workflow,
          title: t('artifact.diagram.error.unknownType'),
          description: t('artifact.diagram.error.unknownTypeHint', { first: problem.first }),
          action: toSource,
        };
      case 'unsupported':
        return {
          kind: 'notice',
          icon: Workflow,
          title: t('artifact.diagram.error.unsupported'),
          description: t('artifact.diagram.error.unsupportedHint', { type: problem.type }),
          action: toSource,
        };
      case 'too-large': {
        const limit = problem.limit === null ? '' : problem.limit.toLocaleString();
        const description =
          problem.reason === 'source'
            ? t('artifact.diagram.error.tooLargeSource', { limit })
            : problem.reason === 'edges'
              ? t('artifact.diagram.error.tooLargeEdges', { limit })
              : problem.reason === 'depth'
                ? t('artifact.diagram.error.tooDeep')
                : t('artifact.diagram.error.tooLargeOutput');
        return { kind: 'notice', icon: FileWarning, title: t('artifact.diagram.error.tooLarge'), description, action: toSource, secondaryAction: { label: t('fileViewer.download'), onSelect: fileActions.downloadFile } };
      }
      default:
        return { kind: 'notice', icon: FileWarning, title: t('artifact.diagram.error.failed'), description: t('artifact.diagram.error.failedHint'), action: toSource };
    }
  };

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  let state: ArtifactShellState | null = fileActions.sourceState(text.source, text.reload);
  // A drawing kept from before (a tab switch, a rewrite) shows at once while the text is fetched again.
  if (state?.kind === 'loading' && !showingSource && drawing !== null) state = null;
  let parseProblem: Extract<DiagramProblem, { kind: 'syntax' | 'semantic' }> | null = null;
  if (state === null && !showingSource && drawing === null) {
    if (failed) {
      if (failed.problem.kind === 'syntax' || failed.problem.kind === 'semantic') parseProblem = failed.problem;
      else state = problemState(failed.problem);
    } else {
      state = slow ? { kind: 'loading', label: t('artifact.diagram.drawing') } : { kind: 'loading', quiet: true };
    }
  }

  // The one quiet line while an older drawing stands in for a newer version that does not draw.
  const staleLine = failed && (failed.problem.kind === 'syntax' || failed.problem.kind === 'semantic') ? failed.problem.line : null;
  const staleText = showingDrawing && failed ? (staleLine !== null ? t('artifact.diagram.stale', { line: String(staleLine) }) : t('artifact.diagram.staleNoLine')) : null;
  const lastStale = useRef<{ text: string; line: number | null }>({ text: '', line: null });
  if (staleText) lastStale.current = { text: staleText, line: staleLine };

  return (
    <ArtifactShell
      viewer="diagram"
      path={file.name}
      stage={showingSource ? 'fill' : 'canvas'}
      modes={[
        { id: 'diagram', label: t('artifact.diagram.viewDiagram') },
        { id: 'source', label: t('artifact.notebook.viewSource') },
      ]}
      mode={mode}
      modesLabel={t('artifact.viewMode')}
      onModeChange={(next) => {
        setReveal(null);
        setMode(next === 'source' ? 'source' : 'diagram');
      }}
      controls={
        showingDrawing && state === null ? (
          <ArtifactZoom
            zoom={measured ? scale : null}
            min={minZoom}
            max={MAX_ZOOM}
            onZoom={(next) => zoomAt(next)}
            // "Fit to window" means the whole drawing; a tall one opens wider than that (see `openZoom`).
            onFit={() => zoomAt(size && fitZoom(size, viewport) < fit - 1e-3 ? fitZoom(size, viewport) : null)}
          />
        ) : null
      }
      meta={facts}
      actions={[fileActions.download]}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      <div ref={rootRef} className={`${styles.root} ${THEME_CLASS}`}>
        {showingSource ? (
          raw !== null ? (
            <div ref={sourceHostRef} className={styles.source}>
              <CodePane docKey={`${file.name}:source`} fileName={file.name} text={raw} wrap />
            </div>
          ) : null
        ) : drawing && size ? (
          <div
            ref={attachViewport}
            className={styles.viewport}
            data-pannable={pannable || undefined}
            data-dragging={dragging || undefined}
            tabIndex={0}
            role="img"
            aria-label={t('artifact.diagram.stageLabel', { kind: kindName, name: file.name })}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
            onScroll={onScroll}
          >
            <div className={styles.plane}>
              <div
                className={styles.frame}
                data-ready={(measured && settled) || undefined}
                style={{ width: Math.max(1, size.width * scale), height: Math.max(1, size.height * scale) }}
              >
                <div ref={setDrawingHost} className={styles.drawing} />
              </div>
            </div>
          </div>
        ) : parseProblem ? (
          <ProblemPanel problem={parseProblem} onShowSource={openSource} />
        ) : null}

        {showingDrawing ? (
          <div className={styles.stale} data-show={staleText ? '' : undefined} role="status">
            <TriangleAlert className={styles.staleGlyph} aria-hidden="true" size={14} strokeWidth={1.75} />
            <span className={styles.staleText}>{staleText ?? lastStale.current.text}</span>
            <Button
              size="sm"
              variant="bare"
              className={styles.staleAction}
              tabIndex={staleText ? 0 : -1}
              onClick={() => openSource(lastStale.current.line)}
            >
              {t('artifact.notebook.showSource')}
            </Button>
          </div>
        ) : null}

        <div
          className={styles.hint}
          data-show={hint?.show ? '' : undefined}
          data-at={hint?.at ? 'pointer' : 'top'}
          style={hint?.at ? { left: hint.at.x, top: hint.at.y } : undefined}
          role="status"
          aria-live="polite"
        >
          {hint?.text ?? ''}
        </div>
      </div>
    </ArtifactShell>
  );
}
