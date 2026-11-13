// Data hooks shared by the Materials view and the composer's material picker:
// the library summary, a debounced value, and a paged search that appends
// batches as the grid scrolls (no pagination UI — the owner wants the grid to
// keep going as you scroll).

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type {
  MaterialSearchResponse,
  MaterialSummaryItem,
  MaterialSummaryResponse,
} from '@open-design/contracts';
import {
  fetchMaterialSummary,
  isAbortError,
  searchMaterials,
} from '../../providers/materials';
import { MATERIAL_PAGE_SIZE, appendMaterialPage } from './material-model';

export type MaterialLoadPhase = 'idle' | 'loading' | 'ready' | 'error';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface MaterialSummaryState {
  phase: MaterialLoadPhase;
  summary: MaterialSummaryResponse | null;
  error: string | null;
  reload: () => void;
}

/** Loads `GET /api/materials/summary` once `enabled` first turns true. */
export function useMaterialSummary(enabled: boolean, libraryId = ''): MaterialSummaryState {
  const [phase, setPhase] = useState<MaterialLoadPhase>('idle');
  const [summary, setSummary] = useState<MaterialSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setPhase('loading');
    setError(null);
    fetchMaterialSummary({ signal: controller.signal, libraryId })
      .then((next) => {
        if (controller.signal.aborted) return;
        setSummary(next);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setError(errorMessage(err));
        setPhase('error');
      });
    return () => controller.abort();
  }, [enabled, nonce, libraryId]);

  useEffect(() => {
    const refresh = () => setNonce((n) => n + 1);
    window.addEventListener('material-libraries-changed', refresh);
    return () => window.removeEventListener('material-libraries-changed', refresh);
  }, []);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { phase, summary, error, reload };
}

/** `value`, delayed until it has been stable for `delayMs`. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (Object.is(value, debounced)) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, debounced, delayMs]);
  return debounced;
}

export interface MaterialSearchFilters {
  libraryId?: string;
  q: string;
  kind: string;
  category: string;
  section?: string;
}

export interface MaterialSearchState {
  phase: MaterialLoadPhase;
  items: MaterialSummaryItem[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** Error of the first page (whole grid) — null while fine. */
  error: string | null;
  /** Error of the last appended page; the loaded items stay on screen. */
  moreError: string | null;
  loadMore: () => void;
  retry: () => void;
}

interface SearchSnapshot {
  key: string;
  phase: MaterialLoadPhase;
  items: MaterialSummaryItem[];
  total: number;
  nextOffset: number | null;
  error: string | null;
}

const EMPTY_SNAPSHOT: SearchSnapshot = {
  key: '',
  phase: 'idle',
  items: [],
  total: 0,
  nextOffset: null,
  error: null,
};

function filtersKey(filters: MaterialSearchFilters): string {
  return JSON.stringify([
    filters.q.trim(),
    filters.kind,
    filters.category,
    filters.section ?? '',
    filters.libraryId ?? '',
  ]);
}

/**
 * Paged `GET /api/materials/items`. A filter change aborts whatever is in
 * flight and restarts at offset 0; `loadMore()` appends the next batch of
 * `pageSize` and is a no-op while a batch is loading or nothing is left.
 */
export function useMaterialSearch(
  filters: MaterialSearchFilters,
  options: { enabled: boolean; pageSize?: number },
): MaterialSearchState {
  const { enabled } = options;
  const pageSize = options.pageSize ?? MATERIAL_PAGE_SIZE;
  const key = filtersKey(filters);
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(EMPTY_SNAPSHOT);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const moreControllerRef = useRef<AbortController | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const loadingMoreRef = useRef(loadingMore);
  loadingMoreRef.current = loadingMore;

  useEffect(() => {
    const refresh = () => setNonce((n) => n + 1);
    window.addEventListener('material-libraries-changed', refresh);
    return () => window.removeEventListener('material-libraries-changed', refresh);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    moreControllerRef.current?.abort();
    moreControllerRef.current = null;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setMoreError(null);
    setSnapshot({ ...EMPTY_SNAPSHOT, key, phase: 'loading' });
    const current = filtersRef.current;
    searchMaterials(
      {
        q: current.q,
        ...(current.libraryId ? { libraryId: current.libraryId } : {}),
        ...(current.kind ? { kind: current.kind } : {}),
        ...(current.category ? { category: current.category } : {}),
        ...(current.section ? { section: current.section } : {}),
        limit: pageSize,
        offset: 0,
      },
      { signal: controller.signal },
    )
      .then((res: MaterialSearchResponse) => {
        if (controller.signal.aborted) return;
        setSnapshot({
          key,
          phase: 'ready',
          items: appendMaterialPage([], res.items ?? []),
          total: res.total ?? 0,
          nextOffset: res.nextOffset ?? null,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setSnapshot({ ...EMPTY_SNAPSHOT, key, phase: 'error', error: errorMessage(err) });
      });
    return () => controller.abort();
  }, [enabled, key, pageSize, nonce]);

  useEffect(() => () => moreControllerRef.current?.abort(), []);

  const loadMore = useCallback(() => {
    const current = snapshotRef.current;
    if (current.phase !== 'ready' || current.nextOffset === null) return;
    if (loadingMoreRef.current) return;
    const requestKey = current.key;
    const offset = current.nextOffset;
    const controller = new AbortController();
    moreControllerRef.current = controller;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    const f = filtersRef.current;
    searchMaterials(
      {
        q: f.q,
        ...(f.libraryId ? { libraryId: f.libraryId } : {}),
        ...(f.kind ? { kind: f.kind } : {}),
        ...(f.category ? { category: f.category } : {}),
        ...(f.section ? { section: f.section } : {}),
        limit: pageSize,
        offset,
      },
      { signal: controller.signal },
    )
      .then((res) => {
        if (controller.signal.aborted) return;
        setSnapshot((prev) => {
          if (prev.key !== requestKey) return prev;
          const items = appendMaterialPage(prev.items, res.items ?? []);
          // A page that adds nothing new would make the sentinel fire forever;
          // stop instead of looping on a daemon that repeats itself.
          const advanced = items.length > prev.items.length;
          return {
            ...prev,
            items,
            total: res.total ?? prev.total,
            nextOffset: advanced ? res.nextOffset ?? null : null,
          };
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setMoreError(errorMessage(err));
      })
      .finally(() => {
        if (moreControllerRef.current === controller) moreControllerRef.current = null;
        if (controller.signal.aborted) return;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [pageSize]);

  const retry = useCallback(() => {
    if (snapshotRef.current.phase === 'error') {
      setNonce((n) => n + 1);
      return;
    }
    setMoreError(null);
    loadMore();
  }, [loadMore]);

  // Until the effect for a new key runs, report "loading" rather than the old
  // key's results, so a filter change never flashes stale cards as current.
  const live = snapshot.key === key ? snapshot : { ...EMPTY_SNAPSHOT, key, phase: enabled ? 'loading' as const : 'idle' as const };

  return {
    phase: live.phase,
    items: live.items,
    total: live.total,
    hasMore: live.phase === 'ready' && live.nextOffset !== null,
    loadingMore: live.key === key ? loadingMore : false,
    error: live.error,
    moreError: live.key === key ? moreError : null,
    loadMore,
    retry,
  };
}

/**
 * Calls `onReach` whenever the sentinel element scrolls within `rootMargin` of
 * the scroll root. The observer is rebuilt on every `revision` change (pass the
 * loaded item count) so a sentinel that is STILL visible after a batch lands —
 * a tall window, a short batch — triggers the next batch instead of waiting for
 * an intersection change that never comes.
 */
export function useInfiniteSentinel(
  sentinelRef: RefObject<Element | null>,
  onReach: () => void,
  options: {
    enabled: boolean;
    revision: number;
    root?: RefObject<Element | null>;
    rootMargin?: string;
  },
): void {
  const { enabled, revision, root, rootMargin = '600px 0px' } = options;
  const onReachRef = useRef(onReach);
  onReachRef.current = onReach;

  useEffect(() => {
    if (!enabled) return;
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const scrollRoot = root?.current ?? nearestScrollRoot(node);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onReachRef.current();
      },
      { root: scrollRoot, rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, revision, root, rootMargin, sentinelRef]);
}

/**
 * The closest scrolling ancestor. A root of `null` (the viewport) would ignore
 * `rootMargin` for content clipped by an inner scroller such as the entry
 * shell's `.entry-main--scroll`, so batches would only load once the sentinel
 * is already on screen.
 */
function nearestScrollRoot(node: Element): Element | null {
  if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null;
  let current = node.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`)) return current;
    current = current.parentElement;
  }
  return null;
}
