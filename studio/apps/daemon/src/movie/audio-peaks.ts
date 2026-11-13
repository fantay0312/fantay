import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const PEAK_RATE = 2000;
const PEAKS_PER_SECOND = 50; // 20 ms bins
const MIN_PEAK_BINS = 600;
const MAX_PEAK_BINS = 24000;

/** Bins an agent-facing payload (MCP, CLI, native/call) carries; the web timeline reads the full array. */
export const AGENT_PEAK_BINS = 600;

/** Max-pools peaks down to at most `bins`: each output bin is the max of every input bin it overlaps, so no transient
 * disappears. Shorter arrays pass through unchanged. */
export function poolAudioPeaks(peaks: number[], bins = AGENT_PEAK_BINS): number[] {
  if (peaks.length <= bins) return peaks;
  return Array.from({ length: bins }, (_, j) => {
    let max = 0;
    const to = Math.ceil(((j + 1) * peaks.length) / bins);
    for (let i = Math.floor((j * peaks.length) / bins); i < to; i++) max = Math.max(max, peaks[i]!);
    return max;
  });
}

/** A source as agents see it: the same payload with `audioPeaks` pooled to AGENT_PEAK_BINS. */
export function agentMovieSource<T>(source: T): T {
  const peaks = (source as { audioPeaks?: unknown } | null)?.audioPeaks;
  return Array.isArray(peaks) ? { ...source, audioPeaks: poolAudioPeaks(peaks as number[]) } : source;
}

/** About 50 bins per second of source, 600-24000. */
export function audioPeakBins(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return MIN_PEAK_BINS;
  return Math.round(Math.min(MAX_PEAK_BINS, Math.max(MIN_PEAK_BINS, duration * PEAKS_PER_SECOND)));
}

/** Real PCM peaks on the picture's clock, normalized once per source; never synthesize a waveform for silent video.
 * Bin i covers [i, i + 1) * duration / bins of source time, so the web can map them over source.duration. */
export async function sourceAudioPeaks(binary: string, file: string, duration: number): Promise<number[]> {
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const bins = audioPeakBins(seconds);
  // A late first packet (start_time / edit list) and a short stream become silence; trim to the container duration.
  const audio = seconds
    ? ['-af', `aresample=${PEAK_RATE}:async=1:first_pts=0,apad,atrim=end=${seconds.toFixed(3)}`]
    : ['-ar', String(PEAK_RATE)];
  // 2000 Hz mono f32 is 8 KB/s: 32 MB holds about 67 minutes.
  const { stdout } = await exec(binary, ['-nostdin', '-loglevel', 'error', '-i', file,
    '-vn', '-ac', '1', ...audio, '-f', 'f32le', 'pipe:1'],
  { encoding: 'buffer', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  const samples = Math.floor(stdout.length / 4);
  // Sample i sits at i / PEAK_RATE seconds; without a known duration, spread the decoded samples.
  const scale = seconds ? bins / (seconds * PEAK_RATE) : bins / Math.max(1, samples);
  const peaks = Array.from({ length: bins }, () => 0);
  for (let i = 0; i < samples; i++) {
    const value = Math.abs(stdout.readFloatLE(i * 4));
    if (Number.isFinite(value)) {
      const bin = Math.min(bins - 1, Math.floor(i * scale));
      peaks[bin] = Math.max(peaks[bin]!, value);
    }
  }
  const max = peaks.reduce((m, p) => Math.max(m, p), 0);
  return peaks.map(p => max > 0 ? Math.round(p / max * 1000) / 1000 : 0);
}
