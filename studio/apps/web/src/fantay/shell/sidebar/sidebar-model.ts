// SPDX-License-Identifier: AGPL-3.0-only
// Pure sidebar model (spec 02 §11.4 with plan R9): partition, ordering, status tones and active-row rules.
// Every project lives in one 项目 list; `sidebarProjectKind` decides which mark its row wears, through
// spec 07's `isMotionProject` (motion-projects.ts), not a second copy (R9).
import type { ProjectDisplayStatus, ProjectGroup, ProjectOrganizationEntry } from '@open-design/contracts';

import { isDesignSystemProject } from '../../../components/design-system-project';
import type { Route } from '../../../router';
import type { Conversation, Project } from '../../../types';
import { isMotionProject } from '../../motion/motion-projects';

export interface SidebarPartition {
  projects: Project[];
  motion: Project[];
  designSystems: Project[];
}

export const SIDEBAR_PROJECT_LIMIT = 15;
export const CONVERSATION_PREVIEW_LIMIT = 6;

export type SidebarProjectKind = 'project' | 'motion' | 'designSystem';
export type SidebarStatusTone = 'running' | 'waiting' | 'failed' | 'unread' | null;

function byUpdatedDesc<T extends { updatedAt: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Exactly one kind per project: a design-system project never also reads as motion. */
export function sidebarProjectKind(project: Project): SidebarProjectKind {
  if (isDesignSystemProject(project)) return 'designSystem';
  if (isMotionProject(project)) return 'motion';
  return 'project';
}

/** Disjoint lists per kind, each newest first (the ⌘K palette's categories). */
export function partitionSidebarProjects(list: readonly Project[]): SidebarPartition {
  const projects: Project[] = [];
  const motion: Project[] = [];
  const designSystems: Project[] = [];
  for (const project of list) {
    const kind = sidebarProjectKind(project);
    if (kind === 'designSystem') designSystems.push(project);
    else if (kind === 'motion') motion.push(project);
    else projects.push(project);
  }
  return { projects: byUpdatedDesc(projects), motion: byUpdatedDesc(motion), designSystems: byUpdatedDesc(designSystems) };
}

export interface SidebarLayout {
  /** Oldest pin first, so a new pin never moves the rows above it. */
  pinned: Project[];
  /** Every group in order, empty ones included; each newest first. */
  groups: { group: ProjectGroup; projects: Project[] }[];
  /** The rest, every kind together: newest first, capped at the limit. */
  projects: Project[];
  archivedCount: number;
}

export function isProjectArchived(entries: ReadonlyMap<string, ProjectOrganizationEntry>, projectId: string): boolean {
  return entries.get(projectId)?.archivedAt != null;
}

/**
 * Splits the catalogue into the sidebar's sections. A pinned project shows only under 置顶 and an archived
 * one nowhere, except the open project: its chats live in its row, so an archived project stays reachable
 * while it is open.
 */
export function sidebarLayout(
  list: readonly Project[],
  groups: readonly ProjectGroup[],
  entries: ReadonlyMap<string, ProjectOrganizationEntry>,
  activeProjectId: string | null,
): SidebarLayout {
  const pinned: Project[] = [];
  const byGroup = new Map(groups.map((group) => [group.id, [] as Project[]]));
  const ungrouped: Project[] = [];
  const openArchived: Project[] = [];
  let archivedCount = 0;
  for (const project of byUpdatedDesc(list)) {
    const entry = entries.get(project.id);
    if (entry?.removedAt != null && project.id !== activeProjectId) continue;
    const grouped = entry?.groupId ? byGroup.get(entry.groupId) : undefined;
    if (entry?.archivedAt != null) {
      archivedCount += 1;
      if (project.id === activeProjectId) openArchived.push(project);
    } else if (entry?.pinnedAt != null) pinned.push(project);
    else if (grouped) grouped.push(project);
    else ungrouped.push(project);
  }
  pinned.sort((a, b) => (entries.get(a.id)?.pinnedAt ?? 0) - (entries.get(b.id)?.pinnedAt ?? 0));
  return {
    pinned,
    groups: groups.map((group) => ({ group, projects: byGroup.get(group.id) ?? [] })),
    projects: [...ungrouped.slice(0, SIDEBAR_PROJECT_LIMIT), ...openArchived],
    archivedCount,
  };
}

/** Every row the layout draws, for the run-status and chat lookups. */
export function sidebarLayoutProjects(layout: SidebarLayout): Project[] {
  return [...layout.pinned, ...layout.groups.flatMap(({ projects }) => projects), ...layout.projects];
}

/** running|queued → running; awaiting_input → waiting; failed|incomplete → failed; succeeded → unread. */
export function projectStatusTone(status: ProjectDisplayStatus | undefined): SidebarStatusTone {
  switch (status) {
    case 'running':
    case 'queued':
      return 'running';
    case 'awaiting_input':
      return 'waiting';
    case 'failed':
    case 'incomplete':
      return 'failed';
    case 'succeeded':
      return 'unread';
    default:
      return null;
  }
}

/** The running set (ProjectView's streaming conversation) or a queued/running latest run → running; failed → failed. */
export function conversationStatusTone(conversation: Conversation, running: ReadonlySet<string>): SidebarStatusTone {
  if (running.has(conversation.id)) return 'running';
  const status = conversation.latestRun?.status;
  if (status === 'queued' || status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  return null;
}

/** The display status a conversation dot is labelled with (`STATUS_LABEL_KEYS`). */
export function conversationToneStatus(tone: SidebarStatusTone): ProjectDisplayStatus | null {
  if (tone === 'running') return 'running';
  if (tone === 'failed') return 'failed';
  return null;
}

export function sortConversations(list: readonly Conversation[]): Conversation[] {
  return byUpdatedDesc(list).sort((left, right) =>
    Number(right.pinnedAt != null) - Number(left.pinnedAt != null)
    || (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0));
}

export function isConversationUnread(conversation: Conversation): boolean {
  return conversation.unreadAt != null
    || (conversation.readAt != null && (conversation.latestRun?.endedAt ?? 0) > conversation.readAt);
}

/**
 * A chat earns a sidebar row once something happened in it; a fresh "new chat" waits as the open composer only,
 * the way Codex does, so pressing new chat never leaves an 未命名对话 row behind.
 */
export { hasConversationActivity } from '../../../utils/conversationActivity';

/** EntryShell (and its own ⌘K, search palette and hidden rail) is on screen for every home view but settings. */
export function isEntryShellRoute(route: Route): boolean {
  return route.kind === 'home' && route.view !== 'settings';
}

/** Onboarding renders without the sidebar (spec 02 §6.2). */
export function isChromelessRoute(route: Route): boolean {
  return route.kind === 'home' && route.view === 'onboarding';
}

export type SidebarNavItemId =
  | 'pa'
  | 'home'
  | 'workbench'
  | 'materials'
  | 'plugins'
  | 'automations'
  | 'community';

/** The workbench owns the project overview and the design-system and film libraries it links to. */
export function isSidebarNavItemActive(item: SidebarNavItemId, route: Route, materialsOpen: boolean): boolean {
  switch (item) {
    case 'pa':
      return route.kind === 'home' && route.view === 'pa';
    case 'home':
      return route.kind === 'home' && route.view === 'home' && !route.creationMode;
    case 'workbench':
      return (
        (route.kind === 'home'
          && (route.view === 'workbench'
            || route.view === 'projects'
            || route.view === 'drafts'
            || route.view === 'all-projects'
            || route.view === 'design-systems'
            || (route.view === 'movies' && !route.movieProjectId)))
        || route.kind === 'design-system-create'
        || route.kind === 'design-system-detail'
      );
    case 'plugins':
      return (
        (route.kind === 'home' && (route.view === 'plugins' || route.view === 'integrations'))
        || route.kind === 'marketplace'
        || route.kind === 'marketplace-detail'
      );
    case 'automations':
      return route.kind === 'home' && route.view === 'tasks';
    case 'community':
      return (route.kind === 'home' && route.view === 'community') || route.kind === 'community';
    case 'materials':
      return materialsOpen || (route.kind === 'home' && route.view === 'materials');
    default:
      return false;
  }
}

/** The project open in ProjectView, or null off the project route. */
export function activeProjectIdFor(route: Route): string | null {
  return route.kind === 'project' ? route.projectId : null;
}
