import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DESIGN_DOCUMENT_MAX_BYTES, DESIGN_HISTORY_LIMIT } from '@open-design/contracts';

import { CanvasStore } from '../../../src/services/design-canvas.js';
import {
  DesignConflictError,
  DesignDocumentService,
  DesignInputError,
} from '../../../src/fantay/designs/service.js';
import {
  designCoverPaths,
  designHistoryDir,
  designMigrationLedgerPath,
  validateDesignPath,
  validateExistingDesignPath,
} from '../../../src/fantay/designs/paths.js';
import { extractFigThumbnail, readPngSize, sniffDesignFormat } from '../../../src/fantay/designs/sniff.js';
import { legacyInput, makeFig, makeFigWithOversizedThumbnail, makeOp, makePng, makeTempRoots, type TempRoots } from './fixtures.js';

const PROJECT = 'proj-designs-service';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('DesignDocumentService', () => {
  let roots: TempRoots;
  let legacyStore: CanvasStore;
  let service: DesignDocumentService;

  function projectFile(name: string): string {
    return path.join(roots.projectsRoot, PROJECT, name);
  }

  async function tempFiles(dir: string): Promise<string[]> {
    return (await readdir(dir).catch(() => [] as string[])).filter((name) => name.includes('.fx-tmp-'));
  }

  beforeEach(async () => {
    roots = await makeTempRoots();
    legacyStore = new CanvasStore(roots.runtimeDataDir);
    service = new DesignDocumentService({ projectsRoot: roots.projectsRoot, runtimeDataDir: roots.runtimeDataDir, legacyStore });
  });

  afterEach(async () => {
    await roots.cleanup();
  });

  it('creates with If-None-Match, updates with If-Match and reports the summary', async () => {
    const first = await makeFig({ canvas: 'v1' });
    const created = await service.write(PROJECT, 'designs/首页.fig', first, { ifNoneMatch: '*' });
    expect(created.created).toBe(true);
    expect(created.previousSha256).toBeNull();
    expect(created.summary).toMatchObject({
      projectId: PROJECT,
      path: 'designs/首页.fig',
      name: '首页',
      format: 'fig',
      size: first.length,
      sha256: sha256(first),
    });
    expect(created.summary.revision).toBe(`${first.length.toString(16)}-${Math.floor(created.summary.mtime).toString(16)}`);
    expect(created.summary.coverUrl).toBe(
      `/api/projects/${PROJECT}/designs/cover?path=${encodeURIComponent('designs/首页.fig')}&v=${encodeURIComponent(created.summary.revision)}`,
    );
    expect(await readFile(projectFile('designs/首页.fig'))).toEqual(first);

    const second = await makeFig({ canvas: 'v2' });
    const updated = await service.write(PROJECT, 'designs/首页.fig', second, { ifMatch: sha256(first) });
    expect(updated).toMatchObject({ created: false, previousSha256: sha256(first), summary: { sha256: sha256(second) } });
    const read = await service.read(PROJECT, 'designs/首页.fig');
    expect(read.bytes).toEqual(second);
    expect(read.sha256).toBe(sha256(second));
    // The previous bytes are in the history, named by their sha256.
    const history = designHistoryDir(roots.runtimeDataDir, PROJECT, 'designs/首页.fig');
    expect(await readFile(path.join(history, `${sha256(first)}.fig`))).toEqual(first);
    expect(await tempFiles(path.dirname(projectFile('designs/首页.fig')))).toEqual([]);
  });

  it('rejects stale and missing preconditions with the current sha256', async () => {
    const first = await makeFig({ canvas: 'a' });
    await service.write(PROJECT, 'designs/a.fig', first, { ifNoneMatch: '*' });
    const stale = await rejection(service.write(PROJECT, 'designs/a.fig', await makeFig({ canvas: 'b' }), { ifMatch: 'f'.repeat(64) }));
    expect(stale).toBeInstanceOf(DesignConflictError);
    expect(stale).toMatchObject({ currentSha256: sha256(first), path: 'designs/a.fig', reason: 'DESIGN_REVISION_MISMATCH' });
    // Creating over an existing file conflicts too.
    const exists = await rejection(service.write(PROJECT, 'designs/a.fig', await makeFig({ canvas: 'c' }), { ifNoneMatch: '*' }));
    expect(exists).toMatchObject({ currentSha256: sha256(first) });
    // If-Match on a file that does not exist: currentSha256 null.
    const missing = await rejection(service.write(PROJECT, 'designs/none.fig', first, { ifMatch: sha256(first) }));
    expect(missing).toBeInstanceOf(DesignConflictError);
    expect(missing).toMatchObject({ currentSha256: null });
    expect(await readFile(projectFile('designs/a.fig'))).toEqual(first);
  });

  it('serializes concurrent writes: one wins, one conflicts, no temp files remain', async () => {
    const base = await makeFig({ canvas: 'base' });
    await service.write(PROJECT, 'designs/race.fig', base, { ifNoneMatch: '*' });
    const left = await makeFig({ canvas: 'left' });
    const right = await makeFig({ canvas: 'right' });
    const outcomes = await Promise.allSettled([
      service.write(PROJECT, 'designs/race.fig', left, { ifMatch: sha256(base) }),
      service.write(PROJECT, 'designs/race.fig', right, { ifMatch: sha256(base) }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect((outcomes[1] as PromiseRejectedResult).reason).toMatchObject({ currentSha256: sha256(left) });
    expect(await readFile(projectFile('designs/race.fig'))).toEqual(left);
    const createRace = await Promise.allSettled([
      service.write(PROJECT, 'designs/new.fig', left, { ifNoneMatch: '*' }),
      service.write(PROJECT, 'designs/new.fig', right, { ifNoneMatch: '*' }),
    ]);
    expect(createRace.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await tempFiles(path.dirname(projectFile('designs/race.fig')))).toEqual([]);
  });

  it('keeps the newest 20 revisions in the history', async () => {
    let current = await makeFig({ canvas: 'r0' });
    await service.write(PROJECT, 'designs/history.fig', current, { ifNoneMatch: '*' });
    const replaced: string[] = [];
    for (let revision = 1; revision <= DESIGN_HISTORY_LIMIT + 1; revision += 1) {
      const next = await makeFig({ canvas: `r${revision}` });
      await service.write(PROJECT, 'designs/history.fig', next, { ifMatch: sha256(current) });
      replaced.push(sha256(current));
      current = next;
    }
    const dir = designHistoryDir(roots.runtimeDataDir, PROJECT, 'designs/history.fig');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.fig')).sort();
    expect(files).toHaveLength(DESIGN_HISTORY_LIMIT);
    // The oldest replaced revision was dropped; the 20 newest are kept.
    expect(files).toEqual(replaced.slice(1).map((sha) => `${sha}.fig`).sort());
    expect(await tempFiles(dir)).toEqual([]);
  });

  it('rejects invalid design paths', async () => {
    const bytes = await makeFig();
    for (const bad of ['../x.fig', '/abs.fig', 'designs/a.png', 'designs/a b.fig', '.file-versions/x.fig', '', 'designs\\a.fig']) {
      const error = await rejection(service.write(PROJECT, bad, bytes, { ifNoneMatch: '*' }));
      expect(error, bad).toBeInstanceOf(DesignInputError);
      expect((error as DesignInputError).reason, bad).toBe('INVALID_DESIGN_PATH');
    }
    expect(thrown(() => validateDesignPath('designs/a b.fig'))).toMatchObject({ reason: 'INVALID_DESIGN_PATH', details: { suggestion: 'designs/a-b.fig' } });
    expect(thrown(() => validateDesignPath('designs/.hidden.fig'))).toMatchObject({ details: { suggestion: 'designs/_hidden.fig' } });
    // A basename too long for the atomic temp name (`.<name>.fx-tmp-<uuid>`) gets a shortened suggestion.
    const long = thrown(() => validateDesignPath(`designs/${'设'.repeat(80)}.fig`)) as DesignInputError;
    expect(long).toMatchObject({ reason: 'INVALID_DESIGN_PATH' });
    expect(long.details.suggestion).toBe(`designs/${'设'.repeat(50)}.fig`);
    expect(validateDesignPath('designs/sub/页面-1.op')).toBe('designs/sub/页面-1.op');
    expect(validateExistingDesignPath('designs/My Design.fig')).toBe('designs/My Design.fig');
    expect(thrown(() => validateExistingDesignPath('designs/.x.fig'))).toBeInstanceOf(DesignInputError);
  });

  it('rejects documents over the size cap and bytes that do not match the format', async () => {
    const oversized = Buffer.alloc(DESIGN_DOCUMENT_MAX_BYTES + 1);
    oversized.write('PK\x03\x04', 'latin1');
    expect(await rejection(service.write(PROJECT, 'designs/big.fig', oversized, { ifNoneMatch: '*' }))).toMatchObject({ reason: 'DESIGN_TOO_LARGE' });
    const small = new DesignDocumentService({ projectsRoot: roots.projectsRoot, runtimeDataDir: roots.runtimeDataDir, legacyStore, maxBytes: 16 });
    expect(await rejection(small.write(PROJECT, 'designs/small.fig', Buffer.from('fig-kiwi-and-more-bytes'), { ifNoneMatch: '*' })))
      .toMatchObject({ reason: 'DESIGN_TOO_LARGE' });
    expect(await rejection(service.write(PROJECT, 'designs/text.fig', Buffer.from('hello'), { ifNoneMatch: '*' }))).toMatchObject({ reason: 'INVALID_DESIGN_DATA' });
    expect(await rejection(service.write(PROJECT, 'designs/empty.fig', Buffer.alloc(0), { ifNoneMatch: '*' }))).toMatchObject({ reason: 'INVALID_DESIGN_DATA' });
    expect(await rejection(service.write(PROJECT, 'designs/zip.op', await makeFig(), { ifNoneMatch: '*' }))).toMatchObject({ reason: 'INVALID_DESIGN_DATA' });
    // fig-kiwi canvases and JSON .op documents (leading whitespace / BOM allowed) are accepted.
    await service.write(PROJECT, 'designs/kiwi.fig', Buffer.from('fig-kiwi\x00\x01'), { ifNoneMatch: '*' });
    await service.write(PROJECT, 'designs/doc.op', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(' \n'), makeOp()]), { ifNoneMatch: '*' });
    expect(sniffDesignFormat(Buffer.from('PK\x03\x04', 'latin1'), 'fig')).toBe(true);
    expect(sniffDesignFormat(Buffer.from('  [1]'), 'op')).toBe(false);
    expect(readPngSize(makePng(7, 3))).toEqual({ width: 7, height: 3 });
    expect(readPngSize(Buffer.from('not a png at all, really not'))).toBeNull();
  });

  it('lists design files newest first without hashing and reads them back', async () => {
    await service.write(PROJECT, 'designs/old.fig', await makeFig({ canvas: 'old' }), { ifNoneMatch: '*' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await service.write(PROJECT, 'designs/new.op', makeOp('new'), { ifNoneMatch: '*' });
    await mkdir(path.dirname(projectFile('notes.txt')), { recursive: true });
    await writeFile(projectFile('notes.txt'), 'not a design');
    const designs = await service.list(PROJECT);
    expect(designs.map((design) => design.path)).toEqual(['designs/new.op', 'designs/old.fig']);
    expect(designs[0]).toMatchObject({ format: 'op', name: 'new' });
    expect(designs[0]).not.toHaveProperty('sha256');
    expect(await rejection(service.read(PROJECT, 'designs/missing.fig'))).toMatchObject({ reason: 'DESIGN_NOT_FOUND' });
  });

  it('reads and updates an existing non-canonical file but never creates one', async () => {
    const bytes = await makeFig({ canvas: 'agent' });
    await mkdir(path.dirname(projectFile('designs/My Design.fig')), { recursive: true });
    await writeFile(projectFile('designs/My Design.fig'), bytes);
    const read = await service.read(PROJECT, 'designs/My Design.fig');
    expect(read.sha256).toBe(sha256(bytes));
    const next = await makeFig({ canvas: 'edited' });
    expect(await service.write(PROJECT, 'designs/My Design.fig', next, { ifMatch: read.sha256 })).toMatchObject({ created: false });
    expect(await rejection(service.write(PROJECT, 'designs/Other Design.fig', next, { ifNoneMatch: '*' }))).toMatchObject({ reason: 'INVALID_DESIGN_PATH' });
  });

  it('serves the stored cover while it matches, then the embedded thumbnail, else nothing', async () => {
    const thumbnail = makePng(4, 4, [1, 2, 3, 255]);
    const first = await makeFig({ canvas: 'cover-1', thumbnail });
    await service.write(PROJECT, 'designs/cover.fig', first, { ifNoneMatch: '*' });
    // No stored cover yet: the embedded thumbnail.
    expect(await service.readCover(PROJECT, 'designs/cover.fig')).toMatchObject({ source: 'thumbnail', png: thumbnail });
    const cover = makePng(16, 9);
    await service.writeCover(PROJECT, 'designs/cover.fig', cover, sha256(first));
    const stored = await service.readCover(PROJECT, 'designs/cover.fig');
    expect(stored).toMatchObject({ source: 'cover', etag: `"${sha256(cover)}"` });
    expect(stored?.png).toEqual(cover);
    const meta = JSON.parse(await readFile(designCoverPaths(roots.runtimeDataDir, PROJECT, 'designs/cover.fig').meta, 'utf8'));
    expect(meta).toMatchObject({ path: 'designs/cover.fig', docSha256: sha256(first), width: 16, height: 9 });
    // The document changed: the stored cover is stale, the new embedded thumbnail is served.
    const nextThumbnail = makePng(5, 5, [9, 9, 9, 255]);
    const second = await makeFig({ canvas: 'cover-2', thumbnail: nextThumbnail });
    await service.write(PROJECT, 'designs/cover.fig', second, { ifMatch: sha256(first) });
    expect(await service.readCover(PROJECT, 'designs/cover.fig')).toMatchObject({ source: 'thumbnail', png: nextThumbnail });
    // A 1×1 placeholder thumbnail (or none) gives no cover.
    await service.write(PROJECT, 'designs/blank.fig', await makeFig({ canvas: 'blank', thumbnail: makePng(1, 1) }), { ifNoneMatch: '*' });
    expect(await service.readCover(PROJECT, 'designs/blank.fig')).toBeNull();
    await service.write(PROJECT, 'designs/none.fig', await makeFig({ canvas: 'none', thumbnail: null }), { ifNoneMatch: '*' });
    expect(await service.readCover(PROJECT, 'designs/none.fig')).toBeNull();
    await service.write(PROJECT, 'designs/doc.op', makeOp(), { ifNoneMatch: '*' });
    expect(await service.readCover(PROJECT, 'designs/doc.op')).toBeNull();
    expect(await service.readCover(PROJECT, 'designs/missing.fig')).toBeNull();
    expect(await extractFigThumbnail(Buffer.from('fig-kiwi'))).toBeNull();
  });

  it('stops inflating an embedded thumbnail that understates its size', async () => {
    // 256 MiB of zeros declared as 1 KiB, in a .fig of about a quarter MiB.
    const crafted = makeFigWithOversizedThumbnail(256);
    expect(crafted.length).toBeLessThan(1024 * 1024);
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 1);
    try {
      expect(await extractFigThumbnail(crafted)).toBeNull();
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    // Inflating stops past the 8 MiB cover cap instead of holding the whole entry in memory first.
    expect(peak - baseline).toBeLessThan(96 * 1024 * 1024);
    await service.write(PROJECT, 'designs/crafted.fig', crafted, { ifNoneMatch: '*' });
    expect(await service.readCover(PROJECT, 'designs/crafted.fig')).toBeNull();
  });

  it('rejects stale and invalid cover writes', async () => {
    const doc = await makeFig({ canvas: 'covers' });
    await service.write(PROJECT, 'designs/covers.fig', doc, { ifNoneMatch: '*' });
    const stale = await rejection(service.writeCover(PROJECT, 'designs/covers.fig', makePng(8, 8), 'a'.repeat(64)));
    expect(stale).toBeInstanceOf(DesignConflictError);
    expect(stale).toMatchObject({ reason: 'DESIGN_COVER_STALE', currentSha256: sha256(doc) });
    expect(await rejection(service.writeCover(PROJECT, 'designs/gone.fig', makePng(8, 8), sha256(doc)))).toMatchObject({
      reason: 'DESIGN_COVER_STALE',
      currentSha256: null,
    });
    expect(await rejection(service.writeCover(PROJECT, 'designs/covers.fig', Buffer.from('not a png'), sha256(doc)))).toMatchObject({ reason: 'INVALID_COVER' });
    expect(await rejection(service.writeCover(PROJECT, 'designs/covers.fig', makePng(4097, 1), sha256(doc)))).toMatchObject({ reason: 'INVALID_COVER' });
    expect(await rejection(service.writeCover(PROJECT, 'designs/covers.fig', makePng(8, 8), 'nope'))).toMatchObject({ reason: 'INVALID_COVER' });
  });

  it('imports legacy documents idempotently and never touches the legacy store', async () => {
    const legacyBytes = await makeFig({ canvas: 'legacy' });
    await legacyStore.save('legacy-1', legacyInput('首页 设计', legacyBytes));
    const legacyFile = path.join(roots.runtimeDataDir, 'design-canvas', 'legacy-1.json');
    const legacyBefore = await readFile(legacyFile);
    const legacyMtime = (await stat(legacyFile)).mtimeMs;

    const first = await service.importLegacy(PROJECT, 'legacy-1', undefined);
    expect(first.alreadyImported).toBe(false);
    expect(first.summary).toMatchObject({ path: 'designs/首页-设计.fig', format: 'fig', sha256: sha256(legacyBytes) });
    expect(first.migration).toMatchObject({
      legacyId: 'legacy-1',
      legacySha256: sha256(legacyBytes),
      projectId: PROJECT,
      path: 'designs/首页-设计.fig',
      sha256: sha256(legacyBytes),
    });
    expect(await readFile(projectFile('designs/首页-设计.fig'))).toEqual(legacyBytes);
    expect(await service.listMigrations()).toEqual([first.migration]);

    const again = await service.importLegacy(PROJECT, 'legacy-1', undefined);
    expect(again).toMatchObject({ alreadyImported: true, migration: first.migration, summary: { path: 'designs/首页-设计.fig' } });
    expect(await service.listMigrations()).toHaveLength(1);

    // Another legacy document with the same name gets `-2`.
    await legacyStore.save('legacy-2', legacyInput('首页 设计', await makeFig({ canvas: 'other' })));
    expect((await service.importLegacy(PROJECT, 'legacy-2', undefined)).summary.path).toBe('designs/首页-设计-2.fig');
    // An explicit path must be free and canonical, with the document's format.
    await legacyStore.save('legacy-3', legacyInput('third', makeOp('third'), 'op'));
    expect(await rejection(service.importLegacy(PROJECT, 'legacy-3', 'designs/首页-设计.fig'))).toMatchObject({ reason: 'INVALID_DESIGN_PATH' });
    await service.write(PROJECT, 'designs/taken.op', makeOp('taken'), { ifNoneMatch: '*' });
    expect(await rejection(service.importLegacy(PROJECT, 'legacy-3', 'designs/taken.op'))).toMatchObject({ reason: 'PATH_EXISTS' });
    expect((await service.importLegacy(PROJECT, 'legacy-3', 'designs/third-copy.op')).summary.path).toBe('designs/third-copy.op');
    expect(await rejection(service.importLegacy(PROJECT, 'missing-doc', undefined))).toMatchObject({ reason: 'LEGACY_NOT_FOUND' });
    expect(await rejection(service.importLegacy(PROJECT, '../escape', undefined))).toMatchObject({ reason: 'LEGACY_NOT_FOUND' });

    // When the imported copy was edited, the same legacy bytes are imported again (06 §7.3 idempotency rule).
    const edited = await makeFig({ canvas: 'edited' });
    await service.write(PROJECT, 'designs/首页-设计.fig', edited, { ifMatch: sha256(legacyBytes) });
    const reimported = await service.importLegacy(PROJECT, 'legacy-1', undefined);
    expect(reimported).toMatchObject({ alreadyImported: false, summary: { path: 'designs/首页-设计-3.fig' } });

    // The legacy store is unchanged, and the ledger is invisible to it.
    expect(await readFile(legacyFile)).toEqual(legacyBefore);
    expect((await stat(legacyFile)).mtimeMs).toBe(legacyMtime);
    expect(await readFile(designMigrationLedgerPath(roots.runtimeDataDir), 'utf8')).toContain('"legacy-1"');
    expect((await legacyStore.list()).map((doc) => doc.id).sort()).toEqual(['legacy-1', 'legacy-2', 'legacy-3']);
    expect(await legacyStore.read('legacy-1')).toMatchObject({ data: legacyBytes.toString('base64') });
  });

  it('rejects legacy documents whose bytes are unusable', async () => {
    await legacyStore.save('broken', legacyInput('broken', Buffer.from('not a design file')));
    expect(await rejection(service.importLegacy(PROJECT, 'broken', undefined))).toMatchObject({ reason: 'INVALID_DESIGN_DATA' });
    expect(await rejection(service.legacyInfo('broken'))).toMatchObject({ reason: 'INVALID_DESIGN_DATA' });
    expect(await service.legacyInfo('absent')).toBeNull();
    expect(await service.listMigrations()).toEqual([]);
  });
});
