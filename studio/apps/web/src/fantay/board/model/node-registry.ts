// SPDX-License-Identifier: AGPL-3.0-only
// Per-kind capabilities (spec 03 §4.0 table, plan R1/R3e): minimum size, resize handles, aspect behaviour,
// live capability, label policy and whether the kind may start a `reference` connection.
import { BOARD_REFERENCE_SOURCE_KINDS, type BoardNodeKind } from '@open-design/contracts';

import type { DictKey, EngineNode, ResizeHandle, Size } from './types';

export type HandleSet = 'all' | 'corners' | 'horizontal' | 'none';
export type LabelPolicy = 'auto' | 'none' | 'always';

export interface NodeKindDefinition {
  kind: BoardNodeKind;
  minSize: Size;
  handles: HandleSet;
  /** Default aspect behaviour while resizing; ⇧ inverts it. */
  aspect: 'free' | 'locked';
  /** Frame, web and motion iframes plus mounted `<video>` count against the live budget (R6). */
  liveCapable: boolean;
  label: LabelPolicy;
  kindLabelKey: DictKey;
}

export const NODE_KINDS: Readonly<Record<BoardNodeKind, NodeKindDefinition>> = {
  frame: { kind: 'frame', minSize: { w: 240, h: 180 }, handles: 'all', aspect: 'free', liveCapable: true, label: 'auto', kindLabelKey: 'board.kind.frame' },
  web: { kind: 'web', minSize: { w: 320, h: 240 }, handles: 'all', aspect: 'free', liveCapable: true, label: 'auto', kindLabelKey: 'board.kind.web' },
  image: { kind: 'image', minSize: { w: 48, h: 48 }, handles: 'corners', aspect: 'locked', liveCapable: false, label: 'auto', kindLabelKey: 'board.kind.image' },
  video: { kind: 'video', minSize: { w: 96, h: 54 }, handles: 'corners', aspect: 'locked', liveCapable: true, label: 'auto', kindLabelKey: 'board.kind.video' },
  audio: { kind: 'audio', minSize: { w: 220, h: 72 }, handles: 'horizontal', aspect: 'free', liveCapable: false, label: 'auto', kindLabelKey: 'board.kind.audio' },
  note: { kind: 'note', minSize: { w: 120, h: 80 }, handles: 'all', aspect: 'free', liveCapable: false, label: 'none', kindLabelKey: 'board.kind.note' },
  shape: { kind: 'shape', minSize: { w: 8, h: 8 }, handles: 'all', aspect: 'free', liveCapable: false, label: 'none', kindLabelKey: 'board.kind.shape' },
  group: { kind: 'group', minSize: { w: 160, h: 120 }, handles: 'all', aspect: 'free', liveCapable: false, label: 'always', kindLabelKey: 'board.kind.group' },
  generator: { kind: 'generator', minSize: { w: 120, h: 120 }, handles: 'all', aspect: 'free', liveCapable: false, label: 'auto', kindLabelKey: 'board.kind.generator' },
  design: { kind: 'design', minSize: { w: 200, h: 140 }, handles: 'corners', aspect: 'locked', liveCapable: false, label: 'auto', kindLabelKey: 'board.kind.design' },
  motion: { kind: 'motion', minSize: { w: 240, h: 135 }, handles: 'corners', aspect: 'locked', liveCapable: true, label: 'auto', kindLabelKey: 'board.kind.motion' },
};

const ALL_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CORNER_HANDLES: readonly ResizeHandle[] = ['nw', 'ne', 'se', 'sw'];
const HORIZONTAL_HANDLES: readonly ResizeHandle[] = ['e', 'w'];
const TEXT_MIN_SIZE: Size = { w: 40, h: 24 };

export function kindDefinition(kind: BoardNodeKind): NodeKindDefinition {
  return NODE_KINDS[kind];
}

function isTextShape(node: EngineNode): boolean {
  return node.kind === 'shape' && node.data.shape === 'text';
}

export function handleSetFor(node: EngineNode): HandleSet {
  if (isTextShape(node)) return 'horizontal';
  return NODE_KINDS[node.kind].handles;
}

/** Resize handles drawn for a node (none for locked nodes is decided by the caller). */
export function handlesFor(node: EngineNode): readonly ResizeHandle[] {
  switch (handleSetFor(node)) {
    case 'all':
      return ALL_HANDLES;
    case 'corners':
      return CORNER_HANDLES;
    case 'horizontal':
      return HORIZONTAL_HANDLES;
    default:
      return [];
  }
}

export function minSizeFor(node: EngineNode): Size {
  return isTextShape(node) ? TEXT_MIN_SIZE : NODE_KINDS[node.kind].minSize;
}

/** Aspect locked by default: image, video, motion, and design once its cover is known (03 §4.0). */
export function aspectLockedByDefault(node: EngineNode): boolean {
  if (node.kind === 'design') return node.data.cover !== undefined && node.data.cover !== null;
  return NODE_KINDS[node.kind].aspect === 'locked';
}

export function isLiveCapableKind(kind: BoardNodeKind): boolean {
  return NODE_KINDS[kind].liveCapable;
}

/** Kinds that may feed a generator through a `reference` edge (plan R3e; groups are not connectable). */
export function isReferenceSource(kind: BoardNodeKind): boolean {
  return (BOARD_REFERENCE_SOURCE_KINDS as readonly BoardNodeKind[]).includes(kind);
}

export function hasLabel(node: EngineNode): boolean {
  const policy = NODE_KINDS[node.kind].label;
  return policy !== 'none';
}
