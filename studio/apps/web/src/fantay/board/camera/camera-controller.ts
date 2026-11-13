/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/Stage.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the store-free DOM writer (L184-232),
 *   settle → layout zoom (L236-249), fly-to (L353-371), wheel flush per animation frame (L504-558) and touch
 *   pinch (L565-624) as one framework-free controller with injected clocks; Safari gesture events, the
 *   `wheelZooms` preference, frozen/ignored targets (R6 `data-board-interactive`), the adaptive dot grid and
 *   reduced motion are Fantay additions (spec 03 §3.2).
 */
import {
  clampZoom,
  easeInOutCubic,
  fitRect as fitRectCamera,
  FLY_MS,
  interpolateCamera,
  isTrackpadWheel,
  LAYOUT_ZOOM_MAX,
  MAX_ZOOM,
  MIN_ZOOM,
  mouseWheelZoomDelta,
  sameCamera,
  SETTLE_MS,
  TRACKPAD_GESTURE_MS,
  WHEEL_DELTA_CLAMP,
  WHEEL_ZOOM_K,
  worldTransform,
  zoomAt,
  type Camera,
  type FitOptions,
} from './camera';
import { layoutZoomFor } from './layout-zoom';
import type { Point, Rect, Size } from '../model/types';

export interface CameraElements {
  /** carries the --zoom/--inv-zoom/--vx/--vy/--lz variables (screen-space labels and overlays read them) */
  root: HTMLElement;
  stage: HTMLElement;
  world: HTMLElement;
  grid?: HTMLElement | null;
}

export interface CameraInputOptions {
  /** true for targets that keep their own wheel/pinch handling (R6 `data-board-interactive`). */
  ignoreTarget?(target: EventTarget | null): boolean;
  /** user preference: the plain mouse wheel zooms; trackpad scrolling keeps panning */
  wheelZooms?(): boolean;
  /** wheel and pinch are ignored (capture markup freezes the camera) */
  frozen?(): boolean;
}

export type CameraChangeReason = 'user' | 'program';

export interface CameraController {
  get(): Camera;
  /** 'user' stamps lastUserInputAt, notifies user-input listeners and cancels a running flight. */
  set(next: Camera, reason?: CameraChangeReason): void;
  panBy(dx: number, dy: number, reason?: CameraChangeReason): void;
  /** pivot default = stage centre */
  zoomTo(zoom: number, pivot?: Point, reason?: CameraChangeReason): void;
  zoomBy(factor: number, pivot?: Point, reason?: CameraChangeReason): void;
  /** reduced motion → set() immediately */
  flyTo(target: Camera, opts?: { durationMs?: number }): void;
  fitRect(rect: Rect, opts?: FitOptions & { animate?: boolean }): void;
  cancelFlight(): void;
  isFlying(): boolean;
  stageSize(): Size;
  /** Overrides the measured stage size (tests, hosts without layout). */
  setStageSize(size: Size): void;
  /** Re-reads the stage element size. */
  measure(): void;
  lastUserInputAt(): number;
  /** The settled layout zoom k the world is laid out at. */
  layoutZoom(): number;
  /** true while a two-finger pinch owns the camera */
  isPinching(): boolean;
  /** Every camera change (non-React consumers write the DOM). */
  subscribe(listener: (cam: Camera) => void): () => void;
  /** 250 ms after the last change: layout zoom applied, then listeners. */
  onSettle(listener: (cam: Camera, layoutZoom: number) => void): () => void;
  onUserInput(listener: () => void): () => void;
  onResize(listener: (size: Size) => void): () => void;
  attach(els: CameraElements): () => void;
  attachInput(stage: HTMLElement, opts?: CameraInputOptions): () => void;
  /** The attached elements (null before attach). */
  elements(): CameraElements | null;
  dispose(): void;
}

export interface CameraControllerOptions {
  initial?: Camera;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (id: number) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  reducedMotion?: () => boolean;
  /** FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY override (tests) */
  density?: boolean;
  layoutZoomMax?: number;
  settleMs?: number;
  minZoom?: number;
  maxZoom?: number;
}

function defaultRequestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => callback());
  return setTimeout(callback, 16) as unknown as number;
}

function defaultCancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

function defaultReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Dot-grid period: 24 world px, multiplied by 4 (at most twice) while it is denser than 12 screen px. */
export function gridPeriod(zoom: number): { period: number; opacity: number } {
  let period = 24 * zoom;
  for (let step = 0; step < 2 && period < 12; step += 1) period *= 4;
  return { period, opacity: Math.min(1, Math.max(0, (period - 6) / 6)) };
}

interface GestureLikeEvent extends Event {
  scale?: number;
  clientX?: number;
  clientY?: number;
}

export function createCameraController(options: CameraControllerOptions = {}): CameraController {
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const reducedMotion = options.reducedMotion ?? defaultReducedMotion;
  const settleMs = options.settleMs ?? SETTLE_MS;
  const layoutMax = options.layoutZoomMax ?? LAYOUT_ZOOM_MAX;
  const minZoom = options.minZoom ?? MIN_ZOOM;
  const maxZoom = options.maxZoom ?? MAX_ZOOM;

  let cam: Camera = options.initial ? { ...options.initial, zoom: clampZoom(options.initial.zoom, minZoom, maxZoom) } : { x: 0, y: 0, zoom: 1 };
  let layoutZoom = 1;
  let els: CameraElements | null = null;
  let size: Size = { w: 0, h: 0 };
  let sizeOverride: Size | null = null;
  let settleTimer: unknown = null;
  let flightFrame: number | null = null;
  let lastUser = Number.NEGATIVE_INFINITY;
  let pinching = false;
  let disposed = false;

  const changeListeners = new Set<(cam: Camera) => void>();
  const settleListeners = new Set<(cam: Camera, layoutZoom: number) => void>();
  const userListeners = new Set<() => void>();
  const resizeListeners = new Set<(size: Size) => void>();
  const cleanups = new Set<() => void>();

  function writeVars(root: HTMLElement): void {
    root.style.setProperty('--zoom', String(cam.zoom));
    root.style.setProperty('--inv-zoom', String(1 / cam.zoom));
    root.style.setProperty('--vx', `${cam.x}px`);
    root.style.setProperty('--vy', `${cam.y}px`);
    root.style.setProperty('--lz', String(layoutZoom));
  }

  /* Camera → DOM without React: no component subscribes to the camera, so pan/zoom never renders anything. */
  function apply(): void {
    if (!els) return;
    els.world.style.transform = worldTransform(cam, layoutZoom);
    writeVars(els.root);
    const grid = els.grid;
    if (grid) {
      const { period, opacity } = gridPeriod(cam.zoom);
      grid.style.backgroundSize = `${period}px ${period}px`;
      /* one period of overhang: the layer slides back by up to a period */
      grid.style.width = `calc(100% + ${period}px)`;
      grid.style.height = `calc(100% + ${period}px)`;
      const gx = (((cam.x % period) + period) % period) - period;
      const gy = (((cam.y % period) + period) % period) - period;
      grid.style.transform = `translate(${gx}px, ${gy}px)`;
      grid.style.opacity = String(opacity);
    }
  }

  function applyLayoutZoom(next: number): void {
    layoutZoom = next;
    if (!els) return;
    const world = els.world;
    /* a new zoom recomputes every length inside the world: transitions are off for this one change */
    world.dataset.rezoom = '';
    world.style.setProperty('zoom', String(next));
    world.style.transform = worldTransform(cam, next);
    void world.offsetWidth;
    delete world.dataset.rezoom;
    writeVars(els.root);
  }

  function settle(): void {
    settleTimer = null;
    if (disposed) return;
    const next = layoutZoomFor(cam.zoom, layoutMax, options.density);
    if (next !== layoutZoom) applyLayoutZoom(next);
    for (const listener of [...settleListeners]) listener(cam, layoutZoom);
  }

  function scheduleSettle(): void {
    if (settleTimer !== null) clearTimer(settleTimer);
    settleTimer = setTimer(settle, settleMs);
  }

  function cancelFlight(): void {
    if (flightFrame !== null) {
      cancelFrame(flightFrame);
      flightFrame = null;
    }
  }

  function noteUser(): void {
    lastUser = now();
    cancelFlight();
    for (const listener of [...userListeners]) listener();
  }

  function set(next: Camera, reason: CameraChangeReason = 'program'): void {
    if (disposed) return;
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y) || !Number.isFinite(next.zoom)) return;
    if (reason === 'user') noteUser();
    const target: Camera = { x: next.x, y: next.y, zoom: clampZoom(next.zoom, minZoom, maxZoom) };
    if (sameCamera(cam, target)) return;
    cam = target;
    apply();
    for (const listener of [...changeListeners]) listener(cam);
    scheduleSettle();
  }

  function stageSize(): Size {
    return sizeOverride ?? size;
  }

  function center(): Point {
    const s = stageSize();
    return { x: s.w / 2, y: s.h / 2 };
  }

  function emitResize(): void {
    const s = stageSize();
    for (const listener of [...resizeListeners]) listener(s);
  }

  function measure(): void {
    if (!els) return;
    const next = { w: els.stage.clientWidth, h: els.stage.clientHeight };
    if (next.w === size.w && next.h === size.h) return;
    size = next;
    if (!sizeOverride) emitResize();
  }

  function flyTo(target: Camera, opts: { durationMs?: number } = {}): void {
    cancelFlight();
    const duration = opts.durationMs ?? FLY_MS;
    if (reducedMotion() || duration <= 0) {
      set(target, 'program');
      return;
    }
    const from = cam;
    const end: Camera = { ...target, zoom: clampZoom(target.zoom, minZoom, maxZoom) };
    const start = now();
    const step = (): void => {
      flightFrame = null;
      const t = Math.min(1, (now() - start) / duration);
      set(interpolateCamera(from, end, easeInOutCubic(t)), 'program');
      if (t < 1 && !disposed) flightFrame = requestFrame(step);
    };
    flightFrame = requestFrame(step);
  }

  function attachInput(stage: HTMLElement, opts: CameraInputOptions = {}): () => void {
    let frame: number | null = null;
    let panX = 0;
    let panY = 0;
    let zoomDelta = 0;
    let pivot: Point = { x: 0, y: 0 };
    let trackpadUntil = Number.NEGATIVE_INFINITY;

    const ignored = (target: EventTarget | null): boolean => opts.ignoreTarget?.(target) === true;
    const frozen = (): boolean => opts.frozen?.() === true;

    function localPoint(clientX: number, clientY: number): Point {
      const rect = stage.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function flush(): void {
      frame = null;
      let next = cam;
      if (zoomDelta !== 0) {
        /* exp(-deltaY/100) is the browser's own pinch↔wheel mapping */
        const factor = Math.exp(-zoomDelta * WHEEL_ZOOM_K);
        next = zoomAt(next, next.zoom * factor, pivot);
        zoomDelta = 0;
      }
      next = { x: next.x - panX, y: next.y - panY, zoom: next.zoom };
      panX = 0;
      panY = 0;
      set(next, 'user');
    }

    function onWheel(event: WheelEvent): void {
      /* overlays with their own scrollbar (generator panel, menus, editors) scroll instead of panning */
      if (ignored(event.target)) return;
      event.preventDefault();
      if (frozen()) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight || 800 : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      if (isTrackpadWheel(event)) trackpadUntil = now() + TRACKPAD_GESTURE_MS;
      if (event.ctrlKey || event.metaKey) {
        pivot = localPoint(event.clientX, event.clientY);
        zoomDelta += Math.max(-WHEEL_DELTA_CLAMP, Math.min(WHEEL_DELTA_CLAMP, dy));
      } else if (opts.wheelZooms?.() === true && !event.shiftKey && now() >= trackpadUntil) {
        pivot = localPoint(event.clientX, event.clientY);
        zoomDelta += mouseWheelZoomDelta(dy);
      } else if (event.shiftKey && dx === 0) {
        panX += dy;
      } else {
        panX += dx;
        panY += dy;
      }
      if (frame === null) frame = requestFrame(flush);
    }

    /* Safari trackpad pinch sends gesture events instead of ctrl+wheel */
    let gestureStartZoom = 1;
    function onGestureStart(event: Event): void {
      const gesture = event as GestureLikeEvent;
      if (ignored(gesture.target)) return;
      event.preventDefault();
      gestureStartZoom = cam.zoom;
    }
    function onGestureChange(event: Event): void {
      const gesture = event as GestureLikeEvent;
      if (ignored(gesture.target)) return;
      event.preventDefault();
      if (frozen() || typeof gesture.scale !== 'number') return;
      const at = typeof gesture.clientX === 'number' && typeof gesture.clientY === 'number'
        ? localPoint(gesture.clientX, gesture.clientY)
        : center();
      set(zoomAt(cam, gestureStartZoom * gesture.scale, at), 'user');
    }
    function onGestureEnd(event: Event): void {
      if (ignored(event.target)) return;
      event.preventDefault();
    }

    /* touch: a two-finger pinch zooms around the fingers' midpoint and pans with it */
    let prev: { dist: number; x: number; y: number } | null = null;
    function pinchOf(touches: TouchList): { dist: number; x: number; y: number } | null {
      const a = touches[0];
      const b = touches[1];
      if (!a || !b) return null;
      const mid = localPoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      return { dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY), x: mid.x, y: mid.y };
    }
    function onTouchStart(event: TouchEvent): void {
      if (event.touches.length < 2 || ignored(event.target)) return;
      event.preventDefault();
      prev = pinchOf(event.touches);
      pinching = true;
    }
    function onTouchMove(event: TouchEvent): void {
      if (!prev || event.touches.length < 2) return;
      event.preventDefault();
      const cur = pinchOf(event.touches);
      if (!cur || frozen()) return;
      const zoom = clampZoom(cam.zoom * (cur.dist / Math.max(1, prev.dist)), minZoom, maxZoom);
      const scale = zoom / cam.zoom;
      /* the world point under the previous midpoint stays under the new one */
      set({ x: cur.x - (prev.x - cam.x) * scale, y: cur.y - (prev.y - cam.y) * scale, zoom }, 'user');
      prev = cur;
    }
    function onTouchEnd(event: TouchEvent): void {
      /* three fingers down and one lifts: measure the remaining pair afresh */
      if (event.touches.length >= 2) {
        prev = pinchOf(event.touches);
        return;
      }
      prev = null;
      pinching = false;
    }

    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('gesturestart', onGestureStart);
    stage.addEventListener('gesturechange', onGestureChange);
    stage.addEventListener('gestureend', onGestureEnd);
    stage.addEventListener('touchstart', onTouchStart, { passive: false });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    stage.addEventListener('touchend', onTouchEnd);
    stage.addEventListener('touchcancel', onTouchEnd);
    const detach = (): void => {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('gesturestart', onGestureStart);
      stage.removeEventListener('gesturechange', onGestureChange);
      stage.removeEventListener('gestureend', onGestureEnd);
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchmove', onTouchMove);
      stage.removeEventListener('touchend', onTouchEnd);
      stage.removeEventListener('touchcancel', onTouchEnd);
      if (frame !== null) cancelFrame(frame);
      frame = null;
      pinching = false;
      cleanups.delete(detach);
    };
    cleanups.add(detach);
    return detach;
  }

  function attach(next: CameraElements): () => void {
    els = next;
    measure();
    apply();
    if (layoutZoom !== 1) applyLayoutZoom(layoutZoom);
    let observer: ResizeObserver | null = null;
    const onWindowResize = (): void => measure();
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => measure());
      observer.observe(next.stage);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', onWindowResize);
    }
    const detach = (): void => {
      observer?.disconnect();
      if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
      if (els === next) els = null;
      cleanups.delete(detach);
    };
    cleanups.add(detach);
    return detach;
  }

  return {
    get: () => cam,
    set,
    panBy(dx, dy, reason = 'user') {
      set({ x: cam.x + dx, y: cam.y + dy, zoom: cam.zoom }, reason);
    },
    zoomTo(zoom, pivot, reason = 'user') {
      set(zoomAt(cam, clampZoom(zoom, minZoom, maxZoom), pivot ?? center()), reason);
    },
    zoomBy(factor, pivot, reason = 'user') {
      set(zoomAt(cam, clampZoom(cam.zoom * factor, minZoom, maxZoom), pivot ?? center()), reason);
    },
    flyTo,
    fitRect(rect, opts = {}) {
      const target = fitRectCamera(rect, stageSize(), opts);
      if (opts.animate) flyTo(target);
      else {
        cancelFlight();
        set(target, 'program');
      }
    },
    cancelFlight,
    isFlying: () => flightFrame !== null,
    stageSize,
    setStageSize(next) {
      sizeOverride = { w: next.w, h: next.h };
      emitResize();
    },
    measure,
    lastUserInputAt: () => lastUser,
    layoutZoom: () => layoutZoom,
    isPinching: () => pinching,
    subscribe(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onSettle(listener) {
      settleListeners.add(listener);
      return () => settleListeners.delete(listener);
    },
    onUserInput(listener) {
      userListeners.add(listener);
      return () => userListeners.delete(listener);
    },
    onResize(listener) {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },
    attach,
    attachInput,
    elements: () => els,
    dispose() {
      disposed = true;
      if (settleTimer !== null) clearTimer(settleTimer);
      settleTimer = null;
      cancelFlight();
      for (const cleanup of [...cleanups]) cleanup();
      changeListeners.clear();
      settleListeners.clear();
      userListeners.clear();
      resizeListeners.clear();
    },
  };
}
