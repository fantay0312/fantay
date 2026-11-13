// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/lib/canvas/canvas-video-frame.ts.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: 15 s timeout, typed errors, the frame size is returned with the
// PNG blob, and the detached element is always released.

export type VideoFramePosition = 'first' | 'last' | 'current';

export interface CapturedVideoFrame {
  blob: Blob;
  width: number;
  height: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

type VideoWaitEvent = 'loadedmetadata' | 'loadeddata' | 'seeked';

function waitForVideo(video: HTMLVideoElement, eventName: VideoWaitEvent): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(eventName, finish);
      video.removeEventListener('error', fail);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('video-frame-read-failed'));
    };
    video.addEventListener(eventName, finish);
    video.addEventListener('error', fail);
  });
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('video-frame-timeout')), Math.max(0, timeoutMs));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function captureFrame(video: HTMLVideoElement, source: string, position: VideoFramePosition, currentTime: number): Promise<CapturedVideoFrame> {
  const metadataLoaded = waitForVideo(video, 'loadedmetadata');
  video.src = source;
  video.load();
  await metadataLoaded;
  const endTime = Math.max(0, (Number.isFinite(video.duration) ? video.duration : 0) - 0.001);
  const time = position === 'first' ? 0 : position === 'last' ? endTime : Math.min(Math.max(0, currentTime), endTime);
  if (time > 0) {
    const seeked = waitForVideo(video, 'seeked');
    video.currentTime = time;
    await seeked;
  } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForVideo(video, 'loadeddata');
  }
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error('video-frame-empty');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas-2d-unavailable');
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((result) => (result ? resolve(result) : reject(new Error('video-frame-encode-failed'))), 'image/png'),
  );
  return { blob, width, height };
}

/**
 * Captures the first, last or `currentTime` frame of `source` as a PNG through a detached
 * `<video>` (`preload="auto"`, muted). Rejects on a media error or after `timeoutMs`.
 */
export async function captureVideoFrame(
  source: string,
  position: VideoFramePosition,
  currentTime = 0,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CapturedVideoFrame> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    return await withTimeout(captureFrame(video, source, position, currentTime), timeoutMs);
  } finally {
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      /* jsdom and some engines throw on load() without a source */
    }
  }
}
