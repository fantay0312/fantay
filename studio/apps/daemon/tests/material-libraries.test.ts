import { mkdtempSync, readFileSync, rmSync, symlinkSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMaterialLibrariesService } from '../src/materials/libraries.js';
import { applyMaterialToProject } from '../src/materials/apply.js';
import { createMaterialsFixture, type MaterialsFixture } from './fixtures/materials-library/fixture.js';

const fixtures: MaterialsFixture[] = [];
const dataDirs: string[] = [];
function setup() {
  const fixture = createMaterialsFixture(); fixtures.push(fixture);
  const dataDir = mkdtempSync(path.join(tmpdir(), 'material-registry-')); dataDirs.push(dataDir);
  const options = { dataDir, dataRoots: [dataDir], env: {}, projectRoot: null, packaged: true };
  return { fixture, options, service: createMaterialLibrariesService(options) };
}
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('multiple external material libraries', () => {
  it('keeps previous default-library references valid when that folder is connected explicitly', async () => {
    const { fixture, options } = setup();
    const service = createMaterialLibrariesService({ ...options, env: { FANTASY_DESIGN_LIBRARY: fixture.root } });
    expect((await service.libraries()).libraries[0]?.id).toBe('default');
    const library = await service.addLibrary(fixture.root);
    expect((await service.libraries()).libraries).toHaveLength(1);
    expect((await service.detail('sonner')).item.libraryId).toBe(library.id);
    await service.removeLibrary(library.id);
    await expect(service.detail('sonner')).rejects.toMatchObject({ code: 'unknown-id' });
  });
  it('persists canonical roots and deduplicates repeated and symlinked selections', async () => {
    const { fixture, options, service } = setup();
    const alias = path.join(fixture.parent, 'alias'); symlinkSync(fixture.root, alias);
    const first = await service.addLibrary(fixture.root, 'Design references');
    expect((await service.addLibrary(alias)).id).toBe(first.id);
    expect((await createMaterialLibrariesService(options).libraries()).libraries).toMatchObject([
      { id: first.id, name: 'Design references', root: fixture.root, status: { enabled: true } },
    ]);
    expect(JSON.parse(readFileSync(path.join(options.dataDir, 'material-libraries.json'), 'utf8')).libraries).toHaveLength(1);
  });

  it('keeps colliding record IDs independent across global, scoped, detail, thumbnail and context reads', async () => {
    const { fixture, service, options } = setup();
    const other = createMaterialsFixture(); fixtures.push(other);
    const a = await service.addLibrary(fixture.root, 'First');
    const b = await service.addLibrary(other.root, 'Second');
    const first = await service.search({ libraryId: a.id, q: 'sonner' });
    const second = await service.search({ libraryId: b.id, q: 'sonner' });
    expect(first.total).toBeGreaterThan(0);
    expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
    expect(first.items.every((item) => item.libraryId === a.id)).toBe(true);
    expect((await service.search({ q: 'sonner' })).total).toBe(first.total + second.total);
    expect((await service.summary()).total).toBe(a.total + b.total);
    expect((await service.summary(a.id)).total).toBe(a.total);
    const id = first.items.find((item) => item.thumbnailUrl)!.id;
    expect((await service.detail(id)).item).toMatchObject({ id, libraryId: a.id, libraryName: 'First' });
    expect((await service.thumbnail(id)).absolutePath.startsWith(fixture.root)).toBe(true);
    const context = await service.context([id, second.items[0]!.id], 'Use both sources');
    expect(context.ids).toEqual([id, second.items[0]!.id]);
    expect(context.markdown).toContain(fixture.root);
    expect(context.markdown).toContain(other.root);
    const opened = await service.openRecord(second.items[0]!.id);
    expect(opened.catalog.root).toBe(other.root);
    expect(opened.record.id).not.toContain(b.id);
    await expect(applyMaterialToProject({ materials: service, projectsDir: options.dataDir,
      projectId: 'imported', projectMetadata: { baseDir: fixture.root }, id: `${b.id}:sonner` }))
      .rejects.toMatchObject({ code: 'unsafe-path' });
    const global = await service.search({ limit: 3 });
    const next = await service.search({ limit: 3, offset: 3 });
    expect(new Set([...global.items, ...next.items].map((item) => item.id)).size).toBe(6);
  });

  it('retains unavailable libraries without blocking healthy ones and disconnects without deleting files', async () => {
    const { fixture, service, options } = setup();
    const other = createMaterialsFixture(); fixtures.push(other);
    const a = await service.addLibrary(fixture.root);
    const b = await service.addLibrary(other.root);
    const moved = `${other.root}-moved`; renameSync(other.root, moved);
    expect((await service.libraries()).libraries.find((item) => item.id === b.id)?.status.enabled).toBe(false);
    expect((await service.search({})).total).toBe(a.total);
    expect((await service.summary(b.id)).status.enabled).toBe(false);
    await service.removeLibrary(a.id);
    expect(existsSync(fixture.root)).toBe(true);
    expect((await createMaterialLibrariesService(options).libraries()).libraries.map((item) => item.id)).toEqual([b.id]);
    await expect(service.detail(`${a.id}:anything`)).rejects.toMatchObject({ code: 'unknown-id' });
  });

  it('rejects invalid selections without saving them and serializes concurrent additions', async () => {
    const { fixture, service, options } = setup();
    await expect(service.addLibrary(options.dataDir)).rejects.toMatchObject({ code: 'library-unavailable' });
    await expect(service.addLibrary('relative/path')).rejects.toMatchObject({ code: 'invalid-request' });
    const other = createMaterialsFixture(); fixtures.push(other);
    await Promise.all([service.addLibrary(fixture.root), service.addLibrary(other.root)]);
    expect((await service.libraries()).libraries).toHaveLength(2);
  });
});
