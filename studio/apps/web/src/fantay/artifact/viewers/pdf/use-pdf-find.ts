// SPDX-License-Identifier: AGPL-3.0-only
// Find in document. The pages' text is read from pdf.js in page order (once per document, kept while
// the viewer lives), every occurrence is counted, and the occurrences on the pages that are mounted
// are painted with the CSS Custom Highlight API: ranges over the text layer's own text nodes, so
// the text layer's markup is never touched and selection keeps working. The first result is the
// first one at or after the page the reader is on.
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useArtifactViewState } from '../../use-view-state';
import { pdfFindMatches, pdfFindOrdinal, pdfFindStep, pdfTextRuns, type PdfFindMatch, type PdfTextItemLike } from './pdf-find';

/** Characters of page text kept for searching; a document with more is searched up to here. */
const MAX_TEXT_CHARACTERS = 8 * 1024 * 1024;
const TYPING_PAUSE_MS = 160;
const PUBLISH_EVERY_MS = 120;
const HIGHLIGHT_ALL = 'fantay-pdf-find';
const HIGHLIGHT_CURRENT = 'fantay-pdf-find-current';

interface PageText {
  runs: string[];
  /** For each run, how far down the page its baseline sits (fraction of the page height). */
  tops: number[];
}

export interface PdfFindPosition {
  page: number;
  index: number;
}

export interface PdfFind {
  open: boolean;
  query: string;
  /** Occurrences found so far. */
  total: number;
  /** 1-based position of the current occurrence; 0 when there is none. */
  ordinal: number;
  searching: boolean;
  /** How many pages were searched when the document's text passed the limit; null when all were. */
  searchedPages: number | null;
  setOpen(open: boolean): void;
  setQuery(query: string): void;
  step(direction: 1 | -1): void;
  /** Pages report their text layer's spans here (and null when the layer goes away). */
  onTextLayer(index: number, items: HTMLElement[] | null): void;
}

export interface PdfFindOptions {
  projectId: string;
  fileName: string;
  pdf: PDFDocumentProxy | null;
  /** The page the reader is on (0-based), asked when a search starts. */
  currentPage(): number;
  /** Bring a point of a page into view: `offset` is a fraction of the page's height. */
  reveal(page: number, offset: number): void;
}

function matchRange(items: readonly HTMLElement[], match: PdfFindMatch): Range | null {
  const start = items[match.startRun]?.firstChild;
  const end = items[match.endRun]?.firstChild;
  if (!(start instanceof Text) || !(end instanceof Text) || !start.isConnected || !end.isConnected) return null;
  const range = document.createRange();
  range.setStart(start, Math.min(match.startOffset, start.length));
  range.setEnd(end, Math.min(match.endOffset, end.length));
  return range;
}

const STYLE_ATTR = 'data-fantay-pdf-highlight';

function ensureHighlightStyles(): void {
  if (typeof document === 'undefined' || document.head.querySelector(`[${STYLE_ATTR}]`)) return;
  // Injected directly into the browser document because LightningCSS drops `::highlight(...)`
  // when compiling CSS Modules for production builds.
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = [
    `::highlight(${HIGHLIGHT_ALL}) { background-color: color-mix(in srgb, var(--warning) 34%, transparent); color: transparent; }`,
    `::highlight(${HIGHLIGHT_CURRENT}) { background-color: color-mix(in srgb, var(--warning) 72%, transparent); color: transparent; }`,
  ].join('\n');
  document.head.appendChild(style);
}

function highlightRegistry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined') return null;
  ensureHighlightStyles();
  return CSS.highlights;
}

export function usePdfFind({ projectId, fileName, pdf, currentPage, reveal }: PdfFindOptions): PdfFind {
  const [saved, setSaved] = useArtifactViewState<{ open: boolean; query: string }>(projectId, fileName, 'find', { open: false, query: '' });
  const { open, query } = saved;
  const [settled, setSettled] = useState(query);
  const [results, setResults] = useState<ReadonlyMap<number, readonly PdfFindMatch[]>>(() => new Map());
  const [current, setCurrent] = useState<PdfFindPosition | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchedPages, setSearchedPages] = useState<number | null>(null);
  const [layersVersion, setLayersVersion] = useState(0);
  const layers = useRef(new Map<number, HTMLElement[]>());
  const texts = useRef<{ pdf: PDFDocumentProxy | null; pages: Map<number, PageText>; characters: number }>({ pdf: null, pages: new Map(), characters: 0 });
  const currentPageRef = useRef(currentPage);
  const revealRef = useRef(reveal);
  currentPageRef.current = currentPage;
  revealRef.current = reveal;

  // The search follows the typing after a short pause.
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(query), TYPING_PAUSE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const needle = open ? settled.trim() : '';

  useEffect(() => {
    if (!pdf || !needle) {
      setResults(new Map());
      setCurrent(null);
      setSearching(false);
      setSearchedPages(null);
      return;
    }
    if (texts.current.pdf !== pdf) texts.current = { pdf, pages: new Map(), characters: 0 };
    const cache = texts.current;
    let cancelled = false;
    const found = new Map<number, readonly PdfFindMatch[]>();
    const from = currentPageRef.current();
    let chosen: PdfFindPosition | null = null;
    let published = performance.now();
    setSearching(true);
    setCurrent(null);
    setSearchedPages(null);

    const choose = (position: PdfFindPosition): void => {
      chosen = position;
      setCurrent(position);
      const top = cache.pages.get(position.page)?.tops[found.get(position.page)?.[position.index]?.startRun ?? 0];
      revealRef.current(position.page, top ?? 0);
    };

    void (async () => {
      let stoppedAt: number | null = null;
      for (let index = 0; index < pdf.numPages; index += 1) {
        let text = cache.pages.get(index);
        if (!text) {
          if (cache.characters > MAX_TEXT_CHARACTERS) {
            stoppedAt = index;
            break;
          }
          const page = await pdf.getPage(index + 1);
          const content = await page.getTextContent();
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1 });
          const items = (content.items as PdfTextItemLike[]).filter((item): item is { str: string; hasEOL: boolean; transform?: number[] } => 'str' in item);
          text = {
            runs: pdfTextRuns(items),
            tops: items.map((item) => {
              const [, y] = viewport.convertToViewportPoint(item.transform?.[4] ?? 0, item.transform?.[5] ?? 0) as [number, number];
              return Math.min(1, Math.max(0, y / viewport.height));
            }),
          };
          cache.pages.set(index, text);
          cache.characters += text.runs.reduce((sum, run) => sum + run.length, 0);
        }
        const matches = pdfFindMatches(text.runs, needle);
        if (matches.length > 0) {
          found.set(index, matches);
          if (!chosen && index >= from) choose({ page: index, index: 0 });
        }
        if (performance.now() - published > PUBLISH_EVERY_MS) {
          published = performance.now();
          setResults(new Map(found));
        }
      }
      if (cancelled) return;
      setResults(new Map(found));
      setSearchedPages(stoppedAt);
      setSearching(false);
      // Nothing from the reader's page onwards: start again from the top.
      const firstPage = [...found.keys()].sort((a, b) => a - b)[0];
      if (!chosen && firstPage !== undefined) choose({ page: firstPage, index: 0 });
    })().catch(() => {
      if (cancelled) return;
      setResults(new Map(found));
      setSearching(false);
    });

    return () => {
      cancelled = true;
    };
  }, [pdf, needle]);

  const counts = useMemo(() => new Map([...results].map(([page, matches]) => [page, matches.length] as const)), [results]);
  const total = useMemo(() => [...counts.values()].reduce((sum, count) => sum + count, 0), [counts]);

  const step = useCallback(
    (direction: 1 | -1) => {
      const next = pdfFindStep(counts, current, direction);
      if (!next) return;
      setCurrent(next);
      const match = results.get(next.page)?.[next.index];
      const top = match ? texts.current.pages.get(next.page)?.tops[match.startRun] : undefined;
      revealRef.current(next.page, top ?? 0);
    },
    [counts, current, results],
  );

  const onTextLayer = useCallback((index: number, items: HTMLElement[] | null) => {
    if (items) layers.current.set(index, items);
    else layers.current.delete(index);
    setLayersVersion((version) => version + 1);
  }, []);

  // Paint the occurrences on the pages that are mounted.
  useEffect(() => {
    const registry = highlightRegistry();
    if (!registry || total === 0) return;
    const all: Range[] = [];
    let active: Range | null = null;
    for (const [page, items] of layers.current) {
      results.get(page)?.forEach((match, index) => {
        const range = matchRange(items, match);
        if (!range) return;
        if (current && current.page === page && current.index === index) active = range;
        else all.push(range);
      });
    }
    registry.set(HIGHLIGHT_ALL, new Highlight(...all));
    if (active) registry.set(HIGHLIGHT_CURRENT, new Highlight(active));
    return () => {
      registry.delete(HIGHLIGHT_ALL);
      registry.delete(HIGHLIGHT_CURRENT);
    };
  }, [results, current, total, layersVersion]);

  const setOpen = useCallback((next: boolean) => setSaved((previous) => (previous.open === next ? previous : { ...previous, open: next })), [setSaved]);
  const setQuery = useCallback((next: string) => setSaved((previous) => ({ ...previous, query: next })), [setSaved]);

  return {
    open,
    query,
    total,
    ordinal: pdfFindOrdinal(counts, current),
    searching: needle !== '' && (searching || settled !== query),
    searchedPages,
    setOpen,
    setQuery,
    step,
    onTextLayer,
  };
}
