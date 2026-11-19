// SPDX-License-Identifier: AGPL-3.0-only
// The waveform of an audio file: fetched once, decoded once, kept per file version. Viewers are
// unmounted on every tab switch, so the result lives here, outside React, and coming back to a file
// draws its shape at once. A file too long to decode whole, a decoder that fails and a decode that
// takes too long all end the same way: no waveform (`peaks: null`), and the player shows a plain
// progress track. That is a normal outcome, not an error.
// The same fetch can also feed the player itself (`keepBytes`), for files the server sends without
// byte ranges: the browser cannot seek in those, so they are played from memory instead.
import { useEffect, useState } from 'react';

import type { ProjectFile } from '../../../../types';
import { useArtifactBytes, type ArtifactSourceResult } from '../../use-artifact-source';
import { probeAudio, type AudioProbe } from './audio-probe';
import { peaksFromChannels, peaksFromPcm } from './peaks';
import type { PeaksRequest, PeaksResponse } from './peaks.worker';

/** Larger files still play; they are just not fetched a second time for their shape. */
export const WAVEFORM_MAX_BYTES = 64 * 1024 * 1024;
/**
 * Web Audio decodes a compressed file whole, at its full rate, before it hands anything back: a
 * quarter of an hour of stereo is already about 300 MB for a moment. Longer files get the plain track.
 */
export const WAVEFORM_MAX_SECONDS = 15 * 60;
/** The shape needs no treble: decoding to a low rate keeps the decoded copy small. */
const DECODE_SAMPLE_RATE = 8000;
const DECODE_TIMEOUT_MS = 20_000;
const WORKER_TIMEOUT_MS = 15_000;
const MAX_CHANNELS = 8;
const MAX_CACHED = 32;

export interface Waveform {
  /** Loudness per slice of the file, 0..1; null when the file has no drawable shape. */
  peaks: Float32Array | null;
  /** What the file's header says (sample rate, channels); null when it could not be read. */
  probe: AudioProbe | null;
  /** Channels the decoder produced, when the header did not say. */
  channels: number;
}

const NO_WAVEFORM: Waveform = { peaks: null, probe: null, channels: 0 };

const settled = new Map<string, Waveform>();
const pending = new Map<string, Promise<Waveform>>();

function remember(key: string, waveform: Waveform): void {
  settled.delete(key);
  settled.set(key, waveform);
  if (settled.size > MAX_CACHED) {
    const oldest = settled.keys().next().value;
    if (oldest !== undefined) settled.delete(oldest);
  }
}

export function waveformKey(projectId: string, file: Pick<ProjectFile, 'name' | 'mtime'>): string {
  return `${projectId}\n${file.name}\n${Math.round(file.mtime)}`;
}

/** Test seam. */
export function resetWaveformCache(): void {
  settled.clear();
  pending.clear();
}

class WorkerUnavailable extends Error {}

/** Rejects with `WorkerUnavailable` when the worker never ran; resolves null when it ran out of time. */
function reduceInWorker(request: PeaksRequest, transfer: Transferable[]): Promise<Float32Array | null> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./peaks.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      reject(new WorkerUnavailable());
      return;
    }
    const finish = (settle: () => void): void => {
      window.clearTimeout(timer);
      worker.terminate();
      settle();
    };
    const timer = window.setTimeout(() => finish(() => resolve(null)), WORKER_TIMEOUT_MS);
    worker.addEventListener('message', (event: MessageEvent<PeaksResponse>) => {
      const data = event.data;
      finish(() => resolve('peaks' in data ? data.peaks : null));
    });
    worker.addEventListener('error', () => finish(() => reject(new WorkerUnavailable())));
    worker.postMessage(request, transfer);
  });
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        window.clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

async function compute(bytes: ArrayBuffer, playerDuration: number): Promise<Waveform> {
  const probe = probeAudio(bytes);

  if (probe?.pcm) {
    // WAV: the samples are in the file as they are. Copied to the worker, so this thread can still
    // do the sums itself if the worker cannot start.
    const layout = probe.pcm;
    const peaks = await reduceInWorker({ kind: 'pcm', bytes, layout }, []).catch(() => peaksFromPcm(new Uint8Array(bytes), layout));
    return { peaks, probe, channels: probe.channels };
  }

  // The player's length when it knows it; otherwise what the file's own header says.
  const duration = playerDuration > 0 ? playerDuration : (probe?.duration ?? 0);
  if (!(duration > 0) || duration > WAVEFORM_MAX_SECONDS || typeof OfflineAudioContext === 'undefined') {
    return { peaks: null, probe, channels: probe?.channels ?? 0 };
  }

  // Web Audio decodes on its own thread and resamples to the context's rate. The decoder takes the
  // buffer it is given, so it gets a copy: the bytes may still be wanted for playback.
  let audio: AudioBuffer;
  try {
    audio = await timeout(new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE).decodeAudioData(bytes.slice(0)), DECODE_TIMEOUT_MS);
  } catch {
    // The decoder refused the file or ran out of time: it still plays, without a shape.
    return { peaks: null, probe, channels: probe?.channels ?? 0 };
  }
  const count = Math.min(audio.numberOfChannels, MAX_CHANNELS);
  const copies: Float32Array[] = [];
  for (let channel = 0; channel < count; channel += 1) {
    const copy = new Float32Array(audio.length);
    audio.copyFromChannel(copy, channel);
    copies.push(copy);
  }
  const peaks = await reduceInWorker(
    { kind: 'channels', channels: copies },
    copies.map((copy) => copy.buffer),
  ).catch(() => {
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < count; channel += 1) channels.push(audio.getChannelData(channel));
    return peaksFromChannels(channels);
  });
  return { peaks, probe, channels: probe?.channels || audio.numberOfChannels };
}

/** Works the waveform out once per file version; later calls for the same version share the result. */
export function loadWaveform(key: string, bytes: ArrayBuffer, duration: number): Promise<Waveform> {
  const known = settled.get(key);
  if (known) return Promise.resolve(known);
  const running = pending.get(key);
  if (running) return running;
  const started = compute(bytes, duration)
    .catch((): Waveform => NO_WAVEFORM)
    .then((waveform) => {
      pending.delete(key);
      remember(key, waveform);
      return waveform;
    });
  pending.set(key, started);
  return started;
}

export interface WaveformState {
  /** Null until it has been worked out. While a newer version loads, the previous one stays. */
  waveform: Waveform | null;
  /** True when the answer is final for this version, with or without a shape. */
  settled: boolean;
  /** True when the shape was already known as the viewer mounted: it is drawn without the entrance. */
  instant: boolean;
  /** The file's bytes, when `keepBytes` asked for them and they have arrived. */
  bytes: ArrayBuffer | null;
  /** The fetch behind `bytes`, for its loading and failure states. */
  source: ArtifactSourceResult<ArrayBuffer>;
}

export interface UseWaveformOptions {
  /** False while the tab is hidden: nothing is fetched or decoded. */
  active: boolean;
  /**
   * What the player knows about the file's length: `pending` before it has loaded, `known` with
   * `duration` in seconds, `unknown` when the player loaded the file but could not tell.
   */
  length: 'pending' | 'known' | 'unknown';
  duration: number;
  /** True for WAV, whose shape does not depend on the decoder or on the length. */
  plainPcm: boolean;
  /** True when the player needs the bytes itself, whatever happens to the shape. */
  keepBytes: boolean;
}

export function useWaveform(projectId: string, file: ProjectFile, options: UseWaveformOptions): WaveformState {
  const { active, length, duration, plainPcm, keepBytes } = options;
  const key = waveformKey(projectId, file);
  const [held, setHeld] = useState<{ key: string; name: string; waveform: Waveform; instant: boolean } | null>(() => {
    const known = settled.get(key);
    return known ? { key, name: file.name, waveform: known, instant: true } : null;
  });
  const known = held?.key === key ? held.waveform : settled.get(key);
  // Worked out earlier in this session (another mount of this file): taken as it is.
  if (known && held?.key !== key) setHeld({ key, name: file.name, waveform: known, instant: true });

  const withinSize = file.size <= WAVEFORM_MAX_BYTES;
  // A length the player could not tell may still be in the file's header: worth a look.
  const drawable = plainPcm || length === 'unknown' || (length === 'known' && duration <= WAVEFORM_MAX_SECONDS);
  const lengthSettled = plainPcm || length !== 'pending';
  const wantsShape = !known && withinSize && drawable;
  const wantsBytes = withinSize && (keepBytes || (wantsShape && lengthSettled));

  const source = useArtifactBytes(projectId, file, { enabled: wantsBytes && active, maxBytes: WAVEFORM_MAX_BYTES });
  const data = wantsBytes && source.source.status === 'ready' && !source.source.stale ? source.source.data : null;
  const fetchFailed = wantsBytes && source.source.status === 'failed';

  const decodable = wantsShape && lengthSettled;
  useEffect(() => {
    if (data === null || !decodable) return;
    let current = true;
    void loadWaveform(key, data, length === 'known' ? duration : 0).then((waveform) => {
      if (current) setHeld({ key, name: file.name, waveform, instant: false });
    });
    return () => {
      current = false;
    };
    // The length only gates the start (`decodable`); a refined duration must not restart the decode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, data, decodable, file.name]);

  const bytes = keepBytes ? data : null;
  if (known) return { waveform: known, settled: true, instant: held?.key === key ? held.instant : true, bytes, source };
  const previous = held?.name === file.name ? held.waveform : null;
  // No shape is coming: the file is too large or too long, or its bytes could not be fetched.
  const final = lengthSettled && (!wantsShape || fetchFailed);
  return { waveform: previous, settled: final, instant: false, bytes, source };
}
