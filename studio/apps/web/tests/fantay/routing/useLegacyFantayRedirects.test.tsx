// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  getMaterialsDrawerState,
  resetMaterialsDrawerForTests,
} from '../../../src/fantay/materials/materials-drawer-store';
import {
  closeMotionCreate,
  getMotionCreateRequest,
} from '../../../src/fantay/motion/motion-create-store';
import { useLegacyFantayRedirects } from '../../../src/fantay/routing/useLegacyFantayRedirects';
import {
  resetWorkspaceBusForTests,
  subscribeWorkspaceCommand,
} from '../../../src/fantay/workspace/workspace-bus';
import { navigate, registerNavigationGuard, useRoute } from '../../../src/router';

function RedirectProbe({ openSettings }: { openSettings: (section: 'account') => void }) {
  const route = useRoute();
  useLegacyFantayRedirects(route, { openSettings });
  return null;
}

/** Lets the microtasks (router popstate fan-out, redirect effects) and React updates settle. */
async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function startAt(url: string) {
  window.history.replaceState(null, '', url);
}

let openSettings: Mock<(section: 'account') => void>;

beforeEach(() => {
  startAt('/');
  // App.openSettings pushes /settings for the section.
  openSettings = vi.fn((_section: 'account') => {
    navigate({ kind: 'home', view: 'settings' });
  });
  resetMaterialsDrawerForTests();
  resetWorkspaceBusForTests();
  closeMotionCreate();
});

afterEach(() => {
  cleanup();
  resetWorkspaceBusForTests();
  resetMaterialsDrawerForTests();
  closeMotionCreate();
  startAt('/');
});

describe('useLegacyFantayRedirects', () => {
  it('opens settings only after React has committed the home route', async () => {
    startAt('/tokentosea');
    const observed: string[] = [];
    function CommittedRouteProbe() {
      const route = useRoute();
      useLegacyFantayRedirects(route, { openSettings: () => {
        observed.push(route.kind === 'home' ? route.view : route.kind);
      } });
      return null;
    }
    render(<CommittedRouteProbe />);
    await settle();
    expect(observed).toEqual(['home']);
  });
  it('replaces /movies/:id with the in-workspace film editor (no extra history entry)', async () => {
    startAt('/movies/film-1');
    const length = window.history.length;
    render(<RedirectProbe openSettings={openSettings} />);
    await settle();
    expect(window.location.pathname).toBe('/projects/film-1/files/movie-studio.json');
    expect(window.history.length).toBe(length);
  });

  it('reads ?project= of an old /movies link', async () => {
    startAt('/movies?project=film-2');
    render(<RedirectProbe openSettings={openSettings} />);
    await settle();
    expect(window.location.pathname).toBe('/projects/film-2/files/movie-studio.json');
  });

  it('keeps /materials on the full page without opening a drawer', async () => {
    startAt('/materials');
    const length = window.history.length;
    const { rerender } = render(<RedirectProbe openSettings={openSettings} />);
    await settle();
    expect(window.location.pathname).toBe('/materials');
    expect(window.history.length).toBe(length);
    expect(getMaterialsDrawerState().open).toBe(false);

    // closing it and re-rendering on home does not reopen it
    act(() => resetMaterialsDrawerForTests());
    rerender(<RedirectProbe openSettings={openSettings} />);
    await settle();
    expect(getMaterialsDrawerState().open).toBe(false);
  });

  it('/tokentosea → home, then Settings ▸ 账户 once; Back would return home', async () => {
    startAt('/tokentosea');
    const length = window.history.length;
    render(
      <StrictMode>
        <RedirectProbe openSettings={openSettings} />
      </StrictMode>,
    );
    await settle();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledWith('account');
    expect(window.location.pathname).toBe('/settings');
    // the legacy entry was replaced by home and settings pushed on top of it
    expect(window.history.length).toBe(length + 1);
  });

  it('/create/animation → home, then the create dialog (legacy-route source)', async () => {
    startAt('/create/animation');
    render(<RedirectProbe openSettings={openSettings} />);
    await settle();
    expect(window.location.pathname).toBe('/');
    expect(getMotionCreateRequest()).toEqual({ target: { kind: 'new-project' }, source: 'legacy-route' });
  });

  it('/create/animation/:id → the film editor of that project', async () => {
    startAt('/create/animation/film-5');
    render(<RedirectProbe openSettings={openSettings} />);
    await settle();
    expect(window.location.pathname).toBe('/projects/film-5/files/movie-studio.json');
    expect(getMotionCreateRequest()).toBeNull();
  });

  it('leaves a bare /movies (the films page the nav rail opens) in place without focusing the sidebar', async () => {
    const focus = vi.fn(() => true);
    subscribeWorkspaceCommand('sidebar.focus', focus);
    startAt('/movies');
    render(
      <StrictMode>
        <RedirectProbe openSettings={openSettings} />
      </StrictMode>,
    );
    await settle();
    expect(window.location.pathname).toBe('/movies');
    expect(focus).not.toHaveBeenCalled();
  });

  it('reopens the materials page after navigating away without a drawer', async () => {
    render(<RedirectProbe openSettings={openSettings} />);
    await settle();
    for (let round = 0; round < 2; round += 1) {
      act(() => resetMaterialsDrawerForTests());
      act(() => navigate({ kind: 'home', view: 'materials' }));
      await settle();
      expect(window.location.pathname).toBe('/resources');
      expect(getMaterialsDrawerState().open).toBe(false);
      act(() => navigate({ kind: 'home', view: 'home' }));
      await settle();
    }
  });

  it('runs no effect when a navigation guard rejects the redirect', async () => {
    startAt('/tokentosea');
    const guard = vi.fn(() => false);
    const unregister = registerNavigationGuard(guard);
    try {
      render(<RedirectProbe openSettings={openSettings} />);
      await settle();
      expect(guard).toHaveBeenCalledTimes(1);
      expect(window.location.pathname).toBe('/tokentosea');
      expect(getMaterialsDrawerState().open).toBe(false);
    } finally {
      unregister();
    }
  });

  it('leaves /movie-app and normal routes untouched', async () => {
    for (const url of ['/movie-app/film-1', '/projects/p1']) {
      startAt(url);
      const { unmount } = render(<RedirectProbe openSettings={openSettings} />);
      await settle();
      expect(window.location.pathname).toBe(url);
      unmount();
    }
    expect(openSettings).not.toHaveBeenCalled();
    expect(getMaterialsDrawerState().open).toBe(false);
    expect(getMotionCreateRequest()).toBeNull();
  });
});
