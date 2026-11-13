'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Error face (spec 03 §4.0 states): an alert glyph, the message and one optional recovery action.
import { TriangleAlert } from 'lucide-react';

import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { BOARD_INTERACTIVE_ATTR } from '../../extensions';
import styles from './faces.module.css';
import { ICON_STROKE } from './kind-icons';

export interface ErrorFaceProps {
  message: string;
  action?: { label: string; onClick(): void };
  className?: string;
}

export function ErrorFace({ message, action, className }: ErrorFaceProps) {
  return (
    <div className={cn(styles.face, className)} role="alert" data-testid="board-face-error">
      <span className={cn(styles.glyph, styles.error)} aria-hidden>
        <TriangleAlert size={24} strokeWidth={ICON_STROKE} />
      </span>
      <span className={styles.message}>{message}</span>
      {action ? (
        <span {...{ [BOARD_INTERACTIVE_ATTR]: '' }}>
          <Button size="sm" variant="default" onClick={action.onClick} onPointerDown={(event) => event.stopPropagation()}>
            {action.label}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
