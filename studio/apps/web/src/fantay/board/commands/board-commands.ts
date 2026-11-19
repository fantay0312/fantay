// SPDX-License-Identifier: AGPL-3.0-only
// Imperative board API (spec 03 §3.16 with plan R1/R7): selection, camera focus and zoom, file and web nodes
// (invariant I1: one node per file path), node edits, grouping, z-order, alignment, modes, live pins and
// undo/redo. Every edit is a transaction on the engine store, i.e. contract ops through `BoardDataStore.apply`.
// Placement uses the contract layout helpers so client and daemon place identically.
import {
  BOARD_DEFAULT_SIZES,
  BOARD_LIMITS,
  boardCompositionDir,
  boardKindForPath,
  boardNodePageId,
  boardNodesOnPage,
  boardPagesOf,
  canGroupNodes,
  canUngroupNodes,
  defaultBoardNodeSize,
  deviceForFramePath,
  edgeEndpointError,
  isBoardMovieDocumentPath,
  isSafeBoardUrl,
  nextBoardPageTitle,
  placeBoardItems,
  stableBoardId,
  type BoardEdgeKind,
  type BoardNodeKind,
  type BoardOp,
  type BoardPlacement,
} from '@open-design/contracts';

import {
  CHROME_INSETS,
  LABEL_ALLOWANCE,
  MAXIMIZE_INSETS,
  MAXIMIZE_MAX_ZOOM,
  ZOOM_STEP,
  fitRect as fitRectCamera,
  type Camera,
} from '../camera/camera';
import type { CameraController } from '../camera/camera-controller';
import { focusViewportForNode } from '../camera/focus-viewport';
import { createBoardPageId } from '../data/client-id';
import type { BoardExtensions } from '../extensions';
import { findNodeByPath, nodeFilePath, nodesInOrder, toContractNode } from '../model/contract-adapter';
import {
  CLICK_SHAPE_SIZE,
  CLICK_TEXT_WIDTH,
  DEFAULT_SHAPE_FILL,
  DEFAULT_SHAPE_RADIUS,
  DEFAULT_SHAPE_TEXT_STYLE,
  NOTE_DEFAULT_COLOR,
  NOTE_SIZE,
} from '../model/defaults';
import { unionRect } from '../model/geometry';
import { isLiveCapableKind } from '../model/node-registry';
import type {
  BoardCaptureTool,
  BoardEnvironment,
  BoardNodeMode,
  BoardServices,
  BoardTool,
  BoardTranslate,
  EngineDoc,
  EngineNode,
  NodeRuntime,
  Point,
  Rect,
} from '../model/types';
import type { EngineStore } from '../store/board-store';
import { newBoardId, type BoardTxLabel, type EngineOp, type NewNodeDraft, type NodePatch, type TxOrigin } from '../store/ops';
import { dragSetFor } from '../store/selection';
import { toast } from '../../ui/toast';
import { createBlankFrameFile } from './blank-frame';

export interface EnsureFileNodesOptions {
  /** anchor node id or world point (default: the stage centre) */
  near?: string | Point;
  origin?: TxOrigin;
  /** select the resulting nodes (default true) */
  select?: boolean;
  /** fly to them when they are off screen (default true) */
  reveal?: boolean;
}

export interface NewNodeInput {
  kind: BoardNodeKind;
  id?: string;
  /** world top-left */
  x?: number;
  y?: number;
  /** world point the node is centred on (wins over x/y) */
  at?: Point;
  w?: number;
  h?: number;
  title?: string;
  parentId?: string | null;
  data?: Record<string, unknown>;
  placement?: BoardPlacement;
}

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type ReorderMode = 'front' | 'back' | 'forward' | 'backward';

export interface FocusNodesOptions {
  animate?: boolean;
  maxZoom?: number;
  /** skip when the user moved the camera within this many ms */
  ifIdleMs?: number;
}

export interface BoardCommands {
  readonly camera: CameraController;
  getDoc(): EngineDoc;
  getNode(id: string): EngineNode | undefined;
  findNodeByPath(path: string): EngineNode | undefined;
  getSelection(): string[];
  /** Shows a canvas page; every page keeps its own camera. */
  showPage(pageId: string): void;
  /** Adds a page after the last one and shows it; null at the page limit. */
  addPage(): string | null;
  renamePage(pageId: string, title: string): void;
  /** Removes the page and every node on it (undoable); files stay in the project (I4). */
  removePage(pageId: string): void;
  /** Moves nodes (with what they contain) below the content of another page. */
  moveNodesToPage(ids: readonly string[], pageId: string): void;
  select(ids: readonly string[], opts?: { reveal?: boolean }): void;
  clearSelection(): void;
  /** Flies (or jumps) to the nodes; false when nothing moved. */
  focusNodes(ids: readonly string[], opts?: FocusNodesOptions): boolean;
  zoomIn(): void;
  zoomOut(): void;
  /** 1 = 100%, about the stage centre */
  zoomTo(zoom: number): void;
  zoomToFit(opts?: { animate?: boolean }): void;
  zoomToSelection(): void;
  /** Fills the stage with the node; on the maximized node, flies back to the view it left. */
  toggleMaximize(nodeId: string): void;
  /** I1: reuses the node of each path, adds the missing ones in one row; resolves ids in input order. */
  ensureFileNodes(paths: readonly string[], opts?: EnsureFileNodesOptions): string[];
  ensureWebNode(url: string, opts?: { near?: string | Point; origin?: TxOrigin }): string | null;
  addNode(input: NewNodeInput, opts?: { origin?: TxOrigin; select?: boolean; label?: BoardTxLabel }): string;
  updateNode(id: string, patch: NodePatch, opts?: { origin?: TxOrigin; label?: BoardTxLabel; coalesceKey?: string }): void;
  /** I4: removes nodes from the board, never their files. */
  removeNodes(ids: readonly string[], opts?: { origin?: TxOrigin }): void;
  connect(from: string, to: string, kind: BoardEdgeKind, opts?: { origin?: TxOrigin }): string | null;
  disconnect(edgeIds: readonly string[]): void;
  group(ids: readonly string[]): string | null;
  ungroup(ids: readonly string[]): void;
  setLocked(ids: readonly string[], locked: boolean): void;
  reorder(ids: readonly string[], to: ReorderMode): void;
  align(ids: readonly string[], how: AlignMode): void;
  distribute(ids: readonly string[], axis: 'h' | 'v'): void;
  nudge(ids: readonly string[], dx: number, dy: number): void;
  /** Board-native nodes are cloned (+24/+24); file-backed ones go to the chrome's duplicate service. */
  duplicate(ids: readonly string[]): Promise<string[]>;
  /** Synchronous clone of board-native nodes (⌥-drag); file-backed ids are skipped. */
  duplicateNative(ids: readonly string[], offset?: Point): string[];
  /** Ephemeral runtime (progress, covers, playing…), never persisted. */
  setRuntime(id: string, patch: Partial<NodeRuntime> | null): void;
  setMode(nodeId: string | null, mode?: BoardNodeMode, captureTool?: BoardCaptureTool): void;
  setTool(tool: BoardTool): void;
  startTextEdit(id: string): void;
  stopTextEdit(): void;
  startRename(id: string): void;
  stopRename(): void;
  /** R6: a body asks to stay live (playing) or releases its pin. */
  requestLive(id: string, pinned: boolean): void;
  /** Enter on a selection (03 §3.10). */
  enterNode(id: string): void;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  /** Draw tools: frame → blank page file + frame node; rectangle/ellipse/text → shape. Resolves the new id. */
  createDrawnNode(tool: BoardTool, rect: Rect): Promise<string | null>;
  /** Place tools: note at the point (then edit), generator through `extensions.createGenerator`. */
  placeNode(tool: 'note' | 'generate', at: Point): string | null;
}

export interface BoardCommandsDeps {
  store: EngineStore;
  camera: CameraController;
  getEnv(): BoardEnvironment;
  getExtensions(): BoardExtensions | undefined;
  getServices(): BoardServices;
  getTranslate(): BoardTranslate;
  newNodeId?: () => string;
  /** the camera's clock (for `ifIdleMs`) */
  now?: () => number;
}

const DUPLICATE_OFFSET: Point = { x: 24, y: 24 };
const FIT_ALL_MAX_ZOOM = 1;
const FIT_SELECTION_MAX_ZOOM = 4;
const NON_COPIED_KEYS: ReadonlySet<string> = new Set([
  'id', 'kind', 'x', 'y', 'w', 'h', 'rev', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'missing', 'origin',
  'title', 'parentId', 'locked', 'hidden', 'variantLabel',
]);

function isFileBacked(node: EngineNode): boolean {
  return nodeFilePath(node) !== null;
}

/** Rect for camera fitting: the node grown by the label above it. */
function withLabel(rect: Rect, zoomHint: number): Rect {
  const allowance = LABEL_ALLOWANCE / Math.max(0.05, zoomHint);
  return { x: rect.x, y: rect.y - allowance, w: rect.w, h: rect.h + allowance };
}

export function createBoardCommands(deps: BoardCommandsDeps): BoardCommands {
  const { store, camera } = deps;
  const newNodeId = deps.newNodeId ?? (() => newBoardId('n'));
  const clock = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

  const state = () => store.getState();
  const doc = () => state().doc;

  function commit(label: BoardTxLabel, ops: EngineOp[], origin: TxOrigin = 'local', coalesceKey?: string): void {
    if (ops.length === 0) return;
    void store.commit({ origin, label, ops, ...(coalesceKey ? { coalesceKey } : {}) });
  }

  function stageCenterWorld(): Point {
    const cam = camera.get();
    const stage = camera.stageSize();
    return { x: (stage.w / 2 - cam.x) / cam.zoom, y: (stage.h / 2 - cam.y) / cam.zoom };
  }

  function isOnScreen(rect: Rect): boolean {
    const cam = camera.get();
    const stage = camera.stageSize();
    const left = rect.x * cam.zoom + cam.x;
    const top = rect.y * cam.zoom + cam.y;
    return left >= 0 && top >= 0 && left + rect.w * cam.zoom <= stage.w && top + rect.h * cam.zoom <= stage.h;
  }

  /** The nodes can sit on another page (a chat output, a generation): show it before they are selected or focused. */
  function showPageOf(ids: readonly string[]): void {
    const board = doc().source;
    if (!board || ids.length === 0 || ids.some((id) => doc().nodes.has(id))) return;
    const node = board.nodes.find((entry) => ids.includes(entry.id));
    if (node) store.data.setActivePage(boardNodePageId(node, boardPagesOf(board)));
  }

  function applyPageOps(ops: BoardOp[]): void {
    void store.data.apply(ops, { label: 'page' }).catch(() => undefined);
    store.syncFromData();
  }

  function addPage(): string | null {
    const { pages } = store.data.getState();
    if (state().readOnly || pages.length >= BOARD_LIMITS.maxPages) return null;
    const page = { id: createBoardPageId(), title: nextBoardPageTitle(pages) };
    applyPageOps([{ op: 'set-meta', pages: [...pages, page] }]);
    store.data.setActivePage(page.id);
    return page.id;
  }

  function renamePage(pageId: string, title: string): void {
    const { pages } = store.data.getState();
    const next = title.trim().slice(0, BOARD_LIMITS.maxPageTitleLength);
    if (state().readOnly || !next || !pages.some((page) => page.id === pageId && page.title !== next)) return;
    applyPageOps([{ op: 'set-meta', pages: pages.map((page) => (page.id === pageId ? { ...page, title: next } : page)) }]);
  }

  function removePage(pageId: string): void {
    const { pages, activePageId, board } = store.data.getState();
    const index = pages.findIndex((page) => page.id === pageId);
    if (state().readOnly || !board || pages.length < 2 || index < 0) return;
    const ids = boardNodesOnPage(board.nodes, pages, pageId).map((node) => node.id);
    if (pageId === activePageId) store.data.setActivePage(pages[index === 0 ? 1 : index - 1]!.id);
    applyPageOps([
      ...(ids.length > 0 ? [{ op: 'remove', ids, cascade: true } as BoardOp] : []),
      { op: 'set-meta', pages: pages.filter((page) => page.id !== pageId) },
    ]);
  }

  function moveNodesToPage(ids: readonly string[], pageId: string): void {
    const { pages, board } = store.data.getState();
    if (state().readOnly || !board || !pages.some((page) => page.id === pageId)) return;
    const moving = new Set<string>();
    const add = (id: string): void => {
      if (moving.has(id)) return;
      moving.add(id);
      for (const child of doc().children.get(id) ?? []) add(child);
    };
    for (const id of ids) if (doc().nodes.has(id)) add(id);
    const nodes = [...moving].map((id) => doc().nodes.get(id)!);
    const bounds = unionRect(nodes);
    if (!bounds) return;
    const [origin] = placeBoardItems({ nodes: boardNodesOnPage(board.nodes, pages, pageId) }, [bounds], { mode: 'auto' });
    const dx = origin!.x - bounds.x;
    const dy = origin!.y - bounds.y;
    // a node leaving its group on its own stays on this side of the move: it is taken out of the group
    applyPageOps(nodes.map((node) => ({
      op: 'update',
      id: node.id,
      patch: {
        page: pageId,
        x: node.x + dx,
        y: node.y + dy,
        ...(node.parentId !== null && !moving.has(node.parentId) ? { parentId: null } : {}),
      },
    })));
  }

  function select(ids: readonly string[], opts: { reveal?: boolean } = {}): void {
    showPageOf(ids);
    const known = ids.filter((id, index) => ids.indexOf(id) === index);
    const current = state().ui;
    const keepMode = current.mode && known.length === 1 && known[0] === current.mode.nodeId ? current.mode : null;
    store.setUi({ selection: known, selectedEdgeId: null, mode: keepMode });
    if (opts.reveal) {
      const rects = known.map((id) => doc().nodes.get(id)).filter((node): node is EngineNode => !!node);
      const union = unionRect(rects);
      if (union && !isOnScreen(union)) focusNodes(known, { animate: true });
    }
  }

  function targetCameraFor(rects: Rect[], opts: FocusNodesOptions): Camera | null {
    const stage = camera.stageSize();
    if (rects.length === 0 || stage.w <= 0 || stage.h <= 0) return null;
    const maxZoom = opts.maxZoom ?? 1;
    if (rects.length === 1) {
      const target = focusViewportForNode(rects[0]!, stage, { bottomInset: CHROME_INSETS.bottom, above: LABEL_ALLOWANCE });
      return target.zoom > maxZoom ? { ...fitRectCamera(rects[0]!, stage, { maxZoom }) } : target;
    }
    const union = unionRect(rects);
    if (!union) return null;
    const primary = rects[0]!;
    const cx = primary.x + primary.w / 2;
    const cy = primary.y + primary.h / 2;
    const halfW = Math.max(cx - union.x, union.x + union.w - cx, primary.w / 2, 1);
    const halfH = Math.max(cy - union.y, union.y + union.h - cy, primary.h / 2, 1);
    const centeredUnion: Rect = { x: cx - halfW, y: cy - halfH, w: halfW * 2, h: halfH * 2 };
    return fitRectCamera(centeredUnion, stage, { maxZoom });
  }

  function focusNodes(ids: readonly string[], opts: FocusNodesOptions = {}): boolean {
    if (opts.ifIdleMs !== undefined && clock() - camera.lastUserInputAt() < opts.ifIdleMs) return false;
    showPageOf(ids);
    const nodes = ids.map((id) => doc().nodes.get(id)).filter((node): node is EngineNode => !!node && !node.hidden);
    const rects: Rect[] = nodes.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));
    const target = targetCameraFor(rects, opts);
    if (!target) return false;
    if (opts.animate === false) camera.set(target, 'program');
    else camera.flyTo(target);
    return true;
  }

  function zoomToFit(opts: { animate?: boolean } = {}): void {
    const nodes = nodesInOrder(doc()).filter((node) => !node.hidden && node.parentId === null);
    const union = unionRect(nodes.map((node) => withLabel(node, camera.get().zoom)));
    if (!union) {
      camera.set({ x: 80, y: 80, zoom: 1 }, 'user');
      return;
    }
    camera.fitRect(union, { maxZoom: FIT_ALL_MAX_ZOOM, animate: opts.animate ?? false, labelAllowance: 0 });
  }

  function zoomToSelection(): void {
    const nodes = state().ui.selection.map((id) => doc().nodes.get(id)).filter((node): node is EngineNode => !!node);
    const union = unionRect(nodes.map((node) => withLabel(node, camera.get().zoom)));
    if (!union) return;
    camera.fitRect(union, { maxZoom: FIT_SELECTION_MAX_ZOOM, animate: false, labelAllowance: 0 });
  }

  function toggleMaximize(nodeId: string): void {
    const current = state().ui.maximized;
    if (current?.nodeId === nodeId) {
      store.setUi({ maximized: null });
      camera.flyTo(current.returnTo);
      return;
    }
    const node = doc().nodes.get(nodeId);
    const stage = camera.stageSize();
    if (!node || stage.w <= 0 || stage.h <= 0) return;
    store.setUi({ maximized: { nodeId, returnTo: current?.returnTo ?? camera.get() } });
    camera.flyTo(fitRectCamera(node, stage, { padding: 0, maxZoom: MAXIMIZE_MAX_ZOOM, insets: MAXIMIZE_INSETS, labelAllowance: 0 }));
  }

  function fileDraft(path: string, env: BoardEnvironment): { draft: NewNodeDraft; ifAbsent: boolean } | null {
    const kind = boardKindForPath(path);
    if (!kind) return null;
    const projectKind = env.isDeckProject ? 'deck' : undefined;
    switch (kind) {
      case 'frame': {
        const device = deviceForFramePath(path, env.projectPlatform ?? null, projectKind ?? null);
        const size = defaultBoardNodeSize('frame', { device, projectKind });
        return {
          draft: { kind, id: stableBoardId('n', `path:${path}`), w: size.w, h: size.h, data: { ref: { path }, device: size.device ?? device } },
          ifAbsent: true,
        };
      }
      case 'image':
      case 'video':
      case 'audio': {
        const size = defaultBoardNodeSize(kind);
        return { draft: { kind, id: stableBoardId('n', `path:${path}`), w: size.w, h: size.h, data: { ref: { path } } }, ifAbsent: true };
      }
      case 'design': {
        const size = defaultBoardNodeSize('design');
        const format = path.toLowerCase().endsWith('.op') ? 'op' : 'fig';
        return { draft: { kind, id: stableBoardId('n', `path:${path}`), w: size.w, h: size.h, data: { ref: { path }, format } }, ifAbsent: true };
      }
      case 'motion': {
        const size = defaultBoardNodeSize('motion');
        if (isBoardMovieDocumentPath(path)) {
          // R5: one movie node per project, stable id + ifAbsent
          return {
            draft: { kind, id: stableBoardId('n', `movie:${env.projectId}`), w: size.w, h: size.h, data: { source: { type: 'movie', projectId: env.projectId } } },
            ifAbsent: true,
          };
        }
        const dir = boardCompositionDir(path);
        if (!dir) return null;
        return {
          draft: { kind, id: stableBoardId('n', `path:${path}`), w: size.w, h: size.h, data: { source: { type: 'composition', ref: { path } } } },
          ifAbsent: true,
        };
      }
      default:
        return null;
    }
  }

  function existingNodeFor(path: string, env: BoardEnvironment): EngineNode | undefined {
    const byPath = findNodeByPath(doc(), path);
    if (byPath) return byPath;
    if (isBoardMovieDocumentPath(path)) {
      for (const node of doc().nodes.values()) {
        if (node.kind === 'motion' && node.data.source.type === 'movie' && node.data.source.projectId === env.projectId) return node;
      }
    }
    return undefined;
  }

  function placementFor(near: string | Point | undefined): BoardPlacement {
    if (typeof near === 'string' && doc().nodes.has(near)) return { mode: 'near', nodeId: near };
    const point = typeof near === 'object' ? near : stageCenterWorld();
    return { mode: 'viewport', centerX: point.x, centerY: point.y };
  }

  function placedPositions(sizes: Array<{ w: number; h: number }>, placement: BoardPlacement): Array<{ x: number; y: number }> {
    return placeBoardItems({ nodes: nodesInOrder(doc()).map(toContractNode) }, sizes, placement);
  }

  function ensureFileNodes(paths: readonly string[], opts: EnsureFileNodesOptions = {}): string[] {
    const env = deps.getEnv();
    const result: string[] = [];
    const drafts: Array<{ draft: NewNodeDraft; ifAbsent: boolean }> = [];
    const seen = new Set<string>();
    for (const path of paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const existing = existingNodeFor(path, env);
      if (existing) {
        result.push(existing.id);
        continue;
      }
      const stable = fileDraft(path, env);
      if (!stable || !stable.draft.id) continue;
      // the stable id is taken when the file already sits on another page: this page gets its own node
      const elsewhere = doc().source?.nodes.some((node) => node.id === stable.draft.id) === true;
      const planned = elsewhere ? { ...stable, draft: { ...stable.draft, id: newNodeId() } } : stable;
      if (drafts.some((entry) => entry.draft.id === planned.draft.id)) continue;
      drafts.push(planned);
      result.push(planned.draft.id!);
    }
    if (drafts.length > 0) {
      const positions = placedPositions(drafts.map(({ draft }) => ({ w: draft.w ?? 0, h: draft.h ?? 0 })), placementFor(opts.near));
      const ops: EngineOp[] = drafts.map(({ draft, ifAbsent }, index) => ({
        type: 'add',
        node: { ...draft, x: positions[index]?.x, y: positions[index]?.y },
        ifAbsent,
      }));
      commit('insert', ops, opts.origin ?? 'local');
    }
    if (opts.select !== false && result.length > 0) {
      select(result);
      if (opts.reveal !== false) {
        const rects = result.map((id) => doc().nodes.get(id)).filter((node): node is EngineNode => !!node);
        const union = unionRect(rects);
        if (union && !isOnScreen(union)) focusNodes(result, { animate: true });
      }
    }
    return result;
  }

  function ensureWebNode(url: string, opts: { near?: string | Point; origin?: TxOrigin } = {}): string | null {
    if (!isSafeBoardUrl(url)) return null;
    for (const node of doc().nodes.values()) if (node.kind === 'web' && node.data.url === url) return node.id;
    const size = defaultBoardNodeSize('web', { device: 'desktop' });
    const [position] = placedPositions([size], placementFor(opts.near));
    const id = newNodeId();
    commit('create', [{ type: 'add', node: { kind: 'web', id, x: position?.x, y: position?.y, w: size.w, h: size.h, data: { url, device: 'desktop' } } }], opts.origin ?? 'local');
    select([id]);
    return id;
  }

  function addNode(input: NewNodeInput, opts: { origin?: TxOrigin; select?: boolean; label?: BoardTxLabel } = {}): string {
    const id = input.id ?? newNodeId();
    const fallback = input.kind === 'group' ? { w: 160, h: 120 } : BOARD_DEFAULT_SIZES[input.kind];
    const w = input.w ?? fallback.w;
    const h = input.h ?? fallback.h;
    let x = input.x;
    let y = input.y;
    if (input.at) {
      x = input.at.x - w / 2;
      y = input.at.y - h / 2;
    }
    const node: NewNodeDraft = { kind: input.kind, id, w, h, ...(input.title ? { title: input.title } : {}), data: input.data ?? {} };
    if (input.parentId) node.parentId = input.parentId;
    let placement: BoardPlacement | undefined;
    if (x !== undefined && y !== undefined) {
      node.x = x;
      node.y = y;
    } else {
      placement = input.placement ?? placementFor(undefined);
      const [position] = placedPositions([{ w, h }], placement);
      if (position) {
        node.x = position.x;
        node.y = position.y;
        placement = undefined;
      }
    }
    commit(opts.label ?? 'create', [{ type: 'add', node, ...(placement ? { placement } : {}) }], opts.origin ?? 'local');
    if (opts.select !== false) select([id]);
    return id;
  }

  function updateNode(id: string, patch: NodePatch, opts: { origin?: TxOrigin; label?: BoardTxLabel; coalesceKey?: string } = {}): void {
    commit(opts.label ?? 'style', [{ type: 'patch', id, patch }], opts.origin ?? 'local', opts.coalesceKey);
  }

  function removeNodes(ids: readonly string[], opts: { origin?: TxOrigin } = {}): void {
    const existing = ids.filter((id) => doc().nodes.has(id));
    if (existing.length === 0) return;
    commit('delete', [{ type: 'remove', ids: existing }], opts.origin ?? 'local');
    const ui = state().ui;
    store.setUi({
      selection: ui.selection.filter((id) => !existing.includes(id)),
      mode: ui.mode && existing.includes(ui.mode.nodeId) ? null : ui.mode,
    });
  }

  function connect(from: string, to: string, kind: BoardEdgeKind, opts: { origin?: TxOrigin } = {}): string | null {
    const current = doc();
    const fromNode = current.nodes.get(from);
    const toNode = current.nodes.get(to);
    if (!fromNode || !toNode) return null;
    if (edgeEndpointError(kind, fromNode, toNode) !== null) return null;
    for (const edge of current.edges.values()) if (edge.from === from && edge.to === to && edge.kind === kind) return edge.id;
    const id = newBoardId('e');
    commit('connect', [{ type: 'connect', edge: { id, kind, from, to } }], opts.origin ?? 'local');
    return id;
  }

  function disconnect(edgeIds: readonly string[]): void {
    commit('disconnect', [{ type: 'disconnect', ids: edgeIds }]);
    if (state().ui.selectedEdgeId && edgeIds.includes(state().ui.selectedEdgeId!)) store.setUi({ selectedEdgeId: null });
  }

  function group(ids: readonly string[]): string | null {
    const current = doc();
    const members = ids.filter((id) => current.nodes.has(id));
    const geometry = nodesInOrder(current).map((node) => ({ id: node.id, kind: node.kind, x: node.x, y: node.y, w: node.w, h: node.h, parentId: node.parentId ?? undefined }));
    if (!canGroupNodes(members, geometry)) return null;
    const id = newNodeId();
    commit('group', [{ type: 'group', ids: members, group: { id, role: 'section', layout: 'free' } }]);
    select([id]);
    return id;
  }

  function ungroup(ids: readonly string[]): void {
    const current = doc();
    const geometry = nodesInOrder(current).map((node) => ({ id: node.id, kind: node.kind, x: node.x, y: node.y, w: node.w, h: node.h, parentId: node.parentId ?? undefined }));
    if (!canUngroupNodes(ids, geometry)) return;
    const ops: EngineOp[] = [];
    const released: string[] = [];
    for (const id of ids) {
      const node = current.nodes.get(id);
      if (!node) continue;
      if (node.kind === 'group') {
        released.push(...(current.children.get(id) ?? []));
        ops.push({ type: 'ungroup', id });
      } else if (node.parentId !== null && !ids.includes(node.parentId)) {
        const parent = current.nodes.get(node.parentId);
        released.push(id);
        ops.push({ type: 'patch', id, patch: { parentId: parent?.parentId ?? null } });
      }
    }
    commit('ungroup', ops);
    if (released.length > 0) select(released);
  }

  function setLocked(ids: readonly string[], locked: boolean): void {
    commit('lock', ids.map((id) => ({ type: 'patch', id, patch: { locked } }) as EngineOp));
  }

  function reorder(ids: readonly string[], to: ReorderMode): void {
    const current = doc();
    const source = current.source;
    if (!source) return;
    const ops: EngineOp[] = [];
    const sorted = [...ids].filter((id) => current.nodes.has(id)).sort((a, b) => (current.arrayIndex.get(a) ?? 0) - (current.arrayIndex.get(b) ?? 0));
    if (to === 'front' || to === 'back') {
      // keep the relative order of a multi-selection
      const sequence = to === 'front' ? sorted : [...sorted].reverse();
      for (const id of sequence) ops.push({ type: 'reorder', id, to });
    } else {
      const order = source.nodes.map((node) => node.id);
      const sequence = to === 'forward' ? [...sorted].reverse() : sorted;
      for (const id of sequence) {
        const node = current.nodes.get(id);
        const index = order.indexOf(id);
        if (!node || index < 0) continue;
        const sameLayer = (otherId: string): boolean => {
          const other = current.nodes.get(otherId);
          return !!other && (other.kind === 'group') === (node.kind === 'group') && !ids.includes(otherId);
        };
        let target = -1;
        if (to === 'forward') {
          for (let next = index + 1; next < order.length; next += 1) if (sameLayer(order[next]!)) { target = next; break; }
        } else {
          for (let prev = index - 1; prev >= 0; prev -= 1) if (sameLayer(order[prev]!)) { target = prev; break; }
        }
        if (target < 0) continue;
        order.splice(index, 1);
        order.splice(target, 0, id);
        ops.push({ type: 'reorder', id, to: target });
      }
    }
    commit('reorder', ops);
  }

  function topLevelSelection(ids: readonly string[]): EngineNode[] {
    const set = dragSetFor(doc(), ids);
    return set.roots.map((id) => doc().nodes.get(id)).filter((node): node is EngineNode => !!node);
  }

  function align(ids: readonly string[], how: AlignMode): void {
    const nodes = topLevelSelection(ids);
    const union = unionRect(nodes);
    if (!union || nodes.length < 2) return;
    const moves = nodes.map((node) => {
      switch (how) {
        case 'left': return { id: node.id, x: union.x, y: node.y };
        case 'center': return { id: node.id, x: union.x + (union.w - node.w) / 2, y: node.y };
        case 'right': return { id: node.id, x: union.x + union.w - node.w, y: node.y };
        case 'top': return { id: node.id, x: node.x, y: union.y };
        case 'middle': return { id: node.id, x: node.x, y: union.y + (union.h - node.h) / 2 };
        default: return { id: node.id, x: node.x, y: union.y + union.h - node.h };
      }
    });
    commit('align', [{ type: 'move', moves }]);
  }

  function distribute(ids: readonly string[], axis: 'h' | 'v'): void {
    const nodes = topLevelSelection(ids);
    if (nodes.length < 3) return;
    const sorted = [...nodes].sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const span = axis === 'h' ? last.x + last.w - first.x : last.y + last.h - first.y;
    const total = sorted.reduce((sum, node) => sum + (axis === 'h' ? node.w : node.h), 0);
    const gap = (span - total) / (sorted.length - 1);
    let cursor = axis === 'h' ? first.x : first.y;
    const moves = sorted.map((node) => {
      const move = axis === 'h' ? { id: node.id, x: cursor, y: node.y } : { id: node.id, x: node.x, y: cursor };
      cursor += (axis === 'h' ? node.w : node.h) + gap;
      return move;
    });
    commit('align', [{ type: 'move', moves }]);
  }

  function nudge(ids: readonly string[], dx: number, dy: number): void {
    const nodes = topLevelSelection(ids);
    if (nodes.length === 0) return;
    const key = `nudge:${nodes.map((node) => node.id).sort().join(',')}`;
    commit('nudge', [{ type: 'move', moves: nodes.map((node) => ({ id: node.id, x: node.x + dx, y: node.y + dy })) }], 'local', key);
  }

  function cloneDraft(node: EngineNode, offset: Point): NewNodeDraft {
    const source = toContractNode(node) as unknown as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (NON_COPIED_KEYS.has(key) || value === undefined) continue;
      data[key] = value;
    }
    if (node.kind === 'generator') data.runs = [];
    return {
      kind: node.kind,
      id: newNodeId(),
      x: node.x + offset.x,
      y: node.y + offset.y,
      w: node.w,
      h: node.h,
      ...(node.title ? { title: node.title } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      data,
    };
  }

  function duplicateNative(ids: readonly string[], offset: Point = DUPLICATE_OFFSET): string[] {
    const nodes = topLevelSelection(ids).filter((node) => !isFileBacked(node) && node.kind !== 'group');
    if (nodes.length === 0) return [];
    const drafts = nodes.map((node) => cloneDraft(node, offset));
    commit('duplicate', drafts.map((draft) => ({ type: 'add', node: draft }) as EngineOp));
    return drafts.map((draft) => draft.id!);
  }

  async function duplicate(ids: readonly string[]): Promise<string[]> {
    const nodes = topLevelSelection(ids);
    const native = duplicateNative(nodes.map((node) => node.id));
    const fileNodes = nodes.filter(isFileBacked);
    let copied: string[] = [];
    const service = deps.getServices().duplicateFileNodes;
    if (fileNodes.length > 0 && service) {
      try {
        copied = await service(fileNodes);
      } catch {
        copied = [];
      }
    }
    const all = [...native, ...copied];
    if (all.length > 0) select(all);
    return all;
  }

  function setMode(nodeId: string | null, mode?: BoardNodeMode, captureTool: BoardCaptureTool = 'pick'): void {
    if (nodeId === null || !mode) {
      store.setUi({ mode: null });
      return;
    }
    const node = doc().nodes.get(nodeId);
    if (!node || !isLiveCapableKind(node.kind)) return;
    if (mode !== 'navigate' && state().readOnly) return;
    if (mode === 'edit' && node.kind !== 'frame') return;
    if (mode === 'capture' && node.kind !== 'frame' && node.kind !== 'web') return;
    if (node.kind === 'frame' && state().runtime.get(nodeId)?.phase === 'building' && mode !== 'capture') return;
    store.setUi({ mode: { nodeId, mode, captureTool }, selection: [nodeId], selectedEdgeId: null });
  }

  function setTool(tool: BoardTool): void {
    if (state().readOnly && tool !== 'select' && tool !== 'hand') return;
    /* the Comment tool runs the page picker itself: a Navigate/Edit/Capture mode ends */
    store.setUi(tool === 'comment' && state().ui.mode ? { tool, mode: null } : { tool });
  }

  function enterNode(id: string): void {
    const node = doc().nodes.get(id);
    if (!node) return;
    const extensions = deps.getExtensions();
    const env = deps.getEnv();
    switch (node.kind) {
      case 'frame':
      case 'web':
        setMode(id, 'navigate');
        return;
      case 'note':
      case 'shape':
        if (node.kind === 'shape' && node.data.shape === 'freehand') return;
        if (!state().readOnly) store.setUi({ editingTextId: id, selection: [id] });
        return;
      case 'design':
        if (extensions?.openDesignDocument) extensions.openDesignDocument(node.data.ref.path);
        else env.onOpenInFiles(node.data.ref.path);
        return;
      case 'motion': {
        const source = node.data.source;
        if (source.type === 'movie') extensions?.openMotionStudio?.(source.projectId);
        else env.onOpenInFiles(source.ref.path);
        return;
      }
      case 'group':
        select([...(doc().children.get(id) ?? [])]);
        return;
      case 'generator':
        store.setUi({ selection: [id], panelFocusNonce: state().ui.panelFocusNonce + 1 });
        return;
      default:
        return;
    }
  }

  async function createDrawnNode(tool: BoardTool, rect: Rect): Promise<string | null> {
    if (state().readOnly) return null;
    const t = deps.getTranslate();
    store.setUi({ tool: 'select' });
    if (tool === 'rectangle' || tool === 'ellipse') {
      return addNode({
        kind: 'shape',
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        data: tool === 'rectangle'
          ? { shape: 'rect', fill: DEFAULT_SHAPE_FILL, radius: DEFAULT_SHAPE_RADIUS }
          : { shape: 'ellipse', fill: DEFAULT_SHAPE_FILL },
      });
    }
    if (tool === 'text') {
      const id = addNode({ kind: 'shape', x: rect.x, y: rect.y, w: rect.w, h: rect.h, data: { shape: 'text', text: '', textStyle: { ...DEFAULT_SHAPE_TEXT_STYLE } } });
      store.setUi({ editingTextId: id });
      return id;
    }
    if (tool !== 'frame') return null;
    const env = deps.getEnv();
    const custom = deps.getServices().createBlankFrameFile;
    let path: string | null = null;
    let failure: string | undefined;
    if (custom) {
      path = await custom();
    } else {
      const written = await createBlankFrameFile({
        projectId: env.projectId,
        existingNames: env.files.map((file) => file.name),
        workspaceContext: env.workspaceContext,
      });
      path = written.ok && written.name ? written.name : null;
      failure = written.message;
    }
    if (!path) {
      toast({ title: t('board.edit.failed', { reason: failure ?? t('board.node.state.error') }), tone: 'danger' });
      return null;
    }
    env.onRefreshFiles?.();
    return addNode({ kind: 'frame', x: rect.x, y: rect.y, w: rect.w, h: rect.h, data: { ref: { path }, device: 'custom' } });
  }

  function placeNode(tool: 'note' | 'generate', at: Point): string | null {
    if (state().readOnly) return null;
    store.setUi({ tool: 'select' });
    if (tool === 'note') {
      const id = addNode({ kind: 'note', at, w: NOTE_SIZE.w, h: NOTE_SIZE.h, data: { text: '', color: NOTE_DEFAULT_COLOR } });
      store.setUi({ editingTextId: id });
      return id;
    }
    const extensions = deps.getExtensions();
    if (!extensions?.createGenerator) {
      toast({ title: deps.getTranslate()('board.insert.unavailable') });
      return null;
    }
    const id = extensions.createGenerator({ selectedIds: [...state().ui.selection], at });
    if (id) select([id]);
    return id;
  }

  return {
    camera,
    getDoc: doc,
    getNode: (id) => doc().nodes.get(id),
    findNodeByPath: (path) => findNodeByPath(doc(), path),
    getSelection: () => [...state().ui.selection],
    showPage: (pageId) => store.data.setActivePage(pageId),
    addPage,
    renamePage,
    removePage,
    moveNodesToPage,
    select,
    clearSelection() {
      store.setUi({ selection: [], selectedEdgeId: null, mode: null });
    },
    focusNodes,
    zoomIn() {
      camera.zoomTo(camera.get().zoom * ZOOM_STEP, undefined, 'user');
    },
    zoomOut() {
      camera.zoomTo(camera.get().zoom / ZOOM_STEP, undefined, 'user');
    },
    zoomTo(zoom) {
      if (Number.isFinite(zoom) && zoom > 0) camera.zoomTo(zoom, undefined, 'user');
    },
    zoomToFit,
    zoomToSelection,
    toggleMaximize,
    ensureFileNodes,
    ensureWebNode,
    addNode,
    updateNode,
    removeNodes,
    connect,
    disconnect,
    group,
    ungroup,
    setLocked,
    reorder,
    align,
    distribute,
    nudge,
    duplicate,
    duplicateNative,
    setRuntime: (id, patch) => store.setRuntime(id, patch),
    setMode,
    setTool,
    startTextEdit(id) {
      const node = doc().nodes.get(id);
      if (state().readOnly || !node || (node.kind === 'shape' && node.data.shape === 'freehand')) return;
      store.setUi({ editingTextId: id, selection: [id] });
    },
    stopTextEdit() {
      store.setUi({ editingTextId: null });
    },
    startRename(id) {
      if (state().readOnly || !doc().nodes.has(id)) return;
      store.setUi({ renamingId: id });
    },
    stopRename() {
      store.setUi({ renamingId: null });
    },
    requestLive: (id, pinned) => store.setPinnedLive(id, pinned),
    enterNode,
    undo: () => store.undo(),
    redo: () => store.redo(),
    createDrawnNode,
    placeNode,
  };
}

/** Click size of a draw tool (03 §4.0): shapes 160×120, text 240 wide, frames the desktop device. */
export function clickRectFor(tool: BoardTool, at: Point, env: Pick<BoardEnvironment, 'isDeckProject'>): Rect {
  if (tool === 'text') {
    const h = Math.round(DEFAULT_SHAPE_TEXT_STYLE.fontSize * 1.5);
    return { x: at.x - CLICK_TEXT_WIDTH / 2, y: at.y - h / 2, w: CLICK_TEXT_WIDTH, h };
  }
  if (tool === 'frame') {
    const size = defaultBoardNodeSize('frame', env.isDeckProject ? { projectKind: 'deck' } : { device: 'desktop' });
    return { x: at.x - size.w / 2, y: at.y - size.h / 2, w: size.w, h: size.h };
  }
  return { x: at.x - CLICK_SHAPE_SIZE.w / 2, y: at.y - CLICK_SHAPE_SIZE.h / 2, w: CLICK_SHAPE_SIZE.w, h: CLICK_SHAPE_SIZE.h };
}
