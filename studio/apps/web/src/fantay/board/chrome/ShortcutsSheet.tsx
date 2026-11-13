'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Keyboard shortcuts (spec 03 §6.6): the `BOARD_SHORTCUTS` key caps in two columns, then the gesture tips
// (`board.shortcut.*`). Opened by "?" or the context menu; `ui.shortcutsOpen` holds the state.
import { isMacPlatform, KbdCombo } from '../../ui/kbd';
import { Modal, ModalTitle } from '../../ui/dialog';
import { useT } from '../../../i18n';
import { useBoardEngine, useBoardSelector } from '../context';
import { BOARD_SHORTCUTS, type BoardShortcutId } from '../interaction/keyboard';
import type { DictKey } from '../model/types';
import styles from './chrome.module.css';

/** Rows the gesture tips describe better (arrows, Tab cycling, Enter, Esc, F2). */
const TIP_ONLY: ReadonlySet<BoardShortcutId> = new Set<BoardShortcutId>([
  'nudge.left', 'nudge.right', 'nudge.up', 'nudge.down', 'select.next', 'select.prev', 'node.enter', 'escape', 'edit.rename',
]);

const TIPS: readonly DictKey[] = [
  'board.shortcut.pan',
  'board.shortcut.zoom',
  'board.shortcut.multiSelect',
  'board.shortcut.nudge',
  'board.shortcut.duplicateDrag',
  'board.shortcut.enter',
  'board.shortcut.exit',
  'board.shortcut.rename',
];

export function ShortcutsSheet() {
  const t = useT();
  const { store } = useBoardEngine();
  const open = useBoardSelector((state) => state.ui.shortcutsOpen);
  const mac = isMacPlatform();
  const vars = { mod: mac ? '⌘' : 'Ctrl', alt: mac ? '⌥' : 'Alt' };
  return (
    <Modal open={open} onClose={() => store.setUi({ shortcutsOpen: false })} size="lg" aria-describedby={undefined} data-testid="board-shortcuts">
      <ModalTitle>{t('board.shortcuts.title')}</ModalTitle>
      <div className={styles.shortcutsGrid}>
        {BOARD_SHORTCUTS.filter((shortcut) => !TIP_ONLY.has(shortcut.id)).map((shortcut) => (
          <div key={shortcut.id} className={styles.shortcutRow} data-testid={`board-shortcut-${shortcut.id}`}>
            <span>{t(shortcut.labelKey)}</span>
            <KbdCombo shortcut={shortcut.keys} />
          </div>
        ))}
      </div>
      <ul className={styles.shortcutTips}>
        {TIPS.map((key) => (
          <li key={key}>{t(key, vars)}</li>
        ))}
      </ul>
    </Modal>
  );
}
