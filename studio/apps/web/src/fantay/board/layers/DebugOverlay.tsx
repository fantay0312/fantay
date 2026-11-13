'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Developer diagnostic (spec 03 §6.6, `?boardDebug=1` only, numbers only, excluded from i18n): visible and live
// counts, layout zoom, zoom and the p95 frame time. Written to the DOM from subscriptions (no re-render on pan).
import { useEffect, useRef } from 'react';

import { useBoardEngine } from '../context';
import styles from './layers.module.css';

export function boardDebugEnabled(): boolean {
  try {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('boardDebug') === '1';
  } catch {
    return false;
  }
}

export function DebugOverlay() {
  const engine = useBoardEngine();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof requestAnimationFrame !== 'function') return undefined;
    const frames: number[] = [];
    let last = performance.now();
    let frame = 0;
    const tick = (time: number): void => {
      frames.push(time - last);
      last = time;
      if (frames.length > 120) frames.shift();
      const sorted = [...frames].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      const state = engine.store.getState();
      const cam = engine.camera.get();
      el.textContent = `vis ${state.visibleIds.length}  live ${state.liveIds.size}  k ${engine.camera.layoutZoom()}  zoom ${cam.zoom.toFixed(3)}  p95 ${p95.toFixed(1)}ms`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engine]);
  return <div ref={ref} className={styles.debug} aria-hidden data-testid="board-debug" />;
}
