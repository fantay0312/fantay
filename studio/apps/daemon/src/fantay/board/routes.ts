// SPDX-License-Identifier: Apache-2.0
// Board HTTP routes (spec 04 §4.3). Every route runs the same gate: project lookup (404), revoked team mirror (404,
// as `routes/project/chat-artifacts.ts`), then the project authority (`{mode:'read'}` for reads,
// `{mode:'write', capability:'writeFiles'}` for writes). `registerBoardRoutes` returns the service so server-side
// writers (the W2 design-canvas import route, plan R11) commit through the same pipeline.
// `POST /board/import-design-canvas` is not registered here (plan R11: W2-daemon-designs).
import { raw, type Express, type NextFunction, type Request, type Response } from 'express';
import { BOARD_LIMITS, type BoardChangedSsePayload } from '@open-design/contracts';

import type { AuthorizeProjectRequest, AuthorizeProjectRequestOptions } from '../../collab/project-request-authority.js';
import type { RouteDeps } from '../../server-context.js';
import { BOARD_COVER_MIMES, BOARD_COVER_ORPHAN_SWEEP_DELAY_MS } from './covers.js';
import { createBoardService, type BoardService, type BoardServiceResult } from './service.js';
import { BoardStorageError, migrateBoardTables } from './store.js';

export interface RegisterBoardRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'projectFiles'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
  emitProjectEvent: (projectId: string, payload: BoardChangedSsePayload) => boolean;
}

const READ: AuthorizeProjectRequestOptions = { mode: 'read' };
const READ_NAVIGATION: AuthorizeProjectRequestOptions = { mode: 'read', allowNavigationQuery: true };
const WRITE: AuthorizeProjectRequestOptions = { mode: 'write', capability: 'writeFiles' };

export function registerBoardRoutes(app: Express, ctx: RegisterBoardRoutesDeps): BoardService {
  migrateBoardTables(ctx.db);
  const { sendApiError } = ctx.http;
  const service = createBoardService({
    db: ctx.db,
    paths: { PROJECTS_DIR: ctx.paths.PROJECTS_DIR, RUNTIME_DATA_DIR: ctx.paths.RUNTIME_DATA_DIR },
    projectFiles: {
      resolveProjectFilePath: ctx.projectFiles.resolveProjectFilePath,
      listFiles: ctx.projectFiles.listFiles,
    },
    getProject: ctx.projectStore.getProject,
    emitProjectEvent: ctx.emitProjectEvent,
  });

  /** Returns the project id once the request may proceed; otherwise the response has been sent. */
  async function gate(req: Request, res: Response, options: AuthorizeProjectRequestOptions): Promise<string | null> {
    const projectId = String(req.params.id ?? '');
    const project = ctx.projectStore.getProject(ctx.db, projectId);
    if (!project) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return null;
    }
    if (project.metadata?.teamMirrorRevokedAt) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return null;
    }
    if (!(await ctx.authorizeProjectRequest(req, res, projectId, options))) return null;
    return projectId;
  }

  function send<T>(res: Response, result: BoardServiceResult<T>): void {
    if (result.ok) {
      res.set('Cache-Control', 'no-store');
      res.json(result.value);
      return;
    }
    const { status, code, message, details } = result.error;
    sendApiError(res, status, code, message, details !== undefined ? { details } : {});
  }

  function internalError(res: Response, error: unknown): void {
    console.warn('[fantay-board] request failed', error);
    if (res.headersSent) return;
    sendApiError(
      res,
      500,
      'INTERNAL_ERROR',
      error instanceof BoardStorageError ? 'the stored board could not be read' : 'board request failed',
    );
  }

  app.get('/api/projects/:id/board', async (req, res) => {
    try {
      const projectId = await gate(req, res, READ);
      if (!projectId) return;
      res.set('Cache-Control', 'no-store');
      res.json(service.get(projectId, { includeSync: req.query.include === 'sync' }));
    } catch (error) {
      internalError(res, error);
    }
  });

  app.put('/api/projects/:id/board', async (req, res) => {
    try {
      const projectId = await gate(req, res, WRITE);
      if (!projectId) return;
      send(res, await service.put(projectId, req.body));
    } catch (error) {
      internalError(res, error);
    }
  });

  app.patch('/api/projects/:id/board', async (req, res) => {
    try {
      const projectId = await gate(req, res, WRITE);
      if (!projectId) return;
      send(res, await service.patch(projectId, req.body));
    } catch (error) {
      internalError(res, error);
    }
  });

  app.post('/api/projects/:id/board/sync', async (req, res) => {
    try {
      const projectId = await gate(req, res, WRITE);
      if (!projectId) return;
      send(res, await service.sync(projectId, req.body));
    } catch (error) {
      internalError(res, error);
    }
  });

  app.put('/api/projects/:id/board/viewport', async (req, res) => {
    try {
      const projectId = await gate(req, res, WRITE);
      if (!projectId) return;
      send(res, service.setViewport(projectId, req.body));
    } catch (error) {
      internalError(res, error);
    }
  });

  // Covers: the gate runs before the body is read; the route-level raw parser (pattern: routes/library.ts) only
  // accepts the three cover types, and an oversized body maps to 413 `board-limit`.
  const coverBody = raw({ type: [...BOARD_COVER_MIMES], limit: BOARD_LIMITS.maxCoverBytes });
  app.put(
    '/api/projects/:id/board/covers',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (await gate(req, res, WRITE)) next();
      } catch (error) {
        internalError(res, error);
      }
    },
    (req: Request, res: Response, next: NextFunction) => {
      coverBody(req, res, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        const failure = error as { status?: number; statusCode?: number; type?: string; length?: number };
        if (failure.status === 413 || failure.statusCode === 413 || failure.type === 'entity.too.large') {
          sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', 'cover images are limited to 1.5 MiB', {
            details: {
              kind: 'board-limit',
              limit: 'maxCoverBytes',
              max: BOARD_LIMITS.maxCoverBytes,
              actual: Number(failure.length ?? req.headers['content-length']) || BOARD_LIMITS.maxCoverBytes + 1,
            },
          });
          return;
        }
        sendApiError(res, 400, 'BAD_REQUEST', 'the cover body could not be read');
      });
    },
    async (req: Request, res: Response) => {
      try {
        send(res, await service.saveCover(String(req.params.id), {
          body: req.body,
          contentType: req.headers['content-type'],
          width: req.query.width,
          height: req.query.height,
          sourceMtime: req.query.sourceMtime,
        }));
      } catch (error) {
        internalError(res, error);
      }
    },
  );

  app.get('/api/projects/:id/board/covers/:digest', async (req, res) => {
    try {
      const projectId = await gate(req, res, READ_NAVIGATION);
      if (!projectId) return;
      const cover = await service.readCover(projectId, String(req.params.digest ?? ''));
      if (!cover) {
        sendApiError(res, 404, 'NOT_FOUND', 'cover not found');
        return;
      }
      res.set('Content-Type', cover.mime);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(cover.bytes);
    } catch (error) {
      internalError(res, error);
    }
  });

  // One-shot sweep of cover dirs whose project row no longer exists (unref'd: never keeps the daemon alive).
  const sweep = setTimeout(() => {
    service.collectOrphanCoverDirs().catch((error: unknown) => console.warn('[fantay-board] cover sweep failed', error));
  }, BOARD_COVER_ORPHAN_SWEEP_DELAY_MS);
  sweep.unref?.();

  return service;
}
