import type { SqliteDb } from '../db.js';
import { getProject, getWorkspaceProjectByProjectId } from '../db.js';
import { parseCommentFileState } from './comment-file-facts.js';
import { pendingCommentFileRetirements } from './comment-file-retirements.js';

/** Only locally proven, unbound projects can skip a cloud share-history lookup. */
export function isUnsharedLocalProject(db: SqliteDb, projectId: string): boolean {
  const project = getProject(db, projectId);
  if (!project || getWorkspaceProjectByProjectId(db, projectId)) return false;
  const rawState = project.metadata?._commentFiles;
  const state = parseCommentFileState(rawState);
  if (rawState !== undefined && !state) return false;
  if (state?.files.length || pendingCommentFileRetirements(db, projectId).length) return false;
  const publication = db.prepare('SELECT 1 FROM public_file_publications WHERE project_id = ? LIMIT 1').get(projectId);
  const pendingStop = db.prepare('SELECT 1 FROM public_file_stop_queue WHERE project_id = ? LIMIT 1').get(projectId);
  return !publication && !pendingStop;
}
