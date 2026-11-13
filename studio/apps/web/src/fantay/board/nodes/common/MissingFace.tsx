'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Missing face (spec 03 §4.0 states): the file behind the node is gone; offers "Remove from board" (I4: the
// board never deletes files, and removing the node deletes nothing).
import { FileX } from 'lucide-react';

import { useT } from '../../../../i18n';
import { Button } from '../../../ui/button';
import { BOARD_INTERACTIVE_ATTR } from '../../extensions';
import styles from './faces.module.css';
import { ICON_STROKE } from './kind-icons';

export interface MissingFaceProps {
  onRemove?: () => void;
}

export function MissingFace({ onRemove }: MissingFaceProps) {
  const t = useT();
  return (
    <div className={styles.face} data-testid="board-face-missing">
      <span className={styles.glyph} aria-hidden>
        <FileX size={24} strokeWidth={ICON_STROKE} />
      </span>
      <span className={styles.message}>{t('board.node.state.missing')}</span>
      {onRemove ? (
        <span {...{ [BOARD_INTERACTIVE_ATTR]: '' }}>
          <Button size="sm" variant="ghost" onClick={onRemove} onPointerDown={(event) => event.stopPropagation()}>
            {t('board.menu.remove')}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
