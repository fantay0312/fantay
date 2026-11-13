// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// SPDX-FileCopyrightText: 2026 Fantay contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/app/editor/clipboard/system/browser.ts
//   with src/app/editor/clipboard/{html,memory,paste,paste-to-replace}.ts and
//   src/app/shell/keyboard/clipboard.ts (same tag)
// Modified by Fantay: browser-only; copy/cut run from keydown with the async Clipboard API, the
// paste reads the native paste event; Fantay toasts instead of the app shell's.
import { extractImageFilesFromClipboard, isSVGMarkup } from '../engine/op';
import type { FxEditorStore } from '../store/types';

type Vector = { x: number; y: number };
type ClipboardPayload = Awaited<ReturnType<FxEditorStore['prepareCopy']>>;
type PasteOptions = Parameters<FxEditorStore['pasteFromHTML']>[2];

const OPENPENCIL_START = '<!--(openpencil)';
const OPENPENCIL_END = '(/openpencil)-->';
const FIGMA_START = '<!--(figma)';
const FIGMA_END = '(/figma)-->';
const ESCAPED_FIGMA_START = '&lt;!--(figma)';
const ESCAPED_FIGMA_END = '(/figma)--&gt;';

function hasCompleteMarker(html: string, start: string, end: string): boolean {
  const startIndex = html.indexOf(start);
  return startIndex !== -1 && html.includes(end, startIndex + start.length);
}

/** Clipboard HTML that carries design layers (an OpenPencil or Figma copy). */
export function isDesignClipboardHTML(html: string): boolean {
  return (
    hasCompleteMarker(html, OPENPENCIL_START, OPENPENCIL_END) ||
    hasCompleteMarker(html, FIGMA_START, FIGMA_END) ||
    hasCompleteMarker(html, ESCAPED_FIGMA_START, ESCAPED_FIGMA_END)
  );
}

let memory: ClipboardPayload = { html: '', plainText: '' };

/** What identifies a copy: its Base64 metadata and buffer, which survive clipboard rewrites. */
function clipboardPayloadKey(html: string): string | null {
  const meta = /\(figmeta\)(.*?)\(\/figmeta\)/.exec(html)?.[1];
  const buffer = /\(figma\)(.*?)\(\/figma\)/s.exec(html)?.[1];
  return meta && buffer ? `${meta}:${buffer}` : null;
}

function matchingClipboardSnapshot(html: string) {
  const { snapshot } = memory;
  if (!html || !snapshot) return undefined;
  if (html === memory.html) return snapshot;
  const key = clipboardPayloadKey(html);
  return key !== null && key === clipboardPayloadKey(memory.html) ? snapshot : undefined;
}

export function rememberClipboardPayload(payload: ClipboardPayload): void {
  memory = payload;
}

export function rememberedClipboardHTML(): string {
  return memory.html;
}

export function clearRememberedClipboard(): void {
  memory = { html: '', plainText: '' };
}

function cursorPosition(store: FxEditorStore): Vector | undefined {
  const { cursorCanvasX: x, cursorCanvasY: y } = store.state;
  return x != null && y != null ? { x, y } : undefined;
}

/** Where a paste without a copied position goes: the cursor, else the middle of the view. */
export function pastePoint(store: FxEditorStore, cursorPos?: Vector): Vector {
  return cursorPos ?? store.viewportCanvasCenter();
}

export async function pasteClipboardHTML(store: FxEditorStore, html: string, cursorPos?: Vector, options: PasteOptions = {}): Promise<void> {
  const snapshot = matchingClipboardSnapshot(html);
  if (snapshot) await store.pasteSnapshot(snapshot, cursorPos, options);
  else await store.pasteFromHTML(html, cursorPos, options);
}

/** Pastes SVG markup (e.g. Figma's Copy as SVG) as layers; false when the text is not SVG. */
export async function pasteSVGText(store: FxEditorStore, text: string, cursorPos?: Vector): Promise<boolean> {
  if (!isSVGMarkup(text)) return false;
  const { x, y } = pastePoint(store, cursorPos);
  return store.pasteSVG(text, x, y);
}

function blobOf(text: Promise<string>, type: string): Promise<Blob> {
  return text.then((value) => new Blob([value], { type }));
}

/**
 * Copies the selection. The write starts inside the key press with promised blobs (browsers
 * accept a clipboard write only during the gesture), and the payload is kept in memory so an
 * in-editor paste keeps full fidelity even where the system clipboard is unavailable.
 */
export async function copySelection(store: FxEditorStore): Promise<boolean> {
  if (store.state.selectedIds.size === 0) return false;
  const prepared = store.prepareCopy();
  let written = false;
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': blobOf(prepared.then((payload) => payload.html), 'text/html'),
          'text/plain': blobOf(prepared.then((payload) => payload.plainText), 'text/plain'),
        }),
      ]);
      written = true;
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText((await prepared).plainText);
      written = true;
    }
  } catch (error) {
    console.warn('[fantay-design] clipboard write failed', error);
  }
  const payload = await prepared.catch(() => null);
  if (!payload || (!payload.html && !payload.plainText)) return false;
  rememberClipboardPayload(payload);
  return written;
}

export async function cutSelection(store: FxEditorStore): Promise<boolean> {
  const selected = new Set(store.state.selectedIds);
  if (selected.size === 0) return false;
  const copied = await copySelection(store);
  const unchanged = selected.size === store.state.selectedIds.size && [...selected].every((id) => store.state.selectedIds.has(id));
  if (unchanged && (copied || rememberedClipboardHTML())) store.deleteSelected();
  return copied;
}

async function readSystemClipboard(): Promise<{ html: string | null; text: string | null } | null> {
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.read !== 'function') return null;
  try {
    const item = (await navigator.clipboard.read()).at(0);
    if (!item) return { html: null, text: null };
    const read = async (type: string) => (item.types.includes(type) ? (await item.getType(type)).text() : null);
    return { html: await read('text/html'), text: await read('text/plain') };
  } catch (error) {
    console.warn('[fantay-design] clipboard read failed', error);
    return null;
  }
}

/** Paste from the context menu ("Paste here"), which has no paste event to read from. */
export async function pasteFromSystemClipboard(store: FxEditorStore, cursorPos?: Vector): Promise<boolean> {
  const result = await readSystemClipboard();
  if (result) {
    if (result.html && isDesignClipboardHTML(result.html)) {
      await pasteClipboardHTML(store, result.html, cursorPos);
      return true;
    }
    if (result.text !== null && (await pasteSVGText(store, result.text, cursorPos))) return true;
  }
  const remembered = rememberedClipboardHTML();
  if (remembered && isDesignClipboardHTML(remembered)) {
    await pasteClipboardHTML(store, remembered, cursorPos);
    return true;
  }
  return false;
}

/** Paste to replace: the copied layers take the place of the selection. */
export async function pasteClipboardToReplace(store: FxEditorStore): Promise<boolean> {
  const result = await readSystemClipboard();
  const html = result?.html && isDesignClipboardHTML(result.html) ? result.html : rememberedClipboardHTML();
  if (!html || !isDesignClipboardHTML(html)) return false;
  await pasteClipboardHTML(store, html, undefined, { replaceSelection: true });
  return true;
}

export async function runClipboardCommand(store: FxEditorStore, command: 'copy' | 'cut' | 'paste', cursorPos?: Vector): Promise<boolean> {
  if (command === 'copy') return copySelection(store);
  if (command === 'cut') return cutSelection(store);
  return pasteFromSystemClipboard(store, cursorPos ?? cursorPosition(store));
}

export async function writeClipboardText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * Handles a native paste event: image files, design layers, SVG markup, then the remembered
 * copy. Returns true when the event was consumed.
 */
export function handlePasteEvent(store: FxEditorStore, event: ClipboardEvent): boolean {
  const cursorPos = cursorPosition(store);
  const imageFiles = extractImageFilesFromClipboard(event);
  if (imageFiles.length > 0) {
    const { x, y } = pastePoint(store, cursorPos);
    void store.placeImageFiles(imageFiles, x, y);
    return true;
  }
  const html = event.clipboardData?.getData('text/html') ?? '';
  if (html && isDesignClipboardHTML(html)) {
    // Like Figma, Paste keeps the copied position; "Paste here" in the canvas menu uses the cursor.
    void pasteClipboardHTML(store, html);
    return true;
  }
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (isSVGMarkup(text)) {
    void pasteSVGText(store, text, cursorPos);
    return true;
  }
  const remembered = rememberedClipboardHTML();
  if (remembered && isDesignClipboardHTML(remembered) && !text) {
    void pasteClipboardHTML(store, remembered);
    return true;
  }
  return false;
}
