// SPDX-License-Identifier: AGPL-3.0-only
// Lazy conversation lists for expanded sidebar projects (spec 02 §11.4). The open project's chats come live
// from the ProjectView bridge; every other expanded project reads `listConversations` (coalesced per project)
// into one module cache. Refresh: on expand when older than 30 s, on RUNS_CHANGED_EVENT (debounced 400 ms),
// when an expanded project's run status changes, and on window focus (debounced 1 s). No new endpoints and
// no new SSE connections.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { RUNS_CHANGED_EVENT } from '../../../providers/daemon';
import { listConversations } from '../../../state/projects';
import type { Conversation } from '../../../types';
import { workspaceAccountScopedCacheKey } from '../../../collab/workspace-identity';

export const SIDEBAR_CONVERSATIONS_STALE_MS = 30_000;
const RUNS_CHANGED_DEBOUNCE_MS = 400;
const FOCUS_DEBOUNCE_MS = 1_000;

export type SidebarConversationsStatus = 'loading' | 'ready' | 'error';

export interface SidebarConversationsEntry {
  readonly scope: string;
  readonly status: SidebarConversationsStatus;
  readonly conversations: readonly Conversation[];
  readonly fetchedAt: number;
}

const cache = new Map<string, SidebarConversationsEntry>();
const inFlight = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion(): number {
  return version;
}

function getServerVersion(): number {
  return 0;
}

const EMPTY_CONVERSATIONS: readonly Conversation[] = Object.freeze([]);

/** Fetches one project's conversations into the cache. Concurrent calls share the request. */
export function loadSidebarConversations(
  projectId: string,
  workspaceContext: WorkspaceCollabContext | null | undefined,
): Promise<void> {
  const scope = workspaceAccountScopedCacheKey(workspaceContext);
  const requestKey = `${scope}:${projectId}`;
  const pending = inFlight.get(requestKey);
  if (pending) return pending;
  const previous = getSidebarConversations(projectId, workspaceContext);
  const revision = revisions.get(projectId) ?? 0;
  if (!previous || previous.status === 'error') {
    cache.set(projectId, { scope, status: 'loading', conversations: previous?.conversations ?? EMPTY_CONVERSATIONS, fetchedAt: 0 });
    emit();
  }
  const request = listConversations(projectId, { throwOnError: true, workspaceContext: workspaceContext ?? null })
    .then((conversations) => {
      if (scope !== workspaceAccountScopedCacheKey(workspaceContext) || cache.get(projectId)?.scope !== scope) return;
      if (revision !== (revisions.get(projectId) ?? 0)) return;
      cache.set(projectId, { scope, status: 'ready', conversations, fetchedAt: Date.now() });
    })
    .catch(() => {
      if (cache.get(projectId)?.scope !== scope) return;
      if (revision !== (revisions.get(projectId) ?? 0)) return;
      const last = cache.get(projectId);
      // Keep a list we already have (a refresh failed); only an empty project shows the error state.
      if (last && last.status === 'ready' && last.conversations.length > 0) {
        cache.set(projectId, { ...last, fetchedAt: Date.now() });
      } else {
        cache.set(projectId, { scope, status: 'error', conversations: last?.conversations ?? EMPTY_CONVERSATIONS, fetchedAt: Date.now() });
      }
    })
    .finally(() => {
      inFlight.delete(requestKey);
      emit();
    });
  inFlight.set(requestKey, request);
  return request;
}

export function getSidebarConversations(projectId: string, context?: WorkspaceCollabContext | null): SidebarConversationsEntry | undefined {
  const entry = cache.get(projectId);
  return entry?.scope === workspaceAccountScopedCacheKey(context) ? entry : undefined;
}

/** Apply a successful mutation before an older list request can restore stale rows. */
export function reconcileSidebarConversation(projectId: string, id: string, conversation: Conversation | null): void {
  revisions.set(projectId, (revisions.get(projectId) ?? 0) + 1);
  const entry = cache.get(projectId);
  if (entry) {
    const conversations = entry.conversations.filter((item) => item.id !== id);
    if (conversation) conversations.push(conversation);
    cache.set(projectId, { ...entry, status: 'ready', conversations, fetchedAt: 0 });
  }
  emit();
}

function isStale(entry: SidebarConversationsEntry | undefined, now: number): boolean {
  if (!entry) return true;
  if (entry.status === 'loading') return false;
  return now - entry.fetchedAt > SIDEBAR_CONVERSATIONS_STALE_MS;
}

export interface UseSidebarConversationsOptions {
  workspaceContext?: WorkspaceCollabContext | null;
  /** Changes when an expanded project's run status changes (e.g. `id:status` joined); triggers a refresh. */
  statusKey?: string;
}

/** Cache entries for `projectIds` (absent = never loaded); loads the stale ones. */
export function useSidebarConversations(
  projectIds: readonly string[],
  options: UseSidebarConversationsOptions = {},
): ReadonlyMap<string, SidebarConversationsEntry> {
  const storeVersion = useSyncExternalStore(subscribe, getVersion, getServerVersion);
  const idsKey = projectIds.join('\u0000');
  const scope = workspaceAccountScopedCacheKey(options.workspaceContext);
  const contextRef = useRef(options.workspaceContext ?? null);
  contextRef.current = options.workspaceContext ?? null;
  const idsRef = useRef(projectIds);
  idsRef.current = projectIds;

  // Expand (or first mount): load what is missing or stale.
  useEffect(() => {
    const now = Date.now();
    for (const id of idsRef.current) {
      if (isStale(getSidebarConversations(id, contextRef.current), now)) void loadSidebarConversations(id, contextRef.current);
    }
  }, [idsKey, scope]);

  // A run status changed somewhere in the expanded set: refresh only the projects whose status changed.
  const statusKey = options.statusKey ?? '';
  const prevStatusesRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const nextMap = new Map<string, string>();
    if (statusKey) {
      for (const pair of statusKey.split('|')) {
        const colon = pair.indexOf(':');
        if (colon <= 0) continue;
        const id = pair.slice(0, colon);
        const status = pair.slice(colon + 1);
        nextMap.set(id, status);
      }
    }
    const prevMap = prevStatusesRef.current;
    prevStatusesRef.current = nextMap;
    for (const [id, status] of nextMap) {
      if (prevMap.has(id) && prevMap.get(id) !== status) {
        void loadSidebarConversations(id, contextRef.current);
      }
    }
  }, [statusKey]);

  // Run lifecycle elsewhere in the app, and returning to the window.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let runsTimer: ReturnType<typeof setTimeout> | null = null;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshAll = () => {
      for (const id of idsRef.current) void loadSidebarConversations(id, contextRef.current);
    };
    const onRunsChanged = () => {
      if (runsTimer !== null) clearTimeout(runsTimer);
      runsTimer = setTimeout(() => {
        runsTimer = null;
        refreshAll();
      }, RUNS_CHANGED_DEBOUNCE_MS);
    };
    const onFocus = () => {
      if (focusTimer !== null) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        focusTimer = null;
        refreshAll();
      }, FOCUS_DEBOUNCE_MS);
    };
    window.addEventListener(RUNS_CHANGED_EVENT, onRunsChanged);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener(RUNS_CHANGED_EVENT, onRunsChanged);
      window.removeEventListener('focus', onFocus);
      if (runsTimer !== null) clearTimeout(runsTimer);
      if (focusTimer !== null) clearTimeout(focusTimer);
    };
  }, []);

  return useMemo(() => {
    const result = new Map<string, SidebarConversationsEntry>();
    for (const id of idsKey ? idsKey.split('\u0000') : []) {
      const entry = getSidebarConversations(id, contextRef.current);
      if (entry) result.set(id, entry);
    }
    return result;
    // storeVersion is the cache's change counter: rebuild only when it moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, storeVersion, scope]);
}

export function resetSidebarConversationsForTests(): void {
  cache.clear();
  inFlight.clear();
  revisions.clear();
  emit();
}
