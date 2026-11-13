// SPDX-License-Identifier: AGPL-3.0-only
// Materials drawer open/width state (spec 07 §7.1). Entry points: the shell's 素材库 row, the board "+"
// menu and the legacy `/materials` redirect call `openMaterialsDrawer()`; `MaterialsDrawerHost` renders
// the drawer from `useMaterialsDrawer()`. Width persists in localStorage (320–520 px, default 360).
import { useMemo, useSyncExternalStore } from 'react';

export const MATERIALS_DRAWER_WIDTH_STORAGE_KEY = 'fantay:materials-drawer:width';
export const MATERIALS_DRAWER_MIN_WIDTH = 320;
export const MATERIALS_DRAWER_MAX_WIDTH = 520;
export const MATERIALS_DRAWER_DEFAULT_WIDTH = 360;

export interface MaterialsDrawerState { open: boolean; width: number }
export interface MaterialsDrawerController extends MaterialsDrawerState { setWidth(width: number): void }

const SERVER_STATE: MaterialsDrawerState = Object.freeze({ open: false, width: MATERIALS_DRAWER_DEFAULT_WIDTH });

let state: MaterialsDrawerState | null = null; // loaded lazily on the client (storage may be unavailable)
const listeners = new Set<() => void>();

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return MATERIALS_DRAWER_DEFAULT_WIDTH;
  return Math.min(MATERIALS_DRAWER_MAX_WIDTH, Math.max(MATERIALS_DRAWER_MIN_WIDTH, Math.round(width)));
}

function readStoredWidth(): number {
  try {
    if (typeof window === 'undefined') return MATERIALS_DRAWER_DEFAULT_WIDTH;
    const raw = window.localStorage.getItem(MATERIALS_DRAWER_WIDTH_STORAGE_KEY);
    if (raw === null || raw.trim() === '') return MATERIALS_DRAWER_DEFAULT_WIDTH;
    return clampWidth(Number(raw));
  } catch {
    return MATERIALS_DRAWER_DEFAULT_WIDTH;
  }
}

function currentState(): MaterialsDrawerState {
  if (state === null) state = Object.freeze({ open: false, width: readStoredWidth() });
  return state;
}

function update(patch: Partial<MaterialsDrawerState>): void {
  const previous = currentState();
  const next = { ...previous, ...patch };
  if (next.open === previous.open && next.width === previous.width) return;
  state = Object.freeze(next);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getServerState(): MaterialsDrawerState {
  return SERVER_STATE;
}

export function openMaterialsDrawer(): void {
  update({ open: true });
}

export function closeMaterialsDrawer(): void {
  update({ open: false });
}

export function toggleMaterialsDrawer(): void {
  update({ open: !currentState().open });
}

/** Clamps to 320–520 px, persists (storage failures ignored) and notifies. */
export function setMaterialsDrawerWidth(width: number): void {
  const next = clampWidth(width);
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(MATERIALS_DRAWER_WIDTH_STORAGE_KEY, String(next));
  } catch {
    // Private mode or blocked storage: the width still applies for this session.
  }
  update({ width: next });
}

/** Non-hook read of the drawer state. */
export function getMaterialsDrawerState(): MaterialsDrawerState {
  return currentState();
}

export function useMaterialsDrawer(): MaterialsDrawerController {
  const snapshot = useSyncExternalStore(subscribe, currentState, getServerState);
  return useMemo(
    () => ({ open: snapshot.open, width: snapshot.width, setWidth: setMaterialsDrawerWidth }),
    [snapshot],
  );
}

/** Forgets the in-memory state; the next read reloads the stored width. */
export function resetMaterialsDrawerForTests(): void {
  state = null;
  for (const listener of [...listeners]) listener();
}
