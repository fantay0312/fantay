// SPDX-License-Identifier: AGPL-3.0-only
// A whole audio file reduced to about a thousand loudness values: enough to draw its shape at any
// panel width, small enough to keep for every file opened in a session. Runs in the peaks worker
// (and on the main thread only if the worker cannot start). Pure: no DOM.
import type { PcmLayout } from './audio-probe';

/** How many values are kept per file. A bar on screen averages several of them. */
export const PEAK_BUCKETS = 1024;
/** At most this many samples are read per bucket; a long file is sampled, not read whole. */
const MAX_SAMPLES_PER_BUCKET = 4096;

/** Scales the values so the loudest is 1. Silence stays silence. */
function normalise(values: Float32Array): Float32Array {
  let top = 0;
  for (let index = 0; index < values.length; index += 1) top = Math.max(top, values[index] ?? 0);
  if (top > 1e-5) for (let index = 0; index < values.length; index += 1) values[index] = (values[index] ?? 0) / top;
  else values.fill(0);
  return values;
}

/**
 * One loudness value per bucket of frames: the geometric mean of the peak and the average energy.
 * The peak alone turns mastered music into a solid block; the average alone loses a drum hit.
 */
function reduce(frames: number, buckets: number, read: (frame: number) => number): Float32Array {
  const count = Math.max(1, Math.min(buckets, frames));
  const out = new Float32Array(count);
  if (frames <= 0) return out;
  const perBucket = frames / count;
  const stride = Math.max(1, Math.floor(perBucket / MAX_SAMPLES_PER_BUCKET));
  for (let bucket = 0; bucket < count; bucket += 1) {
    const start = Math.floor(bucket * perBucket);
    const end = Math.max(start + 1, Math.min(frames, Math.floor((bucket + 1) * perBucket)));
    let peak = 0;
    let energy = 0;
    let taken = 0;
    for (let frame = start; frame < end; frame += stride) {
      const value = Math.abs(read(frame));
      if (value > peak) peak = value;
      energy += value * value;
      taken += 1;
    }
    out[bucket] = Math.sqrt(peak * Math.sqrt(energy / Math.max(1, taken)));
  }
  return normalise(out);
}

/** From decoded channels (Web Audio). The channels are mixed by taking the loudest at each frame. */
export function peaksFromChannels(channels: readonly Float32Array[], buckets = PEAK_BUCKETS): Float32Array {
  const frames = channels.reduce((shortest, channel) => Math.min(shortest, channel.length), Infinity);
  if (!Number.isFinite(frames) || channels.length === 0) return new Float32Array(Math.max(1, buckets));
  return reduce(frames, buckets, (frame) => {
    let value = 0;
    for (const channel of channels) value = Math.max(value, Math.abs(channel[frame] ?? 0));
    return value;
  });
}

/** From interleaved PCM read straight out of a WAV file: no decoder, no second copy of the audio. */
export function peaksFromPcm(bytes: Uint8Array, layout: PcmLayout, buckets = PEAK_BUCKETS): Float32Array {
  const bytesPerSample = layout.bits / 8;
  const blockAlign = bytesPerSample * layout.channels;
  const available = Math.max(0, Math.min(layout.length, bytes.length - layout.offset));
  const frames = blockAlign > 0 ? Math.floor(available / blockAlign) : 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sample = (at: number): number => {
    if (layout.float) return view.getFloat32(at, true);
    if (layout.bits === 8) return (view.getUint8(at) - 128) / 128;
    if (layout.bits === 16) return view.getInt16(at, true) / 32768;
    if (layout.bits === 24) return ((view.getInt8(at + 2) << 16) | view.getUint16(at, true)) / 8388608;
    return view.getInt32(at, true) / 2147483648;
  };
  return reduce(frames, buckets, (frame) => {
    const at = layout.offset + frame * blockAlign;
    let value = 0;
    for (let channel = 0; channel < layout.channels; channel += 1) {
      value = Math.max(value, Math.abs(sample(at + channel * bytesPerSample)));
    }
    return value;
  });
}

/**
 * The stored values resampled to the number of bars that fit the width. Each bar is the mean of its
 * span, and the row is scaled again so its tallest bar is 1: averaging flattens the top, and the
 * loudest passage should still reach the full height at every width.
 */
export function barsFromPeaks(peaks: Float32Array, count: number): Float32Array {
  const bars = new Float32Array(Math.max(0, Math.floor(count)));
  if (bars.length === 0 || peaks.length === 0) return bars;
  const span = peaks.length / bars.length;
  for (let bar = 0; bar < bars.length; bar += 1) {
    const start = Math.floor(bar * span);
    const end = Math.max(start + 1, Math.min(peaks.length, Math.floor((bar + 1) * span)));
    let total = 0;
    for (let index = start; index < end; index += 1) total += peaks[index] ?? 0;
    bars[bar] = total / (end - start);
  }
  return normalise(bars);
}
