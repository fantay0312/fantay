import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import type { MovieExportOptions } from '@open-design/contracts';
import { MovieError, safeMovieAsset } from './store.js';

export function parseMovieExportOptions(value: unknown): MovieExportOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new MovieError('Invalid export settings');
  const { format, width, height, frameRate } = value as MovieExportOptions;
  if (!['mp4', 'mov'].includes(format) || !Number.isInteger(width) || !Number.isInteger(height)
    || width < 64 || height < 64 || width > 7680 || height > 7680 || width % 2 || height % 2
    || !frameRate || !Number.isInteger(frameRate.numerator) || !Number.isInteger(frameRate.denominator)
    || frameRate.numerator < 1 || frameRate.numerator > 240000 || frameRate.denominator < 1 || frameRate.denominator > 10000
    || frameRate.numerator / frameRate.denominator < 1 || frameRate.numerator / frameRate.denominator > 120) {
    throw new MovieError('Export requires MP4 or MOV, even dimensions up to 7680, and a frame rate between 1 and 120 fps');
  }
  return { format, width, height, frameRate: { numerator: frameRate.numerator, denominator: frameRate.denominator } };
}

/** MOV is a real QuickTime remux of the rendered H.264/AAC streams. */
export async function finalizeMovieExport(dir: string, file: string, options?: MovieExportOptions): Promise<string> {
  if (options?.format !== 'mov') return file;
  const source = await safeMovieAsset(dir, file);
  const output = `${path.basename(file, path.extname(file))}.mov`;
  await promisify(execFile)(process.env.HYPERFRAMES_FFMPEG_PATH?.trim() || ffmpegInstaller.path,
    ['-nostdin', '-n', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mov', path.join(dir, output)],
    { timeout: 120_000, maxBuffer: 1024 * 1024 });
  return output;
}
