'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Group face (spec 03 §4.8): sections, chat-turn groups and variant rows. Its label (always shown) carries the
// title and the member count; the body is canvas for the pointer (Figma sections).
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import styles from './group.module.css';

export function GroupNode({ view }: NodeFaceProps) {
  const node = view.node as EngineNodeOf<'group'>;
  return (
    <div
      className={styles.group}
      data-role={node.data.role}
      data-drop-target={view.dropTarget ? '' : undefined}
      data-testid="board-group"
    />
  );
}
