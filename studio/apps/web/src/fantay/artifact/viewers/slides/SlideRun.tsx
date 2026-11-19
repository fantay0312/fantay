// SPDX-License-Identifier: AGPL-3.0-only
// The deck as one vertical run of slides on the shared sheet ground. Every slide has its place from
// the first frame (white paper at the deck's proportions); pictures are asked for as slides come
// near the window and dropped from the DOM when they are far away. The reader's place is kept as
// "this slide, this far into it", so a change of zoom or panel width, a tab switch or a newer
// version of the file leaves them where they were.
'use client';

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useT } from '../../../../i18n';
import { cn } from '../../../ui';
import { nextZoomStep } from '../../shell/ArtifactZoom';
import { readArtifactViewState, writeArtifactViewState } from '../../use-view-state';
import sheets from '../parts/Sheets.module.css';
import type { DeckInfo, DeckSlide, UnsupportedCount, UnsupportedKind } from './protocol';
import {
  SLIDE_ZOOM_MAX,
  SLIDE_ZOOM_MIN,
  anchorAt,
  clampSlideZoom,
  drawOrder,
  fitSlideZoom,
  scrollTopFor,
  slideInView,
  type SlideAnchor,
  type SlideBox,
} from './slide-layout';
import styles from './SlideRun.module.css';
import { totalUnsupported } from './slide-svg';
import type { SlideState } from './use-deck';

/** Slides drawn and kept in the DOM on each side of the window. */
const DRAW_MARGIN = 2;
const ANCHOR_SLOT = 'slides.anchor';

/** The reader's place, with the slide it belonged to: a jump made in another view wins over it. */
interface StoredAnchor extends SlideAnchor {
  page: number;
}

function storedAnchor(projectId: string, fileName: string, page: number): SlideAnchor | null {
  const stored = readArtifactViewState<StoredAnchor>(projectId, fileName, ANCHOR_SLOT);
  return stored && stored.page === page ? stored : null;
}

export interface SlideRunHandle {
  /** Brings a slide (0-based) to the top of the window. */
  scrollToSlide(index: number): void;
}

export interface SlideRunProps {
  projectId: string;
  fileName: string;
  deck: DeckInfo;
  slides: ReadonlyMap<number, SlideState>;
  /** null = fit one whole slide in the window. */
  zoom: number | null;
  onZoom(zoom: number | null): void;
  /** Reports the zoom actually drawn, for the bar's control. */
  onScale(scale: number): void;
  /** The current slide, 0-based: where a first visit opens. */
  page: number;
  /** Called when the reader's own scrolling lands on another slide. */
  onPage(index: number): void;
  showNotes: boolean;
  want(indices: readonly number[]): void;
}

const KIND_KEY = {
  image: 'artifact.slides.kindImage',
  chart: 'artifact.slides.kindChart',
  object: 'artifact.slides.kindObject',
  shape: 'artifact.slides.kindShape',
} as const satisfies Record<UnsupportedKind, string>;

interface SlideItemProps {
  index: number;
  slide: DeckSlide;
  state: SlideState | undefined;
  /** In or near the window: its picture is in the DOM. */
  near: boolean;
  width: number;
  height: number;
  showNotes: boolean;
  register(index: number, element: HTMLDivElement | null): void;
}

const SlideItem = memo(function SlideItem({ index, slide, state, near, width, height, showNotes, register }: SlideItemProps): JSX.Element {
  const t = useT();
  const setRef = useCallback((element: HTMLDivElement | null) => register(index, element), [register, index]);
  const picture = state && state !== 'failed' ? state : null;
  /** The address of a picture the browser could not show (an SVG it will not parse). */
  const [broken, setBroken] = useState<string | null>(null);
  const failed = state === 'failed' || (picture !== null && broken === picture.url);
  const unsupported: readonly UnsupportedCount[] = picture?.unsupported ?? [];
  const missing = totalUnsupported(unsupported);
  const name = t('artifact.slides.slideLabel', { index: index + 1 });

  return (
    <div ref={setRef} className={styles.item} style={{ width }} data-slide={index + 1}>
      <div
        className={cn(sheets.sheet, styles.sheet)}
        style={{ width, height }}
        data-pending={picture ? undefined : ''}
        role="img"
        aria-label={slide.title ? `${name} · ${slide.title}` : name}
      >
        {picture && near && !failed ? (
          <img
            className={styles.picture}
            src={picture.url}
            alt=""
            draggable={false}
            decoding="async"
            // Set on the element, not in state: a newer picture of the same slide replaces the old
            // one in place, with no fade and no blank frame in between.
            onLoad={(event) => event.currentTarget.setAttribute('data-ready', '')}
            onError={() => setBroken(picture.url)}
          />
        ) : null}
        {failed ? <p className={styles.failed}>{t('artifact.slides.slideFailed')}</p> : null}
      </div>
      {slide.hidden || missing > 0 || (showNotes && slide.notes) ? (
        <div className={styles.below}>
          {slide.hidden ? <p className={styles.note}>{t('artifact.slides.hidden')}</p> : null}
          {missing > 0 ? (
            <p className={styles.note} data-slide-note="partial">
              {t(missing === 1 ? 'artifact.slides.partialOne' : 'artifact.slides.partial', {
                count: missing,
                kinds: unsupported.map((entry) => t(KIND_KEY[entry.kind])).join(t('artifact.slides.listSeparator')),
              })}
            </p>
          ) : null}
          {showNotes && slide.notes ? (
            <div className={styles.speaker}>
              <span className={styles.speakerLabel}>{t('artifact.slides.notes')}</span>
              <p className={styles.speakerText}>{slide.notes}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export const SlideRun = forwardRef<SlideRunHandle, SlideRunProps>(function SlideRun(
  { projectId, fileName, deck, slides, zoom, onZoom, onScale, page, onPage, showNotes, want },
  ref,
): JSX.Element {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<Array<HTMLDivElement | null>>([]);
  const [stage, setStage] = useState({ width: 0, height: 0, pad: 24 });
  const [range, setRange] = useState({ first: page, last: page });
  /** Where the reader is; null until a first position has been set. */
  const anchorRef = useRef<SlideAnchor | null>(null);
  const restoredRef = useRef(false);
  if (!restoredRef.current) {
    restoredRef.current = true;
    anchorRef.current = storedAnchor(projectId, fileName, page);
  }
  /** The scroll position this component set itself, so its own scrolling is not read as the reader's. */
  const ownScrollRef = useRef<number | null>(null);
  const frameRef = useRef(0);
  const pageRef = useRef(page);
  pageRef.current = page;

  const count = deck.slides.length;
  const fit = fitSlideZoom({ width: deck.width, height: deck.height }, stage, stage.pad);
  const scale = zoom ?? fit;
  const width = Math.max(1, Math.round(deck.width * scale));
  const height = Math.max(1, Math.round(deck.height * scale));
  const measured = stage.width > 0;

  const register = useCallback((index: number, element: HTMLDivElement | null) => {
    itemsRef.current[index] = element;
  }, []);

  const readBoxes = useCallback((): SlideBox[] => {
    const boxes: SlideBox[] = [];
    for (let index = 0; index < count; index += 1) {
      const element = itemsRef.current[index];
      boxes.push(element ? { top: element.offsetTop, height: element.offsetHeight } : { top: 0, height: 0 });
    }
    return boxes;
  }, [count]);

  /** Reads the scroll position: remembers the place, decides what to draw, and reports the slide in view. */
  const sync = useCallback(
    (byReader: boolean) => {
      const element = scrollerRef.current;
      if (!element) return;
      const boxes = readBoxes();
      const top = element.scrollTop;
      const anchor = anchorAt(boxes, top);
      anchorRef.current = anchor;

      const bottom = top + element.clientHeight;
      const first = anchor.index;
      let last = first;
      while (last + 1 < boxes.length && (boxes[last + 1]?.top ?? Infinity) < bottom) last += 1;
      setRange((previous) => (previous.first === first && previous.last === last ? previous : { first, last }));

      const current = byReader ? slideInView(boxes, top, element.clientHeight, element.scrollHeight) : pageRef.current;
      writeArtifactViewState(projectId, fileName, ANCHOR_SLOT, { ...anchor, page: current } satisfies StoredAnchor);
      if (byReader && current !== pageRef.current) {
        pageRef.current = current;
        onPage(current);
      }
      want(drawOrder(first, last, count, DRAW_MARGIN, current));
    },
    [count, fileName, onPage, projectId, readBoxes, want],
  );

  // ── the stage's size ──────────────────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const pad = Number.parseFloat(getComputedStyle(element).paddingLeft) || 0;
      const next = { width: element.clientWidth, height: element.clientHeight, pad };
      setStage((previous) => (previous.width === next.width && previous.height === next.height && previous.pad === next.pad ? previous : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (measured) onScale(scale);
  }, [measured, onScale, scale]);

  // ── keeping the reader's place ────────────────────────────────────────────────────────────────
  // Runs before paint whenever the layout changes (zoom, width, notes shown, another version of
  // the deck): the anchor taken from the old layout is put back in the new one.
  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element || !measured) return;
    const boxes = readBoxes();
    const anchor = anchorRef.current;
    const opening = boxes[Math.min(count - 1, Math.max(0, pageRef.current))];
    element.scrollTop = anchor ? scrollTopFor(anchor, boxes) : Math.max(0, (opening?.top ?? 0) - stage.pad);
    ownScrollRef.current = element.scrollTop;
    sync(false);
  }, [count, height, measured, readBoxes, showNotes, stage.pad, sync, width]);

  const onScroll = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const element = scrollerRef.current;
      if (!element) return;
      const own = ownScrollRef.current !== null && Math.abs(element.scrollTop - ownScrollRef.current) < 1;
      if (!own) ownScrollRef.current = null;
      sync(!own);
    });
  }, [sync]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const scrollToSlide = useCallback(
    (index: number) => {
      const element = scrollerRef.current;
      const box = readBoxes()[Math.min(count - 1, Math.max(0, index))];
      if (!element || !box) return;
      element.scrollTop = Math.max(0, box.top - stage.pad);
      ownScrollRef.current = element.scrollTop;
      pageRef.current = index;
      sync(false);
    },
    [count, readBoxes, stage.pad, sync],
  );

  useImperativeHandle(ref, () => ({ scrollToSlide }), [scrollToSlide]);

  // Pinch and ⌘/Ctrl-scroll zoom. The listener is not passive: the page must not zoom instead.
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onZoom(clampSlideZoom(scale * Math.exp(-event.deltaY * 0.01)));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [onZoom, scale]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Up, down, space and the page keys scroll by themselves; left and right step by slide.
    if (event.key === 'ArrowRight') {
      if (page < count - 1) {
        onPage(page + 1);
        scrollToSlide(page + 1);
      }
    } else if (event.key === 'ArrowLeft') {
      if (page > 0) {
        onPage(page - 1);
        scrollToSlide(page - 1);
      }
    } else if (event.key === '+' || event.key === '=') onZoom(nextZoomStep(scale, 1, SLIDE_ZOOM_MIN, SLIDE_ZOOM_MAX));
    else if (event.key === '-' || event.key === '_') onZoom(nextZoomStep(scale, -1, SLIDE_ZOOM_MIN, SLIDE_ZOOM_MAX));
    else if (event.key === '0') onZoom(null);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={scrollerRef}
      className={cn(sheets.scroller, styles.run)}
      tabIndex={0}
      role="group"
      aria-label={t('artifact.slides.viewSlides')}
      data-slide-run=""
      onScroll={onScroll}
      onKeyDown={onKeyDown}
    >
      {deck.slides.map((slide, index) => (
        <SlideItem
          key={index}
          index={index}
          slide={slide}
          state={slides.get(index)}
          near={index >= range.first - DRAW_MARGIN && index <= range.last + DRAW_MARGIN}
          width={width}
          height={height}
          showNotes={showNotes}
          register={register}
        />
      ))}
    </div>
  );
});
