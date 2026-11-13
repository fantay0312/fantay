/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — what the shell (WorkbenchView) hands to its own parts: the studio, the assistant,
 * the settings and import dialogs. Pages get the narrower `WorkbenchPageProps` instead.
 */
import { createContext, useContext } from 'react';
import type { WorkbenchPage, WorkbenchPublicSettings } from '@open-design/contracts';

export interface WorkbenchShell {
  /** The page the studio returns to. */
  page: WorkbenchPage;
  /** Public settings; null until the daemon answers (image features then read as unavailable). */
  settings: WorkbenchPublicSettings | null;
  setSettings(next: WorkbenchPublicSettings): void;
  reloadSettings(): Promise<void>;
  openItem(id: string): void;
  closeItem(): void;
  produce(id: string, withImages?: boolean): void;
  openAssistant(prompt?: string): void;
  navigate(page: WorkbenchPage): void;
  openSettings(): void;
  openImport(): void;
  /** Start the TokenToSea sign-in (same flow as the sidebar account button). */
  signIn(): void;
  signingIn: boolean;
}

export const WorkbenchShellContext = createContext<WorkbenchShell | null>(null);

export function useWorkbenchShell(): WorkbenchShell {
  const shell = useContext(WorkbenchShellContext);
  if (!shell) throw new Error('useWorkbenchShell must be used inside WorkbenchView');
  return shell;
}
