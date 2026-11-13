'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Save status chip (spec 03 §6.6), read from the 04 store state the engine mirrors (`state.save`): "Saving…" once
// ops have been pending for 800 ms, offline, merged (3 s after a conflict), failed, read-only. The chip carries the
// short `board.save.*` text and the 04 `board.sync.*` sentence as its tooltip; a blocked undo is a toast.
import { useEffect, useRef, useState } from 'react';

import { useT } from '../../../i18n';
import { Spinner } from '../../ui/spinner';
import { toast } from '../../ui/toast';
import { Tooltip } from '../../ui/tooltip';
import { useBoardSelector } from '../context';
import type { DictKey } from '../model/types';
import { BOARD_CHROME_ISLAND_ATTR } from '../nodes/frame/FrameNode';
import type { EngineSaveState } from '../store/board-store';
import { CHROME_ICON_STROKE, ICONS } from './icons';
import styles from './chrome.module.css';

export const SAVING_DELAY_MS = 800;
export const MERGED_VISIBLE_MS = 3_000;

export type SaveStatusKind = 'saving' | 'offline' | 'merged' | 'failed' | 'readOnly';

export interface SaveStatusView {
  kind: SaveStatusKind;
  labelKey: DictKey;
  detailKey: DictKey;
  detailVars?: Record<string, string>;
  tone: 'default' | 'danger';
}

/** What the chip shows for a store state (null: nothing). `savingDue`: ops have been pending ≥ 800 ms. */
export function saveStatusView(
  save: EngineSaveState,
  readOnly: boolean,
  input: { savingDue: boolean; mergedVisible: boolean },
): SaveStatusView | null {
  const error = save.lastError;
  if (readOnly || error?.code === 'read-only') {
    return { kind: 'readOnly', labelKey: 'board.save.readOnly', detailKey: 'board.sync.readOnly', tone: 'default' };
  }
  if (error?.code === 'offline') {
    return { kind: 'offline', labelKey: 'board.save.offline', detailKey: 'board.sync.offline', tone: 'danger' };
  }
  if (error?.code === 'save-failed') {
    return {
      kind: 'failed',
      labelKey: 'board.save.failed',
      detailKey: 'board.sync.saveFailed',
      detailVars: { detail: error.message ?? '' },
      tone: 'danger',
    };
  }
  if (save.pendingOps > 0 && input.savingDue) {
    return { kind: 'saving', labelKey: 'board.save.saving', detailKey: 'board.save.saving', tone: 'default' };
  }
  if (error?.code === 'conflict' && input.mergedVisible) {
    return { kind: 'merged', labelKey: 'board.save.merged', detailKey: 'board.sync.conflict', tone: 'default' };
  }
  return null;
}

export function SaveStatus() {
  const t = useT();
  const save = useBoardSelector((state) => state.save);
  const readOnly = useBoardSelector((state) => state.readOnly);
  const pending = save.pendingOps > 0;
  const [savingDue, setSavingDue] = useState(false);
  const [mergedAt, setMergedAt] = useState<number | null>(null);
  const toasted = useRef<number | null>(null);

  useEffect(() => {
    if (!pending) {
      setSavingDue(false);
      return undefined;
    }
    const timer = setTimeout(() => setSavingDue(true), SAVING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const error = save.lastError;
  useEffect(() => {
    if (!error) return undefined;
    if (error.code === 'undo-blocked' && toasted.current !== error.at) {
      toasted.current = error.at;
      toast({ title: t('board.undo.blocked') });
      return undefined;
    }
    if (error.code !== 'conflict') return undefined;
    const remaining = MERGED_VISIBLE_MS - Math.max(0, Date.now() - error.at);
    if (remaining <= 0) return undefined;
    setMergedAt(error.at);
    const timer = setTimeout(() => setMergedAt((current) => (current === error.at ? null : current)), remaining);
    return () => clearTimeout(timer);
  }, [error, t]);

  const view = saveStatusView(save, readOnly, { savingDue, mergedVisible: error?.code === 'conflict' && mergedAt === error.at });
  const last = useRef<SaveStatusView | null>(null);
  if (view) last.current = view;
  const shown = view ?? last.current;
  const Glyph = shown?.kind === 'offline' ? ICONS.offline : shown?.kind === 'failed' ? ICONS.saveFailed : shown?.kind === 'readOnly' ? ICONS.readOnly : null;

  const text = shown ? <span className={styles.saveText}>{t(shown.detailKey, shown.detailVars)}</span> : null;
  return (
    <div
      className={styles.saveStatus}
      role="status"
      aria-live="polite"
      data-testid="board-save-status"
      data-state={view ? 'open' : 'closed'}
      data-kind={view?.kind ?? 'none'}
      data-tone={shown?.tone ?? 'default'}
      aria-hidden={view ? undefined : true}
      {...{ [BOARD_CHROME_ISLAND_ATTR]: '' }}
    >
      {shown?.kind === 'saving' ? <Spinner size="xs" /> : Glyph ? <Glyph size={13} strokeWidth={CHROME_ICON_STROKE} aria-hidden /> : null}
      {view && text && view.detailKey !== view.labelKey ? (
        <Tooltip label={t(view.detailKey, view.detailVars)} side="bottom">
          {text}
        </Tooltip>
      ) : (
        text
      )}
    </div>
  );
}
