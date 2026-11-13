import type { WorkspaceCollabContext } from '@open-design/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';

export interface NativeMovieProject {
  id: string;
  name: string;
  updatedAt: number;
  projectId?: string;
}

async function responseBody(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : body.error?.message ?? 'Could not open the video project');
  return body;
}

export async function listNativeMovieProjects(): Promise<NativeMovieProject[]> {
  return (await responseBody(await fetch('/api/movie/native/projects'))).projects;
}

export async function pickNativeMovieProject(): Promise<NativeMovieProject | null> {
  const body = await responseBody(await fetch('/api/movie/native/pick', { method: 'POST' }));
  return body.cancelled ? null : body.project;
}

export async function linkNativeMovieProject(projectId: string, nativeId: string, context?: WorkspaceCollabContext | null): Promise<void> {
  await responseBody(await fetch(`/api/projects/${encodeURIComponent(projectId)}/movie/native/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(context ? workspaceProjectHeaders(context) : {}) },
    body: JSON.stringify({ nativeId }),
  }));
}

