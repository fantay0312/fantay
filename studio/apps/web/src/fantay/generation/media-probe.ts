// SPDX-License-Identifier: AGPL-3.0-only
// Intrinsic size (and duration) of a generated file (spec 05 §4.8): detached elements, metadata only,
// a timeout, and `null` on any failure so callers simply skip the resize.

export const MEDIA_PROBE_TIMEOUT_MS = 15_000;

export function probeImage(url: string, timeoutMs = MEDIA_PROBE_TIMEOUT_MS): Promise<{ width: number; height: number } | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (value: { width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    image.decoding = 'async';
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      finish(width > 0 && height > 0 ? { width, height } : null);
    };
    image.onerror = () => finish(null);
    image.src = url;
  });
}

export function probeVideo(
  url: string,
  timeoutMs = MEDIA_PROBE_TIMEOUT_MS,
): Promise<{ width: number; height: number; durationMs: number } | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let settled = false;
    const finish = (value: { width: number; height: number; durationMs: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      // Release the network request and decoder.
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // jsdom and some engines do not implement load(); nothing to release then.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      const seconds = video.duration;
      if (width > 0 && height > 0) {
        finish({ width, height, durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0 });
      } else {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}
