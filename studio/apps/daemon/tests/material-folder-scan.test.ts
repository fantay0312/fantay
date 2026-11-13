import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMaterialLibrariesService } from '../src/materials/libraries.js';
import { applyMaterialToProject } from '../src/materials/apply.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('indexes an ordinary folder, keeps originals unchanged, restores it and rescans additions/removals', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'material-folder-scan-')); roots.push(temporary);
  const root = path.join(temporary, '我的素材');
  const dataDir = path.join(temporary, 'data');
  mkdirSync(path.join(root, '图片'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '图片', '标志.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(path.join(root, '照片.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(path.join(root, '影片.mp4'), 'video');
  writeFileSync(path.join(root, '音效.wav'), 'audio');
  writeFileSync(path.join(root, '字体.woff2'), 'font');
  writeFileSync(path.join(root, '说明.md'), '# Reference');
  writeFileSync(path.join(root, 'node_modules', 'hidden.js'), 'excluded');
  writeFileSync(path.join(root, '.git', 'config'), 'excluded');
  writeFileSync(path.join(root, '.env'), 'excluded');
  symlinkSync(path.join(root, '图片'), path.join(root, 'linked-folder'));
  const before = readdirSync(root).sort();
  const options = { dataDir, dataRoots: [dataDir], env: {}, projectRoot: null, packaged: true };
  const service = createMaterialLibrariesService(options);
  const library = await service.addLibrary(root, '我的文件夹');
  expect(library).toMatchObject({ kind: 'folder', total: 6, name: '我的文件夹' });
  expect(readdirSync(root).sort()).toEqual(before);
  expect(readdirSync(root)).not.toContain('导览支持');
  const search = await service.search({ libraryId: library.id, limit: 100 });
  expect(new Set(search.items.map((item) => item.kind))).toEqual(new Set(['image', 'svg', 'video', 'audio', 'font', 'markdown']));
  const image = search.items.find((item) => item.kind === 'image')!;
  expect((await service.thumbnail(image.id)).contentType).toBe('image/png');
  const detail = (await service.detail(image.id)).item;
  expect(detail.absolutePath).toBe(realpathSync(path.join(root, '照片.png')));
  expect(detail.license).toBe('');
  const copied = await applyMaterialToProject({ materials: service, id: image.id,
    projectsDir: path.join(dataDir, 'projects'), projectId: 'sample', projectMetadata: {} });
  expect(copied.id).toBe(image.id);
  expect(copied.files.some((file) => file.relPath.endsWith('.png'))).toBe(true);
  expect((await createMaterialLibrariesService(options).summary(library.id)).total).toBe(6);
  writeFileSync(path.join(root, '新增.txt'), 'new');
  rmSync(path.join(root, '影片.mp4'));
  await service.scanLibrary(library.id);
  expect((await service.search({ q: '新增', libraryId: library.id })).total).toBe(1);
  expect((await service.search({ kind: 'video', libraryId: library.id })).total).toBe(0);
  expect((await service.search({ kind: 'image', libraryId: library.id })).items[0]!.id).toBe(image.id);
  const saved = JSON.parse(readFileSync(path.join(dataDir, 'material-libraries.json'), 'utf8'));
  expect(saved.libraries[0].generation).toBeTruthy();
  await service.removeLibrary(library.id);
  expect(readFileSync(path.join(root, '新增.txt'), 'utf8')).toBe('new');
});

it('accepts an empty folder and rejects inaccessible paths without a partial connection', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'material-empty-')); roots.push(temporary);
  const root = path.join(temporary, 'empty'); mkdirSync(root);
  const service = createMaterialLibrariesService({ dataDir: path.join(temporary, 'data'),
    dataRoots: [path.join(temporary, 'data')], env: {}, packaged: true });
  expect((await service.addLibrary(root)).total).toBe(0);
  await expect(service.addLibrary(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'library-unavailable' });
  expect((await service.libraries()).libraries).toHaveLength(1);
});
