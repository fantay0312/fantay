import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMediaOperation, probeMedia, type MediaOpFiles } from '../../../src/fantay/media-ops/ops.js';
import { movieFfmpeg } from '../../../src/movie/video-sources.js';
import { resolveProjectFilePath, writeProjectFile } from '../../../src/projects.js';

const exec = promisify(execFile);
let sharedDir: string, sharedInputPng: string;
let root: string, dir: string, files: MediaOpFiles;
beforeAll(async () => {
  sharedDir = await mkdtemp(path.join(os.tmpdir(), 'media-ops-shared-'));
  sharedInputPng = path.join(sharedDir, 'input.png');
  await exec(movieFfmpeg(), ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90', '-frames:v', '1', sharedInputPng]);
});
afterAll(async () => { if (sharedDir) await rm(sharedDir, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'media-ops-test-'));
  dir = path.join(root, 'media-test');
  await mkdir(dir);
  await copyFile(sharedInputPng, path.join(dir, 'input.png'));
  files = {
    scratchRoot: path.join(root, 'scratch'),
    resolve: name => resolveProjectFilePath(root, 'media-test', name),
    write: (name, bytes) => writeProjectFile(root, 'media-test', name, bytes, { overwrite: false }),
  };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('project media operations', () => {
  it('crops, scales and splits real images with exact dimensions and distinct names', async () => {
    const crop = await runMediaOperation({ op: 'crop', input: 'input.png', params: { x: 5, y: 4, width: 63, height: 41 } }, files);
    expect(await probeMedia(path.join(dir, crop.files[0]!.path))).toMatchObject({ width: 63, height: 41 });
    const scaled = await runMediaOperation({ op: 'scale', input: 'input.png', params: { factor: 2 } }, files);
    expect(await probeMedia(path.join(dir, scaled.files[0]!.path))).toMatchObject({ width: 320, height: 180 });
    const split = await runMediaOperation({ op: 'split', input: 'input.png', params: { rows: 2, cols: 3 }, outputPrefix: 'parts/grid' }, files);
    expect(split.files.map(file => file.path)).toEqual(['parts/grid-r1c1.png','parts/grid-r1c2.png','parts/grid-r1c3.png','parts/grid-r2c1.png','parts/grid-r2c2.png','parts/grid-r2c3.png']);
    expect(split.files.slice(0,3).reduce((sum, file) => sum + file.width!, 0)).toBe(160);
    expect(split.files[0]).toMatchObject({ mime: 'image/png', height: 45 });
  });
  it('extracts a real video frame and crops video without losing requested dimensions', async () => {
    await exec(movieFfmpeg(), ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'input.mp4')]);
    const frame = await runMediaOperation({ op: 'frame', input: 'input.mp4', params: { timeSec: 0.25 } }, files);
    expect(await probeMedia(path.join(dir, frame.files[0]!.path))).toMatchObject({ width: 160, height: 90 });
    const crop = await runMediaOperation({ op: 'crop', input: 'input.mp4', params: { x: 0, y: 0, width: 80, height: 40 } }, files);
    expect(await probeMedia(path.join(dir, crop.files[0]!.path))).toMatchObject({ width: 80, height: 40 });
    await expect(runMediaOperation({ op: 'frame', input: 'input.mp4', params: { timeSec: 2 } }, files)).rejects.toThrow('before the end');
  });
  it('rejects traversal, absolute paths, invalid dimensions and external symlinks', async () => {
    for (const input of ['../input.png', '/input.png', 'file:///input.png']) {
      await expect(runMediaOperation({ op: 'scale', input, params: { factor: 2 } }, files)).rejects.toThrow();
    }
    await expect(runMediaOperation({ op: 'crop', input: 'input.png', params: { x: 150, y: 0, width: 20, height: 5 } }, files)).rejects.toThrow('inside');
    await expect(runMediaOperation({ op: 'scale', input: 'input.png', params: { width: 8193 } }, files)).rejects.toThrow();
    await writeFile(path.join(root, 'outside.png'), await readFile(path.join(dir, 'input.png')));
    await symlink(path.join(root, 'outside.png'), path.join(dir, 'escape.png'));
    await expect(runMediaOperation({ op: 'scale', input: 'escape.png', params: { factor: 2 } }, files)).rejects.toThrow('accessible');
    await symlink(root, path.join(dir, 'escape-dir'));
    await expect(runMediaOperation({ op: 'scale', input: 'input.png', params: { factor: 2 }, output: 'escape-dir/new.png' }, files)).rejects.toThrow();
    expect(await readdir(root)).not.toContain('new.png');
  });
  it('refuses overwrites before writing any split output and leaves original bytes unchanged', async () => {
    await mkdir(path.join(dir, 'parts'));
    await writeFile(path.join(dir, 'parts/grid-r2c2.png'), 'keep');
    await expect(runMediaOperation({ op: 'split', input: 'input.png', params: { rows: 2, cols: 2 }, outputPrefix: 'parts/grid' }, files)).rejects.toThrow('already exists');
    expect(await readdir(path.join(dir, 'parts'))).toEqual(['grid-r2c2.png']);
    expect(await readFile(path.join(dir, 'parts/grid-r2c2.png'), 'utf8')).toBe('keep');
  });
});
