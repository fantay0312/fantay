// SPDX-License-Identifier: AGPL-3.0-only
// Fantay shell geometry (spec 02 §11.1). Every top row of the shell is 44 px so the macOS traffic lights
// (hiddenInset, trafficLightPosition {12, 16}) sit on one midline; the sidebar header reserves 76 px for them
// and the collapsed rail is 76 px wide on windowed macOS desktop.

export const SIDEBAR_WIDTH = 248;
export const DESKTOP_SIDEBAR_WIDTH = 220;
export const DESKTOP_TOP_ROW_HEIGHT = 36;
export const SIDEBAR_COLLAPSED_WIDTH = 0;
export const SIDEBAR_COLLAPSED_WIDTH_MAC_DESKTOP = 0;
export const SIDEBAR_OVERLAY_WIDTH = 280;
export const SHELL_TOP_ROW_HEIGHT = 44;
export const MAC_TRAFFIC_INSET = 76; // 12 (x) + 52 (3 lights) + 12 gap
export const SIDEBAR_OVERLAY_BREAKPOINT = 900; // web only
export const SIDEBAR_AUTO_COLLAPSE_BREAKPOINT = 1080;
export const DESKTOP_SIDEBAR_COMPACT_BREAKPOINT = 920;
export const DESKTOP_SIDEBAR_MINI_BREAKPOINT = 640;
export const FANTAY_DEFAULT_CHAT_PANEL_WIDTH = 420;
export const SIDEBAR_ENTER_MS = 200;
export const SIDEBAR_EXIT_MS = 140;

export type FantaySidebarMode = 'docked' | 'overlay';
export type FantayClientType = 'desktop' | 'web';
export type FantayViewportTier = 'wide' | 'compact' | 'mini';

/** Responsive viewport tier for multi-morphology layout adaptation. */
export function viewportTierFor(innerWidth: number): FantayViewportTier {
  if (innerWidth < DESKTOP_SIDEBAR_MINI_BREAKPOINT) return 'mini';
  if (innerWidth < DESKTOP_SIDEBAR_COMPACT_BREAKPOINT) return 'compact';
  return 'wide';
}

/**
 * `overlay` below 900 px on the web, or below 640 px (`mini` tier) on desktop:
 * the sidebar leaves the horizontal grid and becomes a top bar + modal sheet drawer
 * so the main workspace receives 100% of the window width.
 */
export function sidebarModeFor(innerWidth: number, clientType: FantayClientType): FantaySidebarMode {
  if (clientType === 'desktop') {
    return innerWidth < DESKTOP_SIDEBAR_MINI_BREAKPOINT ? 'overlay' : 'docked';
  }
  return innerWidth < SIDEBAR_OVERLAY_BREAKPOINT ? 'overlay' : 'docked';
}

/** The stored choice wins on wide screens; below 920 px windows always start on the compact rail. */
export function initialSidebarCollapsed(stored: boolean | null, innerWidth: number): boolean {
  if (innerWidth < DESKTOP_SIDEBAR_COMPACT_BREAKPOINT) return true;
  if (stored !== null) return stored;
  return innerWidth < SIDEBAR_AUTO_COLLAPSE_BREAKPOINT;
}

export interface SidebarWidthInput {
  mode: FantaySidebarMode;
  collapsed: boolean;
  chromeless: boolean;
  clientType: FantayClientType;
  hostPlatform: string | undefined;
  /** `html.is-window-fullscreen` (desktop runtime): the traffic lights are gone, the rail is 56 px again. */
  fullscreen: boolean;
}

/** The sidebar column's current width in px (published as `--fx-sidebar-w` for surfaces outside the shell). */
export function currentSidebarWidth(input: SidebarWidthInput): number {
  if (input.chromeless || input.mode === 'overlay') return 0;
  if (!input.collapsed) return input.clientType === 'desktop' ? DESKTOP_SIDEBAR_WIDTH : SIDEBAR_WIDTH;
  const macDesktop = input.clientType === 'desktop' && input.hostPlatform === 'darwin' && !input.fullscreen;
  return macDesktop ? SIDEBAR_COLLAPSED_WIDTH_MAC_DESKTOP : SIDEBAR_COLLAPSED_WIDTH;
}
