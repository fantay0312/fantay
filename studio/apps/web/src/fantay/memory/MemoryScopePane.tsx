// SPDX-License-Identifier: AGPL-3.0-only
// 记忆 scope pane: the selected place's name and who reads it (a bot also gets its two memory controls), a warm
// line when something waits for you, then three tabs — 记忆 (kind filter, search, the list), 对话片段 (the raw
// chat windows this scope can read) and 已归档 (archived, replaced and declined memories). Lists load per scope
// and tab, refresh quietly after a change, and keep what is on screen while they do.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Plus } from 'lucide-react';
import type {
  MemoryChunk,
  MemoryItem,
  MemoryItemListQuery,
  MemoryItemStatus,
  MemoryOverviewResponse,
  MemoryScopeKind,
  MemoryScopeNode,
  PaAutoMemoryMode,
  PaProfileMount,
} from '@open-design/contracts';
import { FantayMascotStill } from '../brand/FantayMascot';
import {
  Button,
  EmptyState,
  Icon,
  InputGroupClear,
  SearchField,
  Segmented,
  SegmentedItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
  toast,
} from '../ui';
import { MemoryApiError, isAbortError, memoryApi } from './api';
import { useMemoryLocale, useMemoryT, type MemoryPageKey, type MemoryT } from './i18n';
import {
  MEMORY_KIND_GROUPS,
  errorMessage,
  formatTimeRange,
  kindGroupLabel,
  nodeNeedsYou,
  parentProjectOf,
  readersSentence,
  scopeKeyOf,
  scopeKindLabel,
  scopeNodeLabel,
  type MemoryKindGroup,
} from './labels';
import { MemoryItemRow } from './MemoryItemRow';
import { ScopeFace, fantayBotId } from './MemoryNavigator';
import styles from './MemoryCenterView.module.css';

export type MemoryPaneTab = 'items' | 'chunks' | 'archived';

/** One scope's own filter: the kind family, what is typed, and what the list was asked for (250 ms behind). */
export interface ScopeFilter {
  group: MemoryKindGroup | 'all';
  draft: string;
  query: string;
}

export const EMPTY_SCOPE_FILTER: ScopeFilter = { group: 'all', draft: '', query: '' };

export interface AgentPolicyPatch {
  profileMount?: PaProfileMount;
  autoMemoryMode?: PaAutoMemoryMode;
}

const ITEM_PAGE = 50;
const CHUNK_PAGE = 20;
/** The most rows one quiet refresh asks for: the contract's `limit` cap of each list. */
const ITEM_REFRESH_MAX = 500;
const CHUNK_REFRESH_MAX = 200;
const AUTO_MODES: readonly PaAutoMemoryMode[] = ['off', 'candidate', 'explicit_auto'];
const ARCHIVED_STATUSES: readonly MemoryItemStatus[] = ['archived', 'superseded', 'rejected'];
const GROUP_IDS: ReadonlyArray<MemoryKindGroup | 'all'> = ['all', ...MEMORY_KIND_GROUPS.map((group) => group.id)];

const EMPTY_KEY: Record<MemoryScopeKind, MemoryPageKey> = {
  profile: 'memory.empty.profile',
  persona: 'memory.empty.persona',
  bot: 'memory.empty.bot',
  group: 'memory.empty.group',
  project: 'memory.empty.project',
  conversation: 'memory.empty.conversation',
};

/* ── paged lists ───────────────────────────────────────────────────────────────────────────── */

type PageFetcher<T> = (offset: number, limit: number, signal: AbortSignal) => Promise<{ rows: T[]; total: number }>;

interface PageSource<T> {
  offset: number;
  total: number;
  /** The last row this source has sent so far. */
  last: T | null;
}

interface PagedState<T> {
  key: string;
  status: 'idle' | 'loading' | 'ready' | 'error';
  rows: T[];
  sources: Array<PageSource<T>>;
  error: unknown;
  loadingMore: boolean;
}

/** Several sources (one per kind or state) merge into one list; a single source keeps the service's order. */
function mergeRows<T extends { id: string }>(lists: T[][], sort: ((a: T, b: T) => number) | undefined, single: boolean): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const list of lists) {
    for (const row of list) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }
  return single || !sort ? merged : merged.sort(sort);
}

/**
 * With several sources, a row is in its final place only when it sorts before the last row of every source
 * that has more to send; later rows wait for the next page. So the merged list reads like one list in one
 * order, and 加载更多 only ever adds at the bottom. `sort` must be the order each source pages in.
 */
function settledRows<T>(rows: T[], sources: ReadonlyArray<PageSource<T>>, sort: ((a: T, b: T) => number) | undefined): T[] {
  if (!sort || sources.length < 2) return rows;
  const bounds = sources.filter((source) => source.offset < source.total && source.last !== null).map((source) => source.last as T);
  if (bounds.length === 0) return rows;
  return rows.filter((row) => bounds.every((bound) => sort(row, bound) <= 0));
}

function pageSource<T>(rows: readonly T[], offset: number, total: number, previous: T | null = null): PageSource<T> {
  return { offset, total, last: rows.length > 0 ? rows[rows.length - 1]! : previous };
}

interface PagedList<T> {
  status: PagedState<T>['status'];
  rows: T[];
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): Promise<void>;
  retry(): void;
  patch(row: T): void;
  remove(id: string): void;
}

/**
 * Loads a list for one `key` while `enabled`. A new key shows the skeleton; the same key again (a `version`
 * bump after a change, or coming back to the tab) refreshes in place with as many rows as were showing, so
 * nothing jumps. A stale response is dropped by aborting the previous request.
 */
function usePagedList<T extends { id: string }>(
  key: string,
  fetchers: ReadonlyArray<PageFetcher<T>>,
  options: { enabled: boolean; version: number; pageSize: number; refreshMax: number; sort?: (a: T, b: T) => number },
): PagedList<T> {
  const { enabled, version, pageSize, refreshMax, sort } = options;
  const [state, setState] = useState<PagedState<T>>({
    key: '',
    status: 'idle',
    rows: [],
    sources: [],
    error: null,
    loadingMore: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const fetchersRef = useRef(fetchers);
  fetchersRef.current = fetchers;
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(
    (reset: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const current = stateRef.current;
      const keep = !reset && current.key === key && current.status === 'ready';
      const list = fetchersRef.current;
      const limits = list.map((_, index) =>
        keep ? Math.min(refreshMax, Math.max(pageSize, current.sources[index]?.offset ?? 0)) : pageSize,
      );
      if (!keep) setState({ key, status: 'loading', rows: [], sources: [], error: null, loadingMore: false });
      Promise.all(list.map((fetchPage, index) => fetchPage(0, limits[index] ?? pageSize, controller.signal))).then(
        (pages) => {
          if (controller.signal.aborted) return;
          setState({
            key,
            status: 'ready',
            rows: mergeRows(
              pages.map((page) => page.rows),
              sortRef.current,
              pages.length === 1,
            ),
            sources: pages.map((page) => pageSource(page.rows, page.rows.length, page.total)),
            error: null,
            loadingMore: false,
          });
        },
        (error: unknown) => {
          if (controller.signal.aborted || isAbortError(error)) return;
          // A quiet refresh that fails keeps what is on screen; a first load shows the error with a retry.
          if (keep) return;
          setState({ key, status: 'error', rows: [], sources: [], error, loadingMore: false });
        },
      );
    },
    [key, pageSize, refreshMax],
  );

  useEffect(() => {
    if (enabled) load(false);
  }, [enabled, version, load]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (current.status !== 'ready' || current.loadingMore) return;
    const pending = current.sources
      .map((source, index) => ({ source, index }))
      .filter(({ source }) => source.offset < source.total);
    if (pending.length === 0) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((s) => ({ ...s, loadingMore: true }));
    try {
      const pages = await Promise.all(
        pending.map(({ source, index }) => {
          const fetchPage = fetchersRef.current[index];
          if (!fetchPage) return Promise.resolve({ rows: [] as T[], total: source.offset });
          return fetchPage(source.offset, pageSize, controller.signal);
        }),
      );
      if (controller.signal.aborted) return;
      setState((s) => {
        if (s.key !== current.key) return s;
        const sources = s.sources.slice();
        const lists: T[][] = [s.rows];
        pending.forEach(({ index }, position) => {
          const page = pages[position];
          const source = sources[index];
          if (!page || !source) return;
          sources[index] = pageSource(page.rows, source.offset + page.rows.length, page.total, source.last);
          lists.push(page.rows);
        });
        return { ...s, rows: mergeRows(lists, sortRef.current, sources.length === 1), sources, loadingMore: false };
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      setState((s) => ({ ...s, loadingMore: false }));
      throw error;
    }
  }, [pageSize]);

  const retry = useCallback(() => load(true), [load]);
  const patch = useCallback((row: T) => setState((s) => ({ ...s, rows: s.rows.map((current) => (current.id === row.id ? row : current)) })), []);
  const remove = useCallback(
    (id: string) =>
      setState((s) => {
        if (!s.rows.some((row) => row.id === id)) return s;
        // With one source the service's next page now starts one row earlier; shift it so nothing is skipped.
        // Several sources cannot tell which one held the row; their next quiet refresh corrects the offsets.
        const sources =
          s.sources.length === 1
            ? s.sources.map((source) => ({ ...source, offset: Math.max(0, source.offset - 1), total: Math.max(0, source.total - 1) }))
            : s.sources;
        return { ...s, rows: s.rows.filter((row) => row.id !== id), sources };
      }),
    [],
  );

  const current = state.key === key ? state : null;
  return {
    status: current?.status ?? (enabled ? 'loading' : 'idle'),
    rows: current ? settledRows(current.rows, current.sources, sort) : [],
    error: current?.error ?? null,
    hasMore: Boolean(current?.sources.some((source) => source.offset < source.total)),
    loadingMore: current?.loadingMore ?? false,
    loadMore,
    retry,
    patch,
    remove,
  };
}

// The service's own order: ledger memories newest first, then the Settings entries (so 全部 and a kind family agree).
const ledgerThenNewest = (a: MemoryItem, b: MemoryItem) =>
  Number(a.backing === 'studio') - Number(b.backing === 'studio') || b.updatedAt - a.updatedAt;
const newestFirst = (a: MemoryItem, b: MemoryItem) => b.updatedAt - a.updatedAt;

/** Relative times ("3 分钟前") stay true while the page is open. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/* ── pane ──────────────────────────────────────────────────────────────────────────────────── */

export interface MemoryScopePaneProps {
  node: MemoryScopeNode;
  overview: MemoryOverviewResponse;
  tab: MemoryPaneTab;
  onTabChange(tab: MemoryPaneTab): void;
  filter: ScopeFilter;
  onGroupChange(group: MemoryKindGroup | 'all'): void;
  onSearchChange(text: string): void;
  onClearFilter(): void;
  /** Bumped after a change made in a dialog; every list of this pane refreshes in place. */
  dataVersion: number;
  onPolicyChange(node: MemoryScopeNode, patch: AgentPolicyPatch): void;
  onCreate(node: MemoryScopeNode): void;
  onOpenItem(item: MemoryItem): void;
  onEditItem(item: MemoryItem): void;
  onCopyItem(item: MemoryItem): void;
  onOpenConflict(conflictId: string): void;
  onOpenInbox(): void;
  /** A change made here: counts and the sidebar badge are read again. */
  onChanged(): void;
  onOpenProject?: ((projectId: string) => void) | undefined;
}

export function MemoryScopePane(props: MemoryScopePaneProps) {
  const { node, tab, onTabChange, filter, dataVersion, onChanged, onOpenItem, onEditItem, onCopyItem, onOpenConflict } = props;
  const t = useMemoryT();
  const locale = useMemoryLocale();
  const now = useMinuteClock();
  const { scope } = node;
  const scopeKey = scopeKeyOf(scope);
  const [localVersion, setLocalVersion] = useState(0);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const version = dataVersion + localVersion;

  const itemQueries = useMemo<MemoryItemListQuery[]>(() => {
    const query = filter.query.trim();
    const base: MemoryItemListQuery = { scopeKind: scope.kind, scopeId: scope.id, status: 'active', ...(query ? { query } : {}) };
    if (filter.group === 'all') return [base];
    const kinds = MEMORY_KIND_GROUPS.find((group) => group.id === filter.group)?.kinds ?? [];
    return kinds.map((kind) => ({ ...base, kind }));
  }, [scope.kind, scope.id, filter.group, filter.query]);

  const archivedQueries = useMemo<MemoryItemListQuery[]>(
    () => ARCHIVED_STATUSES.map((status) => ({ scopeKind: scope.kind, scopeId: scope.id, status })),
    [scope.kind, scope.id],
  );

  const itemFetchers = useMemo(() => itemQueries.map(listFetcher), [itemQueries]);
  const archivedFetchers = useMemo(() => archivedQueries.map(listFetcher), [archivedQueries]);
  const chunkFetchers = useMemo<Array<PageFetcher<MemoryChunk>>>(
    () => [
      (offset, limit, signal) =>
        memoryApi
          .listChunks({ scopeKind: scope.kind, scopeId: scope.id, offset, limit }, signal)
          .then((page) => ({ rows: page.chunks, total: page.total })),
    ],
    [scope.kind, scope.id],
  );

  const items = usePagedList(`items|${JSON.stringify(itemQueries)}`, itemFetchers, {
    enabled: tab === 'items',
    version,
    pageSize: ITEM_PAGE,
    refreshMax: ITEM_REFRESH_MAX,
    sort: ledgerThenNewest,
  });
  const archived = usePagedList(`archived|${scopeKey}`, archivedFetchers, {
    enabled: tab === 'archived',
    version,
    pageSize: ITEM_PAGE,
    refreshMax: ITEM_REFRESH_MAX,
    sort: newestFirst,
  });
  const chunks = usePagedList(`chunks|${scopeKey}`, chunkFetchers, {
    enabled: tab === 'chunks',
    version: dataVersion,
    pageSize: CHUNK_PAGE,
    refreshMax: CHUNK_REFRESH_MAX,
  });

  const setBusy = useCallback((id: string, busy: boolean) => {
    setBusyIds((current) => {
      if (current.has(id) === busy) return current;
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const failed = useCallback(
    (error: unknown) => {
      toast({ tone: 'danger', title: errorMessage(t, error) });
      // A stale revision means someone else changed it: show the current text instead of retrying blind.
      if (error instanceof MemoryApiError && error.status === 409) setLocalVersion((value) => value + 1);
    },
    [t],
  );

  const togglePin = useCallback(
    async (item: MemoryItem) => {
      setBusy(item.id, true);
      items.patch({ ...item, pinned: !item.pinned });
      try {
        const result = await memoryApi.updateItem(item.id, { pinned: !item.pinned, revision: item.revision });
        items.patch(result.item);
        onChanged();
      } catch (error) {
        items.patch(item);
        failed(error);
      } finally {
        setBusy(item.id, false);
      }
    },
    [items.patch, onChanged, failed, setBusy],
  );

  const restore = useCallback(
    async (item: MemoryItem) => {
      setBusy(item.id, true);
      try {
        await memoryApi.itemAction(item.id, { action: 'restore', revision: item.revision });
        archived.remove(item.id);
        setLocalVersion((value) => value + 1);
        onChanged();
        toast({ id: `memory-restored-${item.id}`, tone: 'success', title: t('memory.toast.restored') });
      } catch (error) {
        failed(error);
      } finally {
        setBusy(item.id, false);
      }
    },
    [archived.remove, onChanged, failed, setBusy, t],
  );

  const archive = useCallback(
    async (item: MemoryItem) => {
      setBusy(item.id, true);
      try {
        const result = await memoryApi.itemAction(item.id, { action: 'archive', revision: item.revision });
        items.remove(item.id);
        setLocalVersion((value) => value + 1);
        onChanged();
        // Same wording and id as archiving from the detail dialog, so the two never stack.
        toast({
          id: `memory-archived-${item.id}`,
          title: t('memory.toast.archived'),
          description: t('memory.toast.archivedBody'),
          action: { label: t('memory.toast.undo'), onClick: () => void restore(result.item) },
        });
      } catch (error) {
        failed(error);
      } finally {
        setBusy(item.id, false);
      }
    },
    [items.remove, onChanged, failed, restore, setBusy, t],
  );

  const rowHandlers = useMemo(
    () => ({
      onOpen: onOpenItem,
      onEdit: onEditItem,
      onTogglePin: (item: MemoryItem) => void togglePin(item),
      onCopy: onCopyItem,
      onHistory: onOpenItem,
      onArchive: (item: MemoryItem) => void archive(item),
      onRestore: (item: MemoryItem) => void restore(item),
      onOpenConflict,
    }),
    [onOpenItem, onEditItem, onCopyItem, onOpenConflict, togglePin, archive, restore],
  );

  const loadMore = (list: { loadMore(): Promise<void> }) => {
    list.loadMore().catch((error: unknown) => toast({ tone: 'danger', title: errorMessage(t, error) }));
  };

  const filtering = filter.group !== 'all' || filter.query.trim() !== '' || filter.draft.trim() !== '';
  const showControls = node.counts.active > 0 || filtering || items.rows.length > 0;

  return (
    <section className={styles.pane} aria-label={scopeNodeLabel(t, node)} data-testid="memory-scope-pane" data-scope={scopeKey}>
      <div key={scopeKey} className={styles.paneInner}>
        <ScopeHeader {...props} t={t} />
        {nodeNeedsYou(node) ? (
          <div className={styles.needsYou} data-testid="memory-scope-needs-you">
            <span className={styles.warmDot} aria-hidden />
            <span className={styles.needsYouText}>
              {[
                node.counts.pending > 0 ? t('memory.notice.pending', { count: node.counts.pending }) : null,
                node.counts.conflicts > 0 ? t('memory.notice.conflicts', { count: node.counts.conflicts }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <Button variant="bare" size="sm" className={styles.needsYouAction} onClick={props.onOpenInbox} data-testid="memory-scope-open-inbox">
              {t('memory.notice.open')}
            </Button>
          </div>
        ) : null}

        <Tabs value={tab} onValueChange={(value) => onTabChange(value as MemoryPaneTab)} className={styles.tabs}>
          <TabsList variant="line" size="md" className={styles.tabList} aria-label={t('memory.tabs.label')}>
            <TabsTrigger value="items" className={styles.tabTrigger} data-testid="memory-tab-items">
              {t('memory.tab.items')}
              <span className={styles.tabCount}>{node.counts.active}</span>
            </TabsTrigger>
            <TabsTrigger value="chunks" className={styles.tabTrigger} data-testid="memory-tab-chunks">
              {t('memory.tab.chunks')}
              <span className={styles.tabCount}>{node.counts.chunks}</span>
            </TabsTrigger>
            <TabsTrigger value="archived" className={styles.tabTrigger} data-testid="memory-tab-archived">
              {t('memory.tab.archived')}
              <span className={styles.tabCount}>{node.counts.archived}</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="items" className={styles.tabBody}>
            {showControls ? (
              <div className={styles.controls}>
                <Segmented
                  size="md"
                  className="flex w-full"
                  value={filter.group}
                  onValueChange={(value) => props.onGroupChange(value as MemoryKindGroup | 'all')}
                  aria-label={t('memory.filter.label')}
                >
                  {GROUP_IDS.map((id) => (
                    <SegmentedItem key={id} value={id} className={styles.segItem} data-testid={`memory-kind-${id}`}>
                      {kindGroupLabel(t, id)}
                    </SegmentedItem>
                  ))}
                </Segmented>
                <SearchField
                  className={styles.search}
                  value={filter.draft}
                  placeholder={t('memory.search')}
                  aria-label={t('memory.search')}
                  data-testid="memory-search"
                  onChange={(event) => props.onSearchChange(event.target.value)}
                  trailing={filter.draft ? <InputGroupClear onClear={() => props.onSearchChange('')} /> : null}
                />
              </div>
            ) : null}
            <ListBody
              list={items}
              t={t}
              empty={
                filtering ? (
                  <div className={styles.stateBlock} data-testid="memory-no-match">
                    <p className={styles.stateText}>{t('memory.noMatch')}</p>
                    <Button variant="ghost" size="sm" onClick={props.onClearFilter}>
                      {t('memory.clearFilter')}
                    </Button>
                  </div>
                ) : (
                  <EmptyState
                    variant="dashed"
                    className={styles.empty}
                    illustration={<FantayMascotStill size={48} />}
                    title={t('memory.empty.title')}
                    description={t(EMPTY_KEY[scope.kind], { name: scopeNodeLabel(t, node) })}
                    action={
                      <Button variant="primary" className="fx-page-action" onClick={() => props.onCreate(node)} data-testid="memory-empty-create">
                        <Icon icon={Plus} size="sm" />
                        {t('memory.page.new')}
                      </Button>
                    }
                    data-testid="memory-empty"
                  />
                )
              }
              onLoadMore={() => loadMore(items)}
            >
              {items.rows.map((item) => (
                <MemoryItemRow key={item.id} item={item} mode="active" t={t} locale={locale} now={now} busy={busyIds.has(item.id)} {...rowHandlers} />
              ))}
            </ListBody>
          </TabsContent>

          <TabsContent value="chunks" className={styles.tabBody}>
            <ListBody
              list={chunks}
              t={t}
              empty={
                <EmptyState
                  variant="dashed"
                  className={styles.empty}
                  title={t('memory.chunks.emptyTitle')}
                  description={t('memory.chunks.empty')}
                  data-testid="memory-chunks-empty"
                />
              }
              onLoadMore={() => loadMore(chunks)}
            >
              {chunks.rows.map((chunk) => (
                <ChunkBlock key={chunk.id} chunk={chunk} t={t} locale={locale} now={now} />
              ))}
            </ListBody>
          </TabsContent>

          <TabsContent value="archived" className={styles.tabBody}>
            <ListBody
              list={archived}
              t={t}
              empty={
                <EmptyState
                  variant="dashed"
                  className={styles.empty}
                  title={t('memory.archived.emptyTitle')}
                  description={t('memory.archived.empty')}
                  data-testid="memory-archived-empty"
                />
              }
              onLoadMore={() => loadMore(archived)}
            >
              {archived.rows.map((item) => (
                <MemoryItemRow key={item.id} item={item} mode="archived" t={t} locale={locale} now={now} busy={busyIds.has(item.id)} {...rowHandlers} />
              ))}
            </ListBody>
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}

function listFetcher(query: MemoryItemListQuery): PageFetcher<MemoryItem> {
  return (offset, limit, signal) =>
    memoryApi.listItems({ ...query, offset, limit }, signal).then((page) => ({ rows: page.items, total: page.total }));
}

/* ── header ────────────────────────────────────────────────────────────────────────────────── */

function ScopeHeader({
  node,
  overview,
  onPolicyChange,
  onOpenProject,
  t,
}: MemoryScopePaneProps & { t: MemoryT }) {
  const switchId = useId();
  const autoId = useId();
  const { scope } = node;
  const parent = scope.kind === 'conversation' ? parentProjectOf(overview, scope.id) : null;
  const projectId = scope.kind === 'project' ? scope.id : parent?.scope.id ?? null;
  const separator = t('memory.scope.listSeparator');

  const caption: string[] = [];
  if (scope.kind !== 'profile') caption.push(scopeKindLabel(t, scope.kind));
  if (scope.kind === 'bot') caption.push(t(node.isCharacter ? 'memory.nav.character' : 'memory.nav.assistant'));
  if (scope.kind === 'persona' && node.isDefault) caption.push(t('memory.nav.defaultPersona'));
  if (parent) caption.push(t('memory.scope.inProject', { name: scopeNodeLabel(t, parent) }));

  const policy = scope.kind === 'bot' ? node.policy : undefined;
  const members = scope.kind === 'group' ? node.members ?? [] : [];

  return (
    <header className={styles.scopeHead}>
      <div className={styles.scopeTitleRow}>
        <span className={styles.scopeFace}>
          <ScopeFace node={node} fantayId={fantayBotId(overview)} size={28} />
        </span>
        <h2 className={styles.scopeTitle} data-testid="memory-scope-title">
          {scopeNodeLabel(t, node)}
        </h2>
        {caption.length > 0 ? <span className={styles.scopeKind}>{caption.join(' · ')}</span> : null}
        {projectId && onOpenProject ? (
          <Button variant="bare" size="sm" className={styles.scopeLink} onClick={() => onOpenProject(projectId)} data-testid="memory-open-project">
            {t('memory.scope.openProject')}
            <Icon icon={ArrowUpRight} size="sm" />
          </Button>
        ) : null}
      </div>
      <p className={styles.readers} data-testid="memory-scope-readers">
        {readersSentence(t, node)}
      </p>
      {members.length > 0 ? (
        <p className={styles.scopeMeta}>{t('memory.scope.members', { names: members.map((member) => member.name).join(separator) })}</p>
      ) : null}
      {policy ? (
        <div className={styles.policyRow} data-testid="memory-bot-policy">
          <div className={styles.policyItem}>
            <Switch
              id={switchId}
              size="sm"
              checked={policy.effectiveProfileMount === 'owner_profile'}
              onCheckedChange={(checked) =>
                onPolicyChange(node, { profileMount: checked ? 'owner_profile' : node.isCharacter ? 'persona_only' : 'none' })
              }
              data-testid="memory-bot-profile-switch"
            />
            <label htmlFor={switchId} className={styles.policyLabel}>
              {t('memory.policy.profile')}
            </label>
          </div>
          <div className={styles.policyItem}>
            <span id={autoId} className={styles.policyLabel}>
              {t('memory.policy.auto')}
            </span>
            <Select value={policy.effectiveAutoMemoryMode} onValueChange={(value) => onPolicyChange(node, { autoMemoryMode: value as PaAutoMemoryMode })}>
              <SelectTrigger size="sm" aria-labelledby={autoId} className={styles.policySelect} data-testid="memory-bot-auto-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTO_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode} data-testid={`memory-bot-auto-${mode}`}>
                    {t(`memory.policy.auto.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
    </header>
  );
}

/* ── list states ───────────────────────────────────────────────────────────────────────────── */

type ListView = Pick<PagedList<{ id: string }>, 'status' | 'rows' | 'error' | 'hasMore' | 'loadingMore' | 'retry'>;

function ListBody({
  list,
  t,
  empty,
  onLoadMore,
  children,
}: {
  list: ListView;
  t: MemoryT;
  empty: ReactNode;
  onLoadMore(): void;
  children: ReactNode;
}) {
  if (list.status === 'loading' || list.status === 'idle') return <ListSkeleton />;
  if (list.status === 'error') {
    return (
      <div className={styles.stateBlock} role="alert">
        <p className={styles.stateText}>{errorMessage(t, list.error)}</p>
        <Button variant="ghost" size="sm" onClick={list.retry} data-testid="memory-retry">
          {t('memory.page.retry')}
        </Button>
      </div>
    );
  }
  if (list.rows.length === 0) return <>{empty}</>;
  return (
    <>
      <div className={styles.list}>{children}</div>
      {list.hasMore ? (
        <div className={styles.more}>
          <Button variant="ghost" size="sm" loading={list.loadingMore} onClick={onLoadMore} data-testid="memory-load-more">
            {t('memory.loadMore')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function ListSkeleton() {
  return (
    <div className={styles.list} aria-busy="true" data-testid="memory-list-loading">
      {[0, 1, 2].map((index) => (
        <div key={index} className={styles.skeletonRow} aria-hidden>
          <Skeleton shape="line" index={index} className={styles.skeletonLong} />
          <Skeleton shape="line" index={index} className={styles.skeletonMid} />
          <Skeleton shape="line" index={index} className={styles.skeletonMeta} />
        </div>
      ))}
    </div>
  );
}

/* ── 对话片段 ──────────────────────────────────────────────────────────────────────────────── */

const CHUNK_FOLD_LINES = 6;
const CHUNK_FOLD_CHARS = 420;

function ChunkBlock({ chunk, t, locale, now }: { chunk: MemoryChunk; t: MemoryT; locale: string; now: number }) {
  const [open, setOpen] = useState(false);
  const long = chunk.content.split('\n').length > CHUNK_FOLD_LINES || chunk.content.length > CHUNK_FOLD_CHARS;
  const title = chunk.conversationTitle?.trim() || t('memory.nav.untitled');
  return (
    <article className={styles.chunk} data-open={open ? '' : undefined} data-testid={`memory-chunk-${chunk.id}`}>
      <header className={styles.chunkHead}>
        <span className={styles.chunkTitle} title={title}>
          {title}
        </span>
        <span className={styles.chunkMeta}>
          <time dateTime={new Date(chunk.startAt).toISOString()}>{formatTimeRange(chunk.startAt, chunk.endAt, locale, now)}</time>
          {chunk.speakers.length > 0 ? (
            <>
              <span aria-hidden className={styles.metaSep}>
                ·
              </span>
              <span>{chunk.speakers.join(t('memory.scope.listSeparator'))}</span>
            </>
          ) : null}
        </span>
      </header>
      <p className={cn(styles.chunkText, long && !open && styles.chunkFolded)}>{chunk.content}</p>
      {long ? (
        <Button variant="link" size="sm" className={styles.chunkToggle} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {t(open ? 'memory.chunks.collapse' : 'memory.chunks.expand')}
        </Button>
      ) : null}
    </article>
  );
}
