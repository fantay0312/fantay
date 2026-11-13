// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// SPDX-FileCopyrightText: 2026 Fantay contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/app/document/io/imported-document.ts
//   and https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/app/document/io/source.ts (buildFigFile)
// Modified by Fantay: bytes instead of files, foreign-file detection, blank documents, one
// long-lived store (graph replaced in place).
import { strFromU8, unzipSync } from 'fflate';
import { DesignBridgeFailure } from '@open-design/contracts/runtime/design-editor-bridge';

import { createDefaultEditorState, createEditor, exportFigFile, fontManager, parseFigFile, SceneGraph } from '../engine/op';
import type { FxEditorStore } from '../store/types';

/** `.fig` files the Fantay editor (OpenPencil engine) wrote carry this app name in meta.json. */
export const OWN_FIG_APP = 'OpenPencil';

/** The `meta.json` of a zipped `.fig`, or null for raw `fig-kiwi` files and unreadable archives. */
export function readFigMeta(bytes: Uint8Array): Record<string, unknown> | null {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  try {
    const files = unzipSync(bytes, { filter: (file) => file.name === 'meta.json' });
    const meta = files['meta.json'];
    if (!meta) return null;
    const parsed: unknown = JSON.parse(strFromU8(meta));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A `.fig` written by another app (Figma, …): saving rewrites it in this editor's format. */
export function isForeignFig(bytes: Uint8Array): boolean {
  return readFigMeta(bytes)?.app !== OWN_FIG_APP;
}

export async function parseFigDocument(bytes: ArrayBuffer, signal?: AbortSignal): Promise<SceneGraph> {
  try {
    return await parseFigFile(bytes, { populate: 'first-page', signal });
  } catch (error) {
    if (signal?.aborted) throw new DesignBridgeFailure('CANCELLED', 'Opening was cancelled');
    throw new DesignBridgeFailure('PARSE_FAILED', error instanceof Error ? error.message : String(error));
  }
}

/** A new document: one page named `pageName`, with the page background of the interface theme. */
export function createBlankGraph(pageName: string, theme: 'dark' | 'light'): SceneGraph {
  const graph = new SceneGraph();
  const page = graph.getPages()[0];
  if (page && pageName.trim()) graph.updateNode(page.id, { name: pageName.trim() });
  // A staging editor applies the theme's default page background, as a fresh editor would.
  const staging = createEditor({ graph, state: { ...createDefaultEditorState(page?.id ?? graph.rootId), theme } });
  staging.dispose();
  return graph;
}

/**
 * Makes `graph` the open document: its first page is laid out by a staging editor, then the
 * store takes the graph with a clean history and no selection.
 */
export async function adoptGraph(store: FxEditorStore, graph: SceneGraph, signal?: AbortSignal): Promise<void> {
  const firstPage = graph.getPages()[0];
  const pageId = firstPage?.id ?? graph.rootId;
  const staging = createEditor({
    graph,
    loadFont: (family, style, characters, abort) => fontManager.loadFont(family, style, characters, abort),
    skipInitialGraphSetup: true,
  });
  try {
    const prepared = await staging.preparePage(pageId, { signal });
    signal?.throwIfAborted();
    if (!prepared) throw new DesignBridgeFailure('CANCELLED', 'Opening was superseded');
  } finally {
    staging.dispose();
  }
  store.replaceGraph(graph);
  store.undo.clear();
  store.clearSelection();
}

/** The open document as `.fig` bytes; the embedded thumbnail shows the first page. */
export function serializeDocument(store: FxEditorStore): Promise<Uint8Array> {
  const renderer = store.renderer;
  const firstPageId = store.graph.getPages()[0]?.id ?? store.state.currentPageId;
  return exportFigFile(store.graph, renderer?.ck, renderer ?? undefined, firstPageId);
}
