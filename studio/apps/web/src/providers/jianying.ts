import type { WorkspaceCollabContext } from '@open-design/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';

export async function jianyingRequest<T>(projectId: string, context: WorkspaceCollabContext | null | undefined, route: string, body?: unknown, local = false, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/jianying/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(context ? workspaceProjectHeaders(context) : {}), ...(local ? { 'x-fantay-local-drafts': '1' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  });
  const data = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message ?? `HTTP ${response.status}`);
  return data;
}
