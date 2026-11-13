// SPDX-License-Identifier: AGPL-3.0-only
// URLs of project media for `<img>` / `<video>` / `<audio>` on the board: the raw route, cache-busted by mtime,
// with the workspace identity in the query (media elements cannot send headers).
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { appendResourceQuery, workspaceResourceUrl } from '../../../../collab/workspace-identity';
import { projectRawUrl } from '../../../../providers/registry';

export function projectMediaUrl(
  projectId: string,
  path: string,
  mtime: number | undefined,
  workspaceContext: WorkspaceCollabContext | null,
): string {
  const base = workspaceResourceUrl(projectRawUrl(projectId, path, workspaceContext), workspaceContext);
  return typeof mtime === 'number' && Number.isFinite(mtime) ? appendResourceQuery(base, `v=${Math.round(mtime)}`) : base;
}

/** `m:ss` (or `h:mm:ss`) of a duration in ms; tabular digits are applied by the styles. */
export function formatMediaTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}
