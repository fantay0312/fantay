// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node-upscale-dialog.tsx.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29 (spec 05 §6.7): Fantay Modal/Segmented/Button, targets 1K/2K/4K
// disabled at or below the source, method hints, output size, the honest "local resampling, no AI" note.
import { useEffect, useMemo, useState } from 'react';

import { useT } from '../../../i18n';
import type { Dict } from '../../../i18n/types';
import { Button, Modal, ModalActions, ModalTitle, Segmented, SegmentedItem } from '../../ui';
import { BOARD_INTERACTIVE_PROPS } from '../../generation/components/board-interactive';
import { MAX_UPSCALE_LONG_EDGE, resolveUpscaleSize, type UpscaleAlgorithm, type UpscaleParams } from '../image-ops';
import { editorStageStyles as styles, useImageNaturalSize } from './EditorStage';

type DictKey = keyof Dict;

export const UPSCALE_TARGETS = [
  { label: '1K', value: 1024 },
  { label: '2K', value: 2048 },
  { label: '4K', value: MAX_UPSCALE_LONG_EDGE },
] as const;

const METHODS: Array<{ value: UpscaleAlgorithm; labelKey: DictKey; hintKey: DictKey }> = [
  { value: 'high', labelKey: 'fantay.media.upscale.high', hintKey: 'fantay.media.upscale.highHint' },
  { value: 'bilinear', labelKey: 'fantay.media.upscale.bilinear', hintKey: 'fantay.media.upscale.bilinearHint' },
  { value: 'nearest', labelKey: 'fantay.media.upscale.nearest', hintKey: 'fantay.media.upscale.nearestHint' },
];

/** The first target above the source's long edge (4K when the source is at least 2K). */
export function defaultUpscaleTarget(sourceLongEdge: number): number {
  return UPSCALE_TARGETS.find((target) => sourceLongEdge < target.value)?.value ?? MAX_UPSCALE_LONG_EDGE;
}

export interface UpscaleDialogProps {
  open: boolean;
  imageUrl: string;
  onClose(): void;
  onConfirm(params: UpscaleParams): Promise<unknown> | void;
}

export function UpscaleDialog({ open, imageUrl, onClose, onConfirm }: UpscaleDialogProps) {
  const t = useT();
  const image = useImageNaturalSize(imageUrl, open);
  const sourceLongEdge = image ? Math.max(image.width, image.height) : 0;
  const [params, setParams] = useState<UpscaleParams>({ targetLongEdge: 2048, algorithm: 'high' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setParams({ targetLongEdge: 2048, algorithm: 'high' });
    setBusy(false);
  }, [open, imageUrl]);

  useEffect(() => {
    if (!image) return;
    setParams((current) => ({ ...current, targetLongEdge: defaultUpscaleTarget(sourceLongEdge) }));
  }, [image, sourceLongEdge]);

  const output = useMemo(() => (image ? resolveUpscaleSize(image.width, image.height, params.targetLongEdge) : null), [image, params.targetLongEdge]);
  const canUpscale = Boolean(image && sourceLongEdge < params.targetLongEdge && params.targetLongEdge <= MAX_UPSCALE_LONG_EDGE);
  const method = METHODS.find((entry) => entry.value === params.algorithm) ?? METHODS[0];

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(params);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open && Boolean(imageUrl)}
      onClose={onClose}
      size="xl"
      className="max-w-[min(720px,calc(100vw-24px))]"
      aria-describedby={undefined}
      data-testid="fx-media-upscale-dialog"
      {...BOARD_INTERACTIVE_PROPS}
    >
      <ModalTitle>{t('fantay.media.upscale.title')}</ModalTitle>
      <div className={styles.layout}>
        <div className={styles.stageColumn}>
          <div className={styles.upscalePreview}>
            <img src={imageUrl} alt="" draggable={false} />
          </div>
          <span className={styles.note}>{image ? t('fantay.media.editor.source', { w: image.width, h: image.height }) : '—'}</span>
        </div>
        <div className={styles.controls}>
          <span className={styles.controlTitle}>{t('fantay.media.upscale.target')}</span>
          <Segmented
            size="sm"
            aria-label={t('fantay.media.upscale.target')}
            value={String(params.targetLongEdge)}
            onValueChange={(next) => setParams((current) => ({ ...current, targetLongEdge: Number(next) }))}
          >
            {UPSCALE_TARGETS.map((target) => (
              <SegmentedItem
                key={target.value}
                value={String(target.value)}
                disabled={Boolean(image) && sourceLongEdge >= target.value}
                data-testid={`fx-media-upscale-target-${target.label}`}
              >
                {target.label}
              </SegmentedItem>
            ))}
          </Segmented>
          {image && !canUpscale ? <span className={styles.warning}>{t('fantay.media.upscale.reached')}</span> : null}
          <span className={styles.controlTitle}>{t('fantay.media.upscale.method')}</span>
          <Segmented
            size="sm"
            aria-label={t('fantay.media.upscale.method')}
            value={params.algorithm}
            onValueChange={(next) => setParams((current) => ({ ...current, algorithm: next as UpscaleAlgorithm }))}
          >
            {METHODS.map((entry) => (
              <SegmentedItem key={entry.value} value={entry.value}>
                {t(entry.labelKey)}
              </SegmentedItem>
            ))}
          </Segmented>
          {method ? <span className={styles.note}>{t(method.hintKey)}</span> : null}
          <div className={styles.readout}>
            <span data-testid="fx-media-upscale-output">{output ? t('fantay.media.upscale.output', { w: output.width, h: output.height }) : '—'}</span>
          </div>
          <span className={styles.note}>{t('fantay.media.upscale.note')}</span>
        </div>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('fantay.media.editor.cancel')}
        </Button>
        <Button variant="primary" loading={busy} disabled={!canUpscale} data-testid="fx-media-upscale-confirm" onClick={() => void confirm()}>
          {t('fantay.media.upscale.confirm')}
        </Button>
      </ModalActions>
    </Modal>
  );
}
