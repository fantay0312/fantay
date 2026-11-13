// SPDX-License-Identifier: AGPL-3.0-only
// File operations behind board actions (spec 03 §3.12, §3.14; invariant I4): duplicating a file-backed node copies
// its file (`<base>-copy<ext>` next to it) because the board holds one node per path (I1); deleting a file is a
// separate, confirmed action; copy path, download, pasted pages. Every write goes through the project file API.
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { workspaceProjectHeaders } from '../../../collab/workspace-identity';
import { deleteProjectFile, projectRawUrl, uploadProjectFiles, writeProjectTextFileDetailed } from '../../../providers/registry';
import { nodeFilePath } from '../model/contract-adapter';
import type { EngineNode, Point } from '../model/types';
import type { NewNodeDraft } from '../store/ops';
import { basenameOf, dirnameOf } from '../nodes/frame/project-files';
import { projectMediaUrl } from '../nodes/media/media-url';

/** Offset of duplicates (03 §3.12). */
export const DUPLICATE_OFFSET: Point = { x: 24, y: 24 };

/** Contract keys a duplicate must not carry over (server stamps, identity, the old file's cover). */
const NOT_COPIED = new Set([
  'id', 'kind', 'x', 'y', 'w', 'h', 'rev', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'missing', 'origin',
  'title', 'parentId', 'locked', 'hidden', 'variantLabel', 'ref', 'cover', 'refProxy', 'generation', 'pending', 'migratedFrom',
]);

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' };
}

/** `<base>-copy<ext>`, then `<base>-copy-2<ext>`, … — the first name not taken in its folder. */
export function copyNameFor(path: string, existing: ReadonlySet<string>): string {
  const dir = dirnameOf(path);
  const { base, ext } = splitName(basenameOf(path));
  const join = (name: string) => (dir ? `${dir}/${name}` : name);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? `${base}-copy${ext}` : `${base}-copy-${n}${ext}`;
    if (!existing.has(join(name).toLowerCase())) return name;
  }
}

/** `pasted-<yyyyMMdd-HHmmss>.html` (03 §3.12 paste priority 4). */
export function pastedHtmlName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `pasted-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.html`;
}

/** The bytes of a project file as a `File` (for copies across folders or projects). */
export async function fetchProjectFileBlob(
  projectId: string,
  path: string,
  workspaceContext: WorkspaceCollabContext | null,
  name = basenameOf(path),
): Promise<File | null> {
  try {
    const response = await fetch(projectRawUrl(projectId, path, workspaceContext), {
      cache: 'no-store',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
  } catch {
    return null;
  }
}

/** Draft of the copy of a file-backed node now showing `path` (same kind, size and settings, +24/+24). */
export function duplicateDraftFor(node: EngineNode, path: string, offset: Point = DUPLICATE_OFFSET): NewNodeDraft {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.source as unknown as Record<string, unknown>)) {
    if (NOT_COPIED.has(key) || value === undefined) continue;
    data[key] = value;
  }
  data.ref = { path };
  return {
    kind: node.kind,
    x: node.x + offset.x,
    y: node.y + offset.y,
    w: node.w,
    h: node.h,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    data,
  };
}

export interface DuplicateFileNodesInput {
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  nodes: readonly EngineNode[];
  existingPaths: ReadonlySet<string>;
  /** adds the copy's node (one transaction per copy) and returns its id */
  add(draft: NewNodeDraft): string;
  onFailed?(name: string): void;
}

/** Copies the files of file-backed nodes and adds a node per copy (03 §3.12); resolves the new node ids. */
export async function duplicateFileNodes(input: DuplicateFileNodesInput): Promise<string[]> {
  const taken = new Set([...input.existingPaths].map((path) => path.toLowerCase()));
  const ids: string[] = [];
  for (const node of input.nodes) {
    const path = nodeFilePath(node);
    if (!path || node.kind === 'motion') continue;
    const name = copyNameFor(path, taken);
    const file = await fetchProjectFileBlob(input.projectId, path, input.workspaceContext, name);
    if (!file) {
      input.onFailed?.(basenameOf(path));
      continue;
    }
    const result = await uploadProjectFiles(input.projectId, [file], dirnameOf(path), input.workspaceContext);
    const uploaded = result.uploaded[0];
    if (!uploaded?.path) {
      input.onFailed?.(name);
      continue;
    }
    taken.add(uploaded.path.toLowerCase());
    ids.push(input.add(duplicateDraftFor(node, uploaded.path)));
  }
  return ids;
}

/** Deletes a node's file after the user confirmed (I4); the node leaves the board with it. */
export async function deleteNodeFile(input: {
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  path: string;
  remove(): void;
  deleteFile?: typeof deleteProjectFile;
}): Promise<boolean> {
  const ok = await (input.deleteFile ?? deleteProjectFile)(input.projectId, input.path, input.workspaceContext);
  if (ok) input.remove();
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

/** Starts a browser download of a project file. */
export function downloadProjectFile(projectId: string, path: string, workspaceContext: WorkspaceCollabContext | null): void {
  if (typeof document === 'undefined') return;
  const anchor = document.createElement('a');
  anchor.href = projectMediaUrl(projectId, path, undefined, workspaceContext);
  anchor.download = basenameOf(path);
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Starts a browser download of a blob. */
export function downloadBlob(blob: Blob, name: string): void {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Writes pasted HTML as a new page at the project root; resolves its path. */
export async function writePastedHtml(projectId: string, html: string, workspaceContext: WorkspaceCollabContext | null, now = new Date()): Promise<string | null> {
  const result = await writeProjectTextFileDetailed(projectId, pastedHtmlName(now), html, { versionSource: 'manual' }, workspaceContext);
  return result.ok ? result.file.name : null;
}

/** Opens a URL in the system browser (new tab). */
export function openExternal(url: string): void {
  if (typeof window === 'undefined') return;
  window.open(url, '_blank', 'noopener,noreferrer');
}
