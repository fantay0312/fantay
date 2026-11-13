// SPDX-License-Identifier: AGPL-3.0-only
// Board selection → composer context chip (spec 04 §7.1, plan R15): the engine passes its selection
// (`onSelectionChange(ids)`), this hook builds the single `board-selection` item and reports it through
// `host.onActiveContextChange` (the shell's arbiter) while the board is active, debounced 120 ms.
import { useEffect, useRef } from 'react';

import { useT } from '../../../i18n';
import { useBoardData, useBoardState } from '../data/BoardDataProvider';
import { BOARD_SELECTION_CONTEXT_DEBOUNCE_MS } from '../data/constants';
import { boardSelectionContextItem } from './context-items';

export function useBoardSelectionContextSync({ selectedIds }: { selectedIds: readonly string[] }): void {
  const { host } = useBoardData();
  const t = useT();
  const board = useBoardState((state) => state.board);
  const hostRef = useRef(host);
  hostRef.current = host;
  /** Signature of the last reported item (undefined: nothing reported since the board became active). */
  const reported = useRef<string | null | undefined>(undefined);
  const idsKey = selectedIds.join('\u0000');
  const ids = useRef(selectedIds);
  ids.current = selectedIds;

  useEffect(() => {
    if (!host.active) {
      reported.current = undefined;
      return undefined;
    }
    const item = board
      ? boardSelectionContextItem({ board, selectedIds: ids.current, t, projectDir: host.projectDir })
      : null;
    const signature = item ? [item.id, item.label, item.title ?? '', item.path ?? '', item.url ?? ''].join('\u0000') : null;
    const timer = setTimeout(() => {
      if (reported.current === signature) return;
      reported.current = signature;
      hostRef.current.onActiveContextChange(item);
    }, BOARD_SELECTION_CONTEXT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [board, idsKey, host.active, host.projectDir, t]);
}
