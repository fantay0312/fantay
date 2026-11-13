// SPDX-License-Identifier: AGPL-3.0-only
// Material → board (spec 07 §7.1): copy the record into the project when it has files (the daemon's
// `POST /api/materials/items/:id/apply`, the same route `od materials apply` uses), map it to exactly one
// board draft, and hand the draft to the mounted board through the workspace bus — or queue it for the
// board of that project to drain when it mounts. Websites are bookmarks: they never copy anything.
import {
  BOARD_IMAGE_EXTENSIONS,
  BOARD_VIDEO_EXTENSIONS,
  type MaterialApplyResponse,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import {
  isWebsiteMaterial,
  materialBlurb,
  safeMaterialSourceUrl,
} from '../../components/materials/material-model';
import { applyMaterialItem } from '../../providers/materials';
import { invalidateProjectFilesCache } from '../../providers/registry';
import {
  queueBoardInsert,
  sendWorkspaceCommand,
  type FantayNodeDraft,
  type NodeProvenance,
  type WorkspaceCommandOf,
} from '../workspace/workspace-bus';
import type { MaterialDragItem } from './material-drag';

const IMAGE_EXTENSIONS: readonly string[] = BOARD_IMAGE_EXTENSIONS;
const VIDEO_EXTENSIONS: readonly string[] = BOARD_VIDEO_EXTENSIONS;
const FRAME_EXTENSIONS: readonly string[] = ['.html', '.htm'];

function lowerExtension(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function provenanceFor(item: MaterialDragItem, applied: MaterialApplyResponse | null): NodeProvenance {
  const sourceUrl = safeMaterialSourceUrl(item.source);
  return {
    source: 'material',
    materialId: item.id,
    license: item.license,
    ...(applied?.receiptRelPath ? { receiptPath: applied.receiptRelPath } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

/** The copied file a node should show: the apply response lists the thumbnail first and the main entry last. */
export function materialMainPath(applied: MaterialApplyResponse | null): string | null {
  if (!applied) return null;
  const fromAttachments = applied.attachments.at(-1);
  if (fromAttachments) return fromAttachments;
  const file = applied.files.find((entry) => entry.relPath && entry.relPath !== applied.receiptRelPath);
  return file?.relPath ?? null;
}

/**
 * Exactly one draft per material, each carrying its provenance:
 * a website → `web` (http(s) source) or a `note` (no usable URL); otherwise the main copied file →
 * `image` / `video` / `frame` by extension, anything else a `note` naming the file.
 */
export function materialDrafts(item: MaterialDragItem, applied: MaterialApplyResponse | null): FantayNodeDraft[] {
  const provenance = provenanceFor(item, applied);
  const title = item.title;
  const blurb = materialBlurb(item);
  if (isWebsiteMaterial(item)) {
    const url = safeMaterialSourceUrl(item.source);
    if (url) return [{ kind: 'web', url, title, provenance }];
    return [{ kind: 'note', title, text: blurb || title, provenance }];
  }
  const path = materialMainPath(applied);
  if (path) {
    const extension = lowerExtension(path);
    if (IMAGE_EXTENSIONS.includes(extension)) return [{ kind: 'image', path, title, provenance }];
    if (VIDEO_EXTENSIONS.includes(extension)) return [{ kind: 'video', path, title, provenance }];
    if (FRAME_EXTENSIONS.includes(extension)) return [{ kind: 'frame', path, title, provenance }];
  }
  return [{ kind: 'note', title, text: [title, blurb, path].filter(Boolean).join('\n'), provenance }];
}

export interface InsertMaterialInput {
  item: MaterialDragItem;
  projectId: string;
  /** World coordinates (a drop point); absent → the board places it in view. */
  at?: { x: number; y: number };
  workspaceContext?: WorkspaceCollabContext | null;
}

export interface InsertMaterialResult {
  drafts: FantayNodeDraft[];
  /** `board`: a mounted board took it; `queued`: it waits for the project's board to mount. */
  delivered: 'board' | 'queued';
}

/** Apply (unless a website) → refresh the project file list → `board.insert`, else queue it. Throws when apply fails. */
export async function insertMaterialToBoard(input: InsertMaterialInput): Promise<InsertMaterialResult> {
  const { item, projectId, at, workspaceContext = null } = input;
  let applied: MaterialApplyResponse | null = null;
  if (!isWebsiteMaterial(item)) {
    applied = await applyMaterialItem(item.id, { projectId }, workspaceContext);
    invalidateProjectFilesCache(projectId, workspaceContext);
  }
  const drafts = materialDrafts(item, applied);
  const command: WorkspaceCommandOf<'board.insert'> = {
    type: 'board.insert',
    projectId,
    drafts,
    ...(at ? { at } : {}),
    select: true,
  };
  if (sendWorkspaceCommand(command)) return { drafts, delivered: 'board' };
  queueBoardInsert(command);
  return { drafts, delivered: 'queued' };
}
