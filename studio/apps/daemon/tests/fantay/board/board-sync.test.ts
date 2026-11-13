import type http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyBoardChangeSet,
  emptyBoardDocument,
  stableBoardId,
  type BoardDocument,
  type BoardGroupNode,
  type BoardNode,
  type BoardSyncResponse,
} from '@open-design/contracts';

import { startServer } from '../../../src/server.js';
import { closeDatabase, openDatabase } from '../../../src/db.js';
import { insertMediaTask, updateMediaTask } from '../../../src/media/tasks.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe('board chat sync', () => {
  let server: http.Server;
  let baseUrl: string;
  let messageCounter = 0;

  function dataDir(): string {
    const dir = process.env.OD_DATA_DIR;
    if (!dir) throw new Error('OD_DATA_DIR is required');
    return dir;
  }

  function db() {
    return openDatabase(dataDir(), { dataDir: dataDir() });
  }

  async function createProject(id: string): Promise<void> {
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: id }),
    });
    expect(created.status).toBe(200);
  }

  async function writeProjectFile(projectId: string, name: string, content: string | Buffer = '<!doctype html><p>x</p>'): Promise<void> {
    const file = path.join(dataDir(), 'projects', projectId, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  async function sync(projectId: string, body: Record<string, unknown> = { reason: 'manual' }): Promise<BoardSyncResponse> {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/board/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(200);
    return json as BoardSyncResponse;
  }

  async function board(projectId: string): Promise<BoardDocument> {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/board?include=sync`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { board: BoardDocument }).board;
  }

  function nodeFor(doc: BoardDocument, filePath: string): BoardNode | undefined {
    return doc.nodes.find((node) => 'ref' in node && node.ref?.path === filePath);
  }

  function conversation(projectId: string): string {
    const id = `conv-${projectId}`;
    db().prepare(
      `INSERT OR IGNORE INTO conversations (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(id, projectId, Date.now(), Date.now());
    return id;
  }

  /** A user prompt plus a finished assistant turn that produced `files`. */
  function turn(projectId: string, files: string[], opts: { createdAt?: number; prompt?: string; runId?: string } = {}): string {
    const conversationId = conversation(projectId);
    messageCounter += 2;
    const createdAt = opts.createdAt ?? Date.now();
    const userId = `msg-user-${messageCounter}`;
    const assistantId = `msg-assistant-${messageCounter}`;
    db().prepare(
      `INSERT INTO messages (id, conversation_id, role, content, position, created_at) VALUES (?, ?, 'user', ?, ?, ?)`,
    ).run(userId, conversationId, opts.prompt ?? 'Design it', messageCounter - 1, createdAt - 1);
    db().prepare(
      `INSERT INTO messages (id, conversation_id, role, content, position, created_at, produced_files_json, run_id, run_status)
       VALUES (?, ?, 'assistant', 'done', ?, ?, ?, ?, 'succeeded')`,
    ).run(
      assistantId,
      conversationId,
      messageCounter,
      createdAt,
      JSON.stringify(files.map((name) => ({ name, path: name, type: 'file', size: 1, mtime: createdAt }))),
      opts.runId ?? `run-${messageCounter}`,
    );
    return assistantId;
  }

  async function patch(projectId: string, ops: unknown[]): Promise<void> {
    const current = await board(projectId);
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/board`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: current.revision, ops }),
    });
    expect(response.status).toBe(200);
  }

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as { url: string; server: http.Server };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    closeDatabase();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('seeds existing files into section groups on the first sync, then reports changed:false', async () => {
    const projectId = 'proj-sync-seed';
    await createProject(projectId);
    await writeProjectFile(projectId, 'index.html');
    await writeProjectFile(projectId, 'about.html');
    await writeProjectFile(projectId, 'designs/poster.fig', Buffer.from('fig'));
    await writeProjectFile(projectId, 'hero.png', PNG);
    await writeProjectFile(projectId, 'pages/deep.html');
    const first = await sync(projectId, { reason: 'open' });
    expect(first.changed).toBe(true);
    const doc = await board(projectId);
    const sections = doc.nodes.filter((node): node is BoardGroupNode => node.kind === 'group' && node.role === 'section');
    expect(sections.map((group) => group.sectionKind)).toEqual(['frame', 'design', 'image']);
    expect(nodeFor(doc, 'index.html')!.parentId).toBe(stableBoardId('n', 'section:frame'));
    expect((nodeFor(doc, 'index.html') as { ref: { workspaceArtifactId?: string } }).ref.workspaceArtifactId).toEqual(expect.any(String));
    expect(nodeFor(doc, 'pages/deep.html')).toBeUndefined();
    expect(doc.sync!.seededAt).toEqual(expect.any(Number));
    const second = await sync(projectId);
    expect(second).toMatchObject({ changed: false, changes: null, revision: first.revision });
  });

  it('commits a first sync that needs more ops than one PATCH may carry (long chat history) in one revision', async () => {
    const projectId = 'proj-sync-large';
    await createProject(projectId);
    // 18 finished turns with 12 pages each under pages/ (not seeded): 18 × (12 frames + 1 turn group) = 234 ops.
    const base = Date.now() - 3_600_000;
    for (let index = 0; index < 18; index += 1) {
      const files = Array.from({ length: 12 }, (_, page) => `pages/t${index}-p${page}.html`);
      for (const file of files) await writeProjectFile(projectId, file);
      turn(projectId, files, { createdAt: base + index * 1_000 });
    }
    const first = await sync(projectId, { reason: 'open' });
    expect(first).toMatchObject({ changed: true, revision: 1 });
    expect(first.changes!.upsertNodes).toHaveLength(18 * 13);
    const doc = await board(projectId);
    expect(doc.revision).toBe(1);
    expect(doc.nodes.filter((node) => node.kind === 'frame')).toHaveLength(18 * 12);
    expect(doc.nodes.filter((node) => node.kind === 'group' && node.role === 'turn')).toHaveLength(18);
    expect(doc.sync!.seededAt).toEqual(expect.any(Number));
    // The single change set a client applies reproduces the stored board.
    expect(applyBoardChangeSet(emptyBoardDocument(projectId), first.changes!).nodes).toEqual(doc.nodes);
    expect((await sync(projectId)).changed).toBe(false);
  });

  it('places a turn of three explicit variant files as one variants row inside a turn group', async () => {
    const projectId = 'proj-sync-variants';
    await createProject(projectId);
    await sync(projectId, { reason: 'open' });
    for (const label of ['a', 'b', 'c']) await writeProjectFile(projectId, `landing.variant-${label}.html`);
    turn(projectId, ['landing.variant-a.html', 'landing.variant-b.html', 'landing.variant-c.html'], { prompt: '## Three **landing** options' });
    const result = await sync(projectId, { reason: 'run-finished' });
    expect(result.changed).toBe(true);
    const doc = await board(projectId);
    const rows = doc.nodes.filter((node): node is BoardGroupNode => node.kind === 'group' && node.role === 'variants');
    const turns = doc.nodes.filter((node): node is BoardGroupNode => node.kind === 'group' && node.role === 'turn');
    expect(rows).toHaveLength(1);
    expect(turns).toHaveLength(1);
    expect(rows[0]!.parentId).toBe(turns[0]!.id);
    expect(turns[0]!.title).toBe('Three landing options');
    expect(doc.nodes.filter((node) => node.parentId === rows[0]!.id).map((node) => node.variantLabel).sort()).toEqual(['a', 'b', 'c']);
    expect(result.placements.filter((entry) => entry.status === 'created' && entry.path)).toHaveLength(3);
    expect((await sync(projectId)).changed).toBe(false);
  });

  it('places only the frame of a turn that produced index.html plus hero.png', async () => {
    const projectId = 'proj-sync-rank';
    await createProject(projectId);
    await sync(projectId, { reason: 'open' });
    await writeProjectFile(projectId, 'index.html');
    await writeProjectFile(projectId, 'hero.png', PNG);
    turn(projectId, ['index.html', 'hero.png', 'missing-file.html']);
    await sync(projectId, { reason: 'run-finished' });
    const doc = await board(projectId);
    expect(nodeFor(doc, 'index.html')?.kind).toBe('frame');
    expect(nodeFor(doc, 'hero.png')).toBeUndefined();
    expect(nodeFor(doc, 'missing-file.html')).toBeUndefined();
  });

  it('turns batch media tasks into placeholders and then into file refs', async () => {
    const projectId = 'proj-sync-media';
    await createProject(projectId);
    await sync(projectId, { reason: 'open' });
    const startedAt = Date.now();
    insertMediaTask(db(), { id: 'task-media-1', projectId, runId: 'run-media', status: 'running', surface: 'image', startedAt, progress: ['rendering'] });
    insertMediaTask(db(), { id: 'task-media-2', projectId, runId: 'run-media', status: 'queued', surface: 'image', startedAt: startedAt + 1 });
    await sync(projectId, { reason: 'media' });
    let doc = await board(projectId);
    const row = doc.nodes.find((node) => node.id === stableBoardId('n', 'batch:task-media-1'))!;
    expect(row).toMatchObject({ kind: 'group', role: 'variants', variantKey: 'batch:task-media-1' });
    const first = doc.nodes.find((node) => node.id === stableBoardId('n', 'media:task-media-1'))!;
    expect(first).toMatchObject({ kind: 'image', ref: null, parentId: row.id, pending: { mediaTaskId: 'task-media-1', status: 'running', progress: 'rendering' } });
    expect(doc.sync!.mediaTasks).toMatchObject({ 'task-media-1': first.id });

    await writeProjectFile(projectId, 'gen-1.png', PNG);
    updateMediaTask(db(), 'task-media-1', { status: 'done', file: { name: 'gen-1.png' }, endedAt: startedAt + 5_000 });
    await sync(projectId, { reason: 'media' });
    doc = await board(projectId);
    const done = doc.nodes.find((node) => node.id === first.id)!;
    expect(done).toMatchObject({ ref: { path: 'gen-1.png' }, autoSize: true });
    expect(done).not.toHaveProperty('pending');
    expect(doc.nodes.find((node) => node.id === stableBoardId('n', 'media:task-media-2'))).toMatchObject({ pending: { status: 'queued' } });
  });

  it('follows API renames and removes nodes of API-deleted files', async () => {
    const projectId = 'proj-sync-files';
    await createProject(projectId);
    await writeProjectFile(projectId, 'old.html');
    await writeProjectFile(projectId, 'gone.html');
    await sync(projectId, { reason: 'open' });
    const before = await board(projectId);
    const renamedId = nodeFor(before, 'old.html')!.id;
    const deletedId = nodeFor(before, 'gone.html')!.id;

    const rename = await fetch(`${baseUrl}/api/projects/${projectId}/files/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'old.html', to: 'new.html' }),
    });
    expect(rename.status).toBe(200);
    const remove = await fetch(`${baseUrl}/api/projects/${projectId}/files/gone.html`, { method: 'DELETE' });
    expect(remove.status).toBe(200);

    const result = await sync(projectId, { reason: 'files-changed' });
    const doc = await board(projectId);
    expect(doc.nodes.find((node) => node.id === renamedId)).toMatchObject({ ref: { path: 'new.html' } });
    expect(doc.nodes.find((node) => node.id === deletedId)).toBeUndefined();
    expect(result.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: renamedId, status: 'updated', path: 'new.html' }),
      expect.objectContaining({ nodeId: deletedId, status: 'removed' }),
    ]));
  });

  it('does not re-add a removed node from an older turn, but a newer turn brings it back', async () => {
    const projectId = 'proj-sync-dismiss';
    await createProject(projectId);
    await sync(projectId, { reason: 'open' });
    await writeProjectFile(projectId, 'promo.html');
    turn(projectId, ['promo.html'], { createdAt: Date.now() - 60_000 });
    await sync(projectId, { reason: 'run-finished' });
    const placed = nodeFor(await board(projectId), 'promo.html')!;
    await patch(projectId, [{ op: 'remove', ids: [placed.id] }]);
    expect((await board(projectId)).sync!.dismissed).toHaveProperty('promo.html');

    const older = await sync(projectId, { reason: 'manual' });
    expect(older.changed).toBe(false);
    expect(nodeFor(await board(projectId), 'promo.html')).toBeUndefined();

    turn(projectId, ['promo.html'], { createdAt: Date.now() + 1_000 });
    const newer = await sync(projectId, { reason: 'run-finished' });
    expect(newer.changed).toBe(true);
    const doc = await board(projectId);
    expect(nodeFor(doc, 'promo.html')).toBeDefined();
    expect(doc.sync!.dismissed).not.toHaveProperty('promo.html');
  });

  it('focuses a live artifact frame and reports unplaceable names', async () => {
    const projectId = 'proj-sync-focus';
    await createProject(projectId);
    await sync(projectId, { reason: 'open' });
    await writeProjectFile(projectId, 'README.md', '# readme');
    const result = await sync(projectId, {
      reason: 'focus',
      focus: { names: ['live:la-board-test', 'README.md'], primary: 'live:la-board-test' },
    });
    const liveId = stableBoardId('n', 'live:la-board-test');
    expect(result.focus).toEqual({ nodeIds: [liveId], primaryNodeId: liveId });
    expect(result.unplaceable).toEqual(['README.md']);
    expect((await board(projectId)).nodes.find((node) => node.id === liveId)).toMatchObject({ kind: 'frame', ref: null, liveArtifactId: 'la-board-test' });
    const again = await sync(projectId, { reason: 'focus', focus: { names: ['live:la-board-test'] } });
    expect(again).toMatchObject({ changed: false, focus: { nodeIds: [liveId], primaryNodeId: liveId } });
  });

  it('places the declared paths of a running turn that is not stored yet', async () => {
    const projectId = 'proj-sync-running';
    await createProject(projectId);
    await sync(projectId, { reason: 'open' });
    const conversationId = conversation(projectId);
    await writeProjectFile(projectId, 'draft.html');
    const result = await sync(projectId, {
      reason: 'run-started',
      conversationId,
      turn: { conversationId, messageId: 'msg-not-stored-yet', status: 'running', paths: ['draft.html', 'not-written.html'] },
    });
    expect(result.placements).toEqual([expect.objectContaining({ status: 'created', path: 'draft.html' })]);
    const doc = await board(projectId);
    expect(nodeFor(doc, 'draft.html')!.origin).toMatchObject({ source: 'chat-turn', messageId: 'msg-not-stored-yet', conversationId });
    expect(doc.sync!.turns['msg-not-stored-yet']).toMatchObject({ status: 'running' });
    // A hint for a conversation of another project is ignored.
    const foreign = await sync(projectId, {
      reason: 'run-started',
      turn: { conversationId: 'conv-proj-sync-seed', messageId: 'msg-foreign', status: 'running', paths: ['draft.html'] },
    });
    expect(foreign.changed).toBe(false);
  });
});
