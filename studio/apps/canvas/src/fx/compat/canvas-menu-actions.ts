// SPDX-License-Identifier: Apache-2.0
/**
 * Shim for OpenPencil's `@/app/editor/canvas/menu/actions` (06 §3.4): what the vendored canvas
 * and layer context menus run, on Fantay's clipboard (fx/editor/clipboard.ts) and toasts.
 * Image vectorizing is not part of phase 1.
 */
import type { Ref } from 'vue';

import { t } from '../../host/i18n';
import { pasteClipboardToReplace, runClipboardCommand, writeClipboardText } from '../editor/clipboard';
import { toastError, toastInfo } from '../editor/toasts';
import { nodeToXPath } from '../engine/op';
import type { FxEditorStore } from '../store/types';

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const bytes = new Uint8Array(data.length);
  bytes.set(data);
  return bytes.buffer;
}

export function createCanvasMenuActions(store: FxEditorStore, selectedIds: Ref<Set<string>>) {
  function ids(): string[] {
    return [...selectedIds.value];
  }

  function execCommand(command: 'copy' | 'cut' | 'paste'): void {
    const { cursorCanvasX: x, cursorCanvasY: y } = store.state;
    const cursorPos = x != null && y != null ? { x, y } : undefined;
    void runClipboardCommand(store, command, cursorPos).then((ok) => {
      if (!ok) toastError(t('designEditor.toast.clipboardBlocked'));
      return undefined;
    });
  }

  async function clipboardWrite(text: string | null, label: string): Promise<void> {
    if (!text) return;
    try {
      await writeClipboardText(text);
      toastInfo(t('designEditor.toast.copied', { what: label }));
    } catch {
      toastError(t('designEditor.toast.clipboardBlocked'));
    }
  }

  async function copyNodeId(): Promise<void> {
    const nodeIds = ids();
    if (nodeIds.length > 0) await clipboardWrite(nodeIds.join(', '), 'ID');
  }

  async function copyXPath(): Promise<void> {
    const xpaths = ids()
      .map((id) => nodeToXPath(store.graph, id))
      .filter((xpath): xpath is string => xpath !== null);
    if (xpaths.length > 0) await clipboardWrite(xpaths.join('\n'), 'XPath');
  }

  async function copyAsPNG(): Promise<void> {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      toastError(t('designEditor.toast.pngUnavailable'));
      return;
    }
    const data = await store.renderExportImage(ids(), 2, 'PNG');
    if (!data) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([toArrayBuffer(data)], { type: 'image/png' }) })]);
      toastInfo(t('designEditor.toast.copied', { what: 'PNG' }));
    } catch {
      toastError(t('designEditor.toast.clipboardBlocked'));
    }
  }

  return {
    ids,
    execCommand,
    pasteToReplace: async (): Promise<void> => {
      try {
        if (!(await pasteClipboardToReplace(store))) toastError(t('designEditor.toast.clipboardBlocked'));
      } catch {
        toastError(t('designEditor.toast.clipboardBlocked'));
      }
    },
    clipboardWrite,
    copyNodeId,
    copyXPath,
    copyAsPNG,
    canVectorizeImage: (): boolean => false,
    vectorizeImage: async (): Promise<void> => {},
  };
}
