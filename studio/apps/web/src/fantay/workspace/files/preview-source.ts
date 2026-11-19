// SPDX-License-Identifier: AGPL-3.0-only
// Where a card's preview comes from: the first kilobytes of a text file, or the first frame of a
// video. Both are fetched a few at a time, kept per file version and shared by every card, so
// scrolling a large library never fires a burst of requests and coming back to a folder is instant.
// A card that scrolls away before its turn gives the turn up.
import { useEffect, useState } from 'react';

import { fetchProjectFileTextPreview } from '../../../providers/registry';
import type { ProjectFile } from '../../../types';
import type { WorkspaceCollabContext } from '@open-design/contracts';

/** Runs at most `limit` tasks at once. A queued task can be cancelled; a started one finishes. */
export function createTaskQueue(limit: number): <T>(task: () => Promise<T>) => { promise: Promise<T>; cancel(): void } {
  let active = 0;
  const waiting: Array<() => void> = [];
  const next = (): void => {
    while (active < limit && waiting.length > 0) waiting.shift()?.();
  };
  return <T,>(task: () => Promise<T>) => {
    let start: (() => void) | null = null;
    const promise = new Promise<T>((resolve, reject) => {
      start = () => {
        active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      };
      waiting.push(start);
    });
    // On a microtask, so a card unmounted in the same commit cancels before anything starts.
    queueMicrotask(next);
    return {
      promise,
      cancel: () => {
        const at = start ? waiting.indexOf(start) : -1;
        if (at !== -1) waiting.splice(at, 1);
      },
    };
  };
}

/** A small most-recently-used cache; `onEvict` releases what an entry holds. */
function createCache<T>(capacity: number, onEvict?: (value: T) => void) {
  const entries = new Map<string, T>();
  return {
    get(key: string): T | undefined {
      const value = entries.get(key);
      if (value !== undefined) {
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(key: string, value: T): void {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          const evicted = entries.get(oldest);
          entries.delete(oldest);
          if (evicted !== undefined) onEvict?.(evicted);
        }
      }
    },
    clear(): void {
      entries.clear();
    },
  };
}

/** One version of one file. A new write changes the key, so a stale preview is never shown. */
export function previewKey(projectId: string, file: ProjectFile): string {
  return `${projectId}\u0000${file.name}\u0000${Math.round(file.mtime)}\u0000${file.size}`;
}

// ── text ────────────────────────────────────────────────────────────────────────────────────────

export type PreviewText = { status: 'ready'; text: string; truncated: boolean } | { status: 'failed' };

const textCache = createCache<PreviewText>(800);
const scheduleText = createTaskQueue(4);

/**
 * The first `limit` bytes of a file as text, or null while it loads. `enabled` false holds the
 * request (a kind of file that is not drawn from its text).
 */
export function usePreviewText(
  projectId: string,
  file: ProjectFile,
  limit: number,
  enabled: boolean,
  workspaceContext?: WorkspaceCollabContext | null,
): PreviewText | null {
  const key = previewKey(projectId, file);
  const [held, setHeld] = useState<{ key: string; value: PreviewText } | null>(() => {
    const cached = enabled ? textCache.get(key) : undefined;
    return cached ? { key, value: cached } : null;
  });
  const name = file.name;
  const version = Math.round(file.mtime);

  useEffect(() => {
    if (!enabled) return;
    const cached = textCache.get(key);
    if (cached) {
      setHeld({ key, value: cached });
      return;
    }
    let current = true;
    const task = scheduleText(async (): Promise<PreviewText> => {
      const response = await fetchProjectFileTextPreview(projectId, name, { limit, cacheBustKey: version, workspaceContext });
      return response ? { status: 'ready', text: response.text, truncated: response.truncated } : { status: 'failed' };
    });
    task.promise.then(
      (value) => {
        textCache.set(key, value);
        if (current) setHeld({ key, value });
      },
      () => {
        if (current) setHeld({ key, value: { status: 'failed' } });
      },
    );
    return () => {
      current = false;
      task.cancel();
    };
  }, [enabled, key, projectId, name, version, limit, workspaceContext]);

  return held?.key === key ? held.value : null;
}

// ── video ───────────────────────────────────────────────────────────────────────────────────────

/** A blob address of the first frame, or 'none' when the video could not give one. */
type Poster = string;
const NO_POSTER = 'none';
const POSTER_WIDTH = 480;
const POSTER_TIMEOUT_MS = 8000;

const posterCache = createCache<Poster>(120, (value) => {
  if (value !== NO_POSTER) URL.revokeObjectURL(value);
});
const schedulePoster = createTaskQueue(2);

function waitFor(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => done(new Error('timeout')), POSTER_TIMEOUT_MS);
    const done = (error?: Error): void => {
      window.clearTimeout(timer);
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onEvent = (): void => done();
    const onError = (): void => done(new Error('decode'));
    video.addEventListener(event, onEvent);
    video.addEventListener('error', onError);
  });
}

/**
 * Decodes one frame near the start and keeps it as a small JPEG. The video element exists only for
 * the capture: a grid of cards never holds a decoder per card.
 */
async function capturePoster(url: string): Promise<Poster> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    video.src = url;
    await waitFor(video, 'loadeddata');
    // The very first frame is often black; a moment in is the picture.
    const target = Number.isFinite(video.duration) ? Math.min(0.6, video.duration / 4) : 0;
    if (target > 0) {
      video.currentTime = target;
      await waitFor(video, 'seeked');
    }
    if (video.videoWidth === 0 || video.videoHeight === 0) return NO_POSTER;
    const scale = Math.min(1, POSTER_WIDTH / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return NO_POSTER;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return blob ? URL.createObjectURL(blob) : NO_POSTER;
  } catch {
    return NO_POSTER;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/** The first frame of a video: an address, `null` while it is being read, `false` when there is none. */
export function useVideoPoster(key: string, url: string, enabled: boolean): string | null | false {
  const [held, setHeld] = useState<{ key: string; value: Poster } | null>(() => {
    const cached = enabled ? posterCache.get(key) : undefined;
    return cached ? { key, value: cached } : null;
  });

  useEffect(() => {
    if (!enabled) return;
    const cached = posterCache.get(key);
    if (cached) {
      setHeld({ key, value: cached });
      return;
    }
    let current = true;
    const task = schedulePoster(() => capturePoster(url));
    void task.promise.then((value) => {
      posterCache.set(key, value);
      if (current) setHeld({ key, value });
    });
    return () => {
      current = false;
      task.cancel();
    };
  }, [enabled, key, url]);

  if (held?.key !== key) return null;
  return held.value === NO_POSTER ? false : held.value;
}

export function resetPreviewSourcesForTests(): void {
  textCache.clear();
  posterCache.clear();
}
