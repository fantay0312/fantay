// SPDX-License-Identifier: AGPL-3.0-only
// HTML source loading for frames (spec 03 §5.1): only when a frame is promoted to live or enters Edit, never for
// covers, never above 2 MiB. Sources go through the app's shared snapshot cache (16 entries / 32 MB), keyed by the
// authorization scope like DesignFilesPanel, so the 文件 tab and the board share fetched bytes.
import type { ProjectFile, WorkspaceCollabContext } from '@open-design/contracts';

import { workspaceIdentityCacheKey } from '../../../collab/workspace-identity';
import {
  getHtmlSourceSnapshot,
  htmlSourceSnapshotRefreshKey,
  setHtmlSourceSnapshot,
} from '../../../components/html-source-snapshot-cache';
import { fetchProjectFileText } from '../../../providers/registry';
import { FRAME_SOURCE_MAX_BYTES } from './frame-transport';

/** `'local'`, or `'workspace:' + workspaceIdentityCacheKey(ctx)` (same rule as DesignFilesPanel). */
export function sourceScopeKey(workspaceContext: WorkspaceCollabContext | null | undefined): string {
  return workspaceContext ? `workspace:${workspaceIdentityCacheKey(workspaceContext)}` : 'local';
}

export interface FrameSourceRequest {
  projectId: string;
  file: Pick<ProjectFile, 'name' | 'mtime' | 'size'>;
  workspaceContext: WorkspaceCollabContext | null;
  signal?: AbortSignal;
}

export interface FrameSourceDeps {
  fetchText?: typeof fetchProjectFileText;
}

/** A cached source of exactly this file version, or null. */
export function cachedFrameSource(request: Omit<FrameSourceRequest, 'signal'>): string | null {
  if (request.file.size > FRAME_SOURCE_MAX_BYTES) return null;
  const hit = getHtmlSourceSnapshot(
    sourceScopeKey(request.workspaceContext),
    request.projectId,
    request.file.name,
    htmlSourceSnapshotRefreshKey(request.file, 0),
  );
  return hit ? hit.source : null;
}

/** Loads (and caches) the HTML source of a frame's file; null above 2 MiB or on failure. */
export async function loadFrameSource(request: FrameSourceRequest, deps: FrameSourceDeps = {}): Promise<string | null> {
  if (request.file.size > FRAME_SOURCE_MAX_BYTES) return null;
  const cached = cachedFrameSource(request);
  if (cached !== null) return cached;
  const fetchText = deps.fetchText ?? fetchProjectFileText;
  const source = await fetchText(request.projectId, request.file.name, {
    cacheBustKey: request.file.mtime,
    workspaceContext: request.workspaceContext,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (source === null || request.signal?.aborted) return null;
  setHtmlSourceSnapshot({
    authorizationScopeKey: sourceScopeKey(request.workspaceContext),
    projectId: request.projectId,
    fileName: request.file.name,
    refreshKey: htmlSourceSnapshotRefreshKey(request.file, 0),
    source,
  });
  return source;
}
