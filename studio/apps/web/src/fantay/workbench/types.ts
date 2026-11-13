/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — the contract between the workbench shell (WorkbenchView) and its pages.
 */
import type { WorkbenchPage } from '@open-design/contracts';

export type WorkbenchTab = 'projects' | WorkbenchPage;

/** Props every top-level workbench page receives from WorkbenchView. */
export interface WorkbenchPageProps {
  /** The page is the visible one (pages stay mounted; pause timers and listeners when false). */
  active: boolean;
  /** Open the production studio (成稿工作区) for an item. */
  openItem(id: string): void;
  /** Start 一键成稿 for an item and open the studio. `withImages` overrides the settings default for this run. */
  produce(id: string, withImages?: boolean): void;
  /** Open the assistant panel, optionally pre-filling the composer. */
  openAssistant(prompt?: string): void;
  /** Switch to another workbench page. */
  navigate(page: WorkbenchPage): void;
  /** Open the workbench settings dialog. */
  openSettings(): void;
  /** Open the account-import dialog (TokenToSea 社媒数据). */
  openImport(): void;
}
