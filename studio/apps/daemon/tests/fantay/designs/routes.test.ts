// `/api/projects/:id/designs*`, `/api/design-canvas/migrations` over the real daemon HTTP boundary (startServer),
// pattern of tests/materials-routes.test.ts.
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESIGN_DOCUMENT_MAX_BYTES } from '@open-design/contracts';

import { startServer } from '../../../src/server.js';
import { closeDatabase, openDatabase } from '../../../src/db.js';
import type { AuthorizeProjectRequest } from '../../../src/collab/project-request-authority.js';
import { sendApiError } from '../../../src/http/api-errors.js';
import { registerDesignDocumentRoutes, type RegisterDesignDocumentRoutesDeps } from '../../../src/routes/designs.js';
import { designCoverPaths } from '../../../src/fantay/designs/paths.js';
import { CanvasStore } from '../../../src/services/design-canvas.js';
import { legacyInput, makeFig, makeOp, makePng, makeTempRoots } from './fixtures.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('design document routes', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectId = 'proj-designs-routes';
  const revokedId = 'proj-designs-revoked';

  function dataDir(): string {
    const dir = process.env.OD_DATA_DIR;
    if (!dir) throw new Error('OD_DATA_DIR is required');
    return dir;
  }

  function designsUrl(suffix = '', id = projectId): string {
    return `${baseUrl}/api/projects/${id}/designs${suffix}`;
  }

  function contentUrl(designPath: string, id = projectId): string {
    return designsUrl(`/content?path=${encodeURIComponent(designPath)}`, id);
  }

  function coverUrl(designPath: string): string {
    return designsUrl(`/cover?path=${encodeURIComponent(designPath)}`);
  }

  async function put(url: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }> {
    const response = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }

  async function json(url: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
    const response = await fetch(url, init);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  }

  function octet(extra: Record<string, string>): Record<string, string> {
    return { 'content-type': 'application/octet-stream', ...extra };
  }

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as { url: string; server: http.Server };
    baseUrl = started.url;
    server = started.server;
    for (const id of [projectId, revokedId]) {
      const created = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name: id }),
      });
      expect(created.status).toBe(200);
    }
    const db = openDatabase(dataDir(), { dataDir: dataDir() });
    db.prepare('UPDATE projects SET metadata_json = ? WHERE id = ?').run(JSON.stringify({ teamMirrorRevokedAt: Date.now() }), revokedId);
  });

  afterAll(async () => {
    closeDatabase();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('requires exactly one precondition (428), then creates (201), updates (200) and detects conflicts (409)', async () => {
    const first = await makeFig({ canvas: 'routes-1' });
    const missing = await put(contentUrl('designs/home.fig'), first, octet({}));
    expect(missing.status).toBe(428);
    expect(missing.body.error).toMatchObject({ code: 'BAD_REQUEST', details: { reason: 'PRECONDITION_REQUIRED' } });
    const both = await put(contentUrl('designs/home.fig'), first, octet({ 'if-none-match': '*', 'if-match': `"${sha256(first)}"` }));
    expect(both.status).toBe(428);

    const created = await put(contentUrl('designs/home.fig'), first, octet({ 'if-none-match': '*' }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      created: true,
      previousSha256: null,
      design: { projectId, path: 'designs/home.fig', name: 'home', format: 'fig', size: first.length, sha256: sha256(first) },
    });
    expect(created.headers.get('etag')).toBe(`"${sha256(first)}"`);

    const second = await makeFig({ canvas: 'routes-2' });
    const updated = await put(contentUrl('designs/home.fig'), second, octet({ 'if-match': `"${sha256(first)}"` }));
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ created: false, previousSha256: sha256(first), design: { sha256: sha256(second) } });

    const stale = await put(contentUrl('designs/home.fig'), await makeFig({ canvas: 'routes-3' }), octet({ 'if-match': `"${sha256(first)}"` }));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'DESIGN_REVISION_MISMATCH', currentSha256: sha256(second), path: 'designs/home.fig' },
    });
    const exists = await put(contentUrl('designs/home.fig'), first, octet({ 'if-none-match': '*' }));
    expect(exists.status).toBe(409);
    expect(exists.body.error.details.currentSha256).toBe(sha256(second));
    const vanished = await put(contentUrl('designs/never.fig'), first, octet({ 'if-match': `"${sha256(first)}"` }));
    expect(vanished.status).toBe(409);
    expect(vanished.body.error.details.currentSha256).toBeNull();
  });

  it('serves bytes with a strong ETag and answers HEAD with the same headers', async () => {
    const bytes = makeOp('served');
    expect((await put(contentUrl('designs/served.op'), bytes, octet({ 'if-none-match': '*' }))).status).toBe(201);
    const response = await fetch(contentUrl('designs/served.op'));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('etag')).toBe(`"${sha256(bytes)}"`);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('x-design-format')).toBe('op');
    expect(response.headers.get('x-design-sha256')).toBe(sha256(bytes));
    expect(response.headers.get('cache-control')).toBe('no-store');
    const revision = response.headers.get('x-design-revision');
    expect(revision).toMatch(new RegExp(`^${bytes.length.toString(16)}-[0-9a-f]+$`));

    const head = await fetch(contentUrl('designs/served.op'), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(`"${sha256(bytes)}"`);
    expect(head.headers.get('x-design-sha256')).toBe(sha256(bytes));
    expect(head.headers.get('x-design-revision')).toBe(revision);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const list = await json(designsUrl());
    expect(list.status).toBe(200);
    expect(list.body.designs.map((design: { path: string }) => design.path)).toContain('designs/served.op');
    const absent = await json(contentUrl('designs/absent.fig'));
    expect(absent.status).toBe(404);
    expect(absent.body.error.code).toBe('FILE_NOT_FOUND');
  });

  it('rejects wrong content types (415), oversized bodies (413) and invalid paths (400)', async () => {
    const bytes = await makeFig({ canvas: 'reject' });
    const wrongType = await put(contentUrl('designs/typed.fig'), bytes, { 'content-type': 'text/plain', 'if-none-match': '*' });
    expect(wrongType.status).toBe(415);
    expect(wrongType.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    // Declared length above the 64 MiB cap: answered before the body is read.
    const oversized = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(contentUrl('designs/huge.fig'), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(DESIGN_DOCUMENT_MAX_BYTES + 1), 'if-none-match': '*' },
      }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => { text += chunk; });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body: text });
          request.destroy();
        });
      });
      request.on('error', (error) => reject(error));
      request.flushHeaders();
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(oversized.body).error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { reason: 'DESIGN_TOO_LARGE' } });

    const nonCanonical = await put(contentUrl('designs/a b.fig'), bytes, octet({ 'if-none-match': '*' }));
    expect(nonCanonical.status).toBe(400);
    expect(nonCanonical.body.error).toMatchObject({ code: 'BAD_REQUEST', details: { reason: 'INVALID_DESIGN_PATH', suggestion: 'designs/a-b.fig' } });
    for (const bad of ['../x.fig', 'designs/a.png', '.file-versions/x.fig']) {
      const result = await put(contentUrl(bad), bytes, octet({ 'if-none-match': '*' }));
      expect(result.status, bad).toBe(400);
      expect(result.body.error.details.reason, bad).toBe('INVALID_DESIGN_PATH');
    }
    const noPath = await put(designsUrl('/content'), bytes, octet({ 'if-none-match': '*' }));
    expect(noPath.status).toBe(400);
    const notFig = await put(contentUrl('designs/text.fig'), Buffer.from('plain text'), octet({ 'if-none-match': '*' }));
    expect(notFig.status).toBe(400);
    expect(notFig.body.error.details.reason).toBe('INVALID_DESIGN_DATA');
  });

  it('serves covers: 404 → PUT (204) → 200 PNG, stale writes 409, embedded thumbnails as fallback', async () => {
    const doc = await makeFig({ canvas: 'cover', thumbnail: null });
    expect((await put(contentUrl('designs/cover.fig'), doc, octet({ 'if-none-match': '*' }))).status).toBe(201);
    const none = await json(coverUrl('designs/cover.fig'));
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('NOT_FOUND');

    const png = makePng(32, 18);
    const stored = await fetch(coverUrl('designs/cover.fig'), {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'x-design-sha256': sha256(doc) },
      body: new Uint8Array(png),
    });
    expect(stored.status).toBe(204);
    const cover = await fetch(coverUrl('designs/cover.fig'));
    expect(cover.status).toBe(200);
    expect(cover.headers.get('content-type')).toBe('image/png');
    expect(cover.headers.get('x-design-cover-source')).toBe('cover');
    expect(cover.headers.get('cache-control')).toBe('no-cache');
    const etag = cover.headers.get('etag');
    expect(etag).toBe(`"${sha256(png)}"`);
    expect(Buffer.from(await cover.arrayBuffer())).toEqual(png);
    // Plain http.get: fetch adds `Cache-Control: no-cache` to conditional requests, which disables revalidation.
    const revalidated = await new Promise<number>((resolve, reject) => {
      http.get(coverUrl('designs/cover.fig'), { headers: { 'if-none-match': etag! } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }).on('error', reject);
    });
    expect(revalidated).toBe(304);

    const stale = await fetch(coverUrl('designs/cover.fig'), {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'x-design-sha256': 'b'.repeat(64) },
      body: new Uint8Array(png),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).error).toMatchObject({ code: 'CONFLICT', details: { reason: 'DESIGN_COVER_STALE', currentSha256: sha256(doc) } });
    const wrongType = await fetch(coverUrl('designs/cover.fig'), {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', 'x-design-sha256': sha256(doc) },
      body: new Uint8Array(png),
    });
    expect(wrongType.status).toBe(415);
    const noSha = await fetch(coverUrl('designs/cover.fig'), { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array(png) });
    expect(noSha.status).toBe(400);
    expect(((await noSha.json()) as any).error.details.reason).toBe('INVALID_COVER');

    const thumbnail = makePng(6, 4);
    expect((await put(contentUrl('designs/thumb.fig'), await makeFig({ canvas: 'thumb', thumbnail }), octet({ 'if-none-match': '*' }))).status).toBe(201);
    const fallback = await fetch(coverUrl('designs/thumb.fig'));
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get('x-design-cover-source')).toBe('thumbnail');
    expect(Buffer.from(await fallback.arrayBuffer())).toEqual(thumbnail);
  });

  it('imports legacy documents (201, then 200) and lists the ledger at /api/design-canvas/migrations', async () => {
    const legacyBytes = await makeFig({ canvas: 'legacy-route' });
    const seeded = await json(`${baseUrl}/api/design-canvas/documents/routes-legacy-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(legacyInput('Legacy Route', legacyBytes)),
    });
    expect(seeded.status).toBe(200);
    const importUrl = designsUrl('/import-legacy');
    const post = (body: unknown) => json(importUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const first = await post({ legacyId: 'routes-legacy-1' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      alreadyImported: false,
      design: { path: 'designs/Legacy-Route.fig', sha256: sha256(legacyBytes) },
      migration: { legacyId: 'routes-legacy-1', projectId, path: 'designs/Legacy-Route.fig', legacySha256: sha256(legacyBytes) },
    });
    const again = await post({ legacyId: 'routes-legacy-1' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyImported: true, design: { path: 'designs/Legacy-Route.fig' } });
    const content = await fetch(contentUrl('designs/Legacy-Route.fig'));
    expect(Buffer.from(await content.arrayBuffer())).toEqual(legacyBytes);

    expect((await post({ legacyId: 'routes-missing' })).status).toBe(404);
    expect((await post({})).status).toBe(400);
    const otherBytes = await makeFig({ canvas: 'legacy-route-2' });
    await json(`${baseUrl}/api/design-canvas/documents/routes-legacy-2`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(legacyInput('Second', otherBytes)),
    });
    const taken = await post({ legacyId: 'routes-legacy-2', path: 'designs/Legacy-Route.fig' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({ code: 'CONFLICT', details: { currentSha256: sha256(legacyBytes), path: 'designs/Legacy-Route.fig' } });

    const ledger = await json(`${baseUrl}/api/design-canvas/migrations`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.migrations).toEqual(expect.arrayContaining([expect.objectContaining({ legacyId: 'routes-legacy-1', projectId })]));
    // The ledger does not show up as a legacy document.
    const documents = await json(`${baseUrl}/api/design-canvas/documents`);
    expect(documents.body.documents.map((doc: { id: string }) => doc.id)).not.toContain('.migrations');
  });

  it('answers 404 for unknown projects and revoked team mirrors', async () => {
    for (const id of ['proj-designs-unknown', revokedId]) {
      const list = await json(designsUrl('', id));
      expect(list.status, id).toBe(404);
      expect(list.body.error.code, id).toBe('PROJECT_NOT_FOUND');
      const write = await put(contentUrl('designs/x.fig', id), await makeFig(), octet({ 'if-none-match': '*' }));
      expect(write.status, id).toBe(404);
    }
  });

  it('writes the document into the project folder (a project file the file list shows)', async () => {
    const bytes = await makeFig({ canvas: 'listed' });
    expect((await put(contentUrl('designs/listed.fig'), bytes, octet({ 'if-none-match': '*' }))).status).toBe(201);
    const files = await json(`${baseUrl}/api/projects/${projectId}/files`);
    expect(files.status).toBe(200);
    const names = (files.body.files as Array<{ name: string }>).map((file) => file.name);
    expect(names).toContain('designs/listed.fig');
    expect(names.some((name) => name.includes('.fx-tmp-'))).toBe(false);
    // An agent-written file with a non-canonical name stays readable through the routes.
    const agentFile = path.join(dataDir(), 'projects', projectId, 'designs', 'Agent Made.fig');
    await mkdir(path.dirname(agentFile), { recursive: true });
    await writeFile(agentFile, bytes);
    const read = await fetch(contentUrl('designs/Agent Made.fig'));
    expect(read.status).toBe(200);
  });
});

// Uploads are read before the project's public-file mutation lane; the write authority must still be decided inside
// the lane (as `publicFileMutationHandler` does), so a move/freeze queued ahead of the write is not bypassed.
describe('design uploads re-check the write gate inside the project lane', () => {
  it('refuses document and cover writes whose authority was revoked while they waited for the lane', async () => {
    const roots = await makeTempRoots('fantay-designs-lane-');
    const projectId = 'proj-designs-lane';
    let writable = true;
    let revokeBeforeNextLane = false;
    const authorizeProjectRequest: AuthorizeProjectRequest = async (_req, res, _id, options) => {
      if (options.mode === 'write' && !writable) {
        sendApiError(res, 403, 'WORKSPACE_PROJECT_PERMISSION_DENIED', 'workspace project mutation is not allowed');
        return false;
      }
      return true;
    };
    const app = express();
    registerDesignDocumentRoutes(app, {
      db: null,
      http: { sendApiError },
      paths: { PROJECTS_DIR: roots.projectsRoot, RUNTIME_DATA_DIR: roots.runtimeDataDir },
      projectStore: { getProject: (_db: unknown, id: string) => (id === projectId ? { id, metadata: {} } : null) },
      projectFiles: {},
      authorizeProjectRequest,
      publicFileMutations: {
        // A visibility move queued ahead of the upload commits before the upload's turn in the lane.
        run: async <T,>(_ids: string | readonly string[], operation: () => Promise<T>): Promise<T> => {
          if (revokeBeforeNextLane) {
            revokeBeforeNextLane = false;
            writable = false;
          }
          return operation();
        },
        withMoves: async <T,>(_ids: readonly string[], operation: () => Promise<T>): Promise<T> => operation(),
        captureReconciliation: () => () => true,
      },
      legacyStore: new CanvasStore(roots.runtimeDataDir),
    } as unknown as RegisterDesignDocumentRoutesDeps);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    const url = (route: string, designPath: string) =>
      `http://127.0.0.1:${port}/api/projects/${projectId}/designs/${route}?path=${encodeURIComponent(designPath)}`;
    const file = path.join(roots.projectsRoot, projectId, 'designs', 'lane.fig');
    try {
      const first = await makeFig({ canvas: 'lane-1' });
      const created = await fetch(url('content', 'designs/lane.fig'), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'if-none-match': '*' },
        body: new Uint8Array(first),
      });
      expect(created.status).toBe(201);

      revokeBeforeNextLane = true;
      const update = await fetch(url('content', 'designs/lane.fig'), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'if-match': `"${sha256(first)}"` },
        body: new Uint8Array(await makeFig({ canvas: 'lane-2' })),
      });
      expect(update.status).toBe(403);
      expect(((await update.json()) as any).error.code).toBe('WORKSPACE_PROJECT_PERMISSION_DENIED');
      expect(await readFile(file)).toEqual(first);

      writable = true;
      revokeBeforeNextLane = true;
      const cover = await fetch(url('cover', 'designs/lane.fig'), {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'x-design-sha256': sha256(first) },
        body: new Uint8Array(makePng(8, 8)),
      });
      expect(cover.status).toBe(403);
      await expect(readFile(designCoverPaths(roots.runtimeDataDir, projectId, 'designs/lane.fig').png)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await roots.cleanup();
    }
  });
});
