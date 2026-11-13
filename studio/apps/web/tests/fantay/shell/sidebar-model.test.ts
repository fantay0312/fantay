// SPDX-License-Identifier: Apache-2.0
// Pure sidebar model (spec 02 §11.4 + plan R9): project kind (design system beats motion), ordering, status
// tones, active-row rules, chromeless / EntryShell routes.
import { describe, expect, it } from 'vitest';

import type { ProjectGroup, ProjectOrganizationEntry } from '@open-design/contracts';

import type { Route } from '../../../src/router';
import {
  CONVERSATION_PREVIEW_LIMIT,
  SIDEBAR_PROJECT_LIMIT,
  activeProjectIdFor,
  conversationStatusTone,
  conversationToneStatus,
  isChromelessRoute,
  isEntryShellRoute,
  isSidebarNavItemActive,
  partitionSidebarProjects,
  projectStatusTone,
  sidebarLayout,
  sidebarProjectKind,
  sortConversations,
} from '../../../src/fantay/shell/sidebar/sidebar-model';
import type { Conversation, Project } from '../../../src/types';

function project(id: string, updatedAt: number, extra: Partial<Project> = {}): Project {
  return { id, name: id, skillId: null, designSystemId: null, createdAt: 1, updatedAt, ...extra };
}

function conversation(id: string, updatedAt: number, latestRun?: Conversation['latestRun']): Conversation {
  return { id, projectId: 'p', title: id, createdAt: 1, updatedAt, ...(latestRun ? { latestRun } : {}) };
}

describe('sidebarProjectKind', () => {
  it('gives each project one kind: design systems win over motion, the rest are plain projects', () => {
    expect(sidebarProjectKind(project('plain', 1))).toBe('project');
    expect(sidebarProjectKind(project('movie', 1, { skillId: 'fantay-movie' }))).toBe('motion');
    expect(sidebarProjectKind(project('video', 1, { metadata: { kind: 'video' } }))).toBe('motion');
    expect(sidebarProjectKind(project('hyperframes', 1, { metadata: { kind: 'prototype', intent: 'hyperframes' } }))).toBe('motion');
    expect(sidebarProjectKind(project('brand', 1, { metadata: { kind: 'brand' } }))).toBe('designSystem');
    expect(sidebarProjectKind(project('ds-motion', 1, { metadata: { kind: 'video', importedFrom: 'design-system' } }))).toBe('designSystem');
  });
});

describe('partitionSidebarProjects', () => {
  it('splits disjointly for the ⌘K palette, each list newest first', () => {
    const partition = partitionSidebarProjects([
      project('plain', 1),
      project('movie', 5, { skillId: 'fantay-movie' }),
      project('video', 6, { metadata: { kind: 'video' } }),
      project('ds-motion', 9, { metadata: { kind: 'video', importedFrom: 'design-system' } }),
    ]);
    expect(partition.projects.map((p) => p.id)).toEqual(['plain']);
    expect(partition.motion.map((p) => p.id)).toEqual(['video', 'movie']);
    expect(partition.designSystems.map((p) => p.id)).toEqual(['ds-motion']);
  });
});

describe('sidebarLayout', () => {
  const group = (id: string, position: number): ProjectGroup => ({ id, name: id, position, createdAt: 1, updatedAt: 1 });
  const entries = (...list: (Partial<ProjectOrganizationEntry> & { projectId: string })[]) =>
    new Map(list.map((entry) => [entry.projectId, { groupId: null, pinnedAt: null, archivedAt: null, ...entry }]));
  const ids = (list: readonly Project[]) => list.map((p) => p.id);

  it('keeps every kind in one list, newest first', () => {
    const list = [
      project('plain-old', 1),
      project('movie', 5, { skillId: 'fantay-movie' }),
      project('ds', 9, { metadata: { kind: 'brand' } }),
      project('plain-new', 7),
    ];
    expect(ids(sidebarLayout(list, [], new Map(), null).projects)).toEqual(['ds', 'plain-new', 'movie', 'plain-old']);
  });

  it('caps only the plain list at the project limit', () => {
    const list = Array.from({ length: SIDEBAR_PROJECT_LIMIT + 3 }, (_, index) => project(`p${index}`, index));
    const rows = sidebarLayout(list, [], new Map(), null).projects;
    expect(rows).toHaveLength(15);
    expect(rows[0]?.id).toBe(`p${SIDEBAR_PROJECT_LIMIT + 2}`);
    expect(CONVERSATION_PREVIEW_LIMIT).toBe(6);
    const grouped = entries(...list.map((p) => ({ projectId: p.id, groupId: 'g' })));
    expect(sidebarLayout(list, [group('g', 0)], grouped, null).groups[0]?.projects).toHaveLength(list.length);
  });

  it('shows each project once: a pin wins over its group, oldest pin first', () => {
    const list = [project('a', 1), project('b', 2), project('c', 3), project('d', 4)];
    const layout = sidebarLayout(
      list,
      [group('g', 0), group('empty', 1)],
      entries({ projectId: 'a', pinnedAt: 5 }, { projectId: 'b', pinnedAt: 9, groupId: 'g' }, { projectId: 'c', groupId: 'g' }),
      null,
    );
    expect(ids(layout.pinned)).toEqual(['a', 'b']);
    expect(layout.groups.map(({ group: { id }, projects }) => [id, ids(projects)])).toEqual([['g', ['c']], ['empty', []]]);
    expect(ids(layout.projects)).toEqual(['d']);
  });

  it('treats a project in a deleted group as ungrouped', () => {
    const layout = sidebarLayout([project('a', 1)], [], entries({ projectId: 'a', groupId: 'gone' }), null);
    expect(ids(layout.projects)).toEqual(['a']);
  });

  it('hides archived projects and counts them, but keeps the open one reachable', () => {
    const list = [project('a', 1), project('b', 2), project('c', 3)];
    const archived = entries({ projectId: 'a', archivedAt: 1 }, { projectId: 'b', archivedAt: 1, groupId: 'g' });
    const closed = sidebarLayout(list, [group('g', 0)], archived, null);
    expect(ids(closed.projects)).toEqual(['c']);
    expect(closed.groups[0]?.projects).toEqual([]);
    expect(closed.archivedCount).toBe(2);
    expect(ids(sidebarLayout(list, [group('g', 0)], archived, 'b').projects)).toEqual(['c', 'b']);
  });
});

describe('status tones', () => {
  it('maps project display statuses', () => {
    expect(projectStatusTone('running')).toBe('running');
    expect(projectStatusTone('queued')).toBe('running');
    expect(projectStatusTone('awaiting_input')).toBe('waiting');
    expect(projectStatusTone('failed')).toBe('failed');
    expect(projectStatusTone('incomplete')).toBe('failed');
    expect(projectStatusTone('succeeded')).toBe('unread');
    expect(projectStatusTone('canceled')).toBeNull();
    expect(projectStatusTone('not_started')).toBeNull();
    expect(projectStatusTone(undefined)).toBeNull();
  });

  it('maps conversations: the live running set or a queued/running latest run → running; failed → failed', () => {
    const running = new Set(['live']);
    expect(conversationStatusTone(conversation('live', 1), running)).toBe('running');
    expect(conversationStatusTone(conversation('a', 1, { status: 'running' }), new Set())).toBe('running');
    expect(conversationStatusTone(conversation('b', 1, { status: 'queued' }), new Set())).toBe('running');
    expect(conversationStatusTone(conversation('c', 1, { status: 'failed' }), new Set())).toBe('failed');
    expect(conversationStatusTone(conversation('d', 1, { status: 'succeeded' }), new Set())).toBeNull();
    expect(conversationStatusTone(conversation('e', 1), new Set())).toBeNull();
    expect(conversationToneStatus('running')).toBe('running');
    expect(conversationToneStatus('failed')).toBe('failed');
    expect(conversationToneStatus(null)).toBeNull();
  });

  it('sorts conversations newest first without mutating the input', () => {
    const list = [conversation('old', 1), conversation('new', 3), conversation('mid', 2)];
    expect(sortConversations(list).map((c) => c.id)).toEqual(['new', 'mid', 'old']);
    expect(list.map((c) => c.id)).toEqual(['old', 'new', 'mid']);
  });
  it('places a pin at timestamp zero before unpinned conversations', () => {
    const list = [conversation('recent', 10), { ...conversation('pinned', 1), pinnedAt: 0 }];
    expect(sortConversations(list).map(item => item.id)).toEqual(['pinned', 'recent']);
  });
});

describe('routes', () => {
  const home: Route = { kind: 'home', view: 'home' };
  it('knows where EntryShell is mounted and which route is chromeless', () => {
    expect(isEntryShellRoute(home)).toBe(true);
    expect(isEntryShellRoute({ kind: 'home', view: 'plugins' })).toBe(true);
    expect(isEntryShellRoute({ kind: 'home', view: 'settings' })).toBe(false);
    expect(isEntryShellRoute({ kind: 'project', projectId: 'p', fileName: null })).toBe(false);
    expect(isChromelessRoute({ kind: 'home', view: 'onboarding' })).toBe(true);
    expect(isChromelessRoute(home)).toBe(false);
    expect(activeProjectIdFor({ kind: 'project', projectId: 'p1', fileName: null })).toBe('p1');
    expect(activeProjectIdFor(home)).toBeNull();
  });

  it('applies the active-row rules', () => {
    expect(isSidebarNavItemActive('home', home, false)).toBe(true);
    expect(isSidebarNavItemActive('home', { kind: 'home', view: 'home', creationMode: 'movie' }, false)).toBe(false);
    for (const view of ['workbench', 'projects', 'drafts', 'all-projects', 'design-systems', 'movies'] as const) {
      expect(isSidebarNavItemActive('workbench', { kind: 'home', view }, false)).toBe(true);
    }
    expect(isSidebarNavItemActive('workbench', { kind: 'design-system-detail', designSystemId: 'x' }, false)).toBe(true);
    expect(isSidebarNavItemActive('workbench', { kind: 'design-system-create' }, false)).toBe(true);
    expect(isSidebarNavItemActive('workbench', { kind: 'home', view: 'movies', movieProjectId: 'film' }, false)).toBe(false);
    expect(isSidebarNavItemActive('plugins', { kind: 'marketplace' }, false)).toBe(true);
    expect(isSidebarNavItemActive('plugins', { kind: 'marketplace-detail', pluginId: 'x' }, false)).toBe(true);
    expect(isSidebarNavItemActive('automations', { kind: 'home', view: 'tasks' }, false)).toBe(true);
    expect(isSidebarNavItemActive('community', { kind: 'community' }, false)).toBe(true);
    expect(isSidebarNavItemActive('community', { kind: 'home', view: 'community' }, false)).toBe(true);
    expect(isSidebarNavItemActive('materials', home, true)).toBe(true);
    expect(isSidebarNavItemActive('materials', home, false)).toBe(false);
    expect(isSidebarNavItemActive('materials', { kind: 'home', view: 'materials' }, false)).toBe(true);
  });
});
