// SPDX-License-Identifier: Apache-2.0
/**
 * One editor store for the iframe's lifetime (06 §3.5). Document switches call
 * `store.replaceGraph()`; the store itself, its renderers and CanvasKit stay.
 */
import { markRaw, ref, shallowReactive, shallowRef } from 'vue';

import { readSnappingPreferences } from '../compat/preferences-apply';
import { createFxExport } from '../editor/export';
import { createDefaultEditorState, createEditor, createShaderRasterizer, fontManager, SceneGraph } from '../engine/op';
import type {
  FxDesignCheck,
  FxDesignCheckSnapshot,
  FxEditorExtensions,
  FxEditorState,
  FxEditorStore,
  FxEditorStoreDeps,
} from './types';

/** Store members the vendored UI and the shims rely on beyond the SDK editor (tests/store-shim.test.ts). */
export const FX_STORE_EXTENSION_MEMBERS = [
  'viewportScreenCenter',
  'viewportCanvasCenter',
  'setViewportSize',
  'renderExportImage',
  'exportTargets',
  'nodeEditAlignVertices',
  'designCheck',
  'readOnly',
] as const satisfies ReadonlyArray<keyof FxEditorExtensions>;

export const FX_STATE_EXTENSION_FIELDS = ['showRulers', 'numberFieldFocused', 'renameNodeId', 'showRemoteCursors'] as const;

export function createFxEditorState(pageId: string): FxEditorState {
  return {
    ...createDefaultEditorState(pageId),
    snappingPreferences: readSnappingPreferences(),
    theme: 'dark',
    showRulers: false,
    numberFieldFocused: false,
    renameNodeId: null,
    showRemoteCursors: false,
  };
}

function withMissingMemberWarnings(store: FxEditorStore): FxEditorStore {
  const warned = new Set<string>();
  return new Proxy(store, {
    get(target, property, receiver) {
      if (
        typeof property === 'string' &&
        !(property in target) &&
        !property.startsWith('__v_') &&
        property !== 'then' &&
        property !== 'toJSON' &&
        !warned.has(property)
      ) {
        warned.add(property);
        console.warn(`[fantay-design] missing store member ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

export function createFxEditorStore(deps: FxEditorStoreDeps): FxEditorStore {
  const graph = new SceneGraph();
  const state = shallowReactive<FxEditorState>(createFxEditorState(graph.getPages()[0]!.id));
  const viewportSize = { width: 0, height: 0 };

  function getViewportSize() {
    if (viewportSize.width > 0 && viewportSize.height > 0) return { ...viewportSize };
    const element = deps.getViewportElement();
    return {
      width: element?.clientWidth || (typeof window === 'undefined' ? 1280 : window.innerWidth),
      height: element?.clientHeight || (typeof window === 'undefined' ? 800 : window.innerHeight),
    };
  }

  const editor = createEditor({
    graph,
    state,
    getViewportSize,
    loadFont: (family, style, characters, signal) => fontManager.loadFont(family, style, characters, signal),
    shaderRasterizer: createShaderRasterizer(),
  });
  const exporter = createFxExport(editor, state, deps.downloadFile);
  const designCheck: FxDesignCheck = {
    snapshot: shallowRef<FxDesignCheckSnapshot | null>(null),
    highlightMarker() {},
    openMarker() {},
    pages: { counts: shallowRef(new Map<string, never>()) },
  };

  function viewportScreenCenter() {
    const { width, height } = getViewportSize();
    return { x: width / 2, y: height / 2 };
  }

  // `getImage` is the SDK's own (FxEditorExtensions only narrows its type).
  const extensions: Omit<FxEditorExtensions, 'state' | 'getImage'> = {
    viewportScreenCenter,
    viewportCanvasCenter() {
      const center = viewportScreenCenter();
      return editor.screenToCanvas(center.x, center.y);
    },
    setViewportSize(width, height) {
      viewportSize.width = width;
      viewportSize.height = height;
    },
    renderExportImage: (ids, scale, format) => exporter.renderExportImage(ids, scale, format),
    exportTargets: (requests) => exporter.exportTargets(requests),
    nodeEditAlignVertices() {},
    designCheck,
    readOnly: ref(false),
  };
  // Never wrapped by Vue reactivity: the editor manages its own (shallow-reactive) state.
  const store = markRaw(Object.assign(editor, extensions) as FxEditorStore);
  return import.meta.env.DEV ? withMissingMemberWarnings(store) : store;
}
