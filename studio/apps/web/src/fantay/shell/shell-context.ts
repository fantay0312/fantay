// SPDX-License-Identifier: AGPL-3.0-only
// Shell context (spec 02 §5.2 with plan R9): what surfaces inside the shell may ask of it. `useFantayShell()`
// is null when the shell is off, so every consumer keeps its upstream behaviour there.
import { createContext, useContext } from 'react';

import type { FantaySidebarMode } from './geometry';

export type { FantaySidebarMode } from './geometry';

export interface FantayShellContextValue {
  sidebarCollapsed: boolean;
  sidebarMode: FantaySidebarMode;
  toggleSidebar(): void;
  setSidebarCollapsed(collapsed: boolean): void;
  /** The workspace fills the window: sidebar and chat step aside until it is turned off. */
  workspaceMaximized: boolean;
  setWorkspaceMaximized(maximized: boolean): void;
  /** The right-hand workspace steps aside and the chat takes the room. Per project visit, like maximizing. */
  workspaceCollapsed: boolean;
  setWorkspaceCollapsed(collapsed: boolean): void;
  /** R9: 07's materials drawer (`openMaterialsDrawer()`). */
  openMaterials(): void;
  closeMaterials(): void;
  /** R9: `useMaterialsDrawer().open`. */
  materialsOpen: boolean;
  /** R9: Settings ▸ 账户 (`onOpenSettings('account')`); both tabs land on the one account section. */
  openAccountServices(tab?: 'account' | 'services'): void;
  openSearch(): void;
  /** Project route → a new conversation in that project; else → `newProject()`. */
  newChat(): void;
  /** Navigate home and focus the composer. */
  newProject(): void;
}

export const FantayShellContext = createContext<FantayShellContextValue | null>(null);
FantayShellContext.displayName = 'FantayShellContext';

/** null when the shell is off (or outside it). */
export function useFantayShell(): FantayShellContextValue | null {
  return useContext(FantayShellContext);
}
