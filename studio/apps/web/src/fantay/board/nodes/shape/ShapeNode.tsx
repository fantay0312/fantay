'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Shape face (spec 03 §4.7, plan R1): rect / ellipse / text with contract palette colours and `textStyle`.
// Text shapes grow with their content: a measured height different from the node's is written back as a
// non-undoable `autosize` patch.
import { useEffect, useRef } from 'react';

import { useT } from '../../../../i18n';
import { useBoardEngine } from '../../context';
import { boardColorCss, DEFAULT_SHAPE_TEXT_STYLE } from '../../model/defaults';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import { TextEditor } from '../TextEditor';
import styles from './shape.module.css';

export function ShapeNode({ view }: NodeFaceProps) {
  const t = useT();
  const { commands } = useBoardEngine();
  const node = view.node as EngineNodeOf<'shape'>;
  const { shape } = node.data;
  const textStyle = node.data.textStyle ?? DEFAULT_SHAPE_TEXT_STYLE;
  const text = node.data.text ?? '';
  const isText = shape === 'text';
  const contentRef = useRef<HTMLDivElement | null>(null);

  const strokeWidth = node.data.strokeWidth ?? (node.data.stroke && node.data.stroke !== 'none' ? 2 : 0);
  const style = isText
    ? {}
    : {
        background: boardColorCss(node.data.fill, 'transparent'),
        border: strokeWidth > 0 ? `${strokeWidth}px solid ${boardColorCss(node.data.stroke, 'transparent')}` : undefined,
        borderRadius: shape === 'rect' ? `${Math.min(node.data.radius ?? 0, Math.min(node.w, node.h) / 2)}px` : undefined,
      };
  const textCss = {
    fontSize: textStyle.fontSize,
    fontWeight: textStyle.fontWeight,
    textAlign: textStyle.align,
    color: boardColorCss(textStyle.color, 'var(--ink)'),
  } as const;

  // text shapes: auto height (ResizeObserver → system patch, never undoable). Editing swaps the measured element
  // for the editor, so the observer pauses while editing and re-attaches to the new content afterwards.
  const busy = view.previewRect !== null || view.readOnly || view.editingText;
  useEffect(() => {
    if (!isText || busy || typeof ResizeObserver !== 'function') return undefined;
    const el = contentRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(el.scrollHeight);
      if (height > 0 && Math.abs(height - node.h) > 1) {
        commands.updateNode(node.id, { h: height }, { origin: 'system', label: 'autosize' });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isText, busy, commands, node.id, node.h]);

  return (
    <div className={styles.shape} data-shape={shape} style={style} data-testid="board-shape">
      {view.editingText ? (
        <TextEditor
          initial={text}
          placeholder={t('board.node.textPlaceholder')}
          ariaLabel={t('board.kind.shape')}
          className={styles.editor}
          style={textCss}
          autoHeight={isText}
          onCommit={(next) => {
            commands.stopTextEdit();
            if (next !== text) commands.updateNode(node.id, { data: { text: next } }, { label: 'text' });
          }}
          onCancel={() => commands.stopTextEdit()}
        />
      ) : (
        <div ref={contentRef} className={styles.text} style={textCss}>
          {text.length > 0 ? text : isText ? <span className={styles.placeholder}>{t('board.node.textPlaceholder')}</span> : null}
        </div>
      )}
    </div>
  );
}
