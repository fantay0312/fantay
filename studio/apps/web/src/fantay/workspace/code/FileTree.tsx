// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy apps/desktop/src/renderer/features/cc-agent/workdir-browse/FileTreeView.tsx
// @ 88941ba7 (Apache-2.0): a file tree as a flat row array at one fixed pitch, rendered through
// @tanstack/react-virtual so the cost follows the viewport, not the project; one row can be pinned
// into the rendered window through `rangeExtractor` (cindy pins its inline-edit row, this pins the
// focused row so keyboard focus survives scrolling).
// Added here: arrow-key navigation with roving focus and the flat ARIA tree (level / position / set
// size on each row, the form a virtualised tree takes since rows cannot nest in groups).
import {
  defaultRangeExtractor,
  observeElementRect,
  useVirtualizer,
  type Range,
  type Rect,
  type Virtualizer,
} from '@tanstack/react-virtual';
import { ChevronRight } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type RefObject,
} from 'react';

import styles from './CodeSurface.module.css';
import { pickFileIcon } from './file-visual';
import { TREE_INDENT, TREE_ROW_HEIGHT, type FileTreeRow } from './file-tree';

const OVERSCAN = 12;
/** Until the scroll element is measured, render about one rail's worth of rows. */
const INITIAL_RECT = { width: 248, height: 640 };
const estimateSize = (): number => TREE_ROW_HEIGHT;

/** No box at all: the element, or something above it, is `display: none`. */
function isHidden(element: HTMLElement | null): boolean {
  return !element || (element.clientWidth === 0 && element.clientHeight === 0);
}

export interface FileTreeProps {
  rows: readonly FileTreeRow[];
  selectedPath: string | null;
  /** Files changed this turn. */
  changedFiles: ReadonlySet<string>;
  /** Folder row paths with a changed file somewhere inside. */
  changedDirs: ReadonlySet<string>;
  /** The element that scrolls. The tree may sit below other content inside it. */
  scrollRef: RefObject<HTMLElement>;
  /** Brings a row into view; a new `tick` repeats the request for the same path. */
  reveal: { path: string; tick: number } | null;
  /** Tick of the newest reveal carried out; owned by the parent, so it outlives this tree's unmounts. */
  answeredReveal: MutableRefObject<number>;
  label: string;
  /** True while a filter forces every folder open, so folders cannot be closed. */
  lockExpansion: boolean;
  onToggleDir(path: string, open?: boolean): void;
  onSelectFile(path: string): void;
  /** Filled with the tree's imperative handle while it is mounted. */
  handleRef?: MutableRefObject<FileTreeHandle | null>;
}

export interface FileTreeHandle {
  /** Moves keyboard focus onto the tree's current row. */
  focus(): void;
}

interface TreeRowProps {
  row: FileTreeRow;
  offset: number;
  active: boolean;
  selected: boolean;
  changed: boolean;
  onActivate(row: FileTreeRow): void;
}

const TreeRow = memo(function TreeRow({ row, offset, active, selected, changed, onActivate }: TreeRowProps) {
  const { node, depth } = row;
  const isDir = node.kind === 'dir';
  const Glyph = isDir ? ChevronRight : pickFileIcon(node.path, node.file?.mime);
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={isDir ? row.expanded : undefined}
      aria-selected={isDir ? undefined : selected}
      tabIndex={active ? 0 : -1}
      className={styles.treeRow}
      data-path={node.path}
      data-kind={node.kind}
      data-active={active || undefined}
      data-selected={selected || undefined}
      data-expanded={isDir ? row.expanded : undefined}
      title={node.path}
      style={{ transform: `translateY(${offset}px)`, paddingInlineStart: 8 + depth * TREE_INDENT }}
      onClick={() => onActivate(row)}
    >
      <Glyph className={styles.treeGlyph} size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
      <span className={styles.treeLabel}>{node.label}</span>
      {changed ? <span className={styles.changeDot} data-kind={node.kind} aria-hidden="true" /> : null}
    </div>
  );
});

export function FileTree({
  rows,
  selectedPath,
  changedFiles,
  changedDirs,
  scrollRef,
  reveal,
  answeredReveal,
  label,
  lockExpansion,
  onToggleDir,
  onSelectFile,
  handleRef,
}: FileTreeProps): JSX.Element {
  const treeRef = useRef<HTMLDivElement | null>(null);
  // The row arrow keys last landed on. Null (or gone) falls back to the selected file, then row 0.
  const [activePath, setActivePath] = useState<string | null>(null);
  // A newly selected file becomes the tree's current row wherever it was picked (the changed list
  // selects without a reveal), so the tab stop never stays on a row from an earlier visit.
  const [followedPath, setFollowedPath] = useState(selectedPath);
  if (followedPath !== selectedPath) {
    setFollowedPath(selectedPath);
    setActivePath(null);
  }
  // Set by a key press: the next commit moves DOM focus to the active row.
  const focusPending = useRef(false);

  const indexByPath = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.node.path, index));
    return map;
  }, [rows]);

  const activeIndex =
    (activePath !== null ? indexByPath.get(activePath) : undefined) ??
    (selectedPath !== null ? indexByPath.get(selectedPath) : undefined) ??
    (rows.length > 0 ? 0 : -1);

  // A hidden scroller measures 0 × 0: the workspace keeps the surface mounted behind other tabs, and
  // a closed rail is `display: none`. The last real size stands meanwhile, so the rows are still
  // there on return instead of arriving a frame late; coming back re-renders once (`shownEpoch`) to
  // measure afresh and to carry out a reveal that had to wait.
  const [shownEpoch, markShown] = useReducer((count: number) => count + 1, 0);
  const observeShownRect = useCallback(
    (instance: Virtualizer<HTMLElement, Element>, report: (rect: Rect) => void) => {
      let hidden = false;
      return observeElementRect(instance, (rect) => {
        if (rect.width === 0 && rect.height === 0) {
          hidden = true;
          return;
        }
        report(rect);
        if (hidden) {
          hidden = false;
          markShown();
        }
      });
    },
    [],
  );
  // A row asked for while the scroller was hidden. A hidden element cannot scroll, and the agent
  // keeps choosing files while the person looks at another tab, so the request waits for the return.
  const pendingScroll = useRef<string | null>(null);

  // The tree starts below the filter and the changed list, inside the same scroller.
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const tree = treeRef.current;
    const scroller = scrollRef.current;
    if (!tree || !scroller) return;
    // Hidden: every rectangle reads zero, so the margin measured while showing stands.
    if (isHidden(scroller)) return;
    const margin = Math.round(
      tree.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
    );
    if (margin !== scrollMargin) setScrollMargin(margin);
  });

  // The tab stop must exist even when it is scrolled far away, or focus would fall to <body> the
  // moment the virtualiser recycles the row.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (activeIndex >= 0 && activeIndex < range.count && !indexes.includes(activeIndex)) {
        indexes.push(activeIndex);
        indexes.sort((a, b) => a - b);
      }
      return indexes;
    },
    [activeIndex],
  );

  // Stable keys: expanding a folder shifts indexes, the rows themselves stay the same. Memoised,
  // because a new key function makes the virtualiser measure every row again.
  const getItemKey = useCallback((index: number) => rows[index]?.node.path ?? index, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
    scrollMargin,
    initialRect: INITIAL_RECT,
    observeElementRect: observeShownRect,
    rangeExtractor,
    getItemKey,
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  const focusActiveRow = useCallback(() => {
    treeRef.current?.querySelector<HTMLElement>('[data-active]')?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!focusPending.current || activeIndex < 0) return;
    focusPending.current = false;
    virtualizerRef.current.scrollToIndex(activeIndex, { align: 'auto' });
    focusActiveRow();
  }, [activeIndex, rows, focusActiveRow]);

  // A reveal request: make the row the tree's current one and scroll it into view. The parent has
  // already opened its folders in the same update, so the row is in `rows` by now.
  const revealTick = reveal?.tick ?? 0;
  useEffect(() => {
    if (!reveal) return;
    // This tree unmounts while a filter matches nothing. Mounted again, it does not replay a request
    // it answered before (the person may have picked other files since): it shows the file being read.
    const fresh = reveal.tick > answeredReveal.current;
    const path = fresh ? reveal.path : selectedPath;
    const index = path === null ? undefined : indexByPath.get(path);
    if (index === undefined) return;
    if (fresh) {
      answeredReveal.current = reveal.tick;
      setActivePath(path);
    }
    if (isHidden(scrollRef.current)) {
      pendingScroll.current = path;
    } else {
      // Answered now, so an older request still parked must not follow it and scroll elsewhere.
      pendingScroll.current = null;
      virtualizerRef.current.scrollToIndex(index, { align: 'auto' });
    }
    // Only a new request re-runs this; `rows` changing under an old request must not scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTick]);

  useEffect(() => {
    const path = pendingScroll.current;
    // Also runs on mount, right after a reveal may have been parked: still hidden, it stays parked.
    if (path === null || isHidden(scrollRef.current)) return;
    pendingScroll.current = null;
    const index = indexByPath.get(path);
    if (index !== undefined) virtualizerRef.current.scrollToIndex(index, { align: 'auto' });
    // Runs when the scroller shows again, with the rows of that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownEpoch]);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { focus: focusActiveRow };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, focusActiveRow]);

  const activate = useCallback(
    (row: FileTreeRow) => {
      setActivePath(row.node.path);
      if (row.node.kind === 'file') onSelectFile(row.node.path);
      else if (!lockExpansion) onToggleDir(row.node.path);
    },
    [lockExpansion, onSelectFile, onToggleDir],
  );

  const moveTo = (index: number): void => {
    const target = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!target) return;
    if (target.node.path === rows[activeIndex]?.node.path) {
      // Already there (first or last row): nothing re-renders, so the focus is set by hand.
      focusActiveRow();
      return;
    }
    focusPending.current = true;
    setActivePath(target.node.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const row = rows[activeIndex];
    if (!row) return;
    const isDir = row.node.kind === 'dir';
    switch (event.key) {
      case 'ArrowDown':
        moveTo(activeIndex + 1);
        break;
      case 'ArrowUp':
        moveTo(activeIndex - 1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(rows.length - 1);
        break;
      case 'ArrowRight':
        if (!isDir) return;
        if (!row.expanded) onToggleDir(row.node.path, true);
        else if (row.node.children.length > 0) moveTo(activeIndex + 1);
        break;
      case 'ArrowLeft':
        if (isDir && row.expanded && !lockExpansion) onToggleDir(row.node.path, false);
        else if (row.parentIndex >= 0) moveTo(row.parentIndex);
        break;
      case 'Enter':
      case ' ':
        activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label={label}
      className={styles.tree}
      style={{ height: virtualizer.getTotalSize() }}
      onKeyDown={onKeyDown}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        const path = row.node.path;
        const isDir = row.node.kind === 'dir';
        return (
          <TreeRow
            key={item.key}
            row={row}
            offset={item.start - scrollMargin}
            active={item.index === activeIndex}
            selected={!isDir && path === selectedPath}
            // A closed folder speaks for the changes hidden inside it.
            changed={isDir ? !row.expanded && changedDirs.has(path) : changedFiles.has(path)}
            onActivate={activate}
          />
        );
      })}
    </div>
  );
}
