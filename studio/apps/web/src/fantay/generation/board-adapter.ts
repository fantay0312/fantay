// SPDX-License-Identifier: AGPL-3.0-only
// The only file of the generation service that knows the board contract (spec 05 §4.2, plan R1/R3/R4).
// It converts the board document of 04's `BoardDataStore` into the generation graph view and translates
// `GenerationBoardOp`s into contract `BoardOp`s:
//   - generator data is flattened onto the node (R3a); media data maps to `ref` + natural size, `generation`,
//     `refProxy` (R3b); a key patched with `undefined` clears the field (board `null`);
//   - the graph's `derived` edge role is stored as `lineage` (R3e); reference order is the board's edge order
//     (`createdAt`, then `id`);
//   - frame/web/design covers become not-daemon-ready reference pictures with a pseudo path
//     (`board-cover:<digest>`, `chat-artifact-snapshot:<id>`) that `references.ts` turns into project files.
import {
  GENERATION_EDGE_ROLE_TO_BOARD_KIND,
  boardKindForPath,
  generationEdgeRoleFromBoardKind,
  isDaemonReadyImage,
  type BoardCoverRef,
  type BoardDocument,
  type BoardEdge,
  type BoardMediaFile,
  type BoardNode,
  type BoardNodeDraft,
  type BoardNodePatch,
  type BoardOp,
  type GenerationBoardOp,
  type GenerationDataPatch,
  type GenerationGraph,
  type GenerationGraphEdge,
  type GenerationGraphNode,
  type GenerationNodeInput,
  type GenerationOpMeta,
  type GeneratorNodeData,
  type MediaNodeData,
} from '@open-design/contracts';

import type { BoardApplyOptions } from '../board/data/types';

export interface ReferencePickOptions {
  generatorId: string;
  isEligible(n: GenerationGraphNode): boolean;
  onPick(nodeId: string): void;
  onExit(): void;
}

export interface GenerationBoardPort {
  /** Referentially stable between changes (cached per board document) — required by useSyncExternalStore. */
  getGraph(): GenerationGraph;
  getNode(id: string): GenerationGraphNode | null;
  /** Synchronous, atomic, one undo step if undoable. */
  apply(ops: GenerationBoardOp[], meta: GenerationOpMeta): void;
  subscribe(listener: () => void): () => void;
  onNodesRemoved(listener: (ids: string[]) => void): () => void;
  select(ids: string[]): void;
  /** Fly-to. */
  focus(id: string): void;
  startReferencePick?(o: ReferencePickOptions): void;
  stopReferencePick?(): void;
}

/** The subset of 04's `BoardDataStore` (W1 `board/data/types.ts`) that the generation service uses. */
export interface BoardStoreLike {
  getState(): { board: BoardDocument | null };
  subscribe(listener: () => void): () => void;
  apply(ops: BoardOp[], options?: BoardApplyOptions): Promise<unknown>;
}

/** Engine callbacks (plan R4: `ui: { select(ids), focus(id) }`); pick mode is optional (deferred in phase 1). */
export interface GenerationBoardUi {
  select(ids: string[]): void;
  focus(id: string): void;
  startReferencePick?(o: ReferencePickOptions): void;
  stopReferencePick?(): void;
}

// ---- cover references ------------------------------------------------------------------------------

export const BOARD_COVER_REFERENCE_PREFIX = 'board-cover:';
export const SNAPSHOT_COVER_REFERENCE_PREFIX = 'chat-artifact-snapshot:';

export type CoverReference =
  | { source: 'board-cover'; digest: string }
  | { source: 'chat-artifact-snapshot'; snapshotId: string };

/** The cover behind a pseudo reference path of a frame/web/design node, or null for a project path. */
export function coverReferenceOf(path: string): CoverReference | null {
  if (path.startsWith(BOARD_COVER_REFERENCE_PREFIX)) {
    const digest = path.slice(BOARD_COVER_REFERENCE_PREFIX.length);
    return digest ? { source: 'board-cover', digest } : null;
  }
  if (path.startsWith(SNAPSHOT_COVER_REFERENCE_PREFIX)) {
    const snapshotId = path.slice(SNAPSHOT_COVER_REFERENCE_PREFIX.length);
    return snapshotId ? { source: 'chat-artifact-snapshot', snapshotId } : null;
  }
  return null;
}

function coverImage(cover: BoardCoverRef | undefined): (BoardMediaFile & { daemonReady: boolean }) | undefined {
  if (!cover) return undefined;
  if (cover.source === 'board-cover') {
    return {
      path: `${BOARD_COVER_REFERENCE_PREFIX}${cover.digest}`,
      mime: cover.mime,
      width: cover.width,
      height: cover.height,
      daemonReady: false,
    };
  }
  return { path: `${SNAPSHOT_COVER_REFERENCE_PREFIX}${cover.snapshotId}`, daemonReady: false };
}

/** `${path}@${mtime ?? 0}`: what a reference proxy was made from (spec 05 §4.7). */
export function referenceSourceKey(file: Pick<BoardMediaFile, 'path' | 'mtime'>): string {
  return `${file.path}@${file.mtime ?? 0}`;
}

// ---- document → graph --------------------------------------------------------------------------------

type MediaBoardNode = Extract<BoardNode, { kind: 'image' | 'video' }>;

function mediaDataOf(node: MediaBoardNode): MediaNodeData {
  const data: MediaNodeData = {};
  const generation = node.generation;
  const primary = generation?.primaryCandidateId
    ? generation.candidates.find((candidate) => candidate.id === generation.primaryCandidateId)?.file
    : undefined;
  if (node.ref) {
    const file: BoardMediaFile = { ...(primary && primary.path === node.ref.path ? primary : {}), path: node.ref.path };
    if (typeof node.naturalWidth === 'number' && node.naturalWidth > 0) file.width = node.naturalWidth;
    if (typeof node.naturalHeight === 'number' && node.naturalHeight > 0) file.height = node.naturalHeight;
    if (node.kind === 'video' && typeof node.durationMs === 'number' && node.durationMs > 0) file.durationMs = node.durationMs;
    data.file = file;
  } else if (primary) {
    // The primary file was not mirrored into `ref` (its extension is not placeable as this kind).
    data.file = { ...primary };
  }
  if (node.refProxy) data.refProxy = { path: node.refProxy.path, sourceKey: node.refProxy.sourceKey };
  if (generation) data.generation = generation;
  return data;
}

function graphNodeOf(node: BoardNode, memberIds: string[]): GenerationGraphNode {
  const base: GenerationGraphNode = { id: node.id, kind: 'other', x: node.x, y: node.y, w: node.w, h: node.h };
  if (node.title) base.title = node.title;
  switch (node.kind) {
    case 'generator': {
      const generator: GeneratorNodeData = {
        version: 1,
        surface: node.surface,
        prompt: node.prompt,
        model: node.model,
        params: node.params,
        runs: node.runs,
      };
      if (node.templateId) generator.templateId = node.templateId;
      return { ...base, kind: 'generator', generator };
    }
    case 'image':
    case 'video': {
      const media = mediaDataOf(node);
      const graphNode: GenerationGraphNode = { ...base, kind: node.kind, media };
      if (node.kind === 'image' && !node.missing && media.file) {
        const proxy = node.refProxy;
        graphNode.image =
          proxy && proxy.sourceKey === referenceSourceKey(media.file)
            ? { path: proxy.path, daemonReady: true }
            : { ...media.file, daemonReady: isDaemonReadyImage(media.file) };
      }
      return graphNode;
    }
    case 'note':
      return { ...base, kind: 'note', text: node.text };
    case 'group':
      return { ...base, kind: 'group', memberIds };
    case 'frame':
    case 'web':
    case 'design': {
      const image = node.missing ? undefined : coverImage(node.cover);
      return image ? { ...base, image } : base;
    }
    default:
      return base;
  }
}

function isBoardDocumentLike(value: unknown): value is Pick<BoardDocument, 'nodes' | 'edges'> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { nodes?: unknown }).nodes) &&
    Array.isArray((value as { edges?: unknown }).edges)
  );
}

/** Converts the board document while reusing graph objects of unchanged board objects. */
class GraphBuilder {
  private readonly nodes = new WeakMap<BoardNode, GenerationGraphNode>();
  private readonly groups = new Map<string, { source: BoardNode; members: string; value: GenerationGraphNode }>();
  private readonly edges = new WeakMap<BoardEdge, GenerationGraphEdge>();

  build(doc: Pick<BoardDocument, 'nodes' | 'edges'>): GenerationGraph {
    const children = new Map<string, string[]>();
    for (const node of doc.nodes) {
      if (!node.parentId) continue;
      const list = children.get(node.parentId);
      if (list) list.push(node.id);
      else children.set(node.parentId, [node.id]);
    }
    const nodes = doc.nodes.map((node) => {
      if (node.kind === 'group') {
        const members = children.get(node.id) ?? [];
        const key = members.join('\u0000');
        const cached = this.groups.get(node.id);
        if (cached && cached.source === node && cached.members === key) return cached.value;
        const value = graphNodeOf(node, members);
        this.groups.set(node.id, { source: node, members: key, value });
        return value;
      }
      const cached = this.nodes.get(node);
      if (cached) return cached;
      const value = graphNodeOf(node, []);
      this.nodes.set(node, value);
      return value;
    });
    const edges: GenerationGraphEdge[] = [];
    doc.edges.forEach((edge, order) => {
      const role = generationEdgeRoleFromBoardKind(edge.kind);
      if (!role) return;
      const cached = this.edges.get(edge);
      if (cached && cached.order === order) {
        edges.push(cached);
        return;
      }
      const value: GenerationGraphEdge = { id: edge.id, from: edge.from, to: edge.to, role, order };
      this.edges.set(edge, value);
      edges.push(value);
    });
    return { nodes, edges };
  }
}

const EMPTY_GRAPH: GenerationGraph = Object.freeze({ nodes: [], edges: [] }) as unknown as GenerationGraph;

/** Graph view of a board document (spec-04 `BoardDocument`); anything else reads as an empty board. */
export function toGenerationGraph(snapshot: unknown): GenerationGraph {
  const doc = isBoardDocumentLike(snapshot)
    ? snapshot
    : isBoardDocumentLike((snapshot as { board?: unknown } | null)?.board)
      ? ((snapshot as { board: Pick<BoardDocument, 'nodes' | 'edges'> }).board)
      : null;
  return doc ? new GraphBuilder().build(doc) : { nodes: [], edges: [] };
}

// ---- generation ops → board ops ----------------------------------------------------------------------

interface WorkingNode {
  kind: BoardNode['kind'];
  refPath: string | null;
  naturalWidth: number | null;
  naturalHeight: number | null;
  durationMs: number | null;
  hasGeneration: boolean;
}

function workingOf(node: BoardNode): WorkingNode {
  const media = node.kind === 'image' || node.kind === 'video' ? node : null;
  return {
    kind: node.kind,
    refPath: media?.ref?.path ?? null,
    naturalWidth: media?.naturalWidth ?? null,
    naturalHeight: media?.naturalHeight ?? null,
    durationMs: node.kind === 'video' ? (node.durationMs ?? null) : null,
    hasGeneration: Boolean(media?.generation),
  };
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

const GENERATOR_PATCH_KEYS = ['surface', 'prompt', 'model', 'params', 'templateId', 'runs', 'version'];

function placeableFile(file: BoardMediaFile | undefined, kind: 'image' | 'video'): BoardMediaFile | undefined {
  return file && boardKindForPath(file.path) === kind ? file : undefined;
}

function addOpOf(input: GenerationNodeInput, outputEdgeFrom: ReadonlyMap<string, string>): BoardOp {
  const common = {
    id: input.id,
    x: input.x,
    y: input.y,
    w: input.w,
    h: input.h,
    ...(input.title.trim() ? { title: input.title } : {}),
  };
  if (input.kind === 'generator') {
    const data = input.data as GeneratorNodeData;
    const node = {
      ...common,
      kind: 'generator' as const,
      version: 1 as const,
      surface: data.surface,
      prompt: data.prompt,
      model: data.model,
      params: { ...data.params },
      ...(data.templateId ? { templateId: data.templateId } : {}),
      runs: data.runs.map((run) => ({ ...run })),
    };
    return { op: 'add', node: node as BoardNodeDraft };
  }
  const data = input.data as MediaNodeData;
  const file = placeableFile(data.file, input.kind);
  const generatorId = data.generation?.request.generatorId ?? outputEdgeFrom.get(input.id);
  const node = {
    ...common,
    kind: input.kind,
    ref: file ? { path: file.path } : null,
    ...(file?.width ? { naturalWidth: file.width } : {}),
    ...(file?.height ? { naturalHeight: file.height } : {}),
    ...(input.kind === 'video' && file?.durationMs ? { durationMs: file.durationMs } : {}),
    ...(data.generation ? { generation: data.generation } : {}),
    ...(data.refProxy ? { refProxy: { ...data.refProxy } } : {}),
    ...(generatorId ? { origin: { source: 'generator' as const, generatorNodeId: generatorId } } : {}),
  };
  return { op: 'add', node: node as BoardNodeDraft };
}

function generatorPatchOf(patch: GenerationDataPatch<GeneratorNodeData>): BoardNodePatch {
  const out: BoardNodePatch = {};
  if (patch.surface !== undefined) out.surface = patch.surface;
  if (typeof patch.prompt === 'string') out.prompt = patch.prompt;
  if (hasOwn(patch, 'model') && patch.model !== undefined) out.model = patch.model;
  if (patch.params) out.params = { ...patch.params };
  if (hasOwn(patch, 'templateId')) out.templateId = patch.templateId ?? null;
  if (patch.runs) out.runs = patch.runs.map((run) => ({ ...run }));
  return out;
}

function setIfChanged(
  out: BoardNodePatch,
  key: 'naturalWidth' | 'naturalHeight' | 'durationMs',
  next: number | undefined,
  current: number | null,
): void {
  const value = typeof next === 'number' && next > 0 ? next : null;
  if (value !== current) out[key] = value;
}

function mediaPatchOf(
  kind: 'image' | 'video',
  patch: GenerationDataPatch<MediaNodeData>,
  working: WorkingNode,
): BoardNodePatch {
  const out: BoardNodePatch = {};
  const willHaveGeneration = hasOwn(patch, 'generation') ? Boolean(patch.generation) : working.hasGeneration;
  if (hasOwn(patch, 'file')) {
    const file = patch.file;
    if (file) {
      if (placeableFile(file, kind)) {
        if (working.refPath !== file.path) out.ref = { path: file.path };
        setIfChanged(out, 'naturalWidth', file.width, working.naturalWidth);
        setIfChanged(out, 'naturalHeight', file.height, working.naturalHeight);
        if (kind === 'video') setIfChanged(out, 'durationMs', file.durationMs, working.durationMs);
      }
    } else if (working.refPath !== null && willHaveGeneration) {
      // `ref: null` is valid only while `generation` (or `pending`) is present (plan R3b).
      out.ref = null;
      setIfChanged(out, 'naturalWidth', undefined, working.naturalWidth);
      setIfChanged(out, 'naturalHeight', undefined, working.naturalHeight);
      if (kind === 'video') setIfChanged(out, 'durationMs', undefined, working.durationMs);
    }
  }
  if (hasOwn(patch, 'generation')) out.generation = patch.generation ?? null;
  if (hasOwn(patch, 'refProxy')) out.refProxy = patch.refProxy ? { ...patch.refProxy } : null;
  return out;
}

function applyToWorking(working: WorkingNode, patch: BoardNodePatch): void {
  if (hasOwn(patch, 'ref')) working.refPath = patch.ref ? patch.ref.path : null;
  if (hasOwn(patch, 'naturalWidth')) working.naturalWidth = patch.naturalWidth ?? null;
  if (hasOwn(patch, 'naturalHeight')) working.naturalHeight = patch.naturalHeight ?? null;
  if (hasOwn(patch, 'durationMs')) working.durationMs = patch.durationMs ?? null;
  if (hasOwn(patch, 'generation')) working.hasGeneration = Boolean(patch.generation);
}

function workingOfInput(input: GenerationNodeInput): WorkingNode {
  if (input.kind === 'generator') {
    return { kind: 'generator', refPath: null, naturalWidth: null, naturalHeight: null, durationMs: null, hasGeneration: false };
  }
  const data = input.data as MediaNodeData;
  const file = placeableFile(data.file, input.kind);
  return {
    kind: input.kind,
    refPath: file?.path ?? null,
    naturalWidth: file?.width ?? null,
    naturalHeight: file?.height ?? null,
    durationMs: input.kind === 'video' ? (file?.durationMs ?? null) : null,
    hasGeneration: Boolean(data.generation),
  };
}

/**
 * Translates generation ops into contract ops against `doc` (the current board, optimistic view). Patches
 * of nodes that are neither on the board nor added by the batch are dropped; patches that change nothing
 * are dropped. Edge adds are idempotent (`ifAbsent`).
 */
export function generationOpsToBoardOps(doc: Pick<BoardDocument, 'nodes'> | null, ops: readonly GenerationBoardOp[]): BoardOp[] {
  const working = new Map<string, WorkingNode>();
  for (const node of doc?.nodes ?? []) working.set(node.id, workingOf(node));
  const outputEdgeFrom = new Map<string, string>();
  for (const op of ops) {
    if (op.type === 'edge.add' && op.edge.role === 'output') outputEdgeFrom.set(op.edge.to, op.edge.from);
  }
  const out: BoardOp[] = [];
  for (const op of ops) {
    switch (op.type) {
      case 'node.add':
        out.push(addOpOf(op.node, outputEdgeFrom));
        working.set(op.node.id, workingOfInput(op.node));
        break;
      case 'node.patchData': {
        const current = working.get(op.id);
        if (!current) break;
        let patch: BoardNodePatch;
        if (current.kind === 'generator') {
          patch = generatorPatchOf(op.patch as GenerationDataPatch<GeneratorNodeData>);
        } else if (current.kind === 'image' || current.kind === 'video') {
          if (Object.keys(op.patch).some((key) => GENERATOR_PATCH_KEYS.includes(key))) break;
          patch = mediaPatchOf(current.kind, op.patch as GenerationDataPatch<MediaNodeData>, current);
        } else {
          break;
        }
        if (Object.keys(patch).length === 0) break;
        out.push({ op: 'update', id: op.id, patch });
        applyToWorking(current, patch);
        break;
      }
      case 'node.setFrame':
        if (!working.has(op.id)) break;
        out.push({ op: 'update', id: op.id, patch: { x: op.x, y: op.y, w: op.w, h: op.h } });
        break;
      case 'node.setTitle':
        if (!working.has(op.id)) break;
        out.push({ op: 'update', id: op.id, patch: { title: op.title.trim() ? op.title : null } });
        break;
      case 'edge.add':
        out.push({
          op: 'connect',
          edge: { id: op.edge.id, kind: GENERATION_EDGE_ROLE_TO_BOARD_KIND[op.edge.role], from: op.edge.from, to: op.edge.to },
          ifAbsent: true,
        });
        break;
      case 'edge.remove':
        out.push({ op: 'disconnect', ids: [op.id] });
        break;
      default:
        break;
    }
  }
  return out;
}

// ---- the port ------------------------------------------------------------------------------------------

function nodeIdsOf(board: BoardDocument): Set<string> {
  return new Set(board.nodes.map((node) => node.id));
}

/**
 * Binds the generation service to 04's board data store (plan R4: `createGenerationBoardPort(store, ui)`).
 * Writes go through `store.apply`, which applies optimistically (04 §7.2), so `getGraph()` reflects them at
 * once. Service writes are non-undoable and conflict silently; user actions are undoable.
 */
export function createGenerationBoardPort(store: BoardStoreLike, ui: Partial<GenerationBoardUi> = {}): GenerationBoardPort {
  const builder = new GraphBuilder();
  let cachedBoard: BoardDocument | null | undefined;
  let cachedGraph: GenerationGraph = EMPTY_GRAPH;
  let cachedIndex = new Map<string, GenerationGraphNode>();

  function getGraph(): GenerationGraph {
    const board = store.getState().board;
    if (board !== cachedBoard) {
      cachedBoard = board;
      cachedGraph = board ? builder.build(board) : EMPTY_GRAPH;
      cachedIndex = new Map(cachedGraph.nodes.map((node) => [node.id, node]));
    }
    return cachedGraph;
  }

  const removalListeners = new Set<(ids: string[]) => void>();
  let removalUnsubscribe: (() => void) | null = null;
  let trackedBoard: BoardDocument | null = null;
  let trackedIds: Set<string> | null = null;

  function startRemovalTracking(): void {
    trackedBoard = store.getState().board;
    trackedIds = trackedBoard ? nodeIdsOf(trackedBoard) : null;
    removalUnsubscribe = store.subscribe(() => {
      const board = store.getState().board;
      if (board === trackedBoard || !board) return; // an unloaded board is "unknown", not "everything removed"
      const next = nodeIdsOf(board);
      const removed = trackedIds ? [...trackedIds].filter((id) => !next.has(id)) : [];
      trackedBoard = board;
      trackedIds = next;
      if (removed.length === 0) return;
      for (const listener of [...removalListeners]) listener(removed);
    });
  }

  const port: GenerationBoardPort = {
    getGraph,
    getNode(id) {
      getGraph();
      return cachedIndex.get(id) ?? null;
    },
    apply(ops, meta) {
      if (ops.length === 0) return;
      const boardOps = generationOpsToBoardOps(store.getState().board, ops);
      if (boardOps.length === 0) return;
      const options: BoardApplyOptions = { undoable: meta.undoable, silentConflict: !meta.undoable, label: meta.label };
      if (meta.coalesceKey) options.coalesceKey = meta.coalesceKey;
      // `flush` needs no option: the store sends queued ops in the next microtask (04 §7.2).
      void store.apply(boardOps, options).catch(() => undefined);
    },
    subscribe(listener) {
      return store.subscribe(listener);
    },
    onNodesRemoved(listener) {
      removalListeners.add(listener);
      if (!removalUnsubscribe) startRemovalTracking();
      return () => {
        removalListeners.delete(listener);
        if (removalListeners.size === 0 && removalUnsubscribe) {
          removalUnsubscribe();
          removalUnsubscribe = null;
          trackedBoard = null;
          trackedIds = null;
        }
      };
    },
    select(ids) {
      ui.select?.(ids);
    },
    focus(id) {
      ui.focus?.(id);
    },
  };
  if (ui.startReferencePick) {
    const start = ui.startReferencePick;
    port.startReferencePick = (options) => start(options);
  }
  if (ui.stopReferencePick) {
    const stop = ui.stopReferencePick;
    port.stopReferencePick = () => stop();
  }
  return port;
}
