// SPDX-License-Identifier: AGPL-3.0-only
// Engine runtime: wires the camera to the store without React (spec 03 §3.2–§3.5, plan R1/R7). Camera changes
// re-cull once per animation frame and update the store only when the visible set changes (invariant I2); settle
// stores the settled zoom, recomputes the live set (≤ 4, frozen during gestures, I3), publishes the header zoom
// snapshot while active and saves the 04 viewport. The first camera comes from 04 `initialViewport`, else a fit.
import {
  cameraFromViewport,
  EMPTY_BOARD_CAMERA,
  fitRect,
  LABEL_ALLOWANCE,
  MAX_ZOOM,
  MIN_ZOOM,
  rectToScreen,
  viewportFromCamera,
  type Camera,
} from '../camera/camera';
import type { CameraController } from '../camera/camera-controller';
import { computeVisibleIds, cullBounds, edgeInView, isLod } from '../engine/culling';
import { INACTIVE_DEMOTE_MS, nextHoverDwellAt, selectLiveIds, type LiveCandidate, type LiveKind } from '../engine/live-budget';
import { nodesInOrder } from '../model/contract-adapter';
import { unionRect } from '../model/geometry';
import { isLiveCapableKind } from '../model/node-registry';
import type { EngineDoc, EngineNode, Rect } from '../model/types';
import type { FantayBoardViewportSnapshot } from '../../workspace/board-viewport-store';
import type { EngineState, EngineStore } from './board-store';

export interface EngineRuntimeDeps {
  store: EngineStore;
  camera: CameraController;
  publishViewport(snapshot: FantayBoardViewportSnapshot | null): void;
  noteCameraInteraction(): void;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface EngineRuntime {
  start(): void;
  stop(): void;
  /** the first camera (initial viewport or fit) has been applied */
  cameraReady(): boolean;
  onCameraReady(listener: () => void): () => void;
  /** synchronous culling pass */
  recomputeVisible(): void;
  /** synchronous live-budget pass (no-op mid-gesture) */
  recomputeLive(): void;
}

function defaultRequestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => callback());
  return setTimeout(callback, 16) as unknown as number;
}

function defaultCancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

/** A live-capable node has something to show live (R6). */
export function hasLiveSource(node: EngineNode): boolean {
  switch (node.kind) {
    case 'frame':
      return node.data.ref !== null || typeof node.data.liveArtifactId === 'string';
    case 'web':
      return typeof node.data.url === 'string' && node.data.url.length > 0;
    case 'video':
      return node.data.ref !== null;
    case 'motion':
      return true;
    default:
      return false;
  }
}

/** Live candidates among the visible nodes (03 §3.5 inputs). */
export function liveCandidates(state: EngineState, cam: Camera): LiveCandidate[] {
  const { doc, ui, runtime, preview } = state;
  const candidates: LiveCandidate[] = [];
  for (const id of state.visibleIds) {
    const node = doc.nodes.get(id);
    if (!node || node.hidden || !isLiveCapableKind(node.kind)) continue;
    const rt = runtime.get(id);
    const rect = preview?.rects.get(id) ?? node;
    const pinned = ui.mode?.nodeId === id || state.pinnedLiveIds.has(id) || rt?.playing === true;
    candidates.push({
      id,
      kind: node.kind as LiveKind,
      screenRect: rectToScreen(cam, rect),
      pinned,
      selected: ui.selection.includes(id),
      hoveredSince: ui.hoverId === id ? ui.hoverSince : null,
      building: rt?.phase === 'building',
      currentlyLive: state.liveIds.has(id),
      eligible: hasLiveSource(node) && rt?.phase !== 'missing' && !isLod(node, cam.zoom),
    });
  }
  return candidates;
}

/** Fit rect of every visible top-level node, with room for the labels above them. */
function contentRect(doc: EngineDoc, zoom: number): Rect | null {
  const rects: Rect[] = [];
  for (const node of nodesInOrder(doc)) {
    if (node.hidden || node.parentId !== null) continue;
    const allowance = LABEL_ALLOWANCE / Math.max(0.05, zoom);
    rects.push({ x: node.x, y: node.y - allowance, w: node.w, h: node.h + allowance });
  }
  return unionRect(rects);
}

function sameIdSet(a: ReadonlySet<string>, ids: readonly string[]): boolean {
  if (a.size !== ids.length) return false;
  for (const id of ids) if (!a.has(id)) return false;
  return true;
}

export function createEngineRuntime(deps: EngineRuntimeDeps): EngineRuntime {
  const { store, camera } = deps;
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const requestFrame = deps.requestFrame ?? defaultRequestFrame;
  const cancelFrame = deps.cancelFrame ?? defaultCancelFrame;
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let cullFrame: number | null = null;
  let liveFrame: number | null = null;
  let dwellTimer: unknown = null;
  let demoteTimer: unknown = null;
  let ready = false;
  let pendingEmptyFit = false;
  let running = false;
  let last: EngineState = store.getState();
  let orderCache: { doc: EngineDoc; nodes: EngineNode[] } | null = null;
  const readyListeners = new Set<() => void>();
  const unsubscribers: Array<() => void> = [];

  function orderedNodes(doc: EngineDoc): EngineNode[] {
    if (orderCache?.doc !== doc) orderCache = { doc, nodes: nodesInOrder(doc) };
    return orderCache.nodes;
  }

  function recomputeVisible(): void {
    cullFrame = null;
    const state = store.getState();
    const stage = camera.stageSize();
    const cam = camera.get();
    const always = new Set<string>(state.ui.selection);
    if (state.ui.mode) always.add(state.ui.mode.nodeId);
    if (state.ui.editingTextId) always.add(state.ui.editingTextId);
    if (state.ui.renamingId) always.add(state.ui.renamingId);
    for (const id of state.liveIds) always.add(id);
    const previewRects = state.preview?.rects;
    if (previewRects) for (const id of previewRects.keys()) always.add(id);
    const ids = computeVisibleIds({ nodesInOrder: orderedNodes(state.doc), cam, stage, alwaysInclude: always, ...(previewRects ? { previewRects } : {}) });
    const bounds = cullBounds(cam, stage);
    const edgeIds: string[] = [];
    for (const edge of state.doc.edges.values()) {
      const from = state.doc.nodes.get(edge.from);
      const to = state.doc.nodes.get(edge.to);
      if (!from || !to || from.hidden || to.hidden) continue;
      if (edgeInView(previewRects?.get(from.id) ?? from, previewRects?.get(to.id) ?? to, bounds)) edgeIds.push(edge.id);
    }
    store.setVisible(ids, edgeIds);
  }

  function scheduleCull(): void {
    if (!running || cullFrame !== null) return;
    cullFrame = requestFrame(recomputeVisible);
  }

  function recomputeLive(): void {
    liveFrame = null;
    if (dwellTimer !== null) {
      clearTimer(dwellTimer);
      dwellTimer = null;
    }
    const state = store.getState();
    /* the live set is frozen during gestures */
    if (state.ui.interaction !== 'idle') return;
    if (!state.active) return; // the demote timer empties the set after INACTIVE_DEMOTE_MS
    const cam = camera.get();
    const candidates = liveCandidates(state, cam);
    const at = now();
    const ids = selectLiveIds({ candidates, stage: camera.stageSize(), now: at, boardActive: true });
    if (!sameIdSet(state.liveIds, ids)) store.setLive(new Set(ids));
    const dwell = nextHoverDwellAt(candidates, at);
    if (dwell !== null && running) dwellTimer = setTimer(() => {
      dwellTimer = null;
      recomputeLive();
    }, Math.max(0, dwell - at));
  }

  function scheduleLive(): void {
    if (!running || liveFrame !== null) return;
    liveFrame = requestFrame(recomputeLive);
  }

  function snapshot(): FantayBoardViewportSnapshot {
    return { projectId: store.projectId, zoom: camera.get().zoom, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM };
  }

  function maybeInitCamera(): void {
    if (ready) return;
    const state = store.getState();
    if (state.status !== 'ready') return;
    const stage = camera.stageSize();
    if (stage.w <= 0 || stage.h <= 0) return;
    const initial = store.data.getState().initialViewport;
    let target: Camera;
    if (initial) target = cameraFromViewport(initial, stage);
    else {
      const rect = contentRect(state.doc, 1);
      if (rect) target = fitRect(rect, stage, { maxZoom: 1, labelAllowance: 0 });
      else {
        target = EMPTY_BOARD_CAMERA;
        pendingEmptyFit = true;
      }
    }
    camera.set(target, 'program');
    ready = true;
    recomputeVisible();
    recomputeLive();
    for (const listener of [...readyListeners]) listener();
  }

  /** Every page keeps its own camera: back to where it was left, else a fit of what the page holds. */
  function showPageCamera(doc: EngineDoc): void {
    const stage = camera.stageSize();
    if (stage.w <= 0 || stage.h <= 0) return;
    const saved = doc.pageId ? store.data.pageViewport(doc.pageId) : null;
    const rect = saved ? null : contentRect(doc, 1);
    pendingEmptyFit = !saved && !rect;
    const target = saved
      ? cameraFromViewport(saved, stage)
      : rect ? fitRect(rect, stage, { maxZoom: 1, labelAllowance: 0 }) : EMPTY_BOARD_CAMERA;
    camera.set(target, 'program');
    recomputeVisible();
    recomputeLive();
    if (!store.getState().readOnly) store.data.setViewport(viewportFromCamera(camera.get(), stage));
  }

  function handleActive(active: boolean): void {
    if (active) {
      if (demoteTimer !== null) {
        clearTimer(demoteTimer);
        demoteTimer = null;
      }
      if (ready) deps.publishViewport(snapshot());
      scheduleLive();
      return;
    }
    deps.publishViewport(null);
    if (demoteTimer !== null) clearTimer(demoteTimer);
    demoteTimer = setTimer(() => {
      demoteTimer = null;
      if (!store.getState().active) store.setLive(new Set());
    }, INACTIVE_DEMOTE_MS);
  }

  function onStore(): void {
    const next = store.getState();
    const prev = last;
    last = next;
    if (next === prev) return;
    const pageChanged = ready && next.doc.pageId !== prev.doc.pageId;
    if (next.ui.selection.length > 0) pendingEmptyFit = false;
    // a maximized node losing the selection (click on the board, delete) goes back to the view it left
    const { maximized } = next.ui;
    if (maximized && !next.ui.selection.includes(maximized.nodeId)) {
      store.setUi({ maximized: null });
      if (!pageChanged) camera.flyTo(maximized.returnTo);
    }
    if (pageChanged) showPageCamera(next.doc);
    const docChanged = next.doc !== prev.doc;
    if (docChanged && pendingEmptyFit && next.ui.selection.length === 0) {
      const rect = contentRect(next.doc, 1);
      if (rect) {
        pendingEmptyFit = false;
        const stage = camera.stageSize();
        if (stage.w > 0 && stage.h > 0) {
          camera.set(fitRect(rect, stage, { maxZoom: 1, labelAllowance: 0 }), 'program');
          recomputeVisible();
          recomputeLive();
        }
      }
    }
    if (
      docChanged
      || next.ui.selection !== prev.ui.selection
      || next.ui.mode !== prev.ui.mode
      || next.ui.editingTextId !== prev.ui.editingTextId
      || next.ui.renamingId !== prev.ui.renamingId
      || next.preview !== prev.preview
      || next.liveIds !== prev.liveIds
    ) scheduleCull();
    if (next.status === 'ready' && !ready) maybeInitCamera();
    if (next.active !== prev.active) handleActive(next.active);
    if (
      docChanged
      || next.ui.selection !== prev.ui.selection
      || next.ui.hoverId !== prev.ui.hoverId
      || next.ui.mode !== prev.ui.mode
      || next.pinnedLiveIds !== prev.pinnedLiveIds
      || next.runtime !== prev.runtime
      // not on visible-set changes: those follow the moving camera, and the live set changes only on settle (03 §3.5)
      || next.readOnly !== prev.readOnly
      || (next.ui.interaction === 'idle' && prev.ui.interaction !== 'idle')
    ) scheduleLive();
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = store.getState();
      unsubscribers.push(store.subscribe(onStore));
      unsubscribers.push(camera.subscribe(() => scheduleCull()));
      unsubscribers.push(camera.onResize(() => {
        maybeInitCamera();
        scheduleCull();
        scheduleLive();
      }));
      unsubscribers.push(camera.onUserInput(() => {
        pendingEmptyFit = false;
        deps.noteCameraInteraction();
        if (store.getState().ui.maximized) store.setUi({ maximized: null });
      }));
      unsubscribers.push(camera.onSettle((cam, layoutZoom) => {
        store.setSettled({ zoom: cam.zoom, layoutZoom });
        recomputeLive();
        const state = store.getState();
        if (state.active && ready) deps.publishViewport(snapshot());
        if (ready && !state.readOnly) {
          const stage = camera.stageSize();
          if (stage.w > 0 && stage.h > 0) store.data.setViewport(viewportFromCamera(cam, stage));
        }
      }));
      maybeInitCamera();
      recomputeVisible();
      if (!store.getState().active) handleActive(false);
    },
    stop() {
      if (!running) return;
      running = false;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      if (cullFrame !== null) cancelFrame(cullFrame);
      if (liveFrame !== null) cancelFrame(liveFrame);
      cullFrame = null;
      liveFrame = null;
      if (dwellTimer !== null) clearTimer(dwellTimer);
      if (demoteTimer !== null) clearTimer(demoteTimer);
      dwellTimer = null;
      demoteTimer = null;
      deps.publishViewport(null);
    },
    cameraReady: () => ready,
    onCameraReady(listener) {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    recomputeVisible,
    recomputeLive,
  };
}
