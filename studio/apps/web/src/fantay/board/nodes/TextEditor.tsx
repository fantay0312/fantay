'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// In-node text editor for notes and shapes (spec 03 §4.6–§4.7): the Fantay Textarea, autosized, inside a
// `data-board-interactive` region (R6) so the board ignores its pointer, wheel and keys. Commits on blur or
// mod+Enter, Esc reverts; the IME composition guard keeps Enter/Esc for the candidate window.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { Textarea } from '../../ui/textarea';
import { BOARD_INTERACTIVE_ATTR } from '../extensions';

export interface TextEditorProps {
  initial: string;
  placeholder: string;
  ariaLabel: string;
  onCommit(text: string): void;
  onCancel(): void;
  className?: string;
  style?: CSSProperties;
  /** grow with the content (shape text) instead of filling the node */
  autoHeight?: boolean;
  maxLength?: number;
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

export function TextEditor({ initial, placeholder, ariaLabel, onCommit, onCancel, className, style, autoHeight = false, maxLength }: TextEditorProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const settled = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !autoHeight) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value, autoHeight]);

  const commit = (): void => {
    if (settled.current) return;
    settled.current = true;
    onCommit(value);
  };

  const cancel = (): void => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  return (
    <div
      {...{ [BOARD_INTERACTIVE_ATTR]: '' }}
      style={{ width: '100%', height: autoHeight ? 'auto' : '100%' }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Textarea
        ref={ref}
        variant="bare"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        maxLength={maxLength}
        className={className}
        style={{ height: autoHeight ? undefined : '100%', overflow: autoHeight ? 'hidden' : 'auto', ...style }}
        onChange={(event) => setValue(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancel();
            return;
          }
          const mod = isMac() ? event.metaKey : event.ctrlKey;
          if (event.key === 'Enter' && mod) {
            event.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
