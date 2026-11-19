// SPDX-License-Identifier: AGPL-3.0-only
// Turns audio samples into the waveform's loudness values off the main thread. It lives for one
// file: the audio is untrusted, so a file that makes the sums run long takes the worker with it,
// not the tab. WAV samples are read straight from the file's bytes; every other format arrives
// already decoded by Web Audio (which is not available in a worker).
/// <reference lib="webworker" />
import type { PcmLayout } from './audio-probe';
import { peaksFromChannels, peaksFromPcm } from './peaks';

export type PeaksRequest = { kind: 'pcm'; bytes: ArrayBuffer; layout: PcmLayout } | { kind: 'channels'; channels: Float32Array[] };
export type PeaksResponse = { peaks: Float32Array } | { error: true };

self.addEventListener('message', (event: MessageEvent<PeaksRequest>) => {
  try {
    const request = event.data;
    const peaks =
      request.kind === 'pcm' ? peaksFromPcm(new Uint8Array(request.bytes), request.layout) : peaksFromChannels(request.channels);
    self.postMessage({ peaks } satisfies PeaksResponse, { transfer: [peaks.buffer] });
  } catch {
    self.postMessage({ error: true } satisfies PeaksResponse);
  }
});
