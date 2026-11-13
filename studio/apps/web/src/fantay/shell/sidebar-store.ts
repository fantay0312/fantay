// SPDX-License-Identifier: AGPL-3.0-only
// Sidebar persistence and reveal requests (spec 02 §11.4). localStorage keys:
//   fantay.shell.sidebar.collapsed        '1' | '0'
//   fantay.shell.sidebar.sections         JSON { [sectionId]: true }   (true = section collapsed)
//   fantay.shell.sidebar.expandedProjects JSON string[] (most recently used first, max 30)
// Every storage access is wrapped: private windows and locked-down webviews keep working for the session.
import { useSyncExternalStore } from 'react';

export type FantaySidebarSectionId = 'pinned' | 'projects' | `group:${string}`;

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'fantay.shell.sidebar.collapsed';
export const SIDEBAR_SECTIONS_STORAGE_KEY = 'fantay.shell.sidebar.sections';
export const SIDEBAR_EXPANDED_PROJECTS_STORAGE_KEY = 'fantay.shell.sidebar.expandedProjects';
export const SIDEBAR_EXPANDED_PROJECTS_LIMIT = 30;

function isSectionId(key: string): key is FantaySidebarSectionId {
  return key === 'pinned' || key === 'projects' || key.startsWith('group:');
}

export interface SidebarRevealRequest {
  section: FantaySidebarSectionId;
  /** Changes per request, so asking twice for the same section reveals twice. */
  nonce: number;
}

export interface SidebarStoreState {
  readonly collapsedSections: Readonly<Partial<Record<FantaySidebarSectionId, true>>>;
  readonly expandedProjects: readonly string[];
  readonly reveal: SidebarRevealRequest | null;
}

const SERVER_STATE: SidebarStoreState = Object.freeze({
  collapsedSections: Object.freeze({}),
  expandedProjects: Object.freeze([]) as readonly string[],
  reveal: null,
});

let state: SidebarStoreState | null = null;
let revealNonce = 0;
const listeners = new Set<() => void>();

function readStorage(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the choice still applies for this session.
  }
}

function readSections(): SidebarStoreState['collapsedSections'] {
  const raw = readStorage(SIDEBAR_SECTIONS_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const sections: Partial<Record<FantaySidebarSectionId, true>> = {};
    for (const [id, folded] of Object.entries(parsed)) {
      if (folded === true && isSectionId(id)) sections[id] = true;
    }
    return sections;
  } catch {
    return {};
  }
}

function readExpandedProjects(): readonly string[] {
  const raw = readStorage(SIDEBAR_EXPANDED_PROJECTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'string' && entry && !ids.includes(entry)) ids.push(entry);
      if (ids.length >= SIDEBAR_EXPANDED_PROJECTS_LIMIT) break;
    }
    return ids;
  } catch {
    return [];
  }
}

function current(): SidebarStoreState {
  if (state === null) {
    state = Object.freeze({ collapsedSections: readSections(), expandedProjects: readExpandedProjects(), reveal: null });
  }
  return state;
}

function update(patch: Partial<SidebarStoreState>): void {
  state = Object.freeze({ ...current(), ...patch });
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getServerState(): SidebarStoreState {
  return SERVER_STATE;
}

/** The stored rail choice (`'1'` collapsed, `'0'` expanded), or null when none was stored. */
export function readStoredSidebarCollapsed(): boolean | null {
  const raw = readStorage(SIDEBAR_COLLAPSED_STORAGE_KEY);
  if (raw === '1') return true;
  if (raw === '0') return false;
  return null;
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  writeStorage(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
}

export function isSidebarSectionCollapsed(section: FantaySidebarSectionId): boolean {
  return current().collapsedSections[section] === true;
}

export function setSidebarSectionCollapsed(section: FantaySidebarSectionId, collapsed: boolean): void {
  const previous = current().collapsedSections;
  if ((previous[section] === true) === collapsed) return;
  const next: Partial<Record<FantaySidebarSectionId, true>> = { ...previous };
  if (collapsed) next[section] = true;
  else delete next[section];
  writeStorage(SIDEBAR_SECTIONS_STORAGE_KEY, JSON.stringify(next));
  update({ collapsedSections: Object.freeze(next) });
}

export function toggleSidebarSection(section: FantaySidebarSectionId): void {
  setSidebarSectionCollapsed(section, !isSidebarSectionCollapsed(section));
}

export function expandSidebarSection(section: FantaySidebarSectionId): void {
  setSidebarSectionCollapsed(section, false);
}

export function isSidebarProjectExpanded(projectId: string): boolean {
  return current().expandedProjects.includes(projectId);
}

/** Expanding moves the project to the front (most recently used); the list keeps at most 30 ids. */
export function setSidebarProjectExpanded(projectId: string, expanded: boolean): void {
  const previous = current().expandedProjects;
  const without = previous.filter((id) => id !== projectId);
  const next = expanded ? [projectId, ...without].slice(0, SIDEBAR_EXPANDED_PROJECTS_LIMIT) : without;
  if (next.length === previous.length && next.every((id, index) => id === previous[index])) return;
  writeStorage(SIDEBAR_EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify(next));
  update({ expandedProjects: Object.freeze(next) });
}

export function toggleSidebarProjectExpanded(projectId: string): void {
  setSidebarProjectExpanded(projectId, !isSidebarProjectExpanded(projectId));
}

/** Asks the expanded sidebar to scroll a section into view and flash its caption (07 `sidebar.focus`). */
export function requestSidebarReveal(section: FantaySidebarSectionId): void {
  revealNonce += 1;
  update({ reveal: { section, nonce: revealNonce } });
}

/** Clears a reveal request once the sidebar acted on it (a later remount must not replay it). */
export function acknowledgeSidebarReveal(nonce: number): void {
  if (current().reveal?.nonce !== nonce) return;
  update({ reveal: null });
}

export function getSidebarStoreState(): SidebarStoreState {
  return current();
}

export function useSidebarStore(): SidebarStoreState {
  return useSyncExternalStore(subscribe, current, getServerState);
}

/** Forgets the in-memory state; the next read reloads it from storage. */
export function resetSidebarStoreForTests(): void {
  state = null;
  revealNonce = 0;
  for (const listener of [...listeners]) listener();
}
