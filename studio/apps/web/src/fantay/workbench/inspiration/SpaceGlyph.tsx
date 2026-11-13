/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — the tinted folder glyph of a space (Resurf-style), and a plain tint dot.
 */
import type { WorkbenchSpaceColor } from '@open-design/contracts';
import styles from './tints.module.css';

export function SpaceGlyph({ color, size = 18, className }: { color: WorkbenchSpaceColor; size?: number; className?: string }) {
  return (
    <svg
      className={`${styles.tint} ${styles.glyph}${className ? ` ${className}` : ''}`}
      data-color={color}
      width={size}
      height={Math.round(size * 0.82)}
      viewBox="0 0 22 18"
      aria-hidden
    >
      <path className={styles.back} d="M1.5 3.4C1.5 2.35 2.35 1.5 3.4 1.5h4.5c.5 0 .98.2 1.33.55l1.2 1.2c.35.35.83.55 1.33.55h6.84c1.05 0 1.9.85 1.9 1.9V7H1.5z" />
      <rect className={styles.front} x="1.5" y="5" width="19" height="11.5" rx="2" />
      <path className={styles.shine} d="M3.5 6.6h15" />
    </svg>
  );
}

export function SpaceDot({ color, className }: { color: WorkbenchSpaceColor; className?: string }) {
  return <span className={`${styles.tint} ${styles.dot}${className ? ` ${className}` : ''}`} data-color={color} aria-hidden />;
}
