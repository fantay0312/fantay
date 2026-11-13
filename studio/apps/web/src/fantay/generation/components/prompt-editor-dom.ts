// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-prompt-chip-input.tsx
// (L303-426) and web/src/components/canvas/canvas-config-composer.tsx (L273-370).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: the composer's `@[node:<id>]` token format with the chip-input's
// DOM handling, broken chips for tokens whose node is no longer an input, plain-text newlines, and
// pure helpers separated from the React component so they can be tested.
import { GENERATION_TOKEN_PATTERN } from '@open-design/contracts';

/** Attribute that marks a chip and carries the referenced node id. */
export const REF_NODE_ATTR = 'data-ref-node-id';
/** Placeholder that keeps an empty last line visible in a pre-wrap editor; never serialized. */
export const LINE_KEEPER = '﻿';

export type PromptToken = { type: 'text'; value: string } | { type: 'reference'; nodeId: string };

/** Splits a raw prompt into text and `@[node:<id>]` reference tokens. */
export function parsePromptTokens(value: string): PromptToken[] {
  const tokens: PromptToken[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(new RegExp(GENERATION_TOKEN_PATTERN.source, 'g'))) {
    if (match.index === undefined) continue;
    if (match.index > lastIndex) tokens.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    tokens.push({ type: 'reference', nodeId: match[1] ?? '' });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) tokens.push({ type: 'text', value: value.slice(lastIndex) });
  return tokens;
}

export function promptToken(nodeId: string): string {
  return `@[node:${nodeId}]`;
}

/**
 * Prompt text for previews: tokens become their input labels (图片1, 文本1); tokens whose node is no
 * longer an input are dropped; runs of spaces left behind collapse.
 */
export function previewPromptText(value: string, labels: ReadonlyMap<string, string>): string {
  return parsePromptTokens(value)
    .map((token) => (token.type === 'text' ? token.value : (labels.get(token.nodeId) ?? '')))
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function serializeNodes(nodes: NodeListOf<ChildNode>): string {
  let result = '';
  nodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent ?? '';
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const nodeId = node.getAttribute(REF_NODE_ATTR);
    if (nodeId) result += promptToken(nodeId);
    else if (node.tagName === 'BR') result += '\n';
    else {
      // Browsers wrap new lines in <div>/<p> blocks when content is pasted or typed around chips.
      const block = node.tagName === 'DIV' || node.tagName === 'P';
      if (block && result !== '' && !result.endsWith('\n')) result += '\n';
      result += serializeNodes(node.childNodes);
    }
  });
  return result;
}

/** Editor DOM → raw prompt: chips → `@[node:<id>]`, `<br>` → `\n`, line keepers removed. */
export function serializePromptEditor(editor: HTMLElement): string {
  return serializeNodes(editor.childNodes).split(LINE_KEEPER).join('');
}

/** Text from the start of the editor to the caret (null when the caret is not inside an editor). */
export function textBeforeCaret(): string {
  const selection = typeof window === 'undefined' ? null : window.getSelection();
  if (!selection?.rangeCount) return '';
  const range = selection.getRangeAt(0).cloneRange();
  const editor = closestEditor(range.startContainer);
  if (!editor) return '';
  range.setStart(editor, 0);
  return range.toString().split(LINE_KEEPER).join('');
}

/** The open `@query` right before the caret, or null. */
export function activeMentionQuery(textBefore: string): string | null {
  const match = /@([^\s@]*)$/.exec(textBefore);
  return match ? (match[1] ?? '') : null;
}

export function closestEditor(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[contenteditable='true']") ?? null;
}

/** Removes the `@query` text before the caret (the mention being completed). */
export function removeActiveMention(): void {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  const query = activeMentionQuery(textBeforeCaret());
  if (query === null) return;
  const container = range.startContainer;
  if (container.nodeType !== Node.TEXT_NODE) return;
  const start = Math.max(0, range.startOffset - query.length - 1);
  range.setStart(container, start);
  range.deleteContents();
}

/** Places the caret at the end of `element`. */
export function placeCaretAtEnd(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Inserts `nodes` at the caret (or at the end), then puts the caret after the last one. */
export function insertAtCaret(editor: HTMLElement, nodes: Node[]): void {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (!range || !editor.contains(range.startContainer)) {
    for (const node of nodes) editor.append(node);
    placeCaretAtEnd(editor);
    return;
  }
  range.deleteContents();
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node) range.insertNode(node);
  }
  const last = nodes[nodes.length - 1];
  if (last) {
    range.setStartAfter(last);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

/** Inserts a newline at the caret; keeps the new last line visible with a line keeper. */
export function insertLineBreak(editor: HTMLElement): void {
  const newline = document.createTextNode('\n');
  insertAtCaret(editor, [newline]);
  const after = newline.nextSibling;
  const atEnd = !after || (after.nodeType === Node.TEXT_NODE && (after.textContent ?? '') === '');
  if (atEnd) {
    const keeper = document.createTextNode(LINE_KEEPER);
    newline.after(keeper);
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.setStart(keeper, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
}

function findReferenceSibling(node: Node, previous: boolean, includeSelf = false): HTMLElement | null {
  let current: Node | null = includeSelf ? node : previous ? node.previousSibling : node.nextSibling;
  while (current && current.nodeType === Node.TEXT_NODE && !(current.textContent ?? '').replace(LINE_KEEPER, '').trim()) {
    current = previous ? current.previousSibling : current.nextSibling;
  }
  return current instanceof HTMLElement && current.hasAttribute(REF_NODE_ATTR) ? current : null;
}

function adjacentReferenceNode(range: Range, key: string): HTMLElement | null {
  const container = range.startContainer;
  const offset = range.startOffset;
  const previous = key === 'Backspace';
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? '';
    if ((previous && offset > 0) || (!previous && offset < text.length)) return null;
    return findReferenceSibling(container, previous);
  }
  const children = Array.from(container.childNodes);
  const target = children[previous ? offset - 1 : offset];
  return target ? findReferenceSibling(target, previous, true) : null;
}

/**
 * Chips are atomic `contenteditable="false"` spans: Backspace/Delete next to one removes it whole.
 * Returns true when a chip was removed.
 */
export function deleteAdjacentReference(key: 'Backspace' | 'Delete'): boolean {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const target = adjacentReferenceNode(range, key);
  if (!target) return false;
  const caret = document.createTextNode('');
  target.replaceWith(caret);
  range.setStart(caret, 0);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** Caret rectangle (falls back to the editor bounds on empty lines). */
export function caretRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  if (rect && (rect.width || rect.height || rect.left || rect.top)) return rect;
  const editor = closestEditor(range.startContainer);
  return editor ? editor.getBoundingClientRect() : null;
}
