'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Image face (spec 03 §4.3, plan R4): the generation body when `extensions.renderImageBody` is injected (candidates,
// slot status, fan-out — 05), else the minimal fallback: the picture itself (`object-fit: contain`), the
// placeholder while a media task is pending, the error of a failed one. The first load of a picture without a known
// size writes its natural size once (not undoable).
import { useRef } from 'react';

import { useT } from '../../../../i18n';
import { useBoardEngine, useBoardHost } from '../../context';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import { ErrorFace } from '../common/ErrorFace';
import { PlaceholderFace } from '../common/PlaceholderFace';
import { basenameOf, projectFileFor } from '../frame/project-files';
import { useNodeBodyProps } from './body-props';
import { pickImageSource } from './image-source';
import { projectMediaUrl } from './media-url';
import styles from './media.module.css';

export function ImageNode({ view }: NodeFaceProps) {
  const { extensions } = useBoardHost();
  const body = useNodeBodyProps(view, 'image');
  if (extensions?.renderImageBody) {
    return (
      <div className={styles.body} data-testid="board-image-body">
        {extensions.renderImageBody(body)}
      </div>
    );
  }
  return <ImageFallback view={view} />;
}

function ImageFallback({ view }: NodeFaceProps) {
  const engine = useBoardEngine();
  const { env } = useBoardHost();
  const t = useT();
  const node = view.node as EngineNodeOf<'image'>;
  const path = node.data.ref?.path ?? null;
  const file = projectFileFor(env.files, path);
  const measured = useRef<string | null>(null);
  const title = node.title ?? (path ? basenameOf(path) : t('board.kind.image'));

  if (view.runtime.phase === 'error') {
    return <ErrorFace message={view.runtime.error?.message ?? t(view.runtime.error?.messageKey ?? 'board.node.state.error')} />;
  }
  if (!path) return <PlaceholderFace kind="image" caption={title} />;

  const originalUrl = projectMediaUrl(env.projectId, path, file?.mtime, env.workspaceContext);
  const src = pickImageSource({
    previewUrl: view.runtime.cover?.url,
    originalUrl,
    naturalWidth: node.data.naturalWidth,
    naturalHeight: node.data.naturalHeight,
    renderedWidth: node.w,
    renderedHeight: node.h,
    scale: view.settledZoom,
  });
  return (
    <div className={styles.image} data-testid="board-image">
      <img
        className={styles.picture}
        src={src}
        alt={title}
        decoding="async"
        draggable={false}
        onLoad={(event) => {
          const image = event.currentTarget;
          if (view.readOnly || node.data.naturalWidth || !image.naturalWidth || !image.naturalHeight) return;
          const key = `${path}@${image.naturalWidth}x${image.naturalHeight}`;
          if (measured.current === key) return;
          measured.current = key;
          const h = Math.max(1, Math.round((node.w * image.naturalHeight) / image.naturalWidth));
          engine.commands.updateNode(
            node.id,
            { h, data: { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight } },
            { origin: 'system', label: 'autosize' },
          );
        }}
      />
    </div>
  );
}
