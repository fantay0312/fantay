// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { MEDIA_OP_LIMITS, mediaOpInputClass, validateMediaOpRequest, type MediaOpResponse, type ApiErrorCode } from '@open-design/contracts';
import { movieFfmpeg } from '../../movie/video-sources.js';

const exec = promisify(execFile);
const MAX_BYTES = 256 * 1024 * 1024;
export class MediaOpError extends Error {
  constructor(message: string, readonly status = 400, readonly code: ApiErrorCode = 'BAD_REQUEST') { super(message); }
}
export interface MediaOpFiles {
  /** Explicit daemon-owned staging root (tests pass their isolated root). */
  scratchRoot: string;
  resolve(name: string): Promise<{ filePath: string; size: number }>;
  write(name: string, bytes: Buffer): Promise<{ name?: string } | void>;
}

async function ffmpeg(args: string[]): Promise<string> {
  try {
    const result = await exec(movieFfmpeg(), ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file,pipe', ...args], {
      timeout: 120_000, maxBuffer: 1024 * 1024,
    });
    return result.stderr;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaOpError('The local media processor is unavailable', 503, 'MEDIA_PROCESSOR_UNAVAILABLE');
    throw new MediaOpError('The media file could not be processed. Check the file and operation dimensions.', 422, 'MEDIA_PROCESSING_FAILED');
  }
}

export async function probeMedia(file: string): Promise<{ width: number; height: number; duration?: number }> {
  const text = await ffmpeg(['-i', file, '-t', '0', '-f', 'null', '-']);
  const size = /Video:[^\n]*?\b(\d{1,5})x(\d{1,5})\b/.exec(text);
  if (!size) throw new MediaOpError('The input has no readable image or video stream', 422, 'INVALID_MEDIA');
  const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  return { width: Number(size[1]), height: Number(size[2]), ...(match ? { duration: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) } : {}) };
}

export async function runMediaOperation(raw: unknown, files: MediaOpFiles): Promise<MediaOpResponse> {
  const parsed = validateMediaOpRequest(raw);
  if (!parsed.ok) throw new MediaOpError(parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
  const request = parsed.value;
  let input: Awaited<ReturnType<MediaOpFiles['resolve']>>;
  try { input = await files.resolve(request.input); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MediaOpError('Input file not found', 404, 'FILE_NOT_FOUND');
    throw new MediaOpError('Input path is not an accessible project file');
  }
  if (input.size > MAX_BYTES) throw new MediaOpError('Input files are limited to 256 MiB', 413, 'PAYLOAD_TOO_LARGE');
  const source = await probeMedia(input.filePath);
  const image = mediaOpInputClass(request.input) === 'image';
  const stem = path.posix.basename(request.input, path.posix.extname(request.input)).replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 60) || 'media';
  const prefix = `media-ops/${stem}-${request.op}-${randomUUID()}`;
  const extension = image || request.op === 'frame' ? '.png' : '.mp4';
  const plans: { name: string; filter?: string; width: number; height: number }[] = [];
  if (request.op === 'crop') {
    const { x, y, width, height } = request.params;
    if (x + width > source.width || y + height > source.height) throw new MediaOpError('Crop must stay inside the input dimensions');
    plans.push({ name: request.output ?? prefix + extension, filter: `crop=${width}:${height}:${x}:${y}`, width, height });
  } else if (request.op === 'split') {
    const { rows, cols } = request.params;
    if (rows > source.height || cols > source.width) throw new MediaOpError('Each split piece must contain at least one pixel');
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const x = Math.floor(col * source.width / cols), y = Math.floor(row * source.height / rows);
      const width = Math.floor((col + 1) * source.width / cols) - x, height = Math.floor((row + 1) * source.height / rows) - y;
      plans.push({ name: `${request.outputPrefix ?? prefix}-r${row + 1}c${col + 1}.png`, filter: `crop=${width}:${height}:${x}:${y}`, width, height });
    }
  } else if (request.op === 'scale') {
    const p = request.params;
    const width = p.factor ? source.width * p.factor : p.width ?? Math.max(1, Math.round(source.width * p.height! / source.height));
    const height = p.factor ? source.height * p.factor : p.height ?? Math.max(1, Math.round(source.height * p.width! / source.width));
    plans.push({ name: request.output ?? prefix + extension, filter: `scale=${width}:${height}:flags=lanczos`, width, height });
  } else {
    if (source.duration !== undefined && request.params.timeSec >= source.duration) throw new MediaOpError('Frame time must be before the end of the video');
    plans.push({ name: request.output ?? prefix + '.png', width: source.width, height: source.height });
  }
  for (const plan of plans) {
    if (Math.max(plan.width, plan.height) > MEDIA_OP_LIMITS.maxOutputEdge) throw new MediaOpError(`Output dimensions must not exceed ${MEDIA_OP_LIMITS.maxOutputEdge} pixels`);
    try { await files.resolve(plan.name); throw new MediaOpError(`Output already exists: ${plan.name}`, 409, 'CONFLICT'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(files.scratchRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(files.scratchRoot, 'media-ops-'));
  try {
    // Render everything before publishing any file, so encoder failures leave no partial split.
    const rendered: { plan: typeof plans[number]; bytes: Buffer }[] = [];
    let totalBytes = 0;
    for (const [index, plan] of plans.entries()) {
      const out = path.join(scratch, `${index}${path.posix.extname(plan.name)}`);
      const args = ['-y', ...(request.op === 'frame' ? ['-ss', String(request.params.timeSec)] : []), '-i', input.filePath, '-map', '0:v:0'];
      if (plan.filter) args.push('-vf', plan.filter);
      if (image || request.op === 'frame') args.push('-frames:v', '1');
      else args.push('-map', '0:a?', '-c:v', out.endsWith('.webm') ? 'libvpx-vp9' : 'libx264', '-pix_fmt', 'yuv444p', '-c:a', out.endsWith('.webm') ? 'libopus' : 'aac');
      args.push('-threads', '1', '-fs', String(MAX_BYTES), out);
      await ffmpeg(args);
      const info = await stat(out);
      totalBytes += info.size;
      if (!info.size || totalBytes >= MAX_BYTES) throw new MediaOpError('Output files exceed the 256 MiB limit', 413, 'PAYLOAD_TOO_LARGE');
      rendered.push({ plan, bytes: await readFile(out) });
    }
    const result: MediaOpResponse = { op: request.op, input: request.input, files: [] };
    for (const { plan, bytes } of rendered) {
      const saved = await files.write(plan.name, bytes);
      const name = saved?.name ?? plan.name;
      const ext = path.posix.extname(name).toLowerCase();
      const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' } as Record<string, string>)[ext]!;
      result.files.push({ path: name, mime, width: plan.width, height: plan.height, bytes: bytes.length });
    }
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
