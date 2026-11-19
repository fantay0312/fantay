// SPDX-License-Identifier: AGPL-3.0-only
// Reads an `.excalidraw` file into what the drawing needs, before the drawing library is loaded:
// is it a scene at all, how many elements are visible, which embedded pictures may be drawn, and
// what paper it is drawn on. Everything here distrusts the file: colours that are not colours are
// replaced, embedded files must be base64 `data:` URLs of an image type and stay under a byte cap,
// and only the pictures that a visible element shows are kept. Pure: no React, no DOM, no library.

/** Files above this are not fetched: parsing them would stall the tab. */
export const MAX_SCENE_FILE_BYTES = 40 * 1024 * 1024;
/**
 * Visible elements the preview draws. The library draws a scene in one uninterrupted pass on the
 * main thread (rough.js shapes, then the SVG). Measured in the development build: the longest stall
 * is about 110 ms at 800 elements and 200 ms at 3,000; the app's thumbnail stops at 200 elements,
 * which is too few for a reading view. Past this cap a slower machine would stall for seconds.
 */
export const MAX_SCENE_ELEMENTS = 3000;
/** Embedded pictures the preview takes, decoded bytes, all pictures together. */
export const MAX_EMBEDDED_BYTES = 24 * 1024 * 1024;

/** Image types the library draws (its IMAGE_MIME_TYPES); anything else is dropped. */
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon|avif|svg\+xml));base64,/i;
const NOT_BASE64 = /[^A-Za-z0-9+/=\r\n]/;

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NAMED_COLOR = /^[a-z]{3,24}$/i;
const FUNCTION_COLOR = /^(?:rgba?|hsla?)\(\s*[-+0-9.%,\s/a-z]{1,80}\)$/i;
const DEFAULT_STROKE = '#1e1e1e';
const DEFAULT_PAPER = '#ffffff';

export interface SceneFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export interface WhiteboardScene {
  /** Elements that are not deleted, colours checked; the library's `restore` repairs the rest. */
  elements: Record<string, unknown>[];
  /** Embedded pictures shown by a visible image element, keyed by file id. */
  files: Record<string, SceneFile>;
  /** The scene's paper colour, or null for a transparent scene. */
  background: string | null;
  /** The file says it was drawn in Excalidraw's dark theme. */
  authoredDark: boolean;
}

export interface SceneStats {
  /** Elements that are not deleted. */
  elements: number;
  /** Image elements whose picture can be drawn. */
  images: number;
}

export type SceneReading =
  | { kind: 'scene'; scene: WhiteboardScene; stats: SceneStats }
  | { kind: 'empty'; stats: SceneStats }
  /** Valid JSON, but not an Excalidraw scene. */
  | { kind: 'not-scene' }
  /** Not valid JSON: damaged, or still being written. */
  | { kind: 'damaged' }
  | { kind: 'too-many-elements'; count: number; limit: number; stats: SceneStats }
  | { kind: 'too-many-bytes'; bytes: number; limit: number; stats: SceneStats };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A CSS colour the library may write into an attribute; never a `url(...)` reference. */
export function isPlainColor(value: string): boolean {
  const color = value.trim();
  return HEX_COLOR.test(color) || NAMED_COLOR.test(color) || FUNCTION_COLOR.test(color);
}

/** True when the colour paints nothing: `transparent`, or an alpha of zero. */
export function isTransparentColor(value: string): boolean {
  const color = value.trim().toLowerCase();
  if (color === 'transparent') return true;
  if (HEX_COLOR.test(color)) return (color.length === 5 && color.endsWith('0')) || (color.length === 9 && color.endsWith('00'));
  const alpha = /^(?:rgba|hsla)\(.*[,/]\s*(0(?:\.0*)?|0?\.0+|0%)\s*\)$/.exec(color);
  return alpha !== null;
}

/** The paper the scene is drawn on; null when it has none. */
export function sceneBackground(appState: unknown): string | null {
  if (!isRecord(appState)) return DEFAULT_PAPER;
  const value = appState.viewBackgroundColor;
  if (typeof value !== 'string' || !isPlainColor(value)) return DEFAULT_PAPER;
  return isTransparentColor(value) ? null : value.trim();
}

/** An embedded file the drawing may use, or null. Bytes are the decoded size. */
export function readSceneFile(id: string, value: unknown): { file: SceneFile; bytes: number } | null {
  if (!isRecord(value) || typeof value.dataURL !== 'string') return null;
  const dataURL = value.dataURL;
  const head = IMAGE_DATA_URL.exec(dataURL.slice(0, 64));
  if (!head) return null;
  const body = dataURL.slice(head[0].length);
  if (body.length === 0 || NOT_BASE64.test(body)) return null;
  const mimeType = (head[1] ?? '').toLowerCase();
  const created = typeof value.created === 'number' && Number.isFinite(value.created) ? value.created : 0;
  return { file: { id, mimeType, dataURL, created }, bytes: Math.floor((body.length * 3) / 4) };
}

/** Replaces a colour that is not a plain colour (a paint-server reference, markup) with a default. */
function checkColors(element: Record<string, unknown>): Record<string, unknown> {
  const stroke = element.strokeColor;
  const fill = element.backgroundColor;
  const strokeOk = stroke === undefined || (typeof stroke === 'string' && isPlainColor(stroke));
  const fillOk = fill === undefined || (typeof fill === 'string' && isPlainColor(fill));
  if (strokeOk && fillOk) return element;
  return {
    ...element,
    ...(strokeOk ? {} : { strokeColor: DEFAULT_STROKE }),
    ...(fillOk ? {} : { backgroundColor: 'transparent' }),
  };
}

/** Whether a parsed JSON value is an Excalidraw scene (or the editor's clipboard payload). */
function isSceneShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const type = value.type;
  const typed = type === 'excalidraw' || type === 'excalidraw/clipboard';
  if (type !== undefined && !typed) return false;
  if (value.elements === undefined || value.elements === null) return typed;
  return Array.isArray(value.elements);
}

/**
 * A short fingerprint of the file's text (FNV-1a over UTF-16 units, plus the length). Pictures are
 * kept by content, so a rewrite that changes nothing draws nothing, and text that is still the
 * previous version is never filed under the new one.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length.toString(36)}.${(hash >>> 0).toString(36)}`;
}

function stripMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readScene(text: string): SceneReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripMark(text));
  } catch {
    return { kind: 'damaged' };
  }
  if (!isSceneShape(parsed)) return { kind: 'not-scene' };

  const source = Array.isArray(parsed.elements) ? parsed.elements : [];
  const elements: Record<string, unknown>[] = [];
  const wanted = new Set<string>();
  for (const item of source) {
    if (!isRecord(item) || typeof item.type !== 'string' || item.isDeleted === true) continue;
    elements.push(checkColors(item));
    if (item.type === 'image' && typeof item.fileId === 'string') wanted.add(item.fileId);
  }

  const files: Record<string, SceneFile> = {};
  let bytes = 0;
  const storedFiles = isRecord(parsed.files) ? parsed.files : {};
  for (const id of wanted) {
    if (!Object.prototype.hasOwnProperty.call(storedFiles, id)) continue;
    const read = readSceneFile(id, storedFiles[id]);
    if (!read) continue;
    files[id] = read.file;
    bytes += read.bytes;
  }
  const images = elements.filter((element) => element.type === 'image' && typeof element.fileId === 'string' && files[element.fileId]).length;
  const stats: SceneStats = { elements: elements.length, images };

  if (elements.length === 0) return { kind: 'empty', stats };
  if (elements.length > MAX_SCENE_ELEMENTS) return { kind: 'too-many-elements', count: elements.length, limit: MAX_SCENE_ELEMENTS, stats };
  if (bytes > MAX_EMBEDDED_BYTES) return { kind: 'too-many-bytes', bytes, limit: MAX_EMBEDDED_BYTES, stats };

  const appState = isRecord(parsed.appState) ? parsed.appState : null;
  return {
    kind: 'scene',
    stats,
    scene: {
      elements,
      files,
      background: sceneBackground(appState),
      authoredDark: appState?.theme === 'dark',
    },
  };
}
