// SPDX-License-Identifier: AGPL-3.0-only
// E-books (.epub): one chapter at a time, as a reading column on the interface paper. The bar holds
// the contents and a chapter stepper; ← and → turn chapters, + and − change the text size, and the
// end of every chapter offers the next one. The book's own typography is kept (indents, alignment,
// heading styles); its colours, scripts, fonts and anything remote are not.
// The archive is read in a worker (`ebook/book-client.ts`); every chapter is sanitised and drawn in
// a frame that cannot run script (`parts/SandboxFrame.tsx`), and pictures come from the archive as
// object addresses that are released when the chapter leaves. Chapter, place and text size are kept
// per file; the chapter on screen stays until the next one is ready.
'use client';

import { AArrowDown, AArrowUp, Lock, RotateCcw, TableOfContents, TimerOff } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../../../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  IconButton,
} from '../../ui';
import { ArtifactPager } from '../shell/ArtifactPager';
import { ArtifactShell, type ArtifactMenuEntry, type ArtifactShellState } from '../shell/ArtifactShell';
import { nextZoomStep } from '../shell/ArtifactZoom';
import { useArtifactFileActions } from '../shell/use-file-actions';
import { ARTIFACT_SLOW_LOAD_MS, useArtifactBytes } from '../use-artifact-source';
import { readArtifactViewState, useArtifactViewState, writeArtifactViewState } from '../use-view-state';
import type { ArtifactViewerProps } from '../viewer-types';
import { BOOK_FRAME_CSS, BOOK_GUARD_CSS } from './document/frame-css';
import { applyScrollShare, readScrollShare } from './document/frame-view';
import { BookClient, BookError, type BookFailure } from './ebook/book-client';
import { loadChapter, type LoadedChapter } from './ebook/chapter';
import { MAX_EPUB_BYTES, currentTocEntry, type BookInfo, type BookTocEntry } from './ebook/epub';
import { SandboxFrame } from './parts/SandboxFrame';

const MIN_TEXT_ZOOM = 0.67;
const MAX_TEXT_ZOOM = 2;

interface OpenBook {
  /** The bytes this book was opened from. */
  data: ArrayBuffer;
  client: BookClient;
  info: BookInfo;
}

interface ShownChapter extends LoadedChapter {
  book: OpenBook;
  index: number;
}

/** Where to land in the chapter that is about to be shown. */
interface Landing {
  fragment?: string;
  share?: number;
}

interface SavedPlace {
  chapter: number;
  share: number;
}

type ContentsEntry = BookTocEntry;

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

function ContentsMenu({
  label,
  entries,
  current,
  onPick,
}: {
  label: string;
  entries: readonly ContentsEntry[];
  current: number;
  onPick(entry: ContentsEntry): void;
}): JSX.Element {
  // The menu opens on the reader's place, not on chapter one.
  const showCurrent = useCallback((content: HTMLDivElement | null) => {
    if (!content) return;
    window.requestAnimationFrame(() => content.querySelector('[data-state="checked"]')?.scrollIntoView({ block: 'center' }));
  }, []);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={entries.length === 0}>
        <IconButton size="sm" aria-label={label} tooltipSide="bottom" data-artifact-action="contents" disabled={entries.length === 0}>
          <TableOfContents aria-hidden="true" strokeWidth={1.75} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={showCurrent} align="end" aria-label={label}>
        <DropdownMenuRadioGroup
          value={String(current)}
          onValueChange={(value) => {
            const entry = entries[Number(value)];
            if (entry) onPick(entry);
          }}
        >
          {entries.map((entry, index) => (
            <DropdownMenuRadioItem
              // Titles repeat in real books; the position is the identity.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              value={String(index)}
              className="data-[state=checked]:font-semibold"
              style={{ paddingInlineStart: 10 + Math.min(entry.depth, 4) * 14 }}
            >
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function chapterLink(frameDocument: Document, direction: 'previous' | 'next', caption: string, name: string): HTMLElement {
  const link = frameDocument.createElement('a');
  link.setAttribute('href', '#');
  link.setAttribute('data-fx-nav', direction);
  const dir = frameDocument.createElement('span');
  dir.className = 'fx-dir';
  dir.textContent = caption;
  const title = frameDocument.createElement('span');
  title.className = 'fx-name';
  title.textContent = name;
  link.append(dir, title);
  return link;
}

export default function EbookViewer({ projectId, file, active }: ArtifactViewerProps): JSX.Element {
  const t = useT();
  const fileActions = useArtifactFileActions(projectId, file);
  const bytes = useArtifactBytes(projectId, file, { enabled: active, maxBytes: MAX_EPUB_BYTES });
  const data = bytes.source.status === 'ready' ? bytes.source.data : null;
  const fileName = file.name;

  // ── the book ──────────────────────────────────────────────────────────────────────────────────
  const [book, setBook] = useState<OpenBook | null>(null);
  const [bookFailure, setBookFailure] = useState<{ data: ArrayBuffer; code: BookFailure } | null>(null);
  useEffect(() => {
    if (!data) return;
    const client = new BookClient();
    let current = true;
    client.open(data).then(
      (info) => {
        if (current) setBook({ data, client, info });
      },
      (cause: unknown) => {
        if (current) setBookFailure({ data, code: cause instanceof BookError ? cause.code : 'invalid' });
      },
    );
    return () => {
      current = false;
      client.dispose();
    };
  }, [data]);

  const info = book?.info ?? null;
  const count = info?.chapters.length ?? 0;
  const [storedChapter, setStoredChapter] = useArtifactViewState<number>(projectId, fileName, 'chapter', 0);
  const chapter = count > 0 ? Math.min(count - 1, Math.max(0, storedChapter)) : 0;
  /** The chapter the reader asked for, which may still be loading; stepping counts from it. */
  const requested = useRef(chapter);
  requested.current = chapter;
  const chapterName = useCallback(
    (index: number): string => info?.chapters[index]?.title ?? t('artifact.ebook.section', { n: index + 1 }),
    [info, t],
  );

  const contents = useMemo<ContentsEntry[]>(() => {
    if (!info) return [];
    if (info.toc.length > 0) return info.toc;
    return info.chapters.map((entry, index) => ({ label: entry.title ?? t('artifact.ebook.section', { n: index + 1 }), chapter: index, fragment: '', depth: 0 }));
  }, [info, t]);

  // ── the frame and the chapter in it ───────────────────────────────────────────────────────────
  const [frameDocument, setFrameDocument] = useState<Document | null>(null);
  const [zoom, setZoom] = useArtifactViewState<number>(projectId, fileName, 'zoom', 1);
  const [shown, setShown] = useState<ShownChapter | null>(null);
  const [chapterFailure, setChapterFailure] = useState<{ book: OpenBook; index: number } | null>(null);
  const styleCache = useRef<{ book: OpenBook | null; sheets: Map<string, string> }>({ book: null, sheets: new Map() });
  const landing = useRef<Landing | null>(null);
  const view = useRef({ placed: null as ShownChapter | null, addresses: [] as string[], zoom: 1, live: false, chapter: 0 });

  // The reader's last place in this book is the first landing.
  const restored = useRef(false);
  if (!restored.current && info) {
    restored.current = true;
    const saved = readArtifactViewState<SavedPlace>(projectId, fileName, 'scroll');
    if (saved && saved.chapter === chapter) landing.current = { share: saved.share };
  }

  useEffect(() => {
    if (!book || !frameDocument || count === 0) return;
    if (styleCache.current.book !== book) styleCache.current = { book, sheets: new Map() };
    let current = true;
    loadChapter(book.client, chapter, styleCache.current.sheets).then(
      (loaded) => {
        if (current) setShown({ ...loaded, book, index: chapter });
        else for (const address of loaded.addresses) URL.revokeObjectURL(address);
      },
      () => {
        if (current) setChapterFailure({ book, index: chapter });
      },
    );
    return () => {
      current = false;
    };
  }, [book, chapter, count, frameDocument]);

  // A loaded chapter replaces the one on screen in one step: styles, text, the way on, the place.
  useLayoutEffect(() => {
    if (!frameDocument) return;
    const root = frameDocument.documentElement;
    if (shown && view.current.placed !== shown) {
      const first = view.current.placed === null;
      // The same chapter again is a new version of the book: the reader stays where they were.
      const stay = !first && view.current.chapter === shown.index && landing.current === null ? readScrollShare(frameDocument) : null;
      view.current.live = false;
      const bookStyle = frameDocument.head.querySelector('style[data-book]');
      if (bookStyle) bookStyle.textContent = shown.css;

      const column = frameDocument.createElement('main');
      column.className = `reading ${shown.bodyClass}`.trim();
      if (shown.book.info.language) column.setAttribute('lang', shown.book.info.language);
      if (first) column.setAttribute('data-enter', '');
      column.append(shown.fragment);

      const last = shown.book.info.chapters.length - 1;
      const nav = frameDocument.createElement('nav');
      nav.className = 'fx-chapter-nav';
      if (shown.index > 0) nav.append(chapterLink(frameDocument, 'previous', t('artifact.ebook.previousChapter'), chapterName(shown.index - 1)));
      if (shown.index < last) nav.append(chapterLink(frameDocument, 'next', t('artifact.ebook.nextChapter'), chapterName(shown.index + 1)));
      frameDocument.body.replaceChildren(column, ...(nav.childElementCount > 0 ? [nav] : []));

      for (const address of view.current.addresses) URL.revokeObjectURL(address);
      view.current.addresses = shown.addresses;
      view.current.placed = shown;
      view.current.chapter = shown.index;
      root.style.setProperty('--zoom', String(zoom));
      view.current.zoom = zoom;

      const target = landing.current;
      landing.current = null;
      const scroller = frameDocument.scrollingElement;
      if (scroller) scroller.scrollTop = 0;
      if (target?.fragment) {
        (frameDocument.getElementById(target.fragment) ?? frameDocument.getElementsByName(target.fragment)[0])?.scrollIntoView({ block: 'start' });
      } else if (target?.share !== undefined) {
        applyScrollShare(frameDocument, target.share);
      } else if (stay !== null) {
        applyScrollShare(frameDocument, stay);
      }
      view.current.live = true;
      writeArtifactViewState(projectId, fileName, 'scroll', { chapter: shown.index, share: readScrollShare(frameDocument) } satisfies SavedPlace);
    } else if (view.current.zoom !== zoom) {
      // A new text size reflows the column: keep the reader the same share of the way down.
      const share = readScrollShare(frameDocument);
      root.style.setProperty('--zoom', String(zoom));
      view.current.zoom = zoom;
      applyScrollShare(frameDocument, share);
    }
    // `t` and `chapterName` only word the links of the chapter being placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameDocument, shown, zoom, projectId, fileName]);

  // The pictures' object addresses live as long as the chapter that shows them.
  useEffect(
    () => () => {
      for (const address of view.current.addresses) URL.revokeObjectURL(address);
      view.current.addresses = [];
    },
    [],
  );

  const onReady = useCallback(
    (ready: Document) => {
      // After the frame's own stylesheet: the book's cleaned styles, then what the reader keeps.
      if (!ready.head.querySelector('style[data-book]')) {
        const bookStyle = ready.createElement('style');
        bookStyle.setAttribute('data-book', '');
        const guard = ready.createElement('style');
        guard.textContent = BOOK_GUARD_CSS;
        ready.head.append(bookStyle, guard);
      }
      setFrameDocument(ready);

      let frameRequest = 0;
      const onScroll = (): void => {
        if (!view.current.live || frameRequest !== 0) return;
        frameRequest = window.requestAnimationFrame(() => {
          frameRequest = 0;
          if (!view.current.live) return;
          writeArtifactViewState(projectId, fileName, 'scroll', { chapter: view.current.chapter, share: readScrollShare(ready) } satisfies SavedPlace);
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

  // ── moving through the book ───────────────────────────────────────────────────────────────────
  const go = useCallback(
    (index: number, fragment = '') => {
      if (count === 0) return;
      const next = Math.min(count - 1, Math.max(0, index));
      if (next === requested.current && next === view.current.chapter && view.current.placed && frameDocument) {
        // Already here: move inside the chapter.
        const target = fragment ? (frameDocument.getElementById(fragment) ?? frameDocument.getElementsByName(fragment)[0]) : null;
        if (target) target.scrollIntoView({ block: 'start' });
        else if (frameDocument.scrollingElement) frameDocument.scrollingElement.scrollTop = 0;
        return;
      }
      landing.current = fragment ? { fragment } : null;
      setStoredChapter(next);
    },
    [count, frameDocument, setStoredChapter],
  );

  const onLink = (_href: string, anchor: Element): boolean => {
    const direction = anchor.getAttribute('data-fx-nav');
    if (direction) {
      go(requested.current + (direction === 'next' ? 1 : -1));
      return true;
    }
    const path = anchor.getAttribute('data-fx-path');
    if (path === null) return false;
    const target = info?.chapters.findIndex((entry) => entry.path === path) ?? -1;
    if (target >= 0) go(target, anchor.getAttribute('data-fx-fragment') ?? '');
    return true;
  };

  const stepText = useCallback(
    (direction: 1 | -1) => setZoom((current) => nextZoomStep(current, direction, MIN_TEXT_ZOOM, MAX_TEXT_ZOOM)),
    [setZoom],
  );

  const onFrameKey = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowLeft') go(requested.current - 1);
    else if (event.key === 'ArrowRight') go(requested.current + 1);
    else if (event.key === '+' || event.key === '=') stepText(1);
    else if (event.key === '-' || event.key === '_') stepText(-1);
    else if (event.key === '0') setZoom(1);
    else return;
    event.preventDefault();
  };

  const menu = useMemo<ArtifactMenuEntry[]>(
    () => [
      { id: 'text-larger', label: t('artifact.ebook.textLarger'), icon: AArrowUp, onSelect: () => stepText(1), disabled: zoom >= MAX_TEXT_ZOOM - 1e-3 },
      { id: 'text-smaller', label: t('artifact.ebook.textSmaller'), icon: AArrowDown, onSelect: () => stepText(-1), disabled: zoom <= MIN_TEXT_ZOOM + 1e-3 },
      { id: 'text-reset', label: t('artifact.ebook.textReset'), icon: RotateCcw, onSelect: () => setZoom(1), disabled: zoom === 1 },
      ...fileActions.menu.map((entry, index) => (index === 0 ? { ...entry, separated: true } : entry)),
      fileActions.reloadEntry(bytes.reload),
    ],
    [bytes.reload, fileActions, setZoom, stepText, t, zoom],
  );

  // ── state ─────────────────────────────────────────────────────────────────────────────────────
  const openFailed = data !== null && bookFailure?.data === data ? bookFailure.code : null;
  const chapterFailed = book !== null && chapterFailure?.book === book && chapterFailure.index === chapter;
  const waiting = data !== null && openFailed === null && !chapterFailed && shown === null;
  const slow = useSlow(waiting);
  let state: ArtifactShellState | null = null;
  if (data === null) state = fileActions.sourceState(bytes.source, bytes.reload);
  else if (openFailed === 'protected') state = fileActions.unsupported(t('artifact.ebook.protected'), t('artifact.ebook.protectedHint'), Lock);
  else if (openFailed === 'timeout') state = fileActions.unsupported(t('artifact.document.timeout'), t('artifact.ebook.tooLargeHint'), TimerOff);
  else if (openFailed === 'too-large') state = fileActions.unsupported(t('artifact.ebook.tooLarge'), t('artifact.ebook.tooLargeHint'));
  else if (openFailed === 'empty') state = fileActions.unsupported(t('artifact.ebook.empty'), t('artifact.ebook.tooLargeHint'));
  else if (openFailed !== null) state = fileActions.unsupported(t('artifact.ebook.invalid'), t('artifact.document.notValidHint'));
  else if (chapterFailed) state = fileActions.unsupported(t('artifact.ebook.chapterFailed'), t('artifact.ebook.chapterFailedHint'));
  else if (waiting) state = slow ? { kind: 'loading', label: t('artifact.ebook.opening') } : { kind: 'loading', quiet: true };

  const facts = [info?.title, info?.author].filter(Boolean);

  return (
    <ArtifactShell
      viewer="ebook"
      path={file.name}
      stage="page"
      controls={
        <>
          <ContentsMenu
            label={t('artifact.ebook.contents')}
            entries={contents}
            current={currentTocEntry(contents, chapter)}
            onPick={(entry) => go(entry.chapter, entry.fragment)}
          />
          <ArtifactPager
            page={chapter + 1}
            count={count}
            onPage={(page) => go(page - 1)}
            label={t('artifact.ebook.chapters')}
            previousLabel={t('artifact.ebook.previousChapter')}
            nextLabel={t('artifact.ebook.nextChapter')}
          />
        </>
      }
      meta={facts.join(' · ')}
      actions={[fileActions.download]}
      menu={menu}
      menuLabel={t('nextStep.more')}
      state={state}
      keepContentMounted
    >
      <SandboxFrame title={info?.title ?? file.name} css={BOOK_FRAME_CSS} onReady={onReady} onLink={onLink} onKeyDown={onFrameKey} />
    </ArtifactShell>
  );
}
