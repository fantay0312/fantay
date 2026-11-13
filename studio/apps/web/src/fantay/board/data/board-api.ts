// SPDX-License-Identifier: AGPL-3.0-only
// Board HTTP client (spec 04 §7.1) against the daemon routes of `apps/daemon/src/fantay/board/routes.ts`:
// GET/PATCH/PUT /api/projects/:id/board, POST …/board/sync, PUT …/board/viewport, PUT/GET …/board/covers,
// POST …/board/import-design-canvas. Every call sends the workspace identity headers when a context is present.
import {
  boardApiPath,
  boardCoverApiPath,
  type BoardCoverRef,
  type BoardCoverUploadResponse,
  type BoardGetResponse,
  type BoardPatchRequest,
  type BoardPatchResponse,
  type BoardPutRequest,
  type BoardSyncRequest,
  type BoardSyncResponse,
  type BoardViewport,
  type BoardViewportPutRequest,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { workspaceProjectHeaders, workspaceResourceUrl } from '../../../collab/workspace-identity';

/** `code` = the daemon's `ApiError.code` (e.g. `CONFLICT`), `NETWORK_ERROR`, `ABORTED`, `INVALID_RESPONSE` or `HTTP_<status>`. */
export class BoardRequestError extends Error {
  readonly code: string;
  /** HTTP status; null when the request never got a response (network failure, abort). */
  readonly status: number | null;
  /** `ApiError.details` (e.g. `BoardConflictErrorDetails`), or the network error. */
  readonly details: unknown;

  constructor(message: string, init: { code: string; status: number | null; details?: unknown }) {
    super(message);
    this.name = 'BoardRequestError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
  }
}

export interface BoardRequestOptions {
  workspaceContext?: WorkspaceCollabContext | null;
  signal?: AbortSignal;
}

/** Network failures and 5xx keep the store's queue (offline retry). */
export function isBoardOfflineError(error: unknown): boolean {
  if (!(error instanceof BoardRequestError)) return true;
  if (error.code === 'ABORTED') return false;
  return error.status === null || error.status >= 500 || error.status === 408 || error.status === 429;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function errorFromResponse(response: Response): Promise<BoardRequestError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : null;
  const legacy = isRecord(body) && typeof body.error === 'string' ? body.error : null;
  const code = envelope && typeof envelope.code === 'string' ? envelope.code : `HTTP_${response.status}`;
  const message = envelope && typeof envelope.message === 'string'
    ? envelope.message
    : legacy ?? `board request failed (${response.status})`;
  return new BoardRequestError(message, { code, status: response.status, details: envelope?.details });
}

interface BoardFetchInit {
  method: 'GET' | 'PUT' | 'PATCH' | 'POST';
  json?: unknown;
  body?: Blob;
  contentType?: string;
  keepalive?: boolean;
}

async function boardFetch(url: string, init: BoardFetchInit, opts: BoardRequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.workspaceContext) Object.assign(headers, workspaceProjectHeaders(opts.workspaceContext));
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.body !== undefined) {
    headers['content-type'] = init.contentType ?? 'application/octet-stream';
    body = init.body;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers,
      cache: 'no-store',
      ...(body !== undefined ? { body } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(init.keepalive ? { keepalive: true } : {}),
    });
  } catch (error) {
    const aborted = opts.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
    throw new BoardRequestError(aborted ? 'board request aborted' : 'board request failed: the local service is unreachable', {
      code: aborted ? 'ABORTED' : 'NETWORK_ERROR',
      status: null,
      details: error,
    });
  }
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new BoardRequestError('board response was not JSON', { code: 'INVALID_RESPONSE', status: response.status, details: error });
  }
}

export async function fetchBoard(
  projectId: string,
  opts: BoardRequestOptions & { includeSync?: boolean } = {},
): Promise<BoardGetResponse> {
  const url = boardApiPath(projectId, opts.includeSync ? '?include=sync' : '');
  return readJson<BoardGetResponse>(await boardFetch(url, { method: 'GET' }, opts));
}

/** `keepalive` (extension) lets a final flush survive page unload. */
export async function patchBoard(
  projectId: string,
  body: BoardPatchRequest,
  opts: BoardRequestOptions & { keepalive?: boolean } = {},
): Promise<BoardPatchResponse> {
  const response = await boardFetch(boardApiPath(projectId), { method: 'PATCH', json: body, keepalive: opts.keepalive === true }, opts);
  return readJson<BoardPatchResponse>(response);
}

export async function putBoard(projectId: string, body: BoardPutRequest, opts: BoardRequestOptions = {}): Promise<BoardGetResponse> {
  return readJson<BoardGetResponse>(await boardFetch(boardApiPath(projectId), { method: 'PUT', json: body }, opts));
}

export async function syncBoard(projectId: string, body: BoardSyncRequest, opts: BoardRequestOptions = {}): Promise<BoardSyncResponse> {
  return readJson<BoardSyncResponse>(await boardFetch(boardApiPath(projectId, '/sync'), { method: 'POST', json: body }, opts));
}

export async function putBoardViewport(
  projectId: string,
  viewport: BoardViewport,
  opts: BoardRequestOptions & { keepalive?: boolean; pageId?: string } = {},
): Promise<void> {
  const body: BoardViewportPutRequest = {
    viewport: { centerX: viewport.centerX, centerY: viewport.centerY, zoom: viewport.zoom },
    ...(opts.pageId ? { pageId: opts.pageId } : {}),
  };
  await boardFetch(boardApiPath(projectId, '/viewport'), { method: 'PUT', json: body, keepalive: opts.keepalive === true }, opts);
}

/** Uploads a cover image (webp/png/jpeg, ≤ 1.5 MiB); the node then gets `update {cover}` (plan R1). */
export async function uploadBoardCover(
  projectId: string,
  image: Blob,
  size: { width: number; height: number; sourceMtime?: number },
  opts: BoardRequestOptions = {},
): Promise<BoardCoverUploadResponse> {
  const query = new URLSearchParams({ width: String(Math.round(size.width)), height: String(Math.round(size.height)) });
  if (size.sourceMtime !== undefined && Number.isFinite(size.sourceMtime) && size.sourceMtime >= 0) {
    query.set('sourceMtime', String(Math.floor(size.sourceMtime)));
  }
  const response = await boardFetch(
    `${boardApiPath(projectId, '/covers')}?${query.toString()}`,
    { method: 'PUT', body: image, contentType: image.type || 'image/png' },
    opts,
  );
  return readJson<BoardCoverUploadResponse>(response);
}

/**
 * `<img src>` for a node cover. `board-cover` → the digest route; `chat-artifact-snapshot` → the snapshot thumbnail.
 * Image loads cannot carry headers, so the workspace identity rides in the query (`workspaceResourceUrl`).
 */
export function boardCoverSrc(
  projectId: string,
  cover: BoardCoverRef,
  workspaceContext?: WorkspaceCollabContext | null,
): string {
  const path = cover.source === 'board-cover'
    ? boardCoverApiPath(projectId, cover.digest)
    : `/api/projects/${encodeURIComponent(projectId)}/chat-artifact-snapshots/${encodeURIComponent(cover.snapshotId)}/thumbnail`;
  return workspaceResourceUrl(path, workspaceContext);
}
