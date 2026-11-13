'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/FrameLabelLayer.ts @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the screen-space layer node labels are
 *   portalled into — outside the zoomed world, so a label keeps its size, its gap to the node and crisp text at
 *   every zoom; it sits under the world so a dragged node covers another node's label.
 */
import { forwardRef } from 'react';

import styles from '../BoardView.module.css';

export { BoardLabelLayerContext } from '../context';

export const LabelLayer = forwardRef<HTMLDivElement>(function LabelLayer(_props, ref) {
  return <div ref={ref} className={styles.labels} data-testid="board-labels" />;
});
