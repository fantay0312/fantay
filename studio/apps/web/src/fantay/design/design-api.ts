// SPDX-License-Identifier: AGPL-3.0-only
// Host-side daemon I/O for design documents (spec 06 §6.3). The host owns every request (the editor
// iframe never calls /api/*): project designs are project files under `designs/` with sha256
// compare-and-swap writes and covers; the legacy global store stays readable and importable.
import {
  DESIGN_BRIDGE_LIMITS,
  DESIGN_SHA256_HEADER,
  designCoverApiPath,
  designFileNameFromTitle,
  designFormatForPath,
  uniqueDesignPath,
  type DesignBridgeErrorCode,
  type DesignDocumentFormat,
  type DesignDocumentSaveResponse,
  type DesignDocumentSummary,
  type ProjectFile,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { workspaceProjectHeaders, workspaceResourceUrl } from '../../collab/workspace-identity';
import { invalidateProjectFilesCache, projectRawUrl } from '../../providers/registry';

type Ctx = WorkspaceCollabContext | null | undefined;

/** Multipart upload cap of `POST /api/projects/:id/files` (daemon upload limit). */
export const DESIGN_HTML_SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * A failed design request. `code` is the bridge error code it maps to (so `toDesignBridgeError` keeps it
 * when a bridge handler rethrows); `status` is the HTTP status (0 = network); `apiCode` the daemon's
 * `ApiErrorCode` when the body carried one.
 */
export class DesignApiError extends Error {
  readonly status: number;
  readonly code: DesignBridgeErrorCode;
  readonly apiCode: string | undefined;

  constructor(status: number, message: string, code: DesignBridgeErrorCode = bridgeCodeForStatus(status), apiCode?: string) {
    super(message);
    this.name = 'DesignApiError';
    this.status = status;
    this.code = code;
    this.apiCode = apiCode;
  }
}

/** HTTP status → bridge error code (0 = the request never got an answer). */
export function bridgeCodeForStatus(status: number): DesignBridgeErrorCode {
  if (status === 0) return 'NETWORK';
  if (status === 400 || status === 415 || status === 428) return 'INVALID_REQUEST';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'TOO_LARGE';
  return 'INTERNAL';
}

function requestHeaders(ctx: Ctx, extra?: Record<string, string>): Headers {
  const headers = new Headers(ctx ? workspaceProjectHeaders(ctx) : undefined);
  for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
  return headers;
}

function designsBase(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/designs`;
}

function withPathQuery(url: string, path: string): string {
  return `${url}?path=${encodeURIComponent(path)}`;
}

function networkMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Network error';
}

interface ParsedErrorBody {
  message: string;
  apiCode?: string;
  details?: unknown;
}

async function readErrorBody(resp: Response): Promise<ParsedErrorBody> {
  const fallback = `Request failed (${resp.status})`;
  try {
    const json = (await resp.json()) as { error?: { code?: unknown; message?: unknown; details?: unknown } | string; message?: unknown };
    if (typeof json.error === 'string') return { message: json.error || fallback };
    const error = json.error;
    const message = typeof error?.message === 'string' && error.message ? error.message : typeof json.message === 'string' && json.message ? json.message : fallback;
    return {
      message,
      ...(typeof error?.code === 'string' ? { apiCode: error.code } : {}),
      ...(error && 'details' in error ? { details: error.details } : {}),
    };
  } catch {
    return { message: fallback };
  }
}

async function failure(resp: Response): Promise<DesignApiError> {
  const body = await readErrorBody(resp);
  return new DesignApiError(resp.status, body.message, bridgeCodeForStatus(resp.status), body.apiCode);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new DesignApiError(0, networkMessage(error), 'NETWORK');
  }
}

/** `"<sha256>"` (strong validator). */
export function quoteEtag(sha256: string): string {
  return `"${sha256.replace(/"/g, '')}"`;
}

/** The sha256 inside an ETag header value (`"<sha>"` or `W/"<sha>"`); null when absent. */
export function parseEtag(value: string | null | undefined): string | null {
  if (!value) return null;
  const sha = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '').trim();
  return sha || null;
}

/* ── project designs ──────────────────────────────────────────────────────────────────────── */

/** `GET /api/projects/:id/designs` — every `.fig`/`.op` of the project, newest first. */
export async function listDesigns(projectId: string, ctx?: Ctx): Promise<DesignDocumentSummary[]> {
  const resp = await send(designsBase(projectId), { cache: 'no-store', headers: requestHeaders(ctx) });
  if (!resp.ok) throw await failure(resp);
  const json = (await resp.json()) as { designs?: unknown };
  return Array.isArray(json.designs) ? (json.designs as DesignDocumentSummary[]) : [];
}

/** Document bytes with their sha256 and format; null on 404. */
export async function readDesign(
  projectId: string,
  path: string,
  ctx?: Ctx,
): Promise<{ bytes: ArrayBuffer; sha256: string; format: DesignDocumentFormat } | null> {
  const resp = await send(withPathQuery(`${designsBase(projectId)}/content`, path), {
    cache: 'no-store',
    headers: requestHeaders(ctx),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw await failure(resp);
  const sha256 = resp.headers.get(DESIGN_SHA256_HEADER)?.trim() || parseEtag(resp.headers.get('etag'));
  if (!sha256) throw new DesignApiError(resp.status, 'The design response carried no sha256', 'INTERNAL');
  const headerFormat = resp.headers.get('x-design-format');
  const format: DesignDocumentFormat =
    headerFormat === 'op' || headerFormat === 'fig' ? headerFormat : (designFormatForPath(path) ?? 'fig');
  const bytes = await resp.arrayBuffer();
  return { bytes, sha256, format };
}

export type SaveDesignOutcome =
  | { ok: true; response: DesignDocumentSaveResponse }
  | { ok: false; status: 409; currentSha256: string | null }
  /** 0 = network or an unexpected server answer. */
  | { ok: false; status: 413 | 403 | 404 | 400 | 0; message: string };

function conflictSha(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) return null;
  const value = (details as { currentSha256?: unknown }).currentSha256;
  return typeof value === 'string' && value ? value : null;
}

/**
 * `PUT …/designs/content?path=` with exactly one precondition: `If-Match: "<sha>"` (update) or
 * `If-None-Match: *` (create). Invalidates the project's file-list cache after a write.
 */
export async function saveDesign(
  projectId: string,
  path: string,
  bytes: ArrayBuffer,
  precondition: { ifMatch: string } | { create: true },
  ctx?: Ctx,
): Promise<SaveDesignOutcome> {
  const conditional: Record<string, string> =
    'ifMatch' in precondition ? { 'If-Match': quoteEtag(precondition.ifMatch) } : { 'If-None-Match': '*' };
  let resp: Response;
  try {
    resp = await fetch(withPathQuery(`${designsBase(projectId)}/content`, path), {
      method: 'PUT',
      headers: requestHeaders(ctx, { 'Content-Type': 'application/octet-stream', ...conditional }),
      body: bytes,
    });
  } catch (error) {
    return { ok: false, status: 0, message: networkMessage(error) };
  }
  if (resp.status === 200 || resp.status === 201) {
    invalidateProjectFilesCache(projectId, ctx ?? null);
    const response = (await resp.json()) as DesignDocumentSaveResponse;
    return { ok: true, response };
  }
  const body = await readErrorBody(resp);
  if (resp.status === 409) return { ok: false, status: 409, currentSha256: conflictSha(body.details) };
  const status =
    resp.status === 413 || resp.status === 403 || resp.status === 404 || resp.status === 400
      ? resp.status
      : resp.status === 415 || resp.status === 428
        ? 400
        : 0;
  return { ok: false, status, message: body.message };
}

/** `PUT …/designs/cover?path=` with the sha the cover was rendered from; a changed document → 'stale'. */
export async function putDesignCover(
  projectId: string,
  path: string,
  png: ArrayBuffer,
  docSha256: string,
  ctx?: Ctx,
): Promise<'stored' | 'stale' | 'failed'> {
  try {
    const resp = await fetch(withPathQuery(`${designsBase(projectId)}/cover`, path), {
      method: 'PUT',
      headers: requestHeaders(ctx, { 'Content-Type': 'image/png', [DESIGN_SHA256_HEADER]: docSha256 }),
      body: png,
    });
    if (resp.status === 409) return 'stale';
    return resp.ok ? 'stored' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Cover image URL (`revision` busts caches); workspace authority goes into the query for <img>. */
export function designCoverUrl(projectId: string, path: string, revision: string, ctx?: Ctx): string {
  return workspaceResourceUrl(designCoverApiPath(projectId, path, revision), ctx);
}

/** Raw project file URL for a browser navigation (download link), with the workspace authority. */
export function designDownloadUrl(projectId: string, path: string, ctx?: Ctx): string {
  return workspaceResourceUrl(projectRawUrl(projectId, path, ctx), ctx);
}

/**
 * True for a project-relative path the editor may fetch through `asset.fetch` (mirrors the daemon's
 * `validateProjectPath`): no NUL, no absolute or drive path, no URL scheme, no `..` segment.
 */
export function isSafeProjectAssetPath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const value = path.trim();
  if (!value || value.includes('\0')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  return normalized.split('/').every((segment) => segment !== '..');
}

function normalizeAssetPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

/** `GET /api/projects/:id/raw/<path>`, at most 20 MB (DESIGN_BRIDGE_LIMITS.maxAssetBytes). */
export async function fetchProjectAsset(projectId: string, path: string, ctx?: Ctx): Promise<{ bytes: ArrayBuffer; mime: string }> {
  if (!isSafeProjectAssetPath(path)) throw new DesignApiError(400, `Not a project path: ${String(path)}`, 'INVALID_REQUEST');
  const resp = await send(projectRawUrl(projectId, normalizeAssetPath(path), ctx), {
    cache: 'no-store',
    headers: requestHeaders(ctx),
  });
  if (!resp.ok) throw await failure(resp);
  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > DESIGN_BRIDGE_LIMITS.maxAssetBytes) {
    throw new DesignApiError(413, `Asset is larger than ${DESIGN_BRIDGE_LIMITS.maxAssetBytes} bytes`, 'TOO_LARGE');
  }
  const bytes = await resp.arrayBuffer();
  if (bytes.byteLength > DESIGN_BRIDGE_LIMITS.maxAssetBytes) {
    throw new DesignApiError(413, `Asset is larger than ${DESIGN_BRIDGE_LIMITS.maxAssetBytes} bytes`, 'TOO_LARGE');
  }
  const mime = resp.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  return { bytes, mime };
}

/** UTF-8 text of a project file (e.g. the HTML page to convert). */
export async function fetchProjectText(projectId: string, path: string, ctx?: Ctx): Promise<string> {
  const { bytes } = await fetchProjectAsset(projectId, path, ctx);
  return new TextDecoder('utf-8').decode(bytes);
}

/** True when `path` exists in the project (`HEAD` of the raw file). */
export async function projectFileExists(projectId: string, path: string, ctx?: Ctx): Promise<boolean> {
  try {
    const resp = await fetch(projectRawUrl(projectId, normalizeAssetPath(path), ctx), {
      method: 'HEAD',
      cache: 'no-store',
      headers: requestHeaders(ctx),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Writes a text file (keeps the `designs/` subfolder) through the multipart `POST /api/projects/:id/files`. */
export async function writeProjectTextAsFile(
  projectId: string,
  path: string,
  text: string,
  mime: string,
  ctx?: Ctx,
): Promise<ProjectFile> {
  const blob = new Blob([text], { type: mime });
  if (blob.size > DESIGN_HTML_SNAPSHOT_MAX_BYTES) {
    throw new DesignApiError(413, `File is larger than ${DESIGN_HTML_SNAPSHOT_MAX_BYTES} bytes`, 'TOO_LARGE');
  }
  const form = new FormData();
  form.append('file', blob, path.split('/').pop() || path);
  form.append('name', path);
  const resp = await send(`/api/projects/${encodeURIComponent(projectId)}/files`, {
    method: 'POST',
    headers: requestHeaders(ctx),
    body: form,
  });
  if (!resp.ok) throw await failure(resp);
  invalidateProjectFilesCache(projectId, ctx ?? null);
  const json = (await resp.json()) as { file?: ProjectFile };
  if (!json.file) throw new DesignApiError(resp.status, 'The upload response carried no file', 'INTERNAL');
  return json.file;
}

/* ── naming ───────────────────────────────────────────────────────────────────────────────── */

/** First free `designs/<name>.<format>` (then `-2`, `-3`, …) for a title. */
export function suggestDesignPath(
  name: string,
  existingPaths: Iterable<string>,
  format: DesignDocumentFormat = 'fig',
  dir?: string,
): string {
  return uniqueDesignPath(designFileNameFromTitle(name), format, existingPaths, dir);
}

/** The directory of a project path (`''` for the project root). */
export function designDirOf(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : '';
}

/** Basename with extension: `designs/首页.fig` → `首页.fig`. */
export function designBaseName(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] || path;
}
