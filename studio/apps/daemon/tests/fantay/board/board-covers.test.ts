import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOARD_COVER_GC_MAX_FILES,
  BOARD_COVER_GC_MIN_AGE_MS,
  gcBoardCovers,
  gcOrphanBoardCoverDirs,
  normalizeBoardCoverContentType,
  readBoardCover,
  sniffBoardCoverMime,
  writeBoardCover,
} from '../../../src/fantay/board/covers.js';
import { boardCoverDir, boardCoverFile, boardCoversRoot } from '../../../src/fantay/board/paths.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);

describe('board cover sniffing', () => {
  it('recognizes PNG, JPEG and WebP by their magic bytes only', () => {
    expect(sniffBoardCoverMime(PNG)).toBe('image/png');
    expect(sniffBoardCoverMime(JPEG)).toBe('image/jpeg');
    expect(sniffBoardCoverMime(WEBP)).toBe('image/webp');
    expect(sniffBoardCoverMime(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffBoardCoverMime(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]))).toBeNull();
    expect(sniffBoardCoverMime(PNG.subarray(0, 4))).toBeNull();
    expect(sniffBoardCoverMime(Buffer.alloc(0))).toBeNull();
  });

  it('normalizes the declared content type', () => {
    expect(normalizeBoardCoverContentType('image/png; charset=binary')).toBe('image/png');
    expect(normalizeBoardCoverContentType(' IMAGE/JPEG ')).toBe('image/jpeg');
    expect(normalizeBoardCoverContentType('image/gif')).toBeNull();
    expect(normalizeBoardCoverContentType(undefined)).toBeNull();
  });
});

describe('board cover storage', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'od-board-covers-'));
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('derives every path from the explicit data root and rejects unsafe ids', () => {
    expect(boardCoversRoot(dataDir)).toBe(path.join(dataDir, 'fantay', 'board-covers'));
    expect(boardCoverDir(dataDir, 'proj-1')).toBe(path.join(dataDir, 'fantay', 'board-covers', 'proj-1'));
    expect(() => boardCoverDir(dataDir, '..')).toThrow();
    expect(() => boardCoverDir(dataDir, 'a/b')).toThrow();
    expect(() => boardCoverFile(dataDir, 'proj-1', 'not-a-digest', 'png')).toThrow();
    expect(() => boardCoversRoot('')).toThrow();
  });

  it('writes content-addressed blobs once and reads them back', async () => {
    const digest = createHash('sha256').update(PNG).digest('hex');
    const first = await writeBoardCover(dataDir, 'proj-1', PNG, 'image/png');
    const second = await writeBoardCover(dataDir, 'proj-1', PNG, 'image/png');
    expect(first).toMatchObject({ digest, created: true });
    expect(second).toMatchObject({ digest, created: false });
    expect(first.file).toBe(path.join(dataDir, 'fantay', 'board-covers', 'proj-1', `${digest}.png`));
    expect(await readBoardCover(dataDir, 'proj-1', digest)).toEqual({ bytes: PNG, mime: 'image/png' });
    expect(await readBoardCover(dataDir, 'proj-2', digest)).toBeNull();
    expect(await readBoardCover(dataDir, '..', digest)).toBeNull();
    expect(await readBoardCover(dataDir, 'proj-1', '../../etc/passwd')).toBeNull();
    const webp = await writeBoardCover(dataDir, 'proj-1', WEBP, 'image/webp');
    expect(await readBoardCover(dataDir, 'proj-1', webp.digest)).toEqual({ bytes: WEBP, mime: 'image/webp' });
    await expect(writeBoardCover(dataDir, '../escape', PNG, 'image/png')).rejects.toThrow();
  });

  it('collects old unreferenced covers only once a project holds more than 300 files', async () => {
    const now = 1_800_000_000_000;
    const dir = boardCoverDir(dataDir, 'proj-1');
    await mkdir(dir, { recursive: true });
    const digests: string[] = [];
    for (let index = 0; index < BOARD_COVER_GC_MAX_FILES; index += 1) {
      const digest = createHash('sha256').update(`cover-${index}`).digest('hex');
      digests.push(digest);
      const file = path.join(dir, `${digest}.png`);
      await writeFile(file, PNG);
      const old = (now - BOARD_COVER_GC_MIN_AGE_MS - 60_000) / 1000;
      await utimes(file, old, old);
    }
    // Exactly at the threshold nothing is collected.
    expect(await gcBoardCovers(dataDir, 'proj-1', new Set(), { now })).toEqual([]);
    // One more (young) file crosses the threshold.
    const young = createHash('sha256').update('young').digest('hex');
    await writeFile(path.join(dir, `${young}.png`), PNG);
    await utimes(path.join(dir, `${young}.png`), (now - 1_000) / 1000, (now - 1_000) / 1000);
    await writeFile(path.join(dir, 'notes.txt'), 'foreign file');
    const referenced = new Set([digests[0]!, digests[1]!]);
    const deleted = await gcBoardCovers(dataDir, 'proj-1', referenced, { now });
    expect(deleted).toHaveLength(BOARD_COVER_GC_MAX_FILES - 2);
    const left = (await readdir(dir)).sort();
    expect(left).toEqual([`${digests[0]}.png`, `${digests[1]}.png`, `${young}.png`, 'notes.txt'].sort());
    expect(await gcBoardCovers(dataDir, 'missing-project', new Set(), { now })).toEqual([]);
  });

  it('sweeps cover dirs whose project no longer exists', async () => {
    await writeBoardCover(dataDir, 'alive', PNG, 'image/png');
    await writeBoardCover(dataDir, 'gone', PNG, 'image/png');
    const removed = await gcOrphanBoardCoverDirs(dataDir, (projectId) => projectId === 'alive');
    expect(removed).toEqual(['gone']);
    expect(existsSync(boardCoverDir(dataDir, 'alive'))).toBe(true);
    expect(existsSync(boardCoverDir(dataDir, 'gone'))).toBe(false);
    expect(await gcOrphanBoardCoverDirs(path.join(dataDir, 'nowhere'), () => false)).toEqual([]);
  });
});
