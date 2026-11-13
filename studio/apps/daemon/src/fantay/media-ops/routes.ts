// SPDX-License-Identifier: Apache-2.0
import type { Express } from 'express';
import path from 'node:path';
import type { RouteDeps } from '../../server-context.js';
import type { AuthorizeProjectRequest } from '../../collab/project-request-authority.js';
import type { PublicFileMutations } from '../../collab/public-file-mutations.js';
import { publicFileMutationHandler } from '../../routes/public-file-mutation-handler.js';
import { MediaOpError, runMediaOperation } from './ops.js';

export interface RegisterMediaOpRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'projectFiles'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
  publicFileMutations?: PublicFileMutations;
}
export function registerMediaOpRoutes(app: Express, ctx: RegisterMediaOpRoutesDeps): void {
  app.post('/api/projects/:id/media/ops', publicFileMutationHandler(ctx.publicFileMutations, async (req, res) => {
    try {
      const id = String(req.params.id);
      const project = ctx.projectStore.getProject(ctx.db, id);
      if (!project || project.metadata?.teamMirrorRevokedAt) {
        ctx.http.sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found'); return;
      }
      if (!(await ctx.authorizeProjectRequest(req, res, id, { mode: 'write', capability: 'writeFiles' }))) return;
      const result = await runMediaOperation(req.body, {
        scratchRoot: path.join(ctx.paths.RUNTIME_DATA_DIR, 'media-ops-tmp'),
        resolve: name => ctx.projectFiles.resolveProjectFilePath(ctx.paths.PROJECTS_DIR, id, name, project.metadata),
        write: (name, bytes) => ctx.projectFiles.writeProjectFile(ctx.paths.PROJECTS_DIR, id, name, bytes, { overwrite: false }, project.metadata),
      });
      res.set('Cache-Control', 'no-store').json(result);
    } catch (error) {
      if (error instanceof MediaOpError) ctx.http.sendApiError(res, error.status, error.code, error.message);
      else if ((error as NodeJS.ErrnoException).code === 'EEXIST') ctx.http.sendApiError(res, 409, 'CONFLICT', 'Output file already exists');
      else ctx.http.sendApiError(res, 400, 'BAD_REQUEST', 'The media operation could not access a project file');
    }
  }));
}
