import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import type { JianyingEnvironment } from '@open-design/contracts';
import { registerJianyingRoutes, type RegisterJianyingRoutesDeps } from '../../src/routes/jianying.js';
import { JianyingService } from '../../src/jianying/service.js';
import { runJianying } from '../../src/jianying/cli.js';

afterEach(() => { vi.restoreAllMocks(); process.exitCode = 0; });
it('runs creation and copy editing through the public CLI and the same authorized HTTP routes', async () => {
  const parent = path.resolve('.tmp'); await mkdir(parent, { recursive: true }); const dir = await mkdtemp(path.join(parent, 'jianying-route-'));
  const app = express(); app.use(express.json());
  const environment = { platform: 'darwin', application: { installed: false }, compatibility: 'not-installed', messages: [], native: { available: false } } as unknown as JianyingEnvironment;
  const service = new JianyingService({ resourceDir: fileURLToPath(new URL('../../../../vendor/jianying-draft', import.meta.url)), dataDir: path.join(dir, 'runtime') }, async () => environment);
  const authorize = vi.fn(async () => true);
  registerJianyingRoutes(app, { db: {}, paths: { PROJECTS_DIR: dir }, projectStore: { getProject: () => ({ metadata: {} }) }, projectFiles: { resolveProjectDir: () => dir }, authorizeProjectRequest: authorize,
    http: { requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(), sendApiError: (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }) }, jianying: service,
  } as unknown as RegisterJianyingRoutesDeps);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const plan = path.join(dir, 'plan.json'); await writeFile(plan, JSON.stringify({ name: 'CLI draft', clips: [{ type: 'text', text: 'Original', duration: 2 }] }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runJianying(['create', '--project', 'fixed', '--file', plan, '--daemon-url', base, '--json']);
    const created = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(created.validation.valid).toBe(true); expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'fixed', { mode: 'write', capability: 'writeFiles' });
    const operations = path.join(dir, 'operations.json'); await writeFile(operations, JSON.stringify([{ op: 'set_text', segmentId: created.inspection.tracks[0].segments[0].id, text: 'Edited' }]));
    await runJianying(['edit', '--project', 'fixed', '--draft', created.draft.id, '--file', operations, '--daemon-url', base, '--json']);
    const edited = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(edited.sourcePreserved).toBe(true); expect(edited.draft.id).not.toBe(created.draft.id); expect(edited.inspection.tracks[0].segments[0].text).toBe('Edited');
    const source = await service.inspect(dir, created.draft.id); expect(source.inspection.tracks[0]!.segments[0]!.text).toBe('Original');
    expect(process.exitCode ?? 0).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

it('stops a denied project write before invoking the draft service', async () => {
  const app = express(); app.use(express.json()); const create = vi.fn(), list = vi.fn();
  const authorize = vi.fn(async (_req: unknown, res: express.Response) => { res.status(403).json({ error: { code: 'DENIED' } }); return false; });
  registerJianyingRoutes(app, { db: {}, paths: {}, projectStore: {}, projectFiles: {}, authorizeProjectRequest: authorize, http: { requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(), sendApiError: () => {} }, jianying: { create, list } } as unknown as RegisterJianyingRoutesDeps);
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/projects/fixed/jianying`;
    const response = await fetch(base + '/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); expect(response.status).toBe(403); expect(create).not.toHaveBeenCalled();
    const external = await fetch(base + '/drafts?local=true', { headers: { 'x-fantay-local-drafts': '1' } });
    expect(external.status).toBe(403); expect(list).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'fixed', { mode: 'write', capability: 'writeFiles' });
  }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
