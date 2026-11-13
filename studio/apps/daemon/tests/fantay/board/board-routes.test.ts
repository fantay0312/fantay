import type http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOARD_LIMITS,
  type BoardGetResponse,
  type BoardPatchResponse,
} from '@open-design/contracts';

import { startServer } from '../../../src/server.js';
import { closeDatabase, getProject, openDatabase } from '../../../src/db.js';
import { listFiles, resolveProjectFilePath } from '../../../src/projects.js';
import { createBoardService } from '../../../src/fantay/board/service.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

interface CapturedSseEvent {
  event: string;
  data: any;
}

describe('board routes', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectId = 'proj-board-routes';
  const revokedId = 'proj-board-revoked';

  function dataDir(): string {
    const dir = process.env.OD_DATA_DIR;
    if (!dir) throw new Error('OD_DATA_DIR is required');
    return dir;
  }

  async function writeProjectFile(name: string, content: string | Buffer, id = projectId): Promise<void> {
    const file = path.join(dataDir(), 'projects', id, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  async function call(method: string, suffix: string, body?: unknown, id = projectId): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}/api/projects/${id}/board${suffix}`, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function board(): Promise<BoardGetResponse['board']> {
    const result = await call('GET', '');
    expect(result.status).toBe(200);
    return (result.body as BoardGetResponse).board;
  }

  async function openProjectEvents(id: string): Promise<{ events: CapturedSseEvent[]; close: () => void }> {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/projects/${id}/events`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.ok).toBe(true);
    const events: CapturedSseEvent[] = [];
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let boundary = buffered.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffered.slice(0, boundary);
            buffered = buffered.slice(boundary + 2);
            const name = /^event:\s*(.*)$/m.exec(frame)?.[1]?.trim();
            if (name) {
              const raw = /^data:\s*(.*)$/m.exec(frame)?.[1];
              let data: any = null;
              try {
                data = raw ? JSON.parse(raw) : null;
              } catch {
                data = null;
              }
              events.push({ event: name, data });
            }
            boundary = buffered.indexOf('\n\n');
          }
        }
      } catch {
        // aborted
      }
    })();
    return { events, close: () => controller.abort() };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
    await writeProjectFile('index.html', '<!doctype html><title>Home</title>');
    await writeProjectFile('hero.png', PNG);
    const db = openDatabase(dataDir(), { dataDir: dataDir() });
    db.prepare('UPDATE projects SET metadata_json = ? WHERE id = ?')
      .run(JSON.stringify({ teamMirrorRevokedAt: Date.now() }), revokedId);
  });

  afterAll(async () => {
    closeDatabase();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns revision 0 for a project that never saved a board', async () => {
    const doc = await board();
    expect(doc).toMatchObject({ schemaVersion: 1, projectId, revision: 0, nodes: [], edges: [], viewport: null, updatedBy: null });
    expect(doc).not.toHaveProperty('sync');
    const withSync = await call('GET', '?include=sync');
    expect(withSync.body.board.sync).toMatchObject({ version: 1, seededAt: null });
    // Replacing an empty board with an empty board changes nothing (no revision bump).
    const emptyPut = await call('PUT', '', { baseRevision: 0, board: { nodes: [], edges: [] } });
    expect(emptyPut).toMatchObject({ status: 200, body: { board: { revision: 0, nodes: [] } } });
  });

  it('answers 404 for unknown projects and revoked team mirrors', async () => {
    expect((await call('GET', '', undefined, 'proj-board-missing')).status).toBe(404);
    const patch = await call('PATCH', '', { baseRevision: 0, ops: [{ op: 'add', node: { kind: 'note', text: 'x' } }] }, 'proj-board-missing');
    expect(patch).toMatchObject({ status: 404, body: { error: { code: 'PROJECT_NOT_FOUND' } } });
    expect((await call('GET', '', undefined, revokedId)).body).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
    expect((await call('PUT', '/viewport', { viewport: { centerX: 0, centerY: 0, zoom: 1 } }, revokedId)).status).toBe(404);
  });

  it('adds a frame with PATCH: revision 1, canonical ref and a workspace identity, plus a board-changed event', async () => {
    const stream = await openProjectEvents(projectId);
    try {
      const result = await call('PATCH', '', {
        baseRevision: 0,
        actor: { kind: 'user', clientId: 'tab-1' },
        ops: [{ op: 'add', node: { id: 'n_frame_home', kind: 'frame', ref: { path: 'index.html' } } }],
      });
      expect(result.status).toBe(200);
      const body = result.body as BoardPatchResponse;
      expect(body.revision).toBe(1);
      expect(body.results).toEqual([{ index: 0, status: 'applied', ids: ['n_frame_home'] }]);
      expect(body.inverse).toHaveLength(1);
      const [node] = body.changes.upsertNodes;
      expect(node).toMatchObject({ id: 'n_frame_home', kind: 'frame', device: 'desktop', w: 1440, h: 900, rev: 1, ref: { path: 'index.html' } });
      expect((node as any).ref.workspaceArtifactId).toEqual(expect.any(String));
      const doc = await board();
      expect(doc.revision).toBe(1);
      expect(doc.nodes[0]).toEqual(node);
      await waitFor(() => stream.events.some((event) => event.event === 'board-changed'));
      const event = stream.events.find((entry) => entry.event === 'board-changed')!;
      expect(event.data).toMatchObject({ type: 'board-changed', projectId, revision: 1, reason: 'patch', actor: { kind: 'user', clientId: 'tab-1' } });
    } finally {
      stream.close();
    }
  });

  it('rejects a stale expectRev with 409 board-conflict and commits nothing', async () => {
    const result = await call('PATCH', '', {
      baseRevision: 1,
      ops: [{ op: 'update', id: 'n_frame_home', patch: { title: 'Home' }, expectRev: 0 }],
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { kind: 'board-conflict', revision: 1, conflicts: [{ opIndex: 0, id: 'n_frame_home', reason: 'stale-entity', currentRev: 1 }] },
    });
    expect((await board()).revision).toBe(1);
  });

  it('answers 404 FILE_NOT_FOUND for a missing file and 400 for a file of another kind', async () => {
    const missing = await call('PATCH', '', { baseRevision: 1, ops: [{ op: 'add', node: { kind: 'image', ref: { path: 'nope.png' } } }] });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'FILE_NOT_FOUND', details: { kind: 'board-ref', opIndex: 0, path: 'nope.png', reason: 'not-found' } });
    const wrongKind = await call('PATCH', '', { baseRevision: 1, ops: [{ op: 'add', node: { kind: 'frame', ref: { path: 'hero.png' } } }] });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error.details).toMatchObject({ kind: 'board-ref', reason: 'not-placeable' });
    const invalid = await call('PATCH', '', { baseRevision: 1, ops: [] });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: { kind: 'validation' } });
    // Amendment C8: generators offer image | video only in phase 1.
    const audioGenerator = await call('PATCH', '', {
      baseRevision: 1,
      ops: [{ op: 'add', node: { kind: 'generator', surface: 'audio', prompt: 'beat', model: null, params: { aspect: '1:1', count: 1 } } }],
    });
    expect(audioGenerator.status).toBe(400);
    expect(audioGenerator.body.error.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'ops[0].node.surface' })]));
  });

  it('returns the current revision without committing when nothing changes', async () => {
    const result = await call('PATCH', '', { baseRevision: 1, ops: [{ op: 'remove', ids: ['n_not_there'] }] });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ revision: 1, inverse: [], results: [{ index: 0, status: 'skipped', reason: 'missing' }] });
    expect((await board()).revision).toBe(1);
  });

  it('stamps createdAt monotonically for everything one PATCH creates (B13)', async () => {
    const result = await call('PATCH', '', {
      baseRevision: 1,
      ops: [
        { op: 'add', node: { id: 'n_gen_b13', kind: 'generator', surface: 'image', prompt: 'p', model: null, params: { aspect: '1:1', count: 1 }, runs: [] } },
        { op: 'add', node: { id: 'n_z_note', kind: 'note', text: 'z' } },
        { op: 'add', node: { id: 'n_a_note', kind: 'note', text: 'a' } },
        { op: 'connect', edge: { id: 'e_zz', kind: 'reference', from: 'n_z_note', to: 'n_gen_b13' } },
        { op: 'connect', edge: { id: 'e_aa', kind: 'reference', from: 'n_a_note', to: 'n_gen_b13' } },
      ],
    });
    expect(result.status).toBe(200);
    const doc = await board();
    const created = ['n_gen_b13', 'n_z_note', 'n_a_note'].map((id) => doc.nodes.find((node) => node.id === id)!.createdAt);
    expect(created[1]).toBeGreaterThan(created[0]!);
    expect(created[2]).toBeGreaterThan(created[1]!);
    expect(doc.edges.map((edge) => edge.id)).toEqual(['e_zz', 'e_aa']);
    expect(doc.edges[1]!.createdAt).toBeGreaterThan(doc.edges[0]!.createdAt);
    expect(doc.edges[0]!.createdAt).toBeGreaterThan(created[2]!);
  });

  it('replaces the whole board with PUT only on the current revision', async () => {
    const before = await board();
    const stale = await call('PUT', '', { baseRevision: before.revision - 1, board: { nodes: before.nodes, edges: before.edges } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toMatchObject({ kind: 'board-conflict', conflicts: [{ opIndex: -1, id: '*', reason: 'stale-board' }] });
    // Re-sending the same content changes nothing.
    const same = await call('PUT', '', { baseRevision: before.revision, board: { title: before.title, settings: before.settings, nodes: before.nodes, edges: before.edges } });
    expect(same.status).toBe(200);
    expect(same.body.board.revision).toBe(before.revision);
    const replaced = await call('PUT', '', {
      baseRevision: before.revision,
      actor: { kind: 'cli' },
      board: { title: 'Replaced', nodes: [{ id: 'n_only', kind: 'note', text: 'only', x: 0, y: 0, w: 200, h: 100 }], edges: [] },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.board).toMatchObject({ revision: before.revision + 1, title: 'Replaced', updatedBy: { kind: 'cli' } });
    expect(replaced.body.board.nodes).toHaveLength(1);
    expect(replaced.body.board.nodes[0]).toMatchObject({ id: 'n_only', rev: before.revision + 1, createdBy: { kind: 'cli' } });
    const ledger = (await call('GET', '?include=sync')).body.board.sync;
    expect(ledger.dismissed).toHaveProperty('index.html');
  });

  it('answers 413 board-limit above maxNodes', async () => {
    const current = await board();
    const nodes = Array.from({ length: BOARD_LIMITS.maxNodes + 1 }, (_, index) => ({ id: `n_bulk${index}`, kind: 'note', text: '', x: 0, y: 0, w: 10, h: 10 }));
    const result = await call('PUT', '', { baseRevision: current.revision, board: { nodes, edges: [] } });
    expect(result.status).toBe(413);
    expect(result.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { kind: 'board-limit', limit: 'maxNodes', max: BOARD_LIMITS.maxNodes } });
    expect((await board()).revision).toBe(current.revision);
  });

  it('saves the viewport without a revision bump or an event', async () => {
    const before = await board();
    const stream = await openProjectEvents(projectId);
    try {
      const result = await call('PUT', '/viewport', { viewport: { centerX: 120, centerY: -40, zoom: 0.75 } });
      expect(result).toMatchObject({ status: 200, body: { ok: true } });
      const after = await board();
      expect(after.revision).toBe(before.revision);
      expect(after.viewport).toEqual({ centerX: 120, centerY: -40, zoom: 0.75 });
      expect((await call('PUT', '/viewport', { viewport: { centerX: 0, centerY: 0, zoom: 0 } })).status).toBe(400);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stream.events.some((event) => event.event === 'board-changed')).toBe(false);
    } finally {
      stream.close();
    }
  });

  it('stores covers by digest and checks the magic bytes against the content type', async () => {
    const put = await fetch(`${baseUrl}/api/projects/${projectId}/board/covers?width=320&height=200&sourceMtime=1700000000000`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: PNG,
    });
    expect(put.status).toBe(200);
    const uploaded = await put.json() as any;
    expect(uploaded.cover).toMatchObject({ source: 'board-cover', mime: 'image/png', width: 320, height: 200, sourceMtime: 1700000000000 });
    expect(uploaded.cover.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(uploaded.url).toBe(`/api/projects/${projectId}/board/covers/${uploaded.cover.digest}`);
    const get = await fetch(`${baseUrl}${uploaded.url}`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    expect(get.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(Buffer.from(await get.arrayBuffer())).toEqual(PNG);

    const mismatch = await fetch(`${baseUrl}/api/projects/${projectId}/board/covers?width=10&height=10`, {
      method: 'PUT', headers: { 'content-type': 'image/png' }, body: JPEG,
    });
    expect(mismatch.status).toBe(415);
    expect(((await mismatch.json()) as any).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    const gif = await fetch(`${baseUrl}/api/projects/${projectId}/board/covers?width=10&height=10`, {
      method: 'PUT', headers: { 'content-type': 'image/gif' }, body: Buffer.from('GIF89a'),
    });
    expect(gif.status).toBe(415);
    const badSize = await fetch(`${baseUrl}/api/projects/${projectId}/board/covers?width=0&height=5000`, {
      method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG,
    });
    expect(badSize.status).toBe(400);
    const tooLarge = await fetch(`${baseUrl}/api/projects/${projectId}/board/covers?width=10&height=10`, {
      method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.concat([PNG, Buffer.alloc(BOARD_LIMITS.maxCoverBytes)]),
    });
    expect(tooLarge.status).toBe(413);
    expect(((await tooLarge.json()) as any).error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { kind: 'board-limit', limit: 'maxCoverBytes' } });
    expect((await fetch(`${baseUrl}/api/projects/${projectId}/board/covers/${'0'.repeat(64)}`)).status).toBe(404);
  });

  it('runs a sync and reports it on the event stream', async () => {
    const stream = await openProjectEvents(projectId);
    try {
      const result = await call('POST', '/sync', { reason: 'manual', actor: { kind: 'user', clientId: 'tab-9' } });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ changed: true, focus: null, unplaceable: [] });
      // First sync seeds the project root; index.html left the board through the PUT above, so it stays dismissed.
      expect(result.body.placements.filter((entry: any) => entry.status === 'created').map((entry: any) => entry.path))
        .toEqual(['hero.png']);
      await waitFor(() => stream.events.some((event) => event.event === 'board-changed' && event.data?.reason === 'sync'));
      expect(stream.events.find((event) => event.data?.reason === 'sync')!.data.actor).toEqual({ kind: 'sync', clientId: 'tab-9' });
      const again = await call('POST', '/sync', { reason: 'manual' });
      expect(again.body).toMatchObject({ changed: false, changes: null, revision: result.body.revision });
      expect((await call('POST', '/sync', { reason: 'nope' })).status).toBe(400);
    } finally {
      stream.close();
    }
  });

  it('lets server-side writers commit through the same pipeline (applyOps, plan R11)', async () => {
    await writeProjectFile('designs/poster.fig', Buffer.from('fig-bytes'));
    const emitted: unknown[] = [];
    const db = openDatabase(dataDir(), { dataDir: dataDir() });
    const service = createBoardService({
      db,
      paths: { PROJECTS_DIR: path.join(dataDir(), 'projects'), RUNTIME_DATA_DIR: dataDir() },
      projectFiles: { resolveProjectFilePath, listFiles },
      getProject,
      emitProjectEvent: (_projectId, payload) => {
        emitted.push(payload);
        return true;
      },
    });
    const migratedFrom = { store: 'design-canvas' as const, documentId: 'legacy-1', sha256: 'a'.repeat(64) };
    const build = (content: { nodes: Array<{ kind: string; migratedFrom?: { documentId: string } }> }) =>
      content.nodes.some((node) => node.kind === 'design' && node.migratedFrom?.documentId === 'legacy-1')
        ? []
        : [{ op: 'add' as const, node: { kind: 'design' as const, ref: { path: 'designs/poster.fig' }, format: 'fig' as const, migratedFrom, origin: { source: 'migration' as const } } }];
    const before = await board();
    const first = await service.applyOps({ projectId, ops: build as never, reason: 'import' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.revision).toBe(before.revision + 1);
    expect(first.value.changes.upsertNodes[0]).toMatchObject({ kind: 'design', migratedFrom, updatedBy: { kind: 'daemon' } });
    expect(emitted).toEqual([expect.objectContaining({ type: 'board-changed', reason: 'import', revision: before.revision + 1, actor: { kind: 'daemon' } })]);
    const second = await service.applyOps({ projectId, ops: build as never, reason: 'import' });
    expect(second).toMatchObject({ ok: true, value: { revision: before.revision + 1, inverse: [] } });
    expect(emitted).toHaveLength(1);
    // Array ops get the PATCH ref checks.
    const missing = await service.applyOps({ projectId, ops: [{ op: 'add', node: { kind: 'design', ref: { path: 'designs/none.fig' }, format: 'fig' } }], reason: 'import' });
    expect(missing).toMatchObject({ ok: false, error: { status: 404, code: 'FILE_NOT_FOUND' } });
  });
});
