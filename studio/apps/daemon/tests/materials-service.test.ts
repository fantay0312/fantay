// Materials domain without HTTP: root resolution, index validation and
// caching, ranking parity with the archive's `discovery.py`, DTO mapping,
// path safety, the context packet and copy planning.
//
// Ranking expectations were produced by running the archive's own
// `discovery.score` + `fantasy-design search` sort key over the fixture index
// (`tests/fixtures/materials-library/素材库/导览支持/search-index.json`).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { appendFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MATERIAL_NOTICE } from '@open-design/contracts';
import { planMaterialCopy } from '../src/materials/copy.js';
import {
  compareCodePoints,
  normalizeMaterialText,
  scoreMaterial,
  splitMaterialQuery,
} from '../src/materials/discovery.js';
import { MaterialError } from '../src/materials/errors.js';
import { resolveMaterialLibraryRoot } from '../src/materials/root.js';
import { createMaterialsService, sniffRasterImageType, type MaterialsService } from '../src/materials/service.js';
import {
  SONNER_DIR,
  createMaterialsFixture,
  readFixtureIndex,
  writeFixtureIndex,
  type MaterialsFixture,
} from './fixtures/materials-library/fixture.js';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/materials-library/context-golden.md');

function serviceFor(root: string, dataRoots: string[] = ['/nonexistent-od-data']): MaterialsService {
  return createMaterialsService({
    env: { FANTASY_DESIGN_LIBRARY: root },
    projectRoot: null,
    packaged: false,
    dataRoots,
  });
}

async function rejection(promise: Promise<unknown>): Promise<MaterialError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MaterialError);
    return error as MaterialError;
  }
  throw new Error('expected a MaterialError');
}

async function searchIds(service: MaterialsService, q: string, extra: Record<string, unknown> = {}) {
  const result = await service.search({ q, limit: 100, ...extra });
  return result.items.map((item) => item.id);
}

let fixture: MaterialsFixture;
let service: MaterialsService;

beforeAll(() => {
  fixture = createMaterialsFixture();
  service = serviceFor(fixture.root);
});

afterAll(() => fixture.cleanup());

describe('material library root resolution', () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });
  const temp = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'od-materials-root-')));
    temps.push(dir);
    return dir;
  };

  it('uses FANTASY_DESIGN_LIBRARY when it names a library with an index', () => {
    const result = resolveMaterialLibraryRoot({
      env: { FANTASY_DESIGN_LIBRARY: `  ${fixture.root}  ` },
      projectRoot: null,
      packaged: false,
      dataRoots: [],
    });
    expect(result).toEqual({ ok: true, root: fixture.root, source: 'env' });
  });

  it('expands ~ in the env value', () => {
    const previousHome = process.env.HOME;
    process.env.HOME = fixture.parent;
    try {
      const result = resolveMaterialLibraryRoot({
        env: { FANTASY_DESIGN_LIBRARY: '~/素材库' },
        projectRoot: null,
        packaged: false,
        dataRoots: [],
      });
      expect(result).toEqual({ ok: true, root: fixture.root, source: 'env' });
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it('reports why an env value is unusable instead of falling back', () => {
    const base = { projectRoot: null, packaged: false, dataRoots: [] };
    expect(resolveMaterialLibraryRoot({ ...base, env: { FANTASY_DESIGN_LIBRARY: 'relative/素材库' } })).toMatchObject({
      ok: false,
      source: 'env',
      reason: 'not-configured',
    });
    const missing = path.join(temp(), 'nope');
    expect(resolveMaterialLibraryRoot({ ...base, env: { FANTASY_DESIGN_LIBRARY: missing } })).toMatchObject({
      ok: false,
      root: missing,
      reason: 'missing-root',
    });
    const file = path.join(temp(), 'file.txt');
    writeFileSync(file, 'x');
    expect(resolveMaterialLibraryRoot({ ...base, env: { FANTASY_DESIGN_LIBRARY: file } })).toMatchObject({
      ok: false,
      reason: 'missing-root',
    });
    const empty = temp();
    expect(resolveMaterialLibraryRoot({ ...base, env: { FANTASY_DESIGN_LIBRARY: empty } })).toMatchObject({
      ok: false,
      root: empty,
      reason: 'missing-index',
    });
  });

  it('falls back to a 素材库 folder next to the repository root, except in packaged builds', () => {
    const projectRoot = path.join(fixture.parent, 'studio');
    expect(resolveMaterialLibraryRoot({ env: {}, projectRoot, packaged: false, dataRoots: [] })).toEqual({
      ok: true,
      root: fixture.root,
      source: 'sibling',
    });
    expect(resolveMaterialLibraryRoot({ env: {}, projectRoot, packaged: true, dataRoots: [] })).toMatchObject({
      ok: false,
      root: null,
      source: null,
      reason: 'not-configured',
    });
    expect(
      resolveMaterialLibraryRoot({ env: {}, projectRoot: path.join(temp(), 'studio'), packaged: false, dataRoots: [] }),
    ).toMatchObject({ ok: false, reason: 'not-configured', source: null });
  });

  it('rejects a library that overlaps the daemon data root', () => {
    const inside = resolveMaterialLibraryRoot({
      env: { FANTASY_DESIGN_LIBRARY: fixture.root },
      projectRoot: null,
      packaged: false,
      dataRoots: [fixture.parent],
    });
    expect(inside).toMatchObject({ ok: false, reason: 'not-configured' });
    const containing = resolveMaterialLibraryRoot({
      env: { FANTASY_DESIGN_LIBRARY: fixture.root },
      projectRoot: null,
      packaged: false,
      dataRoots: [path.join(fixture.root, '导览支持')],
    });
    expect(containing).toMatchObject({ ok: false, reason: 'not-configured' });
  });
});

describe('material index validation and caching', () => {
  let copy: MaterialsFixture;
  beforeAll(() => {
    copy = createMaterialsFixture();
  });
  afterAll(() => copy.cleanup());

  it.each([
    ['not json', '{', 'Cannot read search-index.json'],
    ['wrong schema', { schema_version: 2, assets: [] }, 'Unsupported search index schema'],
    ['assets not a list', { schema_version: 1, assets: {} }, 'Unsupported search index schema'],
    [
      'missing required field',
      { schema_version: 1, assets: [{ id: 'a', title: 't', kind: 'k', category: 'c', collection: 'c', path: 'p' }] },
      'Invalid asset record in search index',
    ],
    [
      'non-string id',
      { schema_version: 1, assets: [{ id: 7, title: 't', kind: 'k', category: 'c', collection: 'c', path: 'p', license: 'l' }] },
      'Invalid asset record in search index',
    ],
    [
      'duplicate ids',
      {
        schema_version: 1,
        assets: [
          { id: 'a', title: 't', kind: 'k', category: 'c', collection: 'c', path: 'p', license: 'l' },
          { id: 'a', title: 'u', kind: 'k', category: 'c', collection: 'c', path: 'q', license: 'l' },
        ],
      },
      'Duplicate asset IDs',
    ],
  ])('reports an invalid index (%s)', async (_label, content, message) => {
    const original = readFileSync(path.join(copy.root, '导览支持/search-index.json'), 'utf8');
    try {
      writeFixtureIndex(copy.root, content);
      const broken = serviceFor(copy.root);
      const status = await broken.status();
      expect(status).toMatchObject({ enabled: false, root: copy.root, rootSource: 'env', reason: 'invalid-index' });
      expect(status.message).toContain(message);
      const error = await rejection(broken.search({ q: '' }));
      expect(error).toMatchObject({ code: 'library-unavailable', status: 503 });
      const summary = await broken.summary();
      expect(summary).toMatchObject({ total: 0, categories: {}, kinds: {}, collections: {}, notice: MATERIAL_NOTICE });
    } finally {
      writeFileSync(path.join(copy.root, '导览支持/search-index.json'), original);
    }
  });

  it('reloads the index when the file changes', async () => {
    const live = serviceFor(copy.root);
    expect((await live.summary()).total).toBe(13);
    const index = readFixtureIndex(copy.root);
    index.assets.push({
      id: 'late-addition',
      title: 'Late addition',
      kind: 'file',
      category: '测试',
      collection: '测试',
      path: '素材库/手绘清单.md',
      license: 'CC0',
    });
    writeFixtureIndex(copy.root, index);
    const later = new Date(Date.now() + 5_000);
    await utimes(path.join(copy.root, '导览支持/search-index.json'), later, later);
    expect((await live.summary()).total).toBe(14);
    expect(await searchIds(live, 'late')).toEqual(['late-addition']);
    // In the index but not in assets.jsonl: detail cannot be built.
    const error = await rejection(live.detail('late-addition'));
    expect(error).toMatchObject({ code: 'library-unavailable', status: 503 });
    expect(error.message).toContain('ID missing from assets.jsonl');
  });

  it.each([['not json'], ['[1, 2]'], ['{"title": "no id"}']])(
    'rejects a malformed assets.jsonl line (%s)',
    async (line) => {
      const isolated = createMaterialsFixture();
      try {
        const recordsPath = path.join(isolated.root, '导览支持/assets.jsonl');
        const original = readFileSync(recordsPath, 'utf8');
        // A bad line after the wanted record is never reached (first match wins).
        await appendFile(recordsPath, `${line}\n`);
        expect((await serviceFor(isolated.root).detail('sonner')).item.id).toBe('sonner');
        writeFileSync(recordsPath, `${line}\n${original}`);
        const error = await rejection(serviceFor(isolated.root).detail('sonner'));
        expect(error).toMatchObject({ code: 'library-unavailable', status: 503 });
        expect(error.message).toContain('Invalid record in assets.jsonl');
      } finally {
        isolated.cleanup();
      }
    },
  );
});

describe('ranking (port of discovery.score)', () => {
  it('normalizes like NFKC + casefold and splits on whitespace', () => {
    expect(normalizeMaterialText('ＴＯＡＳＴ')).toBe('toast');
    expect(splitMaterialQuery('  React　聊天  ')).toEqual(['react', '聊天']);
    expect(compareCodePoints('a', 'b')).toBe(-1);
    expect(compareCodePoints('\u{1F600}', 'Ａ')).toBe(1);
    expect(compareCodePoints('ab', 'a')).toBe(1);
  });

  it('weights exact title 12, inside title 6, elsewhere 1 and requires every term', () => {
    const item = { title: 'Toast', tags: ['react'], description: 'notification' };
    expect(scoreMaterial(item, '')).toBe(1);
    expect(scoreMaterial(item, 'toast')).toBe(12);
    expect(scoreMaterial(item, 'toa')).toBe(6);
    expect(scoreMaterial(item, 'react')).toBe(1);
    expect(scoreMaterial(item, 'react toast')).toBe(13);
    expect(scoreMaterial(item, 'react missing')).toBe(0);
    // Alias family: 通知 expands to toast/sonner/notification.
    expect(scoreMaterial(item, '通知')).toBe(12);
  });

  it('browses an empty query in the library rail order, then by title', async () => {
    // The one deliberate difference from the archive CLI, which lists an empty query by title alone.
    expect(await searchIds(service, '')).toEqual([
      'glass-terse', 'sonner', 'sonner-toast', 'vaul', 'icon-bell', 'icon-drawer', 'missing-notes',
      'notes-md-thumb', 'hand-checklist', 'symlink-escape', 'unsafe-absolute', 'unsafe-dotdot',
      'website-0123456789abcdef',
    ]);
  });

  it.each([
    ['通知', ['sonner-toast', 'sonner', 'icon-bell', 'website-0123456789abcdef']],
    ['toast', ['sonner-toast', 'sonner', 'icon-bell', 'website-0123456789abcdef']],
    ['ＴＯＡＳＴ', ['sonner-toast', 'sonner', 'icon-bell', 'website-0123456789abcdef']],
    ['抽屉', ['icon-drawer', 'vaul', 'website-0123456789abcdef']],
    ['react 通知', ['sonner']],
    ['react drawer', ['vaul']],
    ['图标', ['icon-bell', 'icon-drawer']],
    ['icon drawer', ['icon-drawer']],
    ['GLASS', ['glass-terse']],
    ['手绘', ['hand-checklist']],
    ['emil', ['website-0123456789abcdef', 'sonner', 'sonner-toast', 'vaul']],
    ['nonexistent', []],
  ])('ranks %j like the archive CLI', async (query, expected) => {
    expect(await searchIds(service, query)).toEqual(expected);
  });

  it('filters by exact category, kind and collection', async () => {
    expect(await searchIds(service, '', { kind: 'svg' })).toEqual(['icon-bell', 'icon-drawer']);
    expect(await searchIds(service, 'react', { category: '交互组件' })).toEqual(['sonner', 'vaul']);
    expect(await searchIds(service, '', { collection: 'Emil Kowalski', kind: 'component' })).toEqual([
      'sonner',
      'sonner-toast',
      'vaul',
    ]);
    expect(await searchIds(service, '', { kind: 'Component' })).toEqual([]);
  });

  it('resolves composite category aliases and filters by section', async () => {
    expect(await searchIds(service, '', { category: '组件' })).toContain('sonner');
    expect(await searchIds(service, '', { section: '反馈' })).toContain('sonner');
    expect(await searchIds(service, '', { section: 'nonexistent-section' })).toEqual([]);
  });

  it('paginates with total, returned and nextOffset', async () => {
    const first = await service.search({ q: '', limit: 5 });
    expect(first).toMatchObject({ query: '', total: 13, offset: 0, returned: 5, nextOffset: 5, notice: MATERIAL_NOTICE });
    const last = await service.search({ q: '', limit: 5, offset: 10 });
    expect(last).toMatchObject({ total: 13, offset: 10, returned: 3, nextOffset: null });
    expect(last.items.map((item) => item.id)).toEqual(['unsafe-absolute', 'unsafe-dotdot', 'website-0123456789abcdef']);
    const beyond = await service.search({ q: '', offset: 50 });
    expect(beyond).toMatchObject({ total: 13, returned: 0, nextOffset: null, items: [] });
    expect((await service.search({})).returned).toBe(13);
  });
});

describe('DTO mapping', () => {
  it('maps snake_case index records to summary items', async () => {
    const result = await service.search({ q: 'sonner', limit: 100 });
    const sonner = result.items.find((item) => item.id === 'sonner');
    expect(sonner).toEqual({
      id: 'sonner',
      title: 'Sonner · 通知反馈',
      kind: 'component',
      category: '交互组件',
      collection: 'Emil Kowalski',
      section: '反馈',
      description: 'React Toast 通知：堆叠、滑动关闭、操作按钮。',
      tags: ['react', 'toast'],
      status: '源码已固定',
      license: 'MIT · Emil Kowalski',
      source: 'https://sonner.emilkowal.ski/',
      previewKind: 'interactive',
      previewNote: '本地交互示例',
      palette: [],
      capabilities: {
        material: 'source_file',
        previewEntry: false,
        designTokens: false,
        sourceManifest: true,
        licenseDocument: true,
      },
      thumbnailUrl: '/api/materials/items/sonner/thumbnail',
    });
    const toast = result.items.find((item) => item.id === 'sonner-toast');
    expect(toast).toMatchObject({ parentId: 'sonner', thumbnailUrl: null, capabilities: { material: 'local_reference' } });

    const website = (await service.search({ q: '', kind: 'website' })).items[0]!;
    expect(website).toMatchObject({ useStatus: '未读', capabilities: { material: 'website_record' } });
    const glass = (await service.search({ q: 'glass' })).items[0]!;
    expect(glass.palette).toEqual([
      { name: 'surface.base', value: '#f4f1ea' },
      { name: 'accent', value: '#b23a26' },
    ]);
  });

  it('builds details from the full record with library-relative files', async () => {
    const { item, notice } = await service.detail('sonner');
    expect(notice).toBe(MATERIAL_NOTICE);
    const sonnerRoot = path.join(fixture.root, SONNER_DIR);
    expect(item.absolutePath).toBe(path.join(sonnerRoot, 'upstream/src/index.tsx'));
    expect(item.collectionRoot).toBe(sonnerRoot);
    expect(item.children).toEqual(['sonner-toast']);
    expect(item.files.map((file) => [file.field, file.relativePath, file.exists])).toEqual([
      ['path', `${SONNER_DIR}/upstream/src/index.tsx`, true],
      ['document', `${SONNER_DIR}/README.md`, true],
      ['thumbnail', `${SONNER_DIR}/references/preview.png`, true],
      ['source_manifest', `${SONNER_DIR}/references/source-manifest.json`, true],
      ['license_document', `${SONNER_DIR}/THIRD_PARTY_NOTICES.md`, true],
    ]);
    // Stale `absolute_path` from the archive is never used.
    expect(JSON.stringify(item)).not.toContain('/stale/');

    const glass = (await service.detail('glass-terse')).item;
    expect(glass.collectionRoot).toBe(path.join(fixture.root, '风格参考/Glass-玻璃'));
    expect(glass.notes).toBe('Glass panels over warm paper.');
    const bell = (await service.detail('icon-bell')).item;
    expect(bell.subcategories).toEqual(['界面']);

    const missing = (await service.detail('missing-notes')).item;
    expect(missing.collectionRoot).toBeNull();
    expect(missing.files.map((file) => file.exists)).toEqual([false, false]);
    const single = (await service.detail('hand-checklist')).item;
    expect(single.collectionRoot).toBeNull();
  });

  it('rejects unknown ids', async () => {
    expect(await rejection(service.detail('does-not-exist'))).toMatchObject({ code: 'unknown-id', status: 404 });
  });
});

describe('path safety', () => {
  it.each(['unsafe-dotdot', 'unsafe-absolute', 'symlink-escape'])('refuses %s details', async (id) => {
    expect(await rejection(service.detail(id))).toMatchObject({ code: 'unsafe-path', status: 403 });
  });

  it('serves thumbnails only for indexed images without symlinks', async () => {
    const png = await service.thumbnail('sonner');
    expect(png).toMatchObject({ contentType: 'image/png', isSvg: false, size: 69 });
    expect(png.absolutePath).toBe(path.join(fixture.root, SONNER_DIR, 'references/preview.png'));
    expect(await service.thumbnail('icon-bell')).toMatchObject({ contentType: 'image/svg+xml', isSvg: true });
    expect(await rejection(service.thumbnail('symlink-escape'))).toMatchObject({ code: 'unsafe-path', status: 403 });
    expect(await rejection(service.thumbnail('notes-md-thumb'))).toMatchObject({ code: 'unsafe-path', status: 403 });
    expect(await rejection(service.thumbnail('sonner-toast'))).toMatchObject({ code: 'missing-file', status: 404 });
    expect(await rejection(service.thumbnail('nope'))).toMatchObject({ code: 'unknown-id', status: 404 });
  });

  it.runIf(process.platform === 'darwin')('canonicalizes a root given in another letter case', async () => {
    // Case-insensitive APFS: the root must use the same on-disk case as the
    // realpath checks in paths.ts, or every file looks like it leaves the library.
    const variant = fixture.root.toUpperCase();
    if (variant === fixture.root || !existsSync(variant)) return; // case-sensitive volume
    const shifted = serviceFor(variant);
    expect((await shifted.summary()).status.root).toBe(fixture.root);
    expect((await shifted.detail('sonner')).item.id).toBe('sonner');
    expect(await shifted.thumbnail('sonner')).toMatchObject({ contentType: 'image/png' });
  });

  it('declares the real raster type when bytes and extension disagree, never SVG', async () => {
    const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
    expect(sniffRasterImageType(Uint8Array.from([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffRasterImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffRasterImageType(Uint8Array.from(ascii('GIF89a')))).toBe('image/gif');
    expect(sniffRasterImageType(Uint8Array.from(ascii('RIFF\0\0\0\0WEBP')))).toBe('image/webp');
    expect(sniffRasterImageType(Uint8Array.from(ascii('\0\0\0\x1cftypavif')))).toBe('image/avif');
    expect(sniffRasterImageType(Uint8Array.from(ascii('<svg xmlns=')))).toBeNull();
    expect(sniffRasterImageType(new Uint8Array())).toBeNull();

    const copy = createMaterialsFixture();
    try {
      writeFileSync(path.join(copy.root, '风格参考/Glass-玻璃/preview.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]));
      expect(await serviceFor(copy.root).thumbnail('glass-terse')).toMatchObject({ contentType: 'image/jpeg', isSvg: false });
      writeFileSync(path.join(copy.root, '风格参考/Glass-玻璃/preview.png'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      expect(await serviceFor(copy.root).thumbnail('glass-terse')).toMatchObject({ contentType: 'image/png', isSvg: false });
    } finally {
      copy.cleanup();
    }
  });

  it('refuses a symlinked segment even when it stays inside the library', async () => {
    const copy = createMaterialsFixture();
    try {
      const index = readFixtureIndex(copy.root);
      const inner = path.join(copy.root, '杂项/inner');
      mkdirSync(inner, { recursive: true });
      symlinkSync(path.join(copy.root, SONNER_DIR, 'references'), path.join(inner, 'refs'));
      const record = index.assets.find((asset) => asset.id === 'vaul')!;
      record.thumbnail = '素材库/杂项/inner/refs/preview.png';
      writeFixtureIndex(copy.root, index);
      expect(await rejection(serviceFor(copy.root).thumbnail('vaul'))).toMatchObject({ code: 'unsafe-path' });
    } finally {
      copy.cleanup();
    }
  });
});

describe('context packet', () => {
  it('matches the archive CLI markdown byte for byte', async () => {
    const golden = readFileSync(GOLDEN, 'utf8').replaceAll('{{ROOT}}', fixture.root);
    const result = await service.context(['sonner', 'glass-terse', 'hand-checklist', 'icon-bell', 'sonner'], '为设置页设计通知');
    expect(result.ids).toEqual(['sonner', 'glass-terse', 'hand-checklist', 'icon-bell']);
    expect(`${result.markdown}\n`).toBe(golden);
    expect(result.notice).toBe(MATERIAL_NOTICE);
  });

  it('marks missing files and keeps an empty task line', async () => {
    const { markdown } = await service.context(['missing-notes'], '');
    const lines = markdown.split('\n');
    expect(lines.slice(0, 4)).toEqual(['# Fantasy Design 设计参考包', '', '', '']);
    expect(lines).toContain(`- path：${path.join(fixture.root, '杂项/missing/README.md')} [missing]`);
    expect(lines).toContain(`- document：${path.join(fixture.root, '杂项/missing/NOTES.md')} [missing]`);
    expect(lines.at(-1)).toBe(MATERIAL_NOTICE);
  });

  it('bounds the packet size and rejects unknown or unsafe ids', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `id-${i}`);
    expect(await rejection(service.context(tooMany, ''))).toMatchObject({ code: 'invalid-request', status: 400 });
    expect(await rejection(service.context([], ''))).toMatchObject({ code: 'invalid-request' });
    expect(await rejection(service.context(['sonner', 'nope'], ''))).toMatchObject({ code: 'unknown-id' });
    expect(await rejection(service.context(['unsafe-dotdot'], ''))).toMatchObject({ code: 'unsafe-path' });
  });
});

describe('copy planning', () => {
  async function plan(id: string, selection: Parameters<typeof planMaterialCopy>[2] = {}) {
    const { catalog, record } = await service.openRecord(id);
    return planMaterialCopy(catalog, record, selection);
  }

  it('defaults to the entry plus thumbnail and always carries provenance', async () => {
    const result = await plan('sonner');
    expect(result.layoutRoot).toBe(path.join(fixture.root, SONNER_DIR));
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      'README.md',
      'THIRD_PARTY_NOTICES.md',
      'references/preview.png',
      'references/source-manifest.json',
      'upstream/src/index.tsx',
    ]);
    expect(result.mainEntry).toBe('upstream/src/index.tsx');
    expect(result.thumbnail).toBe('references/preview.png');
    const png = result.entries.find((entry) => entry.relativePath === 'references/preview.png')!;
    expect(png).toMatchObject({ bytes: 69, sourceRelativePath: `${SONNER_DIR}/references/preview.png` });
    expect(png.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('walks directories without dotfiles, dependency stores or directory symlinks, while keeping agent skill dotdirs', async () => {
    const result = await plan('sonner', { files: ['upstream'] });
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      'README.md',
      'THIRD_PARTY_NOTICES.md',
      'references/source-manifest.json',
      'upstream/LICENSE.md',
      'upstream/package.json',
      'upstream/src/index.tsx',
      'upstream/src/state.ts',
    ]);
    expect(result.thumbnail).toBeNull();
    expect(result.mainEntry).toBe('upstream/src/index.tsx');

    const agentSkillDir = path.join(fixture.root, SONNER_DIR, 'upstream/.claude/skills/interface-design');
    mkdirSync(agentSkillDir, { recursive: true });
    const agentSkillFile = path.join(agentSkillDir, 'SKILL.md');
    writeFileSync(agentSkillFile, '# Skill\n');
    const secretDotDir = path.join(fixture.root, SONNER_DIR, 'upstream/.secret');
    mkdirSync(secretDotDir, { recursive: true });
    writeFileSync(path.join(secretDotDir, 'token.txt'), 'secret\n');
    try {
      const withAgentDir = await plan('sonner', { files: ['upstream'] });
      const paths = withAgentDir.entries.map((entry) => entry.relativePath);
      expect(paths).toContain('upstream/.claude/skills/interface-design/SKILL.md');
      expect(paths).not.toContain('upstream/.secret/token.txt');
    } finally {
      rmSync(path.join(fixture.root, SONNER_DIR, 'upstream/.claude'), { recursive: true, force: true });
      rmSync(secretDotDir, { recursive: true, force: true });
    }
  });

  it('indexes visualskills metadata and record id in scoreMaterial', () => {
    const record = {
      id: 'vs-leonxlnx-taste-skill',
      title: 'taste-skill',
      kind: 'skill',
      category: '设计 Skill',
      collection: 'Visual Skills',
      path: '素材库/设计Skill/VisualSkills-leonxlnx-taste-skill/upstream/SKILL.md',
      license: 'MIT',
      visualskills: {
        project_id: 'Leonxlnx__taste-skill',
        project_url: 'https://visualskills.dev/skills/Leonxlnx__taste-skill',
        description_zh: '为网站确定视觉方向',
        snapshot: { skill_path: 'visualskills-upstream/.agents/skills/taste-skill/SKILL.md' },
      },
    };
    expect(scoreMaterial(record, 'Leonxlnx__taste-skill')).toBeGreaterThan(0);
    expect(scoreMaterial(record, 'vs-leonxlnx-taste-skill')).toBeGreaterThan(0);
    expect(scoreMaterial(record, '视觉方向')).toBeGreaterThan(0);
    expect(scoreMaterial(record, 'visualskills-upstream')).toBeGreaterThan(0);
  });

  it('lays out single files relative to the entry directory', async () => {
    const result = await plan('hand-checklist');
    expect(result.layoutRoot).toBe(fixture.root);
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(['手绘清单.md']);
  });

  it.each([
    [{ files: ['../Vaul-抽屉'] }, 'unsafe-path', 403],
    [{ files: ['/etc'] }, 'unsafe-path', 403],
    [{ files: ['upstream/node_modules'] }, 'unsafe-path', 403],
    [{ files: ['evil'] }, 'unsafe-path', 403],
    [{ files: ['upstream/src/linked-dir'] }, 'unsafe-path', 403],
    [{ files: ['many'] }, 'copy-limit', 413],
    [{ files: ['big'] }, 'copy-limit', 413],
    [{ files: ['nope.md'] }, 'missing-file', 404],
    [{ fields: ['tokens' as const] }, 'invalid-request', 400],
  ])('rejects %j', async (selection, code, status) => {
    expect(await rejection(plan('sonner', selection))).toMatchObject({ code, status });
  });

  it('rejects collection-relative files for records without a collection directory', async () => {
    expect(await rejection(plan('hand-checklist', { files: ['x.md'] }))).toMatchObject({ code: 'invalid-request' });
  });
});
