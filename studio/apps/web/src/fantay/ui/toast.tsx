'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/toast.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (the pill and its action)
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: a Fantay-original toast store
 *   (toast/dismissToast/useToasts, auto-dismiss timers that pause on hover and focus), a Toaster
 *   viewport (max 3, portaled), tones, busy state, localized labels, Fantay tokens.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';

import { useT } from '../../i18n';
import { cn } from './cn';
import { Dot } from './dot';
import { FX } from './fx';
import { IconButton } from './icon-button';
import { XIcon } from './icons';
import { Spinner } from './spinner';

export type ToastTone = 'default' | 'success' | 'danger';

export interface ToastOptions {
  /** Same id replaces the existing toast (and restarts its timer). */
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  tone?: ToastTone;
  action?: { label: string; onClick(): void };
  busy?: boolean;
  /** ms, default 4000; 0 = sticky until dismissed. */
  duration?: number;
}

export interface ToastRecord
  extends Required<Pick<ToastOptions, 'id' | 'title' | 'tone' | 'duration'>>,
    Omit<ToastOptions, 'id' | 'title' | 'tone' | 'duration'> {
  createdAt: number;
}

export const DEFAULT_TOAST_DURATION = 4000;
export const MAX_VISIBLE_TOASTS = 3;

/* ── store (module scope: one queue per page) ───────────────────────────────────────────── */

interface TimerState {
  handle: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
}

const EMPTY: readonly ToastRecord[] = Object.freeze([]);
let records: readonly ToastRecord[] = EMPTY;
const timers = new Map<string, TimerState>();
const listeners = new Set<() => void>();
let paused = false;
let sequence = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer?.handle != null) clearTimeout(timer.handle);
  timers.delete(id);
}

function runTimer(id: string, timer: TimerState): void {
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => dismissToast(id), timer.remaining);
}

function startTimer(id: string, duration: number): void {
  clearTimer(id);
  if (duration <= 0) return;
  const timer: TimerState = { handle: null, remaining: duration, startedAt: 0 };
  timers.set(id, timer);
  if (!paused) runTimer(id, timer);
}

/** Shows a toast and returns its id. */
export function toast(options: ToastOptions): string {
  sequence += 1;
  const id = options.id ?? `fx-toast-${sequence}`;
  const record: ToastRecord = {
    ...options,
    id,
    title: options.title,
    tone: options.tone ?? 'default',
    duration: options.duration ?? DEFAULT_TOAST_DURATION,
    createdAt: Date.now(),
  };
  const existing = records.findIndex((entry) => entry.id === id);
  records = existing === -1 ? [...records, record] : records.map((entry, index) => (index === existing ? record : entry));
  startTimer(id, record.duration);
  emit();
  return id;
}

export function dismissToast(id: string): void {
  clearTimer(id);
  if (!records.some((entry) => entry.id === id)) return;
  records = records.filter((entry) => entry.id !== id);
  emit();
}

/** Freezes every auto-dismiss timer (the pointer or focus is on the toasts). */
export function pauseToasts(): void {
  if (paused) return;
  paused = true;
  const now = Date.now();
  for (const timer of timers.values()) {
    if (timer.handle == null) continue;
    clearTimeout(timer.handle);
    timer.handle = null;
    timer.remaining = Math.max(0, timer.remaining - (now - timer.startedAt));
  }
}

export function resumeToasts(): void {
  if (!paused) return;
  paused = false;
  for (const [id, timer] of timers) {
    if (timer.handle == null) runTimer(id, timer);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly ToastRecord[] {
  return records;
}

function getServerSnapshot(): readonly ToastRecord[] {
  return EMPTY;
}

export function useToasts(): readonly ToastRecord[] {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Test helper: empties the queue and clears every timer. */
export function __resetToastsForTests(): void {
  for (const id of [...timers.keys()]) clearTimer(id);
  records = EMPTY;
  paused = false;
  sequence = 0;
  emit();
}

/* ── view ──────────────────────────────────────────────────────────────────────────────── */

/** The inverted button inside a toast ("Reload"). */
export const ToastAction = React.forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<'button'>>(function ToastAction(
  { className, type, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      data-slot="toast-action"
      className={cn(
        'flex-none cursor-pointer rounded-row border-0 border-solid border-transparent bg-paper px-2.5 py-1 font-ui text-body font-medium leading-4 text-ink transform-none transition-opacity duration-micro ease-out-quint hover:opacity-90 focus-ring',
        className,
      )}
      {...props}
    />
  );
});

export interface ToastProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'title'> {
  record: ToastRecord;
  onDismiss?: () => void;
}

/** The dark pill that confirms something happened. */
export function Toast({ record, onDismiss, className, ...props }: ToastProps) {
  const t = useT();
  const { tone, busy, title, description, action } = record;
  return (
    <div
      data-slot="toast"
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-live={tone === 'danger' ? 'assertive' : 'polite'}
      className={cn(
        'pointer-events-auto flex min-h-10 max-w-[min(420px,calc(100vw-40px))] items-center gap-3 rounded-pill bg-ink px-4 py-2.5 font-ui text-body font-medium leading-4 text-paper shadow-pop animate-fx-chip-in',
        className,
      )}
      {...props}
    >
      {busy ? <Spinner size="sm" /> : tone === 'success' ? <Dot tone="done" /> : tone === 'danger' ? <Dot tone="failed" /> : null}
      <div className="min-w-0 flex-1">
        <div data-slot="toast-title">{title}</div>
        {description ? (
          <div data-slot="toast-description" className="mt-0.5 text-caption font-normal text-paper/75">
            {description}
          </div>
        ) : null}
      </div>
      {action ? (
        <ToastAction
          onClick={() => {
            action.onClick();
            dismissToast(record.id);
          }}
        >
          {action.label}
        </ToastAction>
      ) : null}
      <IconButton
        size="xs"
        aria-label={t('fantay.ui.dismiss')}
        tooltip={false}
        className="-me-2 text-paper/70 not-data-disabled:hover:bg-paper/15 not-data-disabled:hover:text-paper"
        onClick={() => (onDismiss ? onDismiss() : dismissToast(record.id))}
      >
        <XIcon />
      </IconButton>
    </div>
  );
}

/** The one toast viewport (mounted by the shell and the gallery): portaled to the body, at most
 *  three visible, timers paused while the pointer or focus is on it. */
export function Toaster({ className }: { className?: string }) {
  const t = useT();
  const toasts = useToasts();
  const [mounted, setMounted] = React.useState(false);
  const regionRef = React.useRef<HTMLDivElement | null>(null);
  /* Paused while the pointer or keyboard focus is on the toasts; running again only when neither is. */
  const presence = React.useRef({ pointer: false, focus: false });
  const settle = React.useCallback(() => {
    if (presence.current.pointer || presence.current.focus) pauseToasts();
    else resumeToasts();
  }, []);
  React.useEffect(() => {
    setMounted(true);
    return () => resumeToasts();
  }, []);
  /* A toast dismissed from the keyboard takes its focused button with it, and that blur never
     reaches the region: re-check where focus is whenever the list changes. */
  React.useEffect(() => {
    if (!presence.current.focus || regionRef.current?.contains(document.activeElement)) return;
    presence.current.focus = false;
    settle();
  }, [toasts, settle]);
  if (!mounted || typeof document === 'undefined') return null;
  const visible = toasts.slice(-MAX_VISIBLE_TOASTS);
  return createPortal(
    <div
      ref={regionRef}
      data-slot="toaster"
      role="region"
      aria-label={t('fantay.ui.notifications')}
      className={cn(FX, 'pointer-events-none fixed bottom-5 end-5 z-(--z-fx-toast) flex flex-col items-end gap-2', className)}
      onPointerEnter={() => {
        presence.current.pointer = true;
        settle();
      }}
      onPointerLeave={() => {
        presence.current.pointer = false;
        settle();
      }}
      onFocus={() => {
        presence.current.focus = true;
        settle();
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        presence.current.focus = false;
        settle();
      }}
    >
      {visible.map((record) => (
        <Toast key={record.id} record={record} />
      ))}
    </div>,
    document.body,
  );
}
