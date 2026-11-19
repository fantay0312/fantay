// SPDX-License-Identifier: AGPL-3.0-only
// The drawing a whiteboard tab shows, and how it survives. Viewers are unmounted on every tab switch
// and every rewrite by the agent, so pictures are kept outside React: per version (a remount or a
// return to the drawing shows the same version at once) and per file (the last good picture, shown
// while a newer version is drawn, and kept when that version turns out to be half-written).
// A picture only replaces the one on screen once it is decoded, so an update never blinks.
'use client';

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

import { drawScene, type WhiteboardPicture } from './draw';
import type { WhiteboardScene } from './scene';

/** Past this, drawing ends in a notice; the result is still kept if it arrives later. */
export const DRAW_TIME_LIMIT_MS = 20_000;
/** A draw faster than this shows no loading state. */
const SLOW_DRAW_MS = 180;
const MAX_PICTURES = 24;
const MAX_PICTURE_BYTES = 96 * 1024 * 1024;

const pictures = new Map<string, WhiteboardPicture>();
const lastGood = new Map<string, { key: string; picture: WhiteboardPicture }>();

function remember(key: string, fileKey: string, picture: WhiteboardPicture): void {
  pictures.delete(key);
  pictures.set(key, picture);
  let bytes = 0;
  for (const kept of pictures.values()) bytes += kept.svg.size;
  for (const [oldest, kept] of pictures) {
    if (pictures.size <= MAX_PICTURES && bytes <= MAX_PICTURE_BYTES) break;
    if (oldest === key) continue;
    pictures.delete(oldest);
    bytes -= kept.svg.size;
  }
  lastGood.delete(fileKey);
  lastGood.set(fileKey, { key, picture });
  if (lastGood.size > MAX_PICTURES) {
    const oldest = lastGood.keys().next().value;
    if (oldest !== undefined) lastGood.delete(oldest);
  }
}

/** Test seam. */
export function forgetWhiteboardPictures(): void {
  pictures.clear();
  lastGood.clear();
}

export interface ShownPicture {
  /** The version (and rendering) this picture belongs to. */
  key: string;
  picture: WhiteboardPicture;
  /** Object URL of the SVG; revoked when the picture leaves the screen. */
  url: string;
}

export type DrawPhase = 'idle' | 'drawing' | 'slow' | 'failed' | 'timeout' | 'nothing';

export interface WhiteboardPictureOptions {
  /** One file: project and path. */
  fileKey: string;
  /** One rendering of one version: file, version, light or dark. */
  renderKey: string;
  scene: WhiteboardScene | null;
  dark: boolean;
  /** False while the tab is hidden or the source is showing: nothing new is drawn. */
  enabled: boolean;
}

export interface WhiteboardPictureResult {
  shown: ShownPicture | null;
  /** What is happening to the version `renderKey` names. */
  phase: DrawPhase;
  redraw(): void;
}

function decoded(url: string): Promise<void> {
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  return image.decode().catch(() => {
    /* Shown anyway: the <img> reports its own failure. */
  });
}

export function useWhiteboardPicture({ fileKey, renderKey, scene, dark, enabled }: WhiteboardPictureOptions): WhiteboardPictureResult {
  const [shown, setShown] = useState<ShownPicture | null>(null);
  const [phase, setPhase] = useState<{ key: string; value: DrawPhase } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The last good picture of this file is on screen before the first paint.
  useLayoutEffect(() => {
    const kept = pictures.get(renderKey) ? { key: renderKey, picture: pictures.get(renderKey) as WhiteboardPicture } : lastGood.get(fileKey);
    if (!kept) return;
    setShown((current) => current ?? { key: kept.key, picture: kept.picture, url: URL.createObjectURL(kept.picture.svg) });
    // Only on mount and when another file is handed in; versions are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  useEffect(() => {
    const url = shown?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [shown?.url]);

  useEffect(() => {
    if (!enabled || scene === null) return;
    let current = true;
    const show = (picture: WhiteboardPicture): void => {
      const url = URL.createObjectURL(picture.svg);
      void decoded(url).then(() => {
        if (!current) {
          URL.revokeObjectURL(url);
          return;
        }
        setShown({ key: renderKey, picture, url });
        setPhase({ key: renderKey, value: 'idle' });
      });
    };

    const cached = pictures.get(renderKey);
    if (cached) {
      if (shown?.key !== renderKey) show(cached);
      return () => {
        current = false;
      };
    }

    setPhase({ key: renderKey, value: 'drawing' });
    const slow = window.setTimeout(() => {
      if (current) setPhase((previous) => (previous?.key === renderKey && previous.value === 'drawing' ? { key: renderKey, value: 'slow' } : previous));
    }, SLOW_DRAW_MS);
    const limit = window.setTimeout(() => {
      if (current) setPhase({ key: renderKey, value: 'timeout' });
      current = false;
    }, DRAW_TIME_LIMIT_MS);

    drawScene(scene, dark).then(
      (picture) => {
        window.clearTimeout(slow);
        window.clearTimeout(limit);
        if (picture) remember(renderKey, fileKey, picture);
        if (!current) return;
        if (picture) show(picture);
        else setPhase({ key: renderKey, value: 'nothing' });
      },
      () => {
        window.clearTimeout(slow);
        window.clearTimeout(limit);
        if (current) setPhase({ key: renderKey, value: 'failed' });
      },
    );
    return () => {
      current = false;
      window.clearTimeout(slow);
      window.clearTimeout(limit);
    };
    // `shown` is read only to skip re-showing the picture already on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, scene, renderKey, dark, fileKey, attempt]);

  const redraw = useCallback(() => setAttempt((value) => value + 1), []);
  return { shown, phase: phase?.key === renderKey ? phase.value : 'idle', redraw };
}
