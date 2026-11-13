// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import {
  claimNewProjectGroup,
  loadProjectOrganization,
  releaseNewProjectGroup,
  resetProjectOrganizationForTests,
  setNewProjectGroup,
  useProjectOrganization,
  useProjectOrganizationActions,
} from '../../../src/fantay/shell/project-organization-store';

const GROUP = { id: 'g', name: '客户', position: 0, createdAt: 1, updatedAt: 1 };

function renderStore() {
  const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider initial="zh-CN">{children}</I18nProvider>;
  return renderHook(() => ({ state: useProjectOrganization(), actions: useProjectOrganizationActions() }), { wrapper });
}

describe('a new project started from a group', () => {
  let patches: { url: string; body: unknown }[];

  beforeEach(async () => {
    patches = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method !== 'PATCH') return new Response(JSON.stringify({ groups: [GROUP], projects: [] }));
        const body = JSON.parse(String(init.body)) as { groupId: string };
        patches.push({ url, body });
        const entry = { projectId: url.split('/').pop(), groupId: body.groupId, pinnedAt: null, archivedAt: null };
        return new Response(JSON.stringify({ entry }));
      }),
    );
    resetProjectOrganizationForTests();
    await loadProjectOrganization();
  });

  afterEach(() => {
    cleanup();
    resetProjectOrganizationForTests();
    vi.unstubAllGlobals();
  });

  it("goes to Home's target and spends it", async () => {
    const { result } = renderStore();
    setNewProjectGroup('g');
    await waitFor(() => expect(result.current.state.newProjectGroupId).toBe('g'));

    result.current.actions.placeCreatedProject('p');

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ url: '/api/project-organization/projects/p', body: { groupId: 'g' } });
    expect(result.current.state.newProjectGroupId).toBeNull();
  });

  it('stays out of every group without a target', async () => {
    const { result } = renderStore();
    result.current.actions.placeCreatedProject('p');
    await Promise.resolve();
    expect(patches).toEqual([]);
  });

  it('keeps a claimed group after Home has been left, and shows there at once', async () => {
    const { result } = renderStore();
    setNewProjectGroup('g');
    claimNewProjectGroup('p');
    setNewProjectGroup(null);
    await waitFor(() => expect(result.current.state.entries.get('p')?.groupId).toBe('g'));

    result.current.actions.placeCreatedProject('p');

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body).toEqual({ groupId: 'g' });
  });

  it('does not spend a newer target on a project that claimed its own', async () => {
    const { result } = renderStore();
    setNewProjectGroup('g');
    claimNewProjectGroup('p');
    setNewProjectGroup('other');

    result.current.actions.placeCreatedProject('p');

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(result.current.state.newProjectGroupId).toBe('other');
  });

  it('gives the target back when the send fails', async () => {
    const { result } = renderStore();
    setNewProjectGroup('g');
    claimNewProjectGroup('p');

    releaseNewProjectGroup('p');

    await waitFor(() => expect(result.current.state.newProjectGroupId).toBe('g'));
    expect(result.current.state.entries.has('p')).toBe(false);
  });

  it('drops the target with its group', async () => {
    const { result } = renderStore();
    setNewProjectGroup('g');

    result.current.actions.deleteGroup('g');

    await waitFor(() => expect(result.current.state.newProjectGroupId).toBeNull());
  });
});
