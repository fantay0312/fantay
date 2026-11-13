// SPDX-License-Identifier: AGPL-3.0-only
// FantayShell (spec 02 §2, §3, §6 with plans R9/R18 and amendments B5/B6): one wrapper for both worlds.
// App renders `<FantayShell>{appMain}</FantayShell>` instead of `.workspace-shell__body`, so EntryShell, the
// project route (chat column + workspace), settings, marketplace and design-system routes all render in the
// shell's main column, next to the Fantay sidebar. Responsibilities:
// - layout: docked sidebar (248 px, or the 56/76 px rail), overlay sheet below 900 px on the web, chromeless
//   onboarding; one persistent account dock hosting `#workspace-chrome-account-actions` in every mode (B6);
// - commands (newProject, newChat, toggleSidebar, openSettings, search) and shortcuts (mod+\ in the capture
//   phase, ⌘K outside EntryShell; no ⌘B — B5); native menu commands and chrome on desktop;
// - Resources navigation: 素材库 is a full page; project insertion keeps its separate drawer.
// - R18: the Fantay Toaster and (in the account menu) ThemeSegmented.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanelLeft } from 'lucide-react';
import { getOpenDesignHost } from '@open-design/host';

import { useWorkspaceContext } from '../../collab/useWorkspaceContext';
import { ENTRY_SEARCH_OPEN_EVENT, requestEntryNewProject } from '../../components/entryRailBridge';
import { ProjectDeleteConfirmDialog } from '../../components/project-actions/ProjectDeleteConfirmDialog';
import { useProjectDeleteFlow } from '../../components/project-actions/useProjectDeleteFlow';
import { useProjectDuplicateFlow } from '../../components/project-actions/useProjectDuplicateFlow';
import { ProjectSearchModal } from '../../components/ProjectSearchModal';
import type { SettingsSection } from '../../components/SettingsDialog';
import { acknowledgeProjectCompletion } from '../../hooks/useProjectRunStatuses';
import { useI18n } from '../../i18n';
import { navigate, useRoute, type Route } from '../../router';
import type { Project } from '../../types';
import { focusHomeComposer } from '../home/focus-home-composer';
import { setProjectCreatedHook } from '../../state/projects';
import { setNewProjectGroup, useProjectOrganizationActions } from './project-organization-store';
import { closeMaterialsDrawer, useMaterialsDrawer } from '../materials/materials-drawer-store';
import { isMotionProject, motionProjectOpenRoute } from '../motion/motion-projects';
import { useToolPluginRuntimeBoot } from '../plugins/react';
import { cn } from '../ui/cn';
import { FxLegacy } from '../ui/fx';
import { IconButton } from '../ui/icon-button';
import { Icon } from '../ui/icons';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';
import { Toaster } from '../ui/toast';
import { subscribeWorkspaceCommand } from '../workspace/workspace-bus';
import { registerFantayCommand } from './commands';
import { useDesktopShellChrome } from './desktop-chrome';
import {
  SHELL_TOP_ROW_HEIGHT,
  DESKTOP_TOP_ROW_HEIGHT,
  DESKTOP_SIDEBAR_COMPACT_BREAKPOINT,
  DESKTOP_SIDEBAR_MINI_BREAKPOINT,
  SIDEBAR_AUTO_COLLAPSE_BREAKPOINT,
  SIDEBAR_ENTER_MS,
  SIDEBAR_EXIT_MS,
  SIDEBAR_OVERLAY_WIDTH,
  currentSidebarWidth,
  initialSidebarCollapsed,
  sidebarModeFor,
  viewportTierFor,
  type FantayClientType,
  type FantaySidebarMode,
  type FantayViewportTier,
} from './geometry';
import { notifyShellGeometryChange } from './geometry-notify';
import { useShellKeyboard } from './keyboard';
import { runProjectCommand, useActiveProjectSession } from './project-bridge';
import { FantayShellContext, type FantayShellContextValue } from './shell-context';
import {
  expandSidebarSection,
  readStoredSidebarCollapsed,
  requestSidebarReveal,
  writeStoredSidebarCollapsed,
  type FantaySidebarSectionId,
} from './sidebar-store';
import { Sidebar } from './sidebar/Sidebar';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarRail } from './sidebar/SidebarRail';
import type { SidebarShellApi } from './sidebar/sidebar-api';
import type { SidebarProjectActions } from './sidebar/SidebarProjectRow';
import { isChromelessRoute, isEntryShellRoute } from './sidebar/sidebar-model';
import './split-policy';
import { withBrandName } from '../../components/BrandName';
import styles from './FantayShell.module.css';

/** A "new chat in this project" waits at most this long for the project's ProjectView to publish. */
const PENDING_NEW_CHAT_TTL_MS = 20_000;

/* Popovers over desktop drag rows must stay clickable on Windows (spec 02 §10.1). Module CSS must be pure
   (scoped to a local class), and these layers are portalled to <body>, so the rule ships as a global style. */
const DESKTOP_NO_DRAG_CSS =
  "[data-radix-popper-content-wrapper],[role='dialog'],[role='menu'],[role='listbox']{-webkit-app-region:no-drag}";

export interface FantayShellProps {
  /** App `clientType` ('desktop' | 'web'; anything else is treated as web). */
  clientType: string;
  /** 'darwin' | 'win32' | 'linux' | undefined (web). */
  hostPlatform: string | undefined;
  /** App `workspaceChromeProjects` (already route-reconciled). */
  projects: readonly Project[];
  projectsLoading: boolean;
  onOpenProject: (id: string, fileName?: string) => Promise<boolean> | boolean | void;
  onRenameProject: (id: string, name: string) => Promise<unknown> | void;
  onDuplicateProject: (id: string) => Promise<unknown> | void;
  onDeleteProject: (id: string) => Promise<boolean | void> | boolean | void;
  onOpenSettings: (section?: SettingsSection) => void;
  /** appMain */
  children: ReactNode;
}

function readInnerWidth(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

function isWindowFullscreen(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('is-window-fullscreen');
}

export function FantayShell(props: FantayShellProps) {
  const { hostPlatform, projects, projectsLoading, children } = props;
  const clientType: FantayClientType = props.clientType === 'desktop' ? 'desktop' : 'web';
  const route = useRoute();
  const { t, locale } = useI18n();
  const workspaceContext = useWorkspaceContext().context;
  const materials = useMaterialsDrawer();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chromeless = isChromelessRoute(route);
  const entryShellMounted = isEntryShellRoute(route);

  const [mode, setMode] = useState<FantaySidebarMode>(() => sidebarModeFor(readInnerWidth(), clientType));
  const [viewportTier, setViewportTier] = useState<FantayViewportTier>(() => viewportTierFor(readInnerWidth()));
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    initialSidebarCollapsed(readStoredSidebarCollapsed(), readInnerWidth()),
  );
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [workspaceMaximized, setWorkspaceMaximized] = useState(false);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
  const workspaceMaximizedRef = useRef(workspaceMaximized);
  workspaceMaximizedRef.current = workspaceMaximized;

  // Latest values for the stable callbacks below (commands, shortcuts and the bus outlive renders).
  const propsRef = useRef(props);
  propsRef.current = props;
  const routeRef = useRef<Route>(route);
  routeRef.current = route;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const autoCollapsedRef = useRef(
    readInnerWidth() < DESKTOP_SIDEBAR_COMPACT_BREAKPOINT && readStoredSidebarCollapsed() === false,
  );
  const lastWidthRef = useRef(readInnerWidth());

  // Sidebar mode & responsive morphology tier follow the window (rAF-throttled);
  // crossing compact/mini breakpoints auto-collapses the sidebar to the rail, and widening restores it.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let frame: number | null = null;
    const measure = (initial = false) => {
      frame = null;
      const width = window.innerWidth;
      const prevWidth = lastWidthRef.current;
      lastWidthRef.current = width;
      const next = sidebarModeFor(width, clientType);
      setMode((previous) => (previous === next ? previous : next));
      const nextTier = viewportTierFor(width);
      setViewportTier((previous) => (previous === nextTier ? previous : nextTier));

      const crossedDownCompact =
        width < DESKTOP_SIDEBAR_COMPACT_BREAKPOINT && (initial || prevWidth >= DESKTOP_SIDEBAR_COMPACT_BREAKPOINT);
      const crossedDownMini =
        width < DESKTOP_SIDEBAR_MINI_BREAKPOINT && (initial || prevWidth >= DESKTOP_SIDEBAR_MINI_BREAKPOINT);
      if ((crossedDownCompact || crossedDownMini) && !collapsedRef.current) {
        autoCollapsedRef.current = true;
        collapsedRef.current = true;
        setCollapsed(true);
      } else if (
        width >= SIDEBAR_AUTO_COLLAPSE_BREAKPOINT &&
        prevWidth < SIDEBAR_AUTO_COLLAPSE_BREAKPOINT &&
        autoCollapsedRef.current &&
        collapsedRef.current
      ) {
        autoCollapsedRef.current = false;
        collapsedRef.current = false;
        setCollapsed(false);
      }
    };
    measure(true);
    const onResize = () => {
      if (frame !== null) return;
      frame = typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(() => measure(false))
        : window.setTimeout(() => measure(false), 16);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (frame !== null) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
        else window.clearTimeout(frame);
      }
    };
  }, [clientType]);

  useEffect(() => {
    if (mode !== 'overlay') setOverlayOpen(false);
  }, [mode]);

  // Keep the body-portalled chat composer glued to the moving column while the rail animates.
  const firstCollapsedRender = useRef(true);
  useEffect(() => {
    if (firstCollapsedRender.current) {
      firstCollapsedRender.current = false;
      return undefined;
    }
    return notifyShellGeometryChange(collapsed ? SIDEBAR_EXIT_MS : SIDEBAR_ENTER_MS, rootRef.current);
  }, [collapsed]);

  // Geometry for surfaces rendered outside the shell root (07's materials drawer, W3 hosts).
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    let published = '';
    const publish = () => {
      const width = currentSidebarWidth({
        mode,
        collapsed,
        chromeless: chromeless || workspaceMaximized,
        clientType,
        hostPlatform,
        fullscreen: isWindowFullscreen(),
      });
      const value = `${width}px`;
      if (value === published) return;
      published = value;
      root.style.setProperty('--fx-sidebar-w', value);
      root.style.setProperty('--fx-shell-header-h', `${clientType === 'desktop' ? DESKTOP_TOP_ROW_HEIGHT : SHELL_TOP_ROW_HEIGHT}px`);
    };
    publish();
    window.addEventListener('resize', publish);
    const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(publish) : null;
    observer?.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => {
      window.removeEventListener('resize', publish);
      observer?.disconnect();
    };
  }, [mode, collapsed, chromeless, workspaceMaximized, clientType, hostPlatform]);

  useLayoutEffect(
    () => () => {
      if (typeof document === 'undefined') return;
      document.documentElement.style.removeProperty('--fx-sidebar-w');
      document.documentElement.style.removeProperty('--fx-shell-header-h');
    },
    [],
  );

  const setSidebarCollapsed = useCallback((next: boolean) => {
    autoCollapsedRef.current = false;
    if (collapsedRef.current === next) return;
    collapsedRef.current = next;
    writeStoredSidebarCollapsed(next);
    setCollapsed(next);
  }, []);

  const collapseMiniDrawerIfNeeded = useCallback(() => {
    setOverlayOpen(false);
    if (readInnerWidth() < DESKTOP_SIDEBAR_MINI_BREAKPOINT && !collapsedRef.current) {
      autoCollapsedRef.current = true;
      collapsedRef.current = true;
      setCollapsed(true);
    }
  }, []);

  // Maximizing and collapsing belong to the project they happened in.
  const maximizeScope = route.kind === 'project' ? route.projectId : null;
  useEffect(() => {
    setWorkspaceMaximized(false);
    setWorkspaceCollapsed(false);
  }, [maximizeScope]);

  const toggleSidebar = useCallback(() => {
    if (workspaceMaximizedRef.current) {
      setWorkspaceMaximized(false);
      return;
    }
    if (modeRef.current === 'overlay') {
      setOverlayOpen((open) => !open);
      return;
    }
    setSidebarCollapsed(!collapsedRef.current);
  }, [setSidebarCollapsed]);

  const openSettings = useCallback((section?: SettingsSection) => {
    setOverlayOpen(false);
    if (section === undefined) propsRef.current.onOpenSettings();
    else propsRef.current.onOpenSettings(section);
  }, []);

  const openSearch = useCallback(() => {
    setOverlayOpen(false);
    if (isEntryShellRoute(routeRef.current)) {
      window.dispatchEvent(new CustomEvent(ENTRY_SEARCH_OPEN_EVENT));
      return;
    }
    setSearchOpen(true);
  }, []);

  const openHomeComposer = useCallback(() => {
    collapseMiniDrawerIfNeeded();
    navigate({ kind: 'home', view: 'home' });
    focusHomeComposer();
  }, [collapseMiniDrawerIfNeeded]);

  const newProject = useCallback(() => {
    setNewProjectGroup(null);
    collapseMiniDrawerIfNeeded();
    requestEntryNewProject();
    navigate({ kind: 'home', view: 'home' });
  }, [collapseMiniDrawerIfNeeded]);

  const newProjectInGroup = useCallback((groupId: string) => {
    setNewProjectGroup(groupId);
    collapseMiniDrawerIfNeeded();
    requestEntryNewProject();
    navigate({ kind: 'home', view: 'home' });
  }, [collapseMiniDrawerIfNeeded]);

  // A new project goes to a group only from the Home visit that was opened for it.
  const onHome = route.kind === 'home' && route.view === 'home';
  useEffect(() => {
    if (!onHome) setNewProjectGroup(null);
  }, [onHome]);

  const organization = useProjectOrganizationActions();
  useEffect(() => {
    setProjectCreatedHook(organization.placeCreatedProject);
    return () => setProjectCreatedHook(null);
  }, [organization]);

  const newChat = useCallback(() => {
    const current = routeRef.current;
    if (current.kind === 'project' && runProjectCommand(current.projectId, { kind: 'newConversation' })) {
      collapseMiniDrawerIfNeeded();
      return;
    }
    setNewProjectGroup(null);
    openHomeComposer();
  }, [collapseMiniDrawerIfNeeded, openHomeComposer]);

  const go = useCallback((target: Route) => {
    collapseMiniDrawerIfNeeded();
    navigate(target);
  }, [collapseMiniDrawerIfNeeded]);

  const openMaterials = useCallback(() => {
    collapseMiniDrawerIfNeeded();
    closeMaterialsDrawer();
    navigate({ kind: 'home', view: 'materials' });
  }, [collapseMiniDrawerIfNeeded]);

  const revealSection = useCallback(
    (section: FantaySidebarSectionId) => {
      expandSidebarSection(section);
      if (modeRef.current === 'overlay') setOverlayOpen(true);
      else setSidebarCollapsed(false);
      requestSidebarReveal(section);
    },
    [setSidebarCollapsed],
  );

  // Shell commands: menu accelerators, the web keyboard and other surfaces reach the shell through these.
  useEffect(() => {
    const unregister = [
      registerFantayCommand('fantay.newProject', () => newProject()),
      registerFantayCommand('fantay.newChat', () => newChat()),
      registerFantayCommand('fantay.toggleSidebar', () => toggleSidebar()),
      registerFantayCommand('fantay.openSettings', () => openSettings()),
      registerFantayCommand('fantay.search', () => openSearch()),
    ];
    return () => {
      for (const off of unregister) off();
    };
  }, [newProject, newChat, toggleSidebar, openSettings, openSearch]);

  useShellKeyboard({
    enabled: !chromeless,
    entryShellMounted,
    onToggleSidebar: toggleSidebar,
    onSearch: openSearch,
    menuOwnsToggle: () => Boolean(getOpenDesignHost()?.menu),
  });

  useDesktopShellChrome({ clientType, hostPlatform, rootRef, locale, t });
  useToolPluginRuntimeBoot();

  // 07 workspace bus: reveal a sidebar section (e.g. `/movies` lands home and focuses 视频与动画).
  useEffect(
    () =>
      subscribeWorkspaceCommand('sidebar.focus', () => {
        revealSection('projects');
        return true;
      }),
    [revealSection],
  );

  // Project actions: one delete confirmation and one duplicate path for every row (and the phone sheet).
  const deleteFlow = useProjectDeleteFlow({
    onDelete: props.onDeleteProject,
    analyticsPage: 'home',
    workspaceContext,
  });
  const { duplicate } = useProjectDuplicateFlow({
    onDuplicate: async (id) => {
      await propsRef.current.onDuplicateProject(id);
    },
    analyticsPage: 'home',
    workspaceContext,
  });
  const duplicateRef = useRef(duplicate);
  duplicateRef.current = duplicate;
  const requestDelete = deleteFlow.request;

  // "New chat in this project" from a row menu: run it now when that project is open, else open it and run
  // it once its ProjectView publishes the session.
  const pendingNewChat = useRef<{ projectId: string; at: number } | null>(null);
  const liveSession = useActiveProjectSession();
  useEffect(() => {
    const pending = pendingNewChat.current;
    if (!pending || !liveSession || liveSession.projectId !== pending.projectId) return;
    // A project publishes before it has picked a conversation and while its access is still resolving, and it reads as
    // read-only until then. Hold the request until it can be acted on, or it is spent on a session that drops it. One
    // that really is read-only never gets there, and the request lapses with its TTL.
    if (!liveSession.activeConversationId || liveSession.readOnly) return;
    pendingNewChat.current = null;
    if (Date.now() - pending.at > PENDING_NEW_CHAT_TTL_MS) return;
    runProjectCommand(pending.projectId, { kind: 'newConversation' });
  }, [liveSession]);

  const newChatInProject = useCallback((projectId: string) => {
    setOverlayOpen(false);
    if (runProjectCommand(projectId, { kind: 'newConversation' })) return;
    pendingNewChat.current = { projectId, at: Date.now() };
    // Same door as the row itself: a motion project opens on its film editor file.
    const project = propsRef.current.projects.find((item) => item.id === projectId);
    const fileName = project && isMotionProject(project) ? motionProjectOpenRoute(project).fileName ?? undefined : undefined;
    const opened = fileName === undefined
      ? propsRef.current.onOpenProject(projectId)
      : propsRef.current.onOpenProject(projectId, fileName);
    void Promise.resolve(opened).catch(() => {
      pendingNewChat.current = null;
    });
  }, []);

  const projectActions = useMemo<SidebarProjectActions>(
    () => ({
      rename: (projectId, name) => {
        return Promise.resolve(propsRef.current.onRenameProject(projectId, name)).then(() => undefined);
      },
      duplicate: (project) => {
        setOverlayOpen(false);
        void duplicateRef.current(project);
      },
      requestDelete: (project) => {
        setOverlayOpen(false);
        requestDelete(project);
      },
      newChatInProject,
    }),
    [newChatInProject, requestDelete],
  );

  const openProject = useCallback((project: Project) => {
    setOverlayOpen(false);
    acknowledgeProjectCompletion(project.id);
    // R9: motion projects open on 07's route (fantay-movie → the film editor file).
    const fileName = isMotionProject(project) ? motionProjectOpenRoute(project).fileName ?? undefined : undefined;
    void Promise.resolve(propsRef.current.onOpenProject(project.id, fileName)).catch(() => undefined);
  }, []);

  const selectConversation = useCallback((projectId: string, conversationId: string) => {
    setOverlayOpen(false);
    if (runProjectCommand(projectId, { kind: 'selectConversation', conversationId })) return;
    navigate({ kind: 'project', projectId, conversationId, fileName: null });
  }, []);

  const routeSession = useActiveProjectSession(route.kind === 'project' ? route.projectId : '\u0000');
  const newChatDisabled = route.kind === 'project' && Boolean(routeSession?.readOnly);

  const api = useMemo<SidebarShellApi>(
    () => ({
      route,
      projects,
      projectsLoading,
      workspaceContext,
      clientType,
      hostPlatform,
      mode,
      materialsOpen: materials.open,
      newChatDisabled,
      toggleSidebar,
      openSearch,
      openSettings,
      newChat,
      newProject,
      newProjectInGroup,
      go,
      openProject,
      selectConversation,
      openMaterials,
      revealSection,
      projectActions,
    }),
    [
      route,
      projects,
      projectsLoading,
      workspaceContext,
      clientType,
      hostPlatform,
      mode,
      materials.open,
      newChatDisabled,
      toggleSidebar,
      openSearch,
      openSettings,
      newChat,
      newProject,
      newProjectInGroup,
      go,
      openProject,
      selectConversation,
      openMaterials,
      revealSection,
      projectActions,
    ],
  );

  const contextValue = useMemo<FantayShellContextValue>(
    () => ({
      sidebarCollapsed: collapsed,
      sidebarMode: mode,
      toggleSidebar,
      setSidebarCollapsed,
      workspaceMaximized,
      setWorkspaceMaximized,
      workspaceCollapsed,
      setWorkspaceCollapsed,
      openMaterials,
      closeMaterials: closeMaterialsDrawer,
      materialsOpen: materials.open,
      openAccountServices: () => openSettings('account'),
      openSearch,
      newChat,
      newProject,
    }),
    [collapsed, mode, toggleSidebar, setSidebarCollapsed, workspaceMaximized, workspaceCollapsed, openMaterials, materials.open, openSettings, openSearch, newChat, newProject],
  );

  const overlay = !chromeless && mode === 'overlay';

  return (
    <FantayShellContext.Provider value={contextValue}>
      <div
        ref={rootRef}
        className={styles.root}
        data-fantay-shell=""
        data-testid="fantay-shell"
        data-client-type={clientType}
        data-host-platform={hostPlatform ?? 'web'}
        data-sidebar={collapsed ? 'collapsed' : 'expanded'}
        data-sidebar-mode={mode}
        data-workspace-maximized={workspaceMaximized ? '' : undefined}
        data-viewport-tier={viewportTier}
        data-route-kind={route.kind}
        data-chromeless={chromeless ? '' : undefined}
      >
        {!chromeless && mode === 'docked' ? (
          <Sidebar key="sidebar" api={api} collapsed={collapsed} className={styles.sidebar} />
        ) : null}
        {overlay ? (
          <div key="overlay-open" className={cn('fx', styles.overlayOpen)}>
            <IconButton
              aria-label={t('fantayShell.sidebar.openSidebar')}
              aria-expanded={overlayOpen}
              tooltipSide="bottom"
              data-testid="fantay-sidebar-overlay-open"
              onClick={() => setOverlayOpen(true)}
            >
              <Icon icon={PanelLeft} size={16} />
            </IconButton>
          </div>
        ) : null}
        {overlay ? (
          <div key="overlay-bar" className={cn('fx', styles.overlayBar)}>
            <img src="/app-icon-small.svg" width={20} height={20} alt="" className="size-5 flex-none" draggable={false} />
            <span className="min-w-0 truncate text-label font-medium text-ink">{withBrandName(t('app.brand'))}</span>
          </div>
        ) : null}
        {/* B6: the one account-actions host — same parent, same position, in every sidebar mode. */}
        <div key="dock" className={styles.dock} data-testid="fantay-sidebar-dock">
          <SidebarFooter
            mode={mode}
            collapsed={collapsed}
            workspaceContext={workspaceContext}
            onOpenSettings={openSettings}
          />
        </div>
        <div key="main" className={styles.main} data-testid="fantay-shell-main">
          {clientType === 'desktop' && mode !== 'overlay' && route.kind !== 'project' ? (
            <div className={styles.mainDragStrip} aria-hidden />
          ) : null}
          {children}
        </div>
        {/* Chromium resolves -webkit-app-region in tree order, so the rail's no-drag only wins when it follows the
            main column's drag rows; rendered inside the sidebar, the window swallowed every click on it. */}
        {!chromeless && mode === 'docked' && collapsed ? <SidebarRail key="rail" api={api} className={styles.rail} /> : null}
        {overlay ? (
          <Sheet key="overlay-sheet" open={overlayOpen} onOpenChange={setOverlayOpen}>
            <SheetContent
              side="left"
              width={SIDEBAR_OVERLAY_WIDTH}
              showCloseButton={false}
              aria-describedby={undefined}
              data-testid="fantay-sidebar-sheet"
              className="gap-0 overflow-hidden bg-sidebar p-0"
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              <SheetTitle className="sr-only">{t('fantayShell.sidebar.label')}</SheetTitle>
              <Sidebar api={api} collapsed={false} className="h-full" />
            </SheetContent>
          </Sheet>
        ) : null}
        {searchOpen ? (
          <ProjectSearchModal
            projects={[...projects]}
            workspaceContext={workspaceContext}
            onOpenProject={(id) => propsRef.current.onOpenProject(id)}
            onClose={() => setSearchOpen(false)}
          />
        ) : null}
        {deleteFlow.target ? (
          <FxLegacy>
            <ProjectDeleteConfirmDialog
              projectName={deleteFlow.target.name}
              activeShareCount={deleteFlow.activeShareCount}
              shareReadStatus={deleteFlow.shareReadStatus}
              onRetry={deleteFlow.retryShareRead}
              pending={deleteFlow.pending}
              failed={deleteFlow.failed}
              errorMessage={deleteFlow.errorMessage}
              onCancel={deleteFlow.cancel}
              onConfirm={() => void deleteFlow.commit()}
            />
          </FxLegacy>
        ) : null}
        {clientType === 'desktop' ? <style>{DESKTOP_NO_DRAG_CSS}</style> : null}
        <Toaster />
      </div>
    </FantayShellContext.Provider>
  );
}
