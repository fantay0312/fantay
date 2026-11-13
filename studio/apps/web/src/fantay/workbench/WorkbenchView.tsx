/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 (workbench) — the module shell. Fills the main column beside the app sidebar: its own
 * header (title, projects and the desk pages inline, desk actions), the signed-out notice, the pages (all
 * mounted, inactive ones hidden), the desk assistant on the right, the 成稿 studio over the page area when
 * an item is open, and the settings / import / clear-samples dialogs.
 * Derived from dsh-media-desk client/index.jsx and client/desk.js
 * (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type JSX, type ReactNode } from 'react';
import { LogIn, RefreshCw } from 'lucide-react';
import type { WorkbenchPage, WorkbenchPublicSettings, WorkbenchState } from '@open-design/contracts';
import { WORKBENCH_PAGES } from '@open-design/contracts';

import { TOKENTOSEA_SESSION_CHANGED_EVENT } from '../account/use-tokentosea-session';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { ConfirmDialog } from '../ui/dialog';
import { EmptyState } from '../ui/empty-state';
import { FX } from '../ui/fx';
import { Icon } from '../ui/icons';
import { Spinner } from '../ui/spinner';
import { workbenchApi } from './api';
import { AssistantPanel } from './assistant/AssistantPanel';
import type { ChatDraft } from './assistant/ChatThread';
import { requestQuickCapture } from './capture-bus';
import { ContentPage } from './content/ContentPage';
import { ImportDialog } from './import/ImportDialog';
import { InsightsPage } from './insights/InsightsPage';
import { InspirationPage } from './inspiration/InspirationPage';
import { useL } from './lang';
import { SchedulePage } from './schedule/SchedulePage';
import { SettingsDialog } from './settings/SettingsDialog';
import { WorkbenchShellContext, type WorkbenchShell } from './shell/context';
import { useTokenToSeaSignIn } from './shell/use-sign-in';
import { WorkbenchHeader } from './shell/WorkbenchHeader';
import { startProduction, StudioView } from './studio';
import { StylePage } from './style/StylePage';
import { useWorkbench, workbench } from './store';
import type { WorkbenchPageProps, WorkbenchTab } from './types';
import styles from './WorkbenchView.module.css';

export interface WorkbenchViewProps {
  active: boolean;
  page: WorkbenchTab;
  projects: ReactNode;
  /** When set, the studio is open for this item. */
  itemId: string | null;
  onNavigate(next: { page: WorkbenchTab; itemId?: string | null }, options?: { replace?: boolean }): void;
}

const PAGES: Record<WorkbenchPage, ComponentType<WorkbenchPageProps>> = {
  inspiration: InspirationPage,
  content: ContentPage,
  schedule: SchedulePage,
  insights: InsightsPage,
  style: StylePage,
};

const ASSISTANT_KEY = 'fantay.workbench.assistantOpen';
const NARROW_PX = 1080;

function readAssistantOpen(): boolean {
  try {
    const stored = window.localStorage.getItem(ASSISTANT_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // Storage may be unavailable; fall back to the width.
  }
  // Open by default only when the panel can dock beside the page (workbench area ≥ NARROW_PX after the app sidebar).
  return typeof window !== 'undefined' && window.innerWidth >= 1440;
}

function writeAssistantOpen(open: boolean): void {
  try {
    window.localStorage.setItem(ASSISTANT_KEY, open ? '1' : '0');
  } catch {
    // Not persisted; the panel still toggles.
  }
}

function hasSampleData(state: WorkbenchState | null): boolean {
  if (!state || state.sampleCleared) return false;
  return [state.items, state.spaces, state.people, state.angles, state.skills, state.accounts, state.metrics, state.styles]
    .some(list => list.some(row => (row as { sample?: boolean }).sample));
}

const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return Boolean(el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable));
};

export function WorkbenchView({ active, page, projects, itemId, onNavigate }: WorkbenchViewProps): JSX.Element {
  const L = useL();
  const snapshot = useWorkbench();
  const [settings, setSettings] = useState<WorkbenchPublicSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [confirmSamples, setConfirmSamples] = useState(false);
  const [assistantOpen, setAssistantOpenState] = useState(() => (typeof window === 'undefined' ? false : readAssistantOpen()));
  const [assistantDraft, setAssistantDraft] = useState<ChatDraft | null>(null);
  const [shownItem, setShownItem] = useState<string | null>(itemId);
  const [narrow, setNarrow] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const studioOpen = Boolean(itemId);
  const projectsOpen = page === 'projects';
  const deskActive = active && !projectsOpen;
  const deskPage = projectsOpen ? 'inspiration' : page;

  const setAssistantOpen = useCallback((open: boolean) => {
    setAssistantOpenState(open);
    writeAssistantOpen(open);
  }, []);

  // The studio keeps the last item for a moment after closing, so its exit can play.
  useEffect(() => {
    if (itemId) {
      setShownItem(itemId);
      return undefined;
    }
    const timer = window.setTimeout(() => setShownItem(null), 200);
    return () => window.clearTimeout(timer);
  }, [itemId]);

  const reloadSettings = useCallback(async () => {
    try {
      setSettings(await workbenchApi.settings());
    } catch {
      // Keep what we had; image features read as unavailable until the daemon answers.
    }
  }, []);

  // Load when the workbench becomes visible, and again whenever the window regains focus or the
  // TokenToSea session changes elsewhere (sidebar sign-in, Settings ▸ 账户).
  useEffect(() => {
    if (!deskActive) return undefined;
    void workbench.refresh();
    void reloadSettings();
    const onFocus = () => {
      void workbench.refresh();
      void reloadSettings();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener(TOKENTOSEA_SESSION_CHANGED_EVENT, onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(TOKENTOSEA_SESSION_CHANGED_EVENT, onFocus);
    };
  }, [deskActive, reloadSettings]);

  const signedIn = snapshot.signedIn;
  const firstSignedIn = useRef(signedIn);
  useEffect(() => {
    if (firstSignedIn.current === signedIn) return;
    firstSignedIn.current = signedIn;
    void reloadSettings();
  }, [signedIn, reloadSettings]);

  // Narrow body: the assistant floats over the page instead of taking a column.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < NARROW_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // While the studio covers the body, what is under it leaves the tab order.
  useEffect(() => {
    pagesRef.current?.toggleAttribute('inert', studioOpen);
    dockRef.current?.toggleAttribute('inert', studioOpen || !assistantOpen);
  }, [studioOpen, assistantOpen]);

  // ── navigation and actions, stable for the pages ──────────────────────
  const latest = useRef({ page: deskPage, itemId, onNavigate, L });
  latest.current = { page: deskPage, itemId, onNavigate, L };

  const actions = useMemo(() => {
    const openItem = (id: string) => {
      const { page: current, itemId: open, onNavigate: go } = latest.current;
      if (open === id) return;
      go({ page: current, itemId: id });
    };
    const closeItem = () => {
      const { page: current, onNavigate: go } = latest.current;
      go({ page: current, itemId: null });
    };
    const navigate = (next: WorkbenchPage) => latest.current.onNavigate({ page: next, itemId: null });
    const produce = (id: string, withImages?: boolean) => {
      openItem(id);
      void startProduction(id, withImages, latest.current.L);
    };
    const openAssistant = (prompt?: string) => {
      setAssistantOpen(true);
      if (prompt) setAssistantDraft({ text: prompt, nonce: Date.now() });
    };
    return {
      openItem,
      closeItem,
      navigate,
      produce,
      openAssistant,
      openSettings: () => setSettingsOpen(true),
      openImport: () => setImportOpen(true),
    };
  }, [setAssistantOpen]);

  const signInFlow = useTokenToSeaSignIn(L, () => { void reloadSettings(); });
  const { signIn: startSignIn, signingIn } = signInFlow;

  const shell = useMemo<WorkbenchShell>(() => ({
    page: deskPage,
    settings,
    setSettings,
    reloadSettings,
    ...actions,
    signIn: () => { void startSignIn(); },
    signingIn,
  }), [deskPage, settings, reloadSettings, actions, startSignIn, signingIn]);

  const capture = useCallback(() => {
    if (requestQuickCapture()) return;
    // The capture dialog belongs to the 灵感 page; bring it up first if it is not listening yet.
    actions.navigate('inspiration');
    window.setTimeout(() => { requestQuickCapture(); }, 80);
  }, [actions]);

  // ⌘⇧K quick capture, ⌘Z undo — only on the desk pages.
  const canUndo = snapshot.canUndo;
  useEffect(() => {
    if (!deskActive) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k' && event.shiftKey) {
        event.preventDefault();
        capture();
        return;
      }
      if (key === 'z' && !event.shiftKey && canUndo && !isTyping(event.target) && !document.querySelector('[data-slot="modal"], [data-slot="confirm-dialog"]')) {
        event.preventDefault();
        void workbench.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deskActive, capture, canUndo]);

  const pageProps = useMemo(() => {
    const entries = WORKBENCH_PAGES.map((entry): [WorkbenchPage, WorkbenchPageProps] => [entry, {
      active: active && entry === page && !studioOpen,
      openItem: actions.openItem,
      produce: actions.produce,
      openAssistant: actions.openAssistant,
      navigate: actions.navigate,
      openSettings: actions.openSettings,
      openImport: actions.openImport,
    }]);
    return Object.fromEntries(entries) as Record<WorkbenchPage, WorkbenchPageProps>;
  }, [active, page, studioOpen, actions]);

  const state = snapshot.state;
  const showBanner = !projectsOpen && snapshot.status === 'ready' && !signedIn;
  const dockShown = assistantOpen && !studioOpen;

  return (
    <WorkbenchShellContext.Provider value={shell}>
      <div ref={rootRef} className={cn(FX, styles.root)} data-testid="workbench-view" data-narrow={narrow ? '' : undefined}>
        <WorkbenchHeader
          page={page}
          studioOpen={studioOpen}
          onPage={entry => onNavigate({ page: entry, itemId: null })}
          hasSamples={hasSampleData(state)}
          onClearSamples={() => setConfirmSamples(true)}
          canUndo={snapshot.canUndo}
          undoLabel={snapshot.undoLabel}
          onUndo={() => { void workbench.undo(); }}
          onCapture={capture}
          assistantOpen={assistantOpen}
          onToggleAssistant={() => setAssistantOpen(!assistantOpen)}
          onSettings={actions.openSettings}
        />

        {showBanner ? (
          <div className={styles.banner} role="status">
            <span className={styles.bannerIcon}><Icon icon={LogIn} size={15} /></span>
            <p className={styles.bannerText}>
              <b>{L('还没登录 TokenToSea', 'Not signed in to TokenToSea')}</b>
              <span>{L('写作、生图和导入账号都使用你的 TokenToSea 账户；登录前可以先记灵感、排期和整理。', 'Writing, images and account import run on your TokenToSea account. You can still capture, schedule and organise before signing in.')}</span>
            </p>
            <Button variant="primary" size="sm" loading={signInFlow.phase === 'starting'} onClick={shell.signIn}>
              {signInFlow.phase === 'waiting' ? L('等待授权…', 'Waiting…') : L('登录', 'Sign in')}
            </Button>
          </div>
        ) : null}

        <div
          className={styles.projects}
          data-fx-legacy=""
          hidden={!projectsOpen}
          data-testid="entry-view-projects"
          data-active={projectsOpen && active ? 'true' : 'false'}
        >
          <div className="entry-main__inner entry-main__inner--wide">{projects}</div>
        </div>

        <div className={styles.body} hidden={projectsOpen} data-assistant={dockShown ? 'open' : 'closed'}>
          <div ref={pagesRef} className={styles.pages}>
            {state ? (
              WORKBENCH_PAGES.map((entry) => {
                const Page = PAGES[entry];
                return (
                  <div key={entry} className={styles.page} hidden={entry !== page} data-page={entry}>
                    <Page {...pageProps[entry]} />
                  </div>
                );
              })
            ) : snapshot.status === 'error' ? (
              <div className={styles.center}>
                <EmptyState
                  variant="dashed"
                  title={L('工作台没有连上', 'The workbench did not load')}
                  description={snapshot.error ?? undefined}
                  action={(
                    <Button variant="primary" onClick={() => { void workbench.refresh(); }}>
                      <Icon icon={RefreshCw} size={14} />
                      {L('重试', 'Retry')}
                    </Button>
                  )}
                />
              </div>
            ) : (
              <div className={styles.center} role="status">
                <Spinner size="md" />
                <span className={styles.loadingText}>{L('正在铺开工作台…', 'Laying out the workbench…')}</span>
              </div>
            )}
          </div>

          <div ref={dockRef} className={styles.dock} aria-hidden={dockShown ? undefined : true}>
            <div className={styles.dockInner}>
              {state ? <AssistantPanel draft={assistantDraft} onClose={() => setAssistantOpen(false)} /> : null}
            </div>
          </div>

          {state ? <StudioView itemId={shownItem} open={studioOpen} /> : null}
        </div>

        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
        <ConfirmDialog
          open={confirmSamples}
          onOpenChange={setConfirmSamples}
          title={L('清空示例数据？', 'Clear the sample data?')}
          description={L('示例灵感、内容、数据和风格会被移除，你自己记下的不受影响。可以撤销。', 'Sample ideas, content, data and styles are removed; your own entries stay. You can undo this.')}
          confirmLabel={L('清空示例数据', 'Clear samples')}
          cancelLabel={L('取消', 'Cancel')}
          destructive
          onConfirm={() => { void workbench.ops([{ op: 'clear_samples' }], { label: L('清空示例数据', 'Clear sample data') }); }}
        />
      </div>
    </WorkbenchShellContext.Provider>
  );
}
