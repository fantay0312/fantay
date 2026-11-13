// SPDX-License-Identifier: Apache-2.0
/**
 * Browser destinations returned by `od movie` and the Movie MCP tools (spec 07 §5.6). A film opens
 * inside its project workspace next to the chat; `/create/animation` (redirected to the create
 * dialog by the web app) is only used when there is no project yet. The chrome-free MCP Apps
 * surface keeps `/movie-app[/…]` (`embedUrl`).
 */
import { MOVIE_DOCUMENT_FILE } from "@open-design/contracts";

/** `<web>/projects/<id>/files/movie-studio.json` — the in-workspace film editor. */
export function movieWorkspaceUrl(web: string, projectId: string): string {
  return `${web}/projects/${encodeURIComponent(projectId)}/files/${MOVIE_DOCUMENT_FILE}`;
}

/** The workspace URL for a film, or the legacy create entry when no project is known. */
export function movieOpenUrl(web: string, projectId?: string | null): string {
  return projectId ? movieWorkspaceUrl(web, projectId) : `${web}/create/animation`;
}
