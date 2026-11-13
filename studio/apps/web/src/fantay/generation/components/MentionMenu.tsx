// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-prompt-chip-input.tsx
// (MentionMenu, ReferencePreview, L201-273).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: listbox semantics driven by the editor's aria-activedescendant,
// an empty state, Fantay tokens; options are not focusable (the caret stays in the editor).
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FileText, ImageIcon } from 'lucide-react';
import type { CompiledInput } from '@open-design/contracts';

import { cn } from '../../ui';
import { BOARD_INTERACTIVE_PROPS } from './board-interactive';
import styles from './PromptChipEditor.module.css';

const MENU_WIDTH = 256;
const MENU_MAX_HEIGHT = 224;
const GAP = 6;

export interface MentionMenuProps {
  id: string;
  rect: DOMRect | null;
  options: CompiledInput[];
  previews: Record<string, string | undefined>;
  activeIndex: number;
  emptyLabel: string;
  optionId(index: number): string;
  onSelect(input: CompiledInput): void;
  onHover(index: number): void;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function MentionMenu({ id, rect, options, previews, activeIndex, emptyLabel, optionId, onSelect, onHover }: MentionMenuProps) {
  const activeRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef(false);

  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, options]);

  if (typeof document === 'undefined') return null;
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
  const anchor = rect ?? ({ left: 16, top: 16, bottom: 16 } as DOMRect);
  const left = clamp(anchor.left, 8, viewportWidth - MENU_WIDTH - 8);
  const showAbove = anchor.bottom + GAP + MENU_MAX_HEIGHT > viewportHeight && anchor.top - GAP - MENU_MAX_HEIGHT >= 0;
  const top = showAbove ? anchor.top - GAP - MENU_MAX_HEIGHT : anchor.bottom + GAP;

  const select = (input: CompiledInput) => {
    if (selectedRef.current) return;
    selectedRef.current = true;
    onSelect(input);
  };

  return createPortal(
    <div
      id={id}
      role="listbox"
      className={cn('fx', styles.menu)}
      style={{ left, top }}
      data-testid="fx-gen-mention-menu"
      {...BOARD_INTERACTIVE_PROPS}
      onPointerDown={(event) => {
        // Keep the caret in the editor.
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {options.length === 0 ? (
        <div className={styles.menuEmpty} role="presentation">
          {emptyLabel}
        </div>
      ) : (
        options.map((input, index) => {
          const preview = input.kind === 'image' ? previews[input.nodeId] : undefined;
          return (
            <div
              key={input.nodeId}
              id={optionId(index)}
              ref={index === activeIndex ? activeRef : undefined}
              role="option"
              aria-selected={index === activeIndex}
              className={styles.option}
              data-testid={`fx-gen-mention-option-${input.nodeId}`}
              onPointerEnter={() => onHover(index)}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                select(input);
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                select(input);
              }}
            >
              <span className={styles.optionPreview} aria-hidden>
                {preview ? <img src={preview} alt="" /> : input.kind === 'image' ? <ImageIcon size={16} strokeWidth={1.5} /> : <FileText size={16} strokeWidth={1.5} />}
              </span>
              <span className={styles.optionText}>
                <span className={styles.optionLabel}>{input.label}</span>
                {input.text || input.title ? <span className={styles.optionDetail}>{input.text || input.title}</span> : null}
              </span>
            </div>
          );
        })
      )}
    </div>,
    document.body,
  );
}
