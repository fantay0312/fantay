// SPDX-License-Identifier: AGPL-3.0-only
// Board extension points (plan §3.2 verbatim, amendment C5). Generation (05), design documents (06) and
// motion/materials (07) inject their node bodies, panels and actions into the board engine (03) through
// `BoardExtensions`; W3-board-assembly builds the object. Every absent extension disables its UI entry
// with the tooltip `board.insert.unavailable`.
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import type { Dict } from '../../i18n/types';

/** `keyof Dict` (`i18n/types.ts` exports no `DictKey` alias, and W1–W3 do not edit `i18n/**`). */
type DictKey = keyof Dict;

export const BOARD_INTERACTIVE_ATTR = 'data-board-interactive';

export interface BoardNodeBodyProps {
  projectId: string;
  nodeId: string;
  kind: 'generator' | 'image' | 'video' | 'motion';
  width: number;              // world px
  height: number;
  zoom: number;               // settled zoom
  selected: boolean;
  live: boolean;              // engine-granted live slot (≤ 4 board-wide)
  requestLive(pinned: boolean): void; // true = pin live (e.g. playing); false = release
}
export interface BoardMotionBodyProps extends BoardNodeBodyProps {
  movie: { projectId: string; title?: string; aspect?: '16:9' | '9:16' | '1:1' };
  fileVersion?: number;       // movie-studio.json mtime
  onOpenEditor(): void;
  onDataChange(patch: { title?: string; aspect?: '16:9' | '9:16' | '1:1' }): void;
}
export interface BoardNodeAction {
  id: string; labelKey: DictKey; icon: LucideIcon; placement: 'bar' | 'more';
  disabledReasonKey?: DictKey; run(): void | Promise<void>;
}
export interface BoardExtensions {
  renderGeneratorBody?(props: BoardNodeBodyProps): ReactNode;
  renderGeneratorPanel?(props: { nodeId: string; onClose(): void }): ReactNode;
  renderImageBody?(props: BoardNodeBodyProps): ReactNode;
  renderVideoBody?(props: BoardNodeBodyProps): ReactNode;
  renderMotionBody?(props: BoardMotionBodyProps): ReactNode;
  /** C5: `design` nodes get actions too (open in OpenPencil, Figma snapshot to AI). */
  nodeActions?(nodeId: string, kind: 'image' | 'video' | 'design'): BoardNodeAction[];
  /** G tool / connection-create menu: returns the new generator id. */
  createGenerator?(input: { selectedIds: string[]; at: { x: number; y: number }; surface?: 'image' | 'video'; connectFrom?: string }): string | null;
  resolveDesignCover?(path: string): string | null;
  createDesignDocument?(): void;                       // opens NewDesignDialog
  openDesignDocument?(path: string): void;             // workspace.openEditor
  createMotion?(kind: 'animation' | 'video-edit'): void;
  openMotionStudio?(projectId: string): void;
  openMaterialsPicker?(): void;
  acceptsExternalDrag?(dataTransfer: DataTransfer): boolean;
  onExternalDrop?(dataTransfer: DataTransfer, world: { x: number; y: number }): boolean;
}
