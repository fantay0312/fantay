// SPDX-License-Identifier: AGPL-3.0-only
// HTTP client of the board generation service (spec 05 §4.4): the existing daemon media endpoints, with the
// project's workspace identity on every call. All requests go through the injected `fetch` so tests drive a
// fake daemon; the URLs and headers are the ones `providers/registry.ts` uses for the same endpoints.
import {
  parseDaemonApiError,
  parseMediaGenerateAccepted,
  parseMediaTaskSnapshot,
  type DaemonApiErrorInfo,
  type MediaGenerateAccepted,
  type MediaGenerateRequest,
  type MediaTaskSnapshotResponse,
  type MediaTaskWaitRequest,
  type ProjectFile,
  type ProjectMediaTask,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { workspaceProjectHeaders } from '../../collab/workspace-identity';
import { invalidateProjectFilesCache } from '../../providers/registry';

export interface DispatchDeps {
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  fetch: typeof fetch;
}

export type GenerateResult =
  | { ok: true; accepted: MediaGenerateAccepted }
  | { ok: false; error: DaemonApiErrorInfo }
  | { ok: false; network: string };

export type WaitResult =
  | { kind: 'snapshot'; snapshot: MediaTaskSnapshotResponse }
  | { kind: 'gone' }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'aborted' };

function projectPath(projectId: string, suffix: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}${suffix}`;
}

function identityHeaders(d: DispatchDeps): Record<string, string> {
  return d.workspaceContext ? (workspaceProjectHeaders(d.workspaceContext) as Record<string, string>) : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** POST /api/projects/:id/media/generate (202 `{taskId,status,startedAt}`). */
export async function postGenerate(d: DispatchDeps, body: MediaGenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
  let response: Response;
  try {
    response = await d.fetch(projectPath(d.projectId, '/media/generate'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...identityHeaders(d) },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    return { ok: false, network: isAbortError(error, signal) ? 'aborted' : errorText(error) };
  }
  const payload = await readBody(response);
  if (!response.ok) return { ok: false, error: parseDaemonApiError(response.status, payload) };
  const accepted = parseMediaGenerateAccepted(payload);
  if (!accepted) {
    return { ok: false, error: { status: response.status, message: 'The daemon accepted the request without a task id.' } };
  }
  return { ok: true, accepted };
}

/** POST /api/media/tasks/:id/wait; 404 (task GC'd or unknown) → `gone`. */
export async function waitTask(
  d: DispatchDeps,
  taskId: string,
  body: MediaTaskWaitRequest,
  signal: AbortSignal,
): Promise<WaitResult> {
  if (signal.aborted) return { kind: 'aborted' };
  let response: Response;
  try {
    response = await d.fetch(`/api/media/tasks/${encodeURIComponent(taskId)}/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...identityHeaders(d) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal)) return { kind: 'aborted' };
    return { kind: 'network', message: errorText(error) };
  }
  if (response.status === 404) return { kind: 'gone' };
  let payload: unknown;
  try {
    payload = await readBody(response);
  } catch (error) {
    if (isAbortError(error, signal)) return { kind: 'aborted' };
    return { kind: 'network', message: errorText(error) };
  }
  if (!response.ok) return { kind: 'error', status: response.status, message: parseDaemonApiError(response.status, payload).message };
  const snapshot = parseMediaTaskSnapshot(payload);
  if (!snapshot) return { kind: 'error', status: response.status, message: 'The daemon returned a malformed task snapshot.' };
  return { kind: 'snapshot', snapshot };
}

/** GET /api/projects/:id/media/tasks?includeDone=1 (same request as registry `fetchProjectMediaTasks`). */
export async function listProjectTasks(d: DispatchDeps): Promise<ProjectMediaTask[]> {
  const response = await d.fetch(projectPath(d.projectId, '/media/tasks?includeDone=1'), {
    cache: 'no-store',
    headers: identityHeaders(d),
  });
  if (!response.ok) throw new Error(`media tasks ${response.status}`);
  const payload = (await response.json()) as { tasks?: unknown };
  return Array.isArray(payload.tasks) ? (payload.tasks as ProjectMediaTask[]) : [];
}

/** GET /api/projects/:id/files, never from a cache (same request as registry `fetchProjectFiles({fresh})`). */
export async function listProjectFilesFresh(d: DispatchDeps): Promise<ProjectFile[]> {
  const response = await d.fetch(projectPath(d.projectId, '/files'), {
    cache: 'no-store',
    headers: identityHeaders(d),
  });
  if (!response.ok) throw new Error(`Project files request failed (${response.status})`);
  const payload = (await response.json()) as { files?: unknown };
  if (!Array.isArray(payload.files)) throw new Error('Project files response was malformed');
  return payload.files as ProjectFile[];
}

/**
 * Multipart POST /api/projects/:id/files with `name` = `desiredPath` (sub-folders kept, 20 MB cap; same as
 * registry `uploadProjectFile`). Invalidates the shared project-file list so the Files tab sees the file.
 */
export async function uploadToProject(d: DispatchDeps, blob: Blob, desiredPath: string): Promise<ProjectFile | null> {
  const baseName = desiredPath.slice(desiredPath.lastIndexOf('/') + 1) || 'upload';
  try {
    const form = new FormData();
    const file = typeof File === 'function' ? new File([blob], baseName, { type: blob.type }) : blob;
    form.append('file', file, baseName);
    form.append('name', desiredPath);
    const response = await d.fetch(projectPath(d.projectId, '/files'), {
      method: 'POST',
      headers: identityHeaders(d),
      body: form,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { file?: ProjectFile };
    if (!payload.file || typeof payload.file.name !== 'string') return null;
    try {
      invalidateProjectFilesCache(d.projectId, d.workspaceContext);
    } catch {
      // The cache is an optimisation of other readers; the upload itself succeeded.
    }
    return payload.file;
  } catch {
    return null;
  }
}
