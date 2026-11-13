// SPDX-License-Identifier: AGPL-3.0-only
// Full-size preview of an image/video node (spec 05 §6.3): fit-size media, candidate navigation
// (← / →), download, set as cover, promote and use as reference. Opened by double-click, the "view"
// tool or a chip preview through the provider's `openToolDialog({ kind: 'preview' })`.
import { useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { BoardMediaFile, GenerationCandidate } from '@open-design/contracts';

import { useT } from '../../i18n';
import { Button, IconButton, Modal, ModalTitle } from '../ui';
import { useBoardGraph, useGeneration } from '../generation/hooks';
import { BOARD_INTERACTIVE_PROPS } from '../generation/components/board-interactive';
import { downloadMedia, useAsReference } from '../media-tools/actions';
import { mediaUrl } from '../media-tools/media-url';
import { primaryCandidateOf } from './media-display';
import { createMediaToolContext } from './node-actions';
import styles from './MediaPreviewDialog.module.css';

export interface MediaPreviewDialogProps {
  open: boolean;
  nodeId: string | null;
  candidateId?: string | null | undefined;
  onClose(): void;
}

interface PreviewItem {
  file: BoardMediaFile;
  candidate: GenerationCandidate | null;
}

export function MediaPreviewDialog({ open, nodeId, candidateId, onClose }: MediaPreviewDialogProps) {
  const t = useT();
  const generation = useGeneration();
  const graph = useBoardGraph();
  const node = nodeId ? (graph.nodes.find((entry) => entry.id === nodeId) ?? null) : null;
  const generationData = node?.media?.generation;
  const items = useMemo<PreviewItem[]>(() => {
    if (generationData && generationData.candidates.length > 0) {
      return generationData.candidates
        .filter((candidate) => candidate.status === 'done' && candidate.file)
        .map((candidate) => ({ file: candidate.file as BoardMediaFile, candidate }));
    }
    const file = node?.media?.file;
    return file ? [{ file, candidate: null }] : [];
  }, [generationData, node]);
  const [index, setIndex] = useState(0);
  const [failedPath, setFailedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFailedPath(null);
    const wanted = candidateId ?? primaryCandidateOf(generationData)?.id;
    const found = wanted ? items.findIndex((item) => item.candidate?.id === wanted) : -1;
    setIndex(found >= 0 ? found : 0);
    // Only when the dialog (re)opens or the requested candidate changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, candidateId, nodeId]);

  const current = items[Math.min(index, Math.max(0, items.length - 1))];
  const unavailable = !current || failedPath === current.file.path;
  const isVideo = node?.kind === 'video';
  const title = node?.title?.trim() || t(isVideo ? 'fantay.media.untitledVideo' : 'fantay.media.untitledImage');
  const url = current ? mediaUrl(generation.projectId, current.file.path, generation.workspaceContext) : '';
  const canNavigate = items.length > 1;
  const isPrimary = current?.candidate ? current.candidate.id === primaryCandidateOf(generationData)?.id : true;

  const step = (delta: number) => {
    if (!canNavigate) return;
    setIndex((value) => (value + delta + items.length) % items.length);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
    }
  };

  return (
    <Modal
      open={open && Boolean(node)}
      onClose={onClose}
      size="2xl"
      aria-describedby={undefined}
      data-testid="fx-media-preview"
      onKeyDown={onKeyDown}
      {...BOARD_INTERACTIVE_PROPS}
    >
      <ModalTitle>{`${t('fantay.media.preview.title')} · ${title}`}</ModalTitle>
      <div className={styles.stage}>
        {unavailable ? (
          <div className={styles.empty} role="status" data-testid="fx-media-preview-unavailable">
            {t(current ? 'board.node.missingFile' : 'fantay.media.tool.noMedia')}
          </div>
        ) : isVideo ? (
          <video
            key={current.file.path}
            className={styles.media}
            src={url}
            controls
            playsInline
            preload="metadata"
            aria-label={title}
            onError={() => setFailedPath(current.file.path)}
          />
        ) : (
          <img
            key={current.file.path}
            className={styles.media}
            src={url}
            alt={title}
            draggable={false}
            onError={() => setFailedPath(current.file.path)}
          />
        )}
        {canNavigate ? (
          <>
            <IconButton className={`${styles.nav} ${styles.navPrev}`} variant="frosted" shape="round" aria-label={t('fantay.media.preview.prev')} onClick={() => step(-1)}>
              <ChevronLeft strokeWidth={1.5} />
            </IconButton>
            <IconButton className={`${styles.nav} ${styles.navNext}`} variant="frosted" shape="round" aria-label={t('fantay.media.preview.next')} onClick={() => step(1)}>
              <ChevronRight strokeWidth={1.5} />
            </IconButton>
          </>
        ) : null}
      </div>
      <div className={styles.footer}>
        <span className={styles.counter}>{canNavigate ? `${Math.min(index, items.length - 1) + 1} / ${items.length}` : ''}</span>
        {node && current?.candidate && !isPrimary ? (
          <Button size="sm" variant="ghost" onClick={() => current.candidate && generation.service.setPrimary(node.id, current.candidate.id)}>
            {t('fantay.gen.slot.setPrimary')}
          </Button>
        ) : null}
        {node && current?.candidate ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!current.candidate) return;
              const created = generation.service.promote(node.id, current.candidate.id);
              if (created) {
                generation.board.select([created]);
                onClose();
              }
            }}
          >
            {t('fantay.gen.slot.promote')}
          </Button>
        ) : null}
        {node && !isVideo ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={unavailable}
            onClick={() => {
              const result = useAsReference(createMediaToolContext(generation, node, graph, t));
              if (result) onClose();
            }}
          >
            {t('fantay.media.tool.useAsReference')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          disabled={unavailable}
          onClick={() => current && downloadMedia(generation.projectId, current.file, generation.workspaceContext)}
        >
          {t('fantay.gen.slot.download')}
        </Button>
      </div>
    </Modal>
  );
}
