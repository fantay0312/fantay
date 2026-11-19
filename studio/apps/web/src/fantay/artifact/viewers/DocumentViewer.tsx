// SPDX-License-Identifier: AGPL-3.0-only
// Word-processing documents. Three kinds, told apart by `family.format`:
//  - docx (also .docm, .dotx): the document's own pages, as white sheets on the canvas ground. It
//    opens fitted to the panel's width and never above 100%; pinch, ⌘-scroll and + / − zoom.
//  - rtf, odt: no pages of their own, so they are read into text and shown as a reading column on
//    the interface paper, with a text size instead of a zoom.
//  - legacy (.doc, .dot, .pages, .wps): nothing here can draw them faithfully, so the file card
//    says which format it is and what to do with it.
// Everything made from the file's content is drawn in a frame that cannot run script
// (`parts/SandboxFrame.tsx`). A new version of the file replaces the old render in one step and the
// reader stays where they were; zoom and place are kept per file.
'use client';

import { Lock, TimerOff } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../../i18n';
import type { Dict } from '../../../i18n/types';
import { ArtifactShell, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { ArtifactZoom, nextZoomStep } from '../shell/ArtifactZoom';
import { useArtifactFileActions, type ArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, formatBytes, useArtifactBytes } from '../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import {
  DOCX_RENDER_OPTIONS,
  DOCX_RENDER_TIMEOUT_MS,
  MAX_DOCX_BYTES,
  applyInlineFontFallbacks,
  applySheetFontFallbacks,
  hardenRendered,
  inspectDocx,
  wrapSheets,
  type DocxProblem,
} from './document/docx';
import { READING_FRAME_CSS, SHEETS_FRAME_CSS } from './document/frame-css';
import {
  applyScrollShare,
  applySheetAnchor,
  fitWidthZoom,
  readScrollShare,
  readSheetAnchor,
  type FramePoint,
  type SheetAnchor,
} from './document/frame-view';
import { MAX_ODT_BYTES } from './document/odt';
import { readDocument, type DocumentReadOutcome } from './document/read-document';
import { MAX_RTF_BYTES } from './document/rtf';
import { sanitizeConverted } from './document/sanitize';
import { SandboxFrame } from './parts/SandboxFrame';
import { FileCard } from './UnknownViewer';

type Translate = ReturnType<typeof useT>;

const MIN_PAGE_ZOOM = 0.25;
const MAX_PAGE_ZOOM = 4;
const MIN_TEXT_ZOOM = 0.67;
const MAX_TEXT_ZOOM = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** True once `pending` has lasted longer than the grace period: only then is a wait worth a word. */
function useSlow(pending: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), ARTIFACT_SLOW_LOAD_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);
  return pending && slow;
}

function withTimeout<T>(work: Promise<T>, limit: number): Promise<T | 'timeout'> {
  return new Promise<T | 'timeout'>((resolve, reject) => {
    const timer = window.setTimeout(() => resolve('timeout'), limit);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        window.clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error('render'));
      },
    );
  });
}

/** `+`, `-` and `0` on the stage, the same keys as the image viewer. Returns the claimed step. */
function zoomKey(event: KeyboardEvent): 'in' | 'out' | 'reset' | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === '+' || event.key === '=') return 'in';
  if (event.key === '-' || event.key === '_') return 'out';
  if (event.key === '0') return 'reset';
  return null;
}

function useDocumentMenu(fileActions: ArtifactFileActions, reload: () => void): ArtifactMenuEntry[] {
  return useMemo(() => [...fileActions.menu, fileActions.reloadEntry(reload)], [fileActions, reload]);
}

// ── Word documents ────────────────────────────────────────────────────────────────────────────────

type WordFailure = DocxProblem | 'failed' | 'timeout';

interface WordRender {
  /** The bytes this render was made from. */
  data: ArrayBuffer;
  styles: HTMLStyleElement[];
  wrapper: HTMLElement;
  /** The page count Word saved with the file; null when the file does not say. */
  pages: number | null;
}

function wordFailureState(kind: WordFailure, fileActions: ArtifactFileActions, t: Translate): ArtifactShellState {
  if (kind === 'encrypted') return fileActions.unsupported(t('artifact.document.encrypted'), t('artifact.document.encryptedHint'), Lock);
  if (kind === 'legacy') return fileActions.unsupported(t('artifact.document.legacyTitle'), t('artifact.document.legacyDoc'));
  if (kind === 'not-word') return fileActions.unsupported(t('artifact.document.notWord'), t('artifact.document.notValidHint'));
  if (kind === 'too-complex') return fileActions.unsupported(t('artifact.document.tooComplex'), t('artifact.document.tooComplexHint'));
  if (kind === 'timeout') return fileActions.unsupported(t('artifact.document.timeout'), t('artifact.document.tooComplexHint'), TimerOff);
  return fileActions.unsupported(t('artifact.document.failed'), t('artifact.document.failedHint'));
}

function WordDocument({ projectId, file, family, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: MAX_DOCX_BYTES });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;
  const menu = useDocumentMenu(fileActions, bytes.reload);

  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const [render, setRender] = useState<WordRender | null>(null);
  const [failure, setFailure] = useState<{ data: ArrayBuffer; kind: WordFailure } | null>(null);

  // ── lay the document out ──────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!frameDocument || !data) return;
    let current = true;
    const run = async (): Promise<void> => {
      const inspection = inspectDocx(new Uint8Array(data));
      if (!inspection.ok) {
        if (current) setFailure({ data, kind: inspection.problem });
        return;
      }
      const { renderAsync } = await import('docx-preview');
      // Built detached, in the frame's own document: nothing shows until the whole render is done.
      const body = frameDocument.createElement('div');
      const styleHost = frameDocument.createElement('div');
      const outcome = await withTimeout(renderAsync(data, body, styleHost, DOCX_RENDER_OPTIONS), DOCX_RENDER_TIMEOUT_MS);
      if (!current) return;
      if (outcome === 'timeout') {
        setFailure({ data, kind: 'timeout' });
        return;
      }
      hardenRendered(body);
      applyInlineFontFallbacks(body);
      const sheets = wrapSheets(body, frameDocument);
      const wrapper = body.querySelector<HTMLElement>('.docx-wrapper');
      if (!wrapper || sheets.length === 0) {
        setFailure({ data, kind: 'failed' });
        return;
      }
      setRender({ data, styles: Array.from(styleHost.querySelectorAll('style')), wrapper, pages: inspection.pages });
    };
    run().catch(() => {
      if (current) setFailure({ data, kind: 'failed' });
    });
    return () => {
      current = false;
    };
  }, [frameDocument, data]);

  // ── zoom ──────────────────────────────────────────────────────────────────────────────────────
  /** null = fit the panel's width; a number = that zoom, kept across resizes, tab switches and updates. */
  const [zoom, setZoom] = useArtifactViewState<number | null>(projectId, file.name, 'zoom', null);
  const [fit, setFit] = useState<number | null>(null);
  const scale = zoom ?? fit;
  /** What the frame is drawn at, and the facts needed to change it without a render. */
  const view = useRef({ applied: 1, pageWidth: 0, scale: 1 as number | null, placed: null as WordRender | null, live: false });
  view.current.scale = scale;
  /** Where the pointer was when a pinch changed the zoom, so that point stays under it. */
  const pointerRef = useRef<FramePoint | null>(null);

  const measureFit = useCallback((): number | null => {
    if (!frameDocument || view.current.pageWidth <= 0) return null;
    const wrapper = frameDocument.querySelector('.docx-wrapper');
    const window = frameDocument.defaultView;
    const margin = wrapper && window ? Number.parseFloat(window.getComputedStyle(wrapper).paddingLeft) || 0 : 0;
    return fitWidthZoom(view.current.pageWidth, frameDocument.documentElement.clientWidth, margin, MIN_PAGE_ZOOM);
  }, [frameDocument]);

  /** Draws at `next`, keeping the document point under `point` (default: the top of the window). */
  const applyScale = useCallback(
    (next: number, point?: FramePoint) => {
      if (!frameDocument || Math.abs(next - view.current.applied) < 1e-4) return;
      const anchor = readSheetAnchor(frameDocument, point);
      frameDocument.documentElement.style.setProperty('--zoom', String(next));
      view.current.applied = next;
      if (anchor) applySheetAnchor(frameDocument, anchor, point);
    },
    [frameDocument],
  );

  // A new render goes into the frame in one step, in the same frame as it becomes visible: styles,
  // pages, the widest page's width, the zoom, then the reader's place.
  useLayoutEffect(() => {
    if (!frameDocument || !render || view.current.placed === render) return;
    const first = view.current.placed === null;
    const place: SheetAnchor | null = first
      ? (readArtifactViewState<SheetAnchor>(projectId, file.name, 'scroll') ?? null)
      : readSheetAnchor(frameDocument);
    view.current.live = false;

    for (const stale of Array.from(frameDocument.head.querySelectorAll('style[data-docx]'))) stale.remove();
    for (const style of render.styles) {
      style.setAttribute('data-docx', '');
      frameDocument.head.append(style);
    }
    applySheetFontFallbacks(frameDocument.head);
    if (first) render.wrapper.setAttribute('data-enter', '');
    frameDocument.body.replaceChildren(render.wrapper);
    view.current.placed = render;

    // Page widths are read at 100%, then the zoom is put back before anything is painted.
    const root = frameDocument.documentElement;
    root.style.setProperty('--zoom', '1');
    let widest = 0;
    for (const page of Array.from(frameDocument.querySelectorAll('section.docx'))) widest = Math.max(widest, page.getBoundingClientRect().width);
    view.current.pageWidth = widest;
    const nextFit = measureFit();
    const next = zoom ?? nextFit ?? 1;
    root.style.setProperty('--zoom', String(next));
    view.current.applied = next;
    setFit(nextFit);
    if (place) applySheetAnchor(frameDocument, place);
    view.current.live = true;
    // `zoom` is read once per render; later changes go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameDocument, render, measureFit, projectId, file.name]);

  useLayoutEffect(() => {
    if (scale === null || !view.current.live) return;
    const point = pointerRef.current ?? undefined;
    pointerRef.current = null;
    applyScale(scale, point);
  }, [scale, applyScale]);

  // The panel was resized: "fit" follows it.
  useEffect(() => {
    const frame = frameDocument?.defaultView?.frameElement;
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // A hidden tab has no width: keep the last fit instead of measuring nothing.
      if (view.current.live && frame.clientWidth > 0) setFit(measureFit());
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameDocument, measureFit]);

  const stepZoom = useCallback(
    (direction: 1 | -1) => {
      const from = view.current.scale ?? 1;
      setZoom(nextZoomStep(from, direction, MIN_PAGE_ZOOM, MAX_PAGE_ZOOM));
    },
    [setZoom],
  );

  // ── the frame ─────────────────────────────────────────────────────────────────────────────────
  const fileName = file.name;
  const onReady = useCallback(
    (ready: Document) => {
      setFrameDocument(ready);
      let frameRequest = 0;
      const onScroll = (): void => {
        if (!view.current.live || frameRequest !== 0) return;
        frameRequest = window.requestAnimationFrame(() => {
          frameRequest = 0;
          const anchor = view.current.live ? readSheetAnchor(ready) : null;
          if (anchor) writeArtifactViewState(projectId, fileName, 'scroll', anchor);
        });
      };
      // Pinch and ⌘/Ctrl-scroll zoom. Not passive: the app must not zoom instead.
      const onWheel = (event: WheelEvent): void => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const from = view.current.scale;
        if (from === null || !view.current.live) return;
        pointerRef.current = { x: event.clientX, y: event.clientY };
        setZoom(clamp(from * Math.exp(-event.deltaY * 0.01), MIN_PAGE_ZOOM, MAX_PAGE_ZOOM));
      };
      ready.addEventListener('scroll', onScroll, { passive: true });
      ready.addEventListener('wheel', onWheel, { passive: false });
      return () => {
        window.cancelAnimationFrame(frameRequest);
        ready.removeEventListener('scroll', onScroll);
        ready.removeEventListener('wheel', onWheel);
      };
    },
    [projectId, fileName, setZoom],
  );

  const onFrameKey = useCallback(
    (event: KeyboardEvent) => {
      const key = zoomKey(event);
      if (key === null) return;
      event.preventDefault();
      if (key === 'reset') setZoom(null);
      else stepZoom(key === 'in' ? 1 : -1);
    },
    [setZoom, stepZoom],
  );

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const failed = data !== null && failure?.data === data ? failure.kind : null;
  const laying = data !== null && failed === null && render === null;
  const slow = useSlow(laying);
  let state: ArtifactShellState | null = null;
  if (data === null) state = fileActions.sourceState(bytes.source, bytes.reload);
  else if (failed !== null) state = wordFailureState(failed, fileActions, t);
  else if (laying) state = slow ? { kind: 'loading', label: t('artifact.document.rendering') } : { kind: 'loading', quiet: true };

  const facts = [
    render?.pages ? t('artifact.document.pages', { count: render.pages }) : null,
    family.extension ? family.extension.toUpperCase() : null,
    formatBytes(file.size),
  ].filter(Boolean);

  return (
    <ArtifactShell
      viewer="document"
      path={file.name}
      stage="fill"
      controls={
        <ArtifactZoom
          zoom={render && state === null ? scale : null}
          min={MIN_PAGE_ZOOM}
          max={MAX_PAGE_ZOOM}
          presets={[0.5, 0.75, 1, 1.5, 2]}
          onZoom={(next) => setZoom(clamp(next, MIN_PAGE_ZOOM, MAX_PAGE_ZOOM))}
          onFit={() => setZoom(null)}
          fitLabel={t('artifact.document.fitWidth')}
        />
      }
      meta={facts.join(' · ')}
      actions={[fileActions.download]}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
      keepContentMounted
    >
      <SandboxFrame title={file.name} css={SHEETS_FRAME_CSS} onReady={onReady} onKeyDown={onFrameKey} />
    </ArtifactShell>
  );
}

// ── RTF and OpenDocument: a reading column ────────────────────────────────────────────────────────

type ReadingFormat = 'rtf' | 'odt';
type ReadingFailure = Exclude<DocumentReadOutcome, { ok: true }>['code'];

function readingFailureState(code: ReadingFailure, format: ReadingFormat, fileActions: ArtifactFileActions, t: Translate): ArtifactShellState {
  if (code === 'protected') return fileActions.unsupported(t('artifact.document.encrypted'), t('artifact.document.encryptedHint'), Lock);
  if (code === 'timeout') return fileActions.unsupported(t('artifact.document.timeout'), t('artifact.document.tooComplexHint'), TimerOff);
  if (code === 'too-large') return fileActions.unsupported(t('artifact.document.tooComplex'), t('artifact.document.tooComplexHint'));
  if (code === 'empty') return fileActions.unsupported(t('artifact.document.empty'));
  if (code === 'invalid') {
    return fileActions.unsupported(t(format === 'rtf' ? 'artifact.document.notRtf' : 'artifact.document.notOdt'), t('artifact.document.notValidHint'));
  }
  return fileActions.unsupported(t('artifact.document.failed'), t('artifact.document.failedHint'));
}

function ReadingDocument({ projectId, file, family, active, format }: ArtifactViewerProps & { format: ReadingFormat }): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: format === 'rtf' ? MAX_RTF_BYTES : MAX_ODT_BYTES });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;
  const menu = useDocumentMenu(fileActions, bytes.reload);

  // ── read the file, off the main thread and against the clock ──────────────────────────────────
  const [read, setRead] = useState<{ data: ArrayBuffer; outcome: DocumentReadOutcome } | null>(null);
  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    let current = true;
    void readDocument(format, data, controller.signal).then((outcome) => {
      if (current) setRead({ data, outcome });
    });
    return () => {
      current = false;
      controller.abort();
    };
  }, [data, format]);

  // The last good read stays on screen while a newer version of the file is being read.
  const [good, setGood] = useState<{ data: ArrayBuffer; html: string; pages: number | null } | null>(null);
  if (read?.outcome.ok && good?.data !== read.data) {
    setGood({ data: read.data, html: read.outcome.document.html, pages: read.outcome.document.pages });
  }
  const failed = data !== null && read?.data === data && !read.outcome.ok ? read.outcome.code : null;

  // ── the frame ─────────────────────────────────────────────────────────────────────────────────
  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const [zoom, setZoom] = useArtifactViewState<number>(projectId, file.name, 'zoom', 1);
  const view = useRef({ placed: null as string | null, zoom: 1, live: false });
  const fileName = file.name;

  useLayoutEffect(() => {
    if (!frameDocument || !good) return;
    const root = frameDocument.documentElement;
    if (view.current.placed !== good.html) {
      const first = view.current.placed === null;
      const share = first ? (readArtifactViewState<number>(projectId, fileName, 'scroll') ?? 0) : readScrollShare(frameDocument);
      view.current.live = false;
      const column = frameDocument.createElement('main');
      column.className = 'reading';
      if (first) column.setAttribute('data-enter', '');
      column.append(sanitizeConverted(good.html));
      frameDocument.body.replaceChildren(column);
      view.current.placed = good.html;
      root.style.setProperty('--zoom', String(zoom));
      view.current.zoom = zoom;
      applyScrollShare(frameDocument, share);
      view.current.live = true;
    } else if (view.current.zoom !== zoom) {
      // A new text size reflows the column: keep the reader the same share of the way down.
      const share = readScrollShare(frameDocument);
      root.style.setProperty('--zoom', String(zoom));
      view.current.zoom = zoom;
      applyScrollShare(frameDocument, share);
    }
  }, [frameDocument, good, zoom, projectId, fileName]);

  const onReady = useCallback(
    (ready: Document) => {
      setFrameDocument(ready);
      let frameRequest = 0;
      const onScroll = (): void => {
        if (!view.current.live || frameRequest !== 0) return;
        frameRequest = window.requestAnimationFrame(() => {
          frameRequest = 0;
          if (view.current.live) writeArtifactViewState(projectId, fileName, 'scroll', readScrollShare(ready));
        });
      };
      ready.addEventListener('scroll', onScroll, { passive: true });
      return () => {
        window.cancelAnimationFrame(frameRequest);
        ready.removeEventListener('scroll', onScroll);
      };
    },
    [projectId, fileName],
  );

  const onFrameKey = useCallback(
    (event: KeyboardEvent) => {
      const key = zoomKey(event);
      if (key === null) return;
      event.preventDefault();
      if (key === 'reset') setZoom(1);
      else setZoom((current) => nextZoomStep(current, key === 'in' ? 1 : -1, MIN_TEXT_ZOOM, MAX_TEXT_ZOOM));
    },
    [setZoom],
  );

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const reading = data !== null && failed === null && good === null;
  const slow = useSlow(reading);
  let state: ArtifactShellState | null = null;
  if (data === null) state = fileActions.sourceState(bytes.source, bytes.reload);
  else if (failed !== null) state = readingFailureState(failed, format, fileActions, t);
  else if (reading || !frameDocument) state = slow ? { kind: 'loading', label: t('fileViewer.loading') } : { kind: 'loading', quiet: true };

  const facts = [
    good?.pages ? t('artifact.document.pages', { count: good.pages }) : null,
    family.extension ? family.extension.toUpperCase() : null,
    formatBytes(file.size),
  ].filter(Boolean);

  return (
    <ArtifactShell
      viewer="document"
      path={file.name}
      stage="page"
      controls={
        <ArtifactZoom
          zoom={good && state === null ? zoom : null}
          min={MIN_TEXT_ZOOM}
          max={MAX_TEXT_ZOOM}
          presets={[0.75, 1, 1.25, 1.5]}
          onZoom={(next) => setZoom(clamp(next, MIN_TEXT_ZOOM, MAX_TEXT_ZOOM))}
        />
      }
      meta={facts.join(' · ')}
      actions={[fileActions.download]}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
      keepContentMounted
    >
      <SandboxFrame title={file.name} css={READING_FRAME_CSS} onReady={onReady} onKeyDown={onFrameKey} />
    </ArtifactShell>
  );
}

// ── formats with no renderer ──────────────────────────────────────────────────────────────────────

function legacyReason(extension: string): keyof Dict {
  if (extension === 'pages') return 'artifact.document.legacyPages';
  if (extension === 'wps') return 'artifact.document.legacyWps';
  return 'artifact.document.legacyDoc';
}

export default function DocumentViewer(props: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const format = props.family.format;
  if (format === 'docx') return <WordDocument {...props} />;
  if (format === 'rtf' || format === 'odt') return <ReadingDocument {...props} format={format} />;
  return <FileCard {...props} reason={t(legacyReason(props.family.extension))} />;
}
