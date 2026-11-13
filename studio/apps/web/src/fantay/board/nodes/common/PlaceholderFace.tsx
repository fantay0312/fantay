'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Placeholder face (spec 03 §4.0): the kind glyph and a caption on the hatch an empty page shows. Used for kinds
// whose face is not registered yet and for nodes without a cover.
import { cn } from '../../../ui/cn';
import type { BoardNodeKind } from '../../model/types';
import styles from './faces.module.css';
import { ICON_STROKE, KIND_ICONS } from './kind-icons';

export interface PlaceholderFaceProps {
  kind: BoardNodeKind;
  caption?: string;
  className?: string;
}

export function PlaceholderFace({ kind, caption, className }: PlaceholderFaceProps) {
  const Glyph = KIND_ICONS[kind];
  return (
    <div className={cn(styles.face, styles.placeholder, className)} data-testid="board-face-placeholder">
      <span className={styles.glyph} aria-hidden>
        <Glyph size={28} strokeWidth={ICON_STROKE} />
      </span>
      {caption ? <span className={styles.caption}>{caption}</span> : null}
    </div>
  );
}
