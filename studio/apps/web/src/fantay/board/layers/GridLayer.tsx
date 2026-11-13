'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/Stage.tsx (dot grid layer L906-909) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the dot grid element; the camera
 *   controller writes its period, offset and opacity (spec 03 §3.2), React never re-renders it.
 */
import { forwardRef } from 'react';

import styles from '../BoardView.module.css';

export const GridLayer = forwardRef<HTMLDivElement>(function GridLayer(_props, ref) {
  return <div ref={ref} className={styles.grid} aria-hidden data-testid="board-grid" />;
});
