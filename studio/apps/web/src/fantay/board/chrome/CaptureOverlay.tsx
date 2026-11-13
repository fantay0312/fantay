'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Capture on the board (spec 03 §5.3): Pick highlights the element under the pointer and the picked one (brand 1 px +
// 8 % fill, a label pill above), clipped to the frame and placed through the camera variables; Enter captures the
// picked element, mod+Enter the whole page, Esc drops the pick (a second Esc leaves Capture through the board keys).
// Markup mounts `CaptureMarkupLayer` over the node. A web page captures with Markup only, on desktop only: entering
// Capture on one (keyboard ⇧C, menu, bar) switches to Markup, so the camera freezes, or leaves without the host.
import { useEffect } from 'react';
import { isOpenDesignHostAvailable } from '@open-design/host';

import { useBoardEngine, useBoardSelector } from '../context';
import type { FrameCommentTarget } from '../engine/message-router';
import { isActivationTarget, isOverlayOpen, isTypingTarget } from '../interaction/keyboard';
import { screenBox } from '../layers/screen-space';
import type { EngineNode } from '../model/types';
import { CaptureMarkupLayer } from '../nodes/frame/CaptureMarkupLayer';
import { useFrameRegistry } from '../nodes/frame/frame-registry';
import { useCaptureState } from './capture-state';
import styles from './chrome.module.css';

function TargetBox({ target, picked }: { target: FrameCommentTarget; picked: boolean }) {
  const { x, y, width, height } = target.position;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return (
    <div
      className={styles.captureBox}
      data-picked={picked ? '' : undefined}
      data-testid={picked ? 'board-capture-target' : 'board-capture-hover'}
      style={{
        left: `calc(${x}px * var(--zoom, 1))`,
        top: `calc(${y}px * var(--zoom, 1))`,
        width: `calc(${width}px * var(--zoom, 1))`,
        height: `calc(${height}px * var(--zoom, 1))`,
      }}
    >
      {target.label ? <span className={styles.captureLabel}>{target.label}</span> : null}
    </div>
  );
}

function PickHighlight({ node }: { node: EngineNode }) {
  const registry = useFrameRegistry();
  const state = useCaptureState(registry, node.id);
  if (!state || state.tool !== 'pick') return null;
  const hover = state.hover && (!state.target || state.hover.elementId !== state.target.elementId) ? state.hover : null;
  if (!hover && !state.target) return null;
  return (
    <div className={styles.captureClip} style={screenBox(node)}>
      {hover ? <TargetBox target={hover} picked={false} /> : null}
      {state.target ? <TargetBox target={state.target} picked /> : null}
    </div>
  );
}

export function CaptureOverlay({ active }: { active: boolean }) {
  const engine = useBoardEngine();
  const registry = useFrameRegistry();
  const mode = useBoardSelector((state) => state.ui.mode);
  const nodeId = mode?.mode === 'capture' ? mode.nodeId : null;
  const tool = mode?.mode === 'capture' ? mode.captureTool : null;
  const node = useBoardSelector((state) => (nodeId ? state.doc.nodes.get(nodeId) : undefined));
  const webCapture = node?.kind === 'web';

  // web pages: Markup (03 §5.3 "web: desktop markup/region"; frozen camera), never Pick; nothing without the host
  useEffect(() => {
    if (!nodeId || !webCapture) return;
    let host = false;
    try {
      host = isOpenDesignHostAvailable();
    } catch {
      host = false;
    }
    if (!host) engine.commands.setMode(null);
    else if (tool !== 'markup') engine.commands.setMode(nodeId, 'capture', 'markup');
  }, [engine, nodeId, webCapture, tool]);

  // Enter / mod+Enter / Esc while picking (capture phase: before the board's own Enter and Esc)
  useEffect(() => {
    if (!active || !nodeId || tool !== 'pick') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      if (event.isComposing || event.defaultPrevented) return;
      if (isTypingTarget(event.target) || isOverlayOpen()) return;
      const root = engine.camera.elements()?.root;
      const focused = document.activeElement;
      if (!root || !(root.contains(focused) || focused === document.body || focused === null)) return;
      const session = registry.captureSession();
      if (!session || session.nodeId !== nodeId) return;
      const state = session.getState();
      if (event.key === 'Escape') {
        if (!state.target) return;
        event.preventDefault();
        event.stopPropagation();
        session.clearTarget();
        return;
      }
      const full = event.metaKey || event.ctrlKey;
      if (!full && (!state.target || isActivationTarget(event.target))) return;
      event.preventDefault();
      event.stopPropagation();
      void session.capture(full);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active, engine, registry, nodeId, tool]);

  if (!node || (node.kind !== 'frame' && node.kind !== 'web')) return null;
  const markup = tool === 'markup' || node.kind === 'web';
  return (
    <>
      <div className={styles.captureLayer} data-testid="board-capture-layer">
        {!markup && node.kind === 'frame' ? <PickHighlight node={node} /> : null}
      </div>
      {markup ? <CaptureMarkupLayer node={node} /> : null}
    </>
  );
}
