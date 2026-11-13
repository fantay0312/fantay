// Fantay material library (素材库) HTTP surface.
//
// Read-only routes over an external archive (see `../materials/`), plus one
// project write: copying a record into a project folder. Reads ride the
// daemon's loopback binding and the global `/api` origin guard like the rest
// of `/api`; the copy is loopback-only and passes the workspace `writeFiles`
// mutation gate, exactly like the OD Library apply route.
//
// Errors use the contract envelope `MaterialErrorResponse`
// (`{ error: { code, message } }`).

import type { Express, Request, Response } from 'express';
import type {
  MaterialApplyRequest,
  MaterialErrorCode,
  MaterialErrorResponse,
  MaterialFileField,
} from '@open-design/contracts';
import { MATERIAL_SEARCH_MAX_LIMIT } from '@open-design/contracts';

import type { RouteDeps } from '../server-context.js';
import type { BoundWorkspaceResourceMutationGate } from '../collab/workspace-resource-mutation.js';
import { recordApiFailure } from '../http/api-failure-journal.js';
import { applyMaterialToProject, openCopyableMaterial } from '../materials/apply.js';
import { parseMaterialFileFields } from '../materials/copy.js';
import { invalidRequest, isMaterialError } from '../materials/errors.js';
import type { MaterialSearchParams } from '../materials/service.js';
import type { MaterialLibrariesService } from '../materials/libraries.js';
import { streamAssetFileToResponse } from './library.js';

export interface RegisterMaterialsRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore'> {
  materials: MaterialLibrariesService;
  enforceWorkspaceProjectMutation?: BoundWorkspaceResourceMutationGate;
}

const MAX_SEARCH_OFFSET = 1_000_000;
const MAX_CONTEXT_TASK_CHARS = 20_000;
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function sendMaterialError(res: Response, status: number, code: MaterialErrorCode, message: string): Response {
  recordApiFailure({ at: new Date().toISOString(), request: res.req, status, code, retryable: false });
  const body: MaterialErrorResponse = { error: { code, message } };
  return res.status(status).json(body);
}

function optionalQueryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidRequest(`${key} must be a single string`);
  return value.length > 0 ? value : undefined;
}

function boundedQueryInt(req: Request, key: string, min: number, max: number): number | undefined {
  const raw = optionalQueryString(req, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) throw invalidRequest(`${key} must be an integer`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalidRequest(`${key} must be ${min}..${max}`);
  }
  return value;
}

function parseSearchParams(req: Request): MaterialSearchParams {
  const params: MaterialSearchParams = {};
  const q = optionalQueryString(req, 'q');
  if (q !== undefined) params.q = q;
  for (const key of ['category', 'kind', 'collection', 'libraryId', 'section'] as const) {
    const value = optionalQueryString(req, key);
    if (value !== undefined) params[key] = value;
  }
  const limit = boundedQueryInt(req, 'limit', 1, MATERIAL_SEARCH_MAX_LIMIT);
  if (limit !== undefined) params.limit = limit;
  const offset = boundedQueryInt(req, 'offset', 0, MAX_SEARCH_OFFSET);
  if (offset !== undefined) params.offset = offset;
  return params;
}

function bodyObject(req: Request): Record<string, unknown> {
  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parseContextBody(req: Request): { ids: string[]; task: string } {
  const body = bodyObject(req);
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw invalidRequest('ids must be an array of material IDs');
  }
  const task = body.task;
  if (task !== undefined && typeof task !== 'string') throw invalidRequest('task must be a string');
  if (typeof task === 'string' && task.length > MAX_CONTEXT_TASK_CHARS) {
    throw invalidRequest(`task must be at most ${MAX_CONTEXT_TASK_CHARS} characters`);
  }
  return { ids: body.ids as string[], task: typeof task === 'string' ? task : '' };
}

interface ParsedApplyBody {
  projectId: string;
  dir?: string;
  fields?: MaterialFileField[];
  files?: string[];
}

function parseApplyBody(req: Request): ParsedApplyBody {
  const body = bodyObject(req) as Partial<Record<keyof MaterialApplyRequest, unknown>>;
  if (typeof body.projectId !== 'string' || !body.projectId.trim()) throw invalidRequest('projectId is required');
  const parsed: ParsedApplyBody = { projectId: body.projectId.trim() };
  if (body.dir !== undefined) {
    if (typeof body.dir !== 'string') throw invalidRequest('dir must be a string');
    parsed.dir = body.dir;
  }
  if (body.fields !== undefined) parsed.fields = parseMaterialFileFields(body.fields);
  if (body.files !== undefined) {
    if (!Array.isArray(body.files) || body.files.some((file) => typeof file !== 'string' || file.length === 0)) {
      throw invalidRequest('files must be an array of collection-relative paths');
    }
    parsed.files = body.files as string[];
  }
  return parsed;
}

function routeId(req: Request): string {
  const value = req.params.id;
  return typeof value === 'string' ? value : '';
}

export function registerMaterialsRoutes(app: Express, ctx: RegisterMaterialsRoutesDeps): void {
  const { materials, db } = ctx;
  const { requireLocalDaemonRequest, sendApiError } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { getProject, getWorkspaceProject, getWorkspaceProjectByProjectId } = ctx.projectStore;

  function fail(res: Response, error: unknown): Response {
    if (isMaterialError(error)) return sendMaterialError(res, error.status, error.code, error.message);
    return sendApiError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }

  async function enforceProjectWrite(req: Request, res: Response, projectId: string): Promise<boolean> {
    if (!ctx.enforceWorkspaceProjectMutation) return true;
    return ctx.enforceWorkspaceProjectMutation(
      req,
      res,
      sendApiError,
      getWorkspaceProject,
      getWorkspaceProjectByProjectId,
      db,
      projectId,
      'writeFiles',
    );
  }

  app.get('/api/materials/libraries', async (_req, res) => {
    try { res.json(await materials.libraries()); } catch (error) { fail(res, error); }
  });

  app.post('/api/materials/libraries', requireLocalDaemonRequest, async (req, res) => {
    try {
      const body = bodyObject(req);
      if (typeof body.root !== 'string' || !body.root.trim()) throw invalidRequest('root is required');
      if (body.name !== undefined && typeof body.name !== 'string') throw invalidRequest('name must be a string');
      res.json({ library: await materials.addLibrary(body.root, body.name as string | undefined) });
    } catch (error) { fail(res, error); }
  });

  app.delete('/api/materials/libraries/:id', requireLocalDaemonRequest, async (req, res) => {
    try {
      await materials.removeLibrary(routeId(req));
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  app.post('/api/materials/libraries/:id/scan', requireLocalDaemonRequest, async (req, res) => {
    try { res.json({ library: await materials.scanLibrary(routeId(req)) }); }
    catch (error) { fail(res, error); }
  });

  app.get('/api/materials/summary', async (req, res) => {
    try {
      res.json(await materials.summary(optionalQueryString(req, 'libraryId')));
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/materials/items', async (req, res) => {
    try {
      res.json(await materials.search(parseSearchParams(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/materials/items/:id', async (req, res) => {
    try {
      res.json(await materials.detail(routeId(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  // Bounded, id-addressed thumbnail. Never accepts a path; only indexed image
  // types inside the library, with no symlinked segment, are streamed.
  app.get('/api/materials/items/:id/thumbnail', async (req, res) => {
    let file;
    try {
      file = await materials.thumbnail(routeId(req));
    } catch (error) {
      fail(res, error);
      return;
    }
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    // SVG opened directly would run script on the daemon origin.
    if (file.isSvg) res.setHeader('Content-Security-Policy', SVG_CONTENT_SECURITY_POLICY);
    streamAssetFileToResponse(file.absolutePath, res, () => {
      res.removeHeader('Content-Security-Policy');
      sendMaterialError(res, 404, 'missing-file', 'Thumbnail could not be read');
    });
  });

  app.post('/api/materials/context', async (req, res) => {
    try {
      const { ids, task } = parseContextBody(req);
      res.json(await materials.context(ids, task));
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/materials/items/:id/apply', requireLocalDaemonRequest, async (req, res) => {
    try {
      const body = parseApplyBody(req);
      const id = routeId(req);
      const opened = await openCopyableMaterial(materials, id);
      const project = getProject(db, body.projectId);
      if (!project) {
        sendMaterialError(res, 404, 'project-not-found', `Project not found: ${body.projectId}`);
        return;
      }
      if (!(await enforceProjectWrite(req, res, body.projectId))) return;
      const result = await applyMaterialToProject({
        materials,
        opened,
        projectsDir: PROJECTS_DIR,
        projectId: body.projectId,
        projectMetadata: project.metadata,
        id,
        ...(body.dir !== undefined ? { dir: body.dir } : {}),
        ...(body.fields ? { fields: body.fields } : {}),
        ...(body.files ? { files: body.files } : {}),
      });
      res.json(result);
    } catch (error) {
      fail(res, error);
    }
  });
}
