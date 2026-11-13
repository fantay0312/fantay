import { spawn } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import path, { delimiter } from 'node:path';
import { load } from 'cheerio';
import { terminateProcessGroup } from '@open-design/platform';
import { findRealTagEnd, findRealTagOffset, HTML_TAG_PATTERNS } from '@open-design/contracts/runtime/html-injection-points';
import { resolveOnPath, userToolchainBinDirs } from '../runtimes/executables.js';
import { hyperFramesAudioEncodingArgs, type HyperFramesAudioTrack } from './hyperframes-audio.js';

const TIMEOUT_MS = 5 * 60 * 1000;

/** Footage has not shown a benefit; keep it on the established renderer. */
export function frameVeloEligibility(html: string): string | null {
  const $ = load(html);
  if ($('video').length > 0) return 'Video compositions use the standard renderer.';
  return $('audio').length > 0 ? 'Unprepared audio uses the standard renderer.' : null;
}

export function injectFrameVeloDriver(html: string, duration: number, fps: number, baseHref = '/source/'): string {
  const head = findRealTagEnd(html, HTML_TAG_PATTERNS.headOpen);
  const base = `<base href="${baseHref}"><script>window.__odResourceError='';window.addEventListener('error',function(e){var t=e.target;if(t&&/^(IMG|SCRIPT|LINK)$/.test(t.tagName))window.__odResourceError='A required image, script or stylesheet failed to load';},true);</script>`;
  let result = head >= 0 ? html.slice(0, head) + base + html.slice(head) : base + html;
  const driver = `<script>window.__framevelo={duration:${JSON.stringify(duration)},fps:${JSON.stringify(fps)},async seek(t){await window.__odFrameRenderer.seek(t);await document.fonts.ready;await Promise.all(Array.from(document.images,function(img){return img.decode();}));if(window.__odResourceError)throw new Error(window.__odResourceError);}};</script>`;
  const body = findRealTagOffset(result, HTML_TAG_PATTERNS.bodyClose);
  result = body >= 0 ? result.slice(0, body) + driver + result.slice(body) : result + driver;
  return result;
}

/** Preserve ../asset paths within the project and fail closed for missing assets. */
export async function frameVeloAssetBase(html: string, sourceDir: string, projectDir: string): Promise<string> {
  const root = path.resolve(projectDir), source = path.resolve(sourceDir), relative = path.relative(root, source);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('FrameVelo source escapes the project');
  const $ = load(html);
  const references = $('img[src],script[src],link[rel="stylesheet"][href]').toArray().map(el => $(el).attr('src') ?? $(el).attr('href') ?? '');
  const css = [...$('style').toArray().map(el => $(el).text()), ...$('[style]').toArray().map(el => $(el).attr('style') ?? '')].join('\n');
  for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) references.push(match[1] ?? '');
  for (const ref of references) {
    if (!ref || /^(?:https?:|data:|blob:|#|\/\/)/i.test(ref)) continue;
    if (ref.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(ref)) throw new Error('Unsupported absolute asset path');
    const local = path.resolve(source, decodeURIComponent(ref.split(/[?#]/)[0]!));
    const rel = path.relative(root, local);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !(await stat(local).catch(() => null))?.isFile()) {
      throw new Error('A required local asset is unavailable to FrameVelo');
    }
  }
  return `/source/${relative ? relative.split(path.sep).map(encodeURIComponent).join('/') + '/' : ''}`;
}

export function validateFrameVeloProbe(raw: unknown, expected: { frames: number; fps: number; width: number; height: number; audio: boolean }): void {
  const streams = (raw as { streams?: Array<Record<string, unknown>> })?.streams;
  const video = streams?.find(s => s.codec_type === 'video');
  if (!video || Number(video.nb_read_frames) !== expected.frames || Number(video.width) !== expected.width || Number(video.height) !== expected.height) {
    throw new Error('FrameVelo output has incorrect frame count or dimensions');
  }
  const duration = Number(video.duration);
  // Container duration can conceal the old FFmpeg 9 timestamp defect when
  // audio is correct but the video track is much shorter.
  if (!Number.isFinite(duration) || Math.abs(duration - expected.frames / expected.fps) > 0.5 / expected.fps) {
    throw new Error('FrameVelo output has incorrect video timestamps');
  }
  if (video.color_space !== 'bt709' || video.color_transfer !== 'iec61966-2-1' || video.color_primaries !== 'bt709') {
    throw new Error('FrameVelo output does not preserve the sRGB color contract');
  }
  const audio = streams?.find(s => s.codec_type === 'audio');
  if (expected.audio && (!audio || !Number.isFinite(Number(audio.duration)) || Math.abs(Number(audio.duration) - expected.frames / expected.fps) > 0.1)) {
    throw new Error('FrameVelo output audio is missing or has incorrect duration');
  }
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, PATH: [...(process.env.PATH ?? '').split(delimiter), ...userToolchainBinDirs()].join(delimiter) },
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform !== 'win32') void terminateProcessGroup(child.pid, { termGraceMs: 1000, killGraceMs: 1000 });
      else child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-2_000_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('FrameVelo rendering timed out'));
      else if (code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `Renderer exited with ${String(code)}`));
      else resolve(stdout);
    });
  });
}

export async function renderFrameVeloHtml(options: {
  html: string; sourceDir: string; projectDir: string; tmpRoot: string; output: string;
  fps: number; width: number; height: number; ffmpegPath: string;
  audioTracks: HyperFramesAudioTrack[]; onProgress?: (message: string) => void;
}): Promise<void> {
  const { html, sourceDir, tmpRoot, output, fps, width, height, audioTracks, onProgress } = options;
  const ineligible = frameVeloEligibility(html);
  if (ineligible) throw new Error(ineligible);
  const binary = process.env.FANTAY_FRAMEVELO_BIN?.trim() || resolveOnPath('framevelo');
  const ffprobe = resolveOnPath('ffprobe');
  if (!binary || !ffprobe) throw new Error('FrameVelo or FFprobe is not installed');
  const duration = Number(load(html)('[data-composition-id]').first().attr('data-duration'));
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0) throw new Error('Invalid FrameVelo timeline');
  const frames = Math.ceil(duration * fps);
  const expected = { frames, fps, width, height, audio: audioTracks.length > 0 };
  const input = path.join(tmpRoot, 'framevelo.html'), video = path.join(tmpRoot, 'framevelo-video.mp4');
  const baseHref = await frameVeloAssetBase(html, sourceDir, options.projectDir);
  await writeFile(input, injectFrameVeloDriver(html, duration, fps, baseHref), 'utf8');
  onProgress?.('Rendering HTML motion with FrameVelo…');
  await run(binary, ['render', input, '-o', video, '--no-hyperframes', '--mode', 'dom',
    '--selector', '[data-composition-id]', '--fps', String(fps), '--frames', String(frames),
    '--width', String(width), '--height', String(height), '--workers', '1', '--no-video-proxy',
    '--verify-threshold', '40', '--mount', `/source/=${options.projectDir}`, '--json', '-q']);
  const probe = async (file: string) => JSON.parse(await run(ffprobe, ['-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,width,height,nb_read_frames,duration,color_space,color_transfer,color_primaries', '-of', 'json', file]));
  validateFrameVeloProbe(await probe(video), { ...expected, audio: false });
  // Keep existing audio trims, fades and volume; copy the encoded video.
  await run(options.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', video,
    ...audioTracks.flatMap(track => ['-protocol_whitelist', 'file,pipe', '-f', track.format, '-i', track.file]),
    ...hyperFramesAudioEncodingArgs(audioTracks, frames / fps), '-c:v', 'copy', '-movflags', '+faststart', output]);
  validateFrameVeloProbe(await probe(output), expected);
  onProgress?.(`FrameVelo completed ${frames} frames at ${fps} fps.`);
}
