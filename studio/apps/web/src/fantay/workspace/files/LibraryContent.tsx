// SPDX-License-Identifier: AGPL-3.0-only
// The content of the Files library: live artifacts and folders as compact tiles, then the files, as
// cards in a grid or as rows in a list. Both views are one virtualised column of rows (a grid row
// holds a few cards), so the cost follows the viewport, not the project, and a card's preview is
// only ever loaded near the viewport.
// The keyboard model is a listbox with one tab stop: arrows move through cards and rows, Enter
// opens, Space selects, F2 renames, Delete removes, Backspace goes up a folder. The focused row is
// pinned into the rendered window (the pattern of ../code/FileTree.tsx), so focus survives scrolling.
'use client';

import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { Activity, ArrowDown, ArrowUp, Ellipsis, Folder } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';

import type { Dict } from '../../../i18n/types';
import type { LiveArtifactWorkspaceEntry } from '../../../types';
import { formatBytes } from '../../artifact/use-artifact-source';
import { Button, Dot, IconButton, Input } from '../../ui';
import { pickFileIcon } from '../code/file-visual';
import { FilePreview } from './FilePreview';
import styles from './FilesSurface.module.css';
import {
  relativeTime,
  splitDisplayName,
  type LibraryFile,
  type LibraryFolder,
  type LibraryKind,
  type LibrarySort,
  type LibrarySortKey,
} from './library-model';
import type { LibraryViewMode } from './library-store';

export type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

export type LibraryEntry =
  | { type: 'live'; id: string; artifact: LiveArtifactWorkspaceEntry }
  | { type: 'folder'; id: string; folder: LibraryFolder }
  | { type: 'file'; id: string; item: LibraryFile };

export interface RenameState {
  path: string;
  draft: string;
  saving: boolean;
}

// ── geometry ──────────────────────────────────────────────────────────────────────────────────
// The virtualiser needs every row's height before it is drawn, so the grid's geometry is computed
// here and the stylesheet only repeats it (`--files-*` on the list element).

/** Side padding of the content area. */
export const CONTENT_PAD = 12;
const CARD_MIN = 168;
const CARD_GAP = 12;
/** Name and meta under a preview, with the space above them. */
const CARD_TEXT = 44;
const CARD_ROW_GAP = 14;
const TILE_HEIGHT = 44;
const TILE_GAP = 8;
/** Space between the last row of tiles and the first row of cards. */
const SECTION_GAP = 10;
const LIST_ROW = 32;

export interface GridGeometry {
  columns: number;
  previewHeight: number;
  cardRow: number;
}

/** `repeat(auto-fill, minmax(168px, 1fr))`, never fewer than two columns. */
export function gridGeometry(width: number): GridGeometry {
  const inner = Math.max(0, width - CONTENT_PAD * 2);
  const columns = Math.max(2, Math.floor((inner + CARD_GAP) / (CARD_MIN + CARD_GAP)));
  const cardWidth = Math.max(0, (inner - CARD_GAP * (columns - 1)) / columns);
  const previewHeight = Math.round(cardWidth * 0.75);
  return { columns, previewHeight, cardRow: previewHeight + CARD_TEXT + CARD_ROW_GAP };
}

interface VirtualRow {
  key: string;
  kind: 'tiles' | 'cards' | 'row';
  entries: LibraryEntry[];
  height: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

function buildRows(entries: readonly LibraryEntry[], view: LibraryViewMode, geometry: GridGeometry): VirtualRow[] {
  if (view === 'list') {
    return entries.map((entry) => ({ key: entry.id, kind: 'row', entries: [entry], height: LIST_ROW }));
  }
  const tiles = entries.filter((entry) => entry.type !== 'file');
  const cards = entries.filter((entry) => entry.type === 'file');
  const tileRows = chunk(tiles, geometry.columns);
  const rows: VirtualRow[] = tileRows.map((row, index) => ({
    key: `tiles:${index}`,
    kind: 'tiles',
    entries: row,
    height: TILE_HEIGHT + (index === tileRows.length - 1 && cards.length > 0 ? SECTION_GAP + TILE_GAP : TILE_GAP),
  }));
  chunk(cards, geometry.columns).forEach((row, index) => {
    rows.push({ key: `cards:${index}`, kind: 'cards', entries: row, height: geometry.cardRow });
  });
  return rows;
}

// ── labels ────────────────────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<LibraryKind, keyof Dict> = {
  page: 'artifact.cards.kind.page',
  image: 'artifact.cards.kind.image',
  sketch: 'designFiles.kindSketch',
  video: 'artifact.cards.kind.video',
  audio: 'artifact.cards.kind.audio',
  pdf: 'designFiles.kindPdf',
  document: 'artifact.cards.kind.document',
  text: 'artifact.cards.kind.text',
  sheet: 'artifact.cards.kind.sheet',
  slides: 'artifact.cards.kind.slides',
  code: 'artifact.cards.kind.code',
  data: 'artifact.cards.kind.data',
  notebook: 'workspace.files.kindNotebook',
  database: 'workspace.files.kindDatabase',
  model: 'artifact.cards.kind.model',
  archive: 'artifact.cards.kind.archive',
  font: 'artifact.cards.kind.font',
  file: 'artifact.cards.kind.file',
};

export function timeLabel(t: Translate, timestamp: number, now: number): string {
  const time = relativeTime(timestamp, now);
  switch (time.unit) {
    case 'now':
      return t('common.justNow');
    case 'minutes':
      return t('common.minutesAgo', { n: time.n });
    case 'hours':
      return t('common.hoursAgo', { n: time.n });
    case 'days':
      return t('common.daysAgo', { n: time.n });
    case 'weeks':
      return t('common.weeksAgo', { n: time.n });
    default:
      return time.date.toLocaleDateString();
  }
}

function folderMeta(t: Translate, folder: LibraryFolder): string {
  return folder.fileCount === 0 ? t('workspace.files.folderEmptyCount') : t('designFiles.folderCount', { n: folder.fileCount });
}

/** Where a file lives below the open folder ('' when it sits right in it). */
function relativeDir(item: LibraryFile, currentDir: string): string {
  if (item.dir === currentDir) return '';
  return currentDir === '' ? item.dir : item.dir.slice(currentDir.length + 1);
}

// ── items ─────────────────────────────────────────────────────────────────────────────────────

/** What every item needs and none of them owns. One object, stable between renders that change nothing. */
interface ItemShared {
  projectId: string;
  currentDir: string;
  now: number;
  sortKey: LibrarySortKey;
  viewerOnly: boolean;
  t: Translate;
  onPick(entry: LibraryEntry, event: MouseEvent): void;
  onFocus(id: string): void;
  onMore(element: HTMLElement): void;
  onRenameChange(draft: string): void;
  onRenameCommit(): void;
  onRenameCancel(): void;
}

interface ItemProps {
  entry: LibraryEntry;
  active: boolean;
  selected: boolean;
  writing: boolean;
  renaming: RenameState | null;
  shared: ItemShared;
}

function RenameField({ renaming, shared }: { renaming: RenameState; shared: ItemShared }): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Enter and Escape both blur the field; the blur must not commit a second time.
  const settled = useRef(false);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // The stem is what people change; the extension stays unless they reach for it.
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }, []);
  return (
    <Input
      ref={inputRef}
      inputSize="sm"
      className={styles.rename}
      value={renaming.draft}
      disabled={renaming.saving}
      spellCheck={false}
      autoComplete="off"
      aria-label={shared.t('common.rename')}
      onChange={(event) => shared.onRenameChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The keys belong to the text: Backspace must not leave the folder, arrows must not move cards.
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          settled.current = true;
          shared.onRenameCommit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          settled.current = true;
          shared.onRenameCancel();
        }
      }}
      onBlur={() => {
        if (!settled.current) shared.onRenameCommit();
      }}
    />
  );
}

function FileName({ label }: { label: string }): JSX.Element {
  const { head, tail } = splitDisplayName(label);
  return (
    <span className={styles.name}>
      <span className={styles.nameHead}>{head}</span>
      {tail ? <span className={styles.nameTail}>{tail}</span> : null}
    </span>
  );
}

function MoreButton({ shared, variant }: { shared: ItemShared; variant: 'frosted' | 'quiet' }): JSX.Element {
  return (
    <IconButton
      size="xs"
      variant={variant}
      className={styles.more}
      aria-label={shared.t('workspace.files.more')}
      tooltip={false}
      // Reached with the context-menu key from the item itself; one tab stop per library.
      tabIndex={-1}
      data-files-more=""
      onClick={(event) => {
        event.stopPropagation();
        shared.onMore(event.currentTarget);
      }}
    >
      <Ellipsis aria-hidden="true" strokeWidth={1.75} />
    </IconButton>
  );
}

function itemAttributes({ entry, active, selected, shared }: ItemProps) {
  return {
    role: 'option' as const,
    'aria-selected': entry.type === 'file' ? selected : undefined,
    tabIndex: active ? 0 : -1,
    'data-entry-id': entry.id,
    'data-entry-type': entry.type,
    'data-active': active || undefined,
    'data-selected': selected || undefined,
    onClick: (event: MouseEvent) => shared.onPick(entry, event),
    onFocus: () => shared.onFocus(entry.id),
  };
}

const FileCard = memo(function FileCard(props: ItemProps) {
  const { entry, writing, renaming, shared } = props;
  if (entry.type !== 'file') return null;
  const { item } = entry;
  const { t } = shared;
  const where = relativeDir(item, shared.currentDir);
  const second = shared.sortKey === 'size' ? formatBytes(item.file.size) : timeLabel(t, item.file.mtime, shared.now);
  return (
    <div
      {...itemAttributes(props)}
      className={styles.card}
      title={item.path}
      data-testid={`design-file-row-${item.path}`}
      data-writing={writing || undefined}
    >
      <div className={styles.preview}>
        <FilePreview projectId={shared.projectId} item={item} />
        {renaming ? null : <MoreButton shared={shared} variant="frosted" />}
      </div>
      {renaming ? (
        <div className={styles.cardText}>
          <RenameField renaming={renaming} shared={shared} />
        </div>
      ) : (
        <div className={styles.cardText}>
          <FileName label={item.label} />
          {writing ? (
            <span className={styles.meta} data-writing="">
              <Dot tone="running" size="sm" />
              {t('artifact.cards.writing')}
            </span>
          ) : (
            <span className={styles.meta}>
              {/* Below the open folder, where the file lives says more than its type: the preview shows that. */}
              {where || t(KIND_LABEL[item.kind])} · {second}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

const CompactTile = memo(function CompactTile(props: ItemProps) {
  const { entry, shared } = props;
  const { t } = shared;
  if (entry.type === 'file') return null;
  const isFolder = entry.type === 'folder';
  const Glyph = isFolder ? Folder : Activity;
  const label = isFolder ? entry.folder.label : entry.artifact.title;
  const meta = isFolder
    ? `${folderMeta(t, entry.folder)} · ${timeLabel(t, entry.folder.mtime, shared.now)}`
    : `${t('designFiles.kindLiveArtifact')} · ${timeLabel(t, Date.parse(entry.artifact.updatedAt) || shared.now, shared.now)}`;
  return (
    <div
      {...itemAttributes(props)}
      className={styles.tile}
      title={isFolder ? entry.folder.path : entry.artifact.title}
      data-testid={isFolder ? `files-folder-${entry.folder.path}` : `design-file-row-${entry.artifact.tabId}`}
    >
      <Glyph className={styles.tileGlyph} size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
      <span className={styles.tileText}>
        <span className={styles.name}>
          <span className={styles.nameHead}>{label}</span>
        </span>
        <span className={styles.meta}>{meta}</span>
      </span>
    </div>
  );
});

const ListRow = memo(function ListRow(props: ItemProps) {
  const { entry, writing, renaming, shared } = props;
  const { t } = shared;
  let Glyph = Folder;
  let label: string;
  let where = '';
  let modified: number;
  let size = '';
  let kind: string;
  let testId: string;
  let title: string;
  if (entry.type === 'file') {
    const { item } = entry;
    Glyph = pickFileIcon(item.path, item.file.mime);
    label = item.label;
    where = relativeDir(item, shared.currentDir);
    modified = item.file.mtime;
    size = formatBytes(item.file.size);
    kind = t(KIND_LABEL[item.kind]);
    testId = `design-file-row-${item.path}`;
    title = item.path;
  } else if (entry.type === 'folder') {
    label = entry.folder.label;
    modified = entry.folder.mtime;
    size = folderMeta(t, entry.folder);
    kind = t('designFiles.kindFolder');
    testId = `files-folder-${entry.folder.path}`;
    title = entry.folder.path;
  } else {
    Glyph = Activity;
    label = entry.artifact.title;
    modified = Date.parse(entry.artifact.updatedAt) || shared.now;
    kind = t('designFiles.kindLiveArtifact');
    testId = `design-file-row-${entry.artifact.tabId}`;
    title = entry.artifact.title;
  }
  return (
    <div {...itemAttributes(props)} className={styles.row} title={title} data-testid={testId} data-writing={writing || undefined}>
      <span className={styles.cellName}>
        <Glyph className={styles.rowGlyph} size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
        {renaming ? (
          <RenameField renaming={renaming} shared={shared} />
        ) : (
          <>
            {entry.type === 'file' ? <FileName label={label} /> : <span className={styles.name}><span className={styles.nameHead}>{label}</span></span>}
            {where ? <span className={styles.where}>{where}</span> : null}
          </>
        )}
      </span>
      <span className={styles.cell} data-column="modified">
        {writing ? (
          <span className={styles.meta} data-writing="">
            <Dot tone="running" size="sm" />
            {t('artifact.cards.writing')}
          </span>
        ) : (
          timeLabel(t, modified, shared.now)
        )}
      </span>
      <span className={styles.cell} data-column="size">
        {size}
      </span>
      <span className={styles.cell} data-column="kind">
        {kind}
      </span>
      <span className={styles.rowEnd}>{entry.type === 'file' && !renaming ? <MoreButton shared={shared} variant="quiet" /> : null}</span>
    </div>
  );
});

// ── list header ───────────────────────────────────────────────────────────────────────────────

const COLUMNS: ReadonlyArray<{ key: LibrarySortKey; column: string; label: keyof Dict }> = [
  { key: 'name', column: 'name', label: 'designFiles.colName' },
  { key: 'modified', column: 'modified', label: 'designFiles.colModified' },
  { key: 'size', column: 'size', label: 'workspace.files.size' },
  { key: 'type', column: 'kind', label: 'designFiles.colKind' },
];

function ListHeader({ sort, t, onSort }: { sort: LibrarySort; t: Translate; onSort(key: LibrarySortKey): void }): JSX.Element {
  return (
    <div className={styles.listHead} data-files-list-head="">
      {COLUMNS.map(({ key, column, label }) => {
        const on = sort.key === key;
        const Arrow = sort.direction === 'asc' ? ArrowUp : ArrowDown;
        return (
          <span key={key} className={styles.headCell} data-column={column}>
            <Button
              variant="bare"
              size="sm"
              className={styles.headButton}
              data-on={on || undefined}
              aria-label={`${t('workspace.files.sort')}: ${t(label)}`}
              onClick={() => onSort(key)}
            >
              {t(label)}
              {on ? <Arrow aria-hidden="true" strokeWidth={1.75} /> : null}
            </Button>
          </span>
        );
      })}
      <span className={styles.rowEnd} />
    </div>
  );
}

// ── content ───────────────────────────────────────────────────────────────────────────────────

export interface LibraryContentProps {
  projectId: string;
  view: LibraryViewMode;
  entries: readonly LibraryEntry[];
  currentDir: string;
  sort: LibrarySort;
  /** Width of the scrolling element. */
  width: number;
  selected: ReadonlySet<string>;
  writing: ReadonlySet<string>;
  renaming: RenameState | null;
  now: number;
  viewerOnly: boolean;
  label: string;
  t: Translate;
  /** The element that scrolls; owned by the surface, which also restores its position. */
  scrollRef: RefObject<HTMLElement>;
  onSort(key: LibrarySortKey): void;
  onOpen(entry: LibraryEntry): void;
  onSelect(paths: Set<string>): void;
  onRenameStart(path: string): void;
  onRenameChange(draft: string): void;
  onRenameCommit(): void;
  onRenameCancel(): void;
  onDelete(paths: string[]): void;
  onGoUp(): void;
  /** Opens the item's menu at an element (the "more" button). */
  onMore(element: HTMLElement): void;
}

export function LibraryContent({
  projectId,
  view,
  entries,
  currentDir,
  sort,
  width,
  selected,
  writing,
  renaming,
  now,
  viewerOnly,
  label,
  t,
  scrollRef,
  onSort,
  onOpen,
  onSelect,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onGoUp,
  onMore,
}: LibraryContentProps): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  const geometry = useMemo(() => gridGeometry(width), [width]);
  const rows = useMemo(() => buildRows(entries, view, geometry), [entries, view, geometry]);

  /** Where each entry sits: its row, and its place in that row. */
  const positions = useMemo(() => {
    const map = new Map<string, { row: number; column: number }>();
    rows.forEach((row, rowIndex) => row.entries.forEach((entry, column) => map.set(entry.id, { row: rowIndex, column })));
    return map;
  }, [rows]);
  const order = useMemo(() => rows.flatMap((row) => row.entries), [rows]);
  const indexById = useMemo(() => new Map(order.map((entry, index) => [entry.id, index] as const)), [order]);

  // The item the arrow keys last landed on. Gone (a filter, a rename) falls back to the first item.
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeEntry = (activeId !== null ? order[indexById.get(activeId) ?? -1] : undefined) ?? order[0];
  const activeRow = activeEntry ? (positions.get(activeEntry.id)?.row ?? -1) : -1;
  /** Set by a key press: the next commit moves DOM focus to the active item. */
  const focusPending = useRef(false);
  /** Where a Shift-click range starts. */
  const anchorId = useRef<string | null>(null);

  // The list sits below the list header inside the scroller.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const margin = listRef.current?.offsetTop ?? 0;
    if (margin !== scrollMargin) setScrollMargin(margin);
  });

  // The tab stop must exist even when it is scrolled far away, or focus falls to <body> the moment
  // the virtualiser recycles its row.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (activeRow >= 0 && activeRow < range.count && !indexes.includes(activeRow)) {
        indexes.push(activeRow);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    [activeRow],
  );
  const getItemKey = useCallback((index: number) => rows[index]?.key ?? index, [rows]);
  const estimateSize = useCallback((index: number) => rows[index]?.height ?? LIST_ROW, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: view === 'grid' ? 2 : 12,
    scrollMargin,
    initialRect: { width: 640, height: 720 },
    rangeExtractor,
    getItemKey,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  // Row heights follow the panel width and the view; the virtualiser caches them per index.
  useLayoutEffect(() => {
    virtualizerRef.current.measure();
  }, [geometry.cardRow, geometry.columns, view, rows.length]);

  const focusActive = useCallback(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active]')?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!focusPending.current || activeRow < 0) return;
    focusPending.current = false;
    virtualizerRef.current.scrollToIndex(activeRow, { align: 'auto' });
    focusActive();
  }, [activeRow, activeEntry?.id, rows, focusActive]);

  // Leaving the rename field gives focus back to the item that was being renamed.
  const wasRenaming = useRef<string | null>(null);
  useEffect(() => {
    const previous = wasRenaming.current;
    wasRenaming.current = renaming?.path ?? null;
    if (previous && !renaming && listRef.current?.querySelector('[data-active]')) focusActive();
  }, [renaming, focusActive]);

  const moveTo = (index: number): void => {
    const target = order[Math.min(order.length - 1, Math.max(0, index))];
    if (!target) return;
    if (target.id === activeEntry?.id) {
      focusActive();
      return;
    }
    focusPending.current = true;
    setActiveId(target.id);
  };

  /** One row up or down, keeping the column where the row is long enough. */
  const moveRows = (delta: number): void => {
    if (!activeEntry) return;
    const at = positions.get(activeEntry.id);
    if (!at) return;
    const row = rows[at.row + delta];
    if (!row) return;
    const target = row.entries[Math.min(at.column, row.entries.length - 1)];
    if (target) moveTo(indexById.get(target.id) ?? 0);
  };

  const filePaths = useMemo(() => order.flatMap((entry) => (entry.type === 'file' ? [entry.item.path] : [])), [order]);

  const pick = useCallback(
    (entry: LibraryEntry, event: MouseEvent) => {
      setActiveId(entry.id);
      if (entry.type === 'file' && (event.metaKey || event.ctrlKey)) {
        const next = new Set(selected);
        if (!next.delete(entry.item.path)) next.add(entry.item.path);
        anchorId.current = entry.id;
        onSelect(next);
        return;
      }
      if (entry.type === 'file' && event.shiftKey) {
        const from = indexById.get(anchorId.current ?? activeEntry?.id ?? entry.id) ?? 0;
        const to = indexById.get(entry.id) ?? 0;
        const next = new Set<string>();
        for (const candidate of order.slice(Math.min(from, to), Math.max(from, to) + 1)) {
          if (candidate.type === 'file') next.add(candidate.item.path);
        }
        onSelect(next);
        return;
      }
      anchorId.current = entry.id;
      onOpen(entry);
    },
    [selected, order, indexById, activeEntry?.id, onSelect, onOpen],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || !activeEntry) return;
    const command = event.metaKey || event.ctrlKey;
    const index = indexById.get(activeEntry.id) ?? 0;
    const activePath = activeEntry.type === 'file' ? activeEntry.item.path : null;
    if (command) {
      if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        onSelect(new Set(filePaths));
      } else if (event.key === 'Backspace' && !viewerOnly) {
        // ⌘⌫ is how a Mac deletes a file.
        const targets = selected.size > 0 ? [...selected] : activePath ? [activePath] : [];
        if (targets.length > 0) {
          event.preventDefault();
          onDelete(targets);
        }
      }
      return;
    }
    switch (event.key) {
      case 'ArrowRight':
        if (view === 'list') return;
        moveTo(index + 1);
        break;
      case 'ArrowLeft':
        if (view === 'list') return;
        moveTo(index - 1);
        break;
      case 'ArrowDown':
        if (view === 'list') moveTo(index + 1);
        else moveRows(1);
        break;
      case 'ArrowUp':
        if (view === 'list') moveTo(index - 1);
        else moveRows(-1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(order.length - 1);
        break;
      case 'Enter':
        onOpen(activeEntry);
        break;
      case ' ': {
        if (!activePath) return;
        const next = new Set(selected);
        if (!next.delete(activePath)) next.add(activePath);
        anchorId.current = activeEntry.id;
        onSelect(next);
        break;
      }
      case 'F2':
        if (!activePath || viewerOnly) return;
        onRenameStart(activePath);
        break;
      case 'Delete': {
        if (viewerOnly) return;
        const targets = selected.size > 0 ? [...selected] : activePath ? [activePath] : [];
        if (targets.length === 0) return;
        onDelete(targets);
        break;
      }
      case 'Backspace':
        if (currentDir === '') return;
        onGoUp();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const shared = useMemo<ItemShared>(
    () => ({
      projectId,
      currentDir,
      now,
      sortKey: sort.key,
      viewerOnly,
      t,
      onPick: pick,
      onFocus: setActiveId,
      onMore,
      onRenameChange,
      onRenameCommit,
      onRenameCancel,
    }),
    [projectId, currentDir, now, sort.key, viewerOnly, t, pick, onMore, onRenameChange, onRenameCommit, onRenameCancel],
  );

  return (
    <>
      {view === 'list' ? <ListHeader sort={sort} t={t} onSort={onSort} /> : null}
      <div
        ref={listRef}
        role="listbox"
        aria-label={label}
        aria-multiselectable="true"
        className={styles.list}
        data-view={view}
        data-testid="files-library"
        style={{
          height: virtualizer.getTotalSize(),
          ['--files-columns' as string]: geometry.columns,
          ['--files-preview-height' as string]: `${geometry.previewHeight}px`,
        }}
        onKeyDown={onKeyDown}
      >
        {virtualizer.getVirtualItems().map((virtual) => {
          const row = rows[virtual.index];
          if (!row) return null;
          return (
            <div
              key={virtual.key}
              role="presentation"
              className={styles.virtualRow}
              data-kind={row.kind}
              style={{ transform: `translateY(${virtual.start - scrollMargin}px)`, height: row.height }}
            >
              {row.entries.map((entry) => {
                const path = entry.type === 'file' ? entry.item.path : null;
                const props: ItemProps = {
                  entry,
                  active: entry.id === activeEntry?.id,
                  selected: path !== null && selected.has(path),
                  writing: path !== null && writing.has(path),
                  renaming: path !== null && renaming?.path === path ? renaming : null,
                  shared,
                };
                if (row.kind === 'row') return <ListRow key={entry.id} {...props} />;
                if (row.kind === 'tiles') return <CompactTile key={entry.id} {...props} />;
                return <FileCard key={entry.id} {...props} />;
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}
