// SPDX-License-Identifier: AGPL-3.0-only
// Saves tool output into the project (spec 05 §6.6): `board-media/<kind>/<stem>.<ext>` through the
// multipart project upload (it keeps sub-folders, 20 MB per file). Outputs are ordinary project
// files: visible in the Files tab, readable by agents and usable as generation references.
import { shortGenerationId, type BoardMediaFile, type WorkspaceCollabContext } from '@open-design/contracts';

import { uploadProjectFile } from '../../providers/registry';
import type { ProjectFile } from '../../types';
import { extensionForMime } from './encode';

export type ToolOutputKind = 'crops' | 'splits' | 'upscales' | 'frames' | 'refs';

export interface PersistDeps {
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  /** Injected in tests; defaults to `uploadProjectFile`. */
  upload?: (file: File, desiredPath: string) => Promise<ProjectFile | null>;
}

/**
 * `${kind}-${short(sourceNodeId)}-${short(String(now))}` plus `-r{row}c{col}` for split pieces
 * (1-based), e.g. `crops-k3f9a2-p0x7qe` / `splits-k3f9a2-p0x7qe-r1c2`.
 */
export function toolOutputStem(
  kind: ToolOutputKind,
  sourceNodeId: string,
  now: number,
  piece?: { row: number; column: number },
): string {
  const base = `${kind}-${shortGenerationId(sourceNodeId)}-${shortGenerationId(String(now))}`;
  return piece ? `${base}-r${piece.row + 1}c${piece.column + 1}` : base;
}

/** `board-media/<kind>/<stem>.<ext>`; the extension follows the blob type (png when unknown). */
export function toolOutputPath(kind: ToolOutputKind, stem: string, blob: Blob): string {
  const ext = extensionForMime(blob.type) ?? 'png';
  return `board-media/${kind}/${stem}.${ext}`;
}

/**
 * Uploads `blob` and returns the board media file (`path`, `mime`, `size`, `mtime`, plus `width` /
 * `height` when the caller knows them). Null when the upload failed (callers toast
 * `fantay.media.saveFailed`).
 */
export async function persistToolOutput(
  deps: PersistDeps,
  blob: Blob,
  kind: ToolOutputKind,
  stem: string,
  dims?: { width: number; height: number },
): Promise<BoardMediaFile | null> {
  const desiredPath = toolOutputPath(kind, stem, blob);
  const fileName = desiredPath.slice(desiredPath.lastIndexOf('/') + 1);
  const mime = blob.type || 'image/png';
  const file = new File([blob], fileName, { type: mime });
  const upload =
    deps.upload ?? ((upload: File, path: string) => uploadProjectFile(deps.projectId, upload, path, deps.workspaceContext));
  let saved: ProjectFile | null = null;
  try {
    saved = await upload(file, desiredPath);
  } catch {
    saved = null;
  }
  if (!saved) return null;
  const result: BoardMediaFile = {
    path: saved.name || desiredPath,
    mime: saved.mime || mime,
    size: typeof saved.size === 'number' ? saved.size : blob.size,
  };
  if (typeof saved.mtime === 'number' && Number.isFinite(saved.mtime)) result.mtime = saved.mtime;
  if (dims && dims.width > 0 && dims.height > 0) {
    result.width = Math.round(dims.width);
    result.height = Math.round(dims.height);
  }
  return result;
}

/** Reads the pixel size of an encoded image (null when the browser cannot decode it here). */
export async function measureImageBlob(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}
