// `/api/materials/*` over the real daemon HTTP boundary (startServer), with
// FANTASY_DESIGN_LIBRARY pointed at a temp copy of the synthetic fixture.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MATERIAL_NOTICE } from '@open-design/contracts';
import type {
  MaterialApplyResponse,
  MaterialContextResponse,
  MaterialDetailResponse,
  MaterialErrorResponse,
  MaterialSearchResponse,
  MaterialSummaryResponse,
  MaterialLibrary,
  MaterialLibrariesResponse,
} from '@open-design/contracts';
import { startServer } from '../src/server.js';
import { SONNER_DIR, createMaterialsFixture, writeFixtureIndex, type MaterialsFixture } from './fixtures/materials-library/fixture.js';

const ENV = 'FANTASY_DESIGN_LIBRARY';

let server: http.Server;
let baseUrl: string;
let fixture: MaterialsFixture;
const previousEnv = process.env[ENV];
const projectsToClean: string[] = [];
const tempDirs: string[] = [];

beforeAll(async () => {
  fixture = createMaterialsFixture();
  process.env[ENV] = fixture.root;
  const started = (await startServer({ port: 0, returnServer: true })) as { url: string; server: http.Server };
  baseUrl = started.url;
  server = started.server;
});

afterAll(async () => {
  for (const id of projectsToClean.splice(0)) {
    await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = previousEnv;
  fixture.cleanup();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function getJson<T>(pathname: string): Promise<{ status: number; body: T; headers: Headers }> {
  const resp = await fetch(`${baseUrl}${pathname}`);
  return { status: resp.status, body: (await resp.json()) as T, headers: resp.headers };
}

async function postJson<T>(pathname: string, body: unknown): Promise<{ status: number; body: T }> {
  const resp = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: (await resp.json()) as T };
}

function expectError(result: { status: number; body: unknown }, status: number, code: string): void {
  expect(result.status).toBe(status);
  const body = result.body as MaterialErrorResponse;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function createProject(): Promise<string> {
  const id = `materials-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resp = await postJson<{ project: { id: string } }>('/api/projects', { id, name: id });
  expect(resp.status).toBe(200);
  projectsToClean.push(resp.body.project.id);
  return resp.body.project.id;
}

async function importFolder(baseDir: string): Promise<string> {
  const resp = await postJson<{ project: { id: string } }>('/api/import/folder', { baseDir, name: 'materials-import' });
  expect(resp.status).toBe(200);
  projectsToClean.push(resp.body.project.id);
  return resp.body.project.id;
}

async function projectDirOf(projectId: string): Promise<string> {
  const resp = await getJson<{ project: { metadata?: { baseDir?: string } } }>(`/api/projects/${projectId}`);
  expect(resp.status).toBe(200);
  const baseDir = resp.body.project.metadata?.baseDir;
  return baseDir ?? path.join(process.env.OD_DATA_DIR!, 'projects', projectId);
}

describe('GET /api/materials/summary', () => {
  it('reports status and counts', async () => {
    const { status, body } = await getJson<MaterialSummaryResponse>('/api/materials/summary');
    expect(status).toBe(200);
    expect(body.status).toMatchObject({ enabled: true, root: fixture.root, rootSource: 'env' });
    expect(Date.parse(body.status.indexUpdatedAt!)).not.toBeNaN();
    expect(body.total).toBe(13);
    expect(body.kinds).toEqual({ component: 3, file: 3, markdown: 3, style: 1, svg: 2, website: 1 });
    expect(Object.keys(body.categories)).toEqual(['svg', '交互组件', '收藏网站', '文档', '测试', '风格参考']);
    expect(body.notice).toBe(MATERIAL_NOTICE);
  });

  it('stays 200 with a reason when the library is unavailable', async () => {
    process.env[ENV] = path.join(fixture.parent, 'missing-library');
    try {
      const summary = await getJson<MaterialSummaryResponse>('/api/materials/summary');
      expect(summary.status).toBe(200);
      expect(summary.body).toMatchObject({ total: 0, status: { enabled: false, reason: 'missing-root', rootSource: 'env' } });
      expectError(await getJson('/api/materials/items?q=x'), 503, 'library-unavailable');
      expectError(await getJson('/api/materials/items/sonner'), 503, 'library-unavailable');
      expectError(await postJson('/api/materials/context', { ids: ['sonner'] }), 503, 'library-unavailable');
    } finally {
      process.env[ENV] = fixture.root;
    }
  });

  it('reports an invalid index', async () => {
    const broken = createMaterialsFixture();
    tempDirs.push(broken.parent);
    writeFixtureIndex(broken.root, { schema_version: 99, assets: [] });
    process.env[ENV] = broken.root;
    try {
      const summary = await getJson<MaterialSummaryResponse>('/api/materials/summary');
      expect(summary.body.status).toMatchObject({ enabled: false, reason: 'invalid-index', root: broken.root });
      expectError(await getJson('/api/materials/items'), 503, 'library-unavailable');
    } finally {
      process.env[ENV] = fixture.root;
    }
  });
});

describe('GET /api/materials/items', () => {
  it('ranks, filters and paginates', async () => {
    const q = encodeURIComponent('通知');
    const { status, body } = await getJson<MaterialSearchResponse>(`/api/materials/items?q=${q}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ query: '通知', total: 4, offset: 0, returned: 4, nextOffset: null, notice: MATERIAL_NOTICE });
    expect(body.items.map((item) => item.id)).toEqual(['sonner-toast', 'sonner', 'icon-bell', 'website-0123456789abcdef']);
    expect(body.items[1]).toMatchObject({ thumbnailUrl: '/api/materials/items/sonner/thumbnail', previewKind: 'interactive' });

    const page = await getJson<MaterialSearchResponse>('/api/materials/items?limit=2&offset=2&kind=component');
    expect(page.body).toMatchObject({ total: 3, offset: 2, returned: 1, nextOffset: null });
    const first = await getJson<MaterialSearchResponse>('/api/materials/items?limit=2');
    expect(first.body).toMatchObject({ total: 13, returned: 2, nextOffset: 2 });
    const cat = await getJson<MaterialSearchResponse>(`/api/materials/items?category=${encodeURIComponent('风格参考')}`);
    expect(cat.body.items.map((item) => item.id)).toEqual(['glass-terse']);
  });

  it.each(['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'offset=1.5', 'q=a&q=b'])('rejects %s', async (query) => {
    expectError(await getJson(`/api/materials/items?${query}`), 400, 'invalid-request');
  });
});

describe('GET /api/materials/items/:id', () => {
  it('returns a detail with files and children', async () => {
    const { status, body } = await getJson<MaterialDetailResponse>('/api/materials/items/sonner');
    expect(status).toBe(200);
    expect(body.item).toMatchObject({
      id: 'sonner',
      absolutePath: path.join(fixture.root, SONNER_DIR, 'upstream/src/index.tsx'),
      collectionRoot: path.join(fixture.root, SONNER_DIR),
      children: ['sonner-toast'],
    });
    expect(body.item.files).toHaveLength(5);
    expect(body.notice).toBe(MATERIAL_NOTICE);
  });

  it('returns 404 for unknown ids and 403 for unsafe indexed paths', async () => {
    expectError(await getJson('/api/materials/items/nope'), 404, 'unknown-id');
    for (const id of ['unsafe-dotdot', 'unsafe-absolute', 'symlink-escape']) {
      expectError(await getJson(`/api/materials/items/${id}`), 403, 'unsafe-path');
    }
  });
});

describe('GET /api/materials/items/:id/thumbnail', () => {
  it('streams a PNG with private caching and nosniff', async () => {
    const resp = await fetch(`${baseUrl}/api/materials/items/sonner/thumbnail`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('image/png');
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
    expect(resp.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(resp.headers.get('content-security-policy')).toBeNull();
    const bytes = Buffer.from(await resp.arrayBuffer());
    expect(bytes.equals(readFileSync(path.join(fixture.root, SONNER_DIR, 'references/preview.png')))).toBe(true);
  });

  it('sandboxes SVG with a strict CSP', async () => {
    const resp = await fetch(`${baseUrl}/api/materials/items/icon-bell/thumbnail`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('image/svg+xml');
    expect(resp.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await resp.text()).toContain('<svg');
  });

  it('refuses symlinks, non-images, missing thumbnails and unknown ids', async () => {
    expectError(await getJson('/api/materials/items/symlink-escape/thumbnail'), 403, 'unsafe-path');
    expectError(await getJson('/api/materials/items/notes-md-thumb/thumbnail'), 403, 'unsafe-path');
    expectError(await getJson('/api/materials/items/sonner-toast/thumbnail'), 404, 'missing-file');
    expectError(await getJson('/api/materials/items/nope/thumbnail'), 404, 'unknown-id');
    const unsafe = await fetch(`${baseUrl}/api/materials/items/symlink-escape/thumbnail`);
    expect(unsafe.headers.get('cache-control')).toBeNull();
  });
});

describe('POST /api/materials/context', () => {
  it('renders the markdown packet', async () => {
    const { status, body } = await postJson<MaterialContextResponse>('/api/materials/context', {
      ids: ['sonner', 'icon-bell', 'sonner'],
      task: '为设置页设计通知',
    });
    expect(status).toBe(200);
    expect(body.ids).toEqual(['sonner', 'icon-bell']);
    expect(body.markdown.startsWith('# Fantasy Design 设计参考包\n\n为设置页设计通知\n\n## Sonner · 通知反馈 (`sonner`)')).toBe(true);
    expect(body.markdown.endsWith(MATERIAL_NOTICE)).toBe(true);
  });

  it.each([
    [{}, 400, 'invalid-request'],
    [{ ids: 'sonner' }, 400, 'invalid-request'],
    [{ ids: [] }, 400, 'invalid-request'],
    [{ ids: ['sonner'], task: 5 }, 400, 'invalid-request'],
    [{ ids: Array.from({ length: 21 }, (_, i) => `x${i}`) }, 400, 'invalid-request'],
    [{ ids: ['nope'] }, 404, 'unknown-id'],
  ])('rejects %j', async (body, status, code) => {
    expectError(await postJson('/api/materials/context', body), status, code);
  });
});

describe('POST /api/materials/items/:id/apply', () => {
  it('copies the entry, thumbnail and provenance with a receipt, suffixing repeats', async () => {
    const projectId = await createProject();
    const first = await postJson<MaterialApplyResponse>('/api/materials/items/sonner/apply', { projectId });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      id: 'sonner',
      projectId,
      dir: 'references/sonner',
      attachments: ['references/sonner/references/preview.png', 'references/sonner/upstream/src/index.tsx'],
      receiptRelPath: 'references/sonner/fantasy-design-receipt.json',
      notice: MATERIAL_NOTICE,
    });
    expect(first.body.files.map((file) => file.relPath)).toEqual([
      'references/sonner/README.md',
      'references/sonner/THIRD_PARTY_NOTICES.md',
      'references/sonner/references/preview.png',
      'references/sonner/references/source-manifest.json',
      'references/sonner/upstream/src/index.tsx',
    ]);

    const dir = await projectDirOf(projectId);
    for (const file of first.body.files) {
      const copied = path.join(dir, file.relPath);
      expect(sha256(copied)).toBe(file.sha256);
      const source = path.join(fixture.root, SONNER_DIR, file.relPath.replace('references/sonner/', ''));
      expect(sha256(source)).toBe(file.sha256);
    }
    const receipt = JSON.parse(readFileSync(path.join(dir, first.body.receiptRelPath), 'utf8'));
    expect(receipt).toMatchObject({
      schema_version: 1,
      created_by: 'fantay-studio',
      id: 'sonner',
      source_library_root: fixture.root,
      project_id: projectId,
      destination: 'references/sonner',
      notice: MATERIAL_NOTICE,
      dependencies_resolved: false,
      asset: { id: 'sonner', license: 'MIT · Emil Kowalski' },
    });
    expect(receipt.files).toHaveLength(5);
    expect(receipt.files[0]).toEqual({
      source_relative_path: `${SONNER_DIR}/README.md`,
      relative_path: 'README.md',
      bytes: first.body.files[0]!.bytes,
      sha256: first.body.files[0]!.sha256,
    });
    expect(receipt.asset.origins).toBeUndefined();

    const second = await postJson<MaterialApplyResponse>('/api/materials/items/sonner/apply', { projectId });
    expect(second.body.dir).toBe('references/sonner-2');
    const third = await postJson<MaterialApplyResponse>('/api/materials/items/sonner/apply', { projectId, dir: 'design/refs' });
    expect(third.body.dir).toBe('design/refs/sonner');

    // The project file listing (what the web UI reads) sees the copy.
    const listed = await getJson<{ files: Array<{ path?: string; name?: string }> }>(`/api/projects/${projectId}/files`);
    const names = listed.body.files.map((file) => file.path ?? file.name);
    expect(names).toContain('references/sonner/upstream/src/index.tsx');
    expect(names).toContain('references/sonner-2/fantasy-design-receipt.json');
  });

  it('copies a collection directory without hidden or dependency files', async () => {
    const projectId = await createProject();
    const result = await postJson<MaterialApplyResponse>('/api/materials/items/sonner/apply', {
      projectId,
      files: ['upstream'],
      fields: ['document'],
    });
    expect(result.status).toBe(200);
    expect(result.body.files.map((file) => file.relPath.replace('references/sonner/', ''))).toEqual([
      'README.md',
      'THIRD_PARTY_NOTICES.md',
      'references/source-manifest.json',
      'upstream/LICENSE.md',
      'upstream/package.json',
      'upstream/src/index.tsx',
      'upstream/src/state.ts',
    ]);
    expect(result.body.attachments).toEqual(['references/sonner/upstream/src/index.tsx']);
  });

  it('attaches an SVG icon once when entry and thumbnail are the same file', async () => {
    const projectId = await createProject();
    const result = await postJson<MaterialApplyResponse>('/api/materials/items/icon-bell/apply', { projectId });
    expect(result.status).toBe(200);
    expect(result.body.files.map((file) => file.relPath)).toEqual([
      'references/icon-bell/LICENSE',
      'references/icon-bell/icons/bell.svg',
    ]);
    expect(result.body.attachments).toEqual(['references/icon-bell/icons/bell.svg']);
  });

  it('honors metadata.baseDir for imported-folder projects', async () => {
    const baseDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'od-materials-import-')));
    tempDirs.push(baseDir);
    const projectId = await importFolder(baseDir);
    const result = await postJson<MaterialApplyResponse>('/api/materials/items/hand-checklist/apply', { projectId });
    expect(result.status).toBe(200);
    expect(result.body.files.map((file) => file.relPath)).toEqual(['references/hand-checklist/手绘清单.md']);
    expect(existsSync(path.join(baseDir, 'references/hand-checklist/手绘清单.md'))).toBe(true);
    expect(existsSync(path.join(baseDir, 'references/hand-checklist/fantasy-design-receipt.json'))).toBe(true);
  });

  it('never writes inside the library, even for a project imported from it', async () => {
    const inside = path.join(fixture.root, '杂项/imported-project');
    mkdirSync(inside, { recursive: true });
    const projectId = await importFolder(inside);
    expectError(await postJson('/api/materials/items/sonner/apply', { projectId }), 403, 'unsafe-path');
    expect(readdirSync(inside)).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('never writes inside the library through a firmlink alias of it', async () => {
    // realpath keeps /System/Volumes/Data/…, so the guard also compares device + inode.
    const inside = path.join(fixture.root, '杂项/firmlink-project');
    mkdirSync(inside, { recursive: true });
    const alias = `/System/Volumes/Data${inside}`;
    if (!existsSync(alias)) return;
    const projectId = await importFolder(alias);
    expectError(await postJson('/api/materials/items/hand-checklist/apply', { projectId }), 403, 'unsafe-path');
    expect(readdirSync(inside)).toEqual([]);
  });

  it('rejects website bookmarks, unknown ids and unknown projects', async () => {
    const projectId = await createProject();
    expectError(await postJson('/api/materials/items/website-0123456789abcdef/apply', { projectId }), 400, 'not-copyable');
    expectError(await postJson('/api/materials/items/nope/apply', { projectId }), 404, 'unknown-id');
    expectError(await postJson('/api/materials/items/sonner/apply', { projectId: 'no-such-project' }), 404, 'project-not-found');
    expectError(await postJson('/api/materials/items/sonner/apply', {}), 400, 'invalid-request');
  });

  it.each([
    [{ files: ['many'] }, 413, 'copy-limit'],
    [{ files: ['big'] }, 413, 'copy-limit'],
    [{ files: ['evil'] }, 403, 'unsafe-path'],
    [{ files: ['../Vaul-抽屉'] }, 403, 'unsafe-path'],
    [{ fields: ['bogus'] }, 400, 'invalid-request'],
    [{ dir: '../outside' }, 400, 'invalid-request'],
    [{ dir: 5 }, 400, 'invalid-request'],
  ])('rejects %j without leaving a copy', async (selection, status, code) => {
    const projectId = await createProject();
    expectError(await postJson('/api/materials/items/sonner/apply', { projectId, ...selection }), status, code);
    expect(existsSync(path.join(await projectDirOf(projectId), 'references/sonner'))).toBe(false);
  });
});

describe('material library connections over HTTP', () => {
  it('adds two libraries and resolves selected records through detail, thumbnail and copy routes', async () => {
    const other = createMaterialsFixture();
    const connected: string[] = [];
    try {
      for (const [root, name] of [[fixture.root, 'Primary'], [other.root, 'Secondary']]) {
        const added = await postJson<{ library: MaterialLibrary }>('/api/materials/libraries', { root, name });
        expect(added.status).toBe(200);
        connected.push(added.body.library.id);
      }
      const listed = await getJson<MaterialLibrariesResponse>('/api/materials/libraries');
      expect(listed.body.libraries.map((library) => library.id)).toEqual(connected);
      const selected = await getJson<MaterialSearchResponse>(`/api/materials/items?libraryId=${connected[1]}&q=sonner`);
      expect(selected.status).toBe(200);
      expect(selected.body.items.every((item) => item.libraryId === connected[1])).toBe(true);
      const id = `${connected[1]}:sonner`;
      const detail = await getJson<MaterialDetailResponse>(`/api/materials/items/${encodeURIComponent(id)}`);
      expect(detail.body.item.absolutePath.startsWith(other.root)).toBe(true);
      const thumbnail = await fetch(`${baseUrl}${detail.body.item.thumbnailUrl}`);
      expect(thumbnail.status).toBe(200);
      await thumbnail.arrayBuffer();
      const projectId = await createProject();
      const applied = await postJson<MaterialApplyResponse>(`/api/materials/items/${encodeURIComponent(id)}/apply`, { projectId });
      expect(applied.status).toBe(200);
      expect(applied.body.id).toBe(id);
      const global = await getJson<MaterialSummaryResponse>('/api/materials/summary');
      const scoped = await getJson<MaterialSummaryResponse>(`/api/materials/summary?libraryId=${connected[1]}`);
      expect(global.body.total).toBe(scoped.body.total * 2);
    } finally {
      for (const id of connected) {
        const response = await fetch(`${baseUrl}/api/materials/libraries/${id}`, { method: 'DELETE' });
        expect(response.status).toBe(200);
      }
      expect(existsSync(other.root)).toBe(true);
      other.cleanup();
    }
  });
});
