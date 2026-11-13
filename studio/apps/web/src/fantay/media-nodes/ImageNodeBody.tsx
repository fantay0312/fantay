// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node.tsx
// (ImageContent, BatchFrame, L739-830 and L946-972).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: body of board `image` nodes injected through
// `BoardExtensions.renderImageBody` (plan R4): primary candidate or file, slot status, stacked ghost
// cards with a count pill and the candidate fan-out, hover download, stub/warning badges, dimension
// patch for plain image nodes; interactive descendants carry `data-board-interactive` (plan R6).
import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { ChevronRight, Download, ImageIcon, Info, TriangleAlert } from 'lucide-react';

import { useT } from '../../i18n';
import { Button, Tooltip } from '../ui';
import type { BoardNodeBodyProps } from '../board/extensions';
import { useGeneration } from '../generation/hooks';
import { BOARD_CONTROL_PROPS } from '../generation/components/board-interactive';
import { downloadMedia } from '../media-tools/actions';
import { mediaCacheKey, mediaUrl } from '../media-tools/media-url';
import { useImageSource } from '../media-tools/thumbnails';
import { CandidateFan } from './CandidateFan';
import {
  OVERLAY_MIN_ZOOM,
  displayFileOf,
  overlayScaleFor,
  primaryCandidateOf,
  secondaryCandidatesOf,
  useGenerationNode,
} from './media-display';
import { SlotStatus } from './SlotStatus';
import styles from './ImageNodeBody.module.css';

const MAX_GHOST_CARDS = 3;

export type ImageNodeBodyProps = Pick<BoardNodeBodyProps, 'nodeId' | 'selected' | 'zoom'> &
  Partial<Pick<BoardNodeBodyProps, 'width' | 'height'>>;

export function ImageNodeBody({ nodeId, selected, zoom, width, height }: ImageNodeBodyProps) {
  const t = useT();
  const generation = useGeneration();
  const node = useGenerationNode(nodeId);
  const [fanOpen, setFanOpen] = useState(false);
  const [fanMounted, setFanMounted] = useState(false);
  const patchedDimsFor = useRef<string | null>(null);

  const nodeWidth = width ?? node?.w ?? 320;
  const nodeHeight = height ?? node?.h ?? 320;
  const media = node?.media;
  const generationData = media?.generation;
  const candidates = generationData?.candidates ?? [];
  const primary = primaryCandidateOf(generationData);
  const file = displayFileOf(node);
  const url = file ? mediaUrl(generation.projectId, file.path, generation.workspaceContext) : '';
  const source = useImageSource(url, file ? mediaCacheKey(file) : '', Math.max(nodeWidth, nodeHeight) * zoom);
  const title = node?.title?.trim() || t('fantay.media.untitledImage');
  const others = secondaryCandidatesOf(generationData);
  const multi = candidates.length > 1;
  const generatorId = generationData?.request.generatorId;

  useEffect(() => {
    if (fanOpen) setFanMounted(true);
  }, [fanOpen]);

  // Plain image nodes learn their natural size from the first load (generated ones are probed by the service).
  const onPictureLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    if (!file || generationData || (file.width && file.height)) return;
    const image = event.currentTarget;
    if (!image.naturalWidth || !image.naturalHeight || image.currentSrc.startsWith('blob:')) return;
    const key = `${file.path}@${image.naturalWidth}x${image.naturalHeight}`;
    if (patchedDimsFor.current === key) return;
    patchedDimsFor.current = key;
    generation.board.apply(
      [{ type: 'node.patchData', id: nodeId, patch: { file: { ...file, width: image.naturalWidth, height: image.naturalHeight } } }],
      { label: 'media.dimensions', undoable: false, flush: false },
    );
  };

  const overlayStyle = { '--fx-inv-zoom': overlayScaleFor(zoom) } as React.CSSProperties;
  const lod = zoom < OVERLAY_MIN_ZOOM ? 'low' : 'normal';

  return (
    <div
      className={styles.root}
      style={overlayStyle}
      data-testid="fx-media-node"
      data-kind="image"
      data-fan={fanOpen ? 'open' : 'closed'}
      data-lod={lod}
      data-selected={selected ? '' : undefined}
      aria-busy={primary && (primary.status === 'pending' || primary.status === 'queued' || primary.status === 'running') ? true : undefined}
    >
      {multi ? (
        <div className={styles.ghosts} aria-hidden>
          {Array.from({ length: Math.min(candidates.length - 1, MAX_GHOST_CARDS) }, (_, index) => (
            <span
              key={index}
              className={styles.ghost}
              style={{ transform: `translate(${10 + index * 6}px, ${4 + index * 3}px) rotate(${1.5 + index}deg)`, zIndex: -index - 1 }}
            />
          ))}
        </div>
      ) : null}

      {multi && fanMounted ? (
        <CandidateFan
          nodeId={nodeId}
          candidates={others}
          total={candidates.length}
          width={nodeWidth}
          height={nodeHeight}
          zoom={zoom}
          open={fanOpen}
          title={title}
          generatorId={generatorId}
        />
      ) : null}

      <div
        className={styles.frame}
        data-testid={primary ? `fx-media-candidate-${primary.index}` : undefined}
        data-primary={primary ? '' : undefined}
        onDoubleClick={(event) => {
          // Spec 05 §6.3: double-click opens the preview (the engine's "enter" does nothing for media nodes).
          if (!file) return;
          event.stopPropagation();
          generation.openToolDialog({ kind: 'preview', nodeId });
        }}
      >
        {file ? (
          <img className={styles.picture} src={source} alt={title} draggable={false} decoding="async" onLoad={onPictureLoad} />
        ) : primary ? (
          <SlotStatus nodeId={nodeId} candidate={primary} generatorId={generatorId} />
        ) : (
          <div className={styles.empty}>
            <ImageIcon size={24} strokeWidth={1.5} aria-hidden />
            <span>{t('fantay.media.untitledImage')}</span>
          </div>
        )}
      </div>

      {file ? (
        <div className={`${styles.overlay} ${styles.overlayTopLeft} ${styles.hoverOnly}`}>
          <Button
            size="sm"
            variant="default"
            data-testid="fx-media-download"
            {...BOARD_CONTROL_PROPS}
            onClick={() => downloadMedia(generation.projectId, file, generation.workspaceContext)}
          >
            <Download strokeWidth={1.5} aria-hidden />
            {t('fantay.gen.slot.download')}
          </Button>
        </div>
      ) : null}

      {multi || primary?.stub || primary?.warnings?.length ? (
        <div className={`${styles.overlay} ${styles.overlayTopRight}`}>
          {primary?.stub ? (
            <Tooltip label={t('fantay.gen.slot.stub')}>
              <span className={`${styles.badge} ${styles.badgeWarning}`} role="img" aria-label={t('fantay.gen.slot.stub')} tabIndex={0} {...BOARD_CONTROL_PROPS}>
                <TriangleAlert size={14} strokeWidth={1.5} aria-hidden />
              </span>
            </Tooltip>
          ) : null}
          {primary?.warnings?.length ? (
            <Tooltip label={primary.warnings.join('\n')}>
              <span className={styles.badge} role="img" aria-label={primary.warnings.join(' · ')} tabIndex={0} {...BOARD_CONTROL_PROPS}>
                <Info size={14} strokeWidth={1.5} aria-hidden />
              </span>
            </Tooltip>
          ) : null}
          {multi ? (
            <Button
              size="sm"
              variant="bare"
              className={styles.countPill}
              data-testid="fx-media-count-pill"
              aria-expanded={fanOpen}
              aria-label={`${t('fantay.gen.slot.count', { n: candidates.length })} · ${t(fanOpen ? 'fantay.gen.slot.collapse' : 'fantay.gen.slot.expand')}`}
              {...BOARD_CONTROL_PROPS}
              onClick={() => {
                const next = !fanOpen;
                setFanOpen(next);
                if (next) generation.board.focus(nodeId);
              }}
            >
              {t('fantay.gen.slot.count', { n: candidates.length })}
              <ChevronRight className={styles.countChevron} size={14} strokeWidth={1.5} aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
