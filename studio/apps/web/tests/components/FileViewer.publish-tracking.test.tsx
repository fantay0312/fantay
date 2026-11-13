// @vitest-environment jsdom

// The legacy Vela "publish this file" flow (publish-public POST/DELETE with
// `publish_file` / `artifact_publish_result` / `copy_publish_link` analytics)
// no longer renders: public links are published by the TokenToSea share panel
// and automatic reporting is off (FANTAY_AUTOMATIC_REPORTING_ENABLED = false).
// What remains pinned here is that a React component viewer, which cannot be
// shared, never reaches the retired publish endpoint or emits publish analytics.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { FileViewer } from '../../src/components/FileViewer';
import {
  CollabProvider,
  type CollabContextValue,
} from '../../src/collab/collab-context';
import type { ProjectFile } from '../../src/types';

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
  newRequestId: vi.fn(() => 'request-publish-1'),
}));

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: analytics.track,
    newRequestId: analytics.newRequestId,
  }),
}));

function teamWorkspaceContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
  };
}

function renderProjectFileViewer(
  context: WorkspaceCollabContext,
  props: ComponentProps<typeof FileViewer>,
) {
  const collab: CollabContextValue = {
    workspaceContext: context,
    workspaceContextLoading: false,
    enabled: true,
    member: null,
    present: [],
    publishedVersion: null,
    syncState: null,
    viewerOnly: false,
    writerAuthority: 'allowed',
    isOwner: true,
    isEffectiveOwner: true,
    isSharedNonOwner: false,
    ownerDisplayName: null,
    ownerRole: null,
    downloadPending: false,
    reportChange: () => {},
    requestPublish: () => {},
    refreshPresence: () => {},
    checkStatusNow: () => {},
  };
  const tree = (next: ComponentProps<typeof FileViewer>) => (
    <CollabProvider value={collab}>
      <FileViewer {...next} />
    </CollabProvider>
  );
  const result = render(tree(props));
  return {
    ...result,
    rerenderWith: (next: ComponentProps<typeof FileViewer>) => result.rerender(tree(next)),
  };
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/workspace/context')) {
      return new Response(JSON.stringify({ context: teamWorkspaceContext() }), { status: 200 });
    }
    return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function trackedEvents(name: string): Record<string, unknown>[] {
  return analytics.track.mock.calls
    .filter(([event]) => event === name)
    .map(([, props]) => props as Record<string, unknown>);
}

function reactComponentFile(): ProjectFile {
  return {
    name: 'App.jsx',
    path: 'App.jsx',
    type: 'file',
    size: 512,
    mtime: 1710000000,
    kind: 'code',
    mime: 'text/javascript',
    artifactManifest: {
      version: 1,
      kind: 'react-component',
      title: 'App',
      entry: 'App.jsx',
      renderer: 'react-component',
      exports: ['jsx'],
    },
  };
}

// The retired publish row's labels; a React component viewer must never show it.
const PUBLISH_ROW = /generate and copy link|get a share link/i;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  analytics.track.mockReset();
  analytics.newRequestId.mockClear();
});

describe('publish flow analytics', () => {
  it('does not publish or report publish analytics for a React component, even when retained', async () => {
    const fetchMock = stubFetch();
    const props: ComponentProps<typeof FileViewer> = {
      projectId: 'project-pub',
      projectKind: 'prototype',
      file: reactComponentFile(),
    };
    const { rerenderWith } = renderProjectFileViewer(teamWorkspaceContext(), props);
    const shareButton = await screen.findByRole('button', { name: /^share$/i });
    await waitFor(() => expect(shareButton).toBeDisabled());
    fireEvent.click(shareButton);
    expect(screen.queryByRole('menuitem', { name: PUBLISH_ROW })).toBeNull();

    rerenderWith({ ...props, workspaceActive: false });
    rerenderWith({ ...props, workspaceActive: true });
    expect(await screen.findByRole('button', { name: /^share$/i })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('publish-public'))).toBe(false);
    expect(trackedEvents('ui_click').filter((event) => event.element === 'publish_file')).toEqual([]);
    expect(trackedEvents('artifact_publish_result')).toEqual([]);
  });
});
