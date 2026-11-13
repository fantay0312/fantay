'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/lib/theme.ts @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: `data-theme` attribute instead of the
 *   `.dark` class, system default under the `fantay:theme` key, transition guard while switching, theme-color
 *   meta, desktop host appearance sync, SSR-safe store (getServerSnapshot), feature-checked DOM access.
 *
 * Spec: 01-ui-foundation §3.6. The pre-hydration paint lives in ./init-script.ts and must agree with this file.
 */
import { useSyncExternalStore } from 'react';
import { getOpenDesignHost } from '@open-design/host';
import { FANTAY_THEME_STORAGE_KEY } from './init-script';

/** What a person asks for: light or dark. */
export type ThemePreference = 'dark' | 'light';
/** What the document is actually painted in. */
export type ResolvedTheme = 'dark' | 'light';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light';

const SWITCHING_ATTRIBUTE = 'data-theme-switching';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'dark' || value === 'light';
}

interface ThemeSnapshot {
  readonly preference: ThemePreference;
  readonly resolved: ResolvedTheme;
}

/** Server render / static export: the layout paints light before hydration. */
const SERVER_SNAPSHOT: ThemeSnapshot = Object.freeze({
  preference: DEFAULT_THEME_PREFERENCE,
  resolved: 'light',
});

/* The preference as set this session. Storage can be off limits (a locked-down webview, private
   browsing) and the switch must still work until the tab closes. */
let active: ThemePreference | null = null;
const subscribers = new Set<() => void>();
/* useSyncExternalStore wants the same object back until something changed. */
let snapshot: ThemeSnapshot | null = null;
let teardownListeners: (() => void) | null = null;
/* Each switch bumps this so an older frame callback cannot clear a newer switch's guard. */
let switchGeneration = 0;

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readStoredPreference(): ThemePreference | null {
  try {
    const stored = window.localStorage.getItem(FANTAY_THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Session cache → localStorage['fantay:theme'] → 'light'. */
export function getThemePreference(): ThemePreference {
  if (!hasWindow()) return DEFAULT_THEME_PREFERENCE;
  if (active === null) active = readStoredPreference() ?? DEFAULT_THEME_PREFERENCE;
  return active;
}

/** Fixed two-state preference resolves directly to 'dark' or 'light'. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'dark' ? 'dark' : 'light';
}

function afterTwoFrames(callback: () => void): void {
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => callback()));
    return;
  }
  window.setTimeout(callback, 32);
}

function syncThemeColorMeta(root: HTMLElement): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const paper = window.getComputedStyle(root).getPropertyValue('--paper').trim();
  if (paper) meta.setAttribute('content', paper);
}

function syncHostAppearance(preference: ThemePreference): void {
  try {
    // Desktop shell: native window appearance (vibrancy glass, title bar) follows the preference.
    getOpenDesignHost()?.appearance?.setTheme(preference);
  } catch {
    // Older host builds or a failing bridge must never block painting the document.
  }
}

function paint(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (!hasWindow()) return resolved;
  const root = document.documentElement;
  if (root.getAttribute('data-theme') !== resolved) {
    // motion.css suspends every transition while this attribute is present.
    root.setAttribute(SWITCHING_ATTRIBUTE, '');
    root.setAttribute('data-theme', resolved);
    const generation = ++switchGeneration;
    afterTwoFrames(() => {
      if (generation === switchGeneration) root.removeAttribute(SWITCHING_ATTRIBUTE);
    });
  }
  root.style.colorScheme = resolved;
  syncThemeColorMeta(root);
  syncHostAppearance(preference);
  return resolved;
}

function notify(): void {
  snapshot = null;
  for (const subscriber of [...subscribers]) subscriber();
}

/** Keeps the document in step with other tabs / the same-origin canvas iframe. */
function ensureListeners(): void {
  if (teardownListeners || !hasWindow()) return;
  const onStorage = (event: StorageEvent): void => {
    // key === null: storage was cleared.
    if (event.key !== null && event.key !== FANTAY_THEME_STORAGE_KEY) return;
    active = null;
    paint(getThemePreference());
    notify();
  };
  window.addEventListener('storage', onStorage);
  teardownListeners = () => {
    window.removeEventListener('storage', onStorage);
  };
}

/** Persist (best effort), paint, notify subscribers. */
export function setThemePreference(preference: ThemePreference): void {
  active = preference;
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(FANTAY_THEME_STORAGE_KEY, preference);
  } catch {
    // Nowhere to keep it — the choice still holds until the tab closes.
  }
  ensureListeners();
  paint(preference);
  notify();
}

/** Idempotent paint of the current preference (+ listeners). Called by src/state/appearance.ts. */
export function paintThemePreference(): ResolvedTheme {
  const preference = getThemePreference();
  ensureListeners();
  const resolved = paint(preference);
  if (snapshot && (snapshot.preference !== preference || snapshot.resolved !== resolved)) notify();
  return resolved;
}

function subscribe(subscriber: () => void): () => void {
  ensureListeners();
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

function getSnapshot(): ThemeSnapshot {
  if (!snapshot) {
    const preference = getThemePreference();
    snapshot = { preference, resolved: resolveTheme(preference) };
  }
  return snapshot;
}

function getServerSnapshot(): ThemeSnapshot {
  return SERVER_SNAPSHOT;
}

/** The preference, what it resolves to, and the setter. Re-renders on a switch, an OS change or another tab. */
export function useTheme(): {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(preference: ThemePreference): void;
} {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { preference: state.preference, resolved: state.resolved, setPreference: setThemePreference };
}

export function __resetThemeForTests(): void {
  teardownListeners?.();
  teardownListeners = null;
  active = null;
  snapshot = null;
  subscribers.clear();
  switchGeneration += 1;
}
