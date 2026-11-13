'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The Edit inspector (spec 03 §5.3 step 3): the upstream `ManualEditPanel`, unchanged and wrapped in `<FxLegacy>`
// (B3), bound to the frame's board Edit session (frame registry). It floats right of the frame's screen rect through
// the camera variables (clamped inside the board, so pan and zoom never re-render it) until the user drags it. The
// host region is a `data-board-interactive` island: board shortcuts never fire from inside the panel. Page styles,
// token suggestions and comments stay in Files (out of scope for the board session).
import { useEffect, useState, type CSSProperties } from 'react';

import { ManualEditPanel } from '../../../components/ManualEditPanel';
import { useT } from '../../../i18n';
import { uploadProjectFiles } from '../../../providers/registry';
import { FxLegacy } from '../../ui/fx';
import { useBoardEngine, useBoardHost, useBoardSelector } from '../context';
import { BOARD_INTERACTIVE_ATTR } from '../extensions';
import type { EngineNode } from '../model/types';
import { BOARD_CHROME_ISLAND_ATTR } from '../nodes/frame/FrameNode';
import { useFrameRegistry } from '../nodes/frame/frame-registry';
import { useEditSession } from './capture-state';
import styles from './chrome.module.css';

export const EDIT_PANEL_WIDTH = 320;
const PAD = 12;
const MAX_HEIGHT = 380;

/** Path of `target` relative to the directory of `owner` (an edited page referencing an uploaded image). */
export function relativePathFrom(owner: string, target: string): string {
  const squash = (path: string) =>
    path
      .replace(/^\/+/, '')
      .split('/')
      .reduce<string[]>((out, part) => {
        if (!part || part === '.') return out;
        if (part === '..') out.pop();
        else out.push(part);
        return out;
      }, []);
  const ownerDir = squash(owner).slice(0, -1);
  const parts = squash(target);
  let common = 0;
  while (common < ownerDir.length && common < parts.length && ownerDir[common] === parts[common]) common += 1;
  const relative = [...new Array<string>(ownerDir.length - common).fill('..'), ...parts.slice(common)].join('/');
  return relative || '.';
}

/** Right of the node's screen rect, clamped inside the board (camera variables: no re-render on pan/zoom). */
export function editPanelAnchorStyle(node: Pick<EngineNode, 'x' | 'y' | 'w'>): CSSProperties {
  return {
    position: 'absolute',
    left: `max(${PAD}px, min(calc(var(--vx, 0px) + ${node.x + node.w}px * var(--zoom, 1) + ${PAD}px), calc(100% - ${EDIT_PANEL_WIDTH + PAD}px)))`,
    right: 'auto',
    top: `max(${PAD}px, min(calc(var(--vy, 0px) + ${node.y}px * var(--zoom, 1)), calc(100% - ${MAX_HEIGHT + PAD}px)))`,
    width: EDIT_PANEL_WIDTH,
    maxHeight: `min(${MAX_HEIGHT}px, calc(100% - ${PAD * 2}px))`,
    pointerEvents: 'auto',
  };
}

export function EditPanel() {
  const t = useT();
  const engine = useBoardEngine();
  const { env } = useBoardHost();
  const registry = useFrameRegistry();
  const edit = useEditSession(registry);
  const sessionNodeId = edit?.session.nodeId ?? null;
  const node = useBoardSelector((state) => (sessionNodeId ? state.doc.nodes.get(sessionNodeId) : undefined));
  const [dragged, setDragged] = useState<{ left: number; top: number } | null>(null);

  // a new session starts anchored to its frame again
  useEffect(() => setDragged(null), [edit?.session]);

  if (!edit || !node) return null;
  const { session, state } = edit;
  const showing = state.selected !== null && (state.phase === 'active' || state.phase === 'saving' || state.phase === 'mounting');
  if (!showing) return null;
  const floatingStyle: CSSProperties = dragged
    ? { position: 'absolute', left: dragged.left, right: 'auto', top: dragged.top, width: EDIT_PANEL_WIDTH, maxHeight: `min(${MAX_HEIGHT}px, calc(100% - ${PAD * 2}px))`, pointerEvents: 'auto' }
    : editPanelAnchorStyle(node);

  return (
    <FxLegacy>
      <div
        className={styles.editHost}
        data-testid="board-edit-panel"
        {...{ [BOARD_INTERACTIVE_ATTR]: '', [BOARD_CHROME_ISLAND_ATTR]: '' }}
      >
        <ManualEditPanel
          targets={state.targets}
          selectedTarget={state.selected}
          draft={state.draft}
          history={state.history}
          error={state.error}
          canUndo={state.history.length > 0}
          canRedo={state.undone.length > 0}
          busy={state.busy}
          resetAvailable
          pageStylesEnabled={false}
          onSelectTarget={(target) => session.selectTarget(target)}
          onDraftChange={(draft) => session.setDraft(draft)}
          onStyleChange={(id, styles) => session.previewStyles(id, styles)}
          onApplyPatch={(patch, label) => void session.applyPatch(patch, label)}
          onError={(message) => session.setError(message)}
          onClearSelection={() => session.clearSelection()}
          onExit={() => engine.commands.setMode(null)}
          onCancelDraft={() => session.cancelDraft()}
          onSaveDraft={() => void session.saveDraft()}
          onResetDraft={() => session.resetDraft()}
          onUndo={() => void session.undo()}
          onRedo={() => void session.redo()}
          onPickImage={async (picked) => {
            const result = await uploadProjectFiles(env.projectId, [picked], undefined, env.workspaceContext).catch(() => null);
            const uploaded = result?.uploaded[0];
            if (!uploaded?.path) {
              session.setError(result?.error ?? t('manualEdit.uploadImageFailed'));
              return null;
            }
            env.onRefreshFiles?.();
            session.setError(null);
            return relativePathFrom(state.path, uploaded.path);
          }}
          floatingStyle={floatingStyle}
          onFloatingPositionChange={setDragged}
        />
      </div>
    </FxLegacy>
  );
}
