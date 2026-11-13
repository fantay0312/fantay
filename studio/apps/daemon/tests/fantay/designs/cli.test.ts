// `od canvas` (06 §7.4): argument parsing for every form, `runCanvasCli` against a fake fetch, and one live round trip
// against the real daemon routes.
import { createHash } from 'node:crypto';
import type http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CANVAS_EXIT_CODES,
  CANVAS_USAGE,
  parseCanvasCliArgs,
  runCanvasCli,
  withWorkspaceEnv,
  type CanvasCliCommand,
  type CanvasCliDeps,
} from '../../../src/services/design-canvas-cli.js';
import { startServer } from '../../../src/server.js';
import { closeDatabase } from '../../../src/db.js';
import { legacyInput, makeFig, makePng } from './fixtures.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const common = { json: false };

describe('parseCanvasCliArgs', () => {
  it('parses every project, migration and legacy form', () => {
    const cases: Array<[string[], CanvasCliCommand]> = [
      [[], { kind: 'help' }],
      [['--help'], { kind: 'help' }],
      [['help'], { kind: 'help' }],
      [['list', '-h'], { kind: 'help' }],
      [['list', '--project', 'p1'], { kind: 'list', projectId: 'p1', common }],
      [['list', '--project=p1', '--json'], { kind: 'list', projectId: 'p1', common: { json: true } }],
      [['show', 'designs/a.fig', '--project', 'p1'], { kind: 'show', projectId: 'p1', path: 'designs/a.fig', common }],
      [['import', 'a.fig', '--project', 'p1'], { kind: 'import', projectId: 'p1', file: 'a.fig', replace: false, common }],
      [
        ['import', 'a.op', '--project', 'p1', '--as', 'designs/b.op', '--replace'],
        { kind: 'import', projectId: 'p1', file: 'a.op', as: 'designs/b.op', replace: true, common },
      ],
      [['export', 'designs/a.fig', 'out.fig', '--project', 'p1'], { kind: 'export', projectId: 'p1', path: 'designs/a.fig', output: 'out.fig', common }],
      [['cover', 'designs/a.fig', 'a.png', '--project', 'p1'], { kind: 'cover', projectId: 'p1', path: 'designs/a.fig', output: 'a.png', common }],
      [['migrate', 'legacy-1', '--project', 'p1'], { kind: 'migrate', projectId: 'p1', legacyId: 'legacy-1', common }],
      [['migrate', 'legacy-1', '--project', 'p1', '--as', 'designs/x.fig'], { kind: 'migrate', projectId: 'p1', legacyId: 'legacy-1', as: 'designs/x.fig', common }],
      [['migrate', '--all', '--project', 'p1'], { kind: 'migrate-all', projectId: 'p1', dryRun: false, common }],
      [['migrate', '--all', '--project', 'p1', '--dry-run'], { kind: 'migrate-all', projectId: 'p1', dryRun: true, common }],
      [['migrations'], { kind: 'migrations', common }],
      [['list'], { kind: 'legacy-list', common }],
      [['show', 'doc-1'], { kind: 'legacy-show', id: 'doc-1', common }],
      [['import', 'a.fig'], { kind: 'legacy-import', file: 'a.fig', common }],
      [['export', 'doc-1', 'out.fig'], { kind: 'legacy-export', id: 'doc-1', output: 'out.fig', common }],
      [
        ['list', '--project', 'p1', '--daemon-url', 'http://127.0.0.1:1', '--workspace', 'w1', '--workspace-member', 'm1'],
        { kind: 'list', projectId: 'p1', common: { json: false, daemonUrl: 'http://127.0.0.1:1', workspace: { id: 'w1', memberId: 'm1' } } },
      ],
      [['export', 'doc-1', '--', '--odd-name.fig'], { kind: 'legacy-export', id: 'doc-1', output: '--odd-name.fig', common }],
    ];
    for (const [args, expected] of cases) expect(parseCanvasCliArgs(args), args.join(' ')).toEqual(expected);
  });

  it('rejects malformed invocations', () => {
    const invalid = [
      ['bogus'],
      ['list', 'extra'],
      ['list', '--bogus'],
      ['show'],
      ['show', '--project', 'p1'],
      ['export', 'designs/a.fig', '--project', 'p1'],
      ['import', 'a.fig', '--replace'],
      ['import', 'a.fig', '--as', 'designs/a.fig'],
      ['cover', 'designs/a.fig', 'a.png'],
      ['migrate', 'legacy-1'],
      ['migrate', 'legacy-1', '--project', 'p1', '--dry-run'],
      ['migrate', '--all', 'legacy-1', '--project', 'p1'],
      ['migrate', '--all', '--project', 'p1', '--as', 'designs/x.fig'],
      ['migrations', '--project', 'p1'],
      ['list', '--project'],
      ['list', '--project', '--json'],
      ['list', '--project', 'a', '--project', 'b'],
      ['list', '--project', 'p1', '--workspace', 'w1'],
    ];
    for (const args of invalid) expect(parseCanvasCliArgs(args).kind, args.join(' ')).toBe('invalid');
  });

  it('fills the workspace pair from the environment for project commands only', () => {
    const env = { OD_WORKSPACE_ID: 'w9', OD_WORKSPACE_MEMBER_ID: 'm9' };
    expect(withWorkspaceEnv(parseCanvasCliArgs(['list', '--project', 'p1']), env)).toMatchObject({ common: { workspace: { id: 'w9', memberId: 'm9' } } });
    expect(withWorkspaceEnv(parseCanvasCliArgs(['list']), env)).toEqual({ kind: 'legacy-list', common });
    expect(withWorkspaceEnv(parseCanvasCliArgs(['list', '--project', 'p1']), { OD_WORKSPACE_ID: 'w9' }).kind).toBe('invalid');
    expect(withWorkspaceEnv(parseCanvasCliArgs(['list', '--project', 'p1', '--workspace', 'w1', '--workspace-member', 'm1']), env))
      .toMatchObject({ common: { workspace: { id: 'w1', memberId: 'm1' } } });
  });
});

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

type Route = (request: RecordedRequest) => Response | Promise<Response>;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function apiError(status: number, code: string, reason?: string): Response {
  return jsonResponse(status, { error: { code, message: `${code} message`, ...(reason ? { details: { reason } } : {}) } });
}

function harness(route: Route, options: { files?: Record<string, Buffer>; tty?: boolean } = {}) {
  const requests: RecordedRequest[] = [];
  const written: Array<{ file: string; data: Buffer; flag: string }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const existing = new Set<string>();
  const deps: CanvasCliDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
      const body = init?.body === undefined || init.body === null
        ? null
        : typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
      const request = { method: init?.method ?? 'GET', url: String(input), headers, body };
      requests.push(request);
      return route(request);
    }) as typeof fetch,
    readFile: async (file) => {
      const data = options.files?.[file];
      if (!data) throw Object.assign(new Error(`ENOENT: no such file ${file}`), { code: 'ENOENT' });
      return data;
    },
    writeFile: async (file, data, writeOptions) => {
      if (existing.has(file)) throw Object.assign(new Error(`EEXIST: ${file}`), { code: 'EEXIST' });
      existing.add(file);
      written.push({ file, data, flag: writeOptions.flag });
    },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    daemonUrl: 'http://daemon.test/',
    stderrIsTTY: options.tty ?? false,
  };
  return { deps, requests, written, stdout, stderr, existing };
}

const BASE = 'http://daemon.test';

describe('runCanvasCli (fake fetch)', () => {
  it('imports with If-None-Match: * at a unique default path', async () => {
    const bytes = Buffer.from('PK\x03\x04-fig-bytes', 'latin1');
    const run = harness((request) => {
      if (request.method === 'GET' && request.url === `${BASE}/api/projects/p1/designs`) {
        return jsonResponse(200, { designs: [{ path: 'designs/Poster-Final.fig' }] });
      }
      if (request.method === 'PUT') return jsonResponse(201, { design: { path: 'designs/Poster-Final-2.fig' }, created: true, previousSha256: null });
      return apiError(500, 'INTERNAL_ERROR');
    }, { files: { 'Poster Final.fig': bytes } });
    const code = await runCanvasCli(parseCanvasCliArgs(['import', 'Poster Final.fig', '--project', 'p1']), run.deps);
    expect(code).toBe(0);
    const put = run.requests.find((request) => request.method === 'PUT')!;
    expect(put.url).toBe(`${BASE}/api/projects/p1/designs/content?path=${encodeURIComponent('designs/Poster-Final-2.fig')}`);
    expect(put.headers).toMatchObject({ 'if-none-match': '*', 'content-type': 'application/octet-stream' });
    expect(put.headers).not.toHaveProperty('if-match');
    expect(put.body).toEqual(bytes);
    expect(JSON.parse(run.stdout.join('\n'))).toMatchObject({ created: true });
  });

  it('preserves canonical path suggestions returned by the daemon', async () => {
    const run = harness(() => jsonResponse(400, { error: { code: 'BAD_REQUEST', message: 'Use a canonical path', details: { reason: 'INVALID_DESIGN_PATH', suggestion: 'designs/my-design.fig' } } }));
    expect(await runCanvasCli(parseCanvasCliArgs(['show', 'designs/my design.fig', '--project', 'p1']), run.deps)).toBe(1);
    expect(JSON.parse(run.stderr[0]!)).toMatchObject({ reason: 'INVALID_DESIGN_PATH', suggestion: 'designs/my-design.fig' });
  });

  it('imports with --replace through HEAD + If-Match, or creates when the target is missing', async () => {
    const bytes = Buffer.from('fig-kiwi-new');
    const current = 'c'.repeat(64);
    const replacing = harness((request) => {
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'x-design-sha256': current, 'x-design-format': 'fig', 'x-design-revision': '10-20' } });
      return jsonResponse(200, { created: false });
    }, { files: { 'hero.fig': bytes } });
    expect(await runCanvasCli(parseCanvasCliArgs(['import', 'hero.fig', '--project', 'p1', '--replace']), replacing.deps)).toBe(0);
    const head = replacing.requests[0]!;
    expect(head).toMatchObject({ method: 'HEAD', url: `${BASE}/api/projects/p1/designs/content?path=${encodeURIComponent('designs/hero.fig')}` });
    expect(replacing.requests[1]!.headers).toMatchObject({ 'if-match': `"${current}"` });

    const creating = harness((request) => (request.method === 'HEAD' ? new Response(null, { status: 404 }) : jsonResponse(201, { created: true })), {
      files: { 'hero.fig': bytes },
    });
    expect(await runCanvasCli(parseCanvasCliArgs(['import', 'hero.fig', '--project', 'p1', '--replace', '--as', 'designs/other.fig']), creating.deps)).toBe(0);
    expect(creating.requests[0]!.url).toContain(encodeURIComponent('designs/other.fig'));
    expect(creating.requests[1]!.headers).toMatchObject({ 'if-none-match': '*' });
  });

  it('refuses imports of other file types and mismatched --as paths (exit 2)', async () => {
    const run = harness(() => apiError(500, 'INTERNAL_ERROR'), { files: { 'a.png': Buffer.from('x'), 'a.fig': Buffer.from('x') } });
    expect(await runCanvasCli(parseCanvasCliArgs(['import', 'a.png', '--project', 'p1']), run.deps)).toBe(CANVAS_EXIT_CODES.usage);
    expect(await runCanvasCli(parseCanvasCliArgs(['import', 'a.fig', '--project', 'p1', '--as', 'designs/a.op']), run.deps)).toBe(CANVAS_EXIT_CODES.usage);
    expect(run.requests).toEqual([]);
    expect(await runCanvasCli(parseCanvasCliArgs(['import', 'missing.fig', '--project', 'p1', '--as', 'designs/m.fig']), run.deps)).toBe(1);
    expect(JSON.parse(run.stderr[run.stderr.length - 1]!)).toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('exports and saves covers without overwriting outputs', async () => {
    const bytes = Buffer.from('fig-kiwi-exported');
    const png = makePng(2, 2);
    const run = harness((request) => {
      if (request.url.includes('/designs/content')) return new Response(new Uint8Array(bytes), { status: 200, headers: { 'x-design-sha256': sha256(bytes), 'x-design-format': 'fig' } });
      if (request.url.includes('/designs/cover')) return new Response(new Uint8Array(png), { status: 200, headers: { 'x-design-cover-source': 'thumbnail' } });
      return apiError(500, 'INTERNAL_ERROR');
    });
    expect(await runCanvasCli(parseCanvasCliArgs(['export', 'designs/a.fig', 'out.fig', '--project', 'p1']), run.deps)).toBe(0);
    expect(run.written[0]).toEqual({ file: 'out.fig', data: bytes, flag: 'wx' });
    expect(JSON.parse(run.stdout[0]!)).toMatchObject({ path: path.resolve('out.fig'), sha256: sha256(bytes) });
    expect(await runCanvasCli(parseCanvasCliArgs(['export', 'designs/a.fig', 'out.fig', '--project', 'p1']), run.deps)).toBe(1);
    expect(JSON.parse(run.stderr[0]!)).toMatchObject({ code: 'CONFLICT' });
    expect(await runCanvasCli(parseCanvasCliArgs(['cover', 'designs/a.fig', 'a.png', '--project', 'p1']), run.deps)).toBe(0);
    expect(run.written[1]).toEqual({ file: 'a.png', data: png, flag: 'wx' });
    expect(JSON.parse(run.stdout[1]!)).toMatchObject({ source: 'thumbnail' });
  });

  it('migrate --all --dry-run lists without writing; migrate --all imports only the pending documents', async () => {
    const migrations = [{ legacyId: 'doc-1', legacySha256: 'a'.repeat(64), projectId: 'p1', path: 'designs/one.fig', sha256: 'a'.repeat(64), migratedAt: 'x' }];
    const documents = [
      { id: 'doc-1', name: 'One', format: 'fig', sha256: 'a'.repeat(64), updatedAt: '2026-10-01' },
      { id: 'doc-2', name: 'Two', format: 'fig', sha256: 'b'.repeat(64), updatedAt: '2026-10-02' },
      // Same document imported into another project only: still pending here.
      { id: 'doc-3', name: 'Three', format: 'op', sha256: 'c'.repeat(64), updatedAt: '2026-10-03' },
    ];
    migrations.push({ ...migrations[0]!, legacyId: 'doc-3', legacySha256: 'c'.repeat(64), projectId: 'p2' });
    const route: Route = (request) => {
      if (request.url === `${BASE}/api/projects/p1/designs`) return jsonResponse(200, { designs: [] });
      if (request.url === `${BASE}/api/design-canvas/documents`) return jsonResponse(200, { documents });
      if (request.url === `${BASE}/api/design-canvas/migrations`) return jsonResponse(200, { migrations });
      if (request.method === 'POST') {
        const body = JSON.parse(request.body!.toString('utf8'));
        return jsonResponse(201, { design: { path: `designs/${body.legacyId}.fig` }, migration: { legacyId: body.legacyId }, alreadyImported: false });
      }
      return apiError(500, 'INTERNAL_ERROR');
    };
    const dry = harness(route);
    expect(await runCanvasCli(parseCanvasCliArgs(['migrate', '--all', '--project', 'p1', '--dry-run']), dry.deps)).toBe(0);
    expect(dry.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(JSON.parse(dry.stdout[0]!)).toEqual({ projectId: 'p1', dryRun: true, documents: [documents[1], documents[2]] });

    const real = harness(route);
    expect(await runCanvasCli(parseCanvasCliArgs(['migrate', '--all', '--project', 'p1']), real.deps)).toBe(0);
    const posts = real.requests.filter((request) => request.method === 'POST');
    expect(posts.map((request) => request.url)).toEqual([
      `${BASE}/api/projects/p1/designs/import-legacy`,
      `${BASE}/api/projects/p1/designs/import-legacy`,
    ]);
    expect(posts.map((request) => JSON.parse(request.body!.toString('utf8')))).toEqual([{ legacyId: 'doc-2' }, { legacyId: 'doc-3' }]);
    expect(JSON.parse(real.stdout[0]!).results).toHaveLength(2);

    const single = harness(route);
    expect(await runCanvasCli(parseCanvasCliArgs(['migrate', 'doc-9', '--project', 'p1', '--as', 'designs/nine.fig']), single.deps)).toBe(0);
    expect(JSON.parse(single.requests[0]!.body!.toString('utf8'))).toEqual({ legacyId: 'doc-9', path: 'designs/nine.fig' });
  });

  it('keeps the legacy forms on the old endpoints with the old output', async () => {
    const legacyDoc = { id: 'doc-1', name: 'Old', format: 'fig', sha256: 'd'.repeat(64), updatedAt: '2026-01-01', data: Buffer.from('legacy-bytes').toString('base64') };
    const route: Route = (request) => {
      if (request.method === 'GET' && request.url === `${BASE}/api/design-canvas/documents`) return jsonResponse(200, { documents: [{ id: 'doc-1' }] });
      if (request.method === 'GET' && request.url === `${BASE}/api/design-canvas/documents/doc-1`) return jsonResponse(200, legacyDoc);
      if (request.method === 'PUT' && request.url.startsWith(`${BASE}/api/design-canvas/documents/`)) {
        const body = JSON.parse(request.body!.toString('utf8'));
        return jsonResponse(200, { id: 'new-id', ...body, sha256: 'e'.repeat(64), updatedAt: 'now' });
      }
      return apiError(404, 'NOT_FOUND');
    };
    const run = harness(route, { files: { 'Old Design.fig': Buffer.from('PK\x03\x04', 'latin1') } });
    expect(await runCanvasCli(parseCanvasCliArgs(['list']), run.deps)).toBe(0);
    expect(JSON.parse(run.stdout[0]!)).toEqual({ documents: [{ id: 'doc-1' }] });
    expect(await runCanvasCli(parseCanvasCliArgs(['show', 'doc-1']), run.deps)).toBe(0);
    expect(JSON.parse(run.stdout[1]!)).toEqual({ id: 'doc-1', name: 'Old', format: 'fig', sha256: 'd'.repeat(64), updatedAt: '2026-01-01' });
    expect(await runCanvasCli(parseCanvasCliArgs(['import', 'Old Design.fig']), run.deps)).toBe(0);
    const put = run.requests.find((request) => request.method === 'PUT')!;
    expect(put.url).toMatch(/\/api\/design-canvas\/documents\/[0-9a-f-]{36}$/);
    expect(JSON.parse(put.body!.toString('utf8'))).toEqual({ name: 'Old Design', format: 'fig', data: Buffer.from('PK\x03\x04', 'latin1').toString('base64'), expected: null });
    expect(JSON.parse(run.stdout[2]!)).not.toHaveProperty('data');
    expect(await runCanvasCli(parseCanvasCliArgs(['export', 'doc-1', 'old.fig']), run.deps)).toBe(0);
    expect(run.written[0]).toEqual({ file: 'old.fig', data: Buffer.from('legacy-bytes'), flag: 'wx' });
    expect(run.stdout[3]).toBe(JSON.stringify({ path: path.resolve('old.fig'), sha256: 'd'.repeat(64) }));
    expect(await runCanvasCli(parseCanvasCliArgs(['show', 'doc-404']), run.deps)).toBe(1);
    // No project-scoped headers or hint on a non-TTY stderr.
    expect(run.stderr.filter((line) => line.startsWith('Note:'))).toEqual([]);
    const tty = harness(route, { tty: true });
    await runCanvasCli(parseCanvasCliArgs(['list']), tty.deps);
    expect(tty.stderr).toHaveLength(1);
    expect(tty.stderr[0]).toMatch(/^Note: without --project/);
    const projectTty = harness(() => jsonResponse(200, { designs: [] }), { tty: true });
    await runCanvasCli(parseCanvasCliArgs(['list', '--project', 'p1']), projectTty.deps);
    expect(projectTty.stderr).toEqual([]);
  });

  it('maps failures to stable exit codes and JSON errors', async () => {
    const unreachable = harness(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    expect(await runCanvasCli(parseCanvasCliArgs(['list', '--project', 'p1']), unreachable.deps)).toBe(CANVAS_EXIT_CODES.daemonNotRunning);
    expect(JSON.parse(unreachable.stderr[0]!)).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(unreachable.stderr[0]).toContain('ECONNREFUSED');

    const missingProject = harness(() => apiError(404, 'PROJECT_NOT_FOUND'));
    expect(await runCanvasCli(parseCanvasCliArgs(['list', '--project', 'nope']), missingProject.deps)).toBe(CANVAS_EXIT_CODES.projectNotFound);

    const conflict = harness(() => apiError(409, 'CONFLICT', 'DESIGN_REVISION_MISMATCH'));
    expect(await runCanvasCli(parseCanvasCliArgs(['migrate', 'doc-1', '--project', 'p1']), conflict.deps)).toBe(1);
    expect(JSON.parse(conflict.stderr[0]!)).toEqual({ error: 'CONFLICT message', code: 'CONFLICT', reason: 'DESIGN_REVISION_MISMATCH' });

    const usage = harness(() => apiError(500, 'INTERNAL_ERROR'));
    expect(await runCanvasCli(parseCanvasCliArgs(['bogus']), usage.deps)).toBe(CANVAS_EXIT_CODES.usage);
    expect(JSON.parse(usage.stderr[0]!)).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await runCanvasCli({ kind: 'help' }, usage.deps)).toBe(0);
    expect(usage.stdout[0]).toBe(CANVAS_USAGE);
    expect(usage.requests).toEqual([]);

    // show: HEAD has no body, so a 404 is resolved with the project list.
    const showMissingFile = harness((request) => (request.method === 'HEAD' ? new Response(null, { status: 404 }) : jsonResponse(200, { designs: [] })));
    expect(await runCanvasCli(parseCanvasCliArgs(['show', 'designs/x.fig', '--project', 'p1']), showMissingFile.deps)).toBe(1);
    expect(JSON.parse(showMissingFile.stderr[0]!)).toMatchObject({ code: 'FILE_NOT_FOUND' });
    const showMissingProject = harness((request) => (request.method === 'HEAD' ? new Response(null, { status: 404 }) : apiError(404, 'PROJECT_NOT_FOUND')));
    expect(await runCanvasCli(parseCanvasCliArgs(['show', 'designs/x.fig', '--project', 'nope']), showMissingProject.deps)).toBe(CANVAS_EXIT_CODES.projectNotFound);
  });

  it('sends workspace headers on project calls only', async () => {
    const run = harness((request) => (request.url.includes('/api/projects/') ? jsonResponse(200, { designs: [] }) : jsonResponse(200, { migrations: [] })));
    const workspace = ['--workspace', 'w1', '--workspace-member', 'm1'];
    await runCanvasCli(parseCanvasCliArgs(['list', '--project', 'p1', ...workspace]), run.deps);
    await runCanvasCli(parseCanvasCliArgs(['migrations', ...workspace]), run.deps);
    expect(run.requests[0]!.headers).toMatchObject({ 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'm1' });
    expect(run.requests[1]!.headers).not.toHaveProperty('x-od-workspace-id');
  });
});

describe('od canvas against the daemon', () => {
  let server: http.Server;
  let baseUrl: string;
  let workDir: string;
  const projectId = 'proj-designs-cli';

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as { url: string; server: http.Server };
    baseUrl = started.url;
    server = started.server;
    const created = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: projectId, name: projectId }),
    });
    expect(created.status).toBe(200);
    workDir = await mkdtemp(path.join(tmpdir(), 'fantay-canvas-cli-'));
  });

  afterAll(async () => {
    closeDatabase();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  function live() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps: CanvasCliDeps = {
      fetch,
      readFile: (file) => readFile(file),
      writeFile: (file, data, options) => writeFile(file, data, options),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      daemonUrl: baseUrl,
    };
    const run = async (...args: string[]) => {
      stdout.length = 0;
      stderr.length = 0;
      const code = await runCanvasCli(parseCanvasCliArgs(args), deps);
      return { code, out: stdout.length ? JSON.parse(stdout.join('\n')) : null, err: stderr.join('\n') };
    };
    return run;
  }

  it('imports, lists, shows, replaces, exports, saves covers and migrates through the real routes', async () => {
    const run = live();
    const local = path.join(workDir, 'Launch Poster.fig');
    const first = await makeFig({ canvas: 'cli-1', thumbnail: makePng(3, 3) });
    await writeFile(local, first);

    const imported = await run('import', local, '--project', projectId, '--json');
    expect(imported).toMatchObject({ code: 0, out: { created: true, design: { path: 'designs/Launch-Poster.fig', sha256: sha256(first) } } });
    const second = await run('import', local, '--project', projectId);
    expect(second.out.design.path).toBe('designs/Launch-Poster-2.fig');

    const listed = await run('list', '--project', projectId);
    expect(listed.out.designs.map((design: { path: string }) => design.path).sort()).toEqual(['designs/Launch-Poster-2.fig', 'designs/Launch-Poster.fig']);
    const shown = await run('show', 'designs/Launch-Poster.fig', '--project', projectId);
    expect(shown.out).toMatchObject({ path: 'designs/Launch-Poster.fig', name: 'Launch-Poster', format: 'fig', size: first.length, sha256: sha256(first) });
    expect(shown.out.revision).toBe(listed.out.designs.find((design: { path: string }) => design.path === 'designs/Launch-Poster.fig').revision);

    const next = await makeFig({ canvas: 'cli-2', thumbnail: null });
    await writeFile(local, next);
    const replaced = await run('import', local, '--project', projectId, '--replace');
    expect(replaced.out).toMatchObject({ created: false, previousSha256: sha256(first), design: { path: 'designs/Launch-Poster.fig', sha256: sha256(next) } });

    const output = path.join(workDir, 'exported.fig');
    expect((await run('export', 'designs/Launch-Poster.fig', output, '--project', projectId)).code).toBe(0);
    expect(await readFile(output)).toEqual(next);
    const again = await run('export', 'designs/Launch-Poster.fig', output, '--project', projectId);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.err)).toMatchObject({ code: 'CONFLICT' });

    const cover = path.join(workDir, 'cover.png');
    const coverRun = await run('cover', 'designs/Launch-Poster-2.fig', cover, '--project', projectId);
    expect(coverRun.out).toMatchObject({ source: 'thumbnail' });
    expect(await readFile(cover)).toEqual(makePng(3, 3));
    const noCover = await run('cover', 'designs/Launch-Poster.fig', path.join(workDir, 'none.png'), '--project', projectId);
    expect(noCover.code).toBe(1);
    expect(JSON.parse(noCover.err)).toMatchObject({ code: 'NOT_FOUND' });

    const legacyBytes = await makeFig({ canvas: 'cli-legacy' });
    const seeded = await fetch(`${baseUrl}/api/design-canvas/documents/cli-legacy-1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(legacyInput('Old Board', legacyBytes)),
    });
    expect(seeded.status).toBe(200);
    const dry = await run('migrate', '--all', '--project', projectId, '--dry-run');
    expect(dry.out.documents.map((doc: { id: string }) => doc.id)).toContain('cli-legacy-1');
    const migrated = await run('migrate', 'cli-legacy-1', '--project', projectId);
    expect(migrated.out).toMatchObject({ alreadyImported: false, design: { path: 'designs/Old-Board.fig' } });
    const ledger = await run('migrations');
    expect(ledger.out.migrations).toEqual(expect.arrayContaining([expect.objectContaining({ legacyId: 'cli-legacy-1', projectId })]));
    const dryAfter = await run('migrate', '--all', '--project', projectId, '--dry-run');
    expect(dryAfter.out.documents.map((doc: { id: string }) => doc.id)).not.toContain('cli-legacy-1');

    expect((await run('list', '--project', 'proj-designs-cli-missing')).code).toBe(CANVAS_EXIT_CODES.projectNotFound);
  });
});
