// SPDX-License-Identifier: AGPL-3.0-only
// What the sidebar receives from FantayShell: the route and catalogue it reads, and the shell-owned actions
// it calls. One object, so the docked sidebar, the rail and the phone sheet render from the same source.
import type { WorkspaceCollabContext } from '@open-design/contracts';

import type { Route } from '../../../router';
import type { Project } from '../../../types';
import type { FantayClientType, FantaySidebarMode } from '../geometry';
import type { FantaySidebarSectionId } from '../sidebar-store';
import type { SidebarProjectActions } from './SidebarProjectRow';

export interface SidebarShellApi {
  route: Route;
  /** App `workspaceChromeProjects` (route-reconciled; one catalogue authority). */
  projects: readonly Project[];
  projectsLoading: boolean;
  workspaceContext: WorkspaceCollabContext | null;
  clientType: FantayClientType;
  hostPlatform: string | undefined;
  mode: FantaySidebarMode;
  materialsOpen: boolean;
  /** The open project is read-only (team viewer / not yet materialized): no new chat there. */
  newChatDisabled: boolean;
  /** Docked: fold/unfold the rail. Overlay: close the sheet. */
  toggleSidebar(): void;
  openSearch(): void;
  /** Opens app settings from the sidebar's regular controls. */
  openSettings(): void;
  newChat(): void;
  newProject(): void;
  /** `newProject`, with the group the project will go to shown on Home's composer. */
  newProjectInGroup(groupId: string): void;
  /** Navigate (closes the phone sheet). */
  go(route: Route): void;
  openProject(project: Project): void;
  selectConversation(projectId: string, conversationId: string): void;
  openMaterials(): void;
  /** Rail section buttons: unfold the sidebar and reveal that section. */
  revealSection(section: FantaySidebarSectionId): void;
  projectActions: SidebarProjectActions;
}
