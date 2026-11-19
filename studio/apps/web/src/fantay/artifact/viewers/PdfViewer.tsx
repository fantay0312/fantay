// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/PdfViewer.tsx @ c5e6b24f (MIT): the shape of a
// pdf.js viewer with our own interface (open the bytes, lay the pages out, mount only the pages near
// the window, remember where the reader was). Changed here: the frame, controls and states are the
// artifact shell's; pages keep their own sizes; the reader's place is kept as page + fraction and
// restored after every layout change (zoom, panel width, late page sizes, a new version of the
// file); zoom follows the pointer; a password-protected file asks for its password; the bitmaps on
// screen outlive a tab switch.
//
// PDF: pages in one column on the sheet ground. It opens fitted to the panel's width. The pager
// shows the page in view; ⌘-scroll or a pinch zooms around the pointer, ⌘+ / ⌘− / ⌘0 step and reset.
// Text can be selected and copied. A link inside the document jumps; a link to the outside is never
// followed: activating it copies its address and says so next to the click.
'use client';

import type { PDFDocumentProxy } from 'pdfjs-dist';
import { File, FileWarning, Lock, Maximize, Search, type LucideIcon } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { useT } from '../../../i18n';
import { Button, Input, cn } from '../../ui';
import { copyText } from '../../board/interaction/file-actions';
import { ArtifactPager } from '../shell/ArtifactPager';
import { ArtifactShell, type ArtifactAction, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { ArtifactZoom, nextZoomStep } from '../shell/ArtifactZoom';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, formatBytes, useArtifactBytes } from '../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import sheets from './parts/Sheets.module.css';
import { createPdfBitmapKeeper } from './pdf/bitmap-keeper';
import {
  classifyPdfError,
  forgetPdfPassword,
  loadPdfjs,
  openPdf,
  rememberPdfPassword,
  rememberedPdfPassword,
  type PdfFailure,
  type PdfModule,
} from './pdf/pdf-document';
import {
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  pdfAnchorAt,
  pdfAnchorTop,
  pdfCurrentPage,
  pdfLayout,
  pdfPageDistance,
  pdfPageLeft,
  pdfPageScrollTop,
  pdfPageWindow,
  pdfResolveZoom,
  type PdfAnchor,
  type PdfLayout,
  type PdfMetrics,
  type PdfPageSize,
  type PdfViewport,
  type PdfZoom,
} from './pdf/pdf-layout';
import { unifyCjkRadicals } from './pdf/pdf-find';
import type { PdfLinkTarget } from './pdf/pdf-links';
import { PdfFindBar } from './pdf/PdfFindBar';
import { PdfPage } from './pdf/PdfPage';
import { createPdfRenderQueue } from './pdf/render-queue';
import { usePdfFind } from './pdf/use-pdf-find';
import styles from './PdfViewer.module.css';

const MAX_BYTES = 100 * 1024 * 1024;
/** Parsing that takes longer than this ends in a notice, never in a stage that stays empty. */
const OPEN_TIMEOUT_MS = 30_000;
/** Page sizes are read from the document this many at a time, in the background. */
const MEASURE_BATCH = 32;
/** The sheet ground's padding and gap until they have been read from its computed style. */
const DEFAULT_METRICS: PdfMetrics = { pad: 24, gap: 16 };
/** How long "link address copied" stays up. */
const HINT_MS = 1600;
/** A ground smaller than this is a panel that is collapsed or still sliding in: not a size to lay pages out for. */
const MIN_STAGE_WIDTH = 120;
const MIN_STAGE_HEIGHT = 60;

interface OpenDocument {
  /** The bytes it was opened from: the identity of a version of the file. */
  data: ArrayBuffer;
  pdf: PDFDocumentProxy;
  pdfjs: PdfModule;
  close(): void;
}

/** The reader's place: a page, how far down it the window starts, and how far across. */
interface PdfPosition extends PdfAnchor {
  left: number;
}

/** A point of the document to hold still while the layout changes around it. */
interface PendingAnchor {
  anchor: PdfAnchor;
  /** Fraction of the anchor page's width. */
  across: number;
  /** Where that point sits in the window. */
  x: number;
  y: number;
}

function sameSize(a: PdfPageSize | undefined, b: PdfPageSize): boolean {
  return a !== undefined && Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;
}

/** The screen's pixel ratio, kept current when the window moves to another display. */
function usePixelRatio(): number {
  const [ratio, setRatio] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  useEffect(() => {
    let query: MediaQueryList | null = null;
    const update = (): void => {
      query?.removeEventListener('change', update);
      const current = window.devicePixelRatio || 1;
      setRatio(current);
      query = window.matchMedia(`(resolution: ${current}dppx)`);
      query.addEventListener('change', update);
    };
    update();
    return () => query?.removeEventListener('change', update);
  }, []);
  return ratio;
}

function PdfDocumentView({ projectId, file, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const fileKey = `${projectId}\n${file.name}`;
  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: MAX_BYTES });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;

  // ── the document ──────────────────────────────────────────────────────────────────────────────
  const [opened, setOpened] = useState<OpenDocument | null>(null);
  const [failure, setFailure] = useState<{ data: ArrayBuffer; kind: PdfFailure } | null>(null);
  const [lock, setLock] = useState<{ data: ArrayBuffer; wrong: boolean; submit(password: string): void } | null>(null);
  const [slowOpen, setSlowOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /** Page sizes at scale 1. Kept with the file, so the pages stand where they stood before any byte arrives. */
  const [sizes, setSizes] = useState<PdfPageSize[] | null>(() => readArtifactViewState<PdfPageSize[]>(projectId, file.name, 'sizes') ?? null);
  const openedData = opened?.data ?? null;

  useEffect(() => {
    if (!data || !active || openedData === data) return;
    if (data.byteLength === 0) {
      setFailure({ data, kind: 'empty' });
      return;
    }
    let current = true;
    let adopted = false;
    let handle: ReturnType<typeof openPdf> | null = null;
    /** True once the reader has typed a password here (a remembered one that no longer fits is not their mistake). */
    let typed = false;
    setSlowOpen(false);
    const slow = window.setTimeout(() => current && setSlowOpen(true), ARTIFACT_SLOW_LOAD_MS);
    let deadline = window.setTimeout(() => fail('slow'), OPEN_TIMEOUT_MS);

    function fail(kind: PdfFailure): void {
      if (!current) return;
      current = false;
      window.clearTimeout(slow);
      window.clearTimeout(deadline);
      handle?.close();
      setLock(null);
      setFailure({ data: data as ArrayBuffer, kind });
    }

    void (async () => {
      const pdfjs = await loadPdfjs();
      if (!current) return;
      handle = openPdf(pdfjs, data, { password: rememberedPdfPassword(fileKey) });
      handle.task.onPassword = (update: (password: string) => void, reason: number) => {
        if (!current) return;
        // Waiting for the reader is not a slow parse.
        window.clearTimeout(deadline);
        const rejected = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
        if (rejected) forgetPdfPassword(fileKey);
        setLock({
          data,
          wrong: rejected && typed,
          submit: (password) => {
            typed = true;
            rememberPdfPassword(fileKey, password);
            deadline = window.setTimeout(() => fail('slow'), OPEN_TIMEOUT_MS);
            update(password);
          },
        });
      };
      const pdf = await handle.task.promise;
      if (!current) return;
      if (pdf.numPages < 1) {
        fail('empty');
        return;
      }
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
      if (!current) return;
      window.clearTimeout(slow);
      window.clearTimeout(deadline);
      adopted = true;
      const size: PdfPageSize = { width: first.width, height: first.height };
      // The sizes known from last time stand until the real ones are read; a new document starts
      // with every page as large as the first.
      setSizes((previous) => (previous && previous.length === pdf.numPages ? previous : Array.from({ length: pdf.numPages }, () => size)));
      setLock(null);
      setFailure(null);
      setOpened({ data, pdf, pdfjs, close: handle.close });
    })().catch((error: unknown) => fail(classifyPdfError(error)));

    return () => {
      current = false;
      window.clearTimeout(slow);
      window.clearTimeout(deadline);
      if (!adopted) handle?.close();
    };
  }, [data, active, openedData, attempt, fileKey]);

  // The previous version stays open (and on screen) until the next one has taken its place.
  useEffect(() => {
    if (!opened) return;
    return () => {
      opened.close();
      // pdf.js keeps hidden measuring canvases for its text layers; they go once no layer is being built.
      window.setTimeout(() => opened.pdfjs.TextLayer.cleanup(), 0);
    };
  }, [opened]);

  // Every page's real size, read in the background. Most documents have one size and nothing moves.
  useEffect(() => {
    if (!opened) return;
    let current = true;
    const { pdf } = opened;
    void (async () => {
      for (let start = 0; start < pdf.numPages && current; start += MEASURE_BATCH) {
        const indexes = Array.from({ length: Math.min(MEASURE_BATCH, pdf.numPages - start) }, (_, offset) => start + offset);
        const measured = await Promise.all(
          indexes.map(async (index): Promise<PdfPageSize> => {
            const viewport = (await pdf.getPage(index + 1)).getViewport({ scale: 1 });
            return { width: viewport.width, height: viewport.height };
          }),
        );
        if (!current) return;
        setSizes((previous) => {
          if (!previous || previous.length !== pdf.numPages) return previous;
          if (measured.every((size, offset) => sameSize(previous[start + offset], size))) return previous;
          const next = previous.slice();
          measured.forEach((size, offset) => (next[start + offset] = size));
          return next;
        });
      }
    })().catch(() => undefined);
    return () => {
      current = false;
    };
  }, [opened]);

  useEffect(() => {
    if (sizes) writeArtifactViewState(projectId, file.name, 'sizes', sizes);
  }, [sizes, projectId, file.name]);

  /** A page found that its box has another shape than the page (it was reached before the pass above). */
  const onPageSize = useCallback((index: number, size: PdfPageSize) => {
    setSizes((previous) => {
      if (!previous || index >= previous.length || sameSize(previous[index], size)) return previous;
      const next = previous.slice();
      next[index] = size;
      return next;
    });
  }, []);

  // ── size, zoom, layout ────────────────────────────────────────────────────────────────────────
  // The scrolling ground. Kept in state as well as in a ref: it mounts and unmounts with the frame's
  // states, and the observers below have to follow the element, not a condition.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scroller, setScrollerElement] = useState<HTMLDivElement | null>(null);
  const setScroller = useCallback((element: HTMLDivElement | null) => {
    scrollerRef.current = element;
    setScrollerElement(element);
  }, []);
  const [viewport, setViewport] = useState<PdfViewport | null>(null);
  const [metrics, setMetrics] = useState<PdfMetrics>(DEFAULT_METRICS);
  /** `width` = fit the panel's width (the default), `page` = a whole page, a number = that zoom. */
  const [zoom, setZoom] = useArtifactViewState<PdfZoom>(projectId, file.name, 'zoom', 'width');
  const pixelRatio = usePixelRatio();
  const showsPages = sizes !== null && sizes.length > 0;

  useLayoutEffect(() => {
    const element = scroller;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      // A collapsed panel must not shrink the pages to nothing and lose the reader's place.
      if (element.clientWidth < MIN_STAGE_WIDTH || element.clientHeight < MIN_STAGE_HEIGHT) return;
      const style = window.getComputedStyle(element);
      const pad = Number.parseFloat(style.paddingTop);
      const gap = Number.parseFloat(style.rowGap);
      setMetrics((previous) => {
        const next = { pad: Number.isFinite(pad) ? pad : DEFAULT_METRICS.pad, gap: Number.isFinite(gap) ? gap : DEFAULT_METRICS.gap };
        return previous.pad === next.pad && previous.gap === next.gap ? previous : next;
      });
      setViewport((previous) =>
        previous && previous.width === element.clientWidth && previous.height === element.clientHeight
          ? previous
          : { width: element.clientWidth, height: element.clientHeight },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller]);

  const scale = sizes && viewport ? pdfResolveZoom(zoom, sizes, viewport, metrics.pad) : null;
  const layout = useMemo<PdfLayout | null>(() => (sizes && scale !== null ? pdfLayout(sizes, scale, metrics) : null), [sizes, scale, metrics]);
  const pageCount = sizes?.length ?? 0;

  // ── where the reader is ───────────────────────────────────────────────────────────────────────
  const [pageWindow, setPageWindow] = useState<{ first: number; last: number }>({ first: 0, last: -1 });
  const [currentPage, setCurrentPage] = useState(() => readArtifactViewState<PdfPosition & { current?: number }>(projectId, file.name, 'position')?.current ?? 0);
  const layoutRef = useRef<PdfLayout | null>(null);
  const sizesRef = useRef<PdfPageSize[] | null>(sizes);
  const scaleRef = useRef<number | null>(null);
  const currentRef = useRef(currentPage);
  const positionRef = useRef<PdfPosition | null>(readArtifactViewState<PdfPosition>(projectId, file.name, 'position') ?? null);
  const pendingRef = useRef<PendingAnchor | null>(null);
  /** The scroll position this viewer set itself when it last put the reader back in place. */
  const restoredRef = useRef<{ top: number; left: number } | null>(null);
  layoutRef.current = layout;
  sizesRef.current = sizes;
  scaleRef.current = scale;
  currentRef.current = currentPage;

  /** Reads the scroll position into state: the pages to mount, the page in view, the place to come back to. */
  const syncScroll = useCallback(() => {
    const element = scrollerRef.current;
    const current = layoutRef.current;
    if (!element || !current || current.tops.length === 0) return;
    const top = element.scrollTop;
    const next = pdfPageWindow(current, top, element.clientHeight);
    setPageWindow((previous) => (previous.first === next.first && previous.last === next.last ? previous : next));
    const page = pdfCurrentPage(current, top, element.clientHeight, currentRef.current);
    currentRef.current = page;
    setCurrentPage(page);
    // The place to come back to follows the reader's own scrolling. A position this viewer set while
    // restoring that place is not a new place: near the end of the document it can be a clamped one,
    // and adopting it would make the reader drift a little with every change of width.
    const restored = restoredRef.current;
    if (!restored || restored.top !== top || restored.left !== element.scrollLeft) {
      restoredRef.current = null;
      const anchor = pdfAnchorAt(current, top);
      positionRef.current = {
        ...anchor,
        left: (element.scrollLeft - pdfPageLeft(current, anchor.page, element.clientWidth)) / (current.widths[anchor.page] ?? 1),
      };
    }
    if (positionRef.current) writeArtifactViewState(projectId, file.name, 'position', { ...positionRef.current, current: page });
  }, [projectId, file.name]);

  // Whenever the layout changes (zoom, panel width, late page sizes, a new version), put the reader
  // back where they were: the point under the pointer for a zoom, the top of the window otherwise.
  useLayoutEffect(() => {
    const element = scroller;
    if (!element || !layout) return;
    const pending = pendingRef.current;
    pendingRef.current = null;
    const held: PendingAnchor | null =
      pending ?? (positionRef.current ? { anchor: positionRef.current, across: positionRef.current.left, x: 0, y: 0 } : null);
    if (held) {
      const page = Math.min(layout.tops.length - 1, Math.max(0, held.anchor.page));
      element.scrollTop = pdfAnchorTop(layout, held.anchor) - held.y;
      element.scrollLeft = pdfPageLeft(layout, page, element.clientWidth) + held.across * (layout.widths[page] ?? 0) - held.x;
      // A zoom around the pointer is a new place; putting the old place back is not.
      restoredRef.current = pending ? null : { top: element.scrollTop, left: element.scrollLeft };
    }
    syncScroll();
  }, [layout, scroller, syncScroll]);

  const zoomTo = useCallback(
    (next: PdfZoom, pointer?: { x: number; y: number }) => {
      const element = scrollerRef.current;
      const current = layoutRef.current;
      const value = typeof next === 'number' ? Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, next)) : next;
      if (element && current && current.tops.length > 0 && sizesRef.current) {
        const resolved = pdfResolveZoom(value, sizesRef.current, { width: element.clientWidth, height: element.clientHeight }, current.pad);
        // A zoom that changes nothing (already at the limit) must not leave an anchor behind.
        if (scaleRef.current === null || Math.abs(resolved - scaleRef.current) > 1e-9) {
          const rect = element.getBoundingClientRect();
          const x = pointer ? pointer.x - rect.left : element.clientWidth / 2;
          const y = pointer ? pointer.y - rect.top : element.clientHeight / 2;
          const anchor = pdfAnchorAt(current, element.scrollTop + y);
          pendingRef.current = {
            anchor,
            across: (element.scrollLeft + x - pdfPageLeft(current, anchor.page, element.clientWidth)) / (current.widths[anchor.page] ?? 1),
            x,
            y,
          };
        }
        // Wheel events arrive faster than renders: the next one continues from this zoom.
        scaleRef.current = resolved;
      }
      setZoom(value);
    },
    [setZoom],
  );

  const jumpTo = useCallback((page: number, offset: number | null = null) => {
    const element = scrollerRef.current;
    const current = layoutRef.current;
    if (!element || !current || current.tops.length === 0) return;
    const index = Math.min(current.tops.length - 1, Math.max(0, page));
    currentRef.current = index;
    setCurrentPage(index);
    element.scrollTop =
      offset === null ? pdfPageScrollTop(current, index) : Math.max(0, (current.tops[index] ?? 0) + offset * (current.heights[index] ?? 0) - current.gap);
  }, []);

  // Pinch and ⌘/Ctrl-scroll zoom around the pointer. Not passive: the app must not zoom instead.
  useEffect(() => {
    const element = scroller;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const current = scaleRef.current;
      if (current === null) return;
      zoomTo(current * Math.exp(-event.deltaY * 0.01), { x: event.clientX, y: event.clientY });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomTo, scroller]);

  // ── find ──────────────────────────────────────────────────────────────────────────────────────
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const focusFind = useRef(false);
  /** Brings a found place into view, a third of the way down; left alone when it already reads well. */
  const reveal = useCallback((page: number, offset: number) => {
    const element = scrollerRef.current;
    const current = layoutRef.current;
    if (!element || !current || current.tops.length === 0) return;
    const index = Math.min(current.tops.length - 1, Math.max(0, page));
    const y = (current.tops[index] ?? 0) + offset * (current.heights[index] ?? 0);
    if (y >= element.scrollTop + element.clientHeight * 0.14 && y <= element.scrollTop + element.clientHeight * 0.86) return;
    element.scrollTop = Math.max(0, y - element.clientHeight * 0.35);
  }, []);
  const find = usePdfFind({ projectId, fileName: file.name, pdf: opened?.pdf ?? null, currentPage: () => currentRef.current, reveal });
  const findOpen = find.open;
  const setFindOpen = find.setOpen;

  const openFind = useCallback(() => {
    focusFind.current = true;
    setFindOpen(true);
    // Already open: the effect below does not run again, so take the focus here.
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [setFindOpen]);
  const closeFind = useCallback(() => {
    setFindOpen(false);
    scrollerRef.current?.focus({ preventScroll: true });
  }, [setFindOpen]);
  useEffect(() => {
    // Only when the reader opened it: a find field restored with the tab must not take the focus.
    if (!findOpen || !focusFind.current) return;
    focusFind.current = false;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Arrows, Page Up / Down, Home, End and Space scroll by themselves: the ground has the focus.
    if (event.key === 'Escape' && findOpen) {
      event.preventDefault();
      closeFind();
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey || scale === null) return;
    const key = event.key.toLowerCase();
    if (key === '=' || key === '+') zoomTo(nextZoomStep(scale, 1, PDF_MIN_ZOOM, PDF_MAX_ZOOM));
    else if (key === '-' || key === '_') zoomTo(nextZoomStep(scale, -1, PDF_MIN_ZOOM, PDF_MAX_ZOOM));
    else if (key === '0') zoomTo('width');
    else if (key === 'f') openFind();
    else if (key === 'g' && findOpen) find.step(event.shiftKey ? -1 : 1);
    else return;
    event.preventDefault();
  };

  // Copied text is the text the reader sees: a font's radical twins (U+2F1D filed where the page
  // shows the character U+53E3) are put right, so a sentence copied from a PDF pastes as ordinary
  // characters. Nothing else in the text is touched.
  const onCopy = (event: ReactClipboardEvent<HTMLDivElement>): void => {
    const text = document.getSelection()?.toString() ?? '';
    const unified = unifyCjkRadicals(text);
    if (!text || unified === text) return;
    event.clipboardData.setData('text/plain', unified);
    event.preventDefault();
  };

  // ── drawing order and kept bitmaps ────────────────────────────────────────────────────────────
  const [queue] = useState(() => createPdfRenderQueue());
  const [bitmaps] = useState(() => createPdfBitmapKeeper(fileKey, () => currentRef.current));
  useEffect(() => bitmaps.attach(), [bitmaps]);
  useEffect(() => queue.setPaused(!active), [queue, active]);

  const distance = useCallback((index: number): number => {
    const element = scrollerRef.current;
    const current = layoutRef.current;
    return element && current ? pdfPageDistance(current, index, element.scrollTop, element.clientHeight) : index;
  }, []);

  // ── links ─────────────────────────────────────────────────────────────────────────────────────
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [hint, setHint] = useState<{ x: number; y: number; text: string; show: boolean } | null>(null);
  const hintTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
  }, []);

  const onInternalLink = useCallback((target: PdfLinkTarget) => jumpTo(target.page, target.offset), [jumpTo]);
  const onExternalLink = useCallback(
    (url: string, at: { x: number; y: number }) => {
      // Never followed: the address goes to the clipboard and the reader decides where to open it.
      void copyText(url).then((copied) => {
        const stage = stageRef.current;
        if (!copied || !stage) return;
        const rect = stage.getBoundingClientRect();
        setHint({ x: Math.min(rect.width - 12, Math.max(12, at.x - rect.left)), y: Math.max(36, at.y - rect.top), text: t('artifact.pdf.linkCopied'), show: true });
        if (hintTimer.current !== null) window.clearTimeout(hintTimer.current);
        hintTimer.current = window.setTimeout(() => setHint((previous) => (previous ? { ...previous, show: false } : previous)), HINT_MS);
      });
    },
    [t],
  );

  // ── password ──────────────────────────────────────────────────────────────────────────────────
  const [password, setPassword] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const locked = lock !== null && lock.data === data;
  useEffect(() => {
    // A new request (the first one, or "wrong password") gives the field back to the reader.
    setUnlocking(false);
    if (lock?.wrong) setPassword('');
  }, [lock]);

  const submitPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!lock || !password || unlocking) return;
    setUnlocking(true);
    lock.submit(password);
  };

  // ── bar ───────────────────────────────────────────────────────────────────────────────────────
  const retry = useCallback(() => {
    setFailure(null);
    setAttempt((value) => value + 1);
  }, []);

  const menu = useMemo<ArtifactMenuEntry[]>(
    () => [
      { id: 'fit-page', label: t('artifact.pdf.fitPage'), icon: Maximize, onSelect: () => zoomTo('page'), disabled: !layout },
      ...fileActions.menu,
    ],
    [fileActions.menu, layout, t, zoomTo],
  );

  const actions = useMemo<ArtifactAction[]>(
    () => [
      {
        id: 'find',
        label: t('artifact.pdf.find'),
        icon: Search,
        shortcut: 'mod+f',
        on: findOpen,
        disabled: !opened,
        onSelect: () => (findOpen ? closeFind() : openFind()),
      },
      fileActions.download,
    ],
    [closeFind, fileActions.download, findOpen, openFind, opened, t],
  );

  const facts = [
    pageCount > 0 ? (pageCount === 1 ? t('artifact.pdf.pageCountOne') : t('artifact.pdf.pageCount', { count: pageCount })) : null,
    formatBytes(file.size),
  ].filter(Boolean);

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const notice = (icon: LucideIcon, title: string, description: string, retryable: boolean): ArtifactShellState => ({
    kind: 'notice',
    icon,
    title,
    description,
    ...(retryable
      ? { action: { label: t('fileViewer.reload'), onSelect: retry }, secondaryAction: { label: t('fileViewer.download'), onSelect: fileActions.downloadFile } }
      : {}),
  });

  let state: ArtifactShellState | null = null;
  // A newer version that cannot be read (the agent is still writing it, or it was cut short) does
  // not take the pages away: the last version that opened stays until one opens again.
  const problem = failure && failure.data === data && opened === null ? failure.kind : null;
  if (bytes.source.status === 'too-large' || bytes.source.status === 'failed') {
    state = fileActions.sourceState(bytes.source, bytes.reload);
  } else if (problem === 'damaged') {
    state = fileActions.unsupported(t('artifact.pdf.damaged'), t('artifact.pdf.damagedHint'), FileWarning);
  } else if (problem === 'empty') {
    state = notice(File, t('artifact.pdf.empty'), t('artifact.pdf.emptyHint'), false);
  } else if (problem === 'slow') {
    state = notice(FileWarning, t('artifact.pdf.slow'), t('artifact.pdf.slowHint'), true);
  } else if (problem === 'unavailable') {
    state = notice(FileWarning, t('artifact.pdf.unavailable'), t('artifact.pdf.unavailableHint'), true);
  } else if (!locked && !showsPages) {
    // Nothing to show yet: quiet at first, then "loading" for the bytes or "opening" for the parse.
    state =
      bytes.source.status === 'ready'
        ? slowOpen
          ? { kind: 'loading', label: t('artifact.pdf.opening') }
          : { kind: 'loading', quiet: true }
        : fileActions.sourceState(bytes.source, bytes.reload);
  }

  // Before the first scroll position has been read, the window is the one around the saved place,
  // so the ground already has its full height when that place is restored.
  const shown =
    pageWindow.last >= pageWindow.first || !layout || !viewport
      ? pageWindow
      : pdfPageWindow(layout, positionRef.current ? pdfAnchorTop(layout, positionRef.current) : 0, viewport.height);
  const first = Math.max(0, Math.min(shown.first, pageCount - 1));
  const last = Math.min(shown.last, pageCount - 1);
  const mounted = layout && last >= first ? Array.from({ length: last - first + 1 }, (_, offset) => first + offset) : [];

  return (
    <ArtifactShell
      viewer="pdf"
      path={file.name}
      stage="canvas"
      controls={
        showsPages && !locked && state === null ? (
          <>
            <ArtifactPager page={currentPage + 1} count={pageCount} onPage={(page) => jumpTo(page - 1)} label={t('artifact.pdf.pages')} />
            <ArtifactZoom
              zoom={scale}
              min={PDF_MIN_ZOOM}
              max={PDF_MAX_ZOOM}
              presets={[0.5, 1, 1.5, 2]}
              onZoom={(next) => zoomTo(next)}
              onFit={() => zoomTo('width')}
              fitLabel={t('artifact.pdf.fitWidth')}
            />
          </>
        ) : null
      }
      meta={facts.join(' · ')}
      actions={showsPages && !locked && state === null ? actions : [fileActions.download]}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      {locked ? (
        <div className={styles.lock} data-pdf-locked="">
          <span className={styles.lockGlyph}>
            <Lock aria-hidden="true" size={22} strokeWidth={1.5} />
          </span>
          <p className={styles.lockTitle}>{t('artifact.pdf.locked')}</p>
          <p className={styles.lockText}>{t('artifact.pdf.lockedHint')}</p>
          <form className={styles.lockForm} onSubmit={submitPassword}>
            <Input
              className={styles.lockField}
              type="password"
              autoComplete="off"
              value={password}
              aria-label={t('artifact.pdf.password')}
              placeholder={t('artifact.pdf.password')}
              aria-invalid={lock.wrong && password === '' ? true : undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button type="submit" size="md" variant="primary" disabled={password === ''} loading={unlocking}>
              {t('artifact.pdf.unlock')}
            </Button>
          </form>
          <p className={styles.lockError} role="status">
            {lock.wrong && !unlocking ? t('artifact.pdf.wrongPassword') : ''}
          </p>
        </div>
      ) : showsPages ? (
        <div ref={stageRef} className={styles.stage} onKeyDown={onKeyDown}>
          <div
            ref={setScroller}
            className={cn(sheets.scroller, styles.scroller)}
            tabIndex={0}
            role="region"
            aria-label={file.name}
            data-pdf-scroller=""
            onScroll={syncScroll}
            onCopy={onCopy}
          >
            {layout && first > 0 ? (
              <div className={styles.spacer} style={{ width: layout.width, height: Math.max(0, (layout.tops[first] ?? 0) - layout.pad - layout.gap) }} aria-hidden="true" />
            ) : null}
            {layout
              ? mounted.map((index) => (
                  <PdfPage
                    key={index}
                    pdf={opened?.pdf ?? null}
                    pdfjs={opened?.pdfjs ?? null}
                    index={index}
                    width={layout.widths[index] ?? 1}
                    height={layout.heights[index] ?? 1}
                    pixelRatio={pixelRatio}
                    active={active}
                    queue={queue}
                    distance={distance}
                    bitmaps={bitmaps}
                    onSize={onPageSize}
                    onInternalLink={onInternalLink}
                    onExternalLink={onExternalLink}
                    onTextLayer={find.onTextLayer}
                  />
                ))
              : null}
            {layout && last >= first && last < pageCount - 1 ? (
              <div
                className={styles.spacer}
                style={{
                  width: layout.width,
                  height: Math.max(0, layout.height - layout.pad - ((layout.tops[last] ?? 0) + (layout.heights[last] ?? 0)) - layout.gap),
                }}
                aria-hidden="true"
              />
            ) : null}
          </div>
          <PdfFindBar ref={findInputRef} find={find} onClose={closeFind} />
          <div
            className={styles.hint}
            style={hint ? { left: hint.x, top: hint.y } : undefined}
            data-show={hint?.show ? '' : undefined}
            role="status"
            aria-live="polite"
          >
            {hint?.text ?? ''}
          </div>
        </div>
      ) : null}
    </ArtifactShell>
  );
}

/** Keyed by file, so each document has its own instance and never inherits another one's pages. */
export default function PdfViewer(props: ArtifactViewerProps): JSX.Element {
  return <PdfDocumentView key={`${props.projectId}\n${props.file.name}`} {...props} />;
}
