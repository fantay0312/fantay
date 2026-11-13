// Contract test for `od materials`: the CLI drives the same /api/materials/*
// endpoints as the web UI (AGENTS.md "Capability exposure"), with --json,
// --prompt-file <path|->, and structured errors.
//
// A stub HTTP server captures requests. Most cases call `runMaterialsCli`
// in-process; a few spawn `src/cli.ts` through tsx to prove SUBCOMMAND_MAP
// routing, the root help line and process exit codes.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MATERIAL_NOTICE } from '@open-design/contracts';
import { MATERIALS_USAGE } from '../src/cli-help/materials-cli-help.js';
import { runMaterialsCli, type MaterialsCliIo } from '../src/materials/materials-cli.js';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = path.resolve(here, '..');
const REPO_ROOT = path.resolve(here, '../../..');
const CLI_SRC = path.resolve(here, '../src/cli.ts');
const TSX_CLI = path.resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface Captured {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

let server: http.Server;
let baseUrl: string;
let unreachableUrl: string;
const requests: Captured[] = [];
let responder: (req: Captured) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
const tempDirs: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const captured = { method: req.method ?? '', url: req.url ?? '', body: raw, headers: req.headers };
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
  responder = () => ({ status: 200, body: {} });
});

function memoryIo(stdin = ''): MaterialsCliIo & { out: string; err: string } {
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

const searchBody = {
  query: '通知',
  total: 2,
  offset: 0,
  returned: 2,
  nextOffset: null,
  items: [
    { id: 'sonner-toast', kind: 'component', category: '交互组件', title: 'Toast' },
    { id: 'sonner', kind: 'component', category: '交互组件', title: 'Sonner · 通知反馈' },
  ],
  notice: MATERIAL_NOTICE,
};

describe('od materials (in-process)', () => {
  it('manages library connections and forwards a selected library to search', async () => {
    const io = memoryIo();
    const library = { id: 'library_a', name: 'My references', root: '/tmp/materials', total: 2, status: { enabled: true } };
    responder = () => ({ status: 200, body: { libraries: [library], library, ok: true } });
    expect((await runMaterialsCli(['libraries', '--json', '--daemon-url', baseUrl], io)).exitCode).toBe(0);
    expect((await runMaterialsCli(['add-library', '/tmp/materials', '--name', 'My references', '--json', '--daemon-url', baseUrl], io)).exitCode).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', url: '/api/materials/libraries' });
    expect(JSON.parse(requests.at(-1)!.body)).toEqual({ root: '/tmp/materials', name: 'My references' });
    responder = () => ({ status: 200, body: searchBody });
    expect((await runMaterialsCli(['search', '--library', 'library_a', '--json', '--daemon-url', baseUrl], io)).exitCode).toBe(0);
    expect(requests.at(-1)!.url).toBe('/api/materials/items?libraryId=library_a');
    responder = () => ({ status: 200, body: { ok: true } });
    expect((await runMaterialsCli(['remove-library', 'library_a', '--json', '--daemon-url', baseUrl], io)).exitCode).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/materials/libraries/library_a' });
  });
  it('search maps positionals and filters onto GET /api/materials/items', async () => {
    responder = () => ({ status: 200, body: searchBody });
    const io = memoryIo();
    const result = await runMaterialsCli(
      ['search', 'React', '通知', '--kind', 'component', '--category=交互组件', '--section', '反馈', '--limit', '5', '--offset', '0', '--daemon-url', `${baseUrl}/`],
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url, baseUrl);
    expect(requests[0]!.method).toBe('GET');
    expect(url.pathname).toBe('/api/materials/items');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'React 通知',
      kind: 'component',
      category: '交互组件',
      section: '反馈',
      limit: '5',
      offset: '0',
    });
    expect(io.out).toContain('2 matches for "通知"; showing 1-2');
    expect(io.out).toContain('sonner\tcomponent\t交互组件\tSonner · 通知反馈');
    expect(io.out.trimEnd().endsWith(MATERIAL_NOTICE)).toBe(true);
  });

  it('--json prints the daemon payload as pretty JSON', async () => {
    responder = () => ({ status: 200, body: searchBody });
    const io = memoryIo();
    expect((await runMaterialsCli(['search', '--json', '--daemon-url', baseUrl], io)).exitCode).toBe(0);
    expect(io.out).toBe(`${JSON.stringify(searchBody, null, 2)}\n`);
    expect(new URL(requests[0]!.url, baseUrl).search).toBe('');
  });

  it('summary prints status and counts', async () => {
    responder = () => ({
      status: 200,
      body: {
        status: { enabled: true, root: '/lib/素材库', rootSource: 'env', indexUpdatedAt: '2026-10-25T00:00:00.000Z' },
        total: 3,
        categories: { svg: 2, 交互组件: 1 },
        kinds: { svg: 2, component: 1 },
        collections: { demo: 3 },
        notice: MATERIAL_NOTICE,
      },
    });
    const io = memoryIo();
    expect((await runMaterialsCli(['summary', '--daemon-url', baseUrl], io)).exitCode).toBe(0);
    expect(requests[0]!.url).toBe('/api/materials/summary');
    expect(io.out).toContain('Material library: /lib/素材库 (env)');
    expect(io.out).toContain('Records: 3');
    expect(io.out).toContain('  交互组件\t1');

    responder = () => ({
      status: 200,
      body: {
        status: { enabled: false, root: null, rootSource: null, reason: 'not-configured', message: 'Set it.' },
        total: 0,
        categories: {},
        kinds: {},
        collections: {},
        notice: MATERIAL_NOTICE,
      },
    });
    const off = memoryIo();
    expect((await runMaterialsCli(['summary', '--daemon-url', baseUrl], off)).exitCode).toBe(0);
    expect(off.out).toContain('Material library unavailable (not-configured): Set it.');
  });

  it('show encodes the id and prints files with missing markers', async () => {
    responder = () => ({
      status: 200,
      body: {
        item: {
          id: '昼屿',
          title: '昼屿',
          kind: 'style',
          category: '风格参考',
          collection: '风格参考',
          description: 'd',
          license: 'CC0',
          absolutePath: '/lib/素材库/a/README.md',
          collectionRoot: '/lib/素材库/a',
          files: [
            { field: 'path', relativePath: 'a/README.md', absolutePath: '/lib/素材库/a/README.md', exists: true },
            { field: 'tokens', relativePath: 'a/tokens.json', absolutePath: '/lib/素材库/a/tokens.json', exists: false },
          ],
          children: [],
        },
        notice: MATERIAL_NOTICE,
      },
    });
    const io = memoryIo();
    expect((await runMaterialsCli(['show', '昼屿', '--daemon-url', baseUrl], io)).exitCode).toBe(0);
    expect(requests[0]!.url).toBe(`/api/materials/items/${encodeURIComponent('昼屿')}`);
    expect(io.out).toContain('  tokens\t/lib/素材库/a/tokens.json [missing]');
    expect(io.out).toContain('Collection root: /lib/素材库/a');
  });

  it('context posts ids and the task from --task, --prompt-file <path> or stdin', async () => {
    responder = () => ({ status: 200, body: { ids: ['sonner'], markdown: '# Fantasy Design 设计参考包\n\nT', notice: MATERIAL_NOTICE } });
    const io = memoryIo();
    expect((await runMaterialsCli(['context', 'sonner', 'vaul', '--task', '设置页', '--daemon-url', baseUrl], io)).exitCode).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/materials/context' });
    expect(JSON.parse(requests[0]!.body)).toEqual({ ids: ['sonner', 'vaul'], task: '设置页' });
    expect(io.out).toBe('# Fantasy Design 设计参考包\n\nT\n');

    const dir = mkdtempSync(path.join(tmpdir(), 'od-materials-cli-'));
    tempDirs.push(dir);
    const promptFile = path.join(dir, 'task.md');
    writeFileSync(promptFile, '为移动端\n抽屉设计\n\n');
    await runMaterialsCli(['context', 'vaul', '--prompt-file', promptFile, '--daemon-url', baseUrl], memoryIo());
    expect(JSON.parse(requests[1]!.body)).toEqual({ ids: ['vaul'], task: '为移动端\n抽屉设计' });

    await runMaterialsCli(['context', 'vaul', '--prompt-file', '-', '--json', '--daemon-url', baseUrl], memoryIo('来自 stdin\n'));
    expect(JSON.parse(requests[2]!.body)).toEqual({ ids: ['vaul'], task: '来自 stdin' });

    const both = memoryIo();
    expect((await runMaterialsCli(['context', 'vaul', '--task', 'a', '--prompt-file', '-', '--daemon-url', baseUrl], both)).exitCode).toBe(2);
    expect(JSON.parse(both.err).error.code).toBe('invalid-request');
  });

  it('apply posts the project, dir, repeated fields and files', async () => {
    responder = () => ({
      status: 200,
      body: {
        id: 'sonner',
        projectId: 'p1',
        dir: 'refs/sonner',
        files: [{ relPath: 'refs/sonner/README.md', bytes: 10, sha256: 'a'.repeat(64) }],
        attachments: ['refs/sonner/README.md'],
        receiptRelPath: 'refs/sonner/fantasy-design-receipt.json',
        notice: MATERIAL_NOTICE,
      },
    });
    const io = memoryIo();
    const result = await runMaterialsCli(
      ['apply', 'sonner', '--project', 'p1', '--dir', 'refs', '--field', 'path', '--field', 'document', '--file', 'upstream/src', '--daemon-url', baseUrl],
      io,
    );
    expect(result.exitCode).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/materials/items/sonner/apply' });
    expect(JSON.parse(requests[0]!.body)).toEqual({
      projectId: 'p1',
      dir: 'refs',
      fields: ['path', 'document'],
      files: ['upstream/src'],
    });
    expect(io.out).toContain('Copied 1 file into refs/sonner (project p1)');
    expect(io.out).toContain('Receipt: refs/sonner/fantasy-design-receipt.json');
    expect(requests[0]!.headers['x-od-workspace-id']).toBeUndefined();

    // Team-shared projects: the workspace pair travels as headers, as with `od library apply`.
    await runMaterialsCli(
      ['apply', 'sonner', '--project', 'p1', '--workspace', 'w1', '--workspace-member', 'm1', '--daemon-url', baseUrl],
      memoryIo(),
    );
    expect(requests[1]!.headers).toMatchObject({ 'x-od-workspace-id': 'w1', 'x-od-workspace-member-id': 'm1' });
    // Empty values (an unbound local run) mean no workspace.
    await runMaterialsCli(
      ['apply', 'sonner', '--project', 'p1', '--workspace', '', '--workspace-member', '', '--daemon-url', baseUrl],
      memoryIo(),
    );
    expect(requests[2]!.headers['x-od-workspace-id']).toBeUndefined();
  });

  it('turns daemon error envelopes into structured stderr and exit codes', async () => {
    responder = () => ({ status: 503, body: { error: { code: 'library-unavailable', message: 'no library' } } });
    const unavailable = memoryIo();
    expect((await runMaterialsCli(['search', 'x', '--daemon-url', baseUrl], unavailable)).exitCode).toBe(1);
    expect(JSON.parse(unavailable.err)).toEqual({
      error: { code: 'library-unavailable', message: 'no library', data: { status: 503 } },
    });
    expect(unavailable.out).toBe('');

    responder = () => ({ status: 404, body: { error: { code: 'project-not-found', message: 'Project not found: p' } } });
    const missingProject = memoryIo();
    expect((await runMaterialsCli(['apply', 'sonner', '--project', 'p', '--daemon-url', baseUrl], missingProject)).exitCode).toBe(68);
    expect(JSON.parse(missingProject.err).error.code).toBe('project-not-found');
  });

  it('reports usage errors with exit code 2 before calling the daemon', async () => {
    for (const args of [
      ['apply', 'sonner'],
      ['show'],
      ['show', 'a', 'b'],
      ['context'],
      ['bogus'],
      ['search', '--nope', 'x'],
      ['search', '--limit'],
      ['apply', 'sonner', '--project', 'p1', '--workspace', 'w1'],
    ]) {
      const io = memoryIo();
      const result = await runMaterialsCli([...args, '--daemon-url', baseUrl], io);
      expect(result.exitCode, args.join(' ')).toBe(2);
      expect(JSON.parse(io.err).error.code).toBe('invalid-request');
    }
    expect(requests).toHaveLength(0);
    const help = memoryIo();
    expect((await runMaterialsCli(['--help'], help)).exitCode).toBe(0);
    expect(help.out).toBe(`${MATERIALS_USAGE}\n`);
  });

  it('exits 64 with daemon-not-running when the daemon is unreachable', async () => {
    const io = memoryIo();
    const result = await runMaterialsCli(['summary', '--daemon-url', unreachableUrl], io);
    expect(result.exitCode).toBe(64);
    expect(JSON.parse(io.err.trim()).error.code).toBe('daemon-not-running');
  });
});

async function runOd(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.OD_DAEMON_URL;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
  }
}

describe('od materials (through cli.ts)', () => {
  it('is routed by SUBCOMMAND_MAP and flushes a > 64 KiB --json payload to a pipe before exiting', async () => {
    const items = Array.from({ length: 400 }, (_, index) => ({
      id: `item-${index}`,
      kind: 'component',
      category: '交互组件',
      title: `Item ${index}`,
      description: '素材'.repeat(200),
    }));
    const big = { ...searchBody, total: items.length, returned: items.length, items };
    responder = () => ({ status: 200, body: big });
    const result = await runOd(['materials', 'search', '通知', '--json', '--daemon-url', baseUrl]);
    expect(result.code).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(result.stdout)).toEqual(big);
    expect(new URL(requests[0]!.url, baseUrl).searchParams.get('q')).toBe('通知');
  }, 40_000);
});
