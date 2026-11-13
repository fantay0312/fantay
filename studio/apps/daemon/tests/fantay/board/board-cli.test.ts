// SPDX-License-Identifier: Apache-2.0
// Contract test for `od board` (spec 04 §5, amendments B7/C8): the CLI drives the same
// /api/projects/:id/board* endpoints as the workspace, with --json, --prompt-file <path|->,
// structured errors and the board exit codes.
//
// A stub HTTP server captures requests (pattern of tests/materials-cli.test.ts). Most cases call
// `runBoardCli` in-process; one spawn of `src/cli.ts board --help` through tsx proves the
// SUBCOMMAND_MAP routing.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BOARD_EXIT_CODES, BOARD_SUBCOMMANDS, BOARD_USAGE } from '../../../src/fantay/board/board-cli-help.js';
import { runBoardCli, type BoardCliDeps, type BoardCliIo } from '../../../src/fantay/board/board-cli.js';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = path.resolve(here, '../../..');
const REPO_ROOT = path.resolve(DAEMON_ROOT, '../..');
const CLI_SRC = path.join(DAEMON_ROOT, 'src/cli.ts');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface Captured {
  method: string;
  url: string;
  path: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}
interface StubResponse {
  status: number;
  body: unknown;
}

let server: http.Server;
let baseUrl: string;
let unreachableUrl: string;
const requests: Captured[] = [];
let responder: (req: Captured) => StubResponse = () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'no stub' } } });
const tempDirs: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      const captured: Captured = { method: req.method ?? '', url, path: url.split('?')[0]!, body: raw, headers: req.headers };
      requests.push(captured);
      const response = responder(captured);
      res.statusCode = response.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no stub address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const probeAddress = probe.address();
  if (!probeAddress || typeof probeAddress === 'string') throw new Error('no probe address');
  unreachableUrl = `http://127.0.0.1:${probeAddress.port}`;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  responder = () => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'no stub' } } });
});

function memoryIo(stdin = ''): BoardCliIo & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
    readStdin: async () => stdin,
  };
  return io;
}

/** Env of a run with no project, workspace or agent run: the daemon URL only. */
function cliEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { OD_DAEMON_URL: baseUrl, ...extra };
}

function run(args: string[], options: { stdin?: string; env?: NodeJS.ProcessEnv; deps?: BoardCliDeps } = {}) {
  const io = memoryIo(options.stdin ?? '');
  return runBoardCli(args, io, options.env ?? cliEnv(), options.deps ?? {}).then((result) => ({ ...result, io }));
}

function jsonBody(req: Captured | undefined): Record<string, unknown> {
  if (!req) throw new Error('missing request');
  return JSON.parse(req.body) as Record<string, unknown>;
}

function stderrError(io: { err: string }): { code: string; message: string; data: Record<string, unknown> } {
  return (JSON.parse(io.err.trim()) as { error: { code: string; message: string; data: Record<string, unknown> } }).error;
}

const actorStamp = { kind: 'user' as const };
function stamped(node: Record<string, unknown>): Record<string, unknown> {
  return { createdAt: 1, updatedAt: 1, createdBy: actorStamp, updatedBy: actorStamp, ...node };
}

/** A board as `GET /board` returns it: a frame, a section group with a note, a generator and a pending image. */
function fixtureBoard(revision = 7, projectId = 'p1') {
  return {
    schemaVersion: 1,
    projectId,
    revision,
    updatedAt: 1,
    updatedBy: null,
    viewport: null,
    settings: { background: 'dots', autoPlace: true },
    title: 'Landing',
    nodes: [
      stamped({ id: 'n_frame1', kind: 'frame', x: 0, y: 0, w: 1440, h: 900, ref: { path: 'index.html' }, device: 'desktop', rev: 2 }),
      stamped({ id: 'n_group1', kind: 'group', x: 1600, y: -52, w: 328, h: 296, role: 'section', layout: 'free', rev: 3 }),
      stamped({ id: 'n_note1', kind: 'note', x: 1624, y: 0, w: 280, h: 220, text: '把按钮\n做大', parentId: 'n_group1', variantLabel: 'a', rev: 5 }),
      stamped({ id: 'n_gen1', kind: 'generator', x: 0, y: 1100, w: 320, h: 272, version: 1, surface: 'image', prompt: 'a red bike', model: null, params: { aspect: '1:1', count: 2 }, runs: [], rev: 6 }),
      stamped({ id: 'n_img1', kind: 'image', x: 400, y: 1100, w: 640, h: 640, ref: null, pending: { mediaTaskId: 't1', status: 'running' }, rev: 4 }),
    ],
    edges: [
      { id: 'e_ref1', kind: 'lineage', from: 'n_frame1', to: 'n_note1', createdAt: 1, createdBy: actorStamp, updatedBy: actorStamp, rev: 5 },
      { id: 'e_out1', kind: 'output', from: 'n_gen1', to: 'n_img1', createdAt: 2, createdBy: actorStamp, updatedBy: actorStamp, rev: 6 },
    ],
  };
}

function patchResponse(revision: number, ids: string[], status: 'applied' | 'skipped' = 'applied', reason?: 'exists' | 'missing' | 'noop') {
  return {
    revision,
    updatedAt: 2,
    results: [{ index: 0, status, ...(reason ? { reason } : {}), ids }],
    changes: { fromRevision: revision - 1, toRevision: revision, upsertNodes: [], removeNodeIds: [], upsertEdges: [], removeEdgeIds: [] },
    inverse: [],
  };
}

/** Routes `METHOD /path` to a handler; anything else is a 404 the test would notice. */
function routes(table: Record<string, (req: Captured) => StubResponse>): (req: Captured) => StubResponse {
  return (req) => table[`${req.method} ${req.path}`]?.(req) ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: `no stub for ${req.method} ${req.url}` } } };
}

const BOARD = '/api/projects/p1/board';

describe('od board show', () => {
  it('syncs, then reads the board and prints one line per node', async () => {
    responder = routes({
      [`POST ${BOARD}/sync`]: () => ({ status: 200, body: { revision: 7, changed: false, changes: null, placements: [], focus: null, unplaceable: [] } }),
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
    });
    const { exitCode, io } = await run(['show', '--project', 'p1']);
    expect(exitCode).toBe(0);
    expect(requests.map((req) => `${req.method} ${req.url}`)).toEqual([`POST ${BOARD}/sync`, `GET ${BOARD}`]);
    expect(jsonBody(requests[0])).toEqual({ reason: 'manual', actor: { kind: 'cli' } });
    expect(io.out.split('\n')).toEqual([
      'Board r7 · 5 nodes · 2 edges · project p1',
      'n_frame1\tframe\tindex.html\tx=0 y=0 1440×900',
      'n_group1\tgroup\tsection\tx=1600 y=-52 328×296',
      'n_note1\tnote\t把按钮 做大\tx=1624 y=0 280×220\t[in n_group1] [variant a]',
      'n_gen1\tgenerator\ta red bike\tx=0 y=1100 320×272',
      'n_img1\timage\t-\tx=400 y=1100 640×640\t[pending running]',
      '',
    ]);
    expect(io.err).toBe('');
  });

  it('--no-sync reads only; --include-sync asks for the ledger; --json prints the response', async () => {
    const body = { board: fixtureBoard(7) };
    responder = routes({ [`GET ${BOARD}`]: () => ({ status: 200, body }) });
    const { exitCode, io } = await run(['show', '--project', 'p1', '--no-sync', '--include-sync', '--json']);
    expect(exitCode).toBe(0);
    expect(requests.map((req) => `${req.method} ${req.url}`)).toEqual([`GET ${BOARD}?include=sync`]);
    expect(io.out).toBe(`${JSON.stringify(body, null, 2)}\n`);
  });

  it('a 403 from sync falls back to the stored board silently', async () => {
    responder = routes({
      [`POST ${BOARD}/sync`]: () => ({ status: 403, body: { error: { code: 'FORBIDDEN', message: 'viewer' } } }),
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
    });
    const { exitCode, io } = await run(['show', '--project', 'p1']);
    expect(exitCode).toBe(0);
    expect(io.err).toBe('');
    expect(io.out.startsWith('Board r7 · 5 nodes')).toBe(true);
  });

  it('--node and --kind filter the nodes (and keep their edges) in --json output', async () => {
    responder = routes({ [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }) });
    const { exitCode, io } = await run(['show', '--project', 'p1', '--no-sync', '--node', 'n_note1', '--node', 'n_img1', '--json']);
    expect(exitCode).toBe(0);
    const { board } = JSON.parse(io.out) as { board: { revision: number; nodes: Array<{ id: string }>; edges: Array<{ id: string }> } };
    expect(board.revision).toBe(7);
    expect(board.nodes.map((node) => node.id)).toEqual(['n_note1', 'n_img1']);
    expect(board.edges.map((edge) => edge.id)).toEqual(['e_ref1', 'e_out1']);

    const byKind = await run(['show', '--project', 'p1', '--no-sync', '--kind', 'generator']);
    expect(byKind.io.out.trimEnd().split('\n')).toEqual(['Board r7 · 5 nodes · 2 edges · project p1', 'n_gen1\tgenerator\ta red bike\tx=0 y=1100 320×272']);
  });
});

describe('od board add', () => {
  it('add note --prompt-file - reads stdin and patches against the fetched revision', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(8, ['n_new1']) }),
    });
    const { exitCode, io } = await run(['add', 'note', '--prompt-file', '-', '--color', 'violet', '--project', 'p1'], { stdin: 'Hero 用大标题\n\n' });
    expect(exitCode).toBe(0);
    expect(requests.map((req) => req.method)).toEqual(['GET', 'PATCH']);
    expect(jsonBody(requests[1])).toEqual({
      baseRevision: 7,
      ops: [{ op: 'add', node: { kind: 'note', text: 'Hero 用大标题', color: 'violet' } }],
      actor: { kind: 'cli' },
    });
    expect(io.out).toBe('Added note n_new1 · board r8\n');
  });

  it('reads --prompt-file <path>, and maps placement, group, title, label, id and --if-absent', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(8, ['n_mine1'], 'skipped', 'exists') }),
    });
    const dir = mkdtempSync(path.join(tmpdir(), 'od-board-cli-'));
    tempDirs.push(dir);
    const promptFile = path.join(dir, 'note.md');
    writeFileSync(promptFile, '第一行\n第二行\n\n');
    const near = await run([
      'add', 'note', '--prompt-file', promptFile, '--near', 'n_frame1', '--side', 'below', '--group', 'n_group1',
      '--title', '备注', '--variant-label', 'b', '--id', 'n_mine1', '--if-absent', '--project', 'p1',
    ]);
    expect(near.exitCode).toBe(0);
    expect(jsonBody(requests[1]).ops).toEqual([{
      op: 'add',
      node: { kind: 'note', text: '第一行\n第二行', id: 'n_mine1', parentId: 'n_group1', title: '备注', variantLabel: 'b' },
      placement: { mode: 'near', nodeId: 'n_frame1', side: 'below' },
      ifAbsent: true,
    }]);
    expect(near.io.out).toBe('Nothing added · board r8\n  op 0 skipped (exists): n_mine1\n');

    requests.length = 0;
    await run(['add', 'frame', '--path', './pages/home.html', '--device', 'mobile', '--x', '10', '--y', '-20.5', '--project', 'p1']);
    expect(jsonBody(requests[1]).ops).toEqual([{ op: 'add', node: { kind: 'frame', ref: { path: 'pages/home.html' }, device: 'mobile', x: 10, y: -20.5 } }]);
  });

  it('builds generator drafts with the UI defaults and accepts image|video only (C8)', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(8, ['n_gen2']) }),
    });
    const video = await run(
      ['add', 'generator', '--surface', 'video', '--model', 'veo-3', '--prompt-file', '-', '--count', '2', '--aspect', '9:16', '--duration', '8', '--project', 'p1'],
      { stdin: '海边日落，慢镜头\n' },
    );
    expect(video.exitCode).toBe(0);
    expect(jsonBody(requests[1]).ops).toEqual([{
      op: 'add',
      node: {
        kind: 'generator', version: 1, surface: 'video', prompt: '海边日落，慢镜头', model: 'veo-3',
        params: { aspect: '9:16', count: 2, length: 8 }, runs: [],
      },
    }]);

    requests.length = 0;
    await run(['add', 'generator', '--surface', 'image', '--model', 'gpt-image-2', '--prompt', 'a red bike', '--quality', 'high', '--project', 'p1']);
    expect(jsonBody(requests[1]).ops).toEqual([{
      op: 'add',
      node: { kind: 'generator', version: 1, surface: 'image', prompt: 'a red bike', model: 'gpt-image-2', params: { aspect: '1:1', count: 2, quality: 'high' }, runs: [] },
    }]);

    requests.length = 0;
    const audio = await run(['add', 'generator', '--surface', 'audio', '--model', 'm', '--prompt', 'p', '--project', 'p1']);
    expect(audio.exitCode).toBe(BOARD_EXIT_CODES.usage);
    expect(stderrError(audio.io).message).toContain('--surface must be image or video');
    expect(requests).toHaveLength(0);
  });

  it('maps the other kinds onto contract drafts', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(8, ['n_x']) }),
    });
    const cases: Array<[string[], Record<string, unknown>]> = [
      [['frame', '--live-artifact', 'la_1'], { kind: 'frame', ref: null, liveArtifactId: 'la_1' }],
      [['web', '--url', 'https://example.com/a'], { kind: 'web', url: 'https://example.com/a' }],
      [['video', '--path', 'clips/intro.mp4'], { kind: 'video', ref: { path: 'clips/intro.mp4' } }],
      [['shape', '--shape', 'ellipse', '--text', 'Hi', '--fill', '#ff8800', '--stroke', 'none'], { kind: 'shape', shape: 'ellipse', text: 'Hi', fill: '#ff8800', stroke: 'none' }],
      [['group', '--role', 'variants', '--title', 'Options'], { kind: 'group', role: 'variants', title: 'Options' }],
      [['design', '--path', 'designs/Home.FIG'], { kind: 'design', ref: { path: 'designs/Home.FIG' }, format: 'fig' }],
      [['motion', '--movie', 'p_movie'], { kind: 'motion', source: { type: 'movie', projectId: 'p_movie' } }],
      [['motion', '--composition', 'motion-source/a/index.html', '--render', 'renders/a.mp4'], {
        kind: 'motion', source: { type: 'composition', ref: { path: 'motion-source/a/index.html' } }, render: { path: 'renders/a.mp4' },
      }],
    ];
    for (const [args, node] of cases) {
      requests.length = 0;
      const { exitCode } = await run(['add', ...args, '--project', 'p1']);
      expect(exitCode, args.join(' ')).toBe(0);
      expect(jsonBody(requests[1]).ops, args.join(' ')).toEqual([{ op: 'add', node }]);
    }
  });

  it('checks --group and --near against the fetched board', async () => {
    responder = routes({ [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }) });
    const notGroup = await run(['add', 'note', '--text', 'x', '--group', 'n_frame1', '--project', 'p1']);
    expect(notGroup.exitCode).toBe(BOARD_EXIT_CODES.usage);
    expect(stderrError(notGroup.io).message).toContain('not a group');
    const missing = await run(['add', 'note', '--text', 'x', '--near', 'n_gone', '--project', 'p1']);
    expect(missing.exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(missing.io).code).toBe('node-not-found');
    // A taken --id (node or edge) fails once instead of retrying a 409 `exists` into exit 72.
    for (const taken of ['n_note1', 'e_out1']) {
      const exists = await run(['add', 'note', '--text', 'x', '--id', taken, '--project', 'p1']);
      expect(exists.exitCode, taken).toBe(BOARD_EXIT_CODES.error);
      expect(stderrError(exists.io), taken).toMatchObject({ code: 'node-exists', data: { nodeId: taken } });
    }
    expect(requests.every((req) => req.method === 'GET')).toBe(true);
  });

  it('--if-absent sends a taken --id to the daemon, which skips it', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(7, ['n_note1'], 'skipped', 'exists') }),
    });
    const { exitCode, io } = await run(['add', 'note', '--text', 'x', '--id', 'n_note1', '--if-absent', '--project', 'p1']);
    expect(exitCode).toBe(0);
    expect(jsonBody(requests[1]).ops).toEqual([{ op: 'add', node: { kind: 'note', text: 'x', id: 'n_note1' }, ifAbsent: true }]);
    expect(io.out).toBe('Nothing added · board r7\n  op 0 skipped (exists): n_note1\n');
  });
});

describe('od board identity and env defaults', () => {
  const syncOk = () => routes({
    'POST /api/projects/p-env/board/sync': () => ({ status: 200, body: { revision: 1, changed: false, changes: null, placements: [], focus: null, unplaceable: [] } }),
    'POST /api/projects/p2/board/sync': () => ({ status: 200, body: { revision: 1, changed: false, changes: null, placements: [], focus: null, unplaceable: [] } }),
  });

  it('takes the project, the workspace pair and the agent actor from the run env', async () => {
    responder = syncOk();
    const env = cliEnv({ OD_PROJECT_ID: 'p-env', OD_WORKSPACE_ID: 'w1', OD_WORKSPACE_MEMBER_ID: 'm1', OD_STOCK_RUN_ID: 'run-42' });
    const { exitCode, io } = await run(['sync'], { env });
    expect(exitCode).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/projects/p-env/board/sync' });
    expect(requests[0]!.headers).toMatchObject({ 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'm1' });
    expect(jsonBody(requests[0])).toEqual({ reason: 'manual', actor: { kind: 'agent', runId: 'run-42' } });
    expect(io.out).toBe('Synced · board r1 · no changes · 0 placement(s)\n');
  });

  it('flags win over the env; empty workspace values and an empty run id mean none', async () => {
    responder = syncOk();
    const env = cliEnv({ OD_PROJECT_ID: 'p-env', OD_WORKSPACE_ID: 'w1', OD_WORKSPACE_MEMBER_ID: 'm1', OD_STOCK_RUN_ID: '' });
    expect((await run(['sync', '--project', 'p2', '--workspace', '', '--workspace-member', ''], { env })).exitCode).toBe(0);
    expect(requests[0]!.url).toBe('/api/projects/p2/board/sync');
    expect(requests[0]!.headers['x-od-workspace-id']).toBeUndefined();
    expect(jsonBody(requests[0]).actor).toEqual({ kind: 'cli' });
  });

  it('rejects an incomplete workspace pair from flags or env before any request', async () => {
    const fromFlags = await run(['sync', '--project', 'p1', '--workspace', 'w1']);
    expect(fromFlags.exitCode).toBe(BOARD_EXIT_CODES.usage);
    const fromEnv = await run(['sync'], { env: cliEnv({ OD_PROJECT_ID: 'p1', OD_WORKSPACE_ID: 'w1' }) });
    expect(fromEnv.exitCode).toBe(BOARD_EXIT_CODES.usage);
    expect(stderrError(fromEnv.io).message).toContain('OD_WORKSPACE_MEMBER_ID');
    expect(requests).toHaveLength(0);
  });

  it('exits 67 (missing-input) without a project id, before any request', async () => {
    const { exitCode, io } = await run(['show']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.missingInput);
    expect(stderrError(io).code).toBe('missing-input');
    expect(requests).toHaveLength(0);
  });
});

describe('od board edits', () => {
  it('move --dx/--dy computes absolute positions from the fetched nodes and sends expectRev', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(8, ['n_frame1', 'n_note1']) }),
    });
    const relative = await run(['move', 'n_frame1', 'n_note1', '--dx', '40', '--dy', '-10', '--project', 'p1']);
    expect(relative.exitCode).toBe(0);
    expect(jsonBody(requests[1])).toEqual({
      baseRevision: 7,
      ops: [{
        op: 'move',
        moves: [{ id: 'n_frame1', x: 40, y: -10 }, { id: 'n_note1', x: 1664, y: -10 }],
        expectRev: { n_frame1: 2, n_note1: 5 },
      }],
      actor: { kind: 'cli' },
    });
    expect(relative.io.out).toBe('Moved n_frame1, n_note1 · board r8\n');

    requests.length = 0;
    await run(['move', 'n_note1', 'n_frame1', '--x', '100', '--y', '200', '--project', 'p1']);
    // The first id lands on (x,y); the others keep their offset to it.
    expect((jsonBody(requests[1]).ops as Array<{ moves: unknown }>)[0]!.moves).toEqual([
      { id: 'n_note1', x: 100, y: 200 },
      { id: 'n_frame1', x: -1524, y: 200 },
    ]);

    requests.length = 0;
    const missing = await run(['move', 'n_gone', '--dx', '1', '--project', 'p1']);
    expect(missing.exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(missing.io)).toMatchObject({ code: 'node-not-found', data: { nodeId: 'n_gone' } });
    expect(requests.map((req) => req.method)).toEqual(['GET']);
  });

  it('update maps --text to a generator prompt, "none" clears, and --patch-file merges under the flags', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(8, ['n_gen1']) }),
    });
    const generator = await run(['update', 'n_gen1', '--text', 'a blue bike', '--locked', 'true', '--project', 'p1']);
    expect(generator.exitCode).toBe(0);
    expect(jsonBody(requests[1]).ops).toEqual([{ op: 'update', id: 'n_gen1', patch: { locked: true, prompt: 'a blue bike' }, expectRev: 6 }]);

    requests.length = 0;
    await run(['update', 'n_note1', '--patch-file', '-', '--variant-label', 'none', '--parent', 'none', '--w', '300', '--project', 'p1'], {
      stdin: JSON.stringify({ color: 'green', w: 999 }),
    });
    expect(jsonBody(requests[1]).ops).toEqual([{
      op: 'update', id: 'n_note1', patch: { color: 'green', w: 300, variantLabel: null, parentId: null }, expectRev: 5,
    }]);

    requests.length = 0;
    const frameText = await run(['update', 'n_frame1', '--text', 'x', '--project', 'p1']);
    expect(frameText.exitCode).toBe(BOARD_EXIT_CODES.usage);
    expect(requests.map((req) => req.method)).toEqual(['GET']);
  });

  it('remove, layout, connect, group and ungroup send the contract ops', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(8, ['n_x']) }),
    });
    const cases: Array<[string[], unknown]> = [
      [['remove', 'n_note1', 'n_gone', '--cascade'], { op: 'remove', ids: ['n_note1', 'n_gone'], cascade: true, expectRev: { n_note1: 5 } }],
      [['layout', '--group', 'n_group1', '--mode', 'grid', '--gap', '24', '--columns', '3'], { op: 'layout', target: { groupId: 'n_group1' }, mode: 'grid', gap: 24, columns: 3 }],
      [['layout', '--nodes', 'n_frame1, n_gen1'], { op: 'layout', target: { ids: ['n_frame1', 'n_gen1'] }, mode: 'tidy' }],
      [['layout', '--all', '--mode', 'row'], { op: 'layout', target: { all: true }, mode: 'row' }],
      [['connect', 'n_note1', 'n_gen1', '--kind', 'reference', '--label', 'style'], { op: 'connect', edge: { kind: 'reference', from: 'n_note1', to: 'n_gen1', label: 'style' }, ifAbsent: true }],
      [['connect', 'n_frame1', 'n_img1'], { op: 'connect', edge: { kind: 'lineage', from: 'n_frame1', to: 'n_img1' }, ifAbsent: true }],
      [['group', 'n_frame1', 'n_gen1', '--title', 'Hero'], { op: 'group', ids: ['n_frame1', 'n_gen1'], group: { role: 'section', title: 'Hero' } }],
      [['ungroup', 'n_group1'], { op: 'ungroup', id: 'n_group1', expectRev: 3 }],
    ];
    for (const [args, op] of cases) {
      requests.length = 0;
      const { exitCode, io } = await run([...args, '--project', 'p1']);
      expect(exitCode, `${args.join(' ')}: ${io.err}`).toBe(0);
      expect(requests.map((req) => req.method), args.join(' ')).toEqual(['GET', 'PATCH']);
      expect(jsonBody(requests[1]), args.join(' ')).toEqual({ baseRevision: 7, ops: [op], actor: { kind: 'cli' } });
    }
  });

  it('connect is idempotent: an existing edge comes back skipped, exit 0, no retry', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(7, ['e_out1'], 'skipped', 'exists') }),
    });
    const { exitCode, io } = await run(['connect', 'n_gen1', 'n_img1', '--kind', 'output', '--project', 'p1']);
    expect(exitCode).toBe(0);
    expect(requests.map((req) => req.method)).toEqual(['GET', 'PATCH']);
    expect(jsonBody(requests[1]).ops).toEqual([{ op: 'connect', edge: { kind: 'output', from: 'n_gen1', to: 'n_img1' }, ifAbsent: true }]);
    expect(io.out).toBe('Edge n_gen1 → n_img1 (output) already exists · board r7\n  op 0 skipped (exists): e_out1\n');
  });

  it('apply sends the given ops (BoardOp[] or {ops}) with the fetched revision', async () => {
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(12) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 200, body: patchResponse(13, ['n_frame1']) }),
    });
    const ops = [{ op: 'set-meta', title: 'Launch' }, { op: 'reorder', id: 'n_frame1', to: 'front' }];
    const { exitCode, io } = await run(['apply', '--prompt-file', '-', '--json', '--project', 'p1'], { stdin: JSON.stringify({ ops }) });
    expect(exitCode).toBe(0);
    expect(jsonBody(requests[1])).toEqual({ baseRevision: 12, ops, actor: { kind: 'cli' } });
    expect(JSON.parse(io.out)).toEqual(patchResponse(13, ['n_frame1']));

    const wrong = await run(['apply', '--prompt-file', '-', '--project', 'p1'], { stdin: '{"baseRevision":1,"ops":[]}' });
    expect(wrong.exitCode).toBe(BOARD_EXIT_CODES.usage);
  });
});

describe('od board conflicts and daemon errors', () => {
  it('re-reads and retries a 409 board-conflict, then exits 72 after 3 attempts', async () => {
    let reads = 0;
    responder = routes({
      [`GET ${BOARD}`]: () => {
        reads += 1;
        const board = fixtureBoard(9 + reads);
        // Someone else keeps touching the frame: its rev follows the board revision.
        (board.nodes[0] as { rev: number }).rev = 9 + reads;
        return { status: 200, body: { board } };
      },
      [`PATCH ${BOARD}`]: () => ({
        status: 409,
        body: { error: { code: 'CONFLICT', message: 'Board changed', details: { kind: 'board-conflict', revision: 99, conflicts: [{ opIndex: 0, id: 'n_frame1', reason: 'stale-entity' }] } } },
      }),
    });
    const { exitCode, io } = await run(['update', 'n_frame1', '--title', 'Home', '--project', 'p1']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.revisionConflict);
    expect(requests.map((req) => req.method)).toEqual(['GET', 'PATCH', 'GET', 'PATCH', 'GET', 'PATCH']);
    const patches = requests.filter((req) => req.method === 'PATCH').map(jsonBody);
    expect(patches.map((body) => body.baseRevision)).toEqual([10, 11, 12]);
    expect(patches.map((body) => (body.ops as Array<{ expectRev: number }>)[0]!.expectRev)).toEqual([10, 11, 12]);
    const error = stderrError(io);
    expect(error.code).toBe('board-revision-conflict');
    expect(error.data).toMatchObject({ status: 409, details: { kind: 'board-conflict' } });
    expect(io.out).toBe('');
  });

  it('succeeds when a retry lands', async () => {
    let patches = 0;
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7 + patches) } }),
      [`PATCH ${BOARD}`]: () => {
        patches += 1;
        return patches === 1
          ? { status: 409, body: { error: { code: 'CONFLICT', message: 'Board changed', details: { kind: 'board-conflict', revision: 8, conflicts: [] } } } }
          : { status: 200, body: patchResponse(9, ['n_frame1']) };
      },
    });
    const { exitCode } = await run(['remove', 'n_frame1', '--project', 'p1']);
    expect(exitCode).toBe(0);
    expect(requests.filter((req) => req.method === 'PATCH').map((req) => jsonBody(req).baseRevision)).toEqual([7, 8]);
  });

  it('replace PUTs the file content; an explicit --base-revision conflict exits 72 without retrying', async () => {
    let puts = 0;
    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PUT ${BOARD}`]: (req) => {
        puts += 1;
        const body = jsonBody(req) as { baseRevision: number };
        return body.baseRevision === 7
          ? { status: 200, body: { board: { ...fixtureBoard(8), nodes: [], edges: [] } } }
          : { status: 409, body: { error: { code: 'CONFLICT', message: 'stale', details: { kind: 'board-conflict', revision: 7, conflicts: [{ opIndex: -1, id: '*', reason: 'stale-board', currentRev: 7 }] } } } };
      },
    });
    const shown = { board: fixtureBoard(5) };
    const fromShow = await run(['replace', '--file', '-', '--project', 'p1'], { stdin: JSON.stringify(shown) });
    expect(fromShow.exitCode).toBe(0);
    expect(jsonBody(requests[1])).toEqual({
      baseRevision: 7,
      board: { nodes: shown.board.nodes, edges: shown.board.edges, title: 'Landing', settings: shown.board.settings },
      actor: { kind: 'cli' },
    });
    expect(fromShow.io.out).toBe('Replaced the board · r8 · 0 nodes · 0 edges\n');

    requests.length = 0;
    await run(['replace', '--empty', '--project', 'p1']);
    expect(jsonBody(requests[1]).board).toEqual({ nodes: [], edges: [], title: 'Landing', settings: { background: 'dots', autoPlace: true } });

    requests.length = 0;
    puts = 0;
    const pinned = await run(['replace', '--empty', '--base-revision', '3', '--project', 'p1']);
    expect(pinned.exitCode).toBe(BOARD_EXIT_CODES.revisionConflict);
    expect(puts).toBe(1);
  });

  it('maps daemon failures: 404 project 68, unreachable 64, 400 invalid-request 2, others 1', async () => {
    responder = () => ({ status: 404, body: { error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } } });
    const notFound = await run(['show', '--project', 'p1']);
    expect(notFound.exitCode).toBe(BOARD_EXIT_CODES.projectNotFound);
    expect(stderrError(notFound.io)).toMatchObject({ code: 'project-not-found', data: { status: 404, daemonCode: 'PROJECT_NOT_FOUND' } });
    expect(requests).toHaveLength(1);

    const down = await run(['sync', '--project', 'p1', '--daemon-url', unreachableUrl]);
    expect(down.exitCode).toBe(BOARD_EXIT_CODES.daemonNotRunning);
    expect(stderrError(down.io).code).toBe('daemon-not-running');

    responder = routes({
      [`GET ${BOARD}`]: () => ({ status: 200, body: { board: fixtureBoard(7) } }),
      [`PATCH ${BOARD}`]: () => ({ status: 400, body: { error: { code: 'VALIDATION_FAILED', message: 'bad op', details: { kind: 'validation', issues: [{ path: 'ops[0].edge', message: 'no' }] } } } }),
    });
    const invalid = await run(['connect', 'n_img1', 'n_frame1', '--kind', 'output', '--project', 'p1']);
    expect(invalid.exitCode).toBe(BOARD_EXIT_CODES.usage);
    expect(stderrError(invalid.io)).toMatchObject({ code: 'invalid-request', data: { status: 400, daemonCode: 'VALIDATION_FAILED', details: { kind: 'validation' } } });

    responder = () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } });
    const internal = await run(['sync', '--project', 'p1']);
    expect(internal.exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(internal.io)).toMatchObject({ code: 'INTERNAL_ERROR', data: { status: 500 } });
  });
});

describe('od board import-canvas', () => {
  it('--all lists the global documents and imports them in chunks of 20', async () => {
    const documents = Array.from({ length: 25 }, (_, index) => ({ id: `doc-${index}`, name: `D${index}`, format: 'fig', sha256: 'a'.repeat(64), updatedAt: '2026-10-29' }));
    let revision = 7;
    responder = routes({
      'GET /api/design-canvas/documents': () => ({ status: 200, body: { documents } }),
      [`POST ${BOARD}/import-design-canvas`]: (req) => {
        revision += 1;
        const ids = (jsonBody(req) as { documentIds: string[] }).documentIds;
        return { status: 200, body: { revision, results: ids.map((id) => ({ documentId: id, status: 'imported', path: `designs/${id}.fig`, nodeId: `n_${id}` })), changes: null } };
      },
    });
    const { exitCode, io } = await run(['import-canvas', '--all', '--json', '--project', 'p1']);
    expect(exitCode).toBe(0);
    const posts = requests.filter((req) => req.method === 'POST').map((req) => (jsonBody(req) as { documentIds: string[] }).documentIds);
    expect(posts.map((ids) => ids.length)).toEqual([20, 5]);
    expect(posts.flat()).toEqual(documents.map((doc) => doc.id));
    const merged = JSON.parse(io.out) as { revision: number; results: unknown[]; changes: unknown };
    expect(merged.revision).toBe(9);
    expect(merged.results).toHaveLength(25);
    expect(merged.changes).toBeNull();

    requests.length = 0;
    const listed = await run(['import-canvas', 'doc-1', 'doc-1', 'doc-2', '--project', 'p1']);
    expect(listed.exitCode).toBe(0);
    expect(jsonBody(requests[0])).toEqual({ documentIds: ['doc-1', 'doc-2'] });
    expect(listed.io.out.split('\n')[0]).toBe('Imported 2 of 2 document(s) · board r10');
  });
});

describe('od board usage', () => {
  it('reports usage errors with exit code 2 before calling the daemon', async () => {
    for (const args of [
      ['bogus'],
      ['add'],
      ['add', 'robot'],
      ['add', 'note'],
      ['add', 'note', '--text', 'a', '--prompt-file', '-'],
      ['add', 'note', '--text', 'a', '--url', 'https://x.dev'],
      ['add', 'note', '--text', 'a', '--x', '1'],
      ['add', 'note', '--text', 'a', '--x', '1', '--y', '2', '--near', 'n_frame1'],
      ['add', 'note', '--text', 'a', '--side', 'below'],
      ['add', 'note', '--text', 'a', '--id', 'x'],
      ['add', 'note', '--text', 'a', '--color', 'purple'],
      ['add', 'frame', '--path', 'a.html', '--live-artifact', 'la_1'],
      ['add', 'design', '--path', 'designs/a.png'],
      ['add', 'motion', '--movie', 'p', '--render', 'a.mp4'],
      ['add', 'generator', '--surface', 'image', '--model', 'm', '--prompt', 'p', '--count', '5'],
      ['add', 'generator', '--surface', 'image', '--model', 'm', '--prompt', 'p', '--duration', '4'],
      ['add', 'generator', '--surface', 'video', '--prompt', 'p'],
      ['update', 'n_frame1'],
      ['update', 'n_frame1', '--locked', 'yes'],
      ['update', 'n_frame1', '--text', 'a', '--prompt', 'b'],
      ['remove'],
      ['move', 'n_frame1'],
      ['move', 'n_frame1', '--x', '1'],
      ['move', 'n_frame1', '--x', '1', '--y', '1', '--dx', '2'],
      ['move', 'n_frame1', '--dx', 'left'],
      ['layout'],
      ['layout', '--all', '--group', 'n_group1'],
      ['layout', '--all', '--mode', 'spiral'],
      ['connect', 'n_frame1'],
      ['connect', 'n_frame1', 'n_gen1', '--kind', 'derived'],
      ['ungroup'],
      ['sync', 'extra'],
      ['apply'],
      ['replace'],
      ['replace', '--empty', '--file', '-'],
      ['import-canvas'],
      ['import-canvas', 'doc-1', '--all'],
      ['show', '--nope'],
      ['show', '--kind', 'robot'],
      ['show', '--json=yes'],
      ['show', '--node'],
    ]) {
      const { exitCode, io } = await run([...args, '--project', 'p1']);
      expect(exitCode, args.join(' ')).toBe(BOARD_EXIT_CODES.usage);
      expect(stderrError(io).code, args.join(' ')).toBe('invalid-request');
    }
    expect(requests).toHaveLength(0);
  });

  it('prints the usage for help and lists every subcommand', async () => {
    const help = await run(['--help']);
    expect(help.exitCode).toBe(0);
    expect(help.io.out).toBe(`${BOARD_USAGE}\n`);
    const subHelp = await run(['move', '--help']);
    expect(subHelp.exitCode).toBe(0);
    expect(subHelp.io.out).toBe(`${BOARD_USAGE}\n`);
    const bare = await run([]);
    expect(bare.exitCode).toBe(BOARD_EXIT_CODES.usage);
    expect(bare.io.out).toBe(`${BOARD_USAGE}\n`);
    for (const sub of BOARD_SUBCOMMANDS) expect(BOARD_USAGE).toContain(`od board ${sub}`);
    for (const code of ['64 daemon-not-running', '67 missing-input', '68 project-not-found', '72 board-revision-conflict', '73 generation', '74 every']) {
      expect(BOARD_USAGE.replace(/\s+/gu, ' ')).toContain(code);
    }
    expect(requests).toHaveLength(0);
  });
});

describe('od board generate|media dispatch (amendment B7)', () => {
  const missingModule = (file: string) =>
    Object.assign(new Error(`Cannot find module '/repo/apps/daemon/src/fantay/${file}' imported from /repo/apps/daemon/src/fantay/board/board-cli.ts`), {
      code: 'ERR_MODULE_NOT_FOUND',
    });

  it('reports not-implemented (exit 1) while the module is absent', async () => {
    const generate = await run(['generate', 'n_gen1', '--json'], {
      deps: { importExtension: async () => { throw missingModule('board-generate-cli.js'); } },
    });
    expect(generate.exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(generate.io)).toMatchObject({ code: 'not-implemented', data: { subcommand: 'generate' } });
    expect(generate.io.out).toBe('');

    const media = await run(['media', 'crop', '--json'], {
      deps: { importExtension: async () => { throw missingModule('media-ops/media-ops-cli.js'); } },
    });
    expect(media.exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(media.io)).toMatchObject({ code: 'not-implemented', data: { subcommand: 'media' } });

    const noExport = await run(['generate'], { deps: { importExtension: async () => ({ somethingElse: () => undefined }) } });
    expect(stderrError(noExport.io)).toMatchObject({ code: 'not-implemented', data: { cause: 'the module does not export runBoardGenerate' } });
    expect(requests).toHaveLength(0);
  });

  it('does not hide a broken module behind not-implemented', async () => {
    const broken = Object.assign(new Error("Cannot find module '/repo/node_modules/left-pad/index.js' imported from /repo/apps/daemon/src/fantay/board-generate-cli.ts"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const { exitCode, io } = await run(['generate'], { deps: { importExtension: async () => { throw broken; } } });
    expect(exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(io).code).toBe('cli-error');

    const before = process.exitCode;
    const throwing = await run(['media', 'crop'], {
      deps: { importExtension: async () => ({ runBoardMedia: async () => { process.exitCode = 9; throw new Error('ffmpeg missing'); } }) },
    });
    expect(throwing.exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(throwing.io)).toMatchObject({ code: 'cli-error', message: 'od board media failed: ffmpeg missing' });
    expect(process.exitCode).toBe(before);
  });

  it('hands the remaining args to the module and returns its exit code', async () => {
    const before = process.exitCode;
    const calls: Array<[string, string[]]> = [];
    const deps: BoardCliDeps = {
      importExtension: async (name) => ({
        runBoardGenerate: async (args: string[]) => {
          calls.push([name, args]);
          process.exitCode = BOARD_EXIT_CODES.generationRunning;
        },
        runBoardMedia: async (args: string[]) => {
          calls.push([name, args]);
        },
      }),
    };
    const generate = await run(['generate', 'n_gen1', '--timeout', '5', '--json'], { deps });
    expect(generate.exitCode).toBe(73);
    const media = await run(['media', 'frame', 'clips/a.mp4', '--json'], { deps });
    expect(media.exitCode).toBe(0);
    expect(calls).toEqual([
      ['generate', ['n_gen1', '--timeout', '5', '--json']],
      ['media', ['frame', 'clips/a.mp4', '--json']],
    ]);
    expect(process.exitCode).toBe(before);
  });
});

describe('od board (through cli.ts)', () => {
  it('is routed by SUBCOMMAND_MAP', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.OD_DAEMON_URL;
    const { stdout } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, 'board', '--help'], {
      cwd: DAEMON_ROOT,
      env,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(stdout).toBe(`${BOARD_USAGE}\n`);
  }, 90_000);
});
