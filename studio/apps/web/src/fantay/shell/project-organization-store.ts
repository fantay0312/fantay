// SPDX-License-Identifier: AGPL-3.0-only
// The renderer's copy of the daemon's project groups, pins and archive. One store for the sidebar, 全部项目
// and ⌘K. Writes apply at once and run one at a time; a rejected write reloads the daemon's truth. The
// first subscriber loads it, and window focus reloads it so `od project …` changes show up.
import { useMemo, useSyncExternalStore } from 'react';
import type {
  ProjectGroup,
  ProjectGroupResponse,
  ProjectOrganizationEntry,
  ProjectOrganizationEntryResponse,
  ProjectOrganizationResponse,
  UpdateProjectOrganizationRequest,
} from '@open-design/contracts';

import { useT } from '../../i18n';
import type { Project } from '../../types';
import { toast } from '../ui/toast';

const API = '/api/project-organization';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export interface ProjectOrganizationState {
  readonly groups: readonly ProjectGroup[];
  readonly entries: ReadonlyMap<string, ProjectOrganizationEntry>;
  readonly conversationSections: NonNullable<ProjectOrganizationResponse['conversations']>;
  /** The sidebar's 已归档 row asked 全部项目 to open on that filter; cleared once it has. */
  readonly archivedViewRequested: boolean;
  /** The group the next new project goes to, shown on Home's composer; null for none. */
  readonly newProjectGroupId: string | null;
}

const EMPTY_STATE: ProjectOrganizationState = Object.freeze({
  groups: Object.freeze([]) as readonly ProjectGroup[],
  entries: new Map<string, ProjectOrganizationEntry>(),
  conversationSections: [],
  archivedViewRequested: false,
  newProjectGroupId: null,
});

let state = EMPTY_STATE;
/** Bumped by every write, so a read that started before it cannot overwrite the newer state. */
let revision = 0;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
/** Home's sends on their way to a group, by project id: the row shows there before the daemon has the project. */
const claimedProjects = new Map<string, string>();

function update(patch: Partial<ProjectOrganizationState>): void {
  state = Object.freeze({ ...state, ...patch });
  for (const listener of [...listeners]) listener();
}

function indexEntries(entries: readonly ProjectOrganizationEntry[]): ReadonlyMap<string, ProjectOrganizationEntry> {
  const indexed = new Map(entries.map((entry) => [entry.projectId, entry]));
  // The daemon has no row for these yet, and a reload must not send them back to 项目 for that moment.
  for (const [projectId, groupId] of claimedProjects) {
    indexed.set(projectId, { projectId, groupId, pinnedAt: null, archivedAt: null });
  }
  return indexed;
}

function putEntry(entry: ProjectOrganizationEntry): void {
  const entries = new Map(state.entries);
  entries.set(entry.projectId, entry);
  update({ entries });
}

export async function loadProjectOrganization(): Promise<void> {
  const startedAt = revision;
  try {
    const response = await fetch(API);
    if (!response.ok) return;
    const body = (await response.json()) as ProjectOrganizationResponse;
    if (startedAt !== revision) return;
    update({ groups: body.groups, entries: indexEntries(body.projects), conversationSections: body.conversations ?? [] });
  } catch {
    // Daemon unreachable: the list simply shows unorganized until the next focus.
  }
}

const reloadOnFocus = () => {
  void loadProjectOrganization();
};

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('focus', reloadOnFocus);
    void loadProjectOrganization();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('focus', reloadOnFocus);
  };
}

function getState(): ProjectOrganizationState {
  return state;
}

export function useProjectOrganization(): ProjectOrganizationState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/** Queues a write; resolves to its result, or null after a failure (the daemon's state is reloaded). */
function write<T>(run: () => Promise<Response>, apply: (response: Response) => Promise<T>): Promise<T | null> {
  revision += 1;
  const result = writes.then(async () => {
    try {
      const response = await run();
      if (!response.ok) throw new Error(`project organization write rejected: ${response.status}`);
      return await apply(response);
    } catch {
      revision += 1;
      await loadProjectOrganization();
      return null;
    }
  });
  writes = result;
  return result;
}

function organizeProject(projectId: string, patch: UpdateProjectOrganizationRequest): Promise<boolean> {
  const now = Date.now();
  const entry = state.entries.get(projectId) ?? { projectId, groupId: null, pinnedAt: null, archivedAt: null };
  const archivedAt = patch.archived === undefined ? entry.archivedAt : patch.archived ? entry.archivedAt ?? now : null;
  const pinnedAt = archivedAt !== null ? null : patch.pinned === undefined ? entry.pinnedAt : patch.pinned ? entry.pinnedAt ?? now : null;
  const removedAt = patch.removed === undefined ? entry.removedAt ?? null : patch.removed ? now : null;
  putEntry({ projectId, groupId: patch.groupId === undefined ? entry.groupId : patch.groupId, pinnedAt, archivedAt, removedAt });
  return write(
    () =>
      fetch(`${API}/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(patch),
      }),
    async (response) => {
      putEntry(((await response.json()) as ProjectOrganizationEntryResponse).entry);
      return true;
    },
  ).then((done) => done === true);
}

export function createGroup(name: string): Promise<ProjectGroup | null> {
  return write(
    () => fetch(`${API}/groups`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name }) }),
    async (response) => {
      const { group } = (await response.json()) as ProjectGroupResponse;
      update({ groups: [...state.groups, group] });
      return group;
    },
  );
}

function renameGroup(groupId: string, name: string): Promise<boolean> {
  update({ groups: state.groups.map((group) => (group.id === groupId ? { ...group, name } : group)) });
  return write(
    () =>
      fetch(`${API}/groups/${encodeURIComponent(groupId)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      }),
    async () => true,
  ).then((done) => done === true);
}

function deleteGroup(groupId: string): Promise<boolean> {
  const entries = new Map(state.entries);
  for (const [projectId, entry] of entries) {
    if (entry.groupId === groupId) entries.set(projectId, { ...entry, groupId: null });
  }
  update({
    groups: state.groups.filter((group) => group.id !== groupId),
    entries,
    newProjectGroupId: state.newProjectGroupId === groupId ? null : state.newProjectGroupId,
  });
  return write(
    () => fetch(`${API}/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' }),
    async () => true,
  ).then((done) => done === true);
}

/** Swaps the group with its neighbour; `offset` is -1 (up) or 1 (down). */
function shiftGroup(groupId: string, offset: -1 | 1): Promise<boolean> {
  const groups = [...state.groups];
  const from = groups.findIndex((group) => group.id === groupId);
  const moved = groups[from];
  const neighbour = groups[from + offset];
  if (!moved || !neighbour) return Promise.resolve(true);
  groups[from] = neighbour;
  groups[from + offset] = moved;
  update({ groups });
  return write(
    () =>
      fetch(`${API}/groups/order`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ids: groups.map((group) => group.id) }),
      }),
    async () => true,
  ).then((done) => done === true);
}

export function setNewProjectGroup(groupId: string | null): void {
  if (state.newProjectGroupId !== groupId) update({ newProjectGroupId: groupId });
}

/** A Home send opens its project before the daemon has it, and leaving Home drops the target: the send takes it along. */
export function claimNewProjectGroup(projectId: string): void {
  const groupId = state.newProjectGroupId;
  if (groupId === null) return;
  claimedProjects.set(projectId, groupId);
  putEntry({ projectId, groupId, pinnedAt: null, archivedAt: null });
  update({ newProjectGroupId: null });
}

/** The send failed: Home comes back with the target set, for the retry. */
export function releaseNewProjectGroup(projectId: string): void {
  const groupId = claimedProjects.get(projectId);
  if (groupId === undefined) return;
  claimedProjects.delete(projectId);
  const entries = new Map(state.entries);
  entries.delete(projectId);
  update({ entries, newProjectGroupId: groupId });
}

/** The group a just-created project goes to: the one its send claimed, else Home's current target. */
function takeCreatedProjectGroup(projectId: string): string | null {
  const claimed = claimedProjects.get(projectId);
  claimedProjects.delete(projectId);
  const groupId = claimed ?? state.newProjectGroupId;
  if (claimed === undefined) setNewProjectGroup(null);
  return state.groups.some((group) => group.id === groupId) ? groupId : null;
}

export function requestArchivedProjectsView(): void {
  update({ archivedViewRequested: true });
}

export function acknowledgeArchivedProjectsView(): void {
  if (state.archivedViewRequested) update({ archivedViewRequested: false });
}

export interface ProjectOrganizationActions {
  /** The general form, for a drop that both moves and unpins. */
  organize(projectId: string, patch: UpdateProjectOrganizationRequest): void;
  /** Archives with an undo toast that also restores a pin the archive removed. */
  archive(project: Project): void;
  createGroup(name: string, projectId?: string): void;
  renameGroup(groupId: string, name: string): void;
  deleteGroup(groupId: string): void;
  shiftGroup(groupId: string, offset: -1 | 1): void;
  /** Files a project the daemon just created under the group it was started from, if any. */
  placeCreatedProject(projectId: string): void;
}

/** The store's writes with their failure toast, for the surfaces that organize projects. */
export function useProjectOrganizationActions(): ProjectOrganizationActions {
  const t = useT();
  return useMemo(() => {
    const report = (done: Promise<boolean>) => {
      void done.then((ok) => {
        if (!ok) toast({ title: t('fantayShell.sidebar.organizeFailed'), tone: 'danger' });
      });
    };
    return {
      organize: (projectId, patch) => report(organizeProject(projectId, patch)),
      archive: (project) => {
        const pinned = state.entries.get(project.id)?.pinnedAt != null;
        report(organizeProject(project.id, { archived: true }));
        toast({
          title: t('fantayShell.sidebar.archivedToast', { name: project.name.trim() || t('common.untitled') }),
          action: {
            label: t('fantayShell.sidebar.undo'),
            onClick: () => report(organizeProject(project.id, { archived: false, ...(pinned ? { pinned: true } : {}) })),
          },
        });
      },
      createGroup: (name, projectId) => {
        report(
          createGroup(name).then((group) => {
            if (!group) return false;
            return projectId ? organizeProject(projectId, { groupId: group.id }) : true;
          }),
        );
      },
      renameGroup: (groupId, name) => report(renameGroup(groupId, name)),
      deleteGroup: (groupId) => report(deleteGroup(groupId)),
      shiftGroup: (groupId, offset) => report(shiftGroup(groupId, offset)),
      placeCreatedProject: (projectId) => {
        const groupId = takeCreatedProjectGroup(projectId);
        if (groupId) report(organizeProject(projectId, { groupId }));
      },
    };
  }, [t]);
}

export function resetProjectOrganizationForTests(): void {
  state = EMPTY_STATE;
  revision = 0;
  writes = Promise.resolve();
  claimedProjects.clear();
  for (const listener of [...listeners]) listener();
}
