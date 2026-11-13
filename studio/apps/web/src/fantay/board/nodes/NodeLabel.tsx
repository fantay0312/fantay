'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/FrameView.tsx (frame title portal L1082-1157) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the label is portalled into the
 *   screen-space label layer and positioned with the camera's CSS variables (no re-render on pan/zoom); kind
 *   glyph with status dot, source tag, state chip and the inline rename field (input behaviour after
 *   infinite-canvas canvas-node.tsx L340-375, MIT, commit 9cd3deacbcc598361807afc16c059a80dd18b6f9).
 */
import { memo, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock } from 'lucide-react';

import { useT } from '../../../i18n';
import { Input } from '../../ui/input';
import { cn } from '../../ui/cn';
import boardStyles from '../BoardView.module.css';
import { BoardLabelLayerContext, useBoardEngine } from '../context';
import { BOARD_INTERACTIVE_ATTR } from '../extensions';
import { isLocalUrl, type LabelSpec } from '../model/labels';
import type { BoardTranslate, NodeView } from '../model/types';
import { ICON_STROKE, KIND_ICONS } from './common/kind-icons';
import styles from './NodeLabel.module.css';

export interface NodeLabelProps {
  view: NodeView;
  title: string;
  spec: LabelSpec;
}

/** Status chip text of a node, or null. */
export function labelChip(view: NodeView, t: BoardTranslate): { text: string; tone: 'brand' | 'error'; busy: boolean } | null {
  const { runtime, node } = view;
  if (runtime.phase === 'building') {
    return {
      text: runtime.agentName ? t('board.node.state.buildingBy', { agent: runtime.agentName }) : t('board.node.state.building'),
      tone: 'brand',
      busy: true,
    };
  }
  const pending = node.kind === 'image' || node.kind === 'video' || node.kind === 'audio' ? node.data.pending : undefined;
  if (runtime.phase === 'streaming') {
    if (typeof runtime.progress === 'number') {
      return { text: t('board.node.state.generating', { percent: Math.round(runtime.progress * 100) }), tone: 'brand', busy: true };
    }
    return { text: t(pending?.status === 'queued' ? 'board.node.pending.queued' : 'board.node.pending.running'), tone: 'brand', busy: pending?.status !== 'queued' };
  }
  if (pending?.status === 'failed') return { text: t('board.node.pending.failed'), tone: 'error', busy: false };
  if (pending?.status === 'interrupted') return { text: t('board.node.pending.interrupted'), tone: 'error', busy: false };
  return null;
}

function sourceTag(view: NodeView, t: BoardTranslate): string | null {
  const { node } = view;
  if (node.kind === 'web' && isLocalUrl(node.data.url)) return t('board.node.tagLocal');
  if (node.kind === 'frame' && typeof node.data.liveArtifactId === 'string') return t('board.node.tagLiveArtifact');
  return null;
}

function dotTone(view: NodeView): 'live' | 'building' | 'error' | null {
  if (view.runtime.phase === 'building') return 'building';
  if (view.runtime.phase === 'error' || view.runtime.phase === 'missing') return 'error';
  if (view.live) return 'live';
  return null;
}

export const NodeLabel = memo(function NodeLabel({ view, title, spec }: NodeLabelProps) {
  const host = useContext(BoardLabelLayerContext);
  const t = useT();
  const { commands } = useBoardEngine();
  const { node } = view;
  const rect = view.previewRect ?? node;
  const Glyph = KIND_ICONS[node.kind];
  const chip = labelChip(view, t);
  const tag = sourceTag(view, t);
  const tone = dotTone(view);
  if (!host) return null;
  const style = {
    left: `calc(var(--vx, 0px) + ${rect.x}px * var(--zoom, 1))`,
    top: `calc(var(--vy, 0px) + ${rect.y}px * var(--zoom, 1))`,
    width: `calc(${rect.w}px * var(--zoom, 1))`,
  };
  return createPortal(
    <div
      className={styles.label}
      style={style}
      data-board-label=""
      data-node-id={node.id}
      data-selected={view.selected ? '' : undefined}
      data-testid="board-node-label"
    >
      <div className={styles.inner}>
        <span className={styles.glyph} aria-hidden>
          <Glyph strokeWidth={ICON_STROKE} />
          {tone ? <span className={cn(styles.dot, tone === 'building' && boardStyles.streamPulse)} data-tone={tone} /> : null}
        </span>
        {view.renaming ? (
          <RenameField
            initial={node.title ?? ''}
            fallback={title}
            ariaLabel={t('board.node.renameLabel')}
            onCommit={(value) => {
              commands.stopRename();
              const next = value.trim();
              if (next !== (node.title ?? '')) commands.updateNode(node.id, { title: next.length > 0 ? next : null }, { label: 'rename' });
            }}
            onCancel={() => commands.stopRename()}
          />
        ) : (
          <>
            <span className={styles.title}>{title}</span>
            {spec.kind === 'group' && spec.role !== 'variants' ? <span className={styles.count}>· {spec.count}</span> : null}
          </>
        )}
        {node.locked ? (
          <span className={styles.lock} aria-hidden>
            <Lock size={11} strokeWidth={ICON_STROKE} />
          </span>
        ) : null}
        {tag ? <span className={styles.tag}>{tag}</span> : null}
        {node.kind === 'generator' && node.data.params?.aspect ? <span className={styles.meta}>{node.data.params.aspect}</span> : null}
        {chip ? (
          <span className={cn(styles.chip, boardStyles.chipIn)} data-tone={chip.tone}>
            <span className={chip.busy ? boardStyles.ellipsis : undefined}>{chip.text}</span>
          </span>
        ) : null}
      </div>
    </div>,
    host,
  );
});

interface RenameFieldProps {
  initial: string;
  fallback: string;
  ariaLabel: string;
  onCommit(value: string): void;
  onCancel(): void;
}

function RenameField({ initial, fallback, ariaLabel, onCommit, onCancel }: RenameFieldProps) {
  const [value, setValue] = useState(initial || fallback);
  const ref = useRef<HTMLInputElement | null>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);
  const finish = (commit: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    <span {...{ [BOARD_INTERACTIVE_ATTR]: '' }} style={{ display: 'flex', minWidth: 0, flex: '1 1 auto' }}>
      <Input
        ref={ref}
        variant="bare"
        inputSize="auto"
        className={styles.rename}
        value={value}
        maxLength={64}
        aria-label={ariaLabel}
        onChange={(event) => setValue(event.target.value)}
        onKeyDownCapture={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
      />
    </span>
  );
}
