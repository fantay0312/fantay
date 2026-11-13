import type { Express, Request, Response } from 'express';
import type { JianyingCreateRequest, JianyingEditRequest } from '@open-design/contracts';
import type { RouteDeps } from '../server-context.js';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { JianyingError } from '../jianying/engine.js';
import type { JianyingService } from '../jianying/service.js';

export interface RegisterJianyingRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'projectFiles'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
  jianying: JianyingService;
}
export function registerJianyingRoutes(app: Express, ctx: RegisterJianyingRoutesDeps): void {
  const { requireLocalDaemonRequest, sendApiError } = ctx.http;
  const base = '/api/projects/:id/jianying';
  const localAccess = (req: Request) => req.get('x-fantay-local-drafts') === '1';
  async function projectDir(req: Request, res: Response, write: boolean) {
    const id = String(req.params.id);
    if (!await ctx.authorizeProjectRequest(req, res, id, write || localAccess(req) ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read' })) return null;
    const project = ctx.projectStore.getProject(ctx.db, id);
    if (!project) { sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'Project not found'); return null; }
    return ctx.projectFiles.resolveProjectDir(ctx.paths.PROJECTS_DIR, id, project.metadata);
  }
  const handler = (write: boolean, action: (dir: string, req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const dir = await projectDir(req, res, write);
      if (dir) res.json(await action(dir, req));
    } catch (error) {
      sendApiError(res, error instanceof JianyingError ? error.status : 400, error instanceof JianyingError ? error.code : 'JIANYING_ERROR', error instanceof Error ? error.message : String(error));
    }
  };
  app.get(`${base}/status`, requireLocalDaemonRequest, handler(false, async () => ctx.jianying.status()));
  app.get(`${base}/drafts`, requireLocalDaemonRequest, handler(false, async (dir, req) => ({ drafts: await ctx.jianying.list(dir, localAccess(req) && req.query.local === 'true') })));
  app.get(`${base}/inspect`, requireLocalDaemonRequest, handler(false, (dir, req) => ctx.jianying.inspect(dir, String(req.query.draftId ?? ''), localAccess(req))));
  app.post(`${base}/create`, requireLocalDaemonRequest, handler(true, (dir, req) => ctx.jianying.create(dir, req.body as JianyingCreateRequest)));
  app.post(`${base}/edit`, requireLocalDaemonRequest, handler(true, (dir, req) => ctx.jianying.edit(dir, req.body as JianyingEditRequest, localAccess(req))));
  app.post(`${base}/install`, requireLocalDaemonRequest, handler(true, (dir, req) => ctx.jianying.install(dir, String(req.body?.draftId ?? ''), typeof req.body?.name === 'string' ? req.body.name : undefined)));
}
