import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  movieFps, movieFrameSize, movieShotStarts,
  type JianyingCreateRequest, type JianyingDraftEntry, type JianyingDraftResult, type JianyingEditRequest,
  type JianyingOperation, type JianyingProjectSpec, type JianyingClip, type JianyingKeyframePoint,
  type MovieDocument,
} from '@open-design/contracts';
import { readMovie, safeMovieAsset } from '../movie/store.js';
import { probeMovieMedia } from '../movie/video-sources.js';
import { inspectJianyingEnvironment } from './environment.js';
import { ensureNativeCodec, nativeCodecPrepared, JianyingError, runJianyingEngine, type EngineOptions, type EngineResponse } from './engine.js';

const TRANSITION_NAME_MAP: Record<string, string> = {
  fade: '闪黑',
  crossfade: '叠化',
  slide: '滑动',
  wipe: '擦除',
  iris: '圆形遮罩',
};

const OUTPUT = 'jianying-drafts';
const isInside = (base: string, file: string) => { const relative = path.relative(base, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
async function projectAsset(projectDir: string, value: string, subtitle = false): Promise<string> {
  if (typeof value !== 'string' || /[~$\\\0]/.test(value) || value.split('/').some(part => /^(?:\.env(?:\..*)?|\.ssh|\.git|credentials?(?:\..*)?)$/i.test(part))) throw new JianyingError('Only non-secret project media and subtitle files are allowed', 'UNSAFE_PATH', 403);
  if (!(subtitle ? /\.srt$/i : /\.(mp4|m4v|mov|webm|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif)$/i).test(value)) throw new JianyingError(subtitle ? 'Choose an SRT subtitle file' : 'Choose a supported media file', 'INVALID_ASSET');
  return safeMovieAsset(projectDir, value);
}
export class JianyingService {
  constructor(private readonly options: EngineOptions, private readonly environment = inspectJianyingEnvironment) {}
  async status() {
    const environment = await this.environment();
    environment.native.prepared = await nativeCodecPrepared(this.options, environment);
    return environment;
  }
  async list(projectDir: string, includeLocal = false): Promise<JianyingDraftEntry[]> {
    const environment = includeLocal ? await this.status() : null;
    const roots = [{ dir: path.join(projectDir, OUTPUT), origin: 'project' as const }, ...(environment ? [{ dir: environment.draftsRoot, origin: 'local' as const }] : [])];
    const result: JianyingDraftEntry[] = [];
    for (const root of roots) {
      let entries; try { entries = await readdir(root.dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const file = path.join(root.dir, entry.name);
        try {
          const names = await readdir(file);
          if (!names.includes('draft_info.json') && !names.includes('draft_content.json')) continue;
          result.push({ id: `${root.origin}:${Buffer.from(entry.name).toString('base64url')}`, name: entry.name, origin: root.origin, path: file, modifiedAt: (await lstat(file)).mtime.toISOString() });
        } catch { /* A removed or unreadable draft is not a usable selection. */ }
        if (result.length >= 250) break;
      }
    }
    return result.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
  async source(projectDir: string, draftId: string, allowLocal = false): Promise<string> {
    if (typeof draftId !== 'string') throw new JianyingError('Choose a draft first');
    const match = /^(project|local):([A-Za-z0-9_-]+)$/.exec(draftId);
    if (!match || (match[1] === 'local' && !allowLocal)) throw new JianyingError('Draft is outside this project', 'DRAFT_ACCESS_DENIED', 403);
    const name = Buffer.from(match[2]!, 'base64url').toString('utf8');
    if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name) || name.startsWith('.')) throw new JianyingError('Invalid draft identifier');
    const base = match[1] === 'local' ? (await this.status()).draftsRoot : path.join(projectDir, OUTPUT);
    const rootInfo = await lstat(base);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new JianyingError('Invalid draft root', 'UNSAFE_PATH', 403);
    const root = await realpath(base), file = path.join(root, name);
    if (match[1] === 'project' && !isInside(await realpath(projectDir), root)) throw new JianyingError('Draft is outside this project', 'UNSAFE_PATH', 403);
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isDirectory() || !isInside(root, await realpath(file))) throw new JianyingError('Invalid draft directory', 'UNSAFE_PATH', 403);
    return file;
  }
  private async request(input: Record<string, unknown>) {
    try { return await runJianyingEngine(this.options, input); }
    catch (error) {
      if (!(error instanceof JianyingError) || error.code !== 'ENCRYPTED_DRAFT') throw error;
      const nativeBinary = await ensureNativeCodec(this.options, await this.status());
      return runJianyingEngine(this.options, { ...input, nativeBinary });
    }
  }
  async inspect(projectDir: string, draftId: string, allowLocal = false) {
    return this.request({ command: 'inspect', source: await this.source(projectDir, draftId, allowLocal) });
  }
  private async prepareSpec(projectDir: string, input: JianyingProjectSpec): Promise<JianyingProjectSpec> {
    if (!input || typeof input !== 'object' || !Array.isArray(input.clips) || input.clips.length > 1000) throw new JianyingError('Provide a plan with up to 1000 clips', 'INVALID_PLAN');
    const spec = structuredClone(input);
    for (const clip of spec.clips) if (clip.path !== undefined) clip.path = await projectAsset(projectDir, clip.path);
    if (spec.srt) spec.srt.path = await projectAsset(projectDir, spec.srt.path, true);
    return spec;
  }
  private async destination(projectDir: string, name: string) {
    const base = path.join(projectDir, OUTPUT);
    // Check before mkdir, and never follow a user-created output symlink.
    try { const info = await lstat(base); if (info.isSymbolicLink() || !info.isDirectory()) throw new JianyingError('Invalid draft output directory', 'UNSAFE_PATH'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(base); }
    if (!isInside(await realpath(projectDir), await realpath(base))) throw new JianyingError('Draft output is outside the project', 'UNSAFE_PATH');
    const title = (typeof name === 'string' ? name : 'Jianying').trim().replace(/[\/\\\0:*?"<>|]/g, '-').slice(0, 60) || 'Jianying';
    return path.join(base, `${title}-${randomUUID().slice(0, 8)}`);
  }
  private result(output: string, response: EngineResponse, warnings: string[] = []): JianyingDraftResult {
    if (!response.validation.valid) throw new JianyingError('Generated draft failed validation', 'INVALID_DRAFT');
    const folder = path.basename(output);
    return { draft: { id: `project:${Buffer.from(folder).toString('base64url')}`, name: response.inspection.name ?? folder, origin: 'project', path: output, modifiedAt: new Date().toISOString() }, inspection: response.inspection, validation: response.validation, warnings, sourcePreserved: true };
  }
  async create(projectDir: string, request: JianyingCreateRequest): Promise<JianyingDraftResult> {
    const environment = await this.status();
    if (environment.application.installed && environment.compatibility !== 'verified' && request.allowUnverified !== true) throw new JianyingError('This version is not desktop-verified. Explicitly allow an unverified plaintext draft, or use a verified version without upgrading automatically.', 'UNVERIFIED_VERSION', 409);
    let spec: JianyingProjectSpec, warnings: string[] = [];
    if (request.source === 'plan') spec = await this.prepareSpec(projectDir, request.spec!);
    else {
      const movie = await readMovie(projectDir);
      if (!movie) throw new JianyingError('No saved movie timeline was found', 'MOVIE_NOT_FOUND', 404);
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== movie.revision) throw new JianyingError('Save and refresh the current timeline before creating a draft', 'REVISION_CONFLICT', 409);
      ({ spec, warnings } = await movieToJianying(projectDir, movie));
    }
    if (request.name) spec.name = request.name;
    const output = await this.destination(projectDir, spec.name);
    const response = await this.request({ command: 'create', spec, output });
    if (environment.compatibility !== 'verified') warnings.push(...environment.messages);
    return this.result(output, response, warnings);
  }
  async edit(projectDir: string, request: JianyingEditRequest, allowLocal = false): Promise<JianyingDraftResult> {
    if (!Array.isArray(request.operations) || request.operations.length < 1 || request.operations.length > 100) throw new JianyingError('Provide 1–100 draft operations');
    const source = await this.source(projectDir, request.draftId, allowLocal);
    const operations = structuredClone(request.operations);
    for (const operation of operations) {
      if (operation.op === 'add' && operation.clip.path !== undefined) operation.clip.path = await projectAsset(projectDir, operation.clip.path);
      else if (operation.op === 'replace_media' || operation.op === 'import_srt' || operation.op === 'relink') operation.path = await projectAsset(projectDir, operation.path, operation.op === 'import_srt');
    }
    const output = await this.destination(projectDir, request.name || `${path.basename(source)}-edited`);
    const response = await this.request({ command: 'edit', source, operations, name: request.name ?? `${path.basename(source)}-edited`, output });
    return this.result(output, response);
  }
  async install(projectDir: string, draftId: string, name?: string) {
    const environment = await this.status();
    if (environment.application.running) throw new JianyingError('Quit Jianying before adding a draft to its home screen', 'EDITOR_RUNNING', 409);
    if (!environment.application.installed) throw new JianyingError('Jianying was not found; the generated draft remains available in this project', 'APP_NOT_FOUND', 409);
    const source = await this.source(projectDir, draftId);
    return this.request({ command: 'install', source, root: environment.draftsRoot, ...(name ? { name } : {}) });
  }
}

/** Translate the saved document, never preview proxies or generated player scripts. */
export async function movieToJianying(projectDir: string, movie: MovieDocument): Promise<{ spec: JianyingProjectSpec; warnings: string[] }> {
  const starts = movieShotStarts(movie), size = movieFrameSize(movie), clips: JianyingClip[] = [], warnings: string[] = [];
  for (const [index, shot] of movie.shots.entries()) {
    const start = starts[index]!;
    if (shot.visual?.layers?.length) throw new JianyingError('This timeline contains visual layers that cannot yet be transferred as editable Jianying objects. Use an explicit draft plan or a rendered video.', 'UNSUPPORTED_TIMELINE');
    if (shot.kind === 'text') clips.push({ type: 'text', text: [shot.title, shot.body].filter(Boolean).join('\n') || ' ', start, duration: shot.duration, track: shot.placement?.track ?? 0 });
    else if (shot.media) {
      const file = await projectAsset(projectDir, shot.media), media = await probeMovieMedia(file), c = shot.clip;
      if ((c?.crop && Object.values(c.crop).some(v => v !== 0)) || (c?.color && Object.entries(c.color).some(([key, v]) => v !== (key === 'contrast' || key === 'saturation' ? 1 : 0)))) {
        throw new JianyingError('Crop and color adjustments cannot yet be transferred as editable Jianying objects. Use a rendered source or an explicit plan.', 'UNSUPPORTED_TIMELINE');
      }
      if (c?.audioOnly && media.kind !== 'audio') throw new JianyingError('Extract the embedded audio to a separate project audio file before transferring this clip', 'UNSUPPORTED_TIMELINE');
      if (media.kind === 'audio' && (c?.rate ?? 1) !== 1) throw new JianyingError('Audio speed must be rendered before transfer', 'UNSUPPORTED_TIMELINE');

      const width = c?.width ?? 100, height = c?.height ?? width;
      const fit = media.width && media.height ? (c?.fit === 'cover' ? Math.max : Math.min)(size.width * width / 100 / media.width, size.height * height / 100 / media.height) / Math.min(size.width / media.width, size.height / media.height) : 1;
      const clip: JianyingClip = { type: media.kind, path: file, start, duration: shot.duration, volume: c?.muted ? 0 : c?.volume ?? 1, track: shot.placement?.track ?? 0 };
      if (media.kind !== 'image') { clip.sourceStart = c?.in ?? 0; if (media.kind === 'video') clip.speed = c?.rate ?? 1; }
      if (media.kind !== 'audio') {
        clip.transform = { x: ((c?.x ?? 0) + width / 2 - 50) / 50, y: -((c?.y ?? 0) + height / 2 - 50) / 50, scaleX: fit, scaleY: fit, rotation: c?.rotation ?? 0, alpha: c?.opacity ?? 1 };
      }

      // Audio fades (audio clips or embedded video audio)
      const audioFadeIn = (media.kind === 'audio' ? c?.fadeIn : (c?.audioFadeIn ?? c?.fadeIn)) ?? 0;
      const audioFadeOut = (media.kind === 'audio' ? c?.fadeOut : (c?.audioFadeOut ?? c?.fadeOut)) ?? 0;
      if (audioFadeIn > 0 || audioFadeOut > 0) {
        clip.fade = { in: audioFadeIn, out: audioFadeOut };
        clip.fadeIn = audioFadeIn;
        clip.fadeOut = audioFadeOut;
      }

      // Keyframes
      if (c?.keyframes?.length) {
        clip.keyframes = c.keyframes.map(k => {
          const at = Math.max(0, Math.min(shot.duration, Math.round(k.at * shot.duration * 10000) / 10000));
          const pt: JianyingKeyframePoint = { at };
          const kw = k.width ?? width;
          const kh = k.height ?? (k.width !== undefined ? k.width : height);
          if (k.x !== undefined || k.width !== undefined) {
            const kx = k.x !== undefined ? k.x : (c?.x ?? 0);
            pt.x = ((kx + kw / 2 - 50) / 50);
          }
          if (k.y !== undefined || k.height !== undefined || k.width !== undefined) {
            const ky = k.y !== undefined ? k.y : (c?.y ?? 0);
            pt.y = -((ky + kh / 2 - 50) / 50);
          }
          if (k.width !== undefined || k.height !== undefined) {
            const kfit = media.width && media.height
              ? (c?.fit === 'cover' ? Math.max : Math.min)(size.width * kw / 100 / media.width, size.height * kh / 100 / media.height) / Math.min(size.width / media.width, size.height / media.height)
              : (kw / 100);
            pt.scaleX = kfit;
            pt.scaleY = kfit;
          }
          if (k.rotation !== undefined) pt.rotation = k.rotation;
          if (k.opacity !== undefined) pt.opacity = k.opacity;
          return pt;
        });
      } else if (media.kind === 'video' && ((c?.fadeIn ?? 0) > 0 || (c?.fadeOut ?? 0) > 0)) {
        // Video visual fade mapped to opacity keyframes when keyframes are not explicitly specified
        const kfs: JianyingKeyframePoint[] = [];
        const baseAlpha = c?.opacity ?? 1;
        const fIn = Math.min(c?.fadeIn ?? 0, shot.duration);
        const fOut = Math.min(c?.fadeOut ?? 0, shot.duration);
        if (fIn > 0) {
          kfs.push({ at: 0, opacity: 0 });
          kfs.push({ at: fIn, opacity: baseAlpha });
        }
        if (fOut > 0) {
          const outStart = Math.max(fIn, shot.duration - fOut);
          if (outStart > fIn) kfs.push({ at: outStart, opacity: baseAlpha });
          kfs.push({ at: shot.duration, opacity: 0 });
        }
        if (kfs.length) clip.keyframes = kfs;
      }

      // Transitions (attached between adjacent shots on video track)
      if (shot.visual?.transition && shot.visual.transition !== 'cut' && index < movie.shots.length - 1) {
        const nextShot = movie.shots[index + 1];
        if (nextShot) {
          const transName = TRANSITION_NAME_MAP[shot.visual.transition] || '叠化';
          const defaultDur = 0.5;
          const maxDur = Math.min(shot.duration, nextShot.duration) / 2;
          const duration = Math.min(shot.visual.transitionDuration ?? defaultDur, maxDur > 0 ? maxDur : defaultDur);
          clip.transition = {
            name: transName,
            duration: Number(duration.toFixed(3)),
          };
        }
      }

      clips.push(clip);
    } else throw new JianyingError(`Shot "${shot.title}" is a code animation; use its rendered video or an explicit draft plan`, 'UNSUPPORTED_TIMELINE');
    for (const caption of shot.captions ?? []) if (caption.end > caption.start && caption.text.trim()) clips.push({ type: 'text', text: caption.text, start: start + caption.start, duration: caption.end - caption.start, subtitle: true, track: 100 + (shot.placement?.track ?? 0) });
  }
  for (const type of ['video', 'audio', 'text']) {
    const kind = (c: JianyingClip) => c.type === 'image' ? 'video' : c.type;
    const ordinals = [...new Set(clips.filter(c => kind(c) === type).map(c => c.track ?? 0))].sort((a, b) => a - b);
    for (const clip of clips) if (kind(clip) === type) clip.track = ordinals.indexOf(clip.track ?? 0);
  }
  if (clips.some(clip => clip.type === 'text')) warnings.push('DEFAULT_TEXT_STYLES');
  return { spec: { name: movie.title, ...size, fps: movieFps(movie), clips }, warnings };
}
