// SPDX-License-Identifier: Apache-2.0
// Empty board values and the canonical edge order (re-exported through ops.ts / changes.ts).
import {
  BOARD_SCHEMA_VERSION,
  type BoardContent,
  type BoardDocument,
  type BoardEdge,
  type BoardSettings,
  type BoardSyncLedger,
} from '../api/board.js';

export function defaultBoardSettings(): BoardSettings {
  return { background: 'dots', autoPlace: true };
}

export function emptyBoardContent(): BoardContent {
  return { settings: defaultBoardSettings(), nodes: [], edges: [] };
}

/** What a project without a stored board reads as (revision 0). */
export function emptyBoardDocument(projectId: string): BoardDocument {
  return {
    schemaVersion: BOARD_SCHEMA_VERSION,
    projectId,
    revision: 0,
    updatedAt: 0,
    updatedBy: null,
    viewport: null,
    settings: defaultBoardSettings(),
    nodes: [],
    edges: [],
  };
}

export function emptyBoardSyncLedger(): BoardSyncLedger {
  return { version: 1, seededAt: null, cursor: 0, turns: {}, mediaTasks: {}, dismissed: {} };
}

/**
 * Canonical edge order: `createdAt`, then `id`. `content.edges` is always kept in this order, which is also the
 * reference order of a generator's inputs (plan R3e).
 */
export function compareBoardEdges(a: Pick<BoardEdge, 'createdAt' | 'id'>, b: Pick<BoardEdge, 'createdAt' | 'id'>): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
