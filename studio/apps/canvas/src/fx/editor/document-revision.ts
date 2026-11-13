// SPDX-License-Identifier: Apache-2.0
/**
 * Document revisions for autosave (06 §3.8): a counter that moves on document edits only.
 *
 * The SDK's `state.sceneVersion` also moves when nothing in the document changed: switching
 * pages, layout passes (a font arriving), a page's layers loading. Counting it would save
 * documents the user only looked at (rewriting a foreign `.fig` in this editor's format) and
 * report read-only documents as unsaved. The edits counted here are the ones OpenPencil's own
 * app counts (`src/app/document/io/changes.ts` at v0.16.0): layer changes outside layout and
 * imported state, plus history changes (every recorded step, undo and redo).
 */
import { shallowRef, type ShallowRef } from 'vue';

import type { FxEditorStore } from '../store/types';

export interface DocumentRevisions {
  /** Moves on every document edit. */
  readonly revision: Readonly<ShallowRef<number>>;
  dispose(): void;
}

export function trackDocumentRevisions(store: Pick<FxEditorStore, 'graph' | 'onEditorEvent'>): DocumentRevisions {
  const revision = shallowRef(0);
  const edited = () => {
    revision.value += 1;
  };
  // A page's layers loading (the reader filling them in) is not an edit.
  const layersChanged = () => {
    if (!store.graph.isApplyingImportedState) edited();
  };
  // Layout derives sizes and positions from the document; an edit's own change has counted.
  const layerUpdated = () => {
    const { graph } = store;
    if (!graph.isApplyingLayout && !graph.isApplyingDerivedLayout && !graph.isApplyingImportedState) edited();
  };
  const stops = [
    store.onEditorEvent('node:created', layersChanged),
    store.onEditorEvent('node:updated', layerUpdated),
    store.onEditorEvent('node:deleted', layersChanged),
    store.onEditorEvent('node:reparented', layersChanged),
    store.onEditorEvent('node:reordered', layersChanged),
    store.onEditorEvent('history:changed', edited),
    store.onEditorEvent('document:color-space-changed', edited),
  ];
  return {
    revision,
    dispose() {
      for (const stop of stops.splice(0)) stop();
    },
  };
}
