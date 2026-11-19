// SPDX-License-Identifier: AGPL-3.0-only
// Presentations. A PowerPoint deck opens as one vertical run of slides on the sheet ground, fitted
// so a whole slide shows; the bar steps through slides, zooms, and has the one action a deck is
// for: presenting it. A second view, the outline, gives every slide's words as real text.
// The file is parsed and drawn in a worker (`slides/deck.worker.ts`) with a size cap and time
// limits; each slide arrives as an SVG document and is only ever shown through an `<img>`.
// An OpenDocument presentation gets the outline alone; the older formats get the file card with a
// reason and a way forward.
'use client';

import { Copy, FileWarning, Maximize, Play, Presentation, StickyNote, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useT } from '../../../i18n';
import { copyText } from '../../board/interaction/file-actions';
import { ArtifactPager } from '../shell/ArtifactPager';
import { ArtifactShell, type ArtifactAction, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { ArtifactZoom, nextZoomStep } from '../shell/ArtifactZoom';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { formatBytes, useArtifactBytes } from '../use-artifact-source';
import { useArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { Outline, type OutlineHandle } from './slides/Outline';
import { outlineToText } from './slides/deck-outline';
import { Presenter } from './slides/Presenter';
import type { DeckFailure, DeckInfo, DeckKind } from './slides/protocol';
import { SLIDE_ZOOM_MAX, SLIDE_ZOOM_MIN, aspectLabel } from './slides/slide-layout';
import { SlideRun, type SlideRunHandle } from './slides/SlideRun';
import { useDeck } from './slides/use-deck';
import { FileCard } from './UnknownViewer';

/** Larger decks are not fetched; the frame says so and offers the download. */
const MAX_BYTES = 50 * 1024 * 1024;
/** Opening that outlasts the fetch's own grace period by this much gets a labelled spinner. */
const SLOW_OPEN_MS = 300;
/**
 * The bar gives way as the panel narrows, the least needed first: the facts, then the zoom control
 * (its three commands move into the overflow menu), then the label of "Present".
 */
const ZOOM_MIN_WIDTH = 720;
const LABEL_MIN_WIDTH = 520;
/** A deck's bar carries more controls than most; the frame would clip the facts before it drops them. */
const FACTS_MIN_WIDTH = 900;

type DeckView = 'slides' | 'outline';

/** Width of the viewer's frame, found from an element inside it. null until measured. */
function useFrameWidth(probe: RefObject<HTMLElement>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const frame = probe.current?.closest('[data-artifact-viewer]');
    if (!frame || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setWidth(frame.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [probe]);
  return width;
}

/** True once `pending` has lasted `delay` ms. */
function useLasting(pending: boolean, delay: number): boolean {
  const [lasting, setLasting] = useState(false);
  useEffect(() => {
    if (!pending) {
      setLasting(false);
      return;
    }
    const timer = window.setTimeout(() => setLasting(true), delay);
    return () => window.clearTimeout(timer);
  }, [pending, delay]);
  return pending && lasting;
}

function DeckViewer(props: ArtifactViewerProps & { kind: DeckKind }): JSX.Element {
  const { projectId, file, active, kind } = props;
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);

  // ── the deck ──────────────────────────────────────────────────────────────────────────────────
  const bytes = useArtifactBytes(projectId, file, { maxBytes: MAX_BYTES, enabled: active });
  const session = useDeck(kind, bytes.source.status === 'ready' ? bytes.source.data : null);
  // The structure of the deck as last opened. It outlives the viewer, so coming back to the tab
  // shows the slides' places at once and the pictures fill in; a newer version replaces it.
  const [remembered, setRemembered] = useArtifactViewState<DeckInfo | null>(projectId, file.name, 'slides.deck', null);
  useEffect(() => {
    if (session.deck) setRemembered(session.deck);
    else if (session.failure) setRemembered(null);
  }, [session.deck, session.failure, setRemembered]);
  const deck = session.deck ?? (session.failure ? null : remembered);
  const count = deck?.slides.length ?? 0;
  const drawable = deck?.drawable ?? kind === 'pptx';

  // ── what the reader set ───────────────────────────────────────────────────────────────────────
  const [mode, setMode] = useArtifactViewState<DeckView>(projectId, file.name, 'slides.mode', 'slides');
  /** null = fit one whole slide in the window. */
  const [zoom, setZoom] = useArtifactViewState<number | null>(projectId, file.name, 'slides.zoom', null);
  /** The current slide, 0-based; shared by the run, the outline and the presentation. */
  const [storedPage, setPage] = useArtifactViewState<number>(projectId, file.name, 'slides.page', 0);
  const [showNotes, setShowNotes] = useArtifactViewState<boolean>(projectId, file.name, 'slides.notes', false);
  const page = Math.min(Math.max(0, count - 1), Math.max(0, storedPage));
  const view: DeckView = drawable ? mode : 'outline';
  const [scale, setScale] = useState<number | null>(null);

  const runRef = useRef<SlideRunHandle | null>(null);
  const outlineRef = useRef<OutlineHandle | null>(null);
  const goTo = useCallback(
    (index: number) => {
      setPage(index);
      runRef.current?.scrollToSlide(index);
      outlineRef.current?.scrollToSlide(index);
    },
    [setPage],
  );

  // ── which slides to draw ──────────────────────────────────────────────────────────────────────
  // The run and the presentation each say what they need; the presentation's slide comes first.
  const runWantRef = useRef<readonly number[]>([]);
  const presentWantRef = useRef<readonly number[]>([]);
  const sessionWant = session.want;
  const wantRun = useCallback(
    (indices: readonly number[]) => {
      runWantRef.current = indices;
      sessionWant([...presentWantRef.current, ...indices]);
    },
    [sessionWant],
  );
  const wantPresent = useCallback(
    (indices: readonly number[]) => {
      presentWantRef.current = indices;
      sessionWant([...indices, ...runWantRef.current]);
    },
    [sessionWant],
  );

  // ── presenting ────────────────────────────────────────────────────────────────────────────────
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const frameWidth = useFrameWidth(probeRef);
  const [presenting, setPresenting] = useState<{ start: number; host: HTMLElement } | null>(null);
  const present = useCallback(() => {
    const host = probeRef.current?.closest<HTMLElement>('[data-artifact-viewer]');
    if (host) setPresenting({ start: page, host });
  }, [page]);
  const endPresenting = useCallback(
    (index: number) => {
      presentWantRef.current = [];
      setPresenting(null);
      goTo(index);
    },
    [goTo],
  );
  // A tab that is no longer in front does not keep the screen.
  useEffect(() => {
    if (!active) setPresenting(null);
  }, [active]);

  // ── actions ───────────────────────────────────────────────────────────────────────────────────
  const [copied, setCopied] = useState(false);
  const copyOutline = useCallback(async () => {
    if (!deck) return;
    const done = await copyText(
      outlineToText(deck.slides, { notes: t('artifact.slides.notes'), chart: t('artifact.slides.chart'), untitled: t('artifact.slides.untitled') }),
    );
    if (!done) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [deck, t]);

  const hasNotes = useMemo(() => deck?.slides.some((slide) => slide.notes) ?? false, [deck]);
  const roomForZoom = frameWidth === null || frameWidth >= ZOOM_MIN_WIDTH;
  const menu = useMemo<ArtifactMenuEntry[]>(() => {
    const entries: ArtifactMenuEntry[] = [];
    if (view === 'slides' && !roomForZoom && scale !== null) {
      // The zoom control has no room in the bar: its commands live here instead.
      entries.push(
        { id: 'zoom-in', label: t('fantayShell.workspace.zoomIn'), icon: ZoomIn, onSelect: () => setZoom(nextZoomStep(scale, 1, SLIDE_ZOOM_MIN, SLIDE_ZOOM_MAX)), disabled: scale >= SLIDE_ZOOM_MAX },
        { id: 'zoom-out', label: t('fantayShell.workspace.zoomOut'), icon: ZoomOut, onSelect: () => setZoom(nextZoomStep(scale, -1, SLIDE_ZOOM_MIN, SLIDE_ZOOM_MAX)), disabled: scale <= SLIDE_ZOOM_MIN },
        { id: 'zoom-fit', label: t('artifact.zoom.fit'), icon: Maximize, onSelect: () => setZoom(null), disabled: zoom === null },
      );
    }
    entries.push({
      id: 'copy-outline',
      label: copied ? t('fileViewer.copied') : t('artifact.slides.copyOutline'),
      icon: Copy,
      onSelect: () => void copyOutline(),
      disabled: !deck,
      separated: entries.length > 0,
    });
    if (drawable && hasNotes && view === 'slides') {
      entries.push({
        id: 'notes',
        label: showNotes ? t('artifact.slides.hideNotes') : t('artifact.slides.showNotes'),
        icon: StickyNote,
        onSelect: () => setShowNotes((previous) => !previous),
      });
    }
    return [...entries, fileActions.reloadEntry(bytes.reload), ...fileActions.menu];
  }, [bytes.reload, copied, copyOutline, deck, drawable, fileActions, hasNotes, roomForZoom, scale, setShowNotes, setZoom, showNotes, t, view, zoom]);

  const actions = useMemo<ArtifactAction[]>(
    () => [
      ...(drawable
        ? [
            {
              id: 'present',
              label: t('artifact.slides.present'),
              icon: Play,
              onSelect: present,
              disabled: !session.deck,
              emphasis: frameWidth !== null && frameWidth < LABEL_MIN_WIDTH ? ('icon' as const) : ('label' as const),
            },
          ]
        : []),
      fileActions.download,
    ],
    [drawable, fileActions.download, frameWidth, present, session.deck, t],
  );

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const slowOpening = useLasting(session.opening && !deck, SLOW_OPEN_MS);
  const failed = (failure: DeckFailure): ArtifactShellState => {
    if (failure === 'empty') return fileActions.unsupported(t('artifact.slides.empty'), undefined, Presentation);
    if (failure === 'timeout') return fileActions.unsupported(t('artifact.slides.slow'), t('artifact.slides.slowHint'));
    if (failure === 'too-large') return fileActions.unsupported(t('artifact.state.tooLarge'), t('artifact.slides.slowHint'));
    if (failure === 'worker') {
      // The engine itself did not start: trying again is the way out.
      return {
        kind: 'notice',
        icon: FileWarning,
        title: t('workspace.code.loadFailed'),
        action: { label: t('fileViewer.reload'), onSelect: bytes.reload },
        secondaryAction: { label: t('fileViewer.download'), onSelect: fileActions.downloadFile },
      };
    }
    return fileActions.unsupported(t('artifact.slides.invalid'), t('artifact.slides.invalidHint'));
  };

  const sourceState = fileActions.sourceState(bytes.source, bytes.reload);
  let state: ArtifactShellState | null = null;
  if (session.failure) state = failed(session.failure);
  else if (sourceState?.kind === 'notice') state = sourceState;
  else if (!deck) state = sourceState ?? (slowOpening ? { kind: 'loading', label: t('artifact.slides.opening') } : { kind: 'loading', quiet: true });

  // An OpenDocument file whose text cannot be read is one more format without a preview.
  if (kind === 'odp' && session.failure && session.failure !== 'worker') {
    return <FileCard {...props} reason={t('artifact.slides.legacyOdp')} />;
  }

  const facts = [deck ? t('artifact.slides.count', { count }) : null, deck ? aspectLabel(deck.width, deck.height) : null, formatBytes(file.size)].filter(Boolean);

  return (
    <ArtifactShell
      viewer="slides"
      path={file.name}
      stage={view === 'outline' ? 'page' : 'fill'}
      modes={
        drawable
          ? [
              { id: 'slides', label: t('artifact.slides.viewSlides') },
              { id: 'outline', label: t('artifact.slides.viewOutline') },
            ]
          : undefined
      }
      mode={view}
      modesLabel={t('artifact.viewMode')}
      onModeChange={(next) => setMode(next === 'outline' ? 'outline' : 'slides')}
      controls={
        <>
          <span ref={probeRef} hidden />
          <ArtifactPager
            page={page + 1}
            count={count}
            onPage={(next) => goTo(next - 1)}
            label={t('artifact.slides.viewSlides')}
            previousLabel={t('artifact.slides.previous')}
            nextLabel={t('artifact.slides.next')}
          />
          {view === 'slides' && roomForZoom ? (
            <ArtifactZoom zoom={deck ? scale : null} min={SLIDE_ZOOM_MIN} max={SLIDE_ZOOM_MAX} presets={[0.5, 1, 2]} onZoom={setZoom} onFit={() => setZoom(null)} />
          ) : null}
        </>
      }
      meta={frameWidth === null || frameWidth >= FACTS_MIN_WIDTH ? facts.join(' · ') : undefined}
      actions={actions}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
    >
      {deck ? (
        view === 'outline' ? (
          <Outline
            ref={outlineRef}
            projectId={projectId}
            fileName={file.name}
            deck={deck}
            page={page}
            onPage={setPage}
            lead={deck.drawable ? undefined : t('artifact.slides.textOnly')}
          />
        ) : (
          <SlideRun
            ref={runRef}
            projectId={projectId}
            fileName={file.name}
            deck={deck}
            slides={session.slides}
            zoom={zoom}
            onZoom={setZoom}
            onScale={setScale}
            page={page}
            onPage={setPage}
            showNotes={showNotes}
            want={wantRun}
          />
        )
      ) : null}
      {presenting && session.deck ? (
        <Presenter
          host={presenting.host}
          deck={session.deck}
          slides={session.slides}
          start={presenting.start}
          name={file.name.split('/').pop() ?? file.name}
          want={wantPresent}
          onExit={endPresenting}
        />
      ) : null}
    </ArtifactShell>
  );
}

export default function SlidesViewer(props: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const { family, projectId, file } = props;
  // One viewer per file: a tab that is handed another deck starts from that deck's own state.
  const key = `${projectId}\n${file.name}`;
  if (family.format === 'pptx') return <DeckViewer key={key} {...props} kind="pptx" />;
  if (family.extension === 'odp') return <DeckViewer key={key} {...props} kind="odp" />;
  const reason =
    family.extension === 'key' ? t('artifact.slides.legacyKey') : family.extension === 'dps' ? t('artifact.slides.legacyDps') : t('artifact.slides.legacyPpt');
  return <FileCard {...props} reason={reason} />;
}
