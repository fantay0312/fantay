// `od board generate` (spec 05 §8, plan R4, amendments B7/C8) against a stub daemon whose board routes run the
// real contract engine (`applyBoardOps` with the daemon conflict rule, `validateBoardPatchRequest`), so every
// PATCH the CLI sends is checked like the daemon checks it. Media routes are scripted per case.
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyBoardOps,
  mediaFailureNextStep,
  outputStemOf,
  validateBoardPatchRequest,
  type BoardContent,
  type BoardDocument,
  type BoardNode,
  type BoardOp,
  type MediaGenerateRequest,
} from '@open-design/contracts';

import { BOARD_EXIT_CODES } from '../../src/fantay/board/board-cli-help.js';
import { runBoardCli } from '../../src/fantay/board/board-cli.js';
import { runBoardGenerateCli, type BoardGenerateIo } from '../../src/fantay/board-generate-cli.js';

interface Captured {
  method: string;
  path: string;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}
interface StubResponse {
  status: number;
  body: unknown;
  delayMs?: number;
}

const actor = { kind: 'user' as const };
function stamped(node: Record<string, unknown>): BoardNode {
  return { createdAt: 1, updatedAt: 1, createdBy: actor, updatedBy: actor, rev: 1, ...node } as unknown as BoardNode;
}

function baseBoard(nodes: BoardNode[], edges: BoardDocument['edges'] = []): BoardDocument {
  return {
    schemaVersion: 1,
    projectId: 'p1',
    revision: 1,
    updatedAt: 1,
    updatedBy: null,
    viewport: null,
    settings: { background: 'dots', autoPlace: true },
    nodes,
    edges,
  };
}

const CATALOG = {
  image: [
    { id: 'gpt-image-2', label: 'gpt-image-2', provider: 'openai', caps: ['t2i', 'i2i', 'inpaint'] },
    { id: 'custom-image', label: 'custom-image', provider: 'custom-image', caps: ['t2i', 'i2i'] },
    { id: 'gemini-3.1-flash-image-preview', label: 'nano-banana', provider: 'nanobanana', caps: ['t2i', 'i2i'] },
  ],
  video: [{ id: 'grok-imagine-video', label: 'grok-imagine-video', provider: 'grok', caps: ['t2v', 'i2v', 'audio'] }],
};

interface Daemon {
  board: BoardDocument;
  project: { status: number; body: unknown };
  /** PATCHes answered with a board conflict before the engine runs. */
  conflicts: number;
  generate: (body: MediaGenerateRequest, index: number) => StubResponse;
  wait: (taskId: string, call: number, body: { since?: number; timeoutMs?: number }) => StubResponse;
  files: () => Array<Record<string, unknown>>;
}

let server: http.Server;
let baseUrl: string;
const requests: Captured[] = [];
let daemon: Daemon;
const generated: MediaGenerateRequest[] = [];
const waitCalls = new Map<string, number>();
let clock = 10_000;

function json(status: number, body: unknown): StubResponse {
  return { status, body };
}

function patchBoard(body: unknown): StubResponse {
  const validated = validateBoardPatchRequest(body);
  if (!validated.ok) return json(400, { error: { code: 'VALIDATION_FAILED', message: 'invalid', details: { issues: validated.issues } } });
  const board = daemon.board;
  if (daemon.conflicts > 0) {
    daemon.conflicts -= 1;
    // Someone else wrote meanwhile: the board moves on one revision.
    daemon.board = { ...board, revision: board.revision + 1 };
    return json(409, {
      error: { code: 'CONFLICT', message: 'board changed', details: { kind: 'board-conflict', revision: board.revision + 1, conflicts: [] } },
    });
  }
  const content: BoardContent = { settings: board.settings, nodes: board.nodes, edges: board.edges };
  let counter = 0;
  const outcome = applyBoardOps(content, validated.value.ops as BoardOp[], {
    baseRevision: validated.value.baseRevision,
    nextRevision: board.revision + 1,
    actor: validated.value.actor ?? { kind: 'user' },
    now: (clock += 1),
    newId: (prefix) => `${prefix}_srv${++counter}`,
    checkConflicts: true,
  });
  if (!outcome.ok) {
    if (outcome.reason === 'conflict') {
      return json(409, {
        error: { code: 'CONFLICT', message: 'conflict', details: { kind: 'board-conflict', revision: board.revision, conflicts: outcome.conflicts } },
      });
    }
    return json(400, { error: { code: 'VALIDATION_FAILED', message: outcome.reason, details: outcome } });
  }
  const revision = outcome.changes.toRevision === outcome.changes.fromRevision ? board.revision : board.revision + 1;
  daemon.board = { ...board, ...outcome.content, revision, updatedAt: clock };
  return json(200, { revision, updatedAt: clock, results: outcome.results, changes: outcome.changes, inverse: outcome.inverse });
}

function route(req: Captured): StubResponse {
  const path = req.path;
  if (req.method === 'GET' && path === '/api/projects/p1') return daemon.project as StubResponse;
  if (req.method === 'GET' && path === '/api/media/models') return json(200, CATALOG);
  if (req.method === 'GET' && path === '/api/projects/p1/board') return json(200, { board: daemon.board });
  if (req.method === 'PATCH' && path === '/api/projects/p1/board') return patchBoard(req.body);
  if (req.method === 'GET' && path === '/api/projects/p1/files') return json(200, { files: daemon.files() });
  if (req.method === 'POST' && path === '/api/projects/p1/media/generate') {
    const body = req.body as MediaGenerateRequest;
    generated.push(body);
    return daemon.generate(body, generated.length - 1);
  }
  const wait = /^\/api\/media\/tasks\/([^/]+)\/wait$/.exec(path);
  if (req.method === 'POST' && wait) {
    const taskId = decodeURIComponent(wait[1]!);
    const call = (waitCalls.get(taskId) ?? 0) + 1;
    waitCalls.set(taskId, call);
    return daemon.wait(taskId, call, (req.body ?? {}) as { since?: number; timeoutMs?: number });
  }
  return json(404, { error: { code: 'NOT_FOUND', message: `no stub for ${req.method} ${path}` } });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      let body: unknown;
      try {
        body = raw ? (JSON.parse(raw) as unknown) : undefined;
      } catch {
        body = raw;
      }
      const captured: Captured = { method: req.method ?? '', path: url.split('?')[0]!, body, headers: req.headers };
      requests.push(captured);
      const response = route(captured);
      const send = () => {
        res.statusCode = response.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(response.body));
      };
      if (response.delayMs) setTimeout(send, response.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no stub address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Generator with two connected references: a PNG (daemon-ready) and an SVG (not readable by the daemon). */
function generatorBoard(overrides: Record<string, unknown> = {}): BoardDocument {
  return baseBoard(
    [
      stamped({ id: 'n_ref1', kind: 'image', x: 0, y: 0, w: 320, h: 320, ref: { path: 'refs/cat.png' } }),
      stamped({ id: 'n_ref2', kind: 'image', x: 0, y: 400, w: 320, h: 320, ref: { path: 'refs/logo.svg' } }),
      stamped({
        id: 'n_gen1',
        kind: 'generator',
        x: 400,
        y: 0,
        w: 320,
        h: 272,
        version: 1,
        surface: 'image',
        prompt: 'a red bike like @[node:n_ref1]',
        model: 'custom-image',
        params: { aspect: '1:1', count: 2 },
        runs: [],
        ...overrides,
      }),
    ],
    [
      { id: 'e_ref1', kind: 'reference', from: 'n_ref1', to: 'n_gen1', createdAt: 1, createdBy: actor, updatedBy: actor, rev: 1 },
      { id: 'e_ref2', kind: 'reference', from: 'n_ref2', to: 'n_gen1', createdAt: 2, createdBy: actor, updatedBy: actor, rev: 1 },
    ],
  );
}

function acceptAll(body: MediaGenerateRequest, index: number): StubResponse {
  void body;
  return json(202, { taskId: `task-${index + 1}`, status: 'queued', startedAt: 1000 });
}

/** First wait: running with one progress line; second: done with the requested output file. */
function finishOnSecondWait(taskId: string, call: number): StubResponse {
  const index = Number(taskId.replace('task-', '')) - 1;
  const output = generated[index]?.output ?? 'missing.png';
  if (call === 1) {
    return json(200, { taskId, status: 'running', startedAt: 1000, endedAt: null, progress: ['rendering'], nextSince: 1 });
  }
  return json(200, {
    taskId,
    status: 'done',
    startedAt: 1000,
    endedAt: 2000,
    progress: [],
    nextSince: 1,
    file: { name: output, size: 2048, mime: 'image/png', mtime: 1999, providerNote: 'stub' },
  });
}

beforeEach(() => {
  requests.length = 0;
  generated.length = 0;
  waitCalls.clear();
  daemon = {
    board: generatorBoard(),
    project: json(200, { project: { id: 'p1', metadata: { kind: 'image' } }, resolvedDir: '/tmp/p1' }),
    conflicts: 0,
    generate: acceptAll,
    wait: finishOnSecondWait,
    files: () => [],
  };
});

function memoryIo(stdin = ''): BoardGenerateIo & { out: string; err: string } {
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

let idCounter = 0;
async function run(args: string[], options: { stdin?: string; env?: NodeJS.ProcessEnv } = {}) {
  const io = memoryIo(options.stdin ?? '');
  idCounter = 0;
  const result = await runBoardGenerateCli(args, io, { OD_DAEMON_URL: baseUrl, ...options.env }, {
    sleep: async () => undefined,
    newId: () => `cli-${++idCounter}`,
  });
  return { ...result, io };
}

function stderrError(io: { err: string }): { code: string; message: string; data: Record<string, unknown> } {
  return (JSON.parse(io.err.trim()) as { error: { code: string; message: string; data: Record<string, unknown> } }).error;
}

function nodeById(id: string): Record<string, unknown> {
  const node = daemon.board.nodes.find((entry) => entry.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node as unknown as Record<string, unknown>;
}

describe('od board generate', () => {
  it('runs a generator end to end and prints the --json result (exit 0)', async () => {
    const { exitCode, io } = await run(['n_gen1', '--project', 'p1', '--json']);
    expect(io.err).toBe('');
    expect(exitCode).toBe(BOARD_EXIT_CODES.ok);

    const result = JSON.parse(io.out) as {
      ok: boolean;
      projectId: string;
      generatorId: string;
      runId: string;
      outputNodeId: string;
      status: string;
      candidates: Array<{ id: string; status: string; taskId: string | null; file: { path: string; mime?: string; size?: number } | null; error: unknown }>;
      warnings: Array<{ kind: string; nodeId?: string }>;
    };
    expect(result).toMatchObject({ ok: true, projectId: 'p1', generatorId: 'n_gen1', status: 'done' });
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.taskId)).toEqual(['task-1', 'task-2']);
    expect(result.candidates.every((candidate) => candidate.status === 'done' && candidate.error === null)).toBe(true);
    expect(result.candidates[0]!.file).toEqual({ path: generated[0]!.output, mime: 'image/png', size: 2048 });

    // Two requests with distinct flat output names; the PNG reference is sent, the SVG one is skipped with a warning.
    expect(generated).toHaveLength(2);
    expect(new Set(generated.map((body) => body.output)).size).toBe(2);
    for (const body of generated) {
      expect(body.output).toMatch(/^gen-[0-9a-z]{6}-[0-9a-z]{6}-[12]\.png$/);
      expect(body).toMatchObject({ surface: 'image', model: 'custom-image', aspect: '1:1', image: 'refs/cat.png' });
      expect(body.images).toBeUndefined();
      expect(body.prompt).toBe('a red bike like Image 1');
    }
    expect(result.warnings).toEqual([{ kind: 'reference-not-ready', nodeId: 'n_ref2' }]);

    // The board holds the run like the workspace writes it: runs[0], an output node with the candidates and an
    // output edge; the primary candidate is mirrored into `ref`.
    const generator = nodeById('n_gen1') as { runs: Array<{ runId: string; outputNodeId: string; count: number }>; model: string };
    expect(generator.runs[0]).toMatchObject({ runId: result.runId, outputNodeId: result.outputNodeId, count: 2 });
    expect(generator.model).toBe('custom-image');
    const output = nodeById(result.outputNodeId) as {
      kind: string;
      ref: { path: string } | null;
      origin?: { source: string; generatorNodeId?: string };
      generation: { primaryCandidateId?: string; candidates: Array<{ status: string; taskId?: string }> };
    };
    expect(output.kind).toBe('image');
    expect(output.origin).toEqual({ source: 'generator', generatorNodeId: 'n_gen1' });
    expect(output.generation.candidates.map((candidate) => candidate.status)).toEqual(['done', 'done']);
    expect(output.generation.primaryCandidateId).toBe(result.candidates[0]!.id);
    expect(output.ref?.path).toBe(generated[0]!.output);
    expect(
      daemon.board.edges.some((edge) => edge.kind === 'output' && edge.from === 'n_gen1' && edge.to === result.outputNodeId),
    ).toBe(true);

    // Waits are long-polls with the daemon cap and follow `nextSince`.
    const waits = requests.filter((req) => req.path.endsWith('/wait'));
    expect(waits.length).toBeGreaterThanOrEqual(4);
    expect(waits[0]!.body).toEqual({ since: 0, timeoutMs: 25_000 });
    expect(waits.find((req) => req.path.includes('task-1') && (req.body as { since: number }).since === 1)).toBeTruthy();
    // Every board write is a PATCH with contract ops (R4: no PUT).
    expect(requests.some((req) => req.method === 'PUT')).toBe(false);
  });

  it('re-reads and retries the board write after a revision conflict', async () => {
    daemon.conflicts = 1;
    const { exitCode, io } = await run(['n_gen1', '--project', 'p1', '--json']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.ok);
    const patches = requests.filter((req) => req.method === 'PATCH');
    // conflicted plan write + plan write + task ids + one write per finished candidate
    expect(patches.length).toBeGreaterThanOrEqual(4);
    expect((patches[0]!.body as { baseRevision: number }).baseRevision).toBe(1);
    expect((patches[1]!.body as { baseRevision: number }).baseRevision).toBe(2);
    // The retried write is the same write: one output node, one run.
    const result = JSON.parse(io.out) as { outputNodeId: string };
    expect(daemon.board.nodes.filter((node) => node.kind === 'image' && node.id === result.outputNodeId)).toHaveLength(1);
    expect((nodeById('n_gen1') as { runs: unknown[] }).runs).toHaveLength(1);
  });

  it('exits 72 when the board keeps changing for five write attempts, before any media request', async () => {
    daemon.conflicts = 5;
    const { exitCode, io } = await run(['n_gen1', '--project', 'p1', '--json']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.revisionConflict);
    expect(stderrError(io)).toMatchObject({ code: 'board-revision-conflict' });
    expect(stderrError(io).message).toMatch(/gave up after 5 attempts/);
    expect(requests.filter((req) => req.method === 'PATCH')).toHaveLength(5);
    expect(generated).toHaveLength(0);
    expect(io.out).toBe('');
  });

  it('persists flag overrides into the generator, reads --prompt-file from stdin and records the agent run', async () => {
    const { exitCode } = await run(
      ['n_gen1', '--project', 'p1', '--prompt-file', '-', '--count', '1', '--aspect', '16:9', '--json'],
      { stdin: 'a blue boat\n', env: { OD_STOCK_RUN_ID: 'run-42' } },
    );
    expect(exitCode).toBe(BOARD_EXIT_CODES.ok);
    const generator = nodeById('n_gen1') as { prompt: string; params: { aspect: string; count: number } };
    expect(generator.prompt).toBe('a blue boat');
    expect(generator.params).toMatchObject({ aspect: '16:9', count: 1 });
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ prompt: 'a blue boat', aspect: '16:9', image: 'refs/cat.png' });
    const patch = requests.find((req) => req.method === 'PATCH')!;
    expect((patch.body as { actor: unknown }).actor).toEqual({ kind: 'agent', runId: 'run-42' });
  });

  it('creates a generator right of the board content with --create', async () => {
    daemon.board = baseBoard([stamped({ id: 'n_note1', kind: 'note', x: 0, y: 0, w: 280, h: 220, text: 'moodboard' })]);
    const { exitCode, io } = await run([
      '--create', '--project', 'p1', '--prompt', 'sunset over hills', '--model', 'gpt-image-2', '--quality', 'low', '--count', '1', '--json',
    ]);
    expect(io.err).toBe('');
    expect(exitCode).toBe(BOARD_EXIT_CODES.ok);
    const result = JSON.parse(io.out) as { generatorId: string };
    const generator = nodeById(result.generatorId) as { kind: string; x: number; y: number; prompt: string; model: string; params: Record<string, unknown> };
    expect(generator).toMatchObject({ kind: 'generator', prompt: 'sunset over hills', model: 'gpt-image-2' });
    expect(generator.x).toBeGreaterThanOrEqual(280 + 96);
    expect(generator.params).toMatchObject({ count: 1, quality: 'low' });
    expect(generated[0]).toMatchObject({ model: 'gpt-image-2', quality: 'low', prompt: 'sunset over hills' });
  });

  it('exits 73 with the tasks queued when --no-wait is given', async () => {
    const { exitCode, io } = await run(['n_gen1', '--project', 'p1', '--no-wait', '--json']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.generationRunning);
    const result = JSON.parse(io.out) as { ok: boolean; status: string; candidates: Array<{ status: string; taskId: string }> };
    expect(result.ok).toBe(false);
    expect(result.status).toBe('running');
    expect(result.candidates.map((candidate) => [candidate.status, candidate.taskId])).toEqual([
      ['queued', 'task-1'],
      ['queued', 'task-2'],
    ]);
    expect(requests.some((req) => req.path.endsWith('/wait'))).toBe(false);
    // The task ids are on the board, so the workspace (or a later CLI call) can pick the run up.
    const output = daemon.board.nodes.find((node) => node.kind === 'image' && node.id !== 'n_ref1' && node.id !== 'n_ref2') as unknown as {
      generation: { candidates: Array<{ taskId?: string }> };
    };
    expect(output.generation.candidates.map((candidate) => candidate.taskId)).toEqual(['task-1', 'task-2']);
  });

  it('exits 73 when the tasks are still running at --timeout', async () => {
    daemon.wait = (taskId, _call, body) =>
      ({
        status: 200,
        delayMs: Math.min(body.timeoutMs ?? 0, 20),
        body: { taskId, status: 'running', startedAt: 1000, endedAt: null, progress: [], nextSince: 0 },
      });
    const { exitCode, io } = await run(['n_gen1', '--project', 'p1', '--timeout', '0.15', '--json']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.generationRunning);
    expect((JSON.parse(io.out) as { status: string }).status).toBe('running');
    const waits = requests.filter((req) => req.path.endsWith('/wait'));
    expect(waits.length).toBeGreaterThan(0);
    for (const wait of waits) expect((wait.body as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(150);
  });

  it('exits 74 when every candidate failed, with the next step of the daemon error', async () => {
    daemon.generate = () => json(403, { error: { code: 'MEDIA_MODEL_DENIED', message: 'media model "custom-image" is not allowed for this run' } });
    const { exitCode, io } = await run(['n_gen1', '--project', 'p1', '--json']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.generationFailed);
    const result = JSON.parse(io.out) as { ok: boolean; status: string; candidates: Array<{ status: string; error: { nextStep: string; code: string } }> };
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    const expected = mediaFailureNextStep({ code: 'MEDIA_MODEL_DENIED', status: 403, model: 'custom-image' });
    for (const candidate of result.candidates) {
      expect(candidate.status).toBe('failed');
      expect(candidate.error).toMatchObject({ nextStep: expected, code: 'MEDIA_MODEL_DENIED' });
    }
    expect(requests.some((req) => req.path.endsWith('/wait'))).toBe(false);
  });

  it('recovers a finished output by its stem when the task is gone (404)', async () => {
    daemon.wait = () => json(404, { error: 'task not found' });
    daemon.files = () => generated.map((body, index) => ({ name: body.output, size: 100 + index, mtime: 5_000, kind: 'image', mime: 'image/png' }));
    const { exitCode, io } = await run(['n_gen1', '--project', 'p1', '--json']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.ok);
    const result = JSON.parse(io.out) as { candidates: Array<{ status: string; file: { path: string } }> };
    expect(result.candidates.map((candidate) => candidate.status)).toEqual(['done', 'done']);
    expect(result.candidates.map((candidate) => outputStemOf(candidate.file.path))).toEqual(
      generated.map((body) => outputStemOf(body.output ?? '')),
    );
  });

  it('rejects invalid arguments with exit 2 before calling the daemon', async () => {
    const cases: Array<[string[], RegExp]> = [
      [['--project', 'p1'], /generatorNodeId> or --create/],
      [['n_gen1', '--create', '--project', 'p1'], /either/],
      [['n_gen1', '--project', 'p1', '--surface', 'audio'], /audio generators are not available/],
      [['n_gen1', '--project', 'p1', '--count', '5'], /--count must be 1\.\.4/],
      [['n_gen1', '--project', 'p1', '--aspect', '2:1'], /--aspect must be one of/],
      [['n_gen1', '--project', 'p1', '--bogus'], /unknown flag/],
      [['n_gen1', '--project', 'p1', '--prompt', 'a', '--prompt-file', 'b'], /only one of --prompt, --prompt-file/],
    ];
    for (const [args, message] of cases) {
      const { exitCode, io } = await run(args);
      expect(exitCode, args.join(' ')).toBe(BOARD_EXIT_CODES.usage);
      expect(stderrError(io)).toMatchObject({ code: 'invalid-request' });
      expect(stderrError(io).message).toMatch(message);
    }
    expect(requests).toHaveLength(0);
  });

  it('rejects what the generator cannot run with exit 2 (unknown model, unsupported value, empty prompt)', async () => {
    const unknown = await run(['n_gen1', '--project', 'p1', '--model', 'no-such-model']);
    expect(unknown.exitCode).toBe(BOARD_EXIT_CODES.usage);
    expect(stderrError(unknown.io).message).toMatch(/unknown model no-such-model/);

    const quality = await run(['n_gen1', '--project', 'p1', '--quality', 'low']);
    expect(quality.exitCode).toBe(BOARD_EXIT_CODES.usage);
    expect(stderrError(quality.io).message).toMatch(/--quality is not supported by custom-image/);

    daemon.board = generatorBoard({ prompt: '' });
    daemon.board = { ...daemon.board, edges: [] };
    const empty = await run(['n_gen1', '--project', 'p1']);
    expect(empty.exitCode).toBe(BOARD_EXIT_CODES.usage);
    expect(stderrError(empty.io).data).toMatchObject({ reason: 'empty-prompt' });
    expect(generated).toHaveLength(0);
    expect(requests.some((req) => req.method === 'PATCH')).toBe(false);
  });

  it('maps project and node problems to their exit codes', async () => {
    const missing = await runBoardGenerateCli(['n_gen1'], memoryIo(), { OD_DAEMON_URL: baseUrl }, {});
    expect(missing.exitCode).toBe(BOARD_EXIT_CODES.missingInput);

    daemon.project = json(404, { error: { code: 'PROJECT_NOT_FOUND', message: 'not found' } });
    const notFound = await run(['n_gen1', '--project', 'p1']);
    expect(notFound.exitCode).toBe(BOARD_EXIT_CODES.projectNotFound);

    daemon.project = json(200, { project: { id: 'p1', metadata: { baseDir: '/somewhere/else' } } });
    const imported = await run(['n_gen1', '--project', 'p1']);
    expect(imported.exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(imported.io).code).toBe('imported-folder-unsupported');

    daemon.project = json(200, { project: { id: 'p1', metadata: {} } });
    const node = await run(['n_nope', '--project', 'p1']);
    expect(node.exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(node.io).code).toBe('node-not-found');

    const notGenerator = await run(['n_ref1', '--project', 'p1']);
    expect(notGenerator.exitCode).toBe(BOARD_EXIT_CODES.usage);

    const unreachable = await runBoardGenerateCli(['n_gen1', '--project', 'p1'], memoryIo(), { OD_DAEMON_URL: 'http://127.0.0.1:9' }, {});
    expect(unreachable.exitCode).toBe(BOARD_EXIT_CODES.daemonNotRunning);
  });

  it('refuses a generator whose latest run is still active', async () => {
    daemon.board = generatorBoard({
      runs: [{ runId: 'run-old', outputNodeId: 'n_out', surface: 'image', model: 'custom-image', count: 1, startedAt: 5 }],
    });
    daemon.board.nodes.push(
      stamped({
        id: 'n_out',
        kind: 'image',
        x: 800,
        y: 0,
        w: 320,
        h: 320,
        ref: null,
        generation: {
          candidates: [{ id: 'c-old', runId: 'run-old', index: 0, attempt: 0, status: 'running', outputStem: 'gen-aaaaaa-bbbbbb-1', taskId: 't-old' }],
          request: { surface: 'image', model: 'custom-image', modelBase: 'custom-image', provider: 'custom-image', prompt: 'x', promptSource: 'x', references: [], generatorId: 'n_gen1', runId: 'run-old', createdAt: 5 },
        },
      }),
    );
    const { exitCode, io } = await run(['n_gen1', '--project', 'p1']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.error);
    expect(stderrError(io)).toMatchObject({ code: 'generation-running', data: { runId: 'run-old', outputNodeId: 'n_out' } });
    expect(generated).toHaveLength(0);
  });

  it('prints a readable summary without --json', async () => {
    const { exitCode, io } = await run(['n_gen1', '--project', 'p1']);
    expect(exitCode).toBe(BOARD_EXIT_CODES.ok);
    expect(io.out).toMatch(/^Generator n_gen1 · run \S+ → node \S+ · done \(2\/2 done\) · custom-image/);
    expect(io.out).toMatch(/warning: reference n_ref2 is not a project PNG/);
  });

  it('is reachable as `od board generate` through the board dispatcher (B7)', async () => {
    // The dispatched module writes to the process streams; capture them (and still run write callbacks,
    // which the module awaits before it reports its exit code).
    let printed = '';
    const capture = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean => {
      printed += typeof chunk === 'string' ? chunk : String(chunk);
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (typeof done === 'function') (done as () => void)();
      return true;
    };
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
    try {
      const io = { stdout: () => undefined, stderr: () => undefined, readStdin: async () => '' };
      const help = await runBoardCli(['generate', '--help'], io, { OD_DAEMON_URL: baseUrl });
      expect(help.exitCode).toBe(BOARD_EXIT_CODES.ok);
      expect(printed).toContain('od board generate <generatorNodeId> [flags]');
      const usage = await runBoardCli(['generate'], io, { OD_DAEMON_URL: baseUrl });
      expect(usage.exitCode).toBe(BOARD_EXIT_CODES.usage);
      expect(printed).toContain('"code":"invalid-request"');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
