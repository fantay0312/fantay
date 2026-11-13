// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DESIGN_FILES_TAB, DESIGN_SYSTEM_TAB } from '../../../src/components/FileWorkspace';
import {
  BOARD_TAB,
  PROJECT_DESIGN_SYSTEM_TAB,
} from '../../../src/fantay/workspace/board-host-contract';
import {
  WORKSPACE_DESIGN_FILES_TAB,
  WORKSPACE_DESIGN_SYSTEM_TAB,
  fantayRootFor,
  isFantayRootTabId,
  isRenderableFantayRootTab,
} from '../../../src/fantay/workspace/workspace-roots';

type RootsModule = typeof import('../../../src/fantay/workspace/workspace-roots');

/**
 * workspace-roots with FANTAY_BOARD_READY forced: false = the W1/W2 state, true = after
 * W3-board-assembly flips the constant. Board-dependent cases go through this, never through the
 * constant's current value, so they stay valid across that flip.
 */
async function loadWithBoardReady(ready: boolean): Promise<RootsModule> {
  vi.resetModules();
  vi.doMock('../../../src/fantay/workspace/board-host-contract', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/fantay/workspace/board-host-contract')>()),
    FANTAY_BOARD_READY: ready,
  }));
  return import('../../../src/fantay/workspace/workspace-roots');
}

describe('workspace roots', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/fantay/workspace/board-host-contract');
    vi.resetModules();
    vi.unstubAllEnvs();
    window.localStorage.clear();
  });

  it('mirrors the FileWorkspace tab ids without importing FileWorkspace', () => {
    expect(WORKSPACE_DESIGN_FILES_TAB).toBe(DESIGN_FILES_TAB);
    expect(WORKSPACE_DESIGN_SYSTEM_TAB).toBe(DESIGN_SYSTEM_TAB);
  });

  it('defines the Fantay root tab ids', () => {
    expect(BOARD_TAB).toBe('__board__');
    expect(PROJECT_DESIGN_SYSTEM_TAB).toBe('__project_design_system__');
  });

  it('recognizes only the two Fantay root tab ids', () => {
    expect(isFantayRootTabId(BOARD_TAB)).toBe(true);
    expect(isFantayRootTabId(PROJECT_DESIGN_SYSTEM_TAB)).toBe(true);
    expect(isFantayRootTabId(DESIGN_FILES_TAB)).toBe(false);
    expect(isFantayRootTabId(DESIGN_SYSTEM_TAB)).toBe(false);
    expect(isFantayRootTabId('index.html')).toBe(false);
  });

  it('renders the project design-system tab only with the shell on', () => {
    expect(isRenderableFantayRootTab(PROJECT_DESIGN_SYSTEM_TAB, true)).toBe(true);
    expect(isRenderableFantayRootTab(PROJECT_DESIGN_SYSTEM_TAB, false)).toBe(false);
    expect(isRenderableFantayRootTab('index.html', true)).toBe(false);
  });

  it('never renders the board before it is ready', async () => {
    const notReady = await loadWithBoardReady(false);
    expect(notReady.isRenderableFantayRootTab(BOARD_TAB, true)).toBe(false);
    expect(notReady.isRenderableFantayRootTab(BOARD_TAB, false)).toBe(false);
  });

  it('normalizes root tabs while the board is not ready', async () => {
    const notReady = await loadWithBoardReady(false);
    expect(notReady.normalizeFantayRootTab(BOARD_TAB, false)).toBe(DESIGN_FILES_TAB);
    expect(notReady.normalizeFantayRootTab(BOARD_TAB, true)).toBe(DESIGN_FILES_TAB);
    expect(notReady.normalizeFantayRootTab(PROJECT_DESIGN_SYSTEM_TAB, true)).toBe(DESIGN_SYSTEM_TAB);
    expect(notReady.normalizeFantayRootTab(PROJECT_DESIGN_SYSTEM_TAB, false)).toBe(PROJECT_DESIGN_SYSTEM_TAB);
    expect(notReady.normalizeFantayRootTab('index.html', false)).toBe('index.html');
  });

  it('maps active tabs onto the three roots', () => {
    expect(fantayRootFor(BOARD_TAB)).toBe('board');
    expect(fantayRootFor(DESIGN_SYSTEM_TAB)).toBe('designSystem');
    expect(fantayRootFor(PROJECT_DESIGN_SYSTEM_TAB)).toBe('designSystem');
    expect(fantayRootFor(DESIGN_FILES_TAB)).toBe('files');
    expect(fantayRootFor('index.html')).toBe('files');
    expect(fantayRootFor('live:a1')).toBe('files');
    expect(fantayRootFor('__browser__:1')).toBe('files');
    expect(fantayRootFor('terminal:t1')).toBe('files');
    expect(fantayRootFor('chat:c1')).toBe('files');
  });

  it('keeps the upstream default root and initial tab while the board is not ready', async () => {
    const notReady = await loadWithBoardReady(false);
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    expect(notReady.fantayDefaultRootTab(true, false)).toBe(notReady.WORKSPACE_START_TAB);
    expect(notReady.fantayDefaultRootTab(true, true)).toBeNull();
    expect(notReady.fantayDefaultRootTab(false, false)).toBeNull();
    expect(notReady.fantayInitialActiveTab('index.html')).toBe('index.html');
  });

  it('makes the board renderable and the default once ready', async () => {
    const ready = await loadWithBoardReady(true);
    expect(ready.isRenderableFantayRootTab(BOARD_TAB, true)).toBe(true);
    expect(ready.isRenderableFantayRootTab(BOARD_TAB, false)).toBe(false);
    expect(ready.normalizeFantayRootTab(BOARD_TAB, false)).toBe(BOARD_TAB);
    expect(ready.normalizeFantayRootTab(PROJECT_DESIGN_SYSTEM_TAB, true)).toBe(DESIGN_SYSTEM_TAB);
    expect(ready.fantayDefaultRootTab(true, false)).toBe(BOARD_TAB);
    expect(ready.fantayDefaultRootTab(true, true)).toBeNull();
    expect(ready.fantayDefaultRootTab(false, false)).toBeNull();
  });

  it('opens new projects on the board only when the shell is on and the board is ready', async () => {
    const ready = await loadWithBoardReady(true);
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    expect(ready.fantayInitialActiveTab('index.html')).toBe(BOARD_TAB);
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
    expect(ready.fantayInitialActiveTab('index.html')).toBe('index.html');
    window.localStorage.setItem('fantay.shell', 'on');
    expect(ready.fantayInitialActiveTab('index.html')).toBe(BOARD_TAB);
  });
});
