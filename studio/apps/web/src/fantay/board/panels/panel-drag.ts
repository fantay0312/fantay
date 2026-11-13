// SPDX-License-Identifier: AGPL-3.0-only
// Drag from the side panels onto the canvas. Same rules as `material-drag.ts`: the board accepts on `dragover` by type
// alone, and the drop rebuilds a clean payload because a drag can come from another window.
const BOARD_PANEL_MIME = 'application/x-fantay-board-panel+json';
const MAX_BYTES = 8 * 1024;

export type PanelDragPayload = { kind: 'file'; path: string } | { kind: 'link'; url: string } | { kind: 'asset'; id: string };

export function writePanelDrag(dataTransfer: DataTransfer, payload: PanelDragPayload, label: string): void {
  dataTransfer.setData(BOARD_PANEL_MIME, JSON.stringify(payload));
  dataTransfer.setData('text/plain', label);
  dataTransfer.effectAllowed = 'copy';
}

export function hasPanelDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(BOARD_PANEL_MIME);
}

export function readPanelDrag(dataTransfer: DataTransfer | null | undefined): PanelDragPayload | null {
  try {
    const raw = dataTransfer?.getData(BOARD_PANEL_MIME);
    if (!raw || raw.length > MAX_BYTES) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.kind === 'file' && typeof value.path === 'string') return { kind: 'file', path: value.path };
    if (value.kind === 'link' && typeof value.url === 'string') return { kind: 'link', url: value.url };
    if (value.kind === 'asset' && typeof value.id === 'string') return { kind: 'asset', id: value.id };
    return null;
  } catch {
    return null;
  }
}
