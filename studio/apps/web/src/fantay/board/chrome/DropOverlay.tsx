'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// OS drop feedback (spec 03 §3.13, §6.6): the dashed inset overlay with "Drop to add to the board" while files are
// dragged over the board (`ui.dropActive`), and the pulsing ghosts of uploads in flight (world rects drawn in screen
// space through the camera variables, so pan and zoom never re-render them).
import { useT } from '../../../i18n';
import { useBoardSelector } from '../context';
import type { DropGhost } from '../interaction/drop';
import { screenBox } from '../layers/screen-space';
import styles from './chrome.module.css';

export function DropOverlay() {
  const t = useT();
  const active = useBoardSelector((state) => state.ui.dropActive);
  return (
    <div className={styles.dropOverlay} data-state={active ? 'open' : 'closed'} aria-hidden={active ? undefined : true} data-testid="board-drop-overlay">
      <span className={styles.dropHint}>{t('board.drop.hint')}</span>
    </div>
  );
}

export function UploadGhosts({ ghosts }: { ghosts: readonly DropGhost[] }) {
  if (ghosts.length === 0) return null;
  return (
    <div className={styles.ghostLayer} aria-hidden data-testid="board-upload-ghosts">
      {ghosts.map((ghost, index) => (
        <div key={`${ghost.name}-${index}`} className={styles.ghost} style={screenBox(ghost)} data-testid="board-upload-ghost">
          <span className={styles.ghostLabel}>{ghost.name}</span>
        </div>
      ))}
    </div>
  );
}
