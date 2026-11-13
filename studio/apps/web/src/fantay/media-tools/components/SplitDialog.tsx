// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node-split-dialog.tsx.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29 (spec 05 §6.7): Fantay Modal/Input/Button, rows and columns 1–12,
// draggable and keyboard-movable cut lines, Delete removes the selected line, ⌘/Ctrl+Z / ⇧⌘Z undo and
// redo, the piece count; no extra add-line buttons (lines follow rows/columns).
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';

import { useT } from '../../../i18n';
import { Button, Field, Input, Modal, ModalActions, ModalTitle } from '../../ui';
import { BOARD_INTERACTIVE_PROPS } from '../../generation/components/board-interactive';
import type { SplitParams } from '../image-ops';
import { useImageEditorViewport } from '../use-image-editor-viewport';
import { EditorStage, editorStageStyles as styles, useImageNaturalSize } from './EditorStage';

type Axis = 'horizontal' | 'vertical';
type ActiveLine = { axis: Axis; index: number } | null;

export const MAX_SPLIT_GRID = 12;
const HISTORY_LIMIT = 50;
const DEFAULT_SPLIT: Required<SplitParams> = { rows: 2, columns: 2, horizontalLines: [0.5], verticalLines: [0.5] };

/** Even interior lines for `count` cells (upstream `buildGridLines`). */
export function buildGridLines(count: number): number[] {
  const cells = Math.max(1, Math.round(count));
  return Array.from({ length: cells - 1 }, (_, index) => (index + 1) / cells);
}

export function clampGridCount(value: unknown): number {
  const numeric = Number(value);
  return Math.min(MAX_SPLIT_GRID, Math.max(1, Math.round(Number.isFinite(numeric) ? numeric : 1)));
}

function clampLine(value: number, min: number, max: number): number {
  return Math.min(max - 0.01, Math.max(min + 0.01, value));
}

function cloneParams(params: Required<SplitParams>): Required<SplitParams> {
  return { ...params, horizontalLines: [...params.horizontalLines], verticalLines: [...params.verticalLines] };
}

export interface SplitDialogProps {
  open: boolean;
  imageUrl: string;
  onClose(): void;
  onConfirm(params: Required<SplitParams>): Promise<unknown> | void;
}

export function SplitDialog({ open, imageUrl, onClose, onConfirm }: SplitDialogProps) {
  const t = useT();
  const [params, setParams] = useState<Required<SplitParams>>(DEFAULT_SPLIT);
  const [active, setActive] = useState<ActiveLine>(null);
  const [busy, setBusy] = useState(false);
  const history = useRef<Required<SplitParams>[]>([]);
  const redo = useRef<Required<SplitParams>[]>([]);
  const dragAbort = useRef<AbortController | null>(null);
  const image = useImageNaturalSize(imageUrl, open);
  const viewport = useImageEditorViewport(image, open);
  const rows = params.horizontalLines.length + 1;
  const columns = params.verticalLines.length + 1;
  const pieces = rows * columns;

  useEffect(() => {
    if (!open) {
      dragAbort.current?.abort();
      return;
    }
    setParams(DEFAULT_SPLIT);
    setActive(null);
    setBusy(false);
    history.current = [];
    redo.current = [];
  }, [open, imageUrl]);
  useEffect(() => () => dragAbort.current?.abort(), []);

  const pushHistory = useCallback((current: Required<SplitParams>) => {
    history.current.push(cloneParams(current));
    if (history.current.length > HISTORY_LIMIT) history.current.shift();
    redo.current = [];
  }, []);

  const setCount = (axis: Axis, value: unknown) => {
    const count = clampGridCount(value);
    pushHistory(params);
    setActive(null);
    setParams((current) =>
      axis === 'horizontal'
        ? { ...current, rows: count, horizontalLines: buildGridLines(count) }
        : { ...current, columns: count, verticalLines: buildGridLines(count) },
    );
  };

  const setLine = (axis: Axis, index: number, value: number) => {
    setParams((current) => {
      const key = axis === 'horizontal' ? 'horizontalLines' : 'verticalLines';
      const lines = [...current[key]];
      lines[index] = clampLine(value, lines[index - 1] ?? 0, lines[index + 1] ?? 1);
      return { ...current, [key]: lines };
    });
  };

  const deleteLine = useCallback(() => {
    if (!active) return;
    pushHistory(params);
    setParams((current) => {
      const key = active.axis === 'horizontal' ? 'horizontalLines' : 'verticalLines';
      const lines = current[key].filter((_, index) => index !== active.index);
      return active.axis === 'horizontal'
        ? { ...current, horizontalLines: lines, rows: lines.length + 1 }
        : { ...current, verticalLines: lines, columns: lines.length + 1 };
    });
    setActive(null);
  }, [active, params, pushHistory]);

  const undo = useCallback(() => {
    const previous = history.current.pop();
    if (!previous) return;
    redo.current.push(cloneParams(params));
    setParams(previous);
    setActive(null);
  }, [params]);

  const redoStep = useCallback(() => {
    const next = redo.current.pop();
    if (!next) return;
    history.current.push(cloneParams(params));
    setParams(next);
    setActive(null);
  }, [params]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input,textarea,[contenteditable='true']")) return;
      const key = event.key.toLowerCase();
      const mod = event.metaKey || event.ctrlKey;
      const isUndo = mod && !event.altKey && !event.shiftKey && key === 'z';
      const isRedo = mod && !event.altKey && ((event.shiftKey && key === 'z') || (!event.shiftKey && key === 'y'));
      const isDelete = event.key === 'Delete' || event.key === 'Backspace';
      if (!isUndo && !isRedo && !(isDelete && active)) return;
      event.preventDefault();
      event.stopPropagation();
      if (isDelete) deleteLine();
      else if (isRedo) redoStep();
      else undo();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active, deleteLine, open, redoStep, undo]);

  const startDrag = (axis: Axis, index: number, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setActive({ axis, index });
    const box = viewport.stageRef.current?.getBoundingClientRect();
    if (!box) return;
    pushHistory(params);
    dragAbort.current?.abort();
    const controller = new AbortController();
    dragAbort.current = controller;
    const move = (moveEvent: PointerEvent) =>
      setLine(
        axis,
        index,
        axis === 'horizontal' ? (moveEvent.clientY - box.top) / Math.max(1, box.height) : (moveEvent.clientX - box.left) / Math.max(1, box.width),
      );
    const stop = () => controller.abort();
    window.addEventListener('pointermove', move, { signal: controller.signal });
    window.addEventListener('pointerup', stop, { signal: controller.signal });
    window.addEventListener('pointercancel', stop, { signal: controller.signal });
  };

  const onLineKeyDown = (axis: Axis, index: number, event: React.KeyboardEvent) => {
    const lines = axis === 'horizontal' ? params.horizontalLines : params.verticalLines;
    const forward = axis === 'horizontal' ? 'ArrowDown' : 'ArrowRight';
    const backward = axis === 'horizontal' ? 'ArrowUp' : 'ArrowLeft';
    if (event.key !== forward && event.key !== backward) return;
    event.preventDefault();
    pushHistory(params);
    const step = event.shiftKey ? 0.05 : 0.01;
    setLine(axis, index, (lines[index] ?? 0.5) + (event.key === forward ? step : -step));
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm({ ...params, rows, columns });
    } finally {
      setBusy(false);
    }
  };

  const renderLine = (axis: Axis, line: number, index: number) => (
    <span
      key={`${axis}-${index}`}
      className={styles.cutLine}
      data-axis={axis}
      data-active={active?.axis === axis && active.index === index ? '' : undefined}
      style={axis === 'vertical' ? { left: `${line * 100}%` } : { top: `${line * 100}%` }}
      tabIndex={0}
      role="separator"
      aria-orientation={axis === 'vertical' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(line * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      data-testid={`fx-media-split-line-${axis}-${index}`}
      onFocus={() => setActive({ axis, index })}
      onPointerDown={(event) => startDrag(axis, index, event)}
      onKeyDown={(event) => onLineKeyDown(axis, index, event)}
    />
  );

  return (
    <Modal
      open={open && Boolean(imageUrl)}
      onClose={onClose}
      size="2xl"
      className="max-w-[min(840px,calc(100vw-24px))]"
      aria-describedby={undefined}
      data-testid="fx-media-split-dialog"
      {...BOARD_INTERACTIVE_PROPS}
    >
      <ModalTitle>{t('fantay.media.split.title')}</ModalTitle>
      <div className={styles.layout}>
        <EditorStage viewport={viewport} imageUrl={imageUrl} hint={t('fantay.media.split.hint')}>
          {params.verticalLines.map((line, index) => renderLine('vertical', line, index))}
          {params.horizontalLines.map((line, index) => renderLine('horizontal', line, index))}
        </EditorStage>
        <div className={styles.controls}>
          <div className={styles.fields}>
            <Field label={t('fantay.media.split.rows')} htmlFor="fx-split-rows" labelVariant="form">
              <Input
                id="fx-split-rows"
                type="number"
                min={1}
                max={MAX_SPLIT_GRID}
                step={1}
                value={rows}
                data-testid="fx-media-split-rows"
                onChange={(event) => setCount('horizontal', event.target.value)}
              />
            </Field>
            <Field label={t('fantay.media.split.columns')} htmlFor="fx-split-columns" labelVariant="form">
              <Input
                id="fx-split-columns"
                type="number"
                min={1}
                max={MAX_SPLIT_GRID}
                step={1}
                value={columns}
                data-testid="fx-media-split-columns"
                onChange={(event) => setCount('vertical', event.target.value)}
              />
            </Field>
          </div>
          <div className={styles.readout}>
            <span data-testid="fx-media-split-pieces">{t('fantay.media.split.pieces', { n: pieces })}</span>
            {image ? <span>{t('fantay.media.editor.source', { w: image.width, h: image.height })}</span> : null}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              pushHistory(params);
              setActive(null);
              setParams((current) => ({ ...current, horizontalLines: buildGridLines(current.rows), verticalLines: buildGridLines(current.columns) }));
            }}
          >
            {t('fantay.media.editor.reset')}
          </Button>
        </div>
      </div>
      <ModalActions>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          {t('fantay.media.editor.cancel')}
        </Button>
        <Button variant="primary" loading={busy} data-testid="fx-media-split-confirm" onClick={() => void confirm()}>
          {t('fantay.media.split.confirm')}
        </Button>
      </ModalActions>
    </Modal>
  );
}
