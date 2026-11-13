// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node-crop-dialog.tsx.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29 (spec 05 §6.7): Fantay Modal/Segmented/Button, presets
// free | original | 1:1 | 4:3 | 16:9 | 9:16, read-outs of crop and source size, keyboard nudging of the
// crop box (arrows move, Shift+arrows resize), handles are pointer targets only, busy confirm.
import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';

import { useT } from '../../../i18n';
import { Button, Modal, ModalActions, ModalTitle, Segmented, SegmentedItem } from '../../ui';
import { BOARD_INTERACTIVE_PROPS } from '../../generation/components/board-interactive';
import type { NormalizedRect } from '../image-ops';
import { useImageEditorViewport } from '../use-image-editor-viewport';
import { EditorStage, editorStageStyles as styles, useImageNaturalSize } from './EditorStage';

type DragMode = 'move' | 'resize';
type ResizeHandle = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type CropPreset = 'free' | 'original' | '1:1' | '4:3' | '16:9' | '9:16';

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const PRESETS: CropPreset[] = ['free', 'original', '1:1', '4:3', '16:9', '9:16'];
const MIN_SIZE = 0.06;
const NUDGE = 0.01;
export const DEFAULT_CROP: NormalizedRect = { x: 0.12, y: 0.12, width: 0.76, height: 0.76 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function moveCrop(crop: NormalizedRect, dx: number, dy: number): NormalizedRect {
  return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) };
}

/** Upstream `resizeCrop`: drags a handle, keeps a fixed ratio when given, stays inside the image. */
export function resizeCrop(
  crop: NormalizedRect,
  dx: number,
  dy: number,
  handle: ResizeHandle,
  aspectRatio: number | null,
  box: { width: number; height: number },
): NormalizedRect {
  const next = { ...crop };
  if (handle.includes('e')) next.width = crop.width + dx;
  if (handle.includes('s')) next.height = crop.height + dy;
  if (handle.includes('w')) {
    next.x = crop.x + dx;
    next.width = crop.width - dx;
  }
  if (handle.includes('n')) {
    next.y = crop.y + dy;
    next.height = crop.height - dy;
  }
  if (aspectRatio) {
    const normalizedRatio = aspectRatio * (box.height / Math.max(1, box.width));
    const horizontalOnly = (handle.includes('e') || handle.includes('w')) && !handle.includes('n') && !handle.includes('s');
    const useWidth = horizontalOnly || (handle.length > 1 && Math.abs(dx * box.width) >= Math.abs(dy * box.height));
    if (useWidth) next.height = next.width / normalizedRatio;
    else next.width = next.height * normalizedRatio;
    if (handle.includes('w')) next.x = crop.x + crop.width - next.width;
    if (handle.includes('n')) next.y = crop.y + crop.height - next.height;
    const scaleDown = Math.min(1, 1 / Math.max(next.width, 0.001), 1 / Math.max(next.height, 0.001));
    next.width *= scaleDown;
    next.height *= scaleDown;
    if (next.width < MIN_SIZE || next.height < MIN_SIZE) {
      const minimumScale = Math.max(MIN_SIZE / Math.max(next.width, 0.001), MIN_SIZE / Math.max(next.height, 0.001));
      next.width *= minimumScale;
      next.height *= minimumScale;
    }
    next.width = Math.min(next.width, next.height * normalizedRatio);
    next.height = next.width / normalizedRatio;
  } else {
    next.width = clamp(next.width, MIN_SIZE, 1);
    next.height = clamp(next.height, MIN_SIZE, 1);
  }
  next.x = clamp(next.x, 0, 1 - next.width);
  next.y = clamp(next.y, 0, 1 - next.height);
  return next;
}

export function presetRatio(preset: CropPreset, image: { width: number; height: number } | null): number | null {
  if (preset === 'free' || !image) return null;
  if (preset === 'original') return image.width / image.height;
  const [width, height] = preset.split(':').map(Number);
  return width && height ? width / height : null;
}

/** Upstream `fitCropToRatio`: the largest crop of `ratio` inside the current one, centred. */
export function fitCropToRatio(crop: NormalizedRect, ratio: number, image: { width: number; height: number }): NormalizedRect {
  const normalizedRatio = ratio * (image.height / image.width);
  let width = crop.width;
  let height = width / normalizedRatio;
  if (height > crop.height) {
    height = crop.height;
    width = height * normalizedRatio;
  }
  if (width > 1) {
    width = 1;
    height = width / normalizedRatio;
  }
  if (height > 1) {
    height = 1;
    width = height * normalizedRatio;
  }
  return {
    x: clamp(crop.x + (crop.width - width) / 2, 0, 1 - width),
    y: clamp(crop.y + (crop.height - height) / 2, 0, 1 - height),
    width,
    height,
  };
}

function handleStyle(handle: ResizeHandle): React.CSSProperties {
  const top = handle.includes('n') ? '-6px' : handle.includes('s') ? 'calc(100% - 6px)' : 'calc(50% - 6px)';
  const left = handle.includes('w') ? '-6px' : handle.includes('e') ? 'calc(100% - 6px)' : 'calc(50% - 6px)';
  return { top, left, cursor: `${handle}-resize` };
}

export interface CropDialogProps {
  open: boolean;
  imageUrl: string;
  onClose(): void;
  /** Resolves when the crop is saved; the dialog shows the busy state meanwhile. */
  onConfirm(rect: NormalizedRect): Promise<unknown> | void;
}

export function CropDialog({ open, imageUrl, onClose, onConfirm }: CropDialogProps) {
  const t = useT();
  const [crop, setCrop] = useState<NormalizedRect>(DEFAULT_CROP);
  const [preset, setPreset] = useState<CropPreset>('free');
  const [busy, setBusy] = useState(false);
  const image = useImageNaturalSize(imageUrl, open);
  const viewport = useImageEditorViewport(image, open);
  const dragAbort = useRef<AbortController | null>(null);
  const ratio = presetRatio(preset, image);

  useEffect(() => {
    if (!open) {
      dragAbort.current?.abort();
      return;
    }
    setCrop(DEFAULT_CROP);
    setPreset('free');
    setBusy(false);
  }, [open, imageUrl]);
  useEffect(() => () => dragAbort.current?.abort(), []);

  const startDrag = (mode: DragMode, event: React.PointerEvent, handle?: ResizeHandle) => {
    const box = viewport.stageRef.current?.getBoundingClientRect();
    if (!box || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragAbort.current?.abort();
    const controller = new AbortController();
    dragAbort.current = controller;
    const start = { x: event.clientX, y: event.clientY, crop };
    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - start.x) / Math.max(1, box.width);
      const dy = (moveEvent.clientY - start.y) / Math.max(1, box.height);
      setCrop(mode === 'move' ? moveCrop(start.crop, dx, dy) : resizeCrop(start.crop, dx, dy, handle ?? 'se', ratio, box));
    };
    const stop = () => controller.abort();
    document.addEventListener('pointermove', move, { signal: controller.signal });
    document.addEventListener('pointerup', stop, { signal: controller.signal });
    document.addEventListener('pointercancel', stop, { signal: controller.signal });
  };

  const onBoxKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.altKey ? NUDGE / 4 : NUDGE;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const entry = delta[event.key];
    if (!entry) return;
    event.preventDefault();
    const box = viewport.stageRef.current?.getBoundingClientRect() ?? { width: 1, height: 1 };
    setCrop((current) => (event.shiftKey ? resizeCrop(current, entry[0], entry[1], 'se', ratio, box) : moveCrop(current, entry[0], entry[1])));
  };

  const cropSize = image
    ? { width: Math.max(1, Math.round(crop.width * image.width)), height: Math.max(1, Math.round(crop.height * image.height)) }
    : null;

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(crop);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open && Boolean(imageUrl)}
      onClose={onClose}
      size="2xl"
      className="max-w-[min(780px,calc(100vw-24px))]"
      aria-describedby={undefined}
      data-testid="fx-media-crop-dialog"
      {...BOARD_INTERACTIVE_PROPS}
    >
      <ModalTitle>{t('fantay.media.crop.title')}</ModalTitle>
      <div className={styles.layout}>
        <EditorStage viewport={viewport} imageUrl={imageUrl}>
          <span className={styles.mask} style={{ left: 0, right: 0, top: 0, height: `${crop.y * 100}%` }} />
          <span className={styles.mask} style={{ left: 0, right: 0, bottom: 0, height: `${(1 - crop.y - crop.height) * 100}%` }} />
          <span className={styles.mask} style={{ left: 0, top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.height * 100}%` }} />
          <span
            className={styles.mask}
            style={{ right: 0, top: `${crop.y * 100}%`, width: `${(1 - crop.x - crop.width) * 100}%`, height: `${crop.height * 100}%` }}
          />
          <div
            className={styles.cropBox}
            style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
            tabIndex={0}
            role="group"
            aria-label={cropSize ? t('fantay.media.crop.size', { w: cropSize.width, h: cropSize.height }) : t('fantay.media.crop.title')}
            data-testid="fx-media-crop-box"
            onPointerDown={(event) => startDrag('move', event)}
            onKeyDown={onBoxKeyDown}
          >
            <span className={styles.third} style={{ left: 0, right: 0, top: '33.333%', borderTopWidth: 1 }} />
            <span className={styles.third} style={{ left: 0, right: 0, top: '66.666%', borderTopWidth: 1 }} />
            <span className={styles.third} style={{ top: 0, bottom: 0, left: '33.333%', borderLeftWidth: 1 }} />
            <span className={styles.third} style={{ top: 0, bottom: 0, left: '66.666%', borderLeftWidth: 1 }} />
            {HANDLES.map((handle) => (
              <span
                key={handle}
                className={styles.handle}
                style={handleStyle(handle)}
                aria-hidden
                onPointerDown={(event) => startDrag('resize', event, handle)}
              />
            ))}
          </div>
        </EditorStage>
        <div className={styles.controls}>
          <Segmented
            size="sm"
            aria-label={t('fantay.media.crop.title')}
            value={preset}
            onValueChange={(next) => {
              const value = next as CropPreset;
              setPreset(value);
              const nextRatio = presetRatio(value, image);
              if (nextRatio && image) setCrop((current) => fitCropToRatio(current, nextRatio, image));
            }}
          >
            {PRESETS.map((entry) => (
              <SegmentedItem key={entry} value={entry} data-testid={`fx-media-crop-preset-${entry}`}>
                {entry === 'free' ? t('fantay.media.crop.free') : entry === 'original' ? t('fantay.media.crop.original') : entry}
              </SegmentedItem>
            ))}
          </Segmented>
          <div className={styles.readout}>
            <span>{cropSize ? t('fantay.media.crop.size', { w: cropSize.width, h: cropSize.height }) : '—'}</span>
            {image ? <span>{t('fantay.media.editor.source', { w: image.width, h: image.height })}</span> : null}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setCrop(preset === 'free' ? DEFAULT_CROP : fitCropToRatio(DEFAULT_CROP, ratio ?? 1, image ?? { width: 1, height: 1 }))}>
            {t('fantay.media.editor.reset')}
          </Button>
        </div>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('fantay.media.editor.cancel')}
        </Button>
        <Button variant="primary" loading={busy} data-testid="fx-media-crop-confirm" onClick={() => void confirm()}>
          {t('fantay.media.crop.confirm')}
        </Button>
      </ModalActions>
    </Modal>
  );
}
