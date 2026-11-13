// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-prompt-chip-input.tsx
// (L34-199) and web/src/components/canvas/canvas-config-composer.tsx (L245-288, chip creation).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29 (spec 05 §5.3): `@[node:<id>]` tokens, ⌘/Ctrl+Enter submits and plain
// Enter inserts a newline (a run costs money), broken chips for tokens whose node is no longer an input,
// an empty mention state, plain-text paste, listbox semantics, Esc/submit callbacks instead of event
// propagation, and every keydown kept from the board's shortcuts.
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import type { CompiledInput } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { isImeComposing, isSubmitShortcut } from '../keyboard';
import { BOARD_REGION_PROPS } from './board-interactive';
import { MentionMenu } from './MentionMenu';
import {
  REF_NODE_ATTR,
  activeMentionQuery,
  caretRect,
  deleteAdjacentReference,
  insertAtCaret,
  insertLineBreak,
  parsePromptTokens,
  removeActiveMention,
  serializePromptEditor,
  textBeforeCaret,
} from './prompt-editor-dom';
import styles from './PromptChipEditor.module.css';

export interface PromptChipEditorProps {
  /** Raw text with `@[node:id]` tokens. */
  value: string;
  /** Mention candidates and chip labels (compile order). */
  inputs: CompiledInput[];
  /** nodeId → thumbnail URL. */
  previews: Record<string, string | undefined>;
  onChange(next: string): void;
  /** ⌘/Ctrl+Enter. */
  onSubmit?(): void;
  /** Escape while no mention menu is open (the panel closes). */
  onEscape?(): void;
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  minHeight?: number;
  maxHeight?: number;
  disabled?: boolean;
  onPreview?(nodeId: string): void;
  className?: string;
  /** `bare`: no box of its own, for a surface that already is one (the docked panel). */
  variant?: 'boxed' | 'bare';
}

export interface PromptChipEditorHandle {
  focus(): void;
}

interface MentionState {
  query: string;
  rect: DOMRect | null;
}

function chipFor(
  nodeId: string,
  input: CompiledInput | undefined,
  preview: string | undefined,
  brokenLabel: string,
  onPreview: (nodeId: string) => void,
): HTMLElement {
  const chip = document.createElement('span');
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute(REF_NODE_ATTR, nodeId);
  if (!input) {
    chip.className = `${styles.chip} ${styles.chipBroken}`;
    chip.dataset.broken = '';
    chip.title = brokenLabel;
    const text = document.createElement('span');
    text.className = styles.chipLabel ?? '';
    text.textContent = brokenLabel;
    chip.appendChild(text);
    return chip;
  }
  chip.dataset.kind = input.kind;
  if (input.kind === 'image' && preview) {
    chip.className = `${styles.chip} ${styles.chipImage}`;
    chip.title = input.title ? `${input.label} · ${input.title}` : input.label;
    const image = document.createElement('img');
    image.src = preview;
    image.alt = input.label;
    image.draggable = false;
    chip.appendChild(image);
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onPreview(nodeId);
    });
    return chip;
  }
  chip.className = styles.chip ?? '';
  chip.title = input.kind === 'text' ? (input.text ?? input.title ?? input.label) : (input.title ?? input.label);
  const text = document.createElement('span');
  text.className = styles.chipLabel ?? '';
  text.textContent = input.label;
  chip.appendChild(text);
  return chip;
}

function matchesQuery(input: CompiledInput, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${input.label} ${input.title ?? ''} ${input.text ?? ''}`.toLowerCase().includes(normalized);
}

export const PromptChipEditor = forwardRef<PromptChipEditorHandle, PromptChipEditorProps>(function PromptChipEditor(
  {
    value,
    inputs,
    previews,
    onChange,
    onSubmit,
    onEscape,
    placeholder,
    ariaLabel,
    autoFocus = false,
    minHeight,
    maxHeight,
    disabled = false,
    onPreview,
    className,
    variant = 'boxed',
  },
  ref,
) {
  const t = useT();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const composingRef = useRef(false);
  /* `value` only changes when a composition ends, so the placeholder hides on its start (IME text). */
  const [composing, setComposing] = useState(false);
  /* The last value emitted to the parent: an identical focused value is this editor's own echo, so
     the DOM is not rebuilt (keeps the caret and IME). External changes rebuild even while focused. */
  const lastEmittedRef = useRef<string | null>(null);
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const menuId = useId();
  const optionId = useCallback((index: number) => `${menuId}-option-${index}`, [menuId]);

  const inputById = useMemo(() => new Map(inputs.map((input) => [input.nodeId, input])), [inputs]);
  const candidates = useMemo(() => (mention ? inputs.filter((input) => matchesQuery(input, mention.query)) : []), [inputs, mention]);
  const brokenLabel = t('fantay.gen.prompt.brokenRef');

  useImperativeHandle(ref, () => ({
    focus: () => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      if (typeof window !== 'undefined' && window.getSelection) {
        const selection = window.getSelection();
        if (selection && (!selection.rangeCount || !editor.contains(selection.getRangeAt(0).startContainer))) {
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    },
  }));

  // Rebuild the DOM from `value` when unfocused, or when a focused value is an external change.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const focused = typeof document !== 'undefined' && document.activeElement === editor;
    if (focused && value === lastEmittedRef.current) return;
    editor.textContent = '';
    for (const token of parsePromptTokens(value)) {
      if (token.type === 'text') {
        editor.append(document.createTextNode(token.value));
        continue;
      }
      editor.append(
        chipFor(token.nodeId, inputById.get(token.nodeId), previews[token.nodeId], brokenLabel, (nodeId) => onPreviewRef.current?.(nodeId)),
      );
    }
    lastEmittedRef.current = value;
  }, [value, inputById, previews, brokenLabel]);

  useEffect(() => {
    if (!autoFocus) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
  }, [autoFocus]);

  const emit = (next: string) => {
    lastEmittedRef.current = next;
    onChange(next);
  };

  const closeMention = useCallback(() => {
    setMention(null);
    setActiveIndex(0);
  }, []);

  const syncMention = () => {
    const query = activeMentionQuery(textBeforeCaret());
    if (query === null) {
      closeMention();
      return;
    }
    setMention((current) => (current && current.query === query ? current : { query, rect: caretRect() }));
    setActiveIndex(0);
  };

  const syncFromEditor = () => {
    const editor = editorRef.current;
    if (!editor) return;
    emit(serializePromptEditor(editor));
    syncMention();
  };

  const insertReference = (input: CompiledInput) => {
    const editor = editorRef.current;
    if (!editor) return;
    removeActiveMention();
    const chip = chipFor(input.nodeId, input, previews[input.nodeId], brokenLabel, (nodeId) => onPreviewRef.current?.(nodeId));
    insertAtCaret(editor, [chip, document.createTextNode(' ')]);
    closeMention();
    emit(serializePromptEditor(editor));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Typing never reaches the board's shortcuts (V/H/N…, Delete, ⌘Z).
    event.stopPropagation();
    if (disabled) return;
    if (composingRef.current || isImeComposing(event)) return;
    if (mention) {
      if (candidates.length > 0 && event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % candidates.length);
        return;
      }
      if (candidates.length > 0 && event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
        return;
      }
      if (candidates.length > 0 && event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        const choice = candidates[Math.min(activeIndex, candidates.length - 1)];
        if (choice) insertReference(choice);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMention();
        return;
      }
    }
    if (event.key === 'Escape') {
      onEscape?.();
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && deleteAdjacentReference(event.key)) {
      event.preventDefault();
      syncFromEditor();
      return;
    }
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      onSubmit?.();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const editor = editorRef.current;
      if (!editor) return;
      insertLineBreak(editor);
      syncFromEditor();
      return;
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(syncMention);
    else syncMention();
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (disabled) return;
    const text = event.clipboardData.getData('text/plain');
    const editor = editorRef.current;
    if (!text || !editor) return;
    insertAtCaret(editor, [document.createTextNode(text.replace(/\r\n?/g, '\n'))]);
    syncFromEditor();
  };

  const style: React.CSSProperties = {};
  if (minHeight !== undefined) style.minHeight = minHeight;
  if (maxHeight !== undefined) style.maxHeight = maxHeight;
  const menuOpen = mention !== null;
  const activeOption = menuOpen && candidates.length > 0 ? optionId(Math.min(activeIndex, candidates.length - 1)) : undefined;

  return (
    <div className={styles.root} {...BOARD_REGION_PROPS}>
      {!value.trim() && !composing && placeholder ? (
        <div className={styles.placeholder} data-variant={variant} aria-hidden>
          {placeholder}
        </div>
      ) : null}
      <div
        ref={editorRef}
        className={className ? `${styles.editor} ${className}` : styles.editor}
        style={style}
        data-variant={variant}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        aria-activedescendant={activeOption}
        tabIndex={disabled ? -1 : 0}
        spellCheck
        data-testid="fx-gen-prompt"
        onInput={() => {
          if (!composingRef.current) syncFromEditor();
        }}
        onCompositionStart={() => {
          composingRef.current = true;
          setComposing(true);
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          setComposing(false);
          syncFromEditor();
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={(event) => event.preventDefault()}
        onBlur={() => {
          setTimeout(closeMention, 120);
        }}
      />
      {menuOpen ? (
        <MentionMenu
          id={menuId}
          rect={mention.rect}
          options={candidates}
          previews={previews}
          activeIndex={Math.min(activeIndex, Math.max(0, candidates.length - 1))}
          emptyLabel={t('fantay.gen.prompt.mentionEmpty')}
          optionId={optionId}
          onSelect={insertReference}
          onHover={setActiveIndex}
        />
      ) : null}
    </div>
  );
});
