// SPDX-License-Identifier: AGPL-3.0-only
// The Fantay workspace root (spec §2–§4, §17, §19). It owns the data hook, the derived index, the view state
// (mirrored per viewer to localStorage), navigation, composer drafts and the layout mode, and lays out the
// roster beside either a conversation (with its docked or floating inspector) or one of the three pages.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { PanelLeftOpen } from 'lucide-react';

import { usePresence } from '../../hooks/usePresence';
import { useI18n } from '../../i18n';
import { FantayMascotStill } from '../brand/FantayMascot';
import {
  Button,
  Callout,
  EmptyState,
  FxRoot,
  IconButton,
  Icon,
  Input,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
  VisuallyHidden,
} from '../ui';
import { PaContext, createPaDrafts, usePa } from './pa-context';
import { buildIndex, subjectOf } from './pa-model';
import type {
  PaContextValue,
  PaDrafts,
  PaIndex,
  PaNav,
  PaSnapshot,
  PaUiState,
  Project,
} from './pa-types';
import { PaConfirmHost } from './PaConfirmHost';
import { PaActivityPage } from './PaActivityPage';
import { PaConnectionsPage } from './PaConnectionsPage';
import { PaConversationView } from './PaConversationView';
import { PaInspector } from './PaInspector';
import { PaMemoryPage } from './PaMemoryPage';
import { PaModalHost } from './PaModalHost';
import { PaRoster, PaSeenContext } from './PaRoster';
import { PaTasksPage } from './PaTasksPage';
import { PA_INSPECTOR, PA_ROSTER_WIDTH, dockedInspectorWidth, floatingInspectorWidth, usePaLayout } from './usePaLayout';
import { usePaWorkspace } from './usePaWorkspace';
import { PA_ACCESS_REQUIRED, paRequest, setPaAccessToken } from './pa-api';
import styles from './PersonalAgentWorkspace.module.css';

export interface PersonalAgentWorkspaceProps {
  active: boolean;
  onOpenProject: (id: string, file?: string) => unknown;
  projects?: readonly Project[]; // default []
  initialState?: Partial<PaUiState>; // lab and tests only
}

const UI_KEY = 'fantay.pa.ui.v1';
const SEEN_KEY = 'fantay.pa.seen.v1';
const NOW_TICK_MS = 30_000;
const NO_PROJECTS: readonly Project[] = [];

const EMPTY_SNAPSHOT: PaSnapshot = {
  agents: [],
  groups: [],
  conversations: [],
  messages: [],
  tasks: [],
  attempts: [],
  artifacts: [],
  memories: [],
  node: { id: 'local', protocolVersion: 1, location: 'local', available: false, capabilities: [], heartbeatAt: 0 },
};

const DEFAULT_UI: PaUiState = {
  place: 'conversation',
  conversationId: null,
  inspectorOpen: true,
  inspectorTab: 'activity',
  inspectorWidth: PA_INSPECTOR.default,
  inspectorAgentId: null,
  activityTab: 'activity',
  tasksFilter: null,
  memoryFilter: 'all',
  modal: null,
  rosterQuery: '',
  focusTurn: null,
};

// ---- per-viewer storage (every access guarded: private windows, blocked storage, previews) ----

function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the view works without it */
  }
}

function storedUi(): Partial<PaUiState> {
  const raw = readJson(UI_KEY) as Partial<Record<'conversationId' | 'inspectorOpen' | 'inspectorWidth', unknown>> | null;
  if (!raw || typeof raw !== 'object') return {};
  const out: Partial<PaUiState> = {};
  if (typeof raw.conversationId === 'string' || raw.conversationId === null) out.conversationId = raw.conversationId;
  if (typeof raw.inspectorOpen === 'boolean') out.inspectorOpen = raw.inspectorOpen;
  if (typeof raw.inspectorWidth === 'number' && Number.isFinite(raw.inspectorWidth))
    out.inspectorWidth = Math.max(PA_INSPECTOR.min, Math.min(PA_INSPECTOR.max, Math.round(raw.inspectorWidth)));
  return out;
}

function storedSeen(): Record<string, number> | null {
  const raw = readJson(SEEN_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) if (typeof at === 'number') out[id] = at;
  return out;
}

// ---- derived ----

function newestAgentMessage(index: PaIndex, conversationId: string): number {
  const messages = index.messagesByConversation.get(conversationId) ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]!.senderId !== 'owner') return messages[i]!.createdAt;
  return 0;
}

/** Spec §3.5: the remembered conversation; else Fantay's latest direct chat; else the first group chat; else the
 *  first conversation; else none (the Fantay empty state offers to start one). */
function defaultConversation(index: PaIndex, preferred: string | null): string | null {
  if (preferred && index.conversations.has(preferred)) return preferred;
  const fantay = index.fantay;
  const fantayChat = fantay ? index.directByAgent.get(fantay.id)?.[0] : undefined;
  if (fantayChat) return fantayChat.id;
  for (const group of index.groups.values()) if (index.conversations.has(group.conversationId)) return group.conversationId;
  const first = index.conversations.values().next();
  return first.done ? null : first.value.id;
}

/** The roster Sheet is portaled and fixed to the viewport; this places it over the workspace host instead, inset
 *  8 px like the floating inspector on the other side, so it slides out of the roster's own edge rather than from
 *  the window edge over the app sidebar. Measured while open, and again on resize or scroll. */
const SHEET_INSET = 8;
function useHostFrame(ref: RefObject<HTMLElement | null>, open: boolean): CSSProperties | null {
  const [frame, setFrame] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) return;
      const next = {
        top: Math.round(rect.top + SHEET_INSET),
        left: Math.round(rect.left + SHEET_INSET),
        height: Math.round(rect.height - SHEET_INSET * 2),
      };
      setFrame((previous) =>
        previous && previous.top === next.top && previous.left === next.left && previous.height === next.height
          ? previous
          : { ...next, bottom: 'auto' },
      );
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [ref, open]);
  return frame;
}

/** React 18 drops a boolean `inert`; set it on the node. */
function useInert(ref: RefObject<HTMLElement | null>, inert: boolean): void {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (inert) node.setAttribute('inert', '');
    else node.removeAttribute('inert');
  }, [ref, inert]);
}

export function PersonalAgentWorkspace({ active, onOpenProject, projects = NO_PROJECTS, initialState }: PersonalAgentWorkspaceProps) {
  const { t } = useI18n();
  const data = usePaWorkspace(active);
  const [needsEnterpriseAccess, setNeedsEnterpriseAccess] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessError, setAccessError] = useState(false);
  const accessField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!active) return;
    const gate = () => setNeedsEnterpriseAccess(true);
    window.addEventListener(PA_ACCESS_REQUIRED, gate);
    const abort = new AbortController();
    void paRequest<{ mode?: string; authorized?: boolean }>('/mode', 'GET', undefined, abort.signal)
      .then(mode => { if (mode.mode === 'enterprise' && mode.authorized === false) gate(); })
      .catch(() => undefined);
    return () => {
      abort.abort();
      window.removeEventListener(PA_ACCESS_REQUIRED, gate);
    };
  }, [active]);
  const hostRef = useRef<HTMLElement>(null);
  const layout = usePaLayout(hostRef);
  const snapshot = data.snapshot ?? EMPTY_SNAPSHOT;
  const index = useMemo(() => buildIndex(snapshot, data.channels, data.models), [snapshot, data.channels, data.models]);

  // ---- view state ----
  const [ui, setUi] = useState<PaUiState>(() => ({ ...DEFAULT_UI, ...storedUi(), ...initialState }));
  /* The floating inspector is transient: closed by default at floating widths (even when the docked preference,
     remembered or passed in, is open) and never written over that preference (spec §4.1). */
  const [floatingOpen, setFloatingOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetFrame = useHostFrame(hostRef, sheetOpen);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const focusTurnNonce = useRef(0);

  useEffect(() => {
    writeJson(UI_KEY, { conversationId: ui.conversationId, inspectorOpen: ui.inspectorOpen, inspectorWidth: ui.inspectorWidth });
  }, [ui.conversationId, ui.inspectorOpen, ui.inspectorWidth]);

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (layout.roster === 'full') setSheetOpen(false);
  }, [layout.roster]);

  const conversationId = useMemo(() => defaultConversation(index, ui.conversationId), [index, ui.conversationId]);
  const dockedWidth = dockedInspectorWidth(layout, ui.inspectorWidth);
  // Shown open only when there is something to inspect (or the first load is still arriving).
  const inspectorOpen =
    (layout.inspector === 'docked' ? ui.inspectorOpen : floatingOpen) && (conversationId !== null || (data.load === 'loading' && !data.snapshot));

  // ---- seen map (unread dots) ----
  // One read of the stored map, at mount (lazy: not re-read and re-parsed on every render).
  const [storedSeenAtMount] = useState(storedSeen);
  const [seen, setSeen] = useState<Record<string, number>>(() => storedSeenAtMount ?? {});
  const seenBaseline = useRef(storedSeenAtMount !== null);
  // Persist before the baseline effect runs, so the empty pre-baseline map is never written.
  useEffect(() => {
    if (seenBaseline.current) writeJson(SEEN_KEY, seen);
  }, [seen]);
  useEffect(() => {
    // First run of this viewer: everything already in the snapshot counts as seen, so the roster does not
    // open with every conversation marked unread.
    if (seenBaseline.current || !data.snapshot) return;
    seenBaseline.current = true;
    const baseline: Record<string, number> = {};
    for (const id of index.conversations.keys()) baseline[id] = newestAgentMessage(index, id);
    setSeen((previous) => ({ ...baseline, ...previous }));
  }, [data.snapshot, index]);
  useEffect(() => {
    // Opening a conversation while the view is active marks its newest agent message seen.
    if (!active || ui.place !== 'conversation' || !conversationId) return;
    const newest = newestAgentMessage(index, conversationId);
    setSeen((previous) => (newest > (previous[conversationId] ?? 0) ? { ...previous, [conversationId]: newest } : previous));
  }, [active, conversationId, index, ui.place]);

  // ---- drafts ----
  // A store outside React state with one identity for the workspace's life: typing re-renders the composer that
  // subscribes to it (usePaDraft), not every usePa() consumer (review C6).
  const [drafts] = useState<PaDrafts>(createPaDrafts);

  // ---- navigation ----
  const latest = useRef({ index, layout, actions: data.actions, ui, conversationId, floatingOpen });
  latest.current = { index, layout, actions: data.actions, ui, conversationId, floatingOpen };
  /** Conversation creations in flight, per agent: a second click while one is pending joins it instead of
   *  creating a second empty chat (review C13). */
  const creating = useRef(new Map<string, Promise<void>>());

  const nav = useMemo<PaNav>(() => {
    const open = (id: string) => {
      setUi((state) => ({ ...state, place: 'conversation', conversationId: id, inspectorAgentId: null }));
      setSheetOpen(false);
    };
    const create = (agentId: string): Promise<void> => {
      const pending = creating.current.get(agentId);
      if (pending) return pending;
      const run = latest.current.actions
        .createConversation(agentId)
        .then((created) => open(created.id))
        .finally(() => creating.current.delete(agentId));
      creating.current.set(agentId, run);
      return run;
    };
    return {
      openConversation: open,
      async openAgent(agentId) {
        const existing = latest.current.index.directByAgent.get(agentId)?.[0];
        if (existing) {
          open(existing.id);
          return;
        }
        await create(agentId);
      },
      newConversation: create,
      openPlace(place, opts) {
        setUi((state) => ({
          ...state,
          place,
          ...(opts?.tasksFilter ? { tasksFilter: opts.tasksFilter } : {}),
          ...(opts?.memoryFilter ? { memoryFilter: opts.memoryFilter } : {}),
          ...(opts?.activityTab ? { activityTab: opts.activityTab } : {}),
        }));
        setSheetOpen(false);
      },
      openTaskTurn(taskId) {
        const task = latest.current.index.tasks.get(taskId);
        if (!task) return;
        focusTurnNonce.current += 1;
        const nonce = focusTurnNonce.current;
        setUi((state) => ({
          ...state,
          place: 'conversation',
          conversationId: task.conversationId,
          inspectorAgentId: null,
          focusTurn: { taskId, nonce },
        }));
        setSheetOpen(false);
      },
      openModal(modal) {
        setUi((state) => ({ ...state, modal }));
      },
      closeModal() {
        setUi((state) => (state.modal ? { ...state, modal: null } : state));
      },
      setInspector(next, tab) {
        if (latest.current.layout.inspector === 'docked') {
          setUi((state) => ({
            ...state,
            inspectorOpen: next,
            ...(next ? {} : { inspectorAgentId: null }),
            ...(tab ? { inspectorTab: tab } : {}),
          }));
        } else {
          setFloatingOpen(next);
          if (!next || tab) {
            setUi((state) => ({
              ...state,
              ...(next ? {} : { inspectorAgentId: null }),
              ...(tab ? { inspectorTab: tab } : {}),
            }));
          }
        }
      },
      inspectAgent(agentId, opts) {
        const { index: curIndex, layout: curLayout, conversationId: curConvId, ui: curUi, floatingOpen: curFloat } = latest.current;
        if (!curIndex.agents.has(agentId)) return;
        const conv = curConvId ? curIndex.conversations.get(curConvId) : undefined;
        const convSubject = conv ? subjectOf(curIndex, conv) : null;
        const naturalAgentId = convSubject?.kind === 'agent' ? convSubject.agent.id : null;
        const currentShown = curUi.inspectorAgentId ?? naturalAgentId;
        const isOpen = curLayout.inspector === 'docked' ? curUi.inspectorOpen : curFloat;
        if (opts?.toggle && isOpen && currentShown === agentId) {
          if (curLayout.inspector === 'docked') {
            setUi((state) => ({ ...state, inspectorOpen: false, inspectorAgentId: null }));
          } else {
            setFloatingOpen(false);
            setUi((state) => (state.inspectorAgentId ? { ...state, inspectorAgentId: null } : state));
          }
          return;
        }
        const nextOverride = naturalAgentId === agentId ? null : agentId;
        if (curLayout.inspector === 'docked') {
          setUi((state) => ({
            ...state,
            inspectorOpen: true,
            inspectorAgentId: nextOverride,
            ...(opts?.tab ? { inspectorTab: opts.tab } : {}),
          }));
        } else {
          setFloatingOpen(true);
          setUi((state) => ({
            ...state,
            inspectorAgentId: nextOverride,
            ...(opts?.tab ? { inspectorTab: opts.tab } : {}),
          }));
        }
      },
      clearInspectorAgent() {
        setUi((state) => (state.inspectorAgentId ? { ...state, inspectorAgentId: null } : state));
      },
      setInspectorWidth(px) {
        const width = Math.round(Math.max(PA_INSPECTOR.min, Math.min(PA_INSPECTOR.max, px)));
        setUi((state) => (state.inspectorWidth === width ? state : { ...state, inspectorWidth: width }));
      },
      setTasksFilter(filter) {
        setUi((state) => ({ ...state, tasksFilter: filter }));
      },
      setMemoryFilter(filter) {
        setUi((state) => ({ ...state, memoryFilter: filter }));
      },
      setRosterQuery(query) {
        setUi((state) => ({ ...state, rosterQuery: query }));
      },
      fillComposer(id, draft) {
        drafts.set(id, { ...draft, request: null });
        open(id);
        drafts.requestFocus();
      },
      openRosterSheet() {
        if (latest.current.layout.roster !== 'full') setSheetOpen(true);
      },
    };
  }, [drafts]);

  const effectiveUi = useMemo<PaUiState>(
    () => ({ ...ui, conversationId, inspectorOpen, inspectorWidth: dockedWidth }),
    [ui, conversationId, inspectorOpen, dockedWidth],
  );

  const context = useMemo<PaContextValue>(
    () => ({ data, index, ui: effectiveUi, nav, drafts, layout, projects, onOpenProject, now }),
    [data, index, effectiveUi, nav, drafts, layout, projects, onOpenProject, now],
  );

  const offline = data.load === 'offline' && !data.snapshot;
  const hostStyle = {
    '--pa-roster-col': `${PA_ROSTER_WIDTH[layout.roster]}px`,
    '--pa-inspector-w': `${dockedWidth}px`,
  } as CSSProperties;

  if (needsEnterpriseAccess) return (
    <FxRoot as="section" ref={hostRef} className={styles.enterpriseAccess}>
      <form onSubmit={event => {
        event.preventDefault();
        const token = accessField.current?.value.trim();
        if (!token || accessBusy) return;
        setAccessBusy(true);
        setAccessError(false);
        setPaAccessToken(token);
        void paRequest<{ authorized: boolean }>('/mode').then(async mode => {
          if (!mode.authorized) throw new Error('Enterprise access denied');
          await data.actions.refresh();
          setNeedsEnterpriseAccess(false);
        }).catch(() => {
          setPaAccessToken('');
          setAccessError(true);
        }).finally(() => setAccessBusy(false));
      }}>
        <h2>{t('pa.enterprise.title')}</h2>
        <Input ref={accessField} type="password" autoComplete="off" required maxLength={256} aria-label={t('pa.enterprise.token')} placeholder={t('pa.enterprise.token')} />
        {accessError ? <p role="alert">{t('pa.enterprise.invalid')}</p> : null}
        <Button type="submit" variant="primary" loading={accessBusy}>{t('pa.enterprise.open')}</Button>
      </form>
    </FxRoot>
  );

  return (
    <PaContext.Provider value={context}>
      <PaSeenContext.Provider value={seen}>
        <FxRoot
          as="section"
          ref={hostRef}
          data-testid="pa-workspace"
          data-roster={layout.roster}
          data-inspector={layout.inspector}
          data-place={ui.place}
          className={styles.host}
          style={hostStyle}
        >
          <div className={styles.root} data-roster={layout.roster}>
            {layout.roster !== 'sheet' ? (
              <div className={styles.rosterCol}>
                <PaRoster variant={layout.roster === 'rail' ? 'rail' : 'full'} />
              </div>
            ) : null}
            <div className={styles.main}>
              {offline ? (
                <OfflineState />
              ) : ui.place === 'conversation' ? (
                <ChatArea conversationId={conversationId} active={active} />
              ) : (
                <PageArea active={active} />
              )}
            </div>
          </div>
          {layout.roster !== 'full' ? (
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen} modal={false}>
              <SheetContent
                side="left"
                width={300}
                showCloseButton={false}
                className={styles.sheet}
                style={sheetFrame ?? undefined}
                aria-describedby={undefined}
                onOpenAutoFocus={(event) => {
                  // Land on the roster's own focus stop (the open conversation's row), not on the first button, whose
                  // tooltip would pop up the moment the sheet opens.
                  event.preventDefault();
                  sheetRef.current?.querySelector<HTMLElement>('[data-roster-item][tabindex="0"]')?.focus();
                }}
                ref={sheetRef}
              >
                <VisuallyHidden>
                  <SheetTitle>{t('pa.roster.label')}</SheetTitle>
                </VisuallyHidden>
                <PaRoster variant="full" />
              </SheetContent>
            </Sheet>
          ) : null}
          <PaModalHost />
          <PaConfirmHost />
        </FxRoot>
      </PaSeenContext.Provider>
    </PaContext.Provider>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Main area
// ---------------------------------------------------------------------------------------------------------

function useRetry() {
  const { data } = usePa();
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void data.actions.refresh().finally(() => setRetrying(false));
  };
  return { retrying, retry };
}

/** Spec §17.2 stale state: data kept, poll failing. A neutral callout at the top of the column or page. */
function StaleBar() {
  const { data, ui } = usePa();
  const { t, locale } = useI18n();
  const { retrying, retry } = useRetry();
  if (data.load !== 'ready' || !data.stale) return null;
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(data.stale.since);
  return (
    <div className={styles.staleBar} data-place={ui.place}>
      <Callout tone="neutral" className={styles.stale} role="status">
        <span className={styles.staleText}>{t('pa.state.stale', { time })}</span>
        <Button size="sm" variant="default" loading={retrying} onClick={retry}>
          {t('pa.state.retry')}
        </Button>
      </Callout>
    </div>
  );
}

function OfflineState() {
  const { data } = usePa();
  const { t } = useI18n();
  const { retrying, retry } = useRetry();
  return (
    <div className={styles.offline}>
      <EmptyState
        variant="dashed"
        className={styles.offlineCard}
        illustration={<FantayMascotStill size={48} />}
        title={t('pa.state.offlineTitle')}
        description={
          <>
            <span className={styles.offlineBody}>{t('pa.state.offlineBody')}</span>
            {data.stale?.message ? <span className={styles.offlineDetail}>{data.stale.message}</span> : null}
          </>
        }
        action={
          <Button variant="primary" loading={retrying} onClick={retry}>
            {t('pa.state.retry')}
          </Button>
        }
      />
    </div>
  );
}

function ChatArea({ conversationId, active }: { conversationId: string | null; active: boolean }) {
  const { ui, layout, nav, data } = usePa();
  const loading = data.load === 'loading' && !data.snapshot;
  return (
    <div className={styles.chatArea} data-inspector={layout.inspector}>
      <div className={styles.chatColumn}>
        <StaleBar />
        <div className={styles.conversation}>
          <PaConversationView conversationId={conversationId} active={active} />
        </div>
      </div>
      {layout.inspector === 'docked' ? (
        <DockedInspector
          open={ui.inspectorOpen}
          width={ui.inspectorWidth}
          conversationId={conversationId}
          loading={loading}
        />
      ) : (
        <FloatingInspector
          open={ui.inspectorOpen && conversationId !== null}
          width={floatingInspectorWidth(layout)}
          conversationId={conversationId}
          onClose={() => nav.setInspector(false)}
        />
      )}
    </div>
  );
}

/** Spec §16: the grid column animates 0 ↔ W (240 ms open, 160 ms close); the content keeps its width and only
 *  fades, so it never reflows. Unmounted after the exit, so a closed inspector runs no live mascot. */
function DockedInspector({ open, width, conversationId, loading }: { open: boolean; width: number; conversationId: string | null; loading: boolean }) {
  const presence = usePresence(open, 160);
  const innerRef = useRef<HTMLDivElement>(null);
  useInert(innerRef, presence.closing);
  // +1 for the 1 px seam on the inner's start edge, so the inspector itself keeps exactly `width`.
  const outer = width + 1;
  return (
    <div className={styles.dock} data-open={open ? '' : undefined} style={{ width: open ? outer : 0 }}>
      {presence.mounted ? (
        <div ref={innerRef} className={styles.dockInner} data-state={presence.closing ? 'closed' : 'open'} style={{ width: outer }}>
          {conversationId ? <PaInspector conversationId={conversationId} surface="docked" /> : loading ? <InspectorSkeleton /> : null}
        </div>
      ) : null}
    </div>
  );
}

function FloatingInspector({
  open,
  width,
  conversationId,
  onClose,
}: {
  open: boolean;
  width: number;
  conversationId: string | null;
  onClose(): void;
}) {
  const presence = usePresence(open, 150);
  const ref = useRef<HTMLDivElement>(null);
  useInert(ref, presence.closing);
  const shownId = useRef(conversationId);
  if (conversationId) shownId.current = conversationId;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    /* Escape closes the floating panel wherever focus is in the workspace, not only inside it: after the header
       toggle opens it, focus stays on the toggle. Menus, dialogs and the roster search handle their own Escape
       first (Radix dismisses in the capture phase and marks the event), so this bubble listener skips those. */
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const host = ref.current?.closest('[data-testid="pa-workspace"]');
      const target = event.target as Node | null;
      if (!host || !target || !(target === document.body || host.contains(target))) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);
  if (!presence.mounted || !shownId.current) return null;
  return (
    <div ref={ref} className={styles.float} data-state={presence.closing ? 'closed' : 'open'} style={{ width }}>
      <PaInspector conversationId={shownId.current} surface="floating" />
    </div>
  );
}

/** First load (spec §17.2): the inspector hero shows the still while the snapshot arrives. */
function InspectorSkeleton() {
  return (
    <div className={styles.inspectorSkeleton} aria-hidden>
      <div className={styles.inspectorStage}>
        <FantayMascotStill size={104} />
      </div>
      <Skeleton shape="line" index={0} className={styles.inspectorLine} />
      <Skeleton shape="line" index={1} className={styles.inspectorLineShort} />
    </div>
  );
}

/** Connections drops to 16 px gutters in a container of 560 px or less (PaConnectionsPage.module.css); 576 leaves
 *  room for a classic scrollbar inside that container. */
const CONNECTIONS_NARROW = 576;

function PageArea({ active }: { active: boolean }) {
  const { ui, layout, nav } = usePa();
  const { t } = useI18n();
  const sheet = layout.roster === 'sheet';
  /* Below 720 px the roster button sits in the page's 32 px start gutter, on the heading's line, so the page keeps
     its own top padding and no band opens above the heading. Where the gutter is too narrow for it (connections
     in a small container) the button keeps a row of its own. */
  const inGutter = sheet && !(ui.place === 'connections' && layout.width <= CONNECTIONS_NARROW);
  const button = (
    <IconButton size="sm" variant="quiet" aria-label={t('pa.roster.openList')} onClick={nav.openRosterSheet}>
      <Icon icon={PanelLeftOpen} size="md" />
    </IconButton>
  );
  return (
    <div className={styles.pageColumn} data-place={ui.place}>
      <StaleBar />
      {sheet && !inGutter ? <div className={styles.pageBar}>{button}</div> : null}
      <div className={styles.page}>
        {inGutter ? <span className={styles.pageRosterButton}>{button}</span> : null}
        {ui.place === 'activity' ? <PaActivityPage active={active} /> : ui.place === 'tasks' ? <PaTasksPage /> : ui.place === 'memory' ? <PaMemoryPage /> : <PaConnectionsPage />}
      </div>
    </div>
  );
}
