// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy apps/desktop/src/renderer/features/cc-agent/workdir-browse/FileTreeView.tsx
// @ 88941ba7 (Apache-2.0), by way of this repository's workspace/code/FileTree.tsx: a tree as a flat
// row array at one fixed pitch, rendered through @tanstack/react-virtual, with the focused row
// pinned into the rendered window, arrow-key navigation with roving focus and the flat ARIA tree.
// Changed here: rows carry a size and a date column (an archive listing is a table as much as a
// tree), a folder shows the total of what is inside it, and the 代码 surface's change markers and
// reveal requests are gone.
'use client';

import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { ChevronRight, Link2, Lock } from 'lucide-react';
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import { TREE_INDENT, TREE_ROW_HEIGHT, type FileTreeRow } from '../../../workspace/code/file-tree';
import { pickFileIcon } from '../../../workspace/code/file-visual';
import { formatBytes } from '../../use-artifact-source';
import styles from '../ArchiveViewer.module.css';
import type { ArchiveEntry } from './archive-reader';
import type { ArchiveTree as ArchiveTreeModel } from './archive-tree';

const OVERSCAN = 12;
const INITIAL_RECT = { width: 480, height: 640 };
const estimateSize = (): number => TREE_ROW_HEIGHT;

/** Identity of a row. A damaged archive can hold a file and a folder under one path. */
function rowKey(row: FileTreeRow): string {
  return `${row.node.kind}:${row.node.path}`;
}

export interface ArchiveTreeLabels {
  tree: string;
  encrypted: string;
  link: string;
}

export interface ArchiveTreeProps {
  rows: readonly FileTreeRow[];
  model: ArchiveTreeModel;
  selectedPath: string | null;
  /** The element that scrolls. The rows start `scrollMargin` px below its top (the column header). */
  scrollRef: RefObject<HTMLDivElement>;
  scrollMargin: number;
  labels: ArchiveTreeLabels;
  /** True while a filter forces every folder open, so folders cannot be closed. */
  lockExpansion: boolean;
  formatDate(time: number): string;
  onToggleDir(path: string, open?: boolean): void;
  onSelectFile(path: string): void;
}

interface TreeRowProps {
  row: FileTreeRow;
  offset: number;
  active: boolean;
  selected: boolean;
  entry: ArchiveEntry | null;
  size: number;
  date: string;
  labels: ArchiveTreeLabels;
  onActivate(row: FileTreeRow): void;
}

const TreeRow = memo(function TreeRow({ row, offset, active, selected, entry, size, date, labels, onActivate }: TreeRowProps) {
  const { node, depth } = row;
  const isDir = node.kind === 'dir';
  const Glyph = isDir ? ChevronRight : pickFileIcon(node.path);
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={isDir ? row.expanded : undefined}
      aria-selected={isDir ? undefined : selected}
      tabIndex={active ? 0 : -1}
      className={styles.row}
      data-path={node.path}
      data-kind={node.kind}
      data-active={active || undefined}
      data-selected={selected || undefined}
      data-expanded={isDir ? row.expanded : undefined}
      title={node.path}
      style={{ transform: `translateY(${offset}px)`, paddingInlineStart: 10 + depth * TREE_INDENT }}
      onClick={() => onActivate(row)}
    >
      <Glyph className={styles.rowGlyph} size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
      <span className={styles.rowLabel}>{node.label}</span>
      {entry?.encrypted ? (
        <Lock className={styles.rowBadge} size={12} strokeWidth={1.75} role="img" aria-label={labels.encrypted} />
      ) : entry?.kind === 'link' ? (
        <Link2 className={styles.rowBadge} size={12} strokeWidth={1.75} role="img" aria-label={labels.link} />
      ) : null}
      <span className={styles.rowDate}>{date}</span>
      <span className={styles.rowSize}>{entry?.kind === 'link' ? '' : formatBytes(size)}</span>
    </div>
  );
});

export function ArchiveTree({
  rows,
  model,
  selectedPath,
  scrollRef,
  scrollMargin,
  labels,
  lockExpansion,
  formatDate,
  onToggleDir,
  onSelectFile,
}: ArchiveTreeProps): JSX.Element {
  const treeRef = useRef<HTMLDivElement | null>(null);
  // The row arrow keys last landed on. Null (or gone) falls back to the selected file, then row 0.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Set by a key press: the next commit moves DOM focus to the active row.
  const focusPending = useRef(false);

  const indexByKey = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(rowKey(row), index));
    return map;
  }, [rows]);

  const activeIndex =
    (activeKey !== null ? indexByKey.get(activeKey) : undefined) ??
    (selectedPath !== null ? indexByKey.get(`file:${selectedPath}`) : undefined) ??
    (rows.length > 0 ? 0 : -1);

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

  // Stable keys: expanding a folder shifts indexes, the rows themselves stay the same.
  const getItemKey = useCallback((index: number) => (rows[index] ? rowKey(rows[index]) : index), [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: OVERSCAN,
    scrollMargin,
    initialRect: INITIAL_RECT,
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

  const activate = useCallback(
    (row: FileTreeRow) => {
      setActiveKey(rowKey(row));
      if (row.node.kind === 'file') onSelectFile(row.node.path);
      else if (!lockExpansion) onToggleDir(row.node.path);
    },
    [lockExpansion, onSelectFile, onToggleDir],
  );

  const moveTo = (index: number): void => {
    const target = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!target) return;
    if (rowKey(target) === (rows[activeIndex] ? rowKey(rows[activeIndex]) : null)) {
      // Already there (first or last row): nothing re-renders, so the focus is set by hand.
      focusActiveRow();
      return;
    }
    focusPending.current = true;
    setActiveKey(rowKey(target));
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
      case 'PageDown':
        moveTo(activeIndex + 12);
        break;
      case 'PageUp':
        moveTo(activeIndex - 12);
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
      aria-label={labels.tree}
      className={styles.tree}
      style={{ height: virtualizer.getTotalSize() }}
      onKeyDown={onKeyDown}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        if (!row) return null;
        const isDir = row.node.kind === 'dir';
        const entry = isDir ? null : (model.files.get(row.node.path) ?? null);
        const size = isDir ? (model.folders.get(row.node.path)?.size ?? 0) : (entry?.size ?? 0);
        return (
          <TreeRow
            key={item.key}
            row={row}
            offset={item.start - scrollMargin}
            active={item.index === activeIndex}
            selected={!isDir && row.node.path === selectedPath}
            entry={entry}
            size={size}
            date={entry?.modified ? formatDate(entry.modified) : ''}
            labels={labels}
            onActivate={activate}
          />
        );
      })}
    </div>
  );
}
