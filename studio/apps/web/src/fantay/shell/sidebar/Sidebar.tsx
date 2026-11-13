/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/AppRail.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (structure only)
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the wide/narrow switch, the
 *   section rhythm and the phone drawer are kept; every row and all data are Fantay's — new chat,
 *   主页, 工作台, 素材库, 插件, 自动化, 社区, then 置顶, the owner's groups and 项目 (every kind, marked) with live run status and lazy chats, and 已归档 — and the account face lives in the shell's persistent dock
 *   (amendment B6).
 */
import { useEffect, useMemo, useState } from 'react';

import { useT } from '../../../i18n';
import { PaNavIcon } from '../../pa/PaNavIcon';
import { PaNavigationLabel } from '../../pa/PaNavigationLabel';
import { useProjectRunStatuses } from '../../../hooks/useProjectRunStatuses';
import type { Project } from '../../../types';
import { PluginSidebarFooterActions } from '../../plugins/HarnessSlots';
import { PluginBoundary, usePluginNavItems } from '../../plugins/react';
import { useActiveProjectSession } from '../project-bridge';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { FeatureIcon } from '../../ui/feature-icon';
import { KbdCombo } from '../../ui/kbd';
import {
  requestArchivedProjectsView,
  useProjectOrganization,
  useProjectOrganizationActions,
} from '../project-organization-store';
import {
  acknowledgeSidebarReveal,
  setSidebarProjectExpanded,
  toggleSidebarSection,
  useSidebarStore,
  type FantaySidebarSectionId,
} from '../sidebar-store';
import { DashNavItem, DashSidebar } from './dash';
import type { SidebarShellApi } from './sidebar-api';
import {
  activeProjectIdFor,
  isSidebarNavItemActive,
  sidebarLayout,
  sidebarLayoutProjects,
  sortConversations,
} from './sidebar-model';
import { GroupNameDialog, NewGroupButton, SidebarGroupSection } from './SidebarGroup';
import { SidebarHeader } from './SidebarHeader';
import { SidebarProjectList } from './SidebarProjectList';
import type { SidebarConversationListState } from './SidebarProjectRow';
import { SidebarSection } from './SidebarSection';
import { getSidebarConversations, loadSidebarConversations, useSidebarConversations } from './use-sidebar-conversations';
import { SidebarConversationRow } from './SidebarConversationRow';
import { conversationStatusTone, conversationToneStatus } from './sidebar-model';
import { STATUS_LABEL_KEYS } from '../../../state/projectRunStatus';

const EMPTY_RUNNING: ReadonlySet<string> = new Set();
const NO_SESSION_PROJECT = '\u0000';

export interface SidebarProps {
  api: SidebarShellApi;
  /** Folded to nothing (docked mode only). */
  collapsed: boolean;
  className?: string;
}

/** The sidebar column: the expanded panel; empty when collapsed, where the shell shows SidebarRail instead. */
export function Sidebar({ api, collapsed, className }: SidebarProps) {
  const t = useT();
  return (
    <DashSidebar
      aria-label={t('fantayShell.sidebar.label')}
      data-testid="fantay-sidebar"
      data-sidebar-variant={api.mode}
      data-collapsed={collapsed ? '' : undefined}
      className={cn(collapsed && 'overflow-visible bg-transparent', className)}
    >
      {collapsed ? null : <SidebarPanel api={api} />}
    </DashSidebar>
  );
}

function SidebarPanel({ api }: { api: SidebarShellApi }) {
  const t = useT();
  const store = useSidebarStore();
  const { route } = api;
  const activeProjectId = activeProjectIdFor(route);
  const session = useActiveProjectSession(activeProjectId ?? NO_SESSION_PROJECT);
  const { groups, entries, conversationSections } = useProjectOrganization();
  const organization = useProjectOrganizationActions();
  // The project a new group is created for (null: none), or undefined while the new-group dialog is closed.
  const [newGroupFor, setNewGroupFor] = useState<string | null | undefined>(undefined);

  const layout = useMemo(
    () => sidebarLayout(api.projects, groups, entries, activeProjectId),
    [api.projects, groups, entries, activeProjectId],
  );
  const visibleIds = useMemo(() => sidebarLayoutProjects(layout).map((project) => project.id), [layout]);
  const sectionProjectIds = useMemo(() => [...new Set(conversationSections
    .filter(item => api.projects.some(project => project.id === item.projectId)
      && entries.get(item.projectId)?.removedAt == null && entries.get(item.projectId)?.archivedAt == null)
    .map(item => item.projectId))], [conversationSections, api.projects, entries]);
  const statuses = useProjectRunStatuses(visibleIds, { workspaceContext: api.workspaceContext });

  const expandedSet = useMemo(() => new Set(store.expandedProjects), [store.expandedProjects]);
  // The open project shows its chats (02 §11.4), but its chevron still folds it; opening another project
  // (or coming back) starts expanded again.
  const [foldedActiveId, setFoldedActiveId] = useState<string | null>(null);
  useEffect(() => {
    setFoldedActiveId(null);
  }, [activeProjectId]);
  const isExpanded = (projectId: string) =>
    projectId === activeProjectId ? foldedActiveId !== projectId : expandedSet.has(projectId);
  // The open project's chats come live from ProjectView; the other expanded ones are fetched on expand,
  // and any expanded project (including the active one) refreshes when its run status changes.
  const fetchIds = useMemo(
    () => [...new Set([...visibleIds.filter(id => expandedSet.has(id)), ...sectionProjectIds])].filter(id => id !== activeProjectId),
    [visibleIds, activeProjectId, expandedSet, sectionProjectIds],
  );
  const statusIds = useMemo(
    () => visibleIds.filter((id) => (id === activeProjectId ? foldedActiveId !== activeProjectId : expandedSet.has(id))),
    [visibleIds, activeProjectId, foldedActiveId, expandedSet],
  );
  const statusKey = statusIds.map((id) => `${id}:${statuses.get(id) ?? ''}`).join('|');
  const fetched = useSidebarConversations(fetchIds, { workspaceContext: api.workspaceContext, statusKey });
  const activeFetched = activeProjectId ? getSidebarConversations(activeProjectId, api.workspaceContext) : undefined;

  const sessionState = useMemo<SidebarConversationListState | null>(() => {
    if (!session) return null;
    return {
      status: 'ready',
      conversations: sortConversations(session.conversations),
      runningIds: new Set(session.runningConversationIds),
      activeConversationId: session.activeConversationId,
    };
  }, [session]);

  const conversationsFor = (projectId: string): SidebarConversationListState => {
    if (projectId === activeProjectId) {
      if (sessionState) {
        if (activeFetched?.status === 'ready' && activeFetched.conversations.length > 0) {
          const byId = new Map(sessionState.conversations.map((conv) => [conv.id, conv]));
          for (const conv of activeFetched.conversations) {
            const current = byId.get(conv.id);
            if (!current || conv.updatedAt >= current.updatedAt) {
              byId.set(conv.id, conv);
            }
          }
          return {
            ...sessionState,
            conversations: sortConversations([...byId.values()]),
          };
        }
        return sessionState;
      }
      return {
        status: 'loading',
        conversations: [],
        runningIds: EMPTY_RUNNING,
        activeConversationId: route.kind === 'project' ? route.conversationId ?? null : null,
      };
    }
    const entry = fetched.get(projectId);
    return {
      status: entry?.status ?? 'idle',
      conversations: entry ? sortConversations(entry.conversations) : [],
      runningIds: EMPTY_RUNNING,
      activeConversationId: null,
    };
  };

  const toggleExpanded = (projectId: string) => {
    if (projectId === activeProjectId) {
      setFoldedActiveId((current) => (current === projectId ? null : projectId));
      return;
    }
    setSidebarProjectExpanded(projectId, !expandedSet.has(projectId));
  };
  const retry = (projectId: string) => {
    void loadSidebarConversations(projectId, api.workspaceContext);
  };

  const revealNonceFor = (section: FantaySidebarSectionId) =>
    store.reveal && store.reveal.section === section ? store.reveal.nonce : null;
  const sectionProps = (section: FantaySidebarSectionId) => ({
    id: section,
    collapsed: store.collapsedSections[section] === true,
    onToggle: () => toggleSidebarSection(section),
    revealNonce: revealNonceFor(section),
    onRevealed: acknowledgeSidebarReveal,
  });
  const navActive = (item: Parameters<typeof isSidebarNavItemActive>[0]) =>
    isSidebarNavItemActive(item, route, api.materialsOpen);
  // Pages enabled tool plugins add (工具台 …) follow Fantay's own destinations.
  const pluginNav = usePluginNavItems();

  const listProps = {
    loading: api.projectsLoading,
    activeProjectId,
    isExpanded,
    statuses,
    conversationsFor,
    // The open project's row has nothing left to open, so a click folds or unfolds its chats instead.
    onOpenProject: (project: Project) => {
      if (project.id === activeProjectId) toggleExpanded(project.id);
      else api.openProject(project);
    },
    onToggleExpanded: toggleExpanded,
    onSelectConversation: api.selectConversation,
    onRetryConversations: retry,
    actions: api.projectActions,
    onRequestNewGroup: setNewGroupFor,
  };
  const sectionConversations = (groupId: string) => sortConversations(sectionProjectIds.flatMap(projectId =>
    conversationsFor(projectId).conversations.filter(conversation => conversation.groupId === groupId && conversation.archivedAt == null)));

  return (
    <>
      <SidebarHeader onSearch={api.openSearch} onCollapse={api.toggleSidebar} />
      <div className="fx flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-3 pb-3" data-testid="fantay-sidebar-body">
        <nav aria-label={t('fantayShell.sidebar.label')} className="flex flex-col">
          <Button
            variant="default"
            size="md"
            block
            disabled={api.newChatDisabled}
            data-testid="fantay-sidebar-new-chat"
            className="mb-2 mt-1 justify-start gap-2 px-[11px] [&>[data-slot=button-label]]:flex-1"
            onClick={api.newChat}
          >
            <FeatureIcon name="newChat" slot={16} />
            <span className="min-w-0 flex-1 truncate text-start">{t('fantayShell.sidebar.newChat')}</span>
            {api.clientType === 'desktop' ? <KbdCombo shortcut="mod+n" variant="plain" /> : null}
          </Button>
          <DashNavItem
            data-sidebar-row=""
            data-testid="fantay-sidebar-pa"
            icon={<PaNavIcon size={16} />}
            active={navActive('pa')}
            onClick={() => api.go({ kind: 'home', view: 'pa' })}
          >
            <PaNavigationLabel />
          </DashNavItem>
          <DashNavItem
            data-sidebar-row=""
            data-testid="fantay-sidebar-home"
            icon={<FeatureIcon name="home" slot={15} />}
            active={navActive('home')}
            onClick={() => api.go({ kind: 'home', view: 'home' })}
          >
            {t('entry.navHome')}
          </DashNavItem>

          <ul className="m-0 mt-0.5 flex flex-col gap-0.5 p-0" role="list">
            <li className="list-none">
              <DashNavItem
                data-sidebar-row=""
                data-testid="fantay-sidebar-workbench"
                icon={<FeatureIcon name="workbench" slot={15} />}
                active={navActive('workbench')}
                onClick={() => api.go({ kind: 'home', view: 'workbench' })}
              >
                {t('fantayShell.sidebar.workbench')}
              </DashNavItem>
            </li>
            <li className="list-none">
              <DashNavItem
                data-sidebar-row=""
                data-testid="fantay-sidebar-materials"
                icon={<FeatureIcon name="materials" slot={15} />}
                active={navActive('materials')}
                onClick={api.openMaterials}
              >
                {t('entry.navMaterials')}
              </DashNavItem>
            </li>
            <li className="list-none">
              <DashNavItem
                data-sidebar-row=""
                data-testid="fantay-sidebar-plugins"
                icon={<FeatureIcon name="plugins" slot={15} />}
                active={navActive('plugins')}
                onClick={() => api.go({ kind: 'home', view: 'plugins' })}
              >
                {t('entry.navPlugins')}
              </DashNavItem>
            </li>
            <li className="list-none">
              <DashNavItem
                data-sidebar-row=""
                data-testid="fantay-sidebar-automations"
                icon={<FeatureIcon name="automations" slot={15} />}
                active={navActive('automations')}
                onClick={() => api.go({ kind: 'home', view: 'tasks' })}
              >
                {t('entry.navTasks')}
              </DashNavItem>
            </li>
            <li className="list-none">
              <DashNavItem
                data-sidebar-row=""
                data-testid="fantay-sidebar-community"
                icon={<FeatureIcon name="community" slot={15} />}
                active={navActive('community')}
                onClick={() => api.go({ kind: 'home', view: 'community' })}
              >
                {t('pluginsHome.title')}
              </DashNavItem>
            </li>
            {pluginNav.map((item) => {
              const PluginIcon = item.icon;
              return (
                <li key={`${item.pluginId}/${item.pageId}`} className="list-none">
                  <DashNavItem
                    data-sidebar-row=""
                    data-testid="fantay-sidebar-plugin-page"
                    data-plugin={item.pluginId}
                    icon={(
                      <span className="flex size-[15px] flex-none items-center justify-center">
                        {PluginIcon ? (
                          <PluginBoundary fallback={<FeatureIcon name="plugins" slot={15} />}>
                            <PluginIcon size={15} />
                          </PluginBoundary>
                        ) : <FeatureIcon name="plugins" slot={15} />}
                      </span>
                    )}
                    active={route.kind === 'tool' && route.pluginId === item.pluginId && route.pageId === item.pageId}
                    onClick={() => api.go({ kind: 'tool', pluginId: item.pluginId, pageId: item.pageId })}
                  >
                    {item.title}
                  </DashNavItem>
                </li>
              );
            })}
          </ul>

          {layout.pinned.length > 0 ? (
            <SidebarSection
              {...sectionProps('pinned')}
              label={t('fantayShell.sidebar.pinned')}
              onDropProject={(projectId) => organization.organize(projectId, { pinned: true })}
            >
              <SidebarProjectList {...listProps} projects={layout.pinned} emptyLabel={null} />
            </SidebarSection>
          ) : null}

          {layout.groups.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1">
              {layout.groups.map(({ group, projects }, index) => (
                <SidebarGroupSection
                  key={group.id}
                  {...sectionProps(`group:${group.id}`)}
                  group={group}
                  first={index === 0}
                  last={index === layout.groups.length - 1}
                  onDropProject={(projectId) => organization.organize(projectId, { groupId: group.id, pinned: false })}
                  onNewProject={() => api.newProjectInGroup(group.id)}
                >
                  <SidebarProjectList {...listProps} nested projects={projects} emptyLabel={sectionConversations(group.id).length ? null : t('fantayShell.sidebar.emptyGroup')} />
                  <ul className="m-0 list-none p-0">
                    {sectionConversations(group.id).map(conversation => {
                      const state = conversationsFor(conversation.projectId);
                      const tone = conversationStatusTone(conversation, state.runningIds);
                      const status = conversationToneStatus(tone);
                      return <li key={conversation.id}>
                        <SidebarConversationRow conversation={conversation} tone={tone}
                          toneLabel={status ? t(STATUS_LABEL_KEYS[status]) : undefined}
                          active={state.activeConversationId === conversation.id}
                          onSelect={() => api.selectConversation(conversation.projectId, conversation.id)} />
                      </li>;
                    })}
                  </ul>
                </SidebarGroupSection>
              ))}
            </div>
          ) : null}

          <SidebarSection
            {...sectionProps('projects')}
            label={t('entry.navProjects')}
            add={{ label: t('entry.navNewProject'), onClick: api.newProject }}
            actions={<NewGroupButton onClick={() => setNewGroupFor(null)} />}
            onDropProject={(projectId) => organization.organize(projectId, { groupId: null, pinned: false })}
          >
            <SidebarProjectList
              {...listProps}
              projects={layout.projects}
              emptyLabel={visibleIds.length > 0 ? null : t('fantayShell.sidebar.emptyProjects')}
            />
          </SidebarSection>

          {layout.archivedCount > 0 ? (
            <DashNavItem
              data-sidebar-row=""
              data-testid="fantay-sidebar-archived"
              icon={<FeatureIcon name="archived" slot={15} />}
              trailing={<span className="text-label text-ink-faint">{layout.archivedCount}</span>}
              className="mt-2"
              onClick={() => {
                requestArchivedProjectsView();
                api.go({ kind: 'home', view: 'projects' });
              }}
            >
              {t('fantayShell.sidebar.archived')}
            </DashNavItem>
          ) : null}
        </nav>
      </div>
      {/* Actions DeepSeek Harness plugins put at the sidebar foot; they sit right above the account dock. */}
      <PluginSidebarFooterActions />
      <GroupNameDialog
        open={newGroupFor !== undefined}
        title={t('fantayShell.sidebar.newGroup')}
        description={t('fantayShell.sidebar.newGroupHint')}
        confirmLabel={t('fantayShell.sidebar.createGroup')}
        testId="fantay-sidebar-new-group-name"
        onClose={() => setNewGroupFor(undefined)}
        onSubmit={(name) => {
          organization.createGroup(name, newGroupFor ?? undefined);
          setNewGroupFor(undefined);
        }}
      />
    </>
  );
}
