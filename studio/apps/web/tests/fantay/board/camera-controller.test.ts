// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';

import { screenToWorld, SETTLE_MS } from '../../../src/fantay/board/camera/camera';
import { createCameraController, gridPeriod, type CameraController } from '../../../src/fantay/board/camera/camera-controller';
import { BOARD_INTERACTIVE_ATTR } from '../../../src/fantay/board/extensions';
import { createFrameQueue, createManualTimers } from './engine-fixtures';

function setup(opts: { reducedMotion?: boolean; density?: boolean } = {}) {
  const frames = createFrameQueue();
  const timers = createManualTimers();
  const camera = createCameraController({
    now: timers.now,
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    reducedMotion: () => opts.reducedMotion === true,
    density: opts.density ?? true,
  });
  const root = document.createElement('div');
  const stage = document.createElement('div');
  const world = document.createElement('div');
  const grid = document.createElement('div');
  stage.append(grid, world);
  root.append(stage);
  document.body.append(root);
  camera.attach({ root, stage, world, grid });
  camera.setStageSize({ w: 1000, h: 800 });
  const detachInput = camera.attachInput(stage, {
    ignoreTarget: (target) => target instanceof Element && target.closest(`[${BOARD_INTERACTIVE_ATTR}]`) !== null,
  });
  return { camera, frames, timers, root, stage, world, grid, detachInput };
}

let active: CameraController | null = null;
afterEach(() => {
  active?.dispose();
  active = null;
  document.body.innerHTML = '';
});

function wheel(target: Element, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('CameraController', () => {
  it('writes the world transform and the camera variables straight to the DOM', () => {
    const { camera, root, world, grid } = setup();
    active = camera;
    camera.set({ x: 120, y: -60, zoom: 0.5 });
    expect(world.style.transform).toBe('translate(120px, -60px) scale(0.5)');
    expect(root.style.getPropertyValue('--zoom')).toBe('0.5');
    expect(root.style.getPropertyValue('--inv-zoom')).toBe('2');
    expect(root.style.getPropertyValue('--vx')).toBe('120px');
    expect(root.style.getPropertyValue('--vy')).toBe('-60px');
    const { period } = gridPeriod(0.5);
    expect(grid.style.backgroundSize).toBe(`${period}px ${period}px`);
  });

  it('grid period quadruples while denser than 12 screen px (at most twice)', () => {
    expect(gridPeriod(1).period).toBe(24);
    expect(gridPeriod(0.25).period).toBe(24);
    expect(gridPeriod(0.1).period).toBeCloseTo(38.4, 6);
    expect(gridPeriod(0.01).period).toBeCloseTo(3.84, 6);
    expect(gridPeriod(0.01).opacity).toBe(0);
  });

  it('settles 250 ms after the last change (249 no, 250 yes) and applies the layout zoom then', () => {
    const { camera, timers, world } = setup({ density: true });
    active = camera;
    const settles: Array<{ zoom: number; k: number }> = [];
    camera.onSettle((cam, k) => settles.push({ zoom: cam.zoom, k }));
    camera.set({ x: 0, y: 0, zoom: 1.5 });
    timers.advance(SETTLE_MS - 1);
    expect(settles).toEqual([]);
    expect(camera.layoutZoom()).toBe(1);
    timers.advance(1);
    expect(settles).toEqual([{ zoom: 1.5, k: 2 }]);
    expect(camera.layoutZoom()).toBe(2);
    expect(world.style.transform).toBe('translate(0px, 0px) scale(0.75)');
    // every change restarts the window
    camera.set({ x: 1, y: 0, zoom: 1.5 });
    timers.advance(200);
    camera.set({ x: 2, y: 0, zoom: 1.5 });
    timers.advance(200);
    expect(settles).toHaveLength(1);
    timers.advance(50);
    expect(settles).toHaveLength(2);
  });

  it('accumulates wheel deltas and flushes once per animation frame', () => {
    const { camera, frames, stage } = setup();
    active = camera;
    const changes: number[] = [];
    camera.subscribe((cam) => changes.push(cam.x));
    const first = wheel(stage, { deltaX: 10, deltaY: 0 });
    wheel(stage, { deltaX: 15, deltaY: 0 });
    wheel(stage, { deltaX: 5, deltaY: 20 });
    expect(first.defaultPrevented).toBe(true);
    expect(changes).toEqual([]);
    frames.flush();
    expect(changes).toHaveLength(1);
    expect(camera.get()).toEqual({ x: -30, y: -20, zoom: 1 });
  });

  it('ctrl/⌘ + wheel zooms about the pointer (clamped per event)', () => {
    const { camera, frames, stage } = setup();
    active = camera;
    camera.set({ x: 50, y: 40, zoom: 1 });
    const pivot = { x: 300, y: 200 };
    const before = screenToWorld(camera.get(), pivot);
    wheel(stage, { deltaY: -500, ctrlKey: true, clientX: pivot.x, clientY: pivot.y });
    frames.flush();
    const cam = camera.get();
    expect(cam.zoom).toBeCloseTo(Math.exp(0.4), 9); // clamp(-500) → -40 → exp(40 × 0.01)
    const after = screenToWorld(cam, pivot);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('shift + vertical wheel pans horizontally', () => {
    const { camera, frames, stage } = setup();
    active = camera;
    wheel(stage, { deltaY: 30, shiftKey: true });
    frames.flush();
    expect(camera.get()).toEqual({ x: -30, y: 0, zoom: 1 });
  });

  it('leaves wheel events inside data-board-interactive regions alone (R6)', () => {
    const { camera, frames, stage } = setup();
    active = camera;
    const panel = document.createElement('div');
    panel.setAttribute(BOARD_INTERACTIVE_ATTR, '');
    const inner = document.createElement('span');
    panel.append(inner);
    stage.append(panel);
    const event = wheel(inner, { deltaY: 40 });
    frames.flush();
    expect(event.defaultPrevented).toBe(false);
    expect(camera.get()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('flyTo eases to the exact target over frames', () => {
    const { camera, frames, timers } = setup();
    active = camera;
    camera.flyTo({ x: 400, y: -200, zoom: 2 }, { durationMs: 600 });
    expect(camera.isFlying()).toBe(true);
    timers.advance(300);
    frames.flush(1);
    const mid = camera.get();
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(400);
    timers.advance(400);
    frames.flush();
    expect(camera.get()).toEqual({ x: 400, y: -200, zoom: 2 });
    expect(camera.isFlying()).toBe(false);
  });

  it('reduced motion jumps immediately', () => {
    const { camera } = setup({ reducedMotion: true });
    active = camera;
    camera.flyTo({ x: 10, y: 20, zoom: 3 });
    expect(camera.get()).toEqual({ x: 10, y: 20, zoom: 3 });
    expect(camera.isFlying()).toBe(false);
  });

  it('user input cancels a flight and stamps lastUserInputAt', () => {
    const { camera, frames, timers } = setup();
    active = camera;
    const users: number[] = [];
    camera.onUserInput(() => users.push(timers.now()));
    camera.flyTo({ x: 500, y: 500, zoom: 1 }, { durationMs: 600 });
    timers.advance(100);
    frames.flush(1);
    camera.panBy(5, 5, 'user');
    expect(camera.isFlying()).toBe(false);
    expect(users).toHaveLength(1);
    expect(camera.lastUserInputAt()).toBe(timers.now());
    const stopped = camera.get();
    timers.advance(600);
    frames.flush();
    expect(camera.get()).toEqual(stopped);
  });

  it('fitRect animates only when asked', () => {
    const { camera } = setup();
    active = camera;
    camera.fitRect({ x: 0, y: 0, w: 2000, h: 1000 });
    expect(camera.get().zoom).toBeLessThan(1);
    expect(camera.isFlying()).toBe(false);
  });
});
