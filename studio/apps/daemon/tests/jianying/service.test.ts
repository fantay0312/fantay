import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { createMovieDocument, type JianyingEnvironment } from '@open-design/contracts';
import { JianyingService, movieToJianying } from '../../src/jianying/service.js';
import { saveMovie } from '../../src/movie/store.js';

const resources = fileURLToPath(new URL('../../../../vendor/jianying-draft', import.meta.url));
const roots: string[] = [];
let sharedMediaDir = '';
const sharedClips: Record<'blue' | 'red' | 'green', string> = { blue: '', red: '', green: '' };
const environment: JianyingEnvironment = { platform: 'darwin', application: { installed: false, path: null, version: null, build: null, bundleId: null, running: false }, compatibility: 'not-installed', profile: null, capabilities: { create: true, editPlaintext: true, editEncrypted: false, install: true, automaticUpdate: false }, native: { available: false, prepared: false, reason: 'Unverified' }, ffprobe: true, draftsRoot: '/not-a-user-library', messages: [] };
beforeAll(async () => {
  sharedMediaDir = await mkdtemp(path.join(os.tmpdir(), 'jianying-shared-media-'));
  for (const color of ['blue', 'red', 'green'] as const) {
    const out = path.join(sharedMediaDir, `${color}.mp4`);
    execFileSync(ffmpeg.path, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30`, '-t', '6', '-pix_fmt', 'yuv420p', out], { stdio: 'ignore' });
    sharedClips[color] = out;
  }
});
afterAll(async () => { if (sharedMediaDir) await rm(sharedMediaDir, { recursive: true, force: true }); });
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const parent = path.resolve('.tmp'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, 'jianying-')); roots.push(dir);
  return { dir, service: new JianyingService({ resourceDir: resources, dataDir: path.join(dir, 'runtime') }, async () => structuredClone(environment)) };
}
it('creates, lists, inspects and edits real drafts through the isolated worker, preserving source bytes', async () => {
  const { dir, service } = await fixture();
  const created = await service.create(dir, { source: 'plan', spec: { name: 'Test', fps: 30000 / 1001, clips: [{ type: 'text', text: 'Original 🪄', duration: 3 }] } });
  expect(created.validation.valid).toBe(true); expect(created.inspection.fps).toBe(30000 / 1001);
  const source = path.join(created.draft.path, 'draft_info.json'), before = createHash('sha256').update(await readFile(source)).digest('hex');
  const segmentId = created.inspection.tracks[0]!.segments[0]!.id;
  const edited = await service.edit(dir, { draftId: created.draft.id, operations: [{ op: 'set_text', segmentId, text: 'Changed ✅' }] });
  expect(edited.sourcePreserved).toBe(true); expect(edited.draft.id).not.toBe(created.draft.id); expect(edited.inspection.tracks[0]!.segments[0]!.text).toBe('Changed ✅');
  expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(before);
  expect(await service.list(dir)).toHaveLength(2); expect((await service.inspect(dir, edited.draft.id)).validation.valid).toBe(true);
});
it('exports saved timeline text and requires the exact revision', async () => {
  const { dir, service } = await fixture(), movie = createMovieDocument('Timeline', 'blank');
  movie.shots = [{ id: 'text', kind: 'text', title: 'Title', body: 'Body', duration: 2, layout: 'title', placement: { start: 1, track: 3 }, captions: [{ start: 0.5, end: 1.5, text: 'Caption' }] }];
  const saved = await saveMovie(dir, { expectedRevision: 0, document: movie });
  await expect(service.create(dir, { expectedRevision: saved.revision + 1 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  const result = await service.create(dir, { expectedRevision: saved.revision });
  expect(result.inspection.tracks.flatMap(t => t.segments).map(s => s.start)).toEqual([1, 1.5]);
});
it('rejects external media paths and source-root symlinks before reading a draft', async () => {
  const { dir, service } = await fixture();
  await expect(service.create(dir, { source: 'plan', spec: { name: 'bad', clips: [{ type: 'video', path: '../secret.mp4', duration: 1 }] } })).rejects.toThrow();
  const external = await fixture(); await mkdir(path.join(external.dir, 'draft')); await symlink(external.dir, path.join(dir, 'jianying-drafts'));
  await expect(service.source(dir, 'project:' + Buffer.from('draft').toString('base64url'))).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await expect(service.source(dir, 'local:YW55')).rejects.toMatchObject({ code: 'DRAFT_ACCESS_DENIED' });
});
it('requires explicit consent for an unverified installed client', async () => {
  const { dir } = await fixture(), service = new JianyingService({ resourceDir: resources, dataDir: path.join(dir, 'runtime') }, async () => ({ ...environment, compatibility: 'unverified', application: { ...environment.application, installed: true, version: '99.0.0' } }));
  const request = { source: 'plan' as const, spec: { name: 'Unverified', clips: [] } };
  await expect(service.create(dir, request)).rejects.toMatchObject({ code: 'UNVERIFIED_VERSION' });
  expect((await service.create(dir, { ...request, allowUnverified: true })).validation.valid).toBe(true);
});
it('refuses effects that cannot be transferred instead of silently dropping them', async () => {
  const { dir } = await fixture(), movie = createMovieDocument('Animation');
  await expect(movieToJianying(dir, movie)).rejects.toMatchObject({ code: 'UNSUPPORTED_TIMELINE' });
});
it('refuses secret subtitle inputs without leaking their contents', async () => {
  const { dir, service } = await fixture();
  const created = await service.create(dir, { source: 'plan', spec: { name: 'Safe', clips: [{ type: 'text', text: 'Visible', duration: 1 }] } });
  await writeFile(path.join(dir, '.env'), 'API_TOKEN=sentinel-value');
  let message = '';
  try { await service.edit(dir, { draftId: created.draft.id, operations: [{ op: 'import_srt', path: '.env' }] }); }
  catch (error) { message = (error as Error).message; }
  expect(message).toContain('non-secret'); expect(message).not.toContain('sentinel-value');
});

it('creates drafts with keyframes, transitions and audio fades through service', async () => {
  const { dir, service } = await fixture();
  const v1 = path.join(dir, 'clip1.mp4');
  const v2 = path.join(dir, 'clip2.mp4');
  await Promise.all([copyFile(sharedClips.blue, v1), copyFile(sharedClips.red, v2)]);

  const created = await service.create(dir, {
    source: 'plan',
    spec: {
      name: 'Advanced Draft',
      fps: 30,
      clips: [
        {
          type: 'video',
          path: 'clip1.mp4',
          duration: 4,
          keyframes: [
            { at: 0, opacity: 1, scaleX: 1, scaleY: 1 },
            { at: 2, opacity: 0.5, scaleX: 1.2, scaleY: 1.2 },
          ],
          transition: { name: '叠化', duration: 0.5 },
          fade: { in: 0.5, out: 0.5 },
        },
        {
          type: 'video',
          path: 'clip2.mp4',
          start: 4,
          duration: 4,
        },
      ],
    },
  });
  expect(created.validation.valid).toBe(true);
  const data = JSON.parse(await readFile(path.join(created.draft.path, 'draft_info.json'), 'utf8'));
  const seg1 = data.tracks[0].segments[0];
  expect(seg1.common_keyframes).toHaveLength(3); // opacity, scaleX, scaleY
  expect(data.materials.transitions).toHaveLength(1);
  expect(data.materials.transitions[0].name).toBe('叠化');
  expect(seg1.extra_material_refs).toContain(data.materials.transitions[0].id);
  expect(data.materials.audio_fades).toHaveLength(1);
});

it('supports set_keyframes and set_transition in transactional edits', async () => {
  const { dir, service } = await fixture();
  const v1 = path.join(dir, 'clip1.mp4');
  const v2 = path.join(dir, 'clip2.mp4');
  await Promise.all([copyFile(sharedClips.blue, v1), copyFile(sharedClips.red, v2)]);

  const created = await service.create(dir, {
    source: 'plan',
    spec: {
      name: 'Editable',
      fps: 30,
      clips: [
        { type: 'video', path: 'clip1.mp4', duration: 4 },
        { type: 'video', path: 'clip2.mp4', start: 4, duration: 4 },
      ],
    },
  });
  const seg0Id = created.inspection.tracks[0]!.segments[0]!.id;
  const edited = await service.edit(dir, {
    draftId: created.draft.id,
    operations: [
      {
        op: 'set_keyframes',
        segmentId: seg0Id,
        keyframes: [
          { at: 0, opacity: 0.2 },
          { at: 2, opacity: 1 },
        ],
      },
      {
        op: 'set_transition',
        segmentId: seg0Id,
        transition: { name: '推近', duration: 0.6 },
      },
    ],
  });
  expect(edited.sourcePreserved).toBe(true);
  const data = JSON.parse(await readFile(path.join(edited.draft.path, 'draft_info.json'), 'utf8'));
  const seg = data.tracks[0].segments[0];
  expect(seg.common_keyframes).toHaveLength(1);
  expect(seg.common_keyframes[0].property_type).toBe('KFTypeAlpha');
  expect(data.materials.transitions[0].name).toBe('推近');
});

it('splits a keyframed clip with linear interpolation', async () => {
  const { dir, service } = await fixture();
  const v1 = path.join(dir, 'clip1.mp4');
  await copyFile(sharedClips.blue, v1);

  const created = await service.create(dir, {
    source: 'plan',
    spec: {
      name: 'SplitKeyframe',
      fps: 30,
      clips: [
        {
          type: 'video',
          path: 'clip1.mp4',
          duration: 4,
          keyframes: [
            { at: 0, opacity: 0 },
            { at: 4, opacity: 1 },
          ],
        },
      ],
    },
  });
  const segId = created.inspection.tracks[0]!.segments[0]!.id;
  const edited = await service.edit(dir, {
    draftId: created.draft.id,
    operations: [{ op: 'split', segmentId: segId, at: 2 }],
  });
  expect(edited.validation.valid).toBe(true);
  const data = JSON.parse(await readFile(path.join(edited.draft.path, 'draft_info.json'), 'utf8'));
  const [left, right] = data.tracks[0].segments;
  expect(left.target_timerange.duration).toBe(2000000);
  expect(right.target_timerange.duration).toBe(2000000);
  const leftAlphaList = left.common_keyframes[0].keyframe_list;
  expect(leftAlphaList[leftAlphaList.length - 1].values[0]).toBeCloseTo(0.5);
  const rightAlphaList = right.common_keyframes[0].keyframe_list;
  expect(rightAlphaList[0].values[0]).toBeCloseTo(0.5);
});

it('handles ripple delete on adjacent clips with transitions safely', async () => {
  const { dir, service } = await fixture();
  const v1 = path.join(dir, 'c1.mp4');
  const v2 = path.join(dir, 'c2.mp4');
  const v3 = path.join(dir, 'c3.mp4');
  await Promise.all([
    copyFile(sharedClips.blue, v1),
    copyFile(sharedClips.red, v2),
    copyFile(sharedClips.green, v3),
  ]);

  const created = await service.create(dir, {
    source: 'plan',
    spec: {
      name: 'RippleTransition',
      fps: 30,
      clips: [
        { type: 'video', path: 'c1.mp4', duration: 4, transition: { name: '叠化', duration: 0.5 } },
        { type: 'video', path: 'c2.mp4', start: 4, duration: 4, transition: { name: '推近', duration: 0.5 } },
        { type: 'video', path: 'c3.mp4', start: 8, duration: 4 },
      ],
    },
  });
  const seg1Id = created.inspection.tracks[0]!.segments[1]!.id;
  const edited = await service.edit(dir, {
    draftId: created.draft.id,
    operations: [{ op: 'delete', segmentId: seg1Id, ripple: true }],
  });
  expect(edited.validation.valid).toBe(true);
  const data = JSON.parse(await readFile(path.join(edited.draft.path, 'draft_info.json'), 'utf8'));
  expect(data.tracks[0].segments).toHaveLength(2);
  expect(data.tracks[0].segments[0].target_timerange.duration).toBe(4000000);
  expect(data.tracks[0].segments[1].target_timerange.start).toBe(4000000);
});

it('exports movie documents with keyframes, transitions and audio fades without UNSUPPORTED_TIMELINE', async () => {
  const { dir } = await fixture();
  const v1 = path.join(dir, 'media/video1.mp4');
  const v2 = path.join(dir, 'media/video2.mp4');
  await mkdir(path.join(dir, 'media'), { recursive: true });
  await Promise.all([copyFile(sharedClips.blue, v1), copyFile(sharedClips.red, v2)]);

  const movie = createMovieDocument('KeyframeMovie', 'blank');
  movie.shots = [
    {
      id: 'shot1',
      title: 'Shot 1',
      body: '',
      duration: 3,
      layout: 'title',
      media: 'media/video1.mp4',
      clip: {
        assetId: 'asset1',
        in: 0,
        rate: 1,
        volume: 1,
        fit: 'cover',
        keyframes: [
          { at: 0, opacity: 1, x: 0, y: 0 },
          { at: 1, opacity: 0.5, x: 10, y: 0 },
        ],
        fadeIn: 0.5,
        fadeOut: 0.5,
      },
      visual: {
        composition: 'custom',
        copy: { x: 0, y: 0, width: 100, align: 'center', titleSize: 24, bodySize: 16 },
        layers: [],
        transition: 'crossfade',
        transitionDuration: 0.5,
      },
    },
    {
      id: 'shot2',
      title: 'Shot 2',
      body: '',
      duration: 3,
      layout: 'title',
      media: 'media/video2.mp4',
      clip: { assetId: 'asset2', in: 0, rate: 1, volume: 1, fit: 'cover' },
    },
  ];
  const { spec } = await movieToJianying(dir, movie);
  const clip0 = spec.clips[0]!;
  expect(clip0.keyframes).toBeDefined();
  expect(clip0.keyframes).toHaveLength(2);
  expect(clip0.transition).toBeDefined();
  expect(clip0.fade).toEqual({ in: 0.5, out: 0.5 });
});
