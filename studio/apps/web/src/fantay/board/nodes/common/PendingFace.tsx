'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/GhostFrames.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the ghost skeleton visuals only (three
 *   pulsing bars and a status line) as a node face for a page the agent is still writing; the data source is
 *   the node runtime, styles are a CSS module.
 */
import boardStyles from '../../BoardView.module.css';
import { cn } from '../../../ui/cn';
import styles from './faces.module.css';

export interface PendingFaceProps {
  /** status line, e.g. "Claude is building" */
  status?: string;
}

export function PendingFace({ status }: PendingFaceProps) {
  return (
    <div className={cn(styles.face, styles.pending)} data-testid="board-face-pending">
      <div className={styles.bars} aria-hidden>
        <span className={cn(styles.bar, boardStyles.ghostPulse)} />
        <span className={cn(styles.bar, boardStyles.ghostPulse)} />
        <span className={cn(styles.bar, boardStyles.ghostPulse)} />
      </div>
      {status ? <span className={styles.caption}>{status}</span> : null}
    </div>
  );
}
