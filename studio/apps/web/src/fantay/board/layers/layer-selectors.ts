// SPDX-License-Identifier: AGPL-3.0-only
// Store slices of the layers (spec 03 §3.1) with value equality, so a layer re-renders only when what it draws
// changes — never on pan/zoom (I2).
import { sameRect } from '../model/geometry';
import { handlesFor, isReferenceSource } from '../model/node-registry';
import type { BoardEdgeKind, BoardNodeMode, BoardTool, Point, Rect, ResizeHandle, SnapGuide } from '../model/types';
import type { EngineState } from '../store/board-store';

export interface EdgeLayerSlice {
  edges: Array<{ id: string; kind: BoardEdgeKind; from: Rect; to: Rect; selected: boolean }>;
  connect: { source: Rect; point: Point; target: Rect | null } | null;
}

function rectOfNode(state: EngineState, id: string): Rect | null {
  const node = state.doc.nodes.get(id);
  if (!node) return null;
  return state.preview?.rects.get(id) ?? node;
}

export function edgeLayerSlice(state: EngineState): EdgeLayerSlice {
  const edges: EdgeLayerSlice['edges'] = [];
  for (const id of state.visibleEdgeIds) {
    const edge = state.doc.edges.get(id);
    if (!edge) continue;
    const from = rectOfNode(state, edge.from);
    const to = rectOfNode(state, edge.to);
    if (!from || !to) continue;
    edges.push({ id, kind: edge.kind, from, to, selected: state.ui.selectedEdgeId === id });
  }
  const preview = state.preview?.connect;
  let connect: EdgeLayerSlice['connect'] = null;
  if (preview) {
    const source = rectOfNode(state, preview.from);
    if (source) connect = { source, point: preview.point, target: preview.to ? rectOfNode(state, preview.to) : null };
  }
  return { edges, connect };
}

export function sameEdgeLayerSlice(a: EdgeLayerSlice, b: EdgeLayerSlice): boolean {
  if (a.edges.length !== b.edges.length) return false;
  for (let index = 0; index < a.edges.length; index += 1) {
    const x = a.edges[index]!;
    const y = b.edges[index]!;
    if (x.id !== y.id || x.kind !== y.kind || x.selected !== y.selected || !sameRect(x.from, y.from) || !sameRect(x.to, y.to)) return false;
  }
  if (a.connect === b.connect) return true;
  if (!a.connect || !b.connect) return false;
  return sameRect(a.connect.source, b.connect.source)
    && sameRect(a.connect.target, b.connect.target)
    && a.connect.point.x === b.connect.point.x
    && a.connect.point.y === b.connect.point.y;
}

export interface SelectionSlice {
  boxes: Array<{ id: string; rect: Rect; handles: readonly ResizeHandle[]; mode: BoardNodeMode | null }>;
  union: Rect | null;
  hover: Rect | null;
  /** Valid connection target ring while dragging a connection (spec 03 §3.8). */
  connectTarget: Rect | null;
  /** node that shows a connector dot (hovered or sole-selected reference source); `hoverOnly`: no handles drawn */
  connector: { id: string; rect: Rect; hoverOnly: boolean } | null;
}

const NO_HANDLES: readonly ResizeHandle[] = Object.freeze([]);

export function selectionSlice(state: EngineState): SelectionSlice {
  const { ui, doc } = state;
  const gesture = ui.interaction !== 'idle';
  const boxes: SelectionSlice['boxes'] = [];
  const sole = ui.selection.length === 1;
  for (const id of ui.selection) {
    const node = doc.nodes.get(id);
    const rect = rectOfNode(state, id);
    if (!node || !rect || node.hidden) continue;
    const showHandles = sole && !node.locked && !state.readOnly && ui.interaction !== 'dragging' && ui.mode?.nodeId !== id;
    boxes.push({ id, rect, handles: showHandles ? handlesFor(node) : NO_HANDLES, mode: ui.mode?.nodeId === id ? ui.mode.mode : null });
  }
  let union: Rect | null = null;
  if (boxes.length > 1) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const box of boxes) {
      left = Math.min(left, box.rect.x);
      top = Math.min(top, box.rect.y);
      right = Math.max(right, box.rect.x + box.rect.w);
      bottom = Math.max(bottom, box.rect.y + box.rect.h);
    }
    union = { x: left, y: top, w: right - left, h: bottom - top };
  }
  const hoverNode = ui.hoverId && !ui.selection.includes(ui.hoverId) && !gesture ? doc.nodes.get(ui.hoverId) : undefined;
  const hover = hoverNode && !hoverNode.hidden ? rectOfNode(state, hoverNode.id) : null;
  const connectTargetId = state.preview?.connect?.to ?? null;
  const connectTargetNode = connectTargetId ? doc.nodes.get(connectTargetId) : undefined;
  const connectTarget = connectTargetNode && !connectTargetNode.hidden ? rectOfNode(state, connectTargetNode.id) : null;
  let connector: SelectionSlice['connector'] = null;
  if (!state.readOnly && !gesture) {
    const candidateId = sole ? ui.selection[0]! : ui.hoverId;
    const candidate = candidateId ? doc.nodes.get(candidateId) : undefined;
    if (candidate && !candidate.hidden && !candidate.locked && isReferenceSource(candidate.kind) && ui.mode?.nodeId !== candidate.id) {
      connector = { id: candidate.id, rect: rectOfNode(state, candidate.id) ?? candidate, hoverOnly: !sole };
    }
  }
  return { boxes, union, hover, connectTarget, connector };
}

export function sameSelectionSlice(a: SelectionSlice, b: SelectionSlice): boolean {
  if (a.boxes.length !== b.boxes.length) return false;
  for (let index = 0; index < a.boxes.length; index += 1) {
    const x = a.boxes[index]!;
    const y = b.boxes[index]!;
    if (x.id !== y.id || x.mode !== y.mode || x.handles !== y.handles || !sameRect(x.rect, y.rect)) return false;
  }
  if (!sameRect(a.union, b.union) || !sameRect(a.hover, b.hover) || !sameRect(a.connectTarget, b.connectTarget)) return false;
  if (a.connector === b.connector) return true;
  if (!a.connector || !b.connector) return false;
  return a.connector.id === b.connector.id && a.connector.hoverOnly === b.connector.hoverOnly && sameRect(a.connector.rect, b.connector.rect);
}

export interface GestureSlice {
  marquee: Rect | null;
  draw: { tool: BoardTool; rect: Rect } | null;
  guides: readonly SnapGuide[];
  resize: { rect: Rect; w: number; h: number } | null;
}

const NO_GUIDES: readonly SnapGuide[] = [];

export function gestureSlice(state: EngineState): GestureSlice {
  const preview = state.preview;
  if (!preview) return { marquee: null, draw: null, guides: NO_GUIDES, resize: null };
  const resizeRect = preview.resize ? preview.rects.get(preview.resize.id) ?? null : null;
  return {
    marquee: preview.marquee ?? null,
    draw: preview.draw ?? null,
    guides: preview.guides ?? NO_GUIDES,
    resize: preview.resize && resizeRect ? { rect: resizeRect, w: preview.resize.w, h: preview.resize.h } : null,
  };
}

export function sameGestureSlice(a: GestureSlice, b: GestureSlice): boolean {
  if (!sameRect(a.marquee, b.marquee)) return false;
  if (a.draw !== b.draw && (!a.draw || !b.draw || a.draw.tool !== b.draw.tool || !sameRect(a.draw.rect, b.draw.rect))) return false;
  if (a.guides !== b.guides) {
    if (a.guides.length !== b.guides.length) return false;
    for (let index = 0; index < a.guides.length; index += 1) {
      const x = a.guides[index]!;
      const y = b.guides[index]!;
      if (x.axis !== y.axis || x.at !== y.at || x.from !== y.from || x.to !== y.to) return false;
    }
  }
  if (a.resize === b.resize) return true;
  if (!a.resize || !b.resize) return false;
  return a.resize.w === b.resize.w && a.resize.h === b.resize.h && sameRect(a.resize.rect, b.resize.rect);
}

/** Visible ids split into the groups sublayer and the nodes sublayer (paint order kept). */
export interface WorldSlice {
  groups: readonly string[];
  nodes: readonly string[];
}

export function worldSlice(state: EngineState): WorldSlice {
  const groups: string[] = [];
  const nodes: string[] = [];
  for (const id of state.visibleIds) {
    const node = state.doc.nodes.get(id);
    if (!node) continue;
    if (node.kind === 'group') groups.push(id);
    else nodes.push(id);
  }
  return { groups, nodes };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export function sameWorldSlice(a: WorldSlice, b: WorldSlice): boolean {
  return sameList(a.groups, b.groups) && sameList(a.nodes, b.nodes);
}
