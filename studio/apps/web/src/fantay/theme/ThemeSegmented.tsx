// fx-governance-allow-raw: custom dot-matrix canvas theme switch radio buttons
'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay-original: luminous dot-matrix two-button appearance switch — 深色 (Moon) / 浅色 (Sun),
 * defaulting to 浅色 (light). Mounted in the shell's account menu (R18), /fantay-ui gallery, and PaLab.
 */
import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';

import { useT } from '../../i18n';
import { cn } from '../ui/cn';
import {
  THUMB,
  TRACK,
  clamp,
  createSwitchPhysics,
  renderDotMatrixSwitch,
  stepSwitchPhysics,
  syncCommittedPhysics,
  type DotMatrixSwitchPhysics,
} from './dot-matrix-switch';
import { useTheme, type ThemePreference } from './theme';
import styles from './ThemeSegmented.module.css';

export interface ThemeSegmentedProps {
  /** xs 85×44 (the account menu, level with its balance tile) · sm 92×48 · md 112×58 (default). */
  size?: 'xs' | 'sm' | 'md';
  /** Aligns to the trailing edge when placed inside a wide row container. */
  fill?: boolean;
  className?: string;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function ThemeSegmented({ size = 'md', fill = false, className }: ThemeSegmentedProps) {
  const t = useT();
  const { preference, setPreference } = useTheme();
  const activeTheme: ThemePreference = preference === 'dark' ? 'dark' : 'light';

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const darkBtnRef = useRef<HTMLButtonElement | null>(null);
  const lightBtnRef = useRef<HTMLButtonElement | null>(null);

  const physicsRef = useRef<DotMatrixSwitchPhysics | null>(null);
  if (physicsRef.current === null) {
    physicsRef.current = createSwitchPhysics(activeTheme === 'light');
  }

  const activeThemeRef = useRef<ThemePreference>(activeTheme);
  activeThemeRef.current = activeTheme;
  const setPreferenceRef = useRef(setPreference);
  setPreferenceRef.current = setPreference;

  const [canvasReady, setCanvasReady] = useState(false);
  const [dragging, setDragging] = useState(false);

  const pointerDownRef = useRef(false);
  const dragStartSceneXRef = useRef(0);
  const dragStartPRef = useRef(0);
  const dragMovedRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const wakeLoopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const rootEl = rootRef.current;
    const canvas = canvasRef.current;
    if (!rootEl || !canvas) return;

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    setCanvasReady(true);

    let rafId = 0;
    let lastTime = 0;
    let canvasW = 0;
    let canvasH = 0;
    let dpr = 1;

    const syncCanvasSize = (): void => {
      const rect = canvas.getBoundingClientRect();
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const nextW = Math.max(1, Math.round(rect.width * nextDpr));
      const nextH = Math.max(1, Math.round(rect.height * nextDpr));
      if (nextW !== canvasW || nextH !== canvasH || nextDpr !== dpr) {
        canvasW = nextW;
        canvasH = nextH;
        dpr = nextDpr;
        canvas.width = nextW;
        canvas.height = nextH;
      }
    };

    const drawOnce = (): void => {
      syncCanvasSize();
      renderDotMatrixSwitch(ctx, canvasW, canvasH, dpr, physicsRef.current!);
    };

    const tick = (now: number): void => {
      rafId = 0;
      const dt = lastTime > 0 ? (now - lastTime) * 0.001 : 1 / 60;
      lastTime = now;
      const moving = stepSwitchPhysics(physicsRef.current!, dt, prefersReducedMotion());
      drawOnce();
      if (moving) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        lastTime = 0;
      }
    };

    const wake = (): void => {
      if (prefersReducedMotion() && !physicsRef.current!.isDragging) {
        stepSwitchPhysics(physicsRef.current!, 0, true);
        drawOnce();
        return;
      }
      if (rafId === 0) {
        lastTime = 0;
        rafId = window.requestAnimationFrame(tick);
      }
    };

    wakeLoopRef.current = wake;
    drawOnce();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => {
        drawOnce();
      });
      ro.observe(rootEl);
    }

    return () => {
      wakeLoopRef.current = null;
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, []);

  useEffect(() => {
    syncCommittedPhysics(physicsRef.current!, activeTheme === 'light', prefersReducedMotion());
    wakeLoopRef.current?.();
  }, [activeTheme]);

  const toSceneCoords = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = rootRef.current?.getBoundingClientRect();
    const w = rect?.width || 1;
    const h = rect?.height || 1;
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    return {
      x: TRACK.x + ((clientX - left) / w) * TRACK.w,
      y: TRACK.y + ((clientY - top) / h) * TRACK.h,
    };
  };

  const selectTheme = (next: ThemePreference): void => {
    if (next !== activeThemeRef.current) {
      setPreferenceRef.current(next);
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const physics = physicsRef.current!;
    const pt = toSceneCoords(event.clientX, event.clientY);
    physics.pointerX = pt.x;
    physics.pointerY = pt.y;
    physics.pointerInside = true;
    pointerDownRef.current = true;
    dragMovedRef.current = false;
    dragStartSceneXRef.current = pt.x;
    dragStartPRef.current = physics.p;
    wakeLoopRef.current?.();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const physics = physicsRef.current!;
    const pt = toSceneCoords(event.clientX, event.clientY);
    physics.pointerX = pt.x;
    physics.pointerY = pt.y;
    physics.pointerInside = true;

    if (pointerDownRef.current) {
      const dxScene = pt.x - dragStartSceneXRef.current;
      if (!dragMovedRef.current && Math.abs(dxScene) > 16) {
        dragMovedRef.current = true;
        physics.isDragging = true;
        setDragging(true);
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic pointer events in tests may not have an active pointerId.
        }
      }
      if (physics.isDragging) {
        const travel = THUMB.xLight - THUMB.xDark;
        physics.targetP = clamp(dragStartPRef.current + dxScene / travel, 0, 1);
      }
    }
    wakeLoopRef.current?.();
  };

  const finishPointerInteraction = (event: React.PointerEvent<HTMLDivElement>): void => {
    const physics = physicsRef.current!;
    if (!pointerDownRef.current) return;
    pointerDownRef.current = false;
    const wasDragging = physics.isDragging || dragMovedRef.current;
    physics.isDragging = false;
    setDragging(false);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore synthetic events.
    }

    if (wasDragging) {
      suppressClickUntilRef.current = performance.now() + 80;
      dragMovedRef.current = false;
      const projected = physics.p + physics.vp * 0.09;
      const nextTheme: ThemePreference = projected >= 0.5 ? 'light' : 'dark';
      physics.targetP = nextTheme === 'light' ? 1 : 0;
      selectTheme(nextTheme);
      wakeLoopRef.current?.();
    }
  };

  const handlePointerLeave = (): void => {
    const physics = physicsRef.current!;
    physics.pointerInside = false;
    if (!physics.isDragging) wakeLoopRef.current?.();
  };

  const handleSlotClick = (target: ThemePreference): void => {
    if (performance.now() < suppressClickUntilRef.current) return;
    selectTheme(target);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'ArrowDown'
    ) {
      return;
    }
    event.preventDefault();
    const next: ThemePreference = activeTheme === 'dark' ? 'light' : 'dark';
    selectTheme(next);
    const targetBtn = next === 'dark' ? darkBtnRef.current : lightBtnRef.current;
    targetBtn?.focus();
  };

  const darkLabel = t('fantay.theme.dark');
  const lightLabel = t('fantay.theme.light');

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={t('fantay.theme.label')}
      data-testid="fx-theme-segmented"
      data-slot="theme-segmented"
      data-size={size}
      data-theme-state={activeTheme}
      data-canvas-ready={canvasReady ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      className={cn(styles.root, fill && styles.fill, className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerInteraction}
      onPointerCancel={finishPointerInteraction}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <button
        ref={darkBtnRef}
        type="button"
        role="radio"
        aria-checked={activeTheme === 'dark'}
        aria-label={darkLabel}
        title={darkLabel}
        tabIndex={activeTheme === 'dark' ? 0 : -1}
        className={styles.slot}
        onClick={() => handleSlotClick('dark')}
      />
      <button
        ref={lightBtnRef}
        type="button"
        role="radio"
        aria-checked={activeTheme === 'light'}
        aria-label={lightLabel}
        title={lightLabel}
        tabIndex={activeTheme === 'light' ? 0 : -1}
        className={styles.slot}
        onClick={() => handleSlotClick('light')}
      />
    </div>
  );
}
