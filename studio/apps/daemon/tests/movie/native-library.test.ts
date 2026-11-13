import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeLibrary, nativeProjectThumbnail } from '../../src/movie/native-library.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('keeps existing native projects and host links without launching or copying them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'fantay-native-library-')); roots.push(root);
  const project = path.join(root, '花园 剪辑.palmier');
  await mkdir(project); await writeFile(path.join(project, 'project.json'), '{}');
  await mkdir(path.join(root, 'native-runtime'));
  await writeFile(path.join(root, 'native-runtime/projects.json'), JSON.stringify({ [project]: 'host-project' }));
  const entries = await nativeLibrary(root, async () => [
    { path: project, name: '花园 剪辑', isAccessible: true, lastOpenedAt: 978307210000 },
    { path: project, name: '花园 剪辑', isAccessible: true },
    { path: path.join(root, 'missing.palmier'), name: 'Missing', isAccessible: false },
    { path: 'https://example.invalid/project', name: 'Remote', isAccessible: true },
  ]);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ name: '花园 剪辑', path: project, projectId: 'host-project', updatedAt: 978307210000 });
  expect(entries[0]!.id).toMatch(/^[a-f0-9]{32}$/);
  expect(await nativeLibrary(root, async () => [])).toEqual([]);
});

it('serves only the native-provided thumbnail bytes and never reads an arbitrary path', async () => {
  const entry = { id: 'film', name: 'film', path: '/private/not-a-file.palmier', updatedAt: 0 };
  await expect(nativeProjectThumbnail(entry)).rejects.toThrow('Video project thumbnail not found');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  expect(await nativeProjectThumbnail({ ...entry, thumbnailBase64: jpeg.toString('base64') })).toEqual(jpeg);
  await expect(nativeProjectThumbnail({ ...entry, thumbnailBase64: 'bm90IGFuIGltYWdl' })).rejects.toThrow('Invalid video project thumbnail');
});
