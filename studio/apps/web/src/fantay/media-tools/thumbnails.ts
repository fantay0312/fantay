// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/lib/image-thumbnail.ts.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: in-memory LRU of object URLs (150 entries, in-use entries are
// never evicted), lazy generation with a small queue, React hooks for images and video posters.
// Nothing is persisted.
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { captureVideoFrame } from './video-frame';

export const CANVAS_IMAGE_PREVIEW_MAX_EDGE = 768;
export const THUMBNAIL_CACHE_LIMIT = 150;
const THUMBNAIL_QUALITY = 0.86;
const MAX_CONCURRENT_JOBS = 2;

type ImageSourceChoice = {
  previewUrl?: string | undefined;
  originalUrl: string;
  naturalWidth?: number | undefined;
  naturalHeight?: number | undefined;
  renderedWidth: number;
  renderedHeight: number;
  scale: number;
  devicePixelRatio?: number | undefined;
  previewMaxEdge?: number | undefined;
};

/**
 * Small previews keep panning cheap, but they look soft once the node is magnified: use the
 * original only when the on-screen size needs more pixels than the preview holds (upstream, unchanged).
 */
export function pickImageSource({
  previewUrl,
  originalUrl,
  naturalWidth,
  naturalHeight,
  renderedWidth,
  renderedHeight,
  scale,
  devicePixelRatio = globalThis.devicePixelRatio || 1,
  previewMaxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE,
}: ImageSourceChoice): string {
  if (!previewUrl) return originalUrl;
  const naturalLongEdge = Math.max(naturalWidth || 0, naturalHeight || 0);
  const previewLongEdge = naturalLongEdge > 0 ? Math.min(previewMaxEdge, naturalLongEdge) : previewMaxEdge;
  const requiredLongEdge = Math.max(renderedWidth, renderedHeight) * scale * devicePixelRatio;
  return requiredLongEdge > previewLongEdge ? originalUrl : previewUrl;
}

export function getThumbnailDimensions(width: number, height: number, maxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(1, width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A WebP thumbnail of `blob`, or undefined when the image is already within `maxEdge`. */
export async function createImageThumbnail(blob: Blob, maxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE): Promise<Blob | undefined> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = getThumbnailDimensions(bitmap.width, bitmap.height, maxEdge);
    if (width === bitmap.width && height === bitmap.height) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob | undefined>((resolve) =>
      canvas.toBlob((result) => resolve(result || undefined), 'image/webp', THUMBNAIL_QUALITY),
    );
  } finally {
    bitmap.close();
  }
}

/* ── LRU cache of object URLs ───────────────────────────────────────────────────────────── */

type EntryStatus = 'pending' | 'ready' | 'none' | 'failed';

interface CacheEntry {
  status: EntryStatus;
  /** Object URL of the generated preview (ready only). */
  objectUrl: string | null;
  users: number;
  lastUsed: number;
}

const entries = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<() => void>>();
const queue: Array<{ key: string; run: () => Promise<Blob | undefined> }> = [];
let running = 0;
let clock = 0;

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function revoke(entry: CacheEntry): void {
  if (entry.objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(entry.objectUrl);
  }
}

function evictIfNeeded(): void {
  if (entries.size <= THUMBNAIL_CACHE_LIMIT) return;
  const idle = [...entries.entries()]
    .filter(([, entry]) => entry.users === 0 && entry.status !== 'pending')
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [key, entry] of idle) {
    if (entries.size <= THUMBNAIL_CACHE_LIMIT) break;
    revoke(entry);
    entries.delete(key);
    notify(key);
  }
}

function pump(): void {
  while (running < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    const entry = entries.get(job.key);
    if (!entry || entry.status !== 'pending') continue;
    running += 1;
    void job
      .run()
      .then(
        (blob) => {
          const current = entries.get(job.key);
          if (!current) return;
          if (blob && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            current.objectUrl = URL.createObjectURL(blob);
            current.status = 'ready';
          } else {
            current.status = 'none';
          }
        },
        () => {
          const current = entries.get(job.key);
          if (current) current.status = 'failed';
        },
      )
      .finally(() => {
        running -= 1;
        notify(job.key);
        evictIfNeeded();
        pump();
      });
  }
}

function acquire(key: string, run: () => Promise<Blob | undefined>): () => void {
  clock += 1;
  let entry = entries.get(key);
  if (!entry) {
    entry = { status: 'pending', objectUrl: null, users: 0, lastUsed: clock };
    entries.set(key, entry);
    queue.push({ key, run });
    pump();
  }
  entry.users += 1;
  entry.lastUsed = clock;
  return () => {
    const current = entries.get(key);
    if (!current) return;
    current.users = Math.max(0, current.users - 1);
    evictIfNeeded();
  };
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(key);
  };
}

function snapshot(key: string): string | null {
  const entry = entries.get(key);
  return entry?.status === 'ready' ? entry.objectUrl : null;
}

function useCachedObjectUrl(key: string | null, run: (() => Promise<Blob | undefined>) | null): string | null {
  const subscribeKey = useCallback((listener: () => void) => (key ? subscribe(key, listener) : () => {}), [key]);
  const value = useSyncExternalStore(subscribeKey, () => (key ? snapshot(key) : null), () => null);
  useEffect(() => {
    if (!key || !run) return undefined;
    return acquire(key, run);
    // `run` is derived from the key; re-acquiring on every render would leak users.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return value;
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`thumbnail-fetch-${response.status}`);
  return response.blob();
}

function canGenerateThumbnails(): boolean {
  return typeof createImageBitmap === 'function' && typeof document !== 'undefined';
}

/**
 * The URL to render for an image shown at `renderedLongEdgePx` screen px: a ≤768 px WebP preview
 * from the in-memory LRU when that is enough for the device pixel ratio, else the original. While
 * the preview is generated (or when it cannot be), the original URL is returned.
 */
export function useImageSource(url: string, key: string, renderedLongEdgePx: number): string {
  const devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const wantsPreview = Boolean(url) && canGenerateThumbnails() && renderedLongEdgePx * devicePixelRatio <= CANVAS_IMAGE_PREVIEW_MAX_EDGE;
  const cacheKey = wantsPreview ? `image:${key}` : null;
  const preview = useCachedObjectUrl(cacheKey, wantsPreview ? () => fetchBlob(url).then((blob) => createImageThumbnail(blob)) : null);
  return preview ?? url;
}

/**
 * A poster (first frame) of a video for nodes that are not live, cached with the image previews.
 * Null while it is generated or when the frame cannot be read.
 */
export function useVideoPoster(url: string | null, key: string): string | null {
  const enabled = Boolean(url) && typeof document !== 'undefined';
  const cacheKey = enabled ? `poster:${key}` : null;
  return useCachedObjectUrl(
    cacheKey,
    enabled && url
      ? async () => {
          const frame = await captureVideoFrame(url, 'first');
          if (!canGenerateThumbnails()) return frame.blob;
          return (await createImageThumbnail(frame.blob).catch(() => undefined)) ?? frame.blob;
        }
      : null,
  );
}

/** Test hook: drops every cached preview. */
export function __resetThumbnailCacheForTests(): void {
  for (const entry of entries.values()) revoke(entry);
  entries.clear();
  queue.length = 0;
  running = 0;
  clock = 0;
}
