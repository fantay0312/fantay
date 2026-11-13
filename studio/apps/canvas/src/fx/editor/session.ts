// SPDX-License-Identifier: Apache-2.0
/**
 * Editor session (06 §3.6, §5.3): owns the open document's identity, base sha and read-only
 * flag; answers the host's bridge requests; emits `state`, `selection` (debounced 120 ms, at most
 * 20 node summaries) and `view` (throttled 100 ms). The host does all daemon I/O; the editor only
 * exchanges bytes over the port.
 */
import { nextTick, watch } from 'vue';
import {
  DESIGN_BRIDGE_LIMITS,
  DesignBridgeFailure,
  toDesignBridgeError,
  type DesignEditorStatePayload,
  type DesignIdentity,
  type DesignInsertItem,
  type DesignOpenPayload,
  type DesignOpenResult,
  type DesignOpenWarning,
  type DesignSaveResult,
  type DesignSelection,
  type DesignViewCommand,
  type DesignViewState,
} from '@open-design/contracts/runtime/design-editor-bridge';

import type { EditorBridge } from '../../host/bridge';
import { setEditorLocale, t } from '../../host/i18n';
import { applyTheme } from '../../host/theme';
import { createEditor, SceneGraph } from '../engine/op';
import { importDesignFile, baseNameOf } from '../interop/registry';
import { htmlToSceneGraph } from '../interop/html';
import { opSvgToSceneGraph, svgToPng } from '../interop/op';
import type { FxEditorStore } from '../store/types';
import { createAutosave, type AutosaveController } from './autosave';
import { adoptGraph, createBlankGraph, isForeignFig, parseFigDocument, serializeDocument } from './document';
import { trackDocumentRevisions } from './document-revision';
import { downloadBytes } from './download';
import { createFxExport } from './export';
import { toastError } from './toasts';
import { canAutoFocusCanvas, editorUi, opViewer, setPanelsVisible, whenCanvasReady } from './ui-state';

export const SELECTION_DEBOUNCE_MS = 120;
export const VIEW_THROTTLE_MS = 100;

export interface EditorSessionOptions {
  store: FxEditorStore;
  bridge: EditorBridge;
  engineReady: Promise<void>;
}

export interface EditorSession {
  readonly autosave: AutosaveController;
  forwardShortcuts(): readonly string[];
  closeOnEscape(): boolean;
  requestClose(): void;
  forwardShortcut(combo: string): void;
  saveNow(): Promise<void>;
  toggleUi(): void;
  /** Whether the open `.op` document may be converted (a writable project document). */
  canConvertOp(): boolean;
  /** `.op` → editable `.fig` via the viewer's SVG (lossy); saved next to the original, which is kept. */
  convertOp(svg: string): Promise<void>;
  dispose(): void;
}

/** Candidate paths for a converted `.op`: `<dir>/<name>.fig`, then `-2`, `-3`, … */
export function convertedFigPath(opPath: string, attempt: number): string {
  const slash = opPath.lastIndexOf('/');
  const dir = slash >= 0 ? opPath.slice(0, slash + 1) : '';
  const file = opPath.slice(slash + 1).replace(/\.op$/i, '') || 'design';
  return `${dir}${file}${attempt > 1 ? `-${attempt}` : ''}.fig`;
}

export async function probeProjectFileExists(
  fetchAsset: (path: string) => Promise<unknown>,
  path: string,
): Promise<boolean> {
  try {
    await fetchAsset(path);
    return true;
  } catch (thrown) {
    const error = toDesignBridgeError(thrown);
    if (error.code === 'NOT_FOUND') return false;
    if (error.code === 'TOO_LARGE') return true;
    throw new DesignBridgeFailure(error.code, error.message, error.details);
  }
}

const CONVERT_MAX_ATTEMPTS = 50;

let current: EditorSession | null = null;

export function getEditorSession(): EditorSession | null {
  return current;
}

function selectionSummary(store: FxEditorStore): DesignSelection {
  const nodeIds = [...store.state.selectedIds];
  const nodes = nodeIds.slice(0, DESIGN_BRIDGE_LIMITS.maxSelectionNodes).flatMap((id) => {
    const node = store.graph.getNode(id);
    return node ? [{ id: node.id, name: node.name, type: node.type, width: node.width, height: node.height }] : [];
  });
  return { pageId: store.state.currentPageId, nodeIds, nodes };
}

function viewSummary(store: FxEditorStore): DesignViewState {
  return {
    zoom: store.state.zoom,
    pageId: store.state.currentPageId,
    pages: store.graph.getPages().map((page) => ({ id: page.id, name: page.name })),
  };
}

/** The engine names a new document's page "Page 1"; converted files take the editor language's name. */
export function localizeDefaultPageName(graph: SceneGraph, name: string): void {
  const pages = graph.getPages();
  const page = pages[0];
  if (pages.length === 1 && page && page.name === 'Page 1' && name && name !== page.name) graph.updateNode(page.id, { name });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}

export function startEditorSession(options: EditorSessionOptions): EditorSession {
  const { store, bridge } = options;
  let initialized = false;
  let identity: DesignIdentity | null = null;
  let documentReadOnly = false;
  let forward: readonly string[] = [];
  let escapeCloses = false;
  let openController: AbortController | null = null;
  let disposed = false;
  const cleanups: Array<() => void> = [];
  const exporter = createFxExport(store, store.state, downloadBytes);

  function setReadOnly(readOnly: boolean) {
    documentReadOnly = readOnly;
    editorUi.readOnly = readOnly || editorUi.format === 'op';
    store.readOnly.value = editorUi.readOnly;
    if (editorUi.readOnly && store.state.activeTool !== 'HAND') store.setTool('HAND');
    if (!editorUi.readOnly && store.state.activeTool === 'HAND') store.setTool('SELECT');
  }

  const autosave = createAutosave({
    serialize: async () => {
      if (editorUi.format === 'op') {
        if (!editorUi.opBytes) throw new DesignBridgeFailure('EMPTY_DOCUMENT', 'No document is open');
        // A copy: the save request transfers (detaches) its buffer.
        return editorUi.opBytes.slice();
      }
      await whenCanvasReady();
      return serializeDocument(store);
    },
    save: async (request) => {
      if (request.bytes.byteLength > DESIGN_BRIDGE_LIMITS.maxDocumentBytes) {
        throw new DesignBridgeFailure('TOO_LARGE', 'The design is over 64 MB');
      }
      return bridge.request('document.save', request, { transfer: [request.bytes] });
    },
    isReadOnly: () => documentReadOnly || identity?.kind === 'legacy',
    now: () => Date.now(),
    format: () => editorUi.format ?? 'fig',
    onForbidden: () => setReadOnly(true),
  });

  // ── outgoing events ────────────────────────────────────────────────────────────────────
  let lastState = '';
  function emitState() {
    const saved = autosave.state.value;
    const payload: DesignEditorStatePayload = {
      dirty: saved.dirty,
      saving: saved.saving,
      readOnly: editorUi.readOnly,
      sha256: saved.sha256,
      lastSavedAt: saved.lastSavedAt,
      format: editorUi.format,
      error: saved.error,
    };
    const key = JSON.stringify(payload);
    if (key === lastState) return;
    lastState = key;
    bridge.emit('state', payload);
  }
  cleanups.push(watch(() => [autosave.state.value, editorUi.readOnly, editorUi.format], emitState, { flush: 'sync' }));

  let selectionTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSelection = '';
  function scheduleSelection() {
    if (selectionTimer !== null) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      selectionTimer = null;
      if (editorUi.format !== 'fig') return;
      const summary = selectionSummary(store);
      const key = JSON.stringify(summary);
      if (key === lastSelection) return;
      lastSelection = key;
      bridge.emit('selection', summary);
    }, SELECTION_DEBOUNCE_MS);
  }
  cleanups.push(store.onEditorEvent('selection:changed', scheduleSelection));
  cleanups.push(store.onEditorEvent('page:changed', scheduleSelection));
  // Renames and resizes of selected layers refresh the summaries (names, sizes) the host shows.
  cleanups.push(
    watch(
      () => store.state.sceneVersion,
      () => {
        if (store.state.selectedIds.size > 0) scheduleSelection();
      },
    ),
  );

  let viewTimer: ReturnType<typeof setTimeout> | null = null;
  let lastViewAt = 0;
  function emitView() {
    viewTimer = null;
    lastViewAt = Date.now();
    if (editorUi.format === 'fig') bridge.emit('view', viewSummary(store));
  }
  function scheduleView() {
    if (viewTimer !== null) return;
    const wait = Math.max(0, lastViewAt + VIEW_THROTTLE_MS - Date.now());
    viewTimer = setTimeout(emitView, wait);
  }
  cleanups.push(watch(() => [store.state.zoom, store.state.currentPageId, store.state.sceneVersion], scheduleView));
  // Autosave follows document edits, not every render (page switches, layout, page loads).
  const revisions = trackDocumentRevisions(store);
  cleanups.push(() => revisions.dispose());
  cleanups.push(watch(revisions.revision, (revision) => autosave.onSceneChange(revision)));

  // ── document lifecycle ─────────────────────────────────────────────────────────────────
  function requireInitialized() {
    if (!initialized) throw new DesignBridgeFailure('NOT_INITIALIZED', 'The editor has not been initialized');
  }

  function requireEditable() {
    requireInitialized();
    if (editorUi.readOnly) throw new DesignBridgeFailure('READ_ONLY', 'This design is read-only');
  }

  async function fitView() {
    await nextTick();
    await whenCanvasReady();
    store.zoomToFit();
  }

  async function open(payload: DesignOpenPayload): Promise<DesignOpenResult> {
    requireInitialized();
    openController?.abort();
    const controller = new AbortController();
    openController = controller;
    const { signal } = controller;
    // Safety net: the host flushes before switching; an unsaved change of the old document is saved first.
    const switchingToReadOnly = payload.source === 'bytes' && payload.readOnly;
    if (autosave.state.value.dirty && !autosave.halted && !documentReadOnly && !switchingToReadOnly && identity?.kind === 'project') {
      await autosave.flush('flush');
    }
    autosave.suspend();
    editorUi.phase = 'opening';
    const warnings: DesignOpenWarning[] = [];
    let format: 'fig' | 'op' = 'fig';
    let foreign = false;
    let needsSave = false;
    let sha256: string | null = null;
    let readOnly = false;
    try {
      let graph: SceneGraph | null = null;
      let opBytes: Uint8Array | null = null;
      if (payload.source === 'bytes') {
        sha256 = payload.sha256;
        readOnly = payload.readOnly || payload.identity.kind === 'legacy';
        if (payload.format === 'op') {
          format = 'op';
          opBytes = new Uint8Array(payload.bytes);
        } else {
          foreign = isForeignFig(new Uint8Array(payload.bytes));
          if (foreign) warnings.push('foreign-fig');
          graph = await parseFigDocument(payload.bytes, signal);
        }
      } else if (payload.source === 'blank') {
        needsSave = true;
        graph = createBlankGraph(payload.pageName || t('designEditor.page.defaultName'), store.state.theme === 'light' ? 'light' : 'dark');
      } else if (payload.source === 'html') {
        needsSave = true;
        const converted = await htmlToSceneGraph(payload.html, {
          sourcePath: payload.sourcePath,
          fetchAsset: fetchProjectAsset,
          pageName: payload.name,
          signal,
        });
        graph = converted.graph;
        warnings.push(...converted.warnings);
      } else {
        needsSave = true;
        const imported = await importDesignFile(
          { fileName: payload.fileName, bytes: payload.bytes, sourcePath: null },
          { fetchAsset: fetchProjectAsset, t, signal },
        );
        if (imported.kind === 'op') {
          format = 'op';
          opBytes = imported.bytes;
        } else {
          graph = imported.graph;
          foreign = !!imported.foreign;
          warnings.push(...imported.warnings);
          localizeDefaultPageName(graph, t('designEditor.page.defaultName'));
        }
      }
      signal.throwIfAborted();
      if (graph) {
        await adoptGraph(store, graph, signal);
      } else {
        // An `.op` document: drop the previous graph so nothing of it can be saved or exported.
        await adoptGraph(store, new SceneGraph(), signal);
      }
      if (signal.aborted) throw new DesignBridgeFailure('CANCELLED', 'Opening was superseded');
      identity = payload.identity;
      editorUi.format = format;
      editorUi.opBytes = opBytes;
      editorUi.legacy = payload.identity.kind === 'legacy';
      editorUi.documentName = payload.name;
      setReadOnly(readOnly);
      if (!editorUi.readOnly) store.setTool('SELECT');
      autosave.markLoaded(sha256, revisions.revision.value);
      editorUi.phase = 'ready';
      editorUi.failure = '';
      lastState = '';
      emitState();
      if (format === 'fig') void fitView().then(scheduleView);
      if (needsSave) setTimeout(() => void convertSave(), 0);
      return {
        format,
        readOnly: editorUi.readOnly,
        pageCount: format === 'op' ? 1 : store.graph.getPages().length,
        currentPageId: format === 'op' ? null : store.state.currentPageId,
        foreign,
        needsSave,
        warnings,
      };
    } catch (thrown) {
      if (openController === controller) {
        const error = toDesignBridgeError(thrown, 'PARSE_FAILED');
        editorUi.phase = 'failed';
        editorUi.failure = t('designEditor.loadFailed', { reason: error.message });
        throw new DesignBridgeFailure(error.code, error.message, error.details);
      }
      throw new DesignBridgeFailure('CANCELLED', 'Opening was superseded');
    } finally {
      if (openController === controller) openController = null;
    }
  }

  async function convertSave() {
    const result = await autosave.flush('convert', { baseSha256: null });
    if (!result.saved && result.error) bridge.emit('error', result.error);
  }

  async function projectFileExists(path: string): Promise<boolean> {
    return probeProjectFileExists((candidate) => bridge.request('asset.fetch', { path: candidate }), path);
  }

  async function fetchProjectAsset(path: string): Promise<{ bytes: ArrayBuffer; mime: string }> {
    const asset = await bridge.request('asset.fetch', { path });
    if (asset.bytes.byteLength > DESIGN_BRIDGE_LIMITS.maxAssetBytes) throw new DesignBridgeFailure('TOO_LARGE', 'The asset is over 20 MB');
    return asset;
  }

  async function copyTo(targetPath: string): Promise<DesignSaveResult> {
    requireInitialized();
    const result = await autosave.save('copy', { targetPath, baseSha256: null });
    if (identity?.kind === 'project') identity = { ...identity, path: result.path };
    return result;
  }

  async function exportCover(maxEdge?: number, pageId?: string) {
    requireInitialized();
    if (editorUi.format === 'op') {
      const svg = opViewer()?.exportSvg();
      const cover = svg ? await svgToPng(svg, maxEdge ?? 1600) : null;
      if (!cover) throw new DesignBridgeFailure('EXPORT_FAILED', 'The .op preview could not be rendered');
      return { png: toArrayBuffer(cover.png), width: cover.width, height: cover.height, pageId: '', sourceSha256: autosave.state.value.sha256 };
    }
    await whenCanvasReady();
    const cover = await exporter.exportCover({ maxEdge, pageId });
    return { png: toArrayBuffer(cover.png), width: cover.width, height: cover.height, pageId: cover.pageId, sourceSha256: autosave.state.value.sha256 };
  }

  async function exportHtml(scope: 'page' | 'selection'): Promise<string> {
    requireInitialized();
    if (editorUi.format === 'op') {
      const svg = opViewer()?.exportSvg();
      if (!svg) throw new DesignBridgeFailure('EXPORT_FAILED', 'The .op preview could not be exported');
      return `<!doctype html><meta charset="utf-8"><body style="margin:0">${svg}</body>`;
    }
    return exporter.exportHtml(scope);
  }

  function runViewCommand(command: DesignViewCommand) {
    requireInitialized();
    if (command === 'toggleUi') {
      setPanelsVisible(!editorUi.panelsVisible);
      return;
    }
    if (editorUi.format === 'op') {
      const viewer = opViewer();
      if (command === 'zoomIn') viewer?.zoomIn();
      else if (command === 'zoomOut') viewer?.zoomOut();
      else if (command === 'zoomFit' || command === 'zoomSelection') viewer?.zoomFit();
      else if (command === 'zoom100') viewer?.zoom100();
      return;
    }
    const center = store.viewportScreenCenter();
    switch (command) {
      case 'zoomIn':
        store.applyZoom(-100, center.x, center.y);
        break;
      case 'zoomOut':
        store.applyZoom(100, center.x, center.y);
        break;
      case 'zoomFit':
        store.zoomToFit();
        break;
      case 'zoom100':
        store.zoomToLevel(1);
        break;
      case 'zoomSelection':
        if (store.state.selectedIds.size > 0) store.zoomToSelection();
        else store.zoomToFit();
        break;
      case 'undo':
        if (!editorUi.readOnly) store.undoAction();
        break;
      case 'redo':
        if (!editorUi.readOnly) store.redoAction();
        break;
    }
  }

  function setSelection(nodeIds: string[], reveal: boolean): string[] {
    requireInitialized();
    if (editorUi.format !== 'fig') return [];
    const existing = nodeIds.filter((id) => {
      const node = store.graph.getNode(id);
      return !!node && node.type !== 'CANVAS';
    });
    if (existing.length === 0) store.clearSelection();
    else store.select(existing);
    if (reveal && existing.length > 0) store.revealNodes(existing);
    return [...store.state.selectedIds];
  }

  async function insertItems(items: DesignInsertItem[]): Promise<string[]> {
    requireEditable();
    const created = new Set<string>();
    const { x, y } = store.viewportCanvasCenter();
    for (const item of items) {
      if (item.kind === 'image') {
        await store.placeFiles([new File([item.bytes], item.name, { type: item.mime })], x, y);
      } else if (item.kind === 'svg') {
        if (!(await store.pasteSVG(item.svg, x, y))) throw new DesignBridgeFailure('PARSE_FAILED', 'The SVG has no drawable layers');
      } else {
        const { graph } = await htmlToSceneGraph(item.html, {
          sourcePath: item.sourcePath ?? null,
          fetchAsset: fetchProjectAsset,
          pageName: baseNameOf(item.name),
        });
        // Copy the converted layers through the clipboard model, as a paste would.
        const staging = createEditor({ graph, skipInitialGraphSetup: true });
        try {
          const page = graph.getPages()[0];
          const ids = page ? graph.getChildren(page.id).map((node) => node.id) : [];
          if (ids.length === 0) continue;
          staging.select(ids);
          const payload = await staging.prepareCopy();
          if (payload.snapshot) await store.pasteSnapshot(payload.snapshot, { x, y });
          else await store.pasteFromHTML(payload.html, { x, y });
        } finally {
          staging.dispose();
        }
      }
      for (const id of store.state.selectedIds) created.add(id);
    }
    return [...created];
  }

  // ── bridge handlers ────────────────────────────────────────────────────────────────────
  bridge.handle('init', async (payload) => {
    try {
      await options.engineReady;
    } catch (error) {
      editorUi.phase = 'failed';
      throw new DesignBridgeFailure('ENGINE_LOAD_FAILED', error instanceof Error ? error.message : String(error));
    }
    setEditorLocale(payload.locale, payload.messages);
    applyTheme(payload.theme, store);
    forward = payload.forwardShortcuts;
    escapeCloses = payload.closeOnEscape;
    initialized = true;
    if (editorUi.phase === 'booting') editorUi.phase = 'waiting';
    return { payload: { ready: true } };
  });
  bridge.handle('document.open', async (payload) => ({ payload: await open(payload) }));
  bridge.handle('document.flush', async () => {
    if (!initialized || !identity) return { payload: { saved: true, dirty: false, sha256: null } };
    return { payload: await autosave.flush('flush') };
  });
  bridge.handle('document.saveCopy', async ({ targetPath }) => ({ payload: await copyTo(targetPath) }));
  bridge.handle('document.forceSave', async ({ baseSha256 }) => {
    requireInitialized();
    return { payload: await autosave.save('force', { baseSha256 }) };
  });
  bridge.handle('document.exportCover', async ({ maxEdge, pageId }) => {
    const cover = await exportCover(maxEdge, pageId);
    return { payload: cover, transfer: [cover.png] };
  });
  bridge.handle('document.exportHtml', async ({ scope }) => ({ payload: { html: await exportHtml(scope) } }));
  bridge.handle('view.command', async ({ command }) => {
    runViewCommand(command);
    return { payload: {} };
  });
  bridge.handle('selection.set', async ({ nodeIds, reveal }) => ({ payload: { selected: setSelection(nodeIds, !!reveal) } }));
  bridge.handle('insert', async ({ items }) => ({ payload: { nodeIds: await insertItems(items) } }));
  bridge.handle('focus', async () => {
    if (canAutoFocusCanvas()) {
      document.querySelector<HTMLCanvasElement>('[data-test-id="canvas-element"]')?.focus({ preventScroll: true });
    }
    return { payload: {} };
  });

  cleanups.push(bridge.on('theme', ({ theme }) => applyTheme(theme, store)));
  cleanups.push(bridge.on('locale', ({ locale, messages }) => setEditorLocale(locale, messages)));
  cleanups.push(
    bridge.on('visibility', ({ visible }) => {
      editorUi.visible = visible;
      if (!visible) void autosave.flush('flush');
    }),
  );

  const onHidden = () => {
    if (document.visibilityState === 'hidden') void autosave.flush('flush');
  };
  const onPageHide = () => void autosave.flush('flush');
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onPageHide);
  cleanups.push(() => document.removeEventListener('visibilitychange', onHidden));
  cleanups.push(() => window.removeEventListener('pagehide', onPageHide));

  const session: EditorSession = {
    autosave,
    forwardShortcuts: () => forward,
    closeOnEscape: () => escapeCloses,
    requestClose() {
      bridge.emit('request-close', {});
    },
    forwardShortcut(combo) {
      bridge.emit('shortcut', { combo });
    },
    async saveNow() {
      if (!identity) return;
      const result = await autosave.flush('manual');
      if (!result.saved && result.error && result.error.code !== 'CONFLICT') {
        toastError(t('designEditor.status.saveFailed', { reason: result.error.message }));
      }
    },
    toggleUi() {
      setPanelsVisible(!editorUi.panelsVisible);
    },
    canConvertOp() {
      return editorUi.format === 'op' && identity?.kind === 'project' && !documentReadOnly;
    },
    async convertOp(svg) {
      if (!session.canConvertOp() || identity?.kind !== 'project') return;
      const source = identity;
      try {
        const graph = opSvgToSceneGraph(svg, baseNameOf(source.path));
        localizeDefaultPageName(graph, t('designEditor.page.defaultName'));
        await adoptGraph(store, graph);
        editorUi.format = 'fig';
        editorUi.opBytes = null;
        setReadOnly(false);
        store.setTool('SELECT');
        autosave.markLoaded(null, revisions.revision.value);
        void fitView().then(scheduleView);
        // The first free `<name>.fig`, `<name>-2.fig`, …: probed with asset reads, which (unlike a
        // create that fails) raise no conflict in the host.
        let targetPath: string | null = null;
        for (let attempt = 1; attempt <= CONVERT_MAX_ATTEMPTS && !targetPath; attempt += 1) {
          const candidate = convertedFigPath(source.path, attempt);
          if (!(await projectFileExists(candidate))) targetPath = candidate;
        }
        if (!targetPath) throw new DesignBridgeFailure('CONFLICT', 'No free file name for the converted design');
        const result = await autosave.save('convert', { targetPath, baseSha256: null });
        identity = { ...source, path: result.path };
      } catch (thrown) {
        const error = toDesignBridgeError(thrown);
        bridge.emit('error', error);
        toastError(t('designEditor.status.saveFailed', { reason: error.message }));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (selectionTimer !== null) clearTimeout(selectionTimer);
      if (viewTimer !== null) clearTimeout(viewTimer);
      for (const cleanup of cleanups.splice(0)) cleanup();
      autosave.dispose();
      if (current === session) current = null;
    },
  };
  current = session;
  return session;
}
