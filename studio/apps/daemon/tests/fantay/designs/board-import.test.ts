// `POST /api/projects/:id/board/import-design-canvas` (04 §4.7 via plan R11): importLegacy per document, then design
// nodes through the board service's applyOps. Pure planning, the orchestration with fakes, and the real HTTP route
// plus `od board import-canvas` against it.
import { createHash } from 'node:crypto';
import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOARD_LIMITS,
  emptyBoardContent,
  stableBoardId,
  type BoardContent,
  type BoardDesignNode,
  type BoardGroupNode,
  type BoardNode,
  type BoardOp,
} from '@open-design/contracts';

import { startServer } from '../../../src/server.js';
import { closeDatabase } from '../../../src/db.js';
import { runBoardCli } from '../../../src/fantay/board/board-cli.js';
import {
  DESIGN_IMPORT_DOCUMENTS_PER_BATCH,
  importDesignCanvasIntoBoard,
  planDesignImportOps,
  type DesignCanvasBoardImportDeps,
} from '../../../src/fantay/designs/board-import.js';
import { DesignInputError } from '../../../src/fantay/designs/errors.js';
import { legacyInput, makeFig } from './fixtures.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function designNode(id: string, documentId: string, sha: string, filePath: string, extra: Partial<BoardDesignNode> = {}): BoardDesignNode {
  return {
    id,
    kind: 'design',
    x: 0,
    y: 0,
    w: 960,
    h: 600,
    ref: { path: filePath },
    format: 'fig',
    migratedFrom: { store: 'design-canvas', documentId, sha256: sha },
    createdAt: 1,
    updatedAt: 1,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    rev: 1,
    ...extra,
  };
}

describe('planDesignImportOps', () => {
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);
  let counter = 0;
  const newId = () => `n_fresh${(counter += 1)}`;

  it('adds two or more new nodes in one design section row group placed as requested', () => {
    const plan = planDesignImportOps(
      emptyBoardContent(),
      [
        { documentId: 'doc-a', path: 'designs/a.fig', format: 'fig', sha256: shaA },
        { documentId: 'doc-b', path: 'designs/b.op', format: 'op', sha256: shaB },
      ],
      { mode: 'at', x: 10, y: 20 },
      newId,
    );
    expect(plan.ops).toHaveLength(3);
    const [group, first, second] = plan.ops as [Extract<BoardOp, { op: 'add' }>, Extract<BoardOp, { op: 'add' }>, Extract<BoardOp, { op: 'add' }>];
    expect(group).toMatchObject({ op: 'add', placement: { mode: 'at', x: 10, y: 20 }, node: { kind: 'group', role: 'section', sectionKind: 'design', layout: 'row' } });
    const groupId = (group.node as { id: string }).id;
    expect(first.node).toMatchObject({
      id: stableBoardId('n', `design-canvas:doc-a:${shaA}`),
      kind: 'design',
      parentId: groupId,
      ref: { path: 'designs/a.fig' },
      format: 'fig',
      migratedFrom: { store: 'design-canvas', documentId: 'doc-a', sha256: shaA },
      origin: { source: 'migration' },
    });
    expect(second.node).toMatchObject({ format: 'op', parentId: groupId });
    expect(plan.results).toEqual([
      { documentId: 'doc-a', status: 'imported', path: 'designs/a.fig', nodeId: stableBoardId('n', `design-canvas:doc-a:${shaA}`) },
      { documentId: 'doc-b', status: 'imported', path: 'designs/b.op', nodeId: stableBoardId('n', `design-canvas:doc-b:${shaB}`) },
    ]);
  });

  it('reuses nodes of the same import, repairs moved or missing ones and avoids taken ids', () => {
    const content: BoardContent = {
      ...emptyBoardContent(),
      nodes: [
        designNode('n_same', 'doc-a', shaA, 'designs/a.fig'),
        designNode('n_moved', 'doc-b', shaB, 'designs/old-b.fig', { missing: { since: 5 } }),
        { ...designNode(stableBoardId('n', `design-canvas:doc-c:${shaA}`), 'other', shaB, 'designs/x.fig') } as BoardNode,
      ],
    };
    const plan = planDesignImportOps(
      content,
      [
        { documentId: 'doc-a', path: 'designs/a.fig', format: 'fig', sha256: shaA },
        { documentId: 'doc-b', path: 'designs/b.fig', format: 'fig', sha256: shaB },
        { documentId: 'doc-c', path: 'designs/c.fig', format: 'fig', sha256: shaA },
      ],
      { mode: 'auto' },
      newId,
    );
    expect(plan.ops).toEqual([
      { op: 'update', id: 'n_moved', patch: { ref: { path: 'designs/b.fig' }, missing: null } },
      expect.objectContaining({ op: 'add', placement: { mode: 'auto' }, node: expect.objectContaining({ ref: { path: 'designs/c.fig' } }) }),
    ]);
    const added = (plan.ops[1] as Extract<BoardOp, { op: 'add' }>).node as { id: string };
    expect(added.id).not.toBe(stableBoardId('n', `design-canvas:doc-c:${shaA}`));
    expect(plan.results.map((result) => [result.documentId, result.status, result.nodeId])).toEqual([
      ['doc-a', 'already-imported', 'n_same'],
      ['doc-b', 'imported', 'n_moved'],
      ['doc-c', 'imported', added.id],
    ]);
  });
});

describe('importDesignCanvasIntoBoard (fakes)', () => {
  function fakes(count: number) {
    const applied: BoardOp[][] = [];
    let revision = 3;
    const content: BoardContent = emptyBoardContent();
    const deps: DesignCanvasBoardImportDeps = {
      designs: {
        legacyInfo: async (id: string) => {
          if (id === 'gone') return null;
          if (id === 'broken') throw new DesignInputError('INVALID_DESIGN_DATA', 'broken');
          return { legacyId: id, name: id, format: 'fig' as const, legacySha256: sha256(Buffer.from(id)) };
        },
        importLegacy: async (_projectId: string, id: string) => ({
          summary: { projectId: 'p', path: `designs/${id}.fig`, name: id, format: 'fig' as const, size: 1, mtime: 1, revision: '1-1', coverUrl: '', sha256: 'c'.repeat(64) },
          migration: { legacyId: id, legacySha256: sha256(Buffer.from(id)), projectId: 'p', path: `designs/${id}.fig`, sha256: 'c'.repeat(64), migratedAt: '' },
          alreadyImported: false,
        }),
        stat: async () => null,
      },
      board: {
        get: () => ({ board: { ...content, schemaVersion: 1, projectId: 'p', revision, updatedAt: 0, updatedBy: null, viewport: null } }),
        applyOps: async (input) => {
          const ops = typeof input.ops === 'function' ? input.ops(content, revision) : input.ops;
          applied.push([...ops]);
          revision += 1;
          return { ok: true, value: { revision, updatedAt: 0, results: [], changes: { fromRevision: revision - 1, toRevision: revision, upsertNodes: [], removeNodeIds: [], upsertEdges: [], removeEdgeIds: [] }, inverse: [{ op: 'restore', nodes: [], edges: [], removeNodeIds: [], removeEdgeIds: [] }] } };
        },
      },
      warn: () => undefined,
    };
    const ids = Array.from({ length: count }, (_, index) => `doc-${index}`);
    return { deps, applied, ids, revision: () => revision };
  }

  it('keeps every batch within the op cap and reports not-found documents', async () => {
    const { deps, applied, ids } = fakes(DESIGN_IMPORT_DOCUMENTS_PER_BATCH + 5);
    const result = await importDesignCanvasIntoBoard(deps, { projectId: 'p', documentIds: [...ids, 'gone', 'broken'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applied).toHaveLength(2);
    for (const ops of applied) expect(ops.length).toBeLessThanOrEqual(BOARD_LIMITS.maxOpsPerPatch);
    expect(result.value.results).toHaveLength(ids.length + 2);
    expect(result.value.results.filter((entry) => entry.status === 'imported')).toHaveLength(ids.length);
    expect(result.value.results.slice(-2)).toEqual([
      { documentId: 'gone', status: 'not-found' },
      { documentId: 'broken', status: 'invalid' },
    ]);
    // Two batches: no single change set.
    expect(result.value.changes).toBeNull();
  });

  it('reads the revision without committing when nothing can be imported', async () => {
    const { deps, applied, revision } = fakes(0);
    const result = await importDesignCanvasIntoBoard(deps, { projectId: 'p', documentIds: ['gone'] });
    expect(applied).toEqual([]);
    expect(result).toEqual({ ok: true, value: { revision: revision(), results: [{ documentId: 'gone', status: 'not-found' }], changes: null } });
  });
});

describe('board import route (HTTP) and od board import-canvas', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectId = 'proj-designs-board-import';

  function dataDir(): string {
    const dir = process.env.OD_DATA_DIR;
    if (!dir) throw new Error('OD_DATA_DIR is required');
    return dir;
  }

  async function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
    const response = await fetch(url, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function seedLegacy(id: string, name: string, bytes: Buffer): Promise<void> {
    const seeded = await call('PUT', `${baseUrl}/api/design-canvas/documents/${id}`, legacyInput(name, bytes));
    expect(seeded.status).toBe(200);
  }

  function importCanvas(body: unknown, id = projectId) {
    return call('POST', `${baseUrl}/api/projects/${id}/board/import-design-canvas`, body);
  }

  async function board(): Promise<{ revision: number; nodes: BoardNode[] }> {
    const result = await call('GET', `${baseUrl}/api/projects/${projectId}/board`);
    expect(result.status).toBe(200);
    return result.body.board;
  }

  async function openProjectEvents(): Promise<{ events: Array<{ event: string; data: any }>; close: () => void }> {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/events`, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
    expect(response.ok).toBe(true);
    const events: Array<{ event: string; data: any }> = [];
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
            const raw = /^data:\s*(.*)$/m.exec(frame)?.[1];
            if (name) {
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
    const created = await call('POST', `${baseUrl}/api/projects`, { id: projectId, name: projectId });
    expect(created.status).toBe(200);
  });

  afterAll(async () => {
    closeDatabase();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('imports documents as design nodes with migratedFrom, idempotently, and emits board-changed', async () => {
    const posterBytes = await makeFig({ canvas: 'bi-poster' });
    const landingBytes = await makeFig({ canvas: 'bi-landing' });
    await seedLegacy('bi-poster', 'Poster', posterBytes);
    await seedLegacy('bi-landing', 'Landing', landingBytes);
    const legacyFile = path.join(dataDir(), 'design-canvas', 'bi-poster.json');
    const legacyBefore = await readFile(legacyFile);
    const before = await board();
    const stream = await openProjectEvents();
    try {
      const first = await importCanvas({ documentIds: ['bi-poster', 'bi-landing', 'bi-unknown'] });
      expect(first.status).toBe(200);
      expect(first.body.revision).toBe(before.revision + 1);
      expect(first.body.results).toEqual([
        { documentId: 'bi-poster', status: 'imported', path: 'designs/Poster.fig', nodeId: stableBoardId('n', `design-canvas:bi-poster:${sha256(posterBytes)}`) },
        { documentId: 'bi-landing', status: 'imported', path: 'designs/Landing.fig', nodeId: stableBoardId('n', `design-canvas:bi-landing:${sha256(landingBytes)}`) },
        { documentId: 'bi-unknown', status: 'not-found' },
      ]);
      expect(first.body.changes.upsertNodes.length).toBeGreaterThanOrEqual(3);
      await waitFor(() => stream.events.some((event) => event.event === 'board-changed' && event.data?.reason === 'import'));
    } finally {
      stream.close();
    }

    const doc = await board();
    const designs = doc.nodes.filter((node): node is BoardDesignNode => node.kind === 'design' && node.migratedFrom?.documentId?.startsWith('bi-') === true);
    expect(designs).toHaveLength(2);
    const group = doc.nodes.find((node) => node.id === designs[0]!.parentId) as BoardGroupNode;
    expect(group).toMatchObject({ kind: 'group', role: 'section', sectionKind: 'design', layout: 'row' });
    expect(designs.every((node) => node.parentId === group.id)).toBe(true);
    expect(designs.find((node) => node.ref.path === 'designs/Poster.fig')).toMatchObject({
      format: 'fig',
      migratedFrom: { store: 'design-canvas', documentId: 'bi-poster', sha256: sha256(posterBytes) },
      origin: { source: 'migration' },
    });
    expect(await readFile(path.join(dataDir(), 'projects', projectId, 'designs', 'Poster.fig'))).toEqual(posterBytes);

    const again = await importCanvas({ documentIds: ['bi-poster', 'bi-landing'] });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ revision: doc.revision, changes: null });
    expect(again.body.results.map((entry: { status: string }) => entry.status)).toEqual(['already-imported', 'already-imported']);
    expect((await board()).revision).toBe(doc.revision);
    // The legacy store is only read.
    expect(await readFile(legacyFile)).toEqual(legacyBefore);
  });

  it('suffixes colliding names, honours the placement and repairs a node whose file was deleted', async () => {
    // A project design already uses the name: the import becomes `-2`.
    const existing = await makeFig({ canvas: 'bi-existing' });
    const put = await fetch(`${baseUrl}/api/projects/${projectId}/designs/content?path=${encodeURIComponent('designs/Hero.fig')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'if-none-match': '*' },
      body: new Uint8Array(existing),
    });
    expect(put.status).toBe(201);
    const heroBytes = await makeFig({ canvas: 'bi-hero' });
    await seedLegacy('bi-hero', 'Hero', heroBytes);
    const imported = await importCanvas({ documentIds: ['bi-hero'], placement: { mode: 'at', x: 50_000, y: 60_000 } });
    expect(imported.status).toBe(200);
    expect(imported.body.results[0]).toMatchObject({ status: 'imported', path: 'designs/Hero-2.fig' });
    const nodeId = imported.body.results[0].nodeId as string;
    const node = (await board()).nodes.find((entry) => entry.id === nodeId)!;
    expect(node).toMatchObject({ x: 50_000, y: 60_000, kind: 'design' });
    expect(node.parentId).toBeUndefined();

    // The imported file is deleted by hand: a new import re-creates it and keeps the node.
    await rm(path.join(dataDir(), 'projects', projectId, 'designs', 'Hero-2.fig'));
    const repaired = await importCanvas({ documentIds: ['bi-hero'] });
    expect(repaired.status).toBe(200);
    expect(repaired.body.results[0]).toMatchObject({ status: 'imported', nodeId, path: 'designs/Hero-2.fig' });
    expect(await readFile(path.join(dataDir(), 'projects', projectId, 'designs', 'Hero-2.fig'))).toEqual(heroBytes);
    expect((await board()).nodes.filter((entry) => entry.kind === 'design' && entry.migratedFrom?.documentId === 'bi-hero')).toHaveLength(1);
  });

  it('re-imports a document deleted through the API with a live identity, so the next sync keeps the node', async () => {
    const bytes = await makeFig({ canvas: 'bi-tomb' });
    await seedLegacy('bi-tomb', 'Tomb', bytes);
    const first = await importCanvas({ documentIds: ['bi-tomb'] });
    expect(first.status).toBe(200);
    const nodeId = first.body.results[0].nodeId as string;
    const before = (await board()).nodes.find((node) => node.id === nodeId) as BoardDesignNode;
    expect(before.ref.workspaceArtifactId).toBeTruthy();
    // The file delete route tombstones the file's workspace identity.
    const deleted = await call('DELETE', `${baseUrl}/api/projects/${projectId}/files/${encodeURIComponent('designs/Tomb.fig')}`);
    expect(deleted.status).toBe(200);
    const again = await importCanvas({ documentIds: ['bi-tomb'] });
    expect(again.body.results[0]).toMatchObject({ status: 'imported', nodeId, path: 'designs/Tomb.fig' });
    const repaired = (await board()).nodes.find((node) => node.id === nodeId) as BoardDesignNode;
    expect(repaired.ref.workspaceArtifactId).toBeTruthy();
    expect(repaired.ref.workspaceArtifactId).not.toBe(before.ref.workspaceArtifactId);
    const synced = await call('POST', `${baseUrl}/api/projects/${projectId}/board/sync`, { reason: 'manual' });
    expect(synced.status).toBe(200);
    expect((await board()).nodes.some((node) => node.id === nodeId)).toBe(true);
  });

  it('validates the request and the project', async () => {
    const empty = await importCanvas({ documentIds: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');
    expect((await importCanvas({ documentIds: ['../x'] })).status).toBe(400);
    const unknownProject = await importCanvas({ documentIds: ['bi-poster'] }, 'proj-designs-board-missing');
    expect(unknownProject.status).toBe(404);
    expect(unknownProject.body.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('serves od board import-canvas', async () => {
    const cliBytes = await makeFig({ canvas: 'bi-cli' });
    await seedLegacy('bi-cli', 'From CLI', cliBytes);
    let stdout = '';
    let stderr = '';
    const io = { stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; }, readStdin: async () => '' };
    const first = await runBoardCli(['import-canvas', 'bi-cli', '--project', projectId, '--daemon-url', baseUrl, '--json'], io, {});
    expect(stderr).toBe('');
    expect(first.exitCode).toBe(0);
    const response = JSON.parse(stdout);
    expect(response.results).toEqual([
      { documentId: 'bi-cli', status: 'imported', path: 'designs/From-CLI.fig', nodeId: stableBoardId('n', `design-canvas:bi-cli:${sha256(cliBytes)}`) },
    ]);
    stdout = '';
    const second = await runBoardCli(['import-canvas', 'bi-cli', '--project', projectId, '--daemon-url', baseUrl, '--json'], io, {});
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(stdout).results[0].status).toBe('already-imported');
  });
});
