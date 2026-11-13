// SPDX-License-Identifier: AGPL-3.0-only
// URLs and names of board media. The URL itself is the generation service's `mediaUrl` (spec 05 §4.7:
// project files through `/raw` with the workspace authority in the query, cover pseudo paths through
// the board cover routes); this module re-exports it for the media tools and adds the naming helpers.
import type { BoardMediaFile } from '@open-design/contracts';

export { mediaUrl } from '../generation/references';

/** Cache key of a media file version (`path@mtime`), used by the thumbnail and poster caches. */
export function mediaCacheKey(file: Pick<BoardMediaFile, 'path' | 'mtime'>): string {
  return `${file.path}@${file.mtime ?? 0}`;
}

/** Last path segment (`board-media/crops/a.png` → `a.png`). */
export function mediaBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1) || trimmed;
}

/** Base name without its last extension (`hero.final.png` → `hero.final`). */
export function mediaStemName(path: string): string {
  const base = mediaBaseName(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
