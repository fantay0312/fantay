// SPDX-License-Identifier: Apache-2.0
// Which project files can live on the board, and as what (spec 04 §4.5.1).

export type BoardPlaceableKind = 'frame' | 'image' | 'video' | 'audio' | 'design' | 'motion';

export const BOARD_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg'] as const;
export const BOARD_VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v'] as const;
export const BOARD_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'] as const;
export const BOARD_DESIGN_EXTENSIONS = ['.fig', '.op'] as const;

const FRAME_EXTENSIONS: readonly string[] = ['.html', '.htm'];
const MOVIE_DOCUMENT_PATH = 'movie-studio.json';
const MOTION_SOURCE_DIR = 'motion-source';
const MOVIE_RENDER_PATTERN = /^movie-[A-Za-z0-9-]+\.mp4$/;

/** `\` → `/`, leading `./` dropped, empty segments removed. */
function boardPathSegments(path: string): string[] {
  let normalized = path.replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized.split('/').filter((segment) => segment.length > 0);
}

function lowerExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** `motion-source/<id>` for a HyperFrames composition entry `motion-source/<id>/index.html`, else null. */
export function boardCompositionDir(path: string): string | null {
  const segments = boardPathSegments(path);
  if (segments.length !== 3) return null;
  const [root, id, file] = segments as [string, string, string];
  if (root !== MOTION_SOURCE_DIR || file !== 'index.html') return null;
  if (id.startsWith('.') || id.startsWith('movie-') || id.startsWith('style-')) return null;
  return `${MOTION_SOURCE_DIR}/${id}`;
}

/** Exactly the project-root `movie-studio.json`. */
export function isBoardMovieDocumentPath(path: string): boolean {
  return boardPathSegments(path).join('/') === MOVIE_DOCUMENT_PATH;
}

/** A movie render at the project root (`movie-<id>.mp4`). */
export function isBoardMovieRenderPath(path: string): boolean {
  return MOVIE_RENDER_PATTERN.test(path);
}

/**
 * Board node kind for a project-relative path, or null when the file never lives on the board:
 * hidden segments (`.od/`, `.hyperframes-cache/`, dotfiles), `node_modules/`, sketch/artifact sidecars, and every
 * `motion-source/**` file except a composition entry `motion-source/<id>/index.html`.
 */
export function boardKindForPath(path: string): BoardPlaceableKind | null {
  const segments = boardPathSegments(path);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment.startsWith('.') || segment === 'node_modules')) return null;
  const base = segments[segments.length - 1]!;
  if (base.startsWith('sketch-') || base.endsWith('.sketch.json') || base.endsWith('.artifact.json')) return null;
  if (segments[0] === MOTION_SOURCE_DIR) {
    return boardCompositionDir(segments.join('/')) ? 'motion' : null;
  }
  if (segments.length === 1 && base === MOVIE_DOCUMENT_PATH) return 'motion';
  const ext = lowerExtension(base);
  if (!ext) return null;
  if (FRAME_EXTENSIONS.includes(ext)) return 'frame';
  if ((BOARD_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'image';
  if ((BOARD_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video';
  if ((BOARD_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return 'audio';
  if ((BOARD_DESIGN_EXTENSIONS as readonly string[]).includes(ext)) return 'design';
  return null;
}
