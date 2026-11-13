import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createMovieDocument, buildMovieHtml } from '@open-design/contracts';
import { initializeIntegratedEditor, integratedEditorStatus, importEditorMedia } from '../../src/movie/integrated-editor.js';
import { movieFfmpeg, movieVideoSources, stageMovieClips } from '../../src/movie/video-sources.js';
import { saveMovie, readMovie } from '../../src/movie/store.js';
import { editMovie, stepMovieHistory } from '../../src/movie/edits.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const parent = path.resolve('.tmp'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, 'integrated-editor-')); roots.push(dir);
  await saveMovie(dir, { expectedRevision: 0, document: { ...createMovieDocument('Integrated film'), shots: [] } });
  return dir;
}

it('imports the latest native edits without opening an application, preserves exact NTSC timing and the original files', async () => {
  const dir = await fixture(), source = path.join(dir, 'original.palmier'); await mkdir(source);
  const old = (await readMovie(dir))!;
  await saveMovie(dir, { expectedRevision: old.revision, document: { ...old, title: 'Historical host title' } });
  execFileSync(movieFfmpeg(), ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30000/1001', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1.001', '-c:v', 'libx264', '-c:a', 'aac', path.join(source, 'source.mp4')]);
  const timeline = { id: 'active', fps: { numerator: 30000, denominator: 1001 }, width: 1920, height: 1080, tracks: [
    { id: 'video', type: 'video', clips: [{ id: 'first', mediaRef: 'source', mediaType: 'video', startFrame: 0, durationFrames: 12 }, { id: 'last', mediaRef: 'source', mediaType: 'video', startFrame: 12, durationFrames: 18, trimStartFrame: 12 }] },
    { id: 'sound', type: 'audio', clips: [{ id: 'audio', mediaRef: 'source', mediaType: 'audio', startFrame: 0, durationFrames: 30, volume: 0.5 }] },
  ] };
  const project = JSON.stringify({ timelines: [timeline], activeTimelineId: 'active' });
  await writeFile(path.join(source, 'project.json'), project);
  await writeFile(path.join(source, 'media.json'), JSON.stringify({ entries: [{ id: 'source', name: 'Real source', source: { project: { relativePath: 'source.mp4' } } }] }));
  await writeFile(path.join(dir, '.fantay-native-editor.json'), JSON.stringify({ path: source }));
  expect((await integratedEditorStatus(dir)).migrationPending).toBe(true);
  const migrated = await initializeIntegratedEditor(dir);
  expect(migrated.shots.map(s => [s.id, s.duration, s.clip?.in, s.clip?.audioOnly])).toEqual([
    ['first', 12 * 1001 / 30000, 0, false], ['last', 18 * 1001 / 30000, 12 * 1001 / 30000, false], ['audio', 1.001, 0, true],
  ]);
  expect(migrated.shots[0]!.clip!.volume).toBe(0);
  expect(migrated.shots[2]!.clip!.volume).toBe(0.5);
  expect(migrated.settings?.frameRate).toEqual({ numerator: 30000, denominator: 1001 });
  expect(await readFile(path.join(source, 'project.json'), 'utf8')).toBe(project);
  expect((await initializeIntegratedEditor(dir)).revision).toBe(migrated.revision);
  expect((await integratedEditorStatus(dir)).migrationPending).toBe(false);
  expect(migrated.editHistory).toMatchObject({ undoCount: 0, redoCount: 0 });
  expect(migrated.editHistory?.blocked).not.toBe(true);
  const manual = await editMovie(dir, { expectedRevision: migrated.revision, operations: [{ op: 'update-shot', shotId: 'first', changes: { title: 'Manual edit after import' } }] });
  expect(manual.document.editHistory).toMatchObject({ undoCount: 1 });
  const restored = await stepMovieHistory(dir, { expectedRevision: manual.document.revision }, 'undo');
  expect(restored.document.shots.map(s => s.id)).toEqual(['first', 'last', 'audio']);
  expect(restored.document.shots[0]!.title).toBe(migrated.shots[0]!.title);
});

it('keeps the host document unchanged if an old project cannot be fully read', async () => {
  const dir = await fixture(), source = path.join(dir, 'unreadable.palmier'); await mkdir(source);
  await writeFile(path.join(source, 'project.json'), JSON.stringify({ fps: 30, tracks: [{ clips: [{ id: 'nested', mediaRef: 'missing', mediaType: 'sequence', startFrame: 0, durationFrames: 30 }] }] }));
  await writeFile(path.join(source, 'media.json'), JSON.stringify({ entries: [] }));
  await writeFile(path.join(dir, '.fantay-native-editor.json'), JSON.stringify({ path: source }));
  const before = await readFile(path.join(dir, 'movie-studio.json'), 'utf8');
  await expect(initializeIntegratedEditor(dir)).rejects.toThrow(/missing media|nested sequence/);
  expect(await readFile(path.join(dir, 'movie-studio.json'), 'utf8')).toBe(before);
});

it('keeps linked native audio synchronized through import, earlier-import repair, manual split and undo', async () => {
  const dir = await fixture(), source = path.join(dir, 'linked.palmier'); await mkdir(source);
  execFileSync(movieFfmpeg(), ['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=30','-f','lavfi','-i','sine=frequency=440','-t','1','-c:v','libx264','-c:a','aac',path.join(source,'source.mp4')]);
  const clip = { mediaRef:'source',startFrame:0,durationFrames:30,linkGroupId:'linked' };
  await writeFile(path.join(source,'project.json'),JSON.stringify({fps:30,width:1920,height:1080,tracks:[{type:'video',clips:[{...clip,id:'video',mediaType:'video'}]},{type:'audio',clips:[{...clip,id:'audio',mediaType:'audio',volume:0.4,fadeInFrames:6}]}]}));
  await writeFile(path.join(source,'media.json'),JSON.stringify({entries:[{id:'source',name:'Linked footage',source:{project:{relativePath:'source.mp4'}}}]}));
  await writeFile(path.join(dir,'.fantay-native-editor.json'),JSON.stringify({path:source}));
  const imported = await initializeIntegratedEditor(dir);
  expect(imported.shots).toHaveLength(1);
  expect(imported.shots[0]!.clip).toMatchObject({volume:0.4,audioOnly:false,audioFadeIn:0.2});
  expect(buildMovieHtml(imported).match(/<audio /g)).toHaveLength(1);
  const v = imported.shots[0]!;
  const earlier = await saveMovie(dir,{expectedRevision:imported.revision,document:{...imported,shots:[{...v,title:'Manual title from earlier import',clip:{...v.clip!,volume:0}},{...v,id:'audio',title:'Independent representation',clip:{...v.clip!,audioOnly:true,volume:0.4,fadeIn:0.2}}]}});
  const stored = JSON.parse(await readFile(path.join(dir,'movie-studio.json'),'utf8'));
  stored.editorMigration.version=1;
  await writeFile(path.join(dir,'movie-studio.json'),JSON.stringify(stored));
  const repaired = await initializeIntegratedEditor(dir);
  expect(repaired.revision).toBeGreaterThan(earlier.revision);
  expect(repaired.editorMigration?.version).toBe(2);
  expect(repaired.shots).toHaveLength(1);
  expect(repaired.shots[0]!.title).toBe('Manual title from earlier import');
  expect(repaired.editHistory?.blocked).not.toBe(true);
  const split = await editMovie(dir,{expectedRevision:repaired.revision,operations:[{op:'split-clip',shotId:'video',at:0.5,newShotId:'tail'}]});
  expect(split.document.shots.map(s=>[s.duration,s.clip?.in,s.clip?.volume])).toEqual([[0.5,0,0.4],[0.5,0.5,0.4]]);
  expect(split.document.shots.map(s=>s.clip?.audioFadeIn)).toEqual([0.2,0]);
  const undo = await stepMovieHistory(dir,{expectedRevision:split.document.revision},'undo');
  expect(undo.document.shots).toHaveLength(1);
});

it('edits independent WAV audio and text in the same persistent undo history and stages a real audio export', async () => {
  const dir = await fixture();
  execFileSync(movieFfmpeg(), ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660', '-t', '2', path.join(dir, 'music.wav')]);
  const imported = await importEditorMedia(dir, (await readMovie(dir))!.revision, 'music.wav');
  const edited = await editMovie(dir, { expectedRevision: imported.document.revision, operations: [
    { op: 'insert-clip', assetId: imported.assetId, index: 0, duration: 2, newShotId: 'music' },
    { op: 'insert-text', text: '中文字幕', at: 0.5, duration: 1, track: 1, newShotId: 'title' },
  ] });
  expect(edited.document.shots[0]!.clip?.audioOnly).toBe(true);
  expect((await movieVideoSources(dir, edited.document))[0]).toMatchObject({ kind: 'audio', hasAudio: true, frames: [] });
  const undone = await stepMovieHistory(dir, { expectedRevision: edited.document.revision }, 'undo');
  expect(undone.document.shots).toHaveLength(0);
  const redone = await stepMovieHistory(dir, { expectedRevision: undone.document.revision }, 'redo');
  expect(redone.document.shots.map(s => s.id)).toEqual(['music', 'title']);
  await mkdir(path.join(dir, 'render', 'media'), { recursive: true });
  await writeFile(path.join(dir, 'render', 'music.wav'), await readFile(path.join(dir, 'music.wav')));
  const staged = structuredClone(redone.document);
  const files = await stageMovieClips(dir, 'render', staged);
  expect(files[0]).toMatch(/\.m4a$/);
  expect((await readFile(path.join(dir, files[0]!))).length).toBeGreaterThan(1000);
});
