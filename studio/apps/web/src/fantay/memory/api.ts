// SPDX-License-Identifier: AGPL-3.0-only
// 记忆 — HTTP client for `/api/memory-center/*`. Request and response shapes come from the shared contract
// (`@open-design/contracts`); nothing here knows the daemon. Every call throws `MemoryApiError` on failure,
// except an aborted request, which rethrows the AbortError so callers can ignore it.
import type {
  CopyMemoryItemRequest,
  CreateMemoryItemRequest,
  CreateMemoryItemResponse,
  MemoryChunkDetailResponse,
  MemoryChunkListQuery,
  MemoryChunkListResponse,
  MemoryConflict,
  MemoryConflictListResponse,
  MemoryEngineResponse,
  MemoryInboxResponse,
  MemoryItemActionRequest,
  MemoryItemHistoryResponse,
  MemoryItemListQuery,
  MemoryItemListResponse,
  MemoryItemResponse,
  MemoryLocalModelActionRequest,
  MemoryMergeDraftResponse,
  MemoryOverviewResponse,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemoryReindexRequest,
  MemoryReindexResponse,
  MemoryTidyRequest,
  MemoryTidyResponse,
  ResolveMemoryConflictRequest,
  ResolveMemoryConflictResponse,
  ResolveMemoryPendingRequest,
  ResolveMemoryPendingResponse,
  UpdateAgentMemoryPolicyRequest,
  UpdateAgentMemoryPolicyResponse,
  UpdateMemoryEngineConfigRequest,
  UpdateMemoryItemRequest,
  UpdateMemoryItemResponse,
} from '@open-design/contracts';

import { paAccessHeader, signalPaAccessRequired } from '../pa/pa-api';

const BASE = '/api/memory-center';

/** Enterprise mode: the request carried no (or an expired) member access token. */
export const MEMORY_ACCESS_REQUIRED = 'PA_ENTERPRISE_AUTH';

/** The local service could not be reached (no HTTP response at all); `status` is 0. */
export const MEMORY_OFFLINE = 'MEMORY_OFFLINE';

export class MemoryApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'MemoryApiError';
    this.code = code;
    this.status = status;
  }
}

/** `GET /conflicts/:id` — the contract has no named type for the single-conflict read. */
export interface MemoryConflictResponse {
  conflict: MemoryConflict;
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

type QueryValue = string | number | boolean | null | undefined;

function queryString(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params) as Array<[string, QueryValue]>) {
    if (value === undefined || value === null) continue;
    // The profile scope's id is the empty string; leaving it out reads the same scope.
    if (typeof value === 'string' && value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

const enc = encodeURIComponent;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
  signal?: AbortSignal | undefined;
}

function readError(parsed: unknown, status: number): MemoryApiError {
  const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const nested = obj?.error && typeof obj.error === 'object' ? (obj.error as Record<string, unknown>) : null;
  const pick = (value: unknown) => (typeof value === 'string' && value ? value : null);
  const code = pick(obj?.code) ?? pick(nested?.code) ?? `HTTP_${status}`;
  const message = pick(obj?.message) ?? pick(nested?.message) ?? pick(obj?.error) ?? '';
  return new MemoryApiError(code, message, status);
}

async function request<T>(path: string, { method = 'GET', body, signal }: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    // Enterprise mode reads the same member token as the Personal Agent client.
    const headers: Record<string, string> = { ...paAccessHeader() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    response = await fetch(`${BASE}${path}`, {
      method,
      cache: 'no-store',
      headers,
      ...(signal ? { signal } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new MemoryApiError(MEMORY_OFFLINE, '', 0);
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    const error = readError(parsed, response.status);
    if (error.code === MEMORY_ACCESS_REQUIRED) signalPaAccessRequired();
    throw error;
  }
  return parsed as T;
}

export const memoryApi = {
  overview: (signal?: AbortSignal) => request<MemoryOverviewResponse>('/overview', { signal }),

  listItems: (query: MemoryItemListQuery = {}, signal?: AbortSignal) =>
    request<MemoryItemListResponse>(`/items${queryString(query)}`, { signal }),

  createItem: (body: CreateMemoryItemRequest) =>
    request<CreateMemoryItemResponse>('/items', { method: 'POST', body }),

  getItem: (id: string, signal?: AbortSignal) => request<MemoryItemResponse>(`/items/${enc(id)}`, { signal }),

  updateItem: (id: string, body: UpdateMemoryItemRequest) =>
    request<UpdateMemoryItemResponse>(`/items/${enc(id)}`, { method: 'PATCH', body }),

  history: (id: string, signal?: AbortSignal) =>
    request<MemoryItemHistoryResponse>(`/items/${enc(id)}/history`, { signal }),

  /** archive · restore · redact. Nothing deletes a memory. */
  itemAction: (id: string, body: MemoryItemActionRequest) =>
    request<MemoryItemResponse>(`/items/${enc(id)}/action`, { method: 'POST', body }),

  /** Copies into another scope; the source stays as it is. */
  copyItem: (id: string, body: CopyMemoryItemRequest) =>
    request<CreateMemoryItemResponse>(`/items/${enc(id)}/copy`, { method: 'POST', body }),

  inbox: (signal?: AbortSignal) => request<MemoryInboxResponse>('/inbox', { signal }),

  /** `id` is the inbox entry id (`item:<id>` or `pa:<candidateId>`). */
  resolvePending: (id: string, body: ResolveMemoryPendingRequest) =>
    request<ResolveMemoryPendingResponse>(`/pending/${enc(id)}/resolve`, { method: 'POST', body }),

  listConflicts: (query: { status?: 'open' | 'resolved' } = {}, signal?: AbortSignal) =>
    request<MemoryConflictListResponse>(`/conflicts${queryString(query)}`, { signal }),

  getConflict: (id: string, signal?: AbortSignal) =>
    request<MemoryConflictResponse>(`/conflicts/${enc(id)}`, { signal }),

  resolveConflict: (id: string, body: ResolveMemoryConflictRequest) =>
    request<ResolveMemoryConflictResponse>(`/conflicts/${enc(id)}/resolve`, { method: 'POST', body }),

  mergeDraft: (id: string, signal?: AbortSignal) =>
    request<MemoryMergeDraftResponse>(`/conflicts/${enc(id)}/merge-draft`, { method: 'POST', body: {}, signal }),

  recall: (body: MemoryRecallRequest, signal?: AbortSignal) =>
    request<MemoryRecallResponse>('/recall', { method: 'POST', body, signal }),

  listChunks: (query: MemoryChunkListQuery = {}, signal?: AbortSignal) =>
    request<MemoryChunkListResponse>(`/chunks${queryString(query)}`, { signal }),

  getChunk: (id: string, signal?: AbortSignal) =>
    request<MemoryChunkDetailResponse>(`/chunks/${enc(id)}`, { signal }),

  engine: (signal?: AbortSignal) => request<MemoryEngineResponse>('/engine', { signal }),

  updateEngine: (body: UpdateMemoryEngineConfigRequest) =>
    request<MemoryEngineResponse>('/engine', { method: 'PUT', body }),

  /** Starts (or resumes) or cancels downloading a local model; progress is read back through `engine`. */
  localModelAction: (id: string, body: MemoryLocalModelActionRequest) =>
    request<MemoryEngineResponse>(`/engine/models/${enc(id)}`, { method: 'POST', body }),

  reindex: (body: MemoryReindexRequest = {}) =>
    request<MemoryReindexResponse>('/engine/reindex', { method: 'POST', body }),

  tidy: (body: MemoryTidyRequest = {}) => request<MemoryTidyResponse>('/engine/tidy', { method: 'POST', body }),

  updateAgentPolicy: (agentId: string, body: UpdateAgentMemoryPolicyRequest) =>
    request<UpdateAgentMemoryPolicyResponse>(`/agents/${enc(agentId)}/policy`, { method: 'PATCH', body }),
};

export type MemoryApi = typeof memoryApi;
