// SPDX-License-Identifier: Apache-2.0
// 我的素材 HTTP routes. Assets belong to the local user, so every write is loopback-only; `apply` writes into a project
// and also passes that project's `writeFiles` authority, exactly like the material apply route.
import { raw, type Express, type Request, type Response } from 'express';
import {
  USER_ASSET_LIMITS,
  isUserAssetKind,
  type UserAssetApplyRequest,
  type UserAssetCreateRequest,
  type UserAssetUpdateRequest,
} from '@open-design/contracts';

import type { AuthorizeProjectRequest } from '../../collab/project-request-authority.js';
import type { RouteDeps } from '../../server-context.js';
import { createUserAssetsService, UserAssetError } from './service.js';

export interface RegisterUserAssetRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
}

export function registerUserAssetRoutes(app: Express, ctx: RegisterUserAssetRoutesDeps): void {
  const { sendApiError, requireLocalDaemonRequest } = ctx.http;
  const service = createUserAssetsService({ dataDir: ctx.paths.RUNTIME_DATA_DIR, projectsDir: ctx.paths.PROJECTS_DIR });
  const fileBody = raw({ type: () => true, limit: USER_ASSET_LIMITS.maxFileBytes });

  function fail(res: Response, error: unknown): void {
    if (res.headersSent) return;
    if (error instanceof UserAssetError) {
      sendApiError(res, error.status, error.code, error.message);
      return;
    }
    console.warn('[fantay-assets] request failed', error);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'asset request failed');
  }

  const param = (req: Request, name: string): string => String(req.params[name] ?? '');

  app.get('/api/user-assets', async (req, res) => {
    try {
      const kind = req.query.kind;
      if (kind !== undefined && !isUserAssetKind(kind)) throw new UserAssetError(400, 'BAD_REQUEST', 'unknown asset kind');
      res.json({ assets: await service.list(kind) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/user-assets', requireLocalDaemonRequest, async (req, res) => {
    try {
      res.json({ asset: await service.create((req.body ?? {}) as Partial<UserAssetCreateRequest>) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/user-assets/:id', async (req, res) => {
    try {
      res.json({ asset: await service.get(param(req, 'id')) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.patch('/api/user-assets/:id', requireLocalDaemonRequest, async (req, res) => {
    try {
      res.json({ asset: await service.update(param(req, 'id'), (req.body ?? {}) as UserAssetUpdateRequest) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.delete('/api/user-assets/:id', requireLocalDaemonRequest, async (req, res) => {
    try {
      await service.remove(param(req, 'id'));
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  app.put(
    '/api/user-assets/:id/files',
    requireLocalDaemonRequest,
    (req: Request, res: Response, next) => {
      fileBody(req, res, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const tooLarge = (error as { status?: number }).status === 413;
        sendApiError(res, tooLarge ? 413 : 400, tooLarge ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST', 'the file could not be read');
      });
    },
    async (req: Request, res: Response) => {
      try {
        res.json({ asset: await service.addFile(param(req, 'id'), req.query.name, req.body as Buffer) });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  app.get('/api/user-assets/:id/files/:fileId', async (req, res) => {
    try {
      const { path, file } = await service.filePath(param(req, 'id'), param(req, 'fileId'));
      res.set('Content-Type', file.mime);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', 'sandbox');
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.sendFile(path, { dotfiles: 'allow' });
    } catch (error) {
      fail(res, error);
    }
  });

  app.delete('/api/user-assets/:id/files/:fileId', requireLocalDaemonRequest, async (req, res) => {
    try {
      res.json({ asset: await service.removeFile(param(req, 'id'), param(req, 'fileId')) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/user-assets/:id/apply', requireLocalDaemonRequest, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<UserAssetApplyRequest>;
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      const project = projectId ? ctx.projectStore.getProject(ctx.db, projectId) : null;
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      if (!(await ctx.authorizeProjectRequest(req, res, projectId, { mode: 'write', capability: 'writeFiles' }))) return;
      res.json(await service.apply(param(req, 'id'), {
        projectId,
        metadata: project.metadata,
        ...(typeof body.dir === 'string' ? { dir: body.dir } : {}),
      }));
    } catch (error) {
      fail(res, error);
    }
  });
}
