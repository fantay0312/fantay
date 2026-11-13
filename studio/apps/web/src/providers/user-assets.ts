// 我的素材 daemon helpers (`/api/user-assets`, contract: `packages/contracts/src/api/user-assets.ts`). Kept out of
// registry.ts so the fork adds a file instead of growing an upstream hotspot.
import type {
  UserAsset,
  UserAssetApplyRequest,
  UserAssetApplyResponse,
  UserAssetCreateRequest,
  UserAssetKind,
  UserAssetResponse,
  UserAssetsResponse,
  UserAssetUpdateRequest,
  WorkspaceCollabContext,
} from '@open-design/contracts';

import { workspaceProjectHeaders } from '../collab/workspace-identity';

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } | string } | null;
    const error = body?.error;
    throw new Error((typeof error === 'string' ? error : error?.message) ?? `request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function fetchUserAssets(kind: UserAssetKind): Promise<UserAsset[]> {
  return (await request<UserAssetsResponse>(`/api/user-assets?kind=${kind}`)).assets;
}

export async function createUserAsset(body: UserAssetCreateRequest): Promise<UserAsset> {
  return (await request<UserAssetResponse>('/api/user-assets', jsonInit('POST', body))).asset;
}

export async function updateUserAsset(id: string, body: UserAssetUpdateRequest): Promise<UserAsset> {
  return (await request<UserAssetResponse>(`/api/user-assets/${encodeURIComponent(id)}`, jsonInit('PATCH', body))).asset;
}

export async function deleteUserAsset(id: string): Promise<void> {
  await request(`/api/user-assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function uploadUserAssetFile(id: string, file: File): Promise<UserAsset> {
  const url = `/api/user-assets/${encodeURIComponent(id)}/files?name=${encodeURIComponent(file.name)}`;
  const init: RequestInit = { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: file };
  return (await request<UserAssetResponse>(url, init)).asset;
}

export async function deleteUserAssetFile(id: string, fileId: string): Promise<UserAsset> {
  const url = `/api/user-assets/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`;
  return (await request<UserAssetResponse>(url, { method: 'DELETE' })).asset;
}

export async function applyUserAsset(
  id: string,
  body: UserAssetApplyRequest,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<UserAssetApplyResponse> {
  const init = jsonInit('POST', body);
  if (workspaceContext) init.headers = { ...(init.headers as Record<string, string>), ...workspaceProjectHeaders(workspaceContext) };
  return request<UserAssetApplyResponse>(`/api/user-assets/${encodeURIComponent(id)}/apply`, init);
}
