// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/PdfViewer.tsx @ c5e6b24f (MIT): the `PdfPage`
// component (one page drawn to a canvas within a pixel budget, a pdf.js text layer over it, both
// cancelled and released when the page leaves the window). Changed here: the page is drawn into a
// fresh canvas that replaces the old one only when it is finished, so a zoom or a new version of
// the file never shows a blank or half-drawn page; drawing waits for the zoom to settle and goes
// through the viewer's queue; the text layer is built once and scaled in CSS; links are hit areas of
// our own; a page that fails says so on its own sheet instead of failing the document.
'use client';

import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';

import { useT } from '../../../../i18n';
import { cn } from '../../../ui';
import sheets from '../parts/Sheets.module.css';
import styles from '../PdfViewer.module.css';
import { freePdfCanvas, type PdfBitmapKeeper } from './bitmap-keeper';
import { isPdfCancellation, type PdfModule } from './pdf-document';
import { pdfOutputScale } from './pdf-layout';
import { readPdfLinks, type PdfLink, type PdfLinkTarget } from './pdf-links';
import type { PdfRenderQueue } from './render-queue';
import { steadyPdfTextSelection } from './text-selection';

/** Backing-store pixels one page may use (64 MB of RGBA). Beyond it the page is drawn a little softer. */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
/** How long the zoom has to hold still before a page that already shows a bitmap is drawn again. */
const SETTLE_MS = 140;

export interface PdfPageProps {
  /** Null while the document is still opening: the sheet shows paper, or the bitmap kept from last time. */
  pdf: PDFDocumentProxy | null;
  pdfjs: PdfModule | null;
  /** 0-based. */
  index: number;
  /** The page box in whole CSS pixels at the current zoom. */
  width: number;
  height: number;
  pixelRatio: number;
  /** False while the tab is hidden: nothing new is drawn. */
  active: boolean;
  queue: PdfRenderQueue;
  /** Distance of a page from the middle of the window; the queue draws the nearest first. */
  distance(index: number): number;
  bitmaps: PdfBitmapKeeper;
  /** The page's real size at scale 1, reported when the box it was given has another shape. */
  onSize(index: number, size: { width: number; height: number }): void;
  onInternalLink(target: PdfLinkTarget): void;
  onExternalLink(url: string, at: { x: number; y: number }): void;
  /** The text layer's spans, one per text item in reading order (for find); null when it goes away. */
  onTextLayer?(index: number, items: HTMLElement[] | null): void;
}

function PdfPageView({
  pdf,
  pdfjs,
  index,
  width,
  height,
  pixelRatio,
  active,
  queue,
  distance,
  bitmaps,
  onSize,
  onInternalLink,
  onExternalLink,
  onTextLayer,
}: PdfPageProps): JSX.Element {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  /** What the canvas on screen was drawn from, so an unchanged page is not drawn twice. */
  const drawnRef = useRef<{ pdf: PDFDocumentProxy; width: number; ratio: number } | null>(null);
  const [painted, setPainted] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Text-layer scale per CSS pixel of page width (pdf.js sizes the layer from one CSS variable). */
  const [textUnit, setTextUnit] = useState<number | null>(null);
  const [links, setLinks] = useState<PdfLink[]>([]);
  /** The page box of the latest render, for work that starts later than the render it was queued in. */
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };

  // ── the bitmap this page starts with, and where it goes when the page leaves ────────────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const seed = bitmaps.seed(index);
    if (seed && seed.width > 0 && !host.firstChild) {
      host.append(seed);
      setPainted(true);
    }
    return () => {
      const canvas = host.firstElementChild;
      host.replaceChildren();
      drawnRef.current = null;
      if (canvas instanceof HTMLCanvasElement) bitmaps.retire(index, canvas);
    };
    // Once per mounted page: `index` and `bitmaps` never change for an instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── drawing ─────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const host = hostRef.current;
    if (!pdf || !active || !host) return;
    const ratio = pdfOutputScale(width, height, pixelRatio, MAX_CANVAS_PIXELS);
    const drawn = drawnRef.current;
    if (drawn && drawn.pdf === pdf && drawn.width === width && drawn.ratio === ratio) return;

    let cancelled = false;
    let task: RenderTask | null = null;
    let withdraw: (() => void) | null = null;

    const draw = async (): Promise<void> => {
      if (cancelled) return;
      const page = await pdf.getPage(index + 1);
      pageRef.current = page;
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      // Until every page has been measured, a page stands in a box shaped like the first page. When
      // this page has another shape, say so and wait: the viewer hands it a new box, and that one is
      // drawn. The tolerance is what rounding a box to whole pixels can add, so a box of the right
      // shape is never taken for a wrong one (and a box of a wrong shape always changes).
      const shape = base.height / base.width;
      if (Math.abs(width * shape - height) > 1 + shape) {
        onSize(index, { width: base.width, height: base.height });
        return;
      }
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      try {
        task = page.render({
          canvas,
          viewport,
          // The backing store is whole device pixels; the two axes absorb the rounding separately.
          transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
        });
        await task.promise;
      } catch (error) {
        freePdfCanvas(canvas);
        if (cancelled || isPdfCancellation(error)) return;
        // The old bitmap (if any) stays; only a page with nothing to show says it failed.
        if (!host.firstChild) setFailed(true);
        return;
      }
      if (cancelled) {
        freePdfCanvas(canvas);
        return;
      }
      const previous = host.firstElementChild;
      host.replaceChildren(canvas);
      if (previous instanceof HTMLCanvasElement) freePdfCanvas(previous);
      drawnRef.current = { pdf, width, ratio };
      setPainted(true);
      setFailed(false);
    };

    // A page that already shows something keeps it (stretched) until the zoom settles.
    const timer = window.setTimeout(
      () => {
        withdraw = queue.enqueue(() => distance(index), draw);
      },
      host.firstChild ? SETTLE_MS : 0,
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      withdraw?.();
      task?.cancel();
    };
  }, [pdf, index, width, height, pixelRatio, active, queue, distance, onSize]);

  // ── text and links: built once per document, scaled by CSS afterwards ───────────────────────────
  useEffect(() => {
    const container = textRef.current;
    if (!pdf || !pdfjs || !active || !container) return;
    let cancelled = false;
    let layer: TextLayer | null = null;
    let release: (() => void) | null = null;

    const build = async (): Promise<void> => {
      if (cancelled) return;
      const page = await pdf.getPage(index + 1);
      if (cancelled) return;
      // pdf.js measures each run at the size it is shown at, to stretch it to the drawn width.
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.max(0.1, sizeRef.current.width / base.width) });
      container.replaceChildren();
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
      try {
        await layer.render();
      } catch {
        // No text layer: the page still reads, it just cannot be selected.
        return;
      }
      if (cancelled) return;
      release = steadyPdfTextSelection(container, { selecting: styles.selecting ?? '', endOfContent: styles.endOfContent ?? '' });
      // pdf.js sizes the layer as "factor × the page's own width" and turns it in CSS for a rotated
      // page, so the factor that makes it cover the sheet is the sheet's width over that edge.
      const raw = viewport.rawDims as { pageWidth: number; pageHeight: number };
      setTextUnit(1 / Math.max(1, viewport.rotation % 180 === 0 ? raw.pageWidth : raw.pageHeight));
      onTextLayer?.(index, layer.textDivs);
      const found = await readPdfLinks(pdf, page, index).catch(() => [] as PdfLink[]);
      if (!cancelled) setLinks(found);
    };

    // Just after this page's own drawing, before the pages further away.
    const withdraw = queue.enqueue(() => distance(index) + 1, build);

    return () => {
      cancelled = true;
      withdraw();
      layer?.cancel();
      release?.();
      onTextLayer?.(index, null);
      container.replaceChildren();
      setLinks((previous) => (previous.length > 0 ? [] : previous));
    };
  }, [pdf, pdfjs, index, active, queue, distance, onTextLayer]);

  // Declared after the two effects above, so on unmount it runs once their work has been cancelled:
  // a page's operator list and decoded images are only worth their memory while the page is near.
  useEffect(
    () => () => {
      pageRef.current?.cleanup();
    },
    [],
  );

  const activate = (link: PdfLink, event: MouseEvent<HTMLAnchorElement> | KeyboardEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (link.target) {
      onInternalLink(link.target);
      return;
    }
    if (!link.url) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const at = 'clientX' in event && event.clientX > 0 ? { x: event.clientX, y: event.clientY } : { x: rect.left + rect.width / 2, y: rect.top };
    onExternalLink(link.url, at);
  };

  const style: CSSProperties & Record<'--total-scale-factor', number> = {
    width,
    height,
    '--total-scale-factor': textUnit === null ? 1 : width * textUnit,
  };

  return (
    <div
      className={cn(sheets.sheet, styles.page)}
      style={style}
      role="group"
      aria-label={t('artifact.pdf.page', { page: index + 1 })}
      data-pdf-page={index + 1}
      data-pending={painted ? undefined : ''}
    >
      <div ref={hostRef} className={styles.bitmap} aria-hidden="true" />
      <div ref={textRef} className={styles.textLayer} data-pdf-text-layer="" />
      {links.length > 0 ? (
        <div className={styles.links}>
          {links.map((link, position) => {
            const label = link.target
              ? t('artifact.pdf.linkToPage', { page: link.target.page + 1 })
              : t('artifact.pdf.linkExternal', { url: link.url ?? '' });
            return (
              <a
                key={position}
                className={styles.link}
                style={{ left: `${link.left}%`, top: `${link.top}%`, width: `${link.width}%`, height: `${link.height}%` }}
                role="link"
                tabIndex={0}
                title={label}
                aria-label={label}
                data-pdf-link={link.target ? 'internal' : 'external'}
                onClick={(event) => activate(link, event)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') activate(link, event);
                }}
              />
            );
          })}
        </div>
      ) : null}
      {failed ? <p className={styles.pageNotice}>{t('artifact.pdf.pageFailed')}</p> : null}
    </div>
  );
}

/** One page of the document: paper, the drawn page, selectable text, links. */
export const PdfPage = memo(PdfPageView);
