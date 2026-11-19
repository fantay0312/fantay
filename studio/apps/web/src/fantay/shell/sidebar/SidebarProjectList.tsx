// SPDX-License-Identifier: AGPL-3.0-only
// The rows of the 项目 section, every project kind together: skeletons while App loads the catalogue, an
// empty caption, then the project rows with their lazy chat lists (spec 02 §11.4).
import type { ProjectDisplayStatus } from '@open-design/contracts';
import type { ReactNode } from 'react';

import { useT } from '../../../i18n';
import { STATUS_LABEL_KEYS } from '../../../state/projectRunStatus';
import type { Project } from '../../../types';
import { cn } from '../../ui/cn';
import { Skeleton } from '../../ui/skeleton';
import { SidebarProjectRow, type SidebarConversationListState, type SidebarProjectActions } from './SidebarProjectRow';
import { projectStatusTone, sidebarProjectKind } from './sidebar-model';

const SKELETON_ROWS = 3;

export interface SidebarProjectListProps {
  projects: readonly Project[];
  loading: boolean;
  /** Null draws nothing: the 项目 section when every project lives in 置顶 or a group. */
  emptyLabel: string | null;
  /** Rows under a folder: their marks, and the empty line, start where the folder's name does. */
  nested?: boolean;
  activeProjectId: string | null;
  isExpanded(projectId: string): boolean;
  statuses: ReadonlyMap<string, ProjectDisplayStatus>;
  conversationsFor(projectId: string): SidebarConversationListState;
  renderActivity?(projectId: string): ReactNode;
  onOpenProject(project: Project): void;
  onToggleExpanded(projectId: string): void;
  onSelectConversation(projectId: string, conversationId: string): void;
  onRetryConversations(projectId: string): void;
  actions: SidebarProjectActions;
  onRequestNewGroup(projectId: string): void;
}

export function SidebarProjectList({
  projects,
  loading,
  emptyLabel,
  nested = false,
  activeProjectId,
  isExpanded,
  statuses,
  conversationsFor,
  renderActivity,
  onOpenProject,
  onToggleExpanded,
  onSelectConversation,
  onRetryConversations,
  actions,
  onRequestNewGroup,
}: SidebarProjectListProps) {
  const t = useT();
  if (loading && projects.length === 0) {
    return (
      <div className="flex flex-col gap-1.5 px-[11px] py-1" data-testid="fantay-sidebar-skeleton-projects">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} shape="line" index={index} className="h-4" />
        ))}
      </div>
    );
  }
  if (projects.length === 0) {
    if (emptyLabel === null) return null;
    return (
      <p
        className={cn('m-0 py-1.5 text-label text-ink-faint', nested ? 'ps-[37px] pe-[11px]' : 'px-[11px]')}
        data-testid="fantay-sidebar-empty-projects"
      >
        {emptyLabel}
      </p>
    );
  }
  return (
    <ul className={cn('m-0 flex flex-col gap-0.5 p-0', nested && 'ps-[9px]')} role="list">
      {projects.map((project) => {
        const status = statuses.get(project.id);
        const tone = projectStatusTone(status);
        return (
          <SidebarProjectRow
            key={project.id}
            project={project}
            kind={sidebarProjectKind(project)}
            active={activeProjectId === project.id}
            expanded={isExpanded(project.id)}
            statusTone={tone}
            statusLabel={tone && status ? t(STATUS_LABEL_KEYS[status]) : undefined}
            conversations={conversationsFor(project.id)}
            activity={renderActivity?.(project.id)}
            onToggleExpanded={() => onToggleExpanded(project.id)}
            onOpen={() => onOpenProject(project)}
            onSelectConversation={(conversationId) => onSelectConversation(project.id, conversationId)}
            onRetryConversations={() => onRetryConversations(project.id)}
            actions={actions}
            onRequestNewGroup={() => onRequestNewGroup(project.id)}
          />
        );
      })}
    </ul>
  );
}
