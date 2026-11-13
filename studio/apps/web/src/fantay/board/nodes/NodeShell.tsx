'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/FrameView.tsx (positioned frame, shield L1203-1234) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: one memoized wrapper per node kind
 *   (spec 03 §4.0): position from the node or its drag preview, data attributes for state/live/selection, the
 *   pointer shield while live, the LOD rect, state faces, the face registry and the label.
 */
import { memo } from 'react';

import { useT } from '../../../i18n';
import { cn } from '../../ui/cn';
import boardStyles from '../BoardView.module.css';
import { useBoardEngine, useBoardSelector } from '../context';
import { formatLabel, nodeLabelSpec, type LabelSpec } from '../model/labels';
import { hasLabel, kindDefinition } from '../model/node-registry';
import type { BoardNodeKind, NodeView } from '../model/types';
import { useNodeViewFrom } from '../store/use-board';
import { MissingFace } from './common/MissingFace';
import { PendingFace } from './common/PendingFace';
import { PlaceholderFace } from './common/PlaceholderFace';
import { GroupNode } from './group/GroupNode';
import { BOARD_NODE_FACES, type NodeFaceComponent } from './node-faces';
import { NodeLabel } from './NodeLabel';
import { NoteNode } from './note/NoteNode';
import { ShapeNode } from './shape/ShapeNode';
import styles from './NodeShell.module.css';

const ENGINE_FACES: Readonly<Partial<Record<BoardNodeKind, NodeFaceComponent>>> = {
  note: NoteNode,
  shape: ShapeNode,
  group: GroupNode,
};

export function faceFor(kind: BoardNodeKind): NodeFaceComponent | null {
  return ENGINE_FACES[kind] ?? BOARD_NODE_FACES[kind as keyof typeof BOARD_NODE_FACES] ?? null;
}

function labelSpecEqual(a: LabelSpec, b: LabelSpec): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'title':
    case 'file':
    case 'url':
      return a.text === (b as typeof a).text;
    case 'variant':
      return a.index === (b as typeof a).index && a.label === (b as typeof a).label;
    case 'group': {
      const right = b as typeof a;
      return (
        a.role === right.role
        && a.title === right.title
        && a.sectionKind === right.sectionKind
        && a.count === right.count
      );
    }
    case 'generator':
      return a.surface === (b as typeof a).surface;
    case 'untitled':
      return true;
  }
}

/**
 * The shield keeps pointer events on the board while a live iframe/video is mounted. Navigate, an active Edit
 * session, Capture pick and the Comment tool on a frame lift it; holding Space always raises it (03 §4.0).
 */
export function shieldVisible(view: NodeView): boolean {
  if (!kindDefinition(view.node.kind).liveCapable || !view.live) return false;
  if (view.spaceHeld) return true;
  if (view.commenting && view.node.kind === 'frame') return false;
  if (view.mode === 'navigate') return false;
  if (view.mode === 'edit' && (view.runtime.editSession === 'active' || view.runtime.editSession === 'saving')) return false;
  if (view.mode === 'capture' && view.captureTool === 'pick') return false;
  return true;
}

function NodeFace({ view, title }: { view: NodeView; title: string }) {
  const { commands } = useBoardEngine();
  const t = useT();
  const { node, runtime } = view;
  if (runtime.phase === 'missing' && node.kind !== 'note' && node.kind !== 'shape' && node.kind !== 'group') {
    return <MissingFace onRemove={view.readOnly ? undefined : () => commands.removeNodes([node.id])} />;
  }
  if (runtime.phase === 'building' && runtime.fileMtime === undefined && (node.kind === 'frame' || node.kind === 'motion')) {
    const status = runtime.agentName ? t('board.node.state.buildingBy', { agent: runtime.agentName }) : t('board.node.state.building');
    return <PendingFace status={status} />;
  }
  const Face = faceFor(node.kind);
  if (Face) return <Face view={view} />;
  return <PlaceholderFace kind={node.kind} caption={title} />;
}

export interface NodeShellProps {
  id: string;
}

export const NodeShell = memo(function NodeShell({ id }: NodeShellProps) {
  const engine = useBoardEngine();
  const t = useT();
  const view = useNodeViewFrom(engine.store, id);
  const spec = useBoardSelector((state) => {
    const node = state.doc.nodes.get(id);
    return node ? nodeLabelSpec(state.doc, node) : ({ kind: 'untitled' } as LabelSpec);
  }, labelSpecEqual);
  if (!view) return null;
  const { node } = view;
  const def = kindDefinition(node.kind);
  const rect = view.previewRect ?? node;
  const title = formatLabel(spec, t);
  const shield = shieldVisible(view);
  return (
    <div
      className={cn(styles.node, view.runtime.phase === 'building' && boardStyles.building)}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      data-board-node=""
      data-node-id={id}
      data-kind={node.kind}
      data-state={view.runtime.phase}
      data-live={view.live ? 'true' : undefined}
      data-selected={view.selected ? '' : undefined}
      data-locked={node.locked ? '' : undefined}
      data-previewing={view.previewRect ? '' : undefined}
      data-testid="board-node"
      role="group"
      aria-label={t('board.a11y.nodeLabel', { kind: t(def.kindLabelKey), title })}
      aria-current={view.selected ? 'true' : undefined}
    >
      {view.lod ? (
        <div className={styles.lod} style={{ background: `var(--board-lod-${node.kind})` }} data-testid="board-node-lod" />
      ) : (
        <div className={styles.face}>
          <NodeFace view={view} title={title} />
        </div>
      )}
      {shield ? <div className={styles.shield} data-testid="board-node-shield" /> : null}
      {hasLabel(node) ? <NodeLabel view={view} title={title} spec={spec} /> : null}
    </div>
  );
});
