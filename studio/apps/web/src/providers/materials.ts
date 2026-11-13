// Fantay materials (素材库) daemon helpers. Kept out of registry.ts so the
// fork adds a file instead of growing an upstream hotspot.
//
// The material library is an external, read-only archive the daemon indexes
// and serves under `/api/materials/*` (contract: `packages/contracts/src/api/
// materials.ts`). Unlike the OD Library helpers in registry.ts, these throw a typed
// `MaterialRequestError` instead of collapsing failures to null/[]: the
// Materials view must tell "the daemon route is missing / unreachable" apart
// from "the library is not configured" (a 200 summary with
// `status.enabled === false`) and from an empty search.

import type {
  MaterialApplyRequest,
  MaterialApplyResponse,
  MaterialContextRequest,
  MaterialContextResponse,
  MaterialDetailResponse,
  MaterialErrorCode,
  MaterialSearchQuery,
  MaterialSearchResponse,
  MaterialSummaryResponse,
  MaterialLibrary,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { workspaceProjectHeaders } from '../state/projects';

export type MaterialRequestErrorCode =
  | MaterialErrorCode
  | 'network-error'
  | 'http-error'
  | 'invalid-response';

export class MaterialRequestError extends Error {
  readonly code: MaterialRequestErrorCode;
  /** HTTP status, or null when the request never got a response. */
  readonly status: number | null;

  constructor(code: MaterialRequestErrorCode, message: string, status: number | null) {
    super(message);
    this.name = 'MaterialRequestError';
    this.code = code;
    this.status = status;
  }
}

/** True for a fetch the caller aborted (filter changed, view unmounted). */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && (err as { name?: unknown }).name === 'AbortError'
  );
}

async function materialRequest<T>(url: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new MaterialRequestError(
      'network-error',
      err instanceof Error ? err.message : String(err),
      null,
    );
  }
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as
      | { error?: { code?: unknown; message?: unknown } | string }
      | null;
    const error = payload && typeof payload === 'object' ? payload.error : undefined;
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      throw new MaterialRequestError(
        error.code as MaterialErrorCode,
        typeof error.message === 'string' && error.message ? error.message : `HTTP ${resp.status}`,
        resp.status,
      );
    }
    throw new MaterialRequestError(
      'http-error',
      typeof error === 'string' && error ? error : `HTTP ${resp.status}`,
      resp.status,
    );
  }
  try {
    return (await resp.json()) as T;
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new MaterialRequestError('invalid-response', 'Invalid JSON response', resp.status);
  }
}

/** Query string for `GET /api/materials/items`; empty values are omitted. */
export function materialSearchParams(query: MaterialSearchQuery): string {
  const params = new URLSearchParams();
  const q = query.q?.trim();
  if (q) params.set('q', q);
  if (query.kind) params.set('kind', query.kind);
  if (query.category) params.set('category', query.category);
  if (query.collection) params.set('collection', query.collection);
  if (query.section) params.set('section', query.section);
  if (query.libraryId) params.set('libraryId', query.libraryId);
  if (typeof query.limit === 'number') params.set('limit', String(query.limit));
  if (typeof query.offset === 'number' && query.offset > 0) params.set('offset', String(query.offset));
  return params.toString();
}

/** `GET /api/materials/summary` — library status plus category/kind counts. */
export async function fetchMaterialSummary(
  opts: { signal?: AbortSignal; libraryId?: string } = {},
): Promise<MaterialSummaryResponse> {
  const suffix = opts.libraryId ? `?libraryId=${encodeURIComponent(opts.libraryId)}` : '';
  return materialRequest<MaterialSummaryResponse>(`/api/materials/summary${suffix}`, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

export async function addMaterialLibrary(root: string, name?: string): Promise<MaterialLibrary> {
  const result = await materialRequest<{ library: MaterialLibrary }>('/api/materials/libraries', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root, name }),
  });
  return result.library;
}

export async function removeMaterialLibrary(id: string): Promise<void> {
  await materialRequest(`/api/materials/libraries/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function scanMaterialLibrary(id: string): Promise<MaterialLibrary> {
  const result = await materialRequest<{ library: MaterialLibrary }>(`/api/materials/libraries/${encodeURIComponent(id)}/scan`, { method: 'POST' });
  return result.library;
}

/** `GET /api/materials/items` — one page of ranked search results. */
export async function searchMaterials(
  query: MaterialSearchQuery,
  opts: { signal?: AbortSignal } = {},
): Promise<MaterialSearchResponse> {
  const qs = materialSearchParams(query);
  return materialRequest<MaterialSearchResponse>(`/api/materials/items${qs ? `?${qs}` : ''}`, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** `GET /api/materials/items/:id` — full record with file list. */
export async function fetchMaterialDetail(
  id: string,
  opts: { signal?: AbortSignal } = {},
): Promise<MaterialDetailResponse> {
  return materialRequest<MaterialDetailResponse>(`/api/materials/items/${encodeURIComponent(id)}`, {
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** `POST /api/materials/context` — markdown reference packet for up to 20 ids. */
export async function fetchMaterialContext(
  request: MaterialContextRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<MaterialContextResponse> {
  return materialRequest<MaterialContextResponse>('/api/materials/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/**
 * `POST /api/materials/items/:id/apply` — copy a record's files into a project
 * (`references/<id>/…` by default). The daemon writes project files, so the
 * caller should invalidate that project's file-list cache afterwards, the way
 * `uploadProjectFiles` does.
 */
export async function applyMaterialItem(
  id: string,
  request: MaterialApplyRequest,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<MaterialApplyResponse> {
  return materialRequest<MaterialApplyResponse>(
    `/api/materials/items/${encodeURIComponent(id)}/apply`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify(request),
    },
  );
}
