// SPDX-License-Identifier: Apache-2.0
// Project design documents (spec 06 §7.2) and the board import of legacy design-canvas documents (spec 04 §4.7, plan
// R11). Every route runs the board routes' gate: project lookup (404), revoked team mirror (404), then the project
// authority — reads `{mode:'read', allowNavigationQuery:true}`, writes `{mode:'write', capability:'writeFiles'}`
// (as routes/movie.ts). Writes run inside the project's public-file mutation lane. Upload bodies are parsed
// route-locally (`express.raw`) after the gate and the header checks and before the lane (a slow upload must not hold
// it; the gate runs again inside the lane), so the global 4 MB JSON parser is untouched.
import { raw, type Express, type Request, type RequestHandler, type Response } from 'express';
import {
  DESIGN_COVER_MAX_BYTES,
  DESIGN_DOCUMENT_MAX_BYTES,
  DESIGN_SHA256_HEADER,
  validateBoardImportRequest,
  type DesignConflictDetails,
  type DesignDocumentListResponse,
  type DesignDocumentSaveResponse,
  type ImportLegacyDesignResponse,
} from '@open-design/contracts';

import { kindForArtifactPath, mimeForArtifactPath } from '../chat-artifacts/mime.js';
import { ensureWorkspaceArtifactForPath } from '../chat-artifacts/store.js';
import type { AuthorizeProjectRequest, AuthorizeProjectRequestOptions } from '../collab/project-request-authority.js';
import type { PublicFileMutations } from '../collab/public-file-mutations.js';
import type { BoardService } from '../fantay/board/service.js';
import { importDesignCanvasIntoBoard } from '../fantay/designs/board-import.js';
import { DesignConflictError, DesignDocumentService, DesignInputError, type DesignWritePrecondition } from '../fantay/designs/service.js';
import { validateDesignPath, validateExistingDesignPath } from '../fantay/designs/paths.js';
import type { RouteDeps } from '../server-context.js';
import type { CanvasStore } from '../services/design-canvas.js';
import { publicFileMutationHandler } from './public-file-mutation-handler.js';

export interface RegisterDesignDocumentRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'projectFiles'> {
  authorizeProjectRequest: AuthorizeProjectRequest;
  publicFileMutations?: PublicFileMutations;
  legacyStore: CanvasStore;
  /** The service `registerBoardRoutes` returns (plan R11); `POST /board/import-design-canvas` needs it. */
  boardService?: BoardService;
}

interface GatedProject {
  id: string;
  metadata: unknown;
}

const READ: AuthorizeProjectRequestOptions = { mode: 'read', allowNavigationQuery: true };
const WRITE: AuthorizeProjectRequestOptions = { mode: 'write', capability: 'writeFiles' };
const OCTET_STREAM = 'application/octet-stream';
const PNG = 'image/png';

type RawBodyOutcome = { ok: true; body: Buffer } | { ok: false; tooLarge: boolean };

/**
 * Runs a body parser inside a handler (after the gate) and reports the parsed Buffer or why it failed. A declared
 * `Content-Length` above `limit` fails at once: body-parser would first drain the whole body before reporting 413.
 */
function readRawBody(parser: RequestHandler, req: Request, res: Response, limit: number): Promise<RawBodyOutcome> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return Promise.resolve({ ok: false, tooLarge: true });
  return new Promise((resolve) => {
    void parser(req, res, (error?: unknown) => {
      if (!error) {
        resolve({ ok: true, body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) });
        return;
      }
      const failure = error as { status?: number; statusCode?: number; type?: string };
      resolve({ ok: false, tooLarge: failure.status === 413 || failure.statusCode === 413 || failure.type === 'entity.too.large' });
    });
  });
}

/** `If-Match: "<sha256>"` (quotes optional) or `If-None-Match: *` — exactly one. */
export function parseDesignPrecondition(ifMatch: unknown, ifNoneMatch: unknown): DesignWritePrecondition | null {
  const match = typeof ifMatch === 'string' ? ifMatch.trim() : '';
  const noneMatch = typeof ifNoneMatch === 'string' ? ifNoneMatch.trim() : '';
  if ((match === '') === (noneMatch === '')) return null;
  if (noneMatch !== '') return noneMatch === '*' ? { ifNoneMatch: '*' } : null;
  const parsed = /^"?([A-Fa-f0-9]{64})"?$/.exec(match);
  return parsed ? { ifMatch: parsed[1]!.toLowerCase() } : null;
}

function queryPath(req: Request): unknown {
  const value = req.query.path;
  return typeof value === 'string' ? value : undefined;
}

export function registerDesignDocumentRoutes(app: Express, ctx: RegisterDesignDocumentRoutesDeps): void {
  const { sendApiError } = ctx.http;
  const service = new DesignDocumentService({
    projectsRoot: ctx.paths.PROJECTS_DIR,
    runtimeDataDir: ctx.paths.RUNTIME_DATA_DIR,
    legacyStore: ctx.legacyStore,
  });
  const documentBody = raw({ type: OCTET_STREAM, limit: DESIGN_DOCUMENT_MAX_BYTES });
  const coverBody = raw({ type: PNG, limit: DESIGN_COVER_MAX_BYTES });

  /** Returns the project once the request may proceed; otherwise the response has been sent. */
  async function gate(req: Request, res: Response, options: AuthorizeProjectRequestOptions): Promise<GatedProject | null> {
    const projectId = String(req.params.id ?? '');
    const project = ctx.projectStore.getProject(ctx.db, projectId) as { id?: unknown; metadata?: { teamMirrorRevokedAt?: unknown } } | null;
    if (!project || typeof project.id !== 'string' || project.metadata?.teamMirrorRevokedAt) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return null;
    }
    if (!(await ctx.authorizeProjectRequest(req, res, projectId, options))) return null;
    return { id: projectId, metadata: project.metadata };
  }

  /**
   * Runs a write inside the project's public-file mutation lane. Uploads are read before entering it (a slow body
   * must not block the project's other file mutations), so the whole write gate (project lookup, revoked mirror,
   * write authority) runs again inside the lane, as `publicFileMutationHandler` runs it: a visibility move, freeze
   * or revocation that committed while the body was read must not let the write through.
   */
  async function inProjectLane(req: Request, res: Response, projectId: string, write: (project: GatedProject) => Promise<void>): Promise<void> {
    const task = async () => {
      const project = await gate(req, res, WRITE);
      if (!project) return;
      await write(project);
    };
    if (ctx.publicFileMutations) await ctx.publicFileMutations.run(projectId, task);
    else await task();
  }

  function sendTooLarge(res: Response, message: string, details: Record<string, unknown>): void {
    // The rest of the declared body is not read: close the connection after this answer.
    res.set('Connection', 'close');
    sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', message, { details });
  }

  function sendError(res: Response, error: unknown): void {
    if (res.headersSent) return;
    if (error instanceof DesignConflictError) {
      const details: DesignConflictDetails | { reason: 'DESIGN_COVER_STALE'; currentSha256: string | null; path: string } =
        error.reason === 'DESIGN_COVER_STALE'
          ? { reason: 'DESIGN_COVER_STALE', currentSha256: error.currentSha256, path: error.path }
          : { reason: 'DESIGN_REVISION_MISMATCH', currentSha256: error.currentSha256, path: error.path };
      sendApiError(res, 409, 'CONFLICT', error.message, { details });
      return;
    }
    if (error instanceof DesignInputError) {
      switch (error.reason) {
        case 'INVALID_DESIGN_PATH':
          sendApiError(res, 400, 'BAD_REQUEST', error.message, {
            details: { reason: error.reason, ...(error.details.suggestion ? { suggestion: error.details.suggestion } : {}) },
          });
          return;
        case 'INVALID_DESIGN_DATA':
        case 'INVALID_COVER':
          sendApiError(res, 400, 'BAD_REQUEST', error.message, { details: { reason: error.reason } });
          return;
        case 'DESIGN_TOO_LARGE':
          sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', error.message, { details: { reason: error.reason, limit: DESIGN_DOCUMENT_MAX_BYTES } });
          return;
        case 'LEGACY_NOT_FOUND':
          sendApiError(res, 404, 'NOT_FOUND', error.message);
          return;
        case 'DESIGN_NOT_FOUND':
          sendApiError(res, 404, 'FILE_NOT_FOUND', error.message);
          return;
        case 'PATH_EXISTS': {
          const details: DesignConflictDetails = {
            reason: 'DESIGN_REVISION_MISMATCH',
            currentSha256: error.details.currentSha256 ?? null,
            path: error.details.path ?? '',
          };
          sendApiError(res, 409, 'CONFLICT', error.message, { details });
          return;
        }
      }
    }
    console.warn('[fantay-designs] request failed', error);
    sendApiError(res, 500, 'INTERNAL_ERROR', 'design document request failed');
  }

  function requirePath(res: Response, value: unknown, validate: (raw: unknown) => string): string | null {
    try {
      return validate(value);
    } catch (error) {
      sendError(res, error);
      return null;
    }
  }

  app.get('/api/projects/:id/designs', async (req, res) => {
    try {
      const project = await gate(req, res, READ);
      if (!project) return;
      const body: DesignDocumentListResponse = { designs: await service.list(project.id, project.metadata) };
      res.set('Cache-Control', 'no-store');
      res.json(body);
    } catch (error) {
      sendError(res, error);
    }
  });

  // GET also answers HEAD (Express), with the same headers and no body.
  app.get('/api/projects/:id/designs/content', async (req, res) => {
    try {
      const project = await gate(req, res, READ);
      if (!project) return;
      const designPath = requirePath(res, queryPath(req), validateExistingDesignPath);
      if (designPath === null) return;
      const document = await service.read(project.id, designPath, project.metadata);
      res.set({
        'Content-Type': OCTET_STREAM,
        ETag: `"${document.sha256}"`,
        'X-Design-Format': document.summary.format,
        'X-Design-Sha256': document.sha256,
        'X-Design-Revision': document.summary.revision,
        'Last-Modified': new Date(document.summary.mtime).toUTCString(),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(document.bytes);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/projects/:id/designs/content', async (req, res) => {
    try {
      const gated = await gate(req, res, WRITE);
      if (!gated) return;
      const precondition = parseDesignPrecondition(req.get('if-match'), req.get('if-none-match'));
      if (!precondition) {
        sendApiError(res, 428, 'BAD_REQUEST', 'send exactly one of If-Match: "<sha256>" or If-None-Match: *', {
          details: { reason: 'PRECONDITION_REQUIRED' },
        });
        return;
      }
      const create = 'ifNoneMatch' in precondition;
      const designPath = requirePath(res, queryPath(req), create ? validateDesignPath : validateExistingDesignPath);
      if (designPath === null) return;
      if (req.is(OCTET_STREAM) === false) {
        sendApiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', `design documents are uploaded as ${OCTET_STREAM}`);
        return;
      }
      const body = await readRawBody(documentBody, req, res, DESIGN_DOCUMENT_MAX_BYTES);
      if (!body.ok) {
        if (body.tooLarge) {
          sendTooLarge(res, `design documents are limited to ${DESIGN_DOCUMENT_MAX_BYTES} bytes`, {
            reason: 'DESIGN_TOO_LARGE',
            limit: DESIGN_DOCUMENT_MAX_BYTES,
          });
        } else {
          sendApiError(res, 400, 'BAD_REQUEST', 'the design document body could not be read', { details: { reason: 'INVALID_DESIGN_DATA' } });
        }
        return;
      }
      await inProjectLane(req, res, gated.id, async (project) => {
        const saved = await service.write(project.id, designPath, body.body, precondition, project.metadata);
        const response: DesignDocumentSaveResponse = { design: saved.summary, created: saved.created, previousSha256: saved.previousSha256 };
        res.set({ ETag: `"${saved.summary.sha256}"`, 'X-Design-Sha256': saved.summary.sha256, 'Cache-Control': 'no-store' });
        res.status(saved.created ? 201 : 200).json(response);
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/projects/:id/designs/cover', async (req, res) => {
    try {
      const project = await gate(req, res, READ);
      if (!project) return;
      const designPath = requirePath(res, queryPath(req), validateExistingDesignPath);
      if (designPath === null) return;
      const cover = await service.readCover(project.id, designPath, project.metadata);
      if (!cover) {
        sendApiError(res, 404, 'NOT_FOUND', 'this design has no cover yet');
        return;
      }
      res.set({
        'Content-Type': PNG,
        ETag: cover.etag,
        'Cache-Control': 'no-cache',
        'X-Design-Cover-Source': cover.source,
        'X-Content-Type-Options': 'nosniff',
      });
      // A matching If-None-Match gets 304 from res.send (Express freshness check on the ETag).
      res.send(cover.png);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/projects/:id/designs/cover', async (req, res) => {
    try {
      const gated = await gate(req, res, WRITE);
      if (!gated) return;
      const designPath = requirePath(res, queryPath(req), validateExistingDesignPath);
      if (designPath === null) return;
      if (req.is(PNG) === false) {
        sendApiError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', `covers are uploaded as ${PNG}`);
        return;
      }
      const docSha256 = req.get(DESIGN_SHA256_HEADER) ?? '';
      if (!/^[A-Fa-f0-9]{64}$/.test(docSha256.trim())) {
        sendApiError(res, 400, 'BAD_REQUEST', `${DESIGN_SHA256_HEADER} must be the sha256 of the document the cover was rendered from`, {
          details: { reason: 'INVALID_COVER' },
        });
        return;
      }
      const body = await readRawBody(coverBody, req, res, DESIGN_COVER_MAX_BYTES);
      if (!body.ok) {
        if (body.tooLarge) {
          sendTooLarge(res, `cover images are limited to ${DESIGN_COVER_MAX_BYTES} bytes`, { reason: 'INVALID_COVER', limit: DESIGN_COVER_MAX_BYTES });
        } else {
          sendApiError(res, 400, 'BAD_REQUEST', 'the cover body could not be read', { details: { reason: 'INVALID_COVER' } });
        }
        return;
      }
      await inProjectLane(req, res, gated.id, async (project) => {
        await service.writeCover(project.id, designPath, body.body, docSha256, project.metadata);
        res.status(204).end();
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects/:id/designs/import-legacy', publicFileMutationHandler(ctx.publicFileMutations, async (req, res) => {
    try {
      const project = await gate(req, res, WRITE);
      if (!project) return;
      const body = (req.body ?? {}) as { legacyId?: unknown; path?: unknown };
      if (typeof body.legacyId !== 'string' || body.legacyId === '') {
        sendApiError(res, 400, 'BAD_REQUEST', 'legacyId is required');
        return;
      }
      if (body.path !== undefined && body.path !== null && typeof body.path !== 'string') {
        sendApiError(res, 400, 'BAD_REQUEST', 'path must be a string', { details: { reason: 'INVALID_DESIGN_PATH' } });
        return;
      }
      const imported = await service.importLegacy(project.id, body.legacyId, typeof body.path === 'string' ? body.path : undefined, project.metadata);
      const response: ImportLegacyDesignResponse = { design: imported.summary, migration: imported.migration, alreadyImported: imported.alreadyImported };
      res.set('Cache-Control', 'no-store');
      res.status(imported.alreadyImported ? 200 : 201).json(response);
    } catch (error) {
      sendError(res, error);
    }
  }));

  const boardService = ctx.boardService;
  if (!boardService) return;

  app.post('/api/projects/:id/board/import-design-canvas', publicFileMutationHandler(ctx.publicFileMutations, async (req, res) => {
    try {
      const project = await gate(req, res, WRITE);
      if (!project) return;
      const parsed = validateBoardImportRequest(req.body);
      if (!parsed.ok) {
        sendApiError(res, 400, 'VALIDATION_FAILED', parsed.issues[0]?.message ?? 'invalid import request', {
          details: { kind: 'validation', issues: parsed.issues },
        });
        return;
      }
      const result = await importDesignCanvasIntoBoard(
        {
          designs: service,
          board: boardService,
          ensureIdentity: (projectId, filePath, mtime) => {
            try {
              ensureWorkspaceArtifactForPath(ctx.db, {
                projectId,
                path: filePath,
                kind: kindForArtifactPath(filePath),
                mime: mimeForArtifactPath(filePath) ?? null,
                mtime,
              });
            } catch (error) {
              // Comment-pending identities throw by design; the node ref then stays path-only.
              console.warn(`[fantay-designs] workspace identity for ${filePath} unavailable`, error instanceof Error ? error.message : error);
            }
          },
        },
        {
          projectId: project.id,
          metadata: project.metadata,
          documentIds: parsed.value.documentIds,
          ...(parsed.value.placement ? { placement: parsed.value.placement } : {}),
        },
      );
      if (!result.ok) {
        const { status, code, message, details } = result.error;
        sendApiError(res, status, code, message, details !== undefined ? { details } : {});
        return;
      }
      res.set('Cache-Control', 'no-store');
      res.json(result.value);
    } catch (error) {
      sendError(res, error);
    }
  }));
}
