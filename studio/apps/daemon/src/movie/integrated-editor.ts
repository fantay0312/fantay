import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { movieShotStarts, type MovieDocument, type MovieShot, type MovieStyleAsset } from '@open-design/contracts';
import { applyMovieEdit, MovieError, mutateMovie, parseMovieInput, readMovie, safeMovieAsset } from './store.js';
import { withNativeProject } from './native-project-queue.js';
import { probeMovieMedia } from './video-sources.js';
import { resetMovieHistory, storedMovie } from './edit-history.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const SUPPORTED = /\.(mp4|m4v|mov|webm|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif)$/i;

async function readJson(file: string): Promise<ObjectValue> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new MovieError('Invalid video project metadata');
  return object(JSON.parse(await readFile(file, 'utf8')));
}

function nativeTimeline(project: ObjectValue): ObjectValue {
  const timelines = Array.isArray(project.timelines) ? project.timelines.map(object) : [project];
  return timelines.find(t => t.id === project.activeTimelineId) ?? timelines[0]!;
}

/** Fold only genuine, time-aligned native A/V links. Unrelated music remains independent. */
function mergeLinkedAudio(project: ObjectValue, shots: MovieShot[]): MovieShot[] {
  const rawTracks = (Array.isArray(nativeTimeline(project).tracks) ? nativeTimeline(project).tracks : []) as unknown[];
  const rawClips: Array<ObjectValue & { isAudio: boolean }> = rawTracks.flatMap(raw => { const t = object(raw); return (Array.isArray(t.clips) ? t.clips : []).map(c => ({ ...object(c), isAudio: t.type === 'audio' || object(c).mediaType === 'audio' })); });
  const result = structuredClone(shots), removed = new Set<string>();
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-7;
  for (const raw of rawClips.filter(c => !c.isAudio && typeof c.linkGroupId === 'string')) {
    const partners = rawClips.filter(c => c.isAudio && c.linkGroupId === raw.linkGroupId && c.mediaRef === raw.mediaRef && c.startFrame === raw.startFrame && c.durationFrames === raw.durationFrames);
    if (partners.length !== 1) continue;
    const video = result.find(s => s.id === raw.id), audio = result.find(s => s.id === partners[0]!.id);
    if (!video?.clip || !audio?.clip?.audioOnly || video.clip.volume !== 0 || video.clip.assetId !== audio.clip.assetId || removed.has(audio.id) || audio.captions?.length) continue;
    if (!near(video.placement?.start ?? 0, audio.placement?.start ?? 0) || !near(video.duration, audio.duration) || !near(video.clip.in, audio.clip.in) || !near(video.clip.rate, audio.clip.rate)) continue;
    video.clip.volume = audio.clip.volume;
    video.clip.muted = audio.clip.muted ?? false;
    video.clip.audioFadeIn = audio.clip.fadeIn ?? 0;
    video.clip.audioFadeOut = audio.clip.fadeOut ?? 0;
    removed.add(audio.id);
  }
  const merged = result.filter(s => !removed.has(s.id));
  const videoTracks = [...new Set(merged.filter(s => !s.clip?.audioOnly).map(s => s.placement?.track ?? 0))].sort((a,b)=>a-b);
  const audioTracks = [...new Set(merged.filter(s => s.clip?.audioOnly).map(s => s.placement?.track ?? 0))].sort((a,b)=>a-b);
  for (const shot of merged) if (shot.placement) shot.placement.track = (shot.clip?.audioOnly ? audioTracks : videoTracks).indexOf(shot.placement.track);
  return merged;
}

export async function integratedEditorStatus(dir: string) {
  const doc = await readMovie(dir);
  let legacy = false;
  try { await lstat(path.join(dir, '.fantay-native-editor.json')); legacy = !doc?.editorMigration; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { supported: true, engine: 'integrated', project: null, migrationPending: legacy };
}

/** A one-way, revision-checked import. The former editor and its original package are never opened or changed. */
export async function initializeIntegratedEditor(dir: string): Promise<MovieDocument> {
  return withNativeProject(`integrated:${dir}`, async () => {
    const current = await readMovie(dir);
    if (!current) throw new MovieError('Create a video project first', 404);
    if (current.editorMigration) {
      if (current.editorMigration.version === 1) {
        const digest = current.editorMigration.sourceDigest;
        if (!/^[a-f0-9]{64}$/.test(digest)) throw new MovieError('Invalid video migration metadata');
        const archive = `.movie-migrations/${digest.slice(0,20)}`;
        const project = await readJson(await safeMovieAsset(dir, `${archive}/project.json`));
        const snapshot = `${archive}/host-v1-before.json`;
        try { await writeFile(path.join(dir, snapshot), JSON.stringify(storedMovie(current), null, 2), { flag: 'wx' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await safeMovieAsset(dir, snapshot); }
        return mutateMovie(dir, current.revision, doc => {
          const next = applyMovieEdit(doc!, parseMovieInput({ ...doc, shots: mergeLinkedAudio(project, doc!.shots) }), { history: false });
          next.editorMigration = { ...doc!.editorMigration!, version: 2 };
          resetMovieHistory(next);
          return next;
        });
      }
      if (current.editHistory?.blocked) return mutateMovie(dir, current.revision, doc => { resetMovieHistory(doc!); return doc!; });
      return current;
    }
    let association: ObjectValue;
    try { association = await readJson(path.join(dir, '.fantay-native-editor.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return current; throw error; }
    if (typeof association.path !== 'string' || !path.isAbsolute(association.path) || !association.path.endsWith('.palmier'))
      throw new MovieError('The former video project path is invalid; the original project has been preserved');
    const source = association.path;
    const project = await readJson(path.join(source, 'project.json'));
    const manifest = await readJson(path.join(source, 'media.json'));
    const digest = createHash('sha256').update(JSON.stringify([project, manifest])).digest('hex');
    const timelines = Array.isArray(project.timelines) ? project.timelines.map(object) : [project];
    const timeline = nativeTimeline(project);
    const rawRate = object(timeline.fps);
    const frameRate = typeof timeline.fps === 'number' ? { numerator: timeline.fps, denominator: 1 } : {
      numerator: finite(rawRate.numerator, 30), denominator: finite(rawRate.denominator, 1),
    };
    const fps = frameRate.numerator / frameRate.denominator;
    const seconds = (frames: unknown) => finite(frames, 0) * frameRate.denominator / frameRate.numerator;
    if (!(fps >= 1 && fps <= 120)) throw new MovieError('The former project has an unsupported frame rate; its original data is unchanged');
    const tracks = (Array.isArray(timeline.tracks) ? timeline.tracks : []).map(object);
    if (tracks.length > 8) throw new MovieError('This former project has more than 8 tracks. Its original data is preserved; automatic import has stopped.');
    const entries = (Array.isArray(manifest.entries) ? manifest.entries : []).map(object);
    const media = new Map<string, MovieStyleAsset>();
    const warnings = new Set<string>();
    const archive = `.movie-migrations/${digest.slice(0, 20)}`;
    for (const folder of ['.movie-migrations', archive, 'movie-media']) {
      await mkdir(path.join(dir, folder), { recursive: true });
      const stat = await lstat(path.join(dir, folder));
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MovieError('Invalid video import directory');
    }
    for (const [name, data] of Object.entries({ 'project.json': project, 'media.json': manifest, 'host-before.json': current })) {
      const file = path.join(dir, archive, name);
      try { await writeFile(file, JSON.stringify(data, null, 2), { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await safeMovieAsset(dir, `${archive}/${name}`); }
    }
    const used = new Set(tracks.flatMap(t => (Array.isArray(t.clips) ? t.clips : []).map(c => String(object(c).mediaRef))));
    for (const entry of entries) {
      if (typeof entry.id !== 'string' || !used.has(entry.id)) continue;
      const origin = object(entry.source), external = object(origin.external), local = object(origin.project);
      const input = typeof external.absolutePath === 'string' ? external.absolutePath :
        typeof local.relativePath === 'string' ? path.resolve(source, local.relativePath) : '';
      if (!path.isAbsolute(input) || !SUPPORTED.test(input)) throw new MovieError(`Cannot import media “${String(entry.name ?? entry.id)}”. The original project is preserved.`);
      if (typeof local.relativePath === 'string' && !input.startsWith(path.resolve(source) + path.sep)) throw new MovieError('Former project media escapes its package');
      const stat = await lstat(input);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new MovieError('Former project media must be an accessible regular file');
      const relative = `movie-media/${digest.slice(0, 12)}-${createHash('sha256').update(entry.id).digest('hex').slice(0, 12)}${path.extname(input).toLowerCase()}`;
      try { await safeMovieAsset(dir, relative); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await copyFile(input, path.join(dir, relative), constants.COPYFILE_EXCL); }
      media.set(entry.id, { id: entry.id, path: relative, label: String(entry.name ?? path.basename(input)) });
    }
    const width = finite(timeline.width, 1920), height = finite(timeline.height, 1080);
    const shots: MovieShot[] = [];
    for (const [index, track] of tracks.entries()) {
      for (const raw of Array.isArray(track.clips) ? track.clips : []) {
        const clip = object(raw), id = String(clip.id ?? randomUUID());
        const duration = seconds(clip.durationFrames);
        if (!(duration > 0)) throw new MovieError('The former project contains a clip with invalid timing');
        const placement = { start: seconds(clip.startFrame), track: tracks.length - index - 1 };
        const transform = object(clip.transform), textStyle = object(clip.textStyle);
        const crop = object(clip.crop);
        if (Object.values(crop).some(v => typeof v === 'number' && v !== 0) || transform.flipHorizontal || transform.flipVertical || transform.rotationX || transform.rotationY)
          warnings.add('部分旧裁切、翻转或透视设置已保存在原工程与迁移备份中；请检查当前画面。');
        const visual: NonNullable<MovieShot['visual']> = { composition: 'minimal', copy: { x: 8, y: 75, width: 84, align: 'center', titleSize: 3.5, bodySize: 2 }, layers: [], transition: 'cut', copyMode: 'none' };
        for (const field of ['effects', 'opacityTrack', 'positionTrack', 'scaleTrack', 'rotationTrack', 'cropTrack', 'volumeTrack', 'wordStyles', 'wordTimings', 'multicamGroupId'])
          if (clip[field] && (!Array.isArray(clip[field]) || (clip[field] as unknown[]).length)) warnings.add('部分旧特效、关键帧或逐词样式已保存在原工程与迁移备份中；请检查当前画面。');
        if (track.hidden) warnings.add('旧工程中的隐藏轨道已保留为透明片段。');
        if (clip.mediaType === 'text') {
          visual.copyMode = 'caption';
          visual.copy.x = 8;
          visual.copy.y = Math.max(0, Math.min(90, (finite(transform.centerY, 0.85) - finite(transform.height, 0.1) / 2) * 100));
          visual.copy.titleSize = finite(textStyle.fontSize, 46) / width * 100;
          if (typeof textStyle.color === 'string' && /^#[0-9a-f]{6}$/i.test(textStyle.color)) visual.foreground = textStyle.color;
          shots.push({ id, kind: 'text', title: String(clip.textContent ?? ''), body: '', duration, layout: 'title', placement, visual });
          continue;
        }
        const asset = media.get(String(clip.mediaRef));
        if (!asset) throw new MovieError('The former project contains missing media or a nested sequence. Its original timeline has been preserved.');
        const audioOnly = clip.mediaType === 'audio' || track.type === 'audio';
        const info = await probeMovieMedia(await safeMovieAsset(dir, asset.path));
        shots.push({ id, title: asset.label ?? 'Clip', body: '', duration, layout: 'split', placement, media: asset.path, captions: [], visual,
          clip: { assetId: asset.id, in: seconds(clip.trimStartFrame), rate: finite(clip.speed, 1),
            // Native audio clips carry the sound independently; avoid duplicating the video's audio.
            volume: audioOnly && !track.muted ? Math.max(0, Math.min(1, finite(clip.volume, 1))) : 0,
            fit: 'contain', audioOnly, opacity: track.hidden ? 0 : finite(clip.opacity, 1),
            x: (finite(transform.centerX, 0.5) - finite(transform.width, 1) / 2) * 100,
            y: (finite(transform.centerY, 0.5) - finite(transform.height, 1) / 2) * 100,
            width: finite(transform.width, 1) * 100, height: finite(transform.height, 1) * 100,
            fadeIn: Math.min(duration, seconds(clip.fadeInFrames)), fadeOut: Math.min(duration, seconds(clip.fadeOutFrames)),
            ...(finite(transform.rotation, 0) ? { rotation: finite(transform.rotation, 0) } : {}),
          },
        });
        if (info.kind === 'image') shots.at(-1)!.clip!.volume = 0;
      }
    }
    if (timelines.length > 1) warnings.add('已导入原工程当前时间线；其他时间线完整保存在原工程与迁移备份中。');
    if (timeline.outputColorSpace && timeline.outputColorSpace !== 'rec709') warnings.add('当前统一编辑器使用 SDR 输出；原 HDR 工程保留在迁移备份中。');
    const input = parseMovieInput({ ...current, shots: mergeLinkedAudio(project, shots), settings: { width, height, frameRate },
      aspect: width === height ? '1:1' : height > width ? '9:16' : '16:9',
      style: { ...current.style, background: '#000000', assets: [...media.values()], visual: { composition: 'minimal', copy: { x: 8, y: 75, width: 84, align: 'center', titleSize: 3.5, bodySize: 2 }, layers: [], transition: 'cut', copyMode: 'none' } },
    });
    const latest = createHash('sha256').update(JSON.stringify([await readJson(path.join(source, 'project.json')), await readJson(path.join(source, 'media.json'))])).digest('hex');
    if (latest !== digest) throw new MovieError('The former video project changed during import. Close its editor and retry.', 409);
    return mutateMovie(dir, current.revision, doc => {
      const next = applyMovieEdit(doc!, input, { history: false });
      next.editorMigration = { version: 2, sourceDigest: digest, migratedAt: new Date().toISOString(), warnings: [...warnings] };
      resetMovieHistory(next);
      return next;
    });
  });
}

/** Register a project-owned media file. The existing revision lock and undo receipt remain authoritative. */
export async function importEditorMedia(dir: string, expectedRevision: number, relative: string, label?: string) {
  if (!SUPPORTED.test(relative)) throw new MovieError('Choose video, audio or image media');
  const file = await safeMovieAsset(dir, relative), info = await probeMovieMedia(file), id = randomUUID();
  const document = await mutateMovie(dir, expectedRevision, doc => {
    if (!doc) throw new MovieError('Create a video project first', 404);
    const existing = doc.style.assets?.find(a => a.path === relative);
    if (existing) return doc;
    return applyMovieEdit(doc, parseMovieInput({ ...doc, style: { ...doc.style, assets: [...(doc.style.assets ?? []), { id, path: relative, label: (label ?? path.basename(relative)).slice(0, 200) }] } }), { label: 'Import media' });
  });
  return { document, assetId: document.style.assets!.find(a => a.path === relative)!.id, kind: info.kind };
}

export function editorTimeline(doc: MovieDocument) {
  const starts = movieShotStarts(doc);
  return { document: doc, clips: doc.shots.map((shot, i) => ({ id: shot.id, start: starts[i], duration: shot.duration, track: shot.placement?.track ?? 0 })) };
}
