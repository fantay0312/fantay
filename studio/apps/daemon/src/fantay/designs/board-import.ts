// SPDX-License-Identifier: Apache-2.0
// `POST /api/projects/:id/board/import-design-canvas` (spec 04 §4.7 composed per plan R11): legacy design-canvas
// documents become project files through `DesignDocumentService.importLegacy` (the single writer of imported files),
// then `design` nodes with `migratedFrom` are added through the board service's `applyOps` (reason `import`), so the
// board commit, the B13 stamps, the change set and the `board-changed` SSE come from the W1 pipeline.
//
// Idempotency: a document whose design node (same `migratedFrom.documentId` + `sha256`) is on the board with its file
// present is `already-imported` and nothing is written. The op builder runs inside the board's commit transaction and
// re-checks the board there, so concurrent imports cannot add a second node.
import { randomBytes } from 'node:crypto';
import {
  BOARD_GROUP_MIN_SIZE,
  BOARD_LAYOUT,
  BOARD_LIMITS,
  defaultBoardNodeSize,
  layoutRow,
  refitGroupRect,
  stableBoardId,
  type BoardContent,
  type BoardDesignNode,
  type BoardImportDesignCanvasResponse,
  type BoardImportDesignCanvasResult,
  type BoardNode,
  type BoardNodeDraft,
  type BoardNodePatch,
  type BoardOp,
  type BoardPatchResponse,
  type BoardPlacement,
  type DesignDocumentFormat,
} from '@open-design/contracts';

import type { BoardService, BoardServiceResult } from '../board/service.js';
import { DesignInputError } from './errors.js';
import type { DesignDocumentService, LegacyDesignInfo } from './service.js';

/** Documents per board batch: each adds at most two ops (node + group/update), so a batch stays within maxOpsPerPatch. */
export const DESIGN_IMPORT_DOCUMENTS_PER_BATCH = Math.floor((BOARD_LIMITS.maxOpsPerPatch - 1) / 2);

export interface DesignCanvasBoardImportDeps {
  designs: Pick<DesignDocumentService, 'importLegacy' | 'legacyInfo' | 'stat'>;
  board: Pick<BoardService, 'get' | 'applyOps'>;
  /** Best effort: give the imported file a workspace identity so the node follows renames (04 §4.4.1 step 4). */
  ensureIdentity?: (projectId: string, path: string, mtime: number) => void;
  newId?: () => string;
  warn?: (message: string, detail?: unknown) => void;
}

export interface DesignCanvasBoardImportInput {
  projectId: string;
  metadata?: unknown;
  documentIds: readonly string[];
  placement?: BoardPlacement;
}

export interface ImportCandidate {
  documentId: string;
  path: string;
  format: DesignDocumentFormat;
  sha256: string;
  /** `importLegacy` wrote the project file in this request (it was missing). */
  written?: boolean;
}

export interface BatchPlan {
  ops: BoardOp[];
  results: BoardImportDesignCanvasResult[];
}

function defaultNewId(): string {
  return `n_${randomBytes(10).toString('hex')}`;
}

function migratedDesignNode(nodes: readonly BoardNode[], documentId: string, sha256: string): BoardDesignNode | null {
  for (const node of nodes) {
    if (node.kind === 'design' && node.migratedFrom?.documentId === documentId && node.migratedFrom.sha256 === sha256) return node;
  }
  return null;
}

/** Size of a `row` group laid out from its children (same math as the op engine's re-layout and refit). */
function rowGroupSize(sizes: ReadonlyArray<{ w: number; h: number }>): { w: number; h: number } {
  if (sizes.length === 0) return { ...BOARD_GROUP_MIN_SIZE };
  const items = sizes.map((size, index) => ({ id: String(index).padStart(6, '0'), x: 0, y: 0, w: size.w, h: size.h }));
  const positions = layoutRow(items, { x: BOARD_LAYOUT.groupPad, y: BOARD_LAYOUT.groupHeader }, BOARD_LAYOUT.itemGap, BOARD_LAYOUT.rowWrapWidth, 'input');
  const rects = positions.map((position, index) => ({ x: position.x, y: position.y, w: items[index]!.w, h: items[index]!.h }));
  const rect = refitGroupRect({ x: 0, y: 0, w: 0, h: 0 }, rects);
  return { w: rect.w, h: rect.h };
}

/**
 * Ops for one batch against the board content inside the commit transaction. Existing nodes of the same import are
 * reused; one whose file moved, went missing or was just re-created gets a fresh `ref` (path only, so the commit
 * fills the file's live workspace identity instead of keeping a tombstoned one that the next sync would treat as a
 * deletion). New nodes get a stable id per document revision; two or more go into a new `section`/`design` row group
 * (04 §4.7).
 */
export function planDesignImportOps(
  content: BoardContent,
  candidates: readonly ImportCandidate[],
  placement: BoardPlacement,
  newId: () => string,
): BatchPlan {
  const taken = new Set<string>([...content.nodes.map((node) => node.id), ...content.edges.map((edge) => edge.id)]);
  const freshId = (preferred: string): string => {
    let id = preferred;
    while (taken.has(id)) id = newId();
    taken.add(id);
    return id;
  };
  const ops: BoardOp[] = [];
  const results: BoardImportDesignCanvasResult[] = [];
  const drafts: BoardNodeDraft[] = [];
  for (const candidate of candidates) {
    const existing = migratedDesignNode(content.nodes, candidate.documentId, candidate.sha256);
    if (existing) {
      const repair = candidate.written === true || existing.missing !== undefined || existing.ref.path !== candidate.path;
      if (repair) {
        const patch: BoardNodePatch = { ref: { path: candidate.path } };
        if (existing.missing) patch.missing = null;
        ops.push({ op: 'update', id: existing.id, patch });
      }
      results.push({ documentId: candidate.documentId, status: repair ? 'imported' : 'already-imported', path: candidate.path, nodeId: existing.id });
      continue;
    }
    const id = freshId(stableBoardId('n', `design-canvas:${candidate.documentId}:${candidate.sha256}`));
    drafts.push({
      id,
      kind: 'design',
      ref: { path: candidate.path },
      format: candidate.format,
      migratedFrom: { store: 'design-canvas', documentId: candidate.documentId, sha256: candidate.sha256 },
      origin: { source: 'migration' },
    });
    results.push({ documentId: candidate.documentId, status: 'imported', path: candidate.path, nodeId: id });
  }
  if (drafts.length >= 2) {
    const groupId = freshId(newId());
    const size = rowGroupSize(drafts.map(() => defaultBoardNodeSize('design')));
    ops.push({
      op: 'add',
      node: { id: groupId, kind: 'group', role: 'section', sectionKind: 'design', layout: 'row', w: size.w, h: size.h },
      placement,
    });
    for (const draft of drafts) ops.push({ op: 'add', node: { ...draft, parentId: groupId } });
  } else if (drafts.length === 1) {
    ops.push({ op: 'add', node: drafts[0]!, placement });
  }
  return { ops, results };
}

function isEmptyPatch(response: BoardPatchResponse): boolean {
  return response.inverse.length === 0;
}

export async function importDesignCanvasIntoBoard(
  deps: DesignCanvasBoardImportDeps,
  input: DesignCanvasBoardImportInput,
): Promise<BoardServiceResult<BoardImportDesignCanvasResponse>> {
  const warn = deps.warn ?? ((message: string, detail?: unknown) => console.warn(`[fantay-designs] ${message}`, detail ?? ''));
  const newId = deps.newId ?? defaultNewId;
  const placement: BoardPlacement = input.placement ?? { mode: 'auto' };
  const { projectId, metadata } = input;
  const results = new Map<string, BoardImportDesignCanvasResult>();
  const candidates: ImportCandidate[] = [];
  const nodes = deps.board.get(projectId).board.nodes;

  for (const documentId of input.documentIds) {
    let info: LegacyDesignInfo | null;
    try {
      info = await deps.designs.legacyInfo(documentId);
    } catch (error) {
      if (!(error instanceof DesignInputError)) throw error;
      warn(`legacy design document ${documentId} cannot be imported`, error.message);
      results.set(documentId, { documentId, status: error.reason === 'LEGACY_NOT_FOUND' ? 'not-found' : 'invalid' });
      continue;
    }
    if (!info) {
      results.set(documentId, { documentId, status: 'not-found' });
      continue;
    }
    const onBoard = migratedDesignNode(nodes, documentId, info.legacySha256);
    if (onBoard && !onBoard.missing && (await deps.designs.stat(projectId, onBoard.ref.path, metadata))) {
      results.set(documentId, { documentId, status: 'already-imported', path: onBoard.ref.path, nodeId: onBoard.id });
      continue;
    }
    try {
      const imported = await deps.designs.importLegacy(projectId, documentId, undefined, metadata);
      candidates.push({
        documentId,
        path: imported.summary.path,
        format: imported.summary.format,
        sha256: imported.migration.legacySha256,
        written: !imported.alreadyImported,
      });
      deps.ensureIdentity?.(projectId, imported.summary.path, imported.summary.mtime);
    } catch (error) {
      if (!(error instanceof DesignInputError) || (error.reason !== 'LEGACY_NOT_FOUND' && error.reason !== 'INVALID_DESIGN_DATA')) throw error;
      warn(`legacy design document ${documentId} cannot be imported`, error.message);
      results.set(documentId, { documentId, status: error.reason === 'LEGACY_NOT_FOUND' ? 'not-found' : 'invalid' });
    }
  }

  const committed: BoardPatchResponse[] = [];
  for (let start = 0; start < candidates.length; start += DESIGN_IMPORT_DOCUMENTS_PER_BATCH) {
    const batch = candidates.slice(start, start + DESIGN_IMPORT_DOCUMENTS_PER_BATCH);
    // The builder runs once, inside the board's commit transaction; its plan describes what was committed.
    let plan: BatchPlan = { ops: [], results: [] };
    // Later batches go below the content (`auto`) so they do not land on the first batch's requested spot.
    const batchPlacement: BoardPlacement = start === 0 ? placement : { mode: 'auto' };
    const outcome = await deps.board.applyOps({
      projectId,
      reason: 'import',
      ops: (content) => {
        plan = planDesignImportOps(content, batch, batchPlacement, newId);
        return plan.ops;
      },
    });
    if (!outcome.ok) return outcome;
    for (const result of plan.results) results.set(result.documentId, result);
    committed.push(outcome.value);
  }

  const changed = committed.filter((response) => !isEmptyPatch(response));
  const revision = committed.length > 0 ? committed[committed.length - 1]!.revision : deps.board.get(projectId).board.revision;
  return {
    ok: true,
    value: {
      revision,
      results: input.documentIds.map((documentId) => results.get(documentId) ?? { documentId, status: 'not-found' as const }),
      // One change set when one batch changed the board; a multi-batch import reports none (like `od board import-canvas`).
      changes: changed.length === 1 && committed.length === 1 ? changed[0]!.changes : null,
    },
  };
}
