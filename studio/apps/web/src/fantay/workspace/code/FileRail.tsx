// fx-governance-allow-raw: the filter is a bare field in a tray and a changed-file row is a whole list row, which no input or button primitive models
// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy apps/desktop/src/renderer/features/right-sidebar/plugins/file-browser/FileBrowserBody.tsx
// and features/cc-agent/workdir-browse/FileFilterInput.tsx @ 88941ba7 (Apache-2.0): the tree pane of
// the file browser, a filter field above one scroller. Changed here: the scroller first lists what
// this turn changed, then the whole tree, and the filter narrows both in place instead of swapping
// the tree for a result list.
import { Search, X } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import { useT } from '../../../i18n';
import type { TurnFileChange } from '../surfaces/surface-types';
import styles from './CodeSurface.module.css';
import { FileTree, type FileTreeHandle } from './FileTree';
import { ancestorPaths, filterFileTree, flattenFileTree, type FileTreeNode } from './file-tree';

export interface FileRailProps {
  tree: readonly FileTreeNode[];
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  turnChanges: readonly TurnFileChange[];
  /** True for a path that is in the file list (a changed file may not be listed yet). */
  hasFile(path: string): boolean;
  reveal: { path: string; tick: number } | null;
  filterRef: RefObject<HTMLInputElement>;
  onSelectFile(path: string, from: 'tree' | 'changes'): void;
  onToggleDir(path: string, open?: boolean): void;
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

/** "+12 −3", each half only when it is not zero. */
export function ChangeCounts({ added, removed }: { added: number; removed: number }): JSX.Element | null {
  if (added === 0 && removed === 0) return null;
  return (
    <span className={styles.counts}>
      {added > 0 ? <span className={styles.countAdded}>+{added}</span> : null}
      {removed > 0 ? <span className={styles.countRemoved}>−{removed}</span> : null}
    </span>
  );
}

export function FileRail({
  tree,
  expanded,
  selectedPath,
  turnChanges,
  hasFile,
  reveal,
  filterRef,
  onSelectFile,
  onToggleDir,
}: FileRailProps): JSX.Element {
  const t = useT();
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const treeHandle = useRef<FileTreeHandle | null>(null);
  // Kept here, not in the tree: the tree unmounts while the filter matches nothing.
  const answeredReveal = useRef(0);
  const changedLabelId = useId();
  // Stable, so the memoised tree rows do not re-render on every keystroke in the filter.
  const selectFromTree = useCallback((path: string) => onSelectFile(path, 'tree'), [onSelectFile]);

  const needle = filter.trim().toLowerCase();
  const filtering = needle.length > 0;

  // Keyed on the tree (one per file list) and the filter, never on a render.
  const visibleTree = useMemo(() => filterFileTree(tree, needle), [tree, needle]);
  const rows = useMemo(
    () => flattenFileTree(visibleTree, filtering ? 'all' : expanded),
    [visibleTree, filtering, expanded],
  );

  const changes = useMemo(
    () => (filtering ? turnChanges.filter((change) => change.path.toLowerCase().includes(needle)) : turnChanges),
    [turnChanges, filtering, needle],
  );
  const changedFiles = useMemo(() => {
    const set = new Set<string>();
    for (const change of turnChanges) if (change.status !== 'deleted') set.add(change.path);
    return set;
  }, [turnChanges]);
  const changedDirs = useMemo(() => {
    const set = new Set<string>();
    for (const path of changedFiles) for (const dir of ancestorPaths(path)) set.add(dir);
    return set;
  }, [changedFiles]);

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && filter !== '') {
      // The first Escape clears the field; only an empty field lets it through to close the panel.
      event.preventDefault();
      event.stopPropagation();
      setFilter('');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      treeHandle.current?.focus();
    }
  };

  const showChanges = changes.length > 0;
  const noMatches = filtering && rows.length === 0 && !showChanges;

  return (
    <>
      <div className={styles.filter}>
        <Search className={styles.filterIcon} size={14} strokeWidth={1.75} aria-hidden="true" />
        <input
          ref={filterRef}
          type="text"
          className={styles.filterInput}
          value={filter}
          placeholder={t('workspace.code.filterPlaceholder')}
          aria-label={t('workspace.code.filterPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={onFilterKeyDown}
        />
        {filter !== '' ? (
          <button
            type="button"
            className={`${styles.control} ${styles.filterClear}`}
            aria-label={t('common.clear')}
            title={t('common.clear')}
            onClick={() => {
              setFilter('');
              filterRef.current?.focus();
            }}
          >
            <X size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <div ref={scrollRef} className={styles.railScroll}>
        {showChanges ? (
          <>
            <div className={styles.sectionLabel} id={changedLabelId}>
              {t('workspace.code.changedSection')}
            </div>
            <ul className={styles.changedList} aria-labelledby={changedLabelId}>
              {changes.map((change) => {
                const { name, dir } = splitPath(change.path);
                const selectable = change.status !== 'deleted' && hasFile(change.path);
                return (
                  <li key={change.path}>
                    <button
                      type="button"
                      className={`${styles.control} ${styles.changedRow}`}
                      data-status={change.status}
                      data-selected={(selectable && change.path === selectedPath) || undefined}
                      aria-current={selectable && change.path === selectedPath ? 'true' : undefined}
                      disabled={!selectable}
                      title={change.path}
                      onClick={() => onSelectFile(change.path, 'changes')}
                    >
                      <span className={styles.changedText}>
                        <span className={styles.changedName}>{name}</span>
                        {dir ? <span className={styles.changedDir}>{dir}</span> : null}
                      </span>
                      <ChangeCounts added={change.added} removed={change.removed} />
                    </button>
                  </li>
                );
              })}
            </ul>
            {rows.length > 0 ? <div className={styles.sectionLabel}>{t('workspace.code.allFiles')}</div> : null}
          </>
        ) : null}
        {rows.length > 0 ? (
          <FileTree
            rows={rows}
            selectedPath={selectedPath}
            changedFiles={changedFiles}
            changedDirs={changedDirs}
            scrollRef={scrollRef}
            reveal={reveal}
            answeredReveal={answeredReveal}
            label={t('workspace.code.allFiles')}
            lockExpansion={filtering}
            onToggleDir={onToggleDir}
            onSelectFile={selectFromTree}
            handleRef={treeHandle}
          />
        ) : null}
        {noMatches ? <p className={styles.railEmpty}>{t('workspace.code.noMatches')}</p> : null}
      </div>
    </>
  );
}
