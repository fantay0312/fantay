// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node.tsx
// (ExpandedImageCard, BatchImageFailureActions, L832-918).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: the fan stays mounted once opened (exit transition), cards use the
// Fantay primitives for "set as cover / promote / download" and "retry / delete", generation state comes
// from the candidate records, previews from the thumbnail cache.
import type * as React from 'react';
import { Download, RefreshCw, SquareArrowOutUpRight, Star, Trash2 } from 'lucide-react';
import type { GenerationCandidate } from '@open-design/contracts';

import { useT } from '../../i18n';
import { IconButton } from '../ui';
import { useGeneration } from '../generation/hooks';
import { BOARD_CONTROL_PROPS, BOARD_INTERACTIVE_PROPS } from '../generation/components/board-interactive';
import { downloadMedia } from '../media-tools/actions';
import { mediaCacheKey, mediaUrl } from '../media-tools/media-url';
import { useImageSource } from '../media-tools/thumbnails';
import { SlotStatus } from './SlotStatus';
import styles from './ImageNodeBody.module.css';

/** Gap between fan-out cards (world px), as upstream. */
const FAN_GAP = 18;

export interface CandidateFanProps {
  nodeId: string;
  /** The candidates other than the primary. */
  candidates: GenerationCandidate[];
  /** All candidates of the node (the primary keeps its slot in the grid). */
  total: number;
  width: number;
  height: number;
  zoom: number;
  open: boolean;
  title: string;
  generatorId?: string | undefined;
}

/**
 * Card position of the `index`-th secondary candidate: a ≤ 4-column grid whose last row holds the
 * node itself (first slot), rows growing upward (upstream ExpandedImageCard).
 */
export function fanCardPosition(index: number, total: number, width: number, height: number): { x: number; y: number } {
  const count = Math.max(1, total);
  const columns = Math.min(count, 4);
  const rows = Math.ceil(count / columns);
  const rootSlot = (rows - 1) * columns;
  const slot = index >= rootSlot ? index + 1 : index;
  const column = slot % columns;
  const row = Math.floor(slot / columns);
  return { x: column * (width + FAN_GAP), y: (row - rows + 1) * (height + FAN_GAP) };
}

function FanCard({
  nodeId,
  candidate,
  index,
  position,
  width,
  height,
  zoom,
  open,
  title,
  generatorId,
}: {
  nodeId: string;
  candidate: GenerationCandidate;
  index: number;
  position: { x: number; y: number };
  width: number;
  height: number;
  zoom: number;
  open: boolean;
  title: string;
  generatorId?: string | undefined;
}) {
  const t = useT();
  const generation = useGeneration();
  const file = candidate.status === 'done' ? candidate.file : undefined;
  const url = file ? mediaUrl(generation.projectId, file.path, generation.workspaceContext) : '';
  const source = useImageSource(url, file ? mediaCacheKey(file) : '', Math.max(width, height) * zoom);
  const failed = candidate.status === 'failed' || candidate.status === 'interrupted' || candidate.status === 'lost';
  const style = {
    left: position.x,
    top: position.y,
    width,
    height,
    '--from-x': `${-position.x}px`,
    '--from-y': `${-position.y}px`,
    '--from-rotate': `${4 + index * 2}deg`,
    '--fan-index': index,
  } as React.CSSProperties;

  return (
    <div
      className={styles.fanCard}
      style={style}
      data-state={open ? 'open' : 'closed'}
      data-status={candidate.status}
      data-testid={`fx-media-candidate-${candidate.index}`}
      aria-hidden={open ? undefined : true}
      {...BOARD_INTERACTIVE_PROPS}
      onDoubleClick={(event) => {
        if (!file || (event.target instanceof Element && event.target.closest('button'))) return;
        event.stopPropagation();
        generation.openToolDialog({ kind: 'preview', nodeId, candidateId: candidate.id });
      }}
    >
      {file ? (
        <img className={styles.picture} src={source} alt={title} draggable={false} decoding="async" />
      ) : (
        <SlotStatus nodeId={nodeId} candidate={candidate} generatorId={generatorId} compact />
      )}
      <div className={styles.fanActions}>
        {file ? (
          <>
            <IconButton
              size="sm"
              variant="frosted"
              aria-label={t('fantay.gen.slot.setPrimary')}
              data-testid="fx-media-set-primary"
              tabIndex={open ? 0 : -1}
              {...BOARD_CONTROL_PROPS}
              onClick={() => generation.service.setPrimary(nodeId, candidate.id)}
            >
              <Star strokeWidth={1.5} />
            </IconButton>
            <IconButton
              size="sm"
              variant="frosted"
              aria-label={t('fantay.gen.slot.promote')}
              data-testid="fx-media-promote"
              tabIndex={open ? 0 : -1}
              {...BOARD_CONTROL_PROPS}
              onClick={() => {
                const created = generation.service.promote(nodeId, candidate.id);
                if (created) generation.board.select([created]);
              }}
            >
              <SquareArrowOutUpRight strokeWidth={1.5} />
            </IconButton>
            <IconButton
              size="sm"
              variant="frosted"
              aria-label={t('fantay.gen.slot.download')}
              data-testid="fx-media-candidate-download"
              tabIndex={open ? 0 : -1}
              {...BOARD_CONTROL_PROPS}
              onClick={() => downloadMedia(generation.projectId, file, generation.workspaceContext)}
            >
              <Download strokeWidth={1.5} />
            </IconButton>
          </>
        ) : failed ? (
          <>
            <IconButton
              size="sm"
              variant="frosted"
              aria-label={t('fantay.gen.slot.retry')}
              data-testid="fx-media-retry"
              tabIndex={open ? 0 : -1}
              {...BOARD_CONTROL_PROPS}
              onClick={() => void generation.service.retryCandidate(nodeId, candidate.id)}
            >
              <RefreshCw strokeWidth={1.5} />
            </IconButton>
            <IconButton
              size="sm"
              variant="frosted"
              aria-label={t('fantay.gen.slot.delete')}
              data-testid="fx-media-delete"
              tabIndex={open ? 0 : -1}
              {...BOARD_CONTROL_PROPS}
              onClick={() => generation.service.deleteCandidate(nodeId, candidate.id)}
            >
              <Trash2 strokeWidth={1.5} />
            </IconButton>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The fanned-out candidates of a multi-candidate image node (mounted once opened, then kept for the exit). */
export function CandidateFan({ nodeId, candidates, total, width, height, zoom, open, title, generatorId }: CandidateFanProps) {
  return (
    <>
      {candidates.map((candidate, index) => (
        <FanCard
          key={candidate.id}
          nodeId={nodeId}
          candidate={candidate}
          index={index}
          position={fanCardPosition(index, total, width, height)}
          width={width}
          height={height}
          zoom={zoom}
          open={open}
          title={title}
          generatorId={generatorId}
        />
      ))}
    </>
  );
}
