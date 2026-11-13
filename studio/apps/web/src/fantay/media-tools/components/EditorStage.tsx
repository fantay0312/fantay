// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node-crop-dialog.tsx
// and canvas-node-split-dialog.tsx (zoomable stage markup and zoom controls).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: one shared stage for the crop and split dialogs, Fantay primitives
// for the zoom buttons, i18n hint (spec 05 §6.7).
import type * as React from 'react';
import { useEffect, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';

import { useT } from '../../../i18n';
import { Button, IconButton } from '../../ui';
import type { useImageEditorViewport } from '../use-image-editor-viewport';
import styles from './EditorStage.module.css';

export type ImageEditorViewport = ReturnType<typeof useImageEditorViewport>;

/** Natural size of an image URL (null while loading or when it fails). */
export function useImageNaturalSize(url: string | null, open: boolean): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    setSize(null);
    if (!open || !url || typeof Image === 'undefined') return undefined;
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (alive && image.naturalWidth > 0 && image.naturalHeight > 0) setSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.src = url;
    return () => {
      alive = false;
      image.onload = null;
    };
  }, [open, url]);
  return size;
}

export interface EditorStageProps {
  viewport: ImageEditorViewport;
  imageUrl: string;
  /** Overlays drawn over the image, in stage coordinates (crop box, cut lines). */
  children?: React.ReactNode;
  hint?: string;
}

export function EditorStage({ viewport, imageUrl, children, hint }: EditorStageProps) {
  const t = useT();
  return (
    <div className={styles.stageColumn}>
      <div
        ref={viewport.viewportRef}
        className={styles.viewport}
        data-scrollable={viewport.scrollable ? '' : undefined}
        data-space={viewport.spacePressed ? '' : undefined}
        data-panning={viewport.isPanning ? '' : undefined}
        {...viewport.panHandlers}
      >
        <div className={styles.content} style={viewport.contentStyle}>
          <div ref={viewport.stageRef} className={styles.stage} style={viewport.stageStyle}>
            <div className={styles.media} style={viewport.mediaStyle}>
              <img src={imageUrl} alt="" draggable={false} />
            </div>
            {children}
          </div>
        </div>
      </div>
      <div className={styles.zoomRow}>
        <IconButton size="sm" aria-label={t('fantay.media.editor.zoomOut')} disabled={!viewport.canZoomOut} onClick={viewport.zoomOut}>
          <ZoomOut strokeWidth={1.5} />
        </IconButton>
        <Button size="sm" variant="bare" className={styles.zoomValue} onClick={viewport.resetZoom}>
          {Math.round(viewport.zoom * 100)}%
        </Button>
        <IconButton size="sm" aria-label={t('fantay.media.editor.zoomIn')} disabled={!viewport.canZoomIn} onClick={viewport.zoomIn}>
          <ZoomIn strokeWidth={1.5} />
        </IconButton>
        <span className={styles.hint}>{hint ?? t('fantay.media.editor.hint')}</span>
      </div>
    </div>
  );
}

export { styles as editorStageStyles };
