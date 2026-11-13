'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Capture ▸ Markup (spec 03 §5.3, plan R15): the upstream `PreviewDrawOverlay`, unchanged and wrapped in
// `<FxLegacy>` (B3), over the node's screen rect while the camera is frozen. Its snapshot is the desktop compositor
// region of the live iframe when the host is present, else the frame's snapshot bridge (frames only; web markup
// needs the host, see the context bar's disabled reason). It emits the existing `ANNOTATION_EVENT`, which the
// composer uploads and stages; closing it (Esc / its exit) leaves Capture.
import { useCallback } from 'react';

import { PreviewDrawOverlay } from '../../../../components/PreviewDrawOverlay';
import { FxLegacy } from '../../../ui/fx';
import { useBoardEngine } from '../../context';
import { BOARD_INTERACTIVE_ATTR } from '../../extensions';
import { screenBox } from '../../layers/screen-space';
import type { EngineNode } from '../../model/types';
import { useFrameRegistry } from './frame-registry';
import styles from '../../chrome/chrome.module.css';

const INTERACTIVE = { [BOARD_INTERACTIVE_ATTR]: '' } as const;

export interface CaptureMarkupLayerProps {
  node: EngineNode;
}

export function CaptureMarkupLayer({ node }: CaptureMarkupLayerProps) {
  const engine = useBoardEngine();
  const registry = useFrameRegistry();
  const nodeId = node.id;
  const isFrame = node.kind === 'frame';
  const filePath = node.kind === 'frame' ? node.data.ref?.path : node.kind === 'web' ? node.data.url : undefined;

  const captureFrameRect = useCallback(() => registry.get(nodeId)?.iframe()?.getBoundingClientRect() ?? null, [registry, nodeId]);

  const captureSnapshot = useCallback(async () => {
    const iframe = registry.get(nodeId)?.iframe();
    if (!iframe) return null;
    const exports = await import('../../../../runtime/exports');
    if (exports.isOpenDesignHostAvailable()) {
      const rect = iframe.getBoundingClientRect();
      const region = await exports.captureHostRegionSnapshot({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      if (region) return region;
    }
    return isFrame ? exports.requestPreviewSnapshot(iframe, 4_000) : null;
  }, [registry, nodeId, isFrame]);

  const onActiveChange = useCallback(
    (active: boolean) => {
      if (active) return;
      const mode = engine.store.getState().ui.mode;
      if (mode?.nodeId === nodeId && mode.mode === 'capture') engine.commands.setMode(null);
    },
    [engine, nodeId],
  );

  return (
    <FxLegacy>
      <div className={styles.markupHost} style={screenBox(node)} data-testid="board-capture-markup" {...INTERACTIVE}>
        <PreviewDrawOverlay
          active
          captureSnapshot={captureSnapshot}
          captureFrameRect={captureFrameRect}
          {...(filePath ? { filePath } : {})}
          onActiveChange={onActiveChange}
          toolbarHost={engine.camera.elements()?.root ?? null}
        >
          <span aria-hidden className={styles.markupSpacer} />
        </PreviewDrawOverlay>
      </div>
    </FxLegacy>
  );
}
