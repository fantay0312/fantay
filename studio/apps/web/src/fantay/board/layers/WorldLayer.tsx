'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/Stage.tsx (world layer L915-918) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the world element (transform and
 *   layout zoom written by the camera) with the groups sublayer, the connections and the nodes sublayer of
 *   the culled visible set (spec 03 §3.1); the node layer never clips (candidate fan-out, plan R6).
 */
import { forwardRef, memo } from 'react';

import boardStyles from '../BoardView.module.css';
import { useBoardSelector } from '../context';
import { NodeShell } from '../nodes/NodeShell';
import { EdgeLayer } from './EdgeLayer';
import { sameWorldSlice, worldSlice } from './layer-selectors';
import styles from './layers.module.css';

const WorldContent = memo(function WorldContent() {
  const slice = useBoardSelector(worldSlice, sameWorldSlice);
  return (
    <>
      <div className={styles.groups} data-testid="board-groups">
        {slice.groups.map((id) => (
          <NodeShell key={id} id={id} />
        ))}
      </div>
      <EdgeLayer />
      <div className={styles.nodes} data-testid="board-nodes">
        {slice.nodes.map((id) => (
          <NodeShell key={id} id={id} />
        ))}
      </div>
    </>
  );
});

export const WorldLayer = forwardRef<HTMLDivElement>(function WorldLayer(_props, ref) {
  return (
    <div ref={ref} className={boardStyles.world} data-testid="board-world">
      <WorldContent />
    </div>
  );
});
