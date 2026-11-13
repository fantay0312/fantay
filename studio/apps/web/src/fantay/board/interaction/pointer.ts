/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/Stage.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: pointer pan and marquee (L783-855) as a
 *   framework-free controller; node drag with snapping and group drop targets, 8-handle resize, draw, place,
 *   connect and edge selection are Fantay additions (spec 03 §3.7–§3.8). Every gesture previews per animation
 *   frame and commits one transaction on release.
 */
import {
  findGroupDropTarget,
  type BoardGeometryNode,
} from '@open-design/contracts';

import type { CameraController } from '../camera/camera-controller';
import { screenToWorld } from '../camera/camera';
import { BOARD_INTERACTIVE_ATTR } from '../extensions';
import { clickRectFor, type BoardCommands } from '../commands/board-commands';
import { ancestorsOf } from '../model/contract-adapter';
import { containsPoint, rectFromPoints, translate, unionRect } from '../model/geometry';
import { aspectLockedByDefault, isReferenceSource, minSizeFor } from '../model/node-registry';
import type { BoardEnvironment, BoardTool, EngineNode, Point, Rect, ResizeHandle, SnapGuide } from '../model/types';
import type { EngineStore } from '../store/board-store';
import type { EngineOp } from '../store/ops';
import { dragSetFor, marqueeHits, marqueeSelect, pressSelect } from '../store/selection';
import { resizeRect } from './resize';
import { snapRect } from './snap';
import { resolvePointerAction, type BoardPointerTarget } from './tools';

/** A press becomes a drag after this many screen px. */
export const DRAG_THRESHOLD_PX = 3;
const RESIZE_HANDLES: ReadonlySet<string> = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

export interface ResolvedTarget {
  kind: BoardPointerTarget | 'interactive';
  id?: string;
  handle?: ResizeHandle;
}

/** What a press landed on (R6: `data-board-interactive` regions belong to their content, not the board). */
export function resolvePointerTarget(target: EventTarget | null): ResolvedTarget {
  const element = target instanceof Element ? target : null;
  if (!element) return { kind: 'background' };
  if (element.closest(`[${BOARD_INTERACTIVE_ATTR}]`)) return { kind: 'interactive' };
  const handle = element.closest('[data-board-handle]');
  if (handle) {
    const value = handle.getAttribute('data-board-handle') ?? '';
    const id = handle.getAttribute('data-node-id') ?? undefined;
    if (RESIZE_HANDLES.has(value) && id) return { kind: 'handle', id, handle: value as ResizeHandle };
  }
  const connector = element.closest('[data-board-connector]');
  if (connector) {
    const id = connector.getAttribute('data-node-id') ?? undefined;
    if (id) return { kind: 'connector', id };
  }
  const edge = element.closest('[data-board-edge]');
  if (edge) {
    const id = edge.getAttribute('data-edge-id') ?? undefined;
    if (id) return { kind: 'edge', id };
  }
  const label = element.closest('[data-board-label]');
  if (label) {
    const id = label.getAttribute('data-node-id') ?? undefined;
    if (id) return { kind: 'label', id };
  }
  const node = element.closest('[data-board-node]');
  if (node) {
    const id = node.getAttribute('data-node-id') ?? undefined;
    if (id) return { kind: 'node', id };
  }
  return { kind: 'background' };
}

export interface PointerControllerDeps {
  store: EngineStore;
  camera: CameraController;
  commands: BoardCommands;
  getEnv(): BoardEnvironment;
  /** 04 `noteCameraInteraction` (user pan/zoom/drag) */
  noteInteraction(): void;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
}

export interface PointerController {
  onPointerDown(event: PointerEvent): void;
  /** hover tracking while no gesture runs */
  onPointerMove(event: PointerEvent): void;
  onPointerLeave(): void;
  onDoubleClick(event: MouseEvent): void;
  onContextMenu(event: MouseEvent): void;
  /** Esc: cancels a running gesture (true when one was cancelled) */
  cancel(): boolean;
  active(): boolean;
  dispose(): void;
}

interface Gesture {
  pointerId: number;
  move(event: PointerEvent): void;
  up(event: PointerEvent): void;
  cancel(): void;
}

function defaultRequestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => callback());
  return setTimeout(callback, 16) as unknown as number;
}

function defaultCancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

function geometryOf(node: EngineNode, rect?: Rect): BoardGeometryNode {
  const r = rect ?? node;
  return { id: node.id, kind: node.kind, x: r.x, y: r.y, w: r.w, h: r.h, parentId: node.parentId ?? undefined };
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
}

export function createPointerController(deps: PointerControllerDeps): PointerController {
  const { store, camera, commands } = deps;
  const now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const requestFrame = deps.requestFrame ?? defaultRequestFrame;
  const cancelFrame = deps.cancelFrame ?? defaultCancelFrame;
  let gesture: Gesture | null = null;

  const state = () => store.getState();

  function stageRect(): DOMRect | { left: number; top: number } {
    const el = camera.elements()?.stage;
    return el ? el.getBoundingClientRect() : { left: 0, top: 0 };
  }

  function toLocal(event: { clientX: number; clientY: number }): Point {
    const rect = stageRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function toWorld(event: { clientX: number; clientY: number }): Point {
    return screenToWorld(camera.get(), toLocal(event));
  }

  function onWindowMove(event: PointerEvent): void {
    if (gesture && event.pointerId === gesture.pointerId) gesture.move(event);
  }

  function onWindowUp(event: PointerEvent): void {
    if (gesture && event.pointerId === gesture.pointerId) gesture.up(event);
  }

  function onWindowCancel(event: PointerEvent): void {
    if (gesture && event.pointerId === gesture.pointerId) cancel();
  }

  function begin(next: Gesture): void {
    end();
    gesture = next;
    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
    window.addEventListener('pointercancel', onWindowCancel);
  }

  function end(): void {
    if (!gesture) return;
    gesture = null;
    window.removeEventListener('pointermove', onWindowMove);
    window.removeEventListener('pointerup', onWindowUp);
    window.removeEventListener('pointercancel', onWindowCancel);
    if (state().ui.interaction !== 'idle') store.setUi({ interaction: 'idle' });
  }

  function cancel(): boolean {
    if (!gesture) return false;
    const current = gesture;
    current.cancel();
    end();
    store.setPreview(null);
    return true;
  }

  /** Frame-batched move processing: the latest event wins. */
  function frameBatcher(handle: (event: PointerEvent) => void): { push(event: PointerEvent): void; flush(): void; stop(): void } {
    let pending: PointerEvent | null = null;
    let frame: number | null = null;
    const run = (): void => {
      frame = null;
      const event = pending;
      pending = null;
      if (event) handle(event);
    };
    return {
      push(event) {
        pending = event;
        if (frame === null) frame = requestFrame(run);
      },
      flush() {
        if (frame !== null) cancelFrame(frame);
        run();
      },
      stop() {
        if (frame !== null) cancelFrame(frame);
        frame = null;
        pending = null;
      },
    };
  }

  function clearSelection(): void {
    store.setUi({ selection: [], selectedEdgeId: null, mode: null, contextTarget: null });
  }

  /* A press on the canvas takes focus the way a plain click does, also when the gesture prevents the default
     (pan, marquee, resize, draw, connect): an open rename field or text editor blurs and commits, and the next
     keys reach the board rather than a chrome control that kept focus. The root is focusable (tabIndex -1). */
  function focusBoard(): void {
    const root = camera.elements()?.root;
    if (root && typeof document !== 'undefined' && document.activeElement !== root) root.focus({ preventScroll: true });
  }

  /** The innermost visible group under a world point (group bodies let the pointer through to the canvas). */
  function groupAt(world: Point): EngineNode | null {
    const { doc, visibleIds } = state();
    let found: EngineNode | null = null;
    let depth = -1;
    for (const id of visibleIds) {
      const node = doc.nodes.get(id);
      if (!node || node.kind !== 'group' || node.hidden || !containsPoint(node, world)) continue;
      const level = ancestorsOf(doc, id).length;
      if (level >= depth) {
        found = node;
        depth = level;
      }
    }
    return found;
  }

  function neighbourRects(exclude: ReadonlySet<string>): Rect[] {
    const { doc, visibleIds } = state();
    const rects: Rect[] = [];
    for (const id of visibleIds) {
      if (exclude.has(id)) continue;
      const node = doc.nodes.get(id);
      if (node && !node.hidden) rects.push(node);
    }
    return rects;
  }

  /* ── pan ──────────────────────────────────────────────────────────────────────────────── */
  function startPan(event: PointerEvent, background: boolean): void {
    let last = { x: event.clientX, y: event.clientY };
    let moved = false;
    begin({
      pointerId: event.pointerId,
      move(ev) {
        const dx = ev.clientX - last.x;
        const dy = ev.clientY - last.y;
        last = { x: ev.clientX, y: ev.clientY };
        if (!moved && Math.abs(dx) + Math.abs(dy) > 2) {
          moved = true;
          store.setUi({ interaction: 'panning' });
        }
        /* a pinch owns the camera while it lasts */
        if (camera.isPinching()) return;
        camera.panBy(dx, dy, 'user');
      },
      up() {
        end();
        if (!moved && background) clearSelection();
      },
      cancel() {},
    });
  }

  /* ── marquee ──────────────────────────────────────────────────────────────────────────── */
  function startMarquee(event: PointerEvent): void {
    const origin = toWorld(event);
    const keep = event.shiftKey ? state().ui.selection : [];
    let moved = false;
    const batch = frameBatcher((ev) => {
      const current = toWorld(ev);
      const rect = rectFromPoints(origin, current);
      const hits = marqueeHits(state().doc.nodes.values(), rect);
      store.batch(() => {
        store.setPreview({ rects: new Map(), marquee: rect });
        store.setUi({ selection: marqueeSelect(keep, hits), selectedEdgeId: null });
      });
    });
    begin({
      pointerId: event.pointerId,
      move(ev) {
        if (!moved) {
          const zoom = camera.get().zoom;
          const cur = toWorld(ev);
          if ((Math.abs(cur.x - origin.x) + Math.abs(cur.y - origin.y)) * zoom <= DRAG_THRESHOLD_PX) return;
          moved = true;
          store.setUi({ interaction: 'marquee', mode: null });
        }
        batch.push(ev);
      },
      up(ev) {
        if (moved) {
          batch.push(ev);
          batch.flush();
        }
        batch.stop();
        end();
        store.setPreview(null);
        /* a plain click on empty canvas clears the selection */
        if (!moved && !event.shiftKey) clearSelection();
      },
      cancel() {
        batch.stop();
      },
    });
  }

  /* ── node drag ────────────────────────────────────────────────────────────────────────── */
  function startNodeDrag(event: PointerEvent, nodeId: string): void {
    const toggle = event.shiftKey || (isMac() ? event.metaKey : event.ctrlKey);
    const before = state().ui.selection;
    const selection = pressSelect(before, nodeId, toggle);
    const modeNode = state().ui.mode?.nodeId;
    store.setUi({
      selection,
      selectedEdgeId: null,
      mode: modeNode && modeNode !== nodeId ? null : state().ui.mode,
      contextTarget: null,
    });
    if (toggle && !selection.includes(nodeId)) return;
    const origin = { x: event.clientX, y: event.clientY };
    let started = false;
    let ids = selection;
    let set = dragSetFor(state().doc, ids);
    let starts = new Map<string, Rect>();
    let latest = { dx: 0, dy: 0, dropGroupId: null as string | null };

    const capture = (): void => {
      const { doc } = state();
      set = dragSetFor(doc, ids);
      starts = new Map();
      for (const id of set.all) {
        const node = doc.nodes.get(id);
        if (node) starts.set(id, { x: node.x, y: node.y, w: node.w, h: node.h });
      }
    };

    const batch = frameBatcher((ev) => {
      const zoom = camera.get().zoom;
      let dx = (ev.clientX - origin.x) / zoom;
      let dy = (ev.clientY - origin.y) / zoom;
      const rootRects = set.roots.map((id) => starts.get(id)).filter((r): r is Rect => !!r);
      const union = unionRect(rootRects);
      let guides: readonly SnapGuide[] = [];
      if (union && !ev.altKey) {
        const moved = translate(union, dx, dy);
        const snapped = snapRect('move', moved, neighbourRects(new Set(set.all)), zoom);
        dx += snapped.x - moved.x;
        dy += snapped.y - moved.y;
        guides = snapped.guides;
      }
      const rects = new Map<string, Rect>();
      for (const [id, start] of starts) rects.set(id, translate(start, dx, dy));
      const { doc } = state();
      const nonGroupRoots = set.roots.filter((id) => doc.nodes.get(id)?.kind !== 'group');
      let dropGroupId: string | null = null;
      if (nonGroupRoots.length > 0 && nonGroupRoots.length === set.roots.length) {
        const geometry: BoardGeometryNode[] = [];
        for (const id of doc.order) {
          const node = doc.nodes.get(id);
          if (node && !node.hidden) geometry.push(geometryOf(node, rects.get(id)));
        }
        dropGroupId = findGroupDropTarget(nonGroupRoots, geometry)?.id ?? null;
      }
      latest = { dx, dy, dropGroupId };
      store.setPreview({ rects, guides, dropGroupId });
    });

    begin({
      pointerId: event.pointerId,
      move(ev) {
        if (!started) {
          if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD_PX) return;
          started = true;
          if (ev.altKey || event.altKey) {
            // ⌥-drag duplicates first, then drags the copies (board-native nodes)
            const copies = commands.duplicateNative(ids, { x: 0, y: 0 });
            if (copies.length > 0) {
              ids = copies;
              store.setUi({ selection: copies });
            }
          }
          capture();
          if (set.roots.length === 0) {
            batch.stop();
            end();
            return;
          }
          store.setUi({ interaction: 'dragging' });
          deps.noteInteraction();
        }
        batch.push(ev);
      },
      up(ev) {
        if (!started) {
          batch.stop();
          end();
          return;
        }
        batch.push(ev);
        batch.flush();
        batch.stop();
        commitDrag();
        end();
        store.setPreview(null);
      },
      cancel() {
        batch.stop();
      },
    });

    function commitDrag(): void {
      const { doc } = state();
      const { dx, dy, dropGroupId } = latest;
      if (dx === 0 && dy === 0 && !dropGroupId) return;
      const ops: EngineOp[] = [];
      const moves = set.roots
        .map((id) => {
          const start = starts.get(id);
          return start ? { id, x: start.x + dx, y: start.y + dy } : null;
        })
        .filter((move): move is { id: string; x: number; y: number } => move !== null);
      if (moves.length > 0) ops.push({ type: 'move', moves });
      const freed = new Set<string>();
      for (const id of set.roots) {
        const node = doc.nodes.get(id);
        const start = starts.get(id);
        if (!node || !start || node.kind === 'group') continue;
        const moved = translate(start, dx, dy);
        const center = { x: moved.x + moved.w / 2, y: moved.y + moved.h / 2 };
        let parentId = node.parentId;
        const dropGroup = dropGroupId ? doc.nodes.get(dropGroupId) : undefined;
        if (dropGroup && containsPoint(dropGroup, center)) parentId = dropGroup.id;
        else if (parentId !== null) {
          const parent = doc.nodes.get(parentId);
          if (!parent || !containsPoint(parent, center)) parentId = null;
        }
        if (parentId !== node.parentId) {
          /* dropped into another group (an auto-layout group re-lays itself out) or out of its group */
          ops.push({ type: 'patch', id, patch: { parentId } });
          continue;
        }
        /* the daemon owns child positions in auto-layout groups: moving a child inside its group switches the
           group to free layout in the same batch (04 §7.8 R5) */
        const container = parentId !== null ? doc.nodes.get(parentId) : undefined;
        if (container?.kind === 'group' && (container.data.layout === 'row' || container.data.layout === 'grid') && !freed.has(container.id)) {
          freed.add(container.id);
          ops.push({ type: 'patch', id: container.id, patch: { data: { layout: 'free' } } });
        }
      }
      if (ops.length > 0) void store.commit({ origin: 'local', label: 'move', ops });
    }
  }

  /* ── resize ───────────────────────────────────────────────────────────────────────────── */
  function startResize(event: PointerEvent, nodeId: string, handle: ResizeHandle): void {
    const node = state().doc.nodes.get(nodeId);
    if (!node || node.locked) return;
    const start: Rect = { x: node.x, y: node.y, w: node.w, h: node.h };
    const origin = { x: event.clientX, y: event.clientY };
    const min = minSizeFor(node);
    const lockedAspect = aspectLockedByDefault(node);
    const ratio = node.kind === 'image' || node.kind === 'video'
      ? (node.data.naturalWidth && node.data.naturalHeight ? node.data.naturalWidth / node.data.naturalHeight : undefined)
      : undefined;
    let started = false;
    let latest: Rect = start;
    store.setUi({ selection: [nodeId], selectedEdgeId: null });
    const batch = frameBatcher((ev) => {
      const zoom = camera.get().zoom;
      const delta = { x: (ev.clientX - origin.x) / zoom, y: (ev.clientY - origin.y) / zoom };
      const keepAspect = lockedAspect ? !ev.shiftKey : ev.shiftKey;
      let rect = resizeRect(start, handle, delta, { keepAspect, fromCenter: ev.altKey, min, ...(ratio ? { ratio } : {}) });
      let guides: readonly SnapGuide[] = [];
      if (!keepAspect && !ev.altKey) {
        const snapped = snapRect('resize', rect, neighbourRects(new Set([nodeId])), zoom, { handle, min });
        rect = { x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h };
        guides = snapped.guides;
      }
      latest = rect;
      store.setPreview({ rects: new Map([[nodeId, rect]]), guides, resize: { id: nodeId, w: Math.round(rect.w), h: Math.round(rect.h) } });
    });
    begin({
      pointerId: event.pointerId,
      move(ev) {
        if (!started) {
          if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < DRAG_THRESHOLD_PX) return;
          started = true;
          store.setUi({ interaction: 'resizing' });
          deps.noteInteraction();
        }
        batch.push(ev);
      },
      up(ev) {
        if (started) {
          batch.push(ev);
          batch.flush();
        }
        batch.stop();
        if (started) {
          const sizeChanged = Math.round(latest.w) !== node.w || Math.round(latest.h) !== node.h;
          const data = sizeChanged && (node.kind === 'frame' || node.kind === 'web') ? { device: 'custom' as const } : undefined;
          void store.commit({
            origin: 'local',
            label: 'resize',
            ops: [{ type: 'patch', id: nodeId, patch: { x: latest.x, y: latest.y, w: latest.w, h: latest.h, ...(data ? { data } : {}) } }],
          });
        }
        end();
        store.setPreview(null);
      },
      cancel() {
        batch.stop();
      },
    });
  }

  /* ── draw ─────────────────────────────────────────────────────────────────────────────── */
  function startDraw(event: PointerEvent, tool: BoardTool): void {
    const origin = toWorld(event);
    let moved = false;
    let latest: Rect = { x: origin.x, y: origin.y, w: 0, h: 0 };
    const batch = frameBatcher((ev) => {
      const current = toWorld(ev);
      let rect = rectFromPoints(origin, current);
      if (ev.shiftKey) {
        const side = Math.max(rect.w, rect.h);
        rect = {
          x: current.x < origin.x ? origin.x - side : origin.x,
          y: current.y < origin.y ? origin.y - side : origin.y,
          w: side,
          h: side,
        };
      } else {
        const snapped = snapRect('resize', { x: origin.x, y: origin.y, w: current.x - origin.x, h: current.y - origin.y }, neighbourRects(new Set()), camera.get().zoom, { handle: 'se', min: { w: 1, h: 1 } });
        if (current.x >= origin.x && current.y >= origin.y) rect = { x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h };
      }
      latest = rect;
      store.setPreview({ rects: new Map(), draw: { tool, rect } });
    });
    begin({
      pointerId: event.pointerId,
      move(ev) {
        if (!moved) {
          if (Math.hypot(ev.clientX - event.clientX, ev.clientY - event.clientY) < DRAG_THRESHOLD_PX) return;
          moved = true;
          store.setUi({ interaction: 'drawing', selection: [], mode: null });
        }
        batch.push(ev);
      },
      up(ev) {
        if (moved) {
          batch.push(ev);
          batch.flush();
        }
        batch.stop();
        end();
        store.setPreview(null);
        const rect = moved && latest.w >= 4 && latest.h >= 4 ? latest : clickRectFor(tool, origin, deps.getEnv());
        void commands.createDrawnNode(tool, rect);
      },
      cancel() {
        batch.stop();
      },
    });
  }

  /* ── place ────────────────────────────────────────────────────────────────────────────── */
  function startPlace(event: PointerEvent, tool: 'note' | 'generate'): void {
    const origin = { x: event.clientX, y: event.clientY };
    const at = toWorld(event);
    begin({
      pointerId: event.pointerId,
      move() {},
      up(ev) {
        end();
        if (Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) > DRAG_THRESHOLD_PX * 4) return;
        commands.placeNode(tool, at);
      },
      cancel() {},
    });
  }

  /* ── connect ──────────────────────────────────────────────────────────────────────────── */
  function nodeAt(world: Point, exclude: string): EngineNode | null {
    const { doc } = state();
    for (let index = doc.order.length - 1; index >= 0; index -= 1) {
      const node = doc.nodes.get(doc.order[index]!);
      if (!node || node.hidden || node.id === exclude || node.kind === 'group') continue;
      if (containsPoint(node, world)) return node;
    }
    return null;
  }

  function startConnect(event: PointerEvent, from: string): void {
    const source = state().doc.nodes.get(from);
    if (!source || !isReferenceSource(source.kind)) return;
    let moved = false;
    let target: EngineNode | null = null;
    let point = toWorld(event);
    const batch = frameBatcher((ev) => {
      point = toWorld(ev);
      const hit = nodeAt(point, from);
      target = hit && hit.kind === 'generator' ? hit : null;
      store.setPreview({ rects: new Map(), connect: { from, point, ...(target ? { to: target.id } : {}) } });
    });
    begin({
      pointerId: event.pointerId,
      move(ev) {
        if (!moved) {
          if (Math.hypot(ev.clientX - event.clientX, ev.clientY - event.clientY) < DRAG_THRESHOLD_PX) return;
          moved = true;
          store.setUi({ interaction: 'connecting' });
        }
        batch.push(ev);
      },
      up(ev) {
        if (moved) {
          batch.push(ev);
          batch.flush();
        }
        batch.stop();
        end();
        store.setPreview(null);
        if (!moved) return;
        if (target) {
          commands.connect(from, target.id, 'reference');
          return;
        }
        if (!nodeAt(point, from)) {
          store.setUi({ connectMenu: { from, world: point, client: { x: ev.clientX, y: ev.clientY } } });
        }
      },
      cancel() {
        batch.stop();
      },
    });
  }

  /* ── entry points ─────────────────────────────────────────────────────────────────────── */
  function onPointerDown(event: PointerEvent): void {
    const resolved = resolvePointerTarget(event.target);
    if (resolved.kind === 'interactive') return;
    if (gesture) cancel();
    const s = state();
    const node = resolved.id && (resolved.kind === 'node' || resolved.kind === 'label') ? s.doc.nodes.get(resolved.id) : undefined;
    /* a press on a group's body is a press on the canvas (Figma sections); its label selects it */
    const groupBody = resolved.kind === 'node' && node?.kind === 'group';
    const target: BoardPointerTarget = groupBody ? 'background' : resolved.kind;
    const action = resolvePointerAction({
      tool: s.ui.tool,
      target,
      button: event.button,
      pointerType: event.pointerType,
      spaceHeld: s.ui.spaceHeld,
      locked: node?.locked === true,
      readOnly: s.readOnly,
    });
    if (action !== 'none') focusBoard();
    if (s.ui.contextTarget) store.setUi({ contextTarget: null });
    if (s.ui.connectMenu) store.setUi({ connectMenu: null });
    if (s.ui.renamingId && action !== 'none') store.setUi({ renamingId: null });
    switch (action) {
      case 'pan':
        event.preventDefault();
        startPan(event, target === 'background');
        return;
      case 'marquee':
        event.preventDefault();
        startMarquee(event);
        return;
      case 'node-drag':
        if (node) startNodeDrag(event, node.id);
        return;
      case 'select':
        /* Comment tool: the pressed node alone (a sole selected frame takes comment picks) */
        if (node && s.ui.tool === 'comment' && !s.readOnly) {
          store.setUi({ selection: [node.id], selectedEdgeId: null, mode: null });
          return;
        }
        if (node) {
          const toggle = event.shiftKey || (isMac() ? event.metaKey : event.ctrlKey);
          store.setUi({ selection: pressSelect(s.ui.selection, node.id, toggle), selectedEdgeId: null });
        }
        return;
      case 'resize':
        if (resolved.id && resolved.handle) {
          event.preventDefault();
          startResize(event, resolved.id, resolved.handle);
        }
        return;
      case 'draw':
        event.preventDefault();
        startDraw(event, s.ui.tool);
        return;
      case 'place':
        if (s.ui.tool === 'note' || s.ui.tool === 'generate') startPlace(event, s.ui.tool);
        return;
      case 'connect':
        if (resolved.id) {
          event.preventDefault();
          startConnect(event, resolved.id);
        }
        return;
      case 'edge-select':
        if (resolved.id) store.setUi({ selectedEdgeId: resolved.id, selection: [], mode: null });
        return;
      default:
        return;
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (gesture) return;
    const s = state();
    if (s.ui.interaction !== 'idle') return;
    const resolved = resolvePointerTarget(event.target);
    const id = resolved.kind === 'node' || resolved.kind === 'label' || resolved.kind === 'handle' || resolved.kind === 'connector'
      ? resolved.id ?? null
      : null;
    const hoverId = id && s.doc.nodes.get(id)?.kind !== 'group' ? id : null;
    if (hoverId !== s.ui.hoverId) store.setUi({ hoverId, hoverSince: hoverId ? now() : null });
  }

  function onPointerLeave(): void {
    if (state().ui.hoverId !== null) store.setUi({ hoverId: null, hoverSince: null });
  }

  function onDoubleClick(event: MouseEvent): void {
    const resolved = resolvePointerTarget(event.target);
    if (resolved.kind === 'interactive') return;
    if (resolved.kind === 'background') {
      /* a double-click on a group's body (canvas for the pointer) selects the group (03 §3.7) */
      const group = groupAt(toWorld(event));
      if (group) commands.select([group.id]);
      return;
    }
    if (!resolved.id) return;
    const s = state();
    const node = s.doc.nodes.get(resolved.id);
    if (!node) return;
    if (resolved.kind === 'label') {
      commands.startRename(node.id);
      return;
    }
    if (resolved.kind !== 'node') return;
    if (node.kind === 'group') {
      commands.select([node.id]);
      return;
    }
    if (node.kind === 'note' || node.kind === 'shape') {
      commands.startTextEdit(node.id);
      return;
    }
    commands.enterNode(node.id);
  }

  function onContextMenu(event: MouseEvent): void {
    const resolved = resolvePointerTarget(event.target);
    if (resolved.kind === 'interactive') return;
    event.preventDefault();
    const s = state();
    const world = toWorld(event);
    const client = { x: event.clientX, y: event.clientY };
    if (resolved.kind === 'edge' && resolved.id) {
      store.setUi({ selectedEdgeId: resolved.id, selection: [], contextTarget: { kind: 'edge', id: resolved.id, world, client } });
      return;
    }
    const nodeId = resolved.kind === 'node' || resolved.kind === 'label' || resolved.kind === 'handle' ? resolved.id : undefined;
    const node = nodeId ? s.doc.nodes.get(nodeId) : undefined;
    if (node && !(resolved.kind === 'node' && node.kind === 'group')) {
      const selection = s.ui.selection.includes(node.id) ? s.ui.selection : [node.id];
      store.setUi({ selection, selectedEdgeId: null, contextTarget: { kind: 'node', id: node.id, world, client } });
      return;
    }
    store.setUi({ contextTarget: { kind: 'background', world, client } });
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerLeave,
    onDoubleClick,
    onContextMenu,
    cancel,
    active: () => gesture !== null,
    dispose() {
      cancel();
    },
  };
}
