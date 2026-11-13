// SPDX-License-Identifier: Apache-2.0
/**
 * The editor store the vendored OpenPencil UI talks to (06 §3.5): the SDK `Editor` plus the
 * app-level members the vendored components and the compat shims read. Members absent here
 * do not exist in Fantay (no panes, collaboration, AI, comments or design check).
 */
import type { Ref, ShallowRef } from 'vue';

import type { Editor, EditorState, ExportRequest, RasterExportFormat } from '../engine/op';

export interface FxStateExtensions {
  /** Canvas rulers (Shift+R); off by default. */
  showRulers: boolean;
  /** Written by the vendored NumberField while a field is being edited. */
  numberFieldFocused: boolean;
  /** The layer the vendored LayerTree should start renaming. */
  renameNodeId: string | null;
  /** No collaboration in Fantay: never drawn. */
  showRemoteCursors: boolean;
}

export type FxEditorState = EditorState & FxStateExtensions;

export interface ExportTargetRequest {
  target: ExportRequest['target'];
  formatId: string;
  options?: { scale?: number; quality?: number };
}

/** What a design check run reports for a page (never produced in phase 1). */
export interface FxDesignCheckSnapshot {
  pageId: string;
  issues: readonly unknown[];
}

/** Design check is not part of phase 1: an empty, inert implementation for the vendored UI. */
export interface FxDesignCheck {
  snapshot: ShallowRef<FxDesignCheckSnapshot | null>;
  highlightMarker(ids: string[] | null): void;
  openMarker(ids: string[]): void;
  pages: { counts: ShallowRef<Map<string, never>> };
}

export interface FxEditorExtensions {
  state: FxEditorState;
  /** The canvas centre in canvas-local screen pixels (what `applyZoom` takes as its centre). */
  viewportScreenCenter(): { x: number; y: number };
  /** The canvas centre in document coordinates (where placed files and pastes land). */
  viewportCanvasCenter(): { x: number; y: number };
  /** Records the canvas CSS size, as the scene surface reports it. */
  setViewportSize(width: number, height: number): void;
  renderExportImage(ids: string[], scale: number, format: RasterExportFormat): Promise<Uint8Array<ArrayBuffer> | null>;
  exportTargets(requests: ExportTargetRequest[]): Promise<void>;
  /** Vector node editing is not in phase 1: no-op. */
  nodeEditAlignVertices(axis: 'horizontal' | 'vertical', position: 'min' | 'center' | 'max'): void;
  designCheck: FxDesignCheck;
  readOnly: Ref<boolean>;
  /**
   * The SDK's own `getImage`, typed as what it returns in a browser: image bytes are always
   * backed by an ArrayBuffer (never shared memory), so they can feed a Blob under TS 6's DOM lib.
   */
  getImage(hash: string): Uint8Array<ArrayBuffer> | undefined;
}

/** Extensions first: where a member exists on both, call resolution sees the Fantay signature first. */
export type FxEditorStore = FxEditorExtensions & Editor;

export interface FxEditorStoreDeps {
  getViewportElement(): HTMLElement | null;
  downloadFile(bytes: Uint8Array, fileName: string, mime: string): void;
}
