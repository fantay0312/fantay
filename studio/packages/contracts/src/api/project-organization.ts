// How the owner of this daemon organizes their project list: named groups (分组), pins (置顶) and the
// archive (归档). It is a personal view over the catalogue, stored apart from the project itself: changing
// it never bumps `Project.updatedAt`, reorders recents or reaches a team workspace.

export interface ProjectGroup {
  id: string;
  name: string;
  /** Sidebar order, ascending. */
  position: number;
  createdAt: number;
  updatedAt: number;
}

/** A project with no entry is ungrouped, unpinned and not archived. */
export interface ProjectOrganizationEntry {
  projectId: string;
  groupId: string | null;
  pinnedAt: number | null;
  archivedAt: number | null;
  removedAt?: number | null;
}

export interface ProjectOrganizationResponse {
  groups: ProjectGroup[];
  projects: ProjectOrganizationEntry[];
  conversations?: Array<{ conversationId: string; projectId: string; groupId: string }>;
}

/**
 * Omitted fields stay as they are. Archiving also unpins, and an archived project refuses `pinned: true`
 * unless the same request sets `archived: false`. The group survives archiving, so restoring a project
 * puts it back where it was.
 */
export interface UpdateProjectOrganizationRequest {
  pinned?: boolean;
  archived?: boolean;
  groupId?: string | null;
  removed?: boolean;
}

export interface ProjectOrganizationEntryResponse {
  entry: ProjectOrganizationEntry;
}

export interface CreateProjectGroupRequest {
  name: string;
}

export interface UpdateProjectGroupRequest {
  name: string;
}

/** Every existing group id, in the new order. */
export interface ReorderProjectGroupsRequest {
  ids: string[];
}

export interface ProjectGroupResponse {
  group: ProjectGroup;
}

export const PROJECT_GROUP_NAME_MAX_LENGTH = 60;
