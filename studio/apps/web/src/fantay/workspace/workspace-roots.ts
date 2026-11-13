// SPDX-License-Identifier: AGPL-3.0-only
// Workspace root-tab helpers (spec 02 §5.6): 画板 / 文件 / 设计系统 map onto FileWorkspace tab ids.
// Pure; FileWorkspace imports these, so this module must not import FileWorkspace (no cycle).
import { isFantayShellEnabled } from '../shell/flags';
import { BOARD_TAB, FANTAY_BOARD_READY, PROJECT_DESIGN_SYSTEM_TAB } from './board-host-contract';

/** Mirror of FileWorkspace's `DESIGN_FILES_TAB` (equality is asserted by a test). */
export const WORKSPACE_DESIGN_FILES_TAB = '__design_files__';
/** Mirror of FileWorkspace's `DESIGN_SYSTEM_TAB` (equality is asserted by a test). */
export const WORKSPACE_DESIGN_SYSTEM_TAB = '__design_system__';
export const WORKSPACE_START_TAB = '__workspace_start__';

export type FantayWorkspaceRoot = 'board' | 'files' | 'designSystem';

export function isFantayRootTabId(id: string): id is typeof BOARD_TAB | typeof PROJECT_DESIGN_SYSTEM_TAB {
  return id === BOARD_TAB || id === PROJECT_DESIGN_SYSTEM_TAB;
}

/** enabled && (id === PROJECT_DESIGN_SYSTEM_TAB || (id === BOARD_TAB && FANTAY_BOARD_READY)) */
export function isRenderableFantayRootTab(id: string, enabled: boolean): boolean {
  return enabled && (id === PROJECT_DESIGN_SYSTEM_TAB || (id === BOARD_TAB && FANTAY_BOARD_READY));
}

/** BOARD_TAB && !FANTAY_BOARD_READY → DESIGN_FILES_TAB; PROJECT_DESIGN_SYSTEM_TAB on a design-system project → DESIGN_SYSTEM_TAB; else id */
export function normalizeFantayRootTab(id: string, isDesignSystemProject: boolean): string {
  if (id === BOARD_TAB && !FANTAY_BOARD_READY) return WORKSPACE_DESIGN_FILES_TAB;
  if (id === PROJECT_DESIGN_SYSTEM_TAB && isDesignSystemProject) return WORKSPACE_DESIGN_SYSTEM_TAB;
  return id;
}

/** BOARD_TAB → board; DESIGN_SYSTEM_TAB | PROJECT_DESIGN_SYSTEM_TAB → designSystem; else files */
export function fantayRootFor(activeTab: string): FantayWorkspaceRoot {
  if (activeTab === BOARD_TAB) return 'board';
  if (activeTab === WORKSPACE_DESIGN_SYSTEM_TAB || activeTab === PROJECT_DESIGN_SYSTEM_TAB) return 'designSystem';
  return 'files';
}

/** Keep the project's initial editor when available; otherwise show the tools page. */
export function fantayDefaultRootTab(enabled: boolean, isDesignSystemProject: boolean): string | null {
  return enabled && !isDesignSystemProject ? (FANTAY_BOARD_READY ? BOARD_TAB : WORKSPACE_START_TAB) : null;
}

/** ProjectView initial-open seam: BOARD_TAB when shell on && FANTAY_BOARD_READY, else `fileName`. */
export function fantayInitialActiveTab(fileName: string): string {
  return FANTAY_BOARD_READY && isFantayShellEnabled() ? BOARD_TAB : fileName;
}
