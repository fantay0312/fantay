'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Insert ▸ Project files (spec 03 §6.2, §6.6): the renderable project files with a kind glyph and their path, a
// search field, files already on the board marked "On board" (and not selectable, invariant I1), "Add {count}".
import { useEffect, useMemo, useRef, useState } from 'react';
import { boardKindForPath, type ProjectFile } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Modal, ModalActions, ModalTitle } from '../../ui/dialog';
import { SearchField } from '../../ui/search-field';
import type { BoardNodeKind } from '../model/types';
import { KIND_ICONS, ICON_STROKE } from '../nodes/common/kind-icons';
import styles from './chrome.module.css';

export interface PickableFile {
  path: string;
  kind: BoardNodeKind;
  onBoard: boolean;
}

/** Files the board can show (directories, hidden and helper files excluded), in list order. */
export function pickableProjectFiles(files: readonly ProjectFile[], onBoard: (path: string) => boolean): PickableFile[] {
  const result: PickableFile[] = [];
  for (const file of files) {
    if (file.type === 'dir') continue;
    const kind = boardKindForPath(file.name);
    if (!kind) continue;
    result.push({ path: file.name, kind, onBoard: onBoard(file.name) });
  }
  return result;
}

export interface ProjectFilesPickerProps {
  open: boolean;
  files: readonly ProjectFile[];
  isOnBoard(path: string): boolean;
  onClose(): void;
  onAdd(paths: string[]): void;
}

export function ProjectFilesPicker({ open, files, isOnBoard, onClose, onAdd }: ProjectFilesPickerProps) {
  const t = useT();
  const search = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setPicked(new Set());
  }, [open]);

  const all = useMemo(() => (open ? pickableProjectFiles(files, isOnBoard) : []), [open, files, isOnBoard]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((entry) => entry.path.toLowerCase().includes(needle)) : all;
  }, [all, query]);

  const toggle = (path: string, on: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      aria-describedby={undefined}
      data-testid="board-files-picker"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        search.current?.focus();
      }}
    >
      <ModalTitle>{t('board.files.title')}</ModalTitle>
      <SearchField
        ref={search}
        className={styles.filesSearch}
        value={query}
        placeholder={t('common.search')}
        aria-label={t('common.search')}
        onChange={(event) => setQuery(event.target.value)}
      />
      {visible.length === 0 ? (
        <p className={styles.filesEmpty}>{t('board.files.empty')}</p>
      ) : (
        <div className={styles.filesList} role="group" aria-label={t('board.files.title')}>
          {visible.map((entry) => {
            const Glyph = KIND_ICONS[entry.kind];
            return (
              <label key={entry.path} className={styles.fileRow} data-disabled={entry.onBoard ? '' : undefined} data-testid="board-files-row">
                <Checkbox
                  checked={entry.onBoard || picked.has(entry.path)}
                  disabled={entry.onBoard}
                  onChange={(event) => toggle(entry.path, event.target.checked)}
                />
                <span className={styles.fileIcon} aria-hidden>
                  <Glyph size={15} strokeWidth={ICON_STROKE} />
                </span>
                <span className={styles.filePath} title={entry.path}>
                  {entry.path}
                </span>
                {entry.onBoard ? <span className={styles.fileBadge}>{t('board.files.onBoard')}</span> : null}
              </label>
            );
          })}
        </div>
      )}
      <ModalActions>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={picked.size === 0}
          data-testid="board-files-add"
          onClick={() => onAdd(all.filter((entry) => picked.has(entry.path)).map((entry) => entry.path))}
        >
          {t('board.files.add', { count: picked.size })}
        </Button>
      </ModalActions>
    </Modal>
  );
}
