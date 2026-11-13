// SPDX-License-Identifier: AGPL-3.0-only
// Accessible scrub slider (spec 07 §3.1) for the board node footer and the editor style stage.
// A 24px hit area around a 4px track with a 10px thumb (palmier-pro values, clean-room). Pointer
// drags capture the pointer; ←/→ step, Shift+←/→ jump, PageUp/PageDown 10%, Home/End the ends.
import { useCallback, useRef, type KeyboardEvent, type PointerEvent } from 'react';

import { cn } from '../ui';
import styles from './Scrubber.module.css';

export interface ScrubberProps {
  value: number;
  max: number;
  onChange: (value: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: (value: number) => void;
  /** Accessible name, e.g. t('motion.preview.position'). */
  ariaLabel: string;
  /** e.g. t('motion.node.timeValue', { current, total }). */
  valueText?: string;
  /** Arrow step in seconds (default 0.1); Shift+arrow uses `largeStep` (default 1). */
  step?: number;
  largeStep?: number;
  disabled?: boolean;
  className?: string;
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.max(0, max), value));
}

export function Scrubber({
  value,
  max,
  onChange,
  onScrubStart,
  onScrubEnd,
  ariaLabel,
  valueText,
  step = 0.1,
  largeStep = 1,
  disabled = false,
  className,
}: ScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const safeMax = max > 0 ? max : 0;
  const current = clamp(value, safeMax);
  const ratio = safeMax > 0 ? current / safeMax : 0;

  const valueAt = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || !(rect.width > 0)) return current;
      return clamp(((clientX - rect.left) / rect.width) * safeMax, safeMax);
    },
    [current, safeMax],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    dragging.current = true;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is a convenience; dragging still works without it.
    }
    event.currentTarget.focus();
    onScrubStart?.();
    onChange(valueAt(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    onChange(valueAt(event.clientX));
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    const next = valueAt(event.clientX);
    onChange(next);
    onScrubEnd?.(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const jump = event.shiftKey ? largeStep : step;
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + jump;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - jump;
    else if (event.key === 'PageUp') next = current + safeMax / 10;
    else if (event.key === 'PageDown') next = current - safeMax / 10;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = safeMax;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.round(clamp(next, safeMax) * 1000) / 1000;
    onChange(clamped);
    onScrubEnd?.(clamped);
  };

  return (
    <div
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={Math.round(safeMax * 1000) / 1000}
      aria-valuenow={Math.round(current * 1000) / 1000}
      aria-valuetext={valueText}
      aria-disabled={disabled ? true : undefined}
      aria-orientation="horizontal"
      data-testid="motion-scrubber"
      className={cn(styles.root, className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
    >
      <div ref={trackRef} className={styles.track}>
        <div className={styles.fill} style={{ width: `${ratio * 100}%` }} />
        <div className={styles.thumb} style={{ left: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}
