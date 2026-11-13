'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Screen-space overlay (spec 03 §3.1): selection outlines and handles, hover, connector dot, snap guides,
// marquee, draw preview, resize badge; pointer-events none except the handles and dots that opt in.
import { memo, useState } from 'react';

import styles from '../BoardView.module.css';
import { boardDebugEnabled, DebugOverlay } from './DebugOverlay';
import { SelectionOverlay } from './SelectionOverlay';
import { SnapGuides } from './SnapGuides';

export const OverlayLayer = memo(function OverlayLayer() {
  const [debug] = useState(boardDebugEnabled);
  return (
    <div className={styles.overlay} data-testid="board-overlay">
      <SelectionOverlay />
      <SnapGuides />
      {debug ? <DebugOverlay /> : null}
    </div>
  );
});
