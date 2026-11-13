// SPDX-License-Identifier: AGPL-3.0-only
// Fantay workspace shell (spec 02). App imports `FantayShell` and `useFantayShellEnabled` from here; other
// Fantay modules import the leaf files (flags, commands, project-bridge) directly to stay cycle-free.
export { FantayShell, type FantayShellProps } from './FantayShell';
export { FANTAY_SHELL_STORAGE_KEY, isFantayShellEnabled, useFantayShellEnabled } from './flags';
export { FantayShellContext, useFantayShell, type FantayShellContextValue, type FantaySidebarMode } from './shell-context';
export {
  FANTAY_DEFAULT_CHAT_PANEL_WIDTH,
  SHELL_TOP_ROW_HEIGHT,
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_COLLAPSED_WIDTH_MAC_DESKTOP,
  SIDEBAR_OVERLAY_BREAKPOINT,
  SIDEBAR_WIDTH,
} from './geometry';
export { notifyShellGeometryChange } from './geometry-notify';
export type { FantaySidebarSectionId } from './sidebar-store';
