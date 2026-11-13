import type {
  MovieAction,
  MovieDocument,
  WorkspaceCollabContext,
  MovieReviewAssets,
  MovieVideoSource,
} from "@open-design/contracts";
import { workspaceProjectHeaders } from "../collab/workspace-identity";

/** A failed movie request: the daemon's message plus the HTTP status and error code. */
export class MovieRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "MovieRequestError";
    this.status = status;
    if (code) this.code = code;
  }
}

/** True for `GET /movie` on a project without `movie-studio.json` (404 `MOVIE_NOT_FOUND`). */
export function isMovieNotFound(error: unknown): boolean {
  return (
    error instanceof MovieRequestError &&
    error.status === 404 &&
    error.code === "MOVIE_NOT_FOUND"
  );
}

/** The body of a response; a failed response without a JSON body reads as `{}`. */
async function readJson(response: Response): Promise<any> {
  if (response.ok) return response.json();
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function errorCode(result: any): string | undefined {
  const code = result?.error?.code;
  return typeof code === "string" ? code : undefined;
}

export async function movieStyleRequest<T>(
  projectId: string,
  context: WorkspaceCollabContext | null | undefined,
  route:
    | "style-link"
    | "style-preview"
    | "production/authorize"
    | "production/cancel"
    | "review-submit"
    | "feedback-prompt"
    | "sources"
    | "transcribe"
    | "edits"
    | "history/undo"
    | "history/redo",
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/movie/${route}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(context ? workspaceProjectHeaders(context) : {}),
      },
      body: JSON.stringify(body),
    },
  );
  const result = await readJson(response);
  if (!response.ok)
    throw new MovieRequestError(
      String(result.error?.message ?? result.error ?? `HTTP ${response.status}`),
      response.status,
      errorCode(result),
    );
  return result as T;
}
export async function getMovieVideoSources(
  projectId: string,
  context?: WorkspaceCollabContext | null,
): Promise<MovieVideoSource[]> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/movie/sources`,
    { headers: context ? workspaceProjectHeaders(context) : {} },
  );
  const result = await readJson(response);
  if (!response.ok)
    throw new MovieRequestError(
      String(result.error?.message ?? "Could not inspect video sources"),
      response.status,
      errorCode(result),
    );
  return result.sources;
}

export async function initializeMovieEditor(projectId: string, context?: WorkspaceCollabContext | null): Promise<MovieDocument> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/movie/editor/initialize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(context ? workspaceProjectHeaders(context) : {}) }, body: '{}', signal: AbortSignal.timeout(120000),
  });
  const result = await readJson(response);
  if (!response.ok) throw new MovieRequestError(String(result.error?.message ?? result.error ?? `HTTP ${response.status}`), response.status, response.status === 404 ? 'MOVIE_NOT_FOUND' : errorCode(result));
  return result.document;
}

export async function uploadMovieMedia(projectId: string, revision: number, file: File, context?: WorkspaceCollabContext | null): Promise<MovieDocument> {
  if (file.size > 256 * 1024 * 1024) throw new Error('请选择小于 256 MiB 的素材 / Choose media under 256 MiB');
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/movie/editor/media?revision=${revision}&filename=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', ...(context ? workspaceProjectHeaders(context) : {}) }, body: file,
  });
  const result = await readJson(response);
  if (!response.ok) throw new MovieRequestError(String(result.error?.message ?? result.error ?? `HTTP ${response.status}`), response.status, errorCode(result));
  return result.document;
}
export async function getMovieReviewAssets(
  projectId: string,
  renderId: string,
  context?: WorkspaceCollabContext | null,
): Promise<MovieReviewAssets> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/movie/review-assets?renderId=${encodeURIComponent(renderId)}`,
    { headers: context ? workspaceProjectHeaders(context) : {} },
  );
  const result = await readJson(response);
  if (!response.ok)
    throw new MovieRequestError(
      String(result.error?.message ?? "Could not prepare the review timeline"),
      response.status,
      errorCode(result),
    );
  return result;
}

export async function movieRequest(
  projectId: string,
  context: WorkspaceCollabContext | null | undefined,
  action?: MovieAction | { document: MovieDocument; expectedRevision: number },
  expectedRevision?: number,
): Promise<MovieDocument> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/movie${action && "action" in action ? "/actions" : ""}`,
    {
      method: action ? ("action" in action ? "POST" : "PUT") : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(context ? workspaceProjectHeaders(context) : {}),
      },
      ...(action
        ? {
            body: JSON.stringify({
              ...action,
              ...("action" in action ? { expectedRevision } : {}),
            }),
          }
        : {}),
    },
  );
  const result = await readJson(response);
  if (!response.ok)
    throw new MovieRequestError(
      String(result.error?.message ?? result.error ?? `HTTP ${response.status}`),
      response.status,
      errorCode(result),
    );
  return result.document as MovieDocument;
}

/** What the daemon can render for movies (amendment C6). */
export interface MoviePreviewCapability {
  /** Style samples and one-pass production ("一句话生成影片") can render frames. */
  available: boolean;
  renderer: "desktop" | "browser" | null;
}

/**
 * `GET /api/movie/integration?include=capabilities` → `capabilities.preview`. Null when unknown
 * (request failed, or a daemon without the field), so callers fail open.
 */
export async function fetchMoviePreviewCapability(): Promise<MoviePreviewCapability | null> {
  try {
    const response = await fetch("/api/movie/integration?include=capabilities");
    if (!response.ok) return null;
    const preview = (await readJson(response))?.capabilities?.preview;
    if (!preview || typeof preview.available !== "boolean") return null;
    return {
      available: preview.available,
      renderer:
        preview.renderer === "desktop" || preview.renderer === "browser"
          ? preview.renderer
          : null,
    };
  } catch {
    return null;
  }
}
