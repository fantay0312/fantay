// SPDX-License-Identifier: AGPL-3.0-only
// Default chat column of 420 px in Fantay mode (spec 02 §7.6), installed at module evaluation through the
// `project-split-layout.ts` policy seam. FantayShell imports this module and App imports FantayShell eagerly,
// so the policy is in place before any ProjectView measures its split. A width the user dragged still wins
// (`resolveProjectSplitLayout` reads the saved width first); with the shell off nothing is installed.
import { setDefaultChatPanelWidthPolicy } from '../../components/project-split-layout';
import { isFantayShellEnabled } from './flags';
import { FANTAY_DEFAULT_CHAT_PANEL_WIDTH } from './geometry';

/** The uncustomized chat width in Fantay mode; the seam clamps it to what the split allows. */
export function fantayDefaultChatPanelWidth(): number {
  return FANTAY_DEFAULT_CHAT_PANEL_WIDTH;
}

/** Installs the policy when the shell is on; returns whether it did. */
export function installFantaySplitPolicy(enabled: boolean = isFantayShellEnabled()): boolean {
  if (!enabled) return false;
  setDefaultChatPanelWidthPolicy(fantayDefaultChatPanelWidth);
  return true;
}

installFantaySplitPolicy();
