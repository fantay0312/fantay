// SPDX-License-Identifier: AGPL-3.0-only
// Board clipboard (spec 03 §3.12). Copy/cut write the selected nodes (positions relative to their union, edges
// between them) as `text/plain` with a prefix, plus an in-memory copy; cut removes nodes from the board only (I4).
// Paste priority: a board clip > files (upload) > an http(s) URL (web node) > HTML (a new page) > text (a note) >
// nothing. Same-project file nodes are duplicated by copying their files (I1); clips from another project copy the
// bytes over. Relative clip positions are modelled after Doop src/lib/frameClipboard.ts (idea only, no code copied).
import { useEffect } from 'react';

import type { BoardEdgeKind, BoardNodeKind } from '@open-design/contracts';

import { findNodeByPath, nodeFilePath } from '../model/contract-adapter';
import { unionRect } from '../model/geometry';
import type { DictKey, EngineDoc, EngineEdge, EngineNode, Point } from '../model/types';
import type { BoardEngine } from '../store/board-engine';
import { newBoardId, type EngineOp, type NewNodeDraft } from '../store/ops';
import { isOverlayOpen, isTypingTarget } from './keyboard';

/** `pasted-<yyyyMMdd-HHmmss>.<ext>` (same stamp as file-actions `pastedHtmlName`). */
export function pastedFileName(now: Date, ext: string): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `pasted-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}

export const BOARD_CLIP_PREFIX = 'fantay-board-clip:v1:';
/** Offset of a paste that is not at the pointer (03 §3.12). */
export const PASTE_OFFSET: Point = { x: 24, y: 24 };

export interface BoardClipNode {
  id: string;
  kind: BoardNodeKind;
  /** relative to the clip origin */
  x: number;
  y: number;
  w: number;
  h: number;
  title?: string;
  parentId?: string;
  /** contract kind fields (no server stamps) */
  data: Record<string, unknown>;
}

export interface BoardClipEdge {
  kind: BoardEdgeKind;
  from: string;
  to: string;
  label?: string;
}

export interface BoardClip {
  projectId: string;
  /** world top-left of the copied union */
  origin: Point;
  nodes: BoardClipNode[];
  edges: BoardClipEdge[];
}

const SKIPPED_KEYS = new Set([
  'id', 'kind', 'x', 'y', 'w', 'h', 'rev', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'missing', 'origin',
  'title', 'parentId', 'locked', 'hidden', 'variantLabel',
]);

function clipData(node: EngineNode): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.source as unknown as Record<string, unknown>)) {
    if (SKIPPED_KEYS.has(key) || value === undefined) continue;
    data[key] = value;
  }
  if (node.kind === 'generator') data.runs = [];
  return data;
}

/** The selected nodes plus every descendant of selected groups, parents before children. */
export function clipNodesFor(doc: EngineDoc, selection: readonly string[]): EngineNode[] {
  const chosen = new Set<string>();
  const visit = (id: string): void => {
    if (chosen.has(id)) return;
    const node = doc.nodes.get(id);
    if (!node) return;
    chosen.add(id);
    if (node.kind === 'group') for (const child of doc.children.get(id) ?? []) visit(child);
  };
  for (const id of selection) visit(id);
  const depth = (node: EngineNode): number => {
    let level = 0;
    let parent = node.parentId;
    while (parent && chosen.has(parent) && level < 8) {
      level += 1;
      parent = doc.nodes.get(parent)?.parentId ?? null;
    }
    return level;
  };
  return [...chosen]
    .map((id) => doc.nodes.get(id)!)
    .sort((a, b) => depth(a) - depth(b) || (doc.arrayIndex.get(a.id) ?? 0) - (doc.arrayIndex.get(b.id) ?? 0));
}

export function serializeClip(nodes: readonly EngineNode[], edges: Iterable<EngineEdge>, projectId: string): string {
  const union = unionRect(nodes) ?? { x: 0, y: 0, w: 0, h: 0 };
  const ids = new Set(nodes.map((node) => node.id));
  const clip: BoardClip = {
    projectId,
    origin: { x: union.x, y: union.y },
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      x: node.x - union.x,
      y: node.y - union.y,
      w: node.w,
      h: node.h,
      ...(node.title ? { title: node.title } : {}),
      ...(node.parentId && ids.has(node.parentId) ? { parentId: node.parentId } : {}),
      data: clipData(node),
    })),
    edges: [...edges]
      .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
      .map((edge) => ({ kind: edge.kind, from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}) })),
  };
  return `${BOARD_CLIP_PREFIX}${JSON.stringify(clip)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseClip(text: string): BoardClip | null {
  if (!text.startsWith(BOARD_CLIP_PREFIX)) return null;
  try {
    const value = JSON.parse(text.slice(BOARD_CLIP_PREFIX.length)) as unknown;
    if (!isRecord(value) || typeof value.projectId !== 'string' || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
    const origin = isRecord(value.origin) ? { x: Number(value.origin.x) || 0, y: Number(value.origin.y) || 0 } : { x: 0, y: 0 };
    const nodes: BoardClipNode[] = [];
    for (const raw of value.nodes) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.kind !== 'string' || !isRecord(raw.data)) return null;
      const [x, y, w, h] = [raw.x, raw.y, raw.w, raw.h].map(Number);
      if (![x, y, w, h].every(Number.isFinite)) return null;
      nodes.push({
        id: raw.id,
        kind: raw.kind as BoardNodeKind,
        x: x!,
        y: y!,
        w: w!,
        h: h!,
        ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
        ...(typeof raw.parentId === 'string' ? { parentId: raw.parentId } : {}),
        data: raw.data,
      });
    }
    const edges: BoardClipEdge[] = [];
    for (const raw of value.edges) {
      if (!isRecord(raw) || typeof raw.from !== 'string' || typeof raw.to !== 'string' || typeof raw.kind !== 'string') continue;
      edges.push({ kind: raw.kind as BoardEdgeKind, from: raw.from, to: raw.to, ...(typeof raw.label === 'string' ? { label: raw.label } : {}) });
    }
    return { projectId: value.projectId, origin, nodes, edges };
  } catch {
    return null;
  }
}

export interface RemappedClip {
  /** drafts in paint order, parents first */
  nodes: Array<{ draft: NewNodeDraft; source: BoardClipNode }>;
  edges: Array<{ kind: BoardEdgeKind; from: string; to: string; label?: string }>;
  idMap: ReadonlyMap<string, string>;
}

/** New ids and absolute positions for a clip pasted with its top-left at `at`. */
export function remapClip(clip: BoardClip, at: Point, newId: (kind: BoardNodeKind) => string): RemappedClip {
  const idMap = new Map<string, string>();
  for (const node of clip.nodes) idMap.set(node.id, newId(node.kind));
  const nodes = clip.nodes.map((node) => {
    const parent = node.parentId ? idMap.get(node.parentId) : undefined;
    const draft: NewNodeDraft = {
      kind: node.kind,
      id: idMap.get(node.id)!,
      x: at.x + node.x,
      y: at.y + node.y,
      w: node.w,
      h: node.h,
      ...(node.title ? { title: node.title } : {}),
      ...(parent ? { parentId: parent } : {}),
      data: { ...node.data },
    };
    return { draft, source: node };
  });
  const edges = clip.edges
    .filter((edge) => idMap.has(edge.from) && idMap.has(edge.to))
    .map((edge) => ({ kind: edge.kind, from: idMap.get(edge.from)!, to: idMap.get(edge.to)!, ...(edge.label ? { label: edge.label } : {}) }));
  return { nodes, edges, idMap };
}

/** Clip node that shows a project file (it must be copied, never shared: I1). */
export function clipNodePath(node: BoardClipNode): string | null {
  const ref = node.data.ref;
  if (isRecord(ref) && typeof ref.path === 'string') return ref.path;
  const source = node.data.source;
  if (isRecord(source) && source.type === 'composition' && isRecord(source.ref) && typeof source.ref.path === 'string') return source.ref.path;
  return null;
}

export type PastePlan =
  | { kind: 'clip'; clip: BoardClip }
  | { kind: 'files'; files: File[] }
  | { kind: 'url'; url: string }
  | { kind: 'html'; html: string }
  | { kind: 'note'; text: string }
  | { kind: 'nothing' };

const MEDIA_TYPE = /^(image|video|audio)\//;

/** What a paste means, in the priority order of 03 §3.12. */
export function planPaste(input: { text: string; files: readonly File[] }): PastePlan {
  const clip = parseClip(input.text);
  if (clip && clip.nodes.length > 0) return { kind: 'clip', clip };
  const files = input.files.filter((file) => MEDIA_TYPE.test(file.type) || /\.(html?|fig|op)$/i.test(file.name));
  if (files.length > 0) return { kind: 'files', files };
  const text = input.text.trim();
  if (/^https?:\/\/\S+$/i.test(text)) return { kind: 'url', url: text };
  const head = text.slice(0, 64).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) return { kind: 'html', html: input.text };
  if (text.length > 0) return { kind: 'note', text: input.text };
  return { kind: 'nothing' };
}

/** File-backed nodes of a selection (copy/cut/duplicate need their files). */
export function fileBackedNodes(nodes: readonly EngineNode[]): EngineNode[] {
  return nodes.filter((node) => nodeFilePath(node) !== null);
}

export interface BoardClipboardHandlers {
  /** paste of a parsed plan at a world point (null: not over the stage) */
  paste(plan: PastePlan, at: Point | null): void;
}

let memoryClip: string | null = null;

/** In-memory copy of the last board clip (fallback when the system clipboard is unavailable). */
export function lastBoardClip(): string | null {
  return memoryClip;
}

/**
 * DOM clipboard events for the board (03 §3.12): copy/cut/paste are handled while the board is the active root
 * tab and focused (last press or focus inside the board), never in typing targets or open dialogs/menus.
 */
export function useBoardClipboard(engine: BoardEngine, active: boolean, handlers: BoardClipboardHandlers): void {
  const { paste } = handlers;
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined;
    let pressInside = false;
    let pointer: Point | null = null;
    const root = (): HTMLElement | null => engine.camera.elements()?.root ?? null;
    const inside = (): boolean => {
      const element = root();
      return !!element && (pressInside || element.contains(document.activeElement));
    };
    const eligible = (event: Event): boolean => inside() && !isTypingTarget(event.target) && !isTypingTarget(document.activeElement) && !isOverlayOpen();
    const onPointerDown = (event: PointerEvent): void => {
      const element = root();
      pressInside = !!element && event.target instanceof Node && element.contains(event.target);
    };
    const onPointerMove = (event: PointerEvent): void => {
      const stage = engine.camera.elements()?.stage;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const insideStage = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!insideStage) {
        pointer = null;
        return;
      }
      const cam = engine.camera.get();
      pointer = { x: (event.clientX - rect.left - cam.x) / cam.zoom, y: (event.clientY - rect.top - cam.y) / cam.zoom };
    };
    const write = (event: ClipboardEvent, cut: boolean): void => {
      if (!eligible(event)) return;
      const state = engine.store.getState();
      const selection = state.ui.selection;
      if (selection.length === 0) return;
      const nodes = clipNodesFor(state.doc, selection);
      if (nodes.length === 0) return;
      const text = serializeClip(nodes, state.doc.edges.values(), engine.projectId);
      memoryClip = text;
      try {
        event.clipboardData?.setData('text/plain', text);
      } catch {
        /* the in-memory copy remains */
      }
      event.preventDefault();
      if (cut && !state.readOnly) engine.commands.removeNodes(selection);
    };
    const onCopy = (event: ClipboardEvent): void => write(event, false);
    const onCut = (event: ClipboardEvent): void => write(event, true);
    const onPaste = (event: ClipboardEvent): void => {
      if (!eligible(event) || engine.store.getState().readOnly) return;
      const data = event.clipboardData;
      const text = data?.getData('text/plain') ?? '';
      const files = data ? Array.from(data.files ?? []) : [];
      const plan = planPaste({ text: text || (files.length === 0 ? memoryClip ?? '' : ''), files });
      event.preventDefault();
      paste(plan, pointer);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, [engine, active, paste]);
}

/** Context menu Copy / Cut: the selection as a board clip on the system clipboard (and in memory). */
export async function copyBoardSelection(engine: BoardEngine, cut = false): Promise<boolean> {
  const state = engine.store.getState();
  const selection = state.ui.selection;
  if (selection.length === 0) return false;
  const nodes = clipNodesFor(state.doc, selection);
  if (nodes.length === 0) return false;
  const text = serializeClip(nodes, state.doc.edges.values(), engine.projectId);
  memoryClip = text;
  try {
    if (typeof navigator !== 'undefined') await navigator.clipboard?.writeText(text);
  } catch {
    /* the in-memory copy remains */
  }
  if (cut && !state.readOnly) engine.commands.removeNodes(selection);
  return true;
}

/** Context menu Paste: images and text from the system clipboard, else the in-memory clip. */
export async function readClipboardForPaste(now = new Date()): Promise<{ text: string; files: File[] }> {
  const files: File[] = [];
  let text = '';
  try {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clipboard?.read) {
      for (const item of await clipboard.read()) {
        for (const type of item.types) {
          if (MEDIA_TYPE.test(type)) {
            const blob = await item.getType(type);
            files.push(new File([blob], pastedFileName(now, (type.split('/')[1] ?? 'png').replace(/[^a-z0-9]+/gi, '') || 'png'), { type }));
          } else if (type === 'text/plain' && !text) {
            text = await (await item.getType(type)).text();
          }
        }
      }
    } else if (clipboard?.readText) {
      text = await clipboard.readText();
    }
  } catch {
    /* no permission: fall back to the board's own clip */
  }
  if (!text && files.length === 0 && memoryClip) text = memoryClip;
  return { text, files };
}

/** Keys a pasted copy of a file node must not keep (the old file's cover, provenance of another run). */
const FILE_COPY_DROPPED = ['cover', 'refProxy', 'generation', 'pending', 'migratedFrom'] as const;

export interface PasteClipNotice {
  key: DictKey;
  vars?: Record<string, string | number>;
  tone?: 'default' | 'danger';
}

export interface PasteClipInput {
  engine: BoardEngine;
  clip: BoardClip;
  /** world point for the clip's top-left (null: the copied position + 24/24) */
  at: Point | null;
  /**
   * Copies a file the clip references into this project (`fromProjectId` = the clip's project) and resolves the new
   * path, or null when the copy failed.
   */
  copyFile(path: string, fromProjectId: string): Promise<string | null>;
  notify(notice: PasteClipNotice): void;
  newId?: (kind: BoardNodeKind) => string;
}

/**
 * Pastes a board clip in one undoable transaction and selects the result (03 §3.12 priority 1). File-backed nodes
 * keep their path when no node shows it any more (cut + paste in the same project); otherwise their file is copied
 * first (I1), across projects too (toast `board.paste.crossProject`). Nodes whose copy failed are skipped with their
 * edges; motion compositions are not copied (a folder, not a file).
 */
export async function pasteBoardClip(input: PasteClipInput): Promise<string[]> {
  const { engine, clip } = input;
  const at = input.at ?? { x: clip.origin.x + PASTE_OFFSET.x, y: clip.origin.y + PASTE_OFFSET.y };
  const remapped = remapClip(clip, at, input.newId ?? (() => newBoardId('n')));
  const sameProject = clip.projectId === engine.projectId;
  const doc = engine.store.getState().doc;
  const skipped = new Set<string>();
  const ops: EngineOp[] = [];
  const ids: string[] = [];
  let copiedAcross = false;
  for (const { draft, source } of remapped.nodes) {
    const id = draft.id!;
    const path = clipNodePath(source);
    let data = draft.data;
    if (path) {
      const reuse = sameProject && findNodeByPath(doc, path) === undefined;
      if (!reuse) {
        if (source.kind === 'motion') {
          skipped.add(id);
          continue;
        }
        const next = await input.copyFile(path, clip.projectId).catch(() => null);
        if (!next) {
          skipped.add(id);
          input.notify({ key: 'board.drop.failed', vars: { name: path.split('/').pop() ?? path }, tone: 'danger' });
          continue;
        }
        const copy: Record<string, unknown> = { ...data, ref: { path: next } };
        for (const key of FILE_COPY_DROPPED) delete copy[key];
        data = copy;
        if (!sameProject) copiedAcross = true;
      }
    }
    const node: NewNodeDraft = { ...draft, data };
    if (node.parentId && skipped.has(node.parentId)) delete node.parentId;
    ops.push({ type: 'add', node });
    ids.push(id);
  }
  for (const edge of remapped.edges) {
    if (skipped.has(edge.from) || skipped.has(edge.to)) continue;
    ops.push({ type: 'connect', edge });
  }
  if (ids.length === 0) return [];
  await engine.store.commit({ origin: 'local', label: 'paste', ops });
  engine.commands.select(ids);
  if (copiedAcross) input.notify({ key: 'board.paste.crossProject' });
  return ids;
}

/** Test helper. */
export function resetBoardClipboardForTests(): void {
  memoryClip = null;
}
