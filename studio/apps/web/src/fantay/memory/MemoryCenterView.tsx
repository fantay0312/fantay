// SPDX-License-Identifier: AGPL-3.0-only
// 记忆 page (Memory Center): one calm surface for everything Fantay remembers. The shared page frame holds a
// title with one inventory line and four actions (待处理 · 试试回忆 · 新建记忆 · engine settings); under a
// hairline the navigator lists every place a memory can live and the pane shows the selected one. Creating,
// editing, comparing, recalling and engine settings open modals (./dialogs). The overview loads on every
// activation and after every change; it also feeds the sidebar badge.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ScanSearch, Settings } from 'lucide-react';
import type {
  MemoryConflict,
  MemoryItem,
  MemoryOverviewResponse,
  MemoryScopeNode,
  MemoryScopeRef,
} from '@open-design/contracts';
import { useRoute, type MemoryCenterTab } from '../../router';
import type { Project } from '../../types';
import { Button, Callout, Icon, IconButton, Skeleton, toast } from '../ui';
import { isAbortError, memoryApi } from './api';
import {
  MemoryCompareDialog,
  MemoryCopyDialog,
  MemoryDetailDialog,
  MemoryEditorDialog,
  MemoryEngineDialog,
  MemoryInboxDialog,
  MemoryRecallDialog,
} from './dialogs';
import { useMemoryT } from './i18n';
import { errorMessage, findScopeNode, replaceScopeNode, scopeKeyOf } from './labels';
import { reportMemoryInbox } from './memory-badge-store';
import { MemoryNavigator } from './MemoryNavigator';
import {
  EMPTY_SCOPE_FILTER,
  MemoryScopePane,
  type AgentPolicyPatch,
  type MemoryPaneTab,
  type ScopeFilter,
} from './MemoryScopePane';
import styles from './MemoryCenterView.module.css';

const SCOPE_STORAGE_KEY = 'fantay.memory.scope.v1';
const SEARCH_DEBOUNCE_MS = 250;
const PROFILE_KEY = 'profile:';
const NO_COUNTS = { active: 0, pending: 0, conflicts: 0, archived: 0, chunks: 0 } as const;

function readRememberedScope(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(SCOPE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberScope(key: string): void {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, key);
  } catch {
    /* per-viewer convenience only */
  }
}

/** Every project of the app is a place a memory can live, even before the service has seen it. */
function withShellProjects(overview: MemoryOverviewResponse, projects: readonly Project[]): MemoryOverviewResponse {
  if (projects.length === 0) return overview;
  const known = new Set(overview.projects.map((node) => node.scope.id));
  const extra: MemoryScopeNode[] = projects
    .filter((project) => !known.has(project.id))
    .map((project): MemoryScopeNode => ({
      scope: { kind: 'project', id: project.id },
      label: project.name,
      counts: { ...NO_COUNTS },
      children: [],
      updatedAt: project.updatedAt,
    }));
  return extra.length > 0 ? { ...overview, projects: [...overview.projects, ...extra] } : overview;
}

/** Where an old `/memory/<tab>` link lands now: the first place of that kind (the remembered place when
 *  there is none). `inspector` and `ledger` were tools; they open 试试回忆 and 记忆引擎 instead. */
function linkedScope(tree: MemoryOverviewResponse, tab: MemoryCenterTab): MemoryScopeRef | null {
  if (tab === 'private') return tree.profile.scope;
  if (tab === 'agent') return tree.bots[0]?.scope ?? null;
  if (tab === 'group') return tree.groups[0]?.scope ?? null;
  if (tab === 'project') return tree.projects[0]?.scope ?? null;
  return null;
}

/** The tab named in the address, or null for a bare `/memory`. Read from the URL itself: the shell's
 *  `tab` prop reads 'agent' for a bare `/memory` as well, which would replace the remembered place. */
function useLinkedTab(): MemoryCenterTab | null {
  const route = useRoute();
  return route.kind === 'home' && route.view === 'memory' ? route.memoryTab ?? null : null;
}

type EditorMode = { kind: 'create'; scope?: MemoryScopeRef } | { kind: 'edit'; item: MemoryItem };

/** A dialog keeps its last subject while it plays its closing motion. */
interface Opened<T> {
  open: boolean;
  value: T;
}

export interface MemoryCenterViewProps {
  active: boolean;
  /** The shell's reading of `/memory/<tab>`; the view reads the address itself (see `useLinkedTab`). */
  tab?: MemoryCenterTab;
  projects?: readonly Project[];
  onNavigateTab?(tab: MemoryCenterTab): void;
  onOpenProject?(projectId: string): void;
}

export function MemoryCenterView({ active, projects = [], onOpenProject }: MemoryCenterViewProps) {
  const t = useMemoryT();
  const [overview, setOverview] = useState<MemoryOverviewResponse | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selectedKey, setSelectedKey] = useState<string>(() => readRememberedScope() ?? PROFILE_KEY);
  const [tab, setTab] = useState<MemoryPaneTab>('items');
  const [filters, setFilters] = useState<Readonly<Record<string, ScopeFilter>>>({});
  const [dataVersion, setDataVersion] = useState(0);
  const [editor, setEditor] = useState<Opened<EditorMode>>({ open: false, value: { kind: 'create' } });
  const [detail, setDetail] = useState<Opened<string | null>>({ open: false, value: null });
  const [copy, setCopy] = useState<Opened<MemoryItem | null>>({ open: false, value: null });
  const [compare, setCompare] = useState<Opened<string | null>>({ open: false, value: null });
  const [inboxOpen, setInboxOpen] = useState(false);
  const [recallOpen, setRecallOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);

  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const loadSeq = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const searchTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The 待处理 action keeps its last number while it fades out at zero.
  const shownInbox = useRef(0);

  /* ── data ──────────────────────────────────────────────────────────────────────────────── */

  const loadOverview = useCallback(async () => {
    const seq = ++loadSeq.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    try {
      const next = await memoryApi.overview(controller.signal);
      if (seq !== loadSeq.current) return;
      setOverview(next);
      setLoadError(null);
      reportMemoryInbox(next.inbox);
    } catch (error) {
      if (seq !== loadSeq.current || isAbortError(error)) return;
      // With a page already on screen a failed refresh keeps it; only a first load shows the error.
      setLoadError(error);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void loadOverview();
    return () => loadController.current?.abort();
  }, [active, loadOverview]);

  // Modals render in a portal: leaving the page must not leave one of them open over another page.
  useEffect(() => {
    if (active) return;
    setEditor((current) => (current.open ? { ...current, open: false } : current));
    setDetail((current) => (current.open ? { ...current, open: false } : current));
    setCopy((current) => (current.open ? { ...current, open: false } : current));
    setCompare((current) => (current.open ? { ...current, open: false } : current));
    setInboxOpen(false);
    setRecallOpen(false);
    setEngineOpen(false);
  }, [active]);

  useEffect(() => {
    const timers = searchTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /** After any change: counts and badge are read again and every list refreshes in place. */
  const afterChange = useCallback(() => {
    void loadOverview();
    setDataVersion((value) => value + 1);
  }, [loadOverview]);

  /** A change the pane already shows (pin, archive, restore): only the counts are read again. */
  const countsChanged = useCallback(() => {
    void loadOverview();
  }, [loadOverview]);

  const tree = useMemo(() => (overview ? withShellProjects(overview, projects) : null), [overview, projects]);
  const selectedNode = tree ? findScopeNode(tree, selectedKey) ?? tree.profile : null;
  const effectiveKey = selectedNode ? scopeKeyOf(selectedNode.scope) : selectedKey;
  const inboxCount = overview ? overview.inbox.conflicts + overview.inbox.pending : 0;
  if (inboxCount > 0) shownInbox.current = inboxCount;

  const select = useCallback((scope: MemoryScopeRef) => {
    const key = scopeKeyOf(scope);
    setSelectedKey(key);
    rememberScope(key);
  }, []);

  // An old `/memory/<tab>` link is followed once, when the page shows it with the overview loaded; leaving the
  // page or a bare `/memory` forgets it, so following the same link again works again.
  const linkedTab = useLinkedTab();
  const followedLink = useRef<MemoryCenterTab | null>(null);
  useEffect(() => {
    if (!active || linkedTab === null) {
      followedLink.current = null;
      return;
    }
    if (!tree || followedLink.current === linkedTab) return;
    followedLink.current = linkedTab;
    const scope = linkedScope(tree, linkedTab);
    if (scope) {
      select(scope);
      setTab('items');
    }
    if (linkedTab === 'inspector') setRecallOpen(true);
    if (linkedTab === 'ledger') setEngineOpen(true);
  }, [active, linkedTab, tree, select]);

  /* ── per-scope filter and debounced search ─────────────────────────────────────────────── */

  const patchFilter = useCallback((key: string, patch: Partial<ScopeFilter>) => {
    setFilters((current) => ({ ...current, [key]: { ...(current[key] ?? EMPTY_SCOPE_FILTER), ...patch } }));
  }, []);

  const changeSearch = useCallback(
    (key: string, text: string) => {
      patchFilter(key, { draft: text });
      const timers = searchTimers.current;
      const pending = timers.get(key);
      if (pending) clearTimeout(pending);
      timers.delete(key);
      // Emptying the field shows everything at once; typing waits for a pause.
      if (!text.trim()) {
        patchFilter(key, { query: '' });
        return;
      }
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          patchFilter(key, { query: text });
        }, SEARCH_DEBOUNCE_MS),
      );
    },
    [patchFilter],
  );

  const clearFilter = useCallback(
    (key: string) => {
      const pending = searchTimers.current.get(key);
      if (pending) clearTimeout(pending);
      searchTimers.current.delete(key);
      patchFilter(key, EMPTY_SCOPE_FILTER);
    },
    [patchFilter],
  );

  /* ── bot policy (optimistic, rolled back on failure) ───────────────────────────────────── */

  const updatePolicy = useCallback(
    async (node: MemoryScopeNode, patch: AgentPolicyPatch) => {
      const current = overviewRef.current ? findScopeNode(overviewRef.current, node.scope) : null;
      if (!current?.policy || current.scope.kind !== 'bot') return;
      const optimistic: MemoryScopeNode = {
        ...current,
        policy: {
          ...current.policy,
          ...patch,
          effectiveProfileMount: patch.profileMount ?? current.policy.effectiveProfileMount,
          effectiveAutoMemoryMode: patch.autoMemoryMode ?? current.policy.effectiveAutoMemoryMode,
        },
      };
      // An overview read that started before this change would bring the old setting back.
      loadSeq.current += 1;
      loadController.current?.abort();
      setOverview((value) => value && replaceScopeNode(value, optimistic));
      try {
        const result = await memoryApi.updateAgentPolicy(current.scope.id, patch);
        setOverview((value) => value && replaceScopeNode(value, result.node));
        void loadOverview();
      } catch (error) {
        setOverview((value) => value && replaceScopeNode(value, current));
        toast({ tone: 'danger', title: t('memory.policy.failed'), description: errorMessage(t, error) });
      }
    },
    [loadOverview, t],
  );

  /* ── dialogs ───────────────────────────────────────────────────────────────────────────── */

  const openCreate = useCallback((scope?: MemoryScopeRef) => {
    setEditor({ open: true, value: scope ? { kind: 'create', scope } : { kind: 'create' } });
  }, []);
  const openEdit = useCallback((item: MemoryItem) => setEditor({ open: true, value: { kind: 'edit', item } }), []);
  const openDetail = useCallback((item: MemoryItem) => setDetail({ open: true, value: item.id }), []);
  const openCopy = useCallback((item: MemoryItem) => setCopy({ open: true, value: item }), []);
  const openCompare = useCallback((conflictId: string) => setCompare({ open: true, value: conflictId }), []);
  const openInbox = useCallback(() => setInboxOpen(true), []);
  const createIn = useCallback((node: MemoryScopeNode) => openCreate(node.scope), [openCreate]);

  const onSaved = useCallback(
    (result: { item: MemoryItem; conflicts: MemoryConflict[] }) => {
      const created = editorRef.current.value.kind === 'create';
      setEditor((current) => ({ ...current, open: false }));
      // A new memory saved somewhere else is shown where it now lives.
      if (created) select(result.item.scope);
      afterChange();
    },
    [afterChange, select],
  );

  const editFromDetail = useCallback(
    (item: MemoryItem) => {
      setDetail((current) => ({ ...current, open: false }));
      openEdit(item);
    },
    [openEdit],
  );

  const compareFromDetail = useCallback(
    (conflictId: string) => {
      setDetail((current) => ({ ...current, open: false }));
      openCompare(conflictId);
    },
    [openCompare],
  );

  const onCopied = useCallback(() => {
    setCopy((current) => ({ ...current, open: false }));
    afterChange();
  }, [afterChange]);

  const onResolved = useCallback(() => {
    setCompare((current) => ({ ...current, open: false }));
    afterChange();
  }, [afterChange]);

  /* ── render ────────────────────────────────────────────────────────────────────────────── */

  const filter = filters[effectiveKey] ?? EMPTY_SCOPE_FILTER;

  return (
    <div className={styles.root} data-testid="fantay-memory-center">
      <header className={styles.header} data-testid="memory-header">
        <div className={styles.headText}>
          <h1 className="entry-section__title">{t('memory.page.title')}</h1>
          {overview ? (
            <p className={styles.inventory} data-testid="memory-inventory">
              {t('memory.page.inventoryItems', { count: overview.totals.items })}
              {inboxCount > 0 ? ` · ${t('memory.page.inventoryPending', { count: inboxCount })}` : ''}
            </p>
          ) : (
            <Skeleton shape="line" className={styles.inventorySkeleton} aria-hidden />
          )}
        </div>
        <div className={styles.headerActions}>
          <Button
            variant="bare"
            className={styles.inboxAction}
            data-state={inboxCount > 0 ? 'shown' : 'hidden'}
            aria-hidden={inboxCount > 0 ? undefined : true}
            tabIndex={inboxCount > 0 ? undefined : -1}
            aria-label={t('memory.page.inboxLabel', { count: shownInbox.current })}
            onClick={openInbox}
            data-testid="memory-open-inbox"
          >
            <span className={styles.warmDot} aria-hidden />
            {t('memory.page.inbox', { count: shownInbox.current })}
          </Button>
          <Button
            variant="ghost"
            className={styles.quietAction}
            disabled={!overview}
            onClick={() => setRecallOpen(true)}
            data-testid="memory-open-recall"
          >
            <Icon icon={ScanSearch} size="sm" />
            {t('memory.page.recall')}
          </Button>
          <Button
            variant="primary"
            className="fx-page-action"
            disabled={!overview}
            onClick={() => openCreate(selectedNode?.scope)}
            data-testid="memory-new"
          >
            <Icon icon={Plus} size="sm" />
            {t('memory.page.new')}
          </Button>
          <IconButton aria-label={t('memory.page.engine')} onClick={() => setEngineOpen(true)} data-testid="memory-open-engine">
            <Icon icon={Settings} size="md" />
          </IconButton>
        </div>
      </header>

      {overview?.enabled === false ? (
        <Callout tone="neutral" className={styles.disabledNote} data-testid="memory-disabled">
          {t('memory.page.disabled')}
        </Callout>
      ) : null}

      <div className={styles.split}>
        {loadError !== null && !overview ? (
          <div className={styles.pageError} role="alert" data-testid="memory-load-error">
            <p className={styles.stateText}>
              {t('memory.page.loadFailed')} {errorMessage(t, loadError)}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void loadOverview()} data-testid="memory-retry-overview">
              {t('memory.page.retry')}
            </Button>
          </div>
        ) : (
          <>
            <MemoryNavigator overview={tree} selectedKey={effectiveKey} onSelect={select} />
            {tree && selectedNode ? (
              <MemoryScopePane
                node={selectedNode}
                overview={tree}
                tab={tab}
                onTabChange={setTab}
                filter={filter}
                onGroupChange={(group) => patchFilter(effectiveKey, { group })}
                onSearchChange={(text) => changeSearch(effectiveKey, text)}
                onClearFilter={() => clearFilter(effectiveKey)}
                dataVersion={dataVersion}
                onPolicyChange={(node, patch) => void updatePolicy(node, patch)}
                onCreate={createIn}
                onOpenItem={openDetail}
                onEditItem={openEdit}
                onCopyItem={openCopy}
                onOpenConflict={openCompare}
                onOpenInbox={openInbox}
                onChanged={countsChanged}
                onOpenProject={onOpenProject}
              />
            ) : (
              <PaneSkeleton />
            )}
          </>
        )}
      </div>

      <MemoryEditorDialog
        open={editor.open}
        onOpenChange={(open: boolean) => setEditor((current) => ({ ...current, open }))}
        overview={tree}
        mode={editor.value}
        onSaved={onSaved}
      />
      <MemoryDetailDialog
        open={detail.open}
        onOpenChange={(open: boolean) => setDetail((current) => ({ ...current, open }))}
        itemId={detail.value}
        onEdit={editFromDetail}
        onChanged={afterChange}
        onOpenConflict={compareFromDetail}
      />
      <MemoryCopyDialog
        open={copy.open}
        onOpenChange={(open: boolean) => setCopy((current) => ({ ...current, open }))}
        item={copy.value}
        overview={tree}
        onCopied={onCopied}
      />
      <MemoryInboxDialog open={inboxOpen} onOpenChange={setInboxOpen} onChanged={afterChange} />
      <MemoryCompareDialog
        open={compare.open}
        onOpenChange={(open: boolean) => setCompare((current) => ({ ...current, open }))}
        conflictId={compare.value}
        onResolved={onResolved}
      />
      <MemoryRecallDialog
        open={recallOpen}
        onOpenChange={setRecallOpen}
        overview={tree}
        {...(selectedNode ? { initialScope: selectedNode.scope } : {})}
      />
      <MemoryEngineDialog open={engineOpen} onOpenChange={setEngineOpen} onChanged={afterChange} />
    </div>
  );
}

/** The pane's first paint while the overview loads: the same blocks, so nothing moves when it arrives. */
function PaneSkeleton() {
  return (
    <div className={styles.pane} aria-busy="true" data-testid="memory-pane-loading">
      <div className={styles.paneInner}>
        <div className={styles.scopeHead} aria-hidden>
          <div className={styles.scopeTitleRow}>
            <Skeleton className={styles.skeletonFace} />
            <Skeleton shape="line" className={styles.skeletonTitle} />
          </div>
          <Skeleton shape="line" className={styles.skeletonMid} />
        </div>
        <div className={styles.skeletonTabs} aria-hidden />
        <div className={styles.list} aria-hidden>
          {[0, 1, 2].map((index) => (
            <div key={index} className={styles.skeletonRow}>
              <Skeleton shape="line" index={index} className={styles.skeletonLong} />
              <Skeleton shape="line" index={index} className={styles.skeletonMid} />
              <Skeleton shape="line" index={index} className={styles.skeletonMeta} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
