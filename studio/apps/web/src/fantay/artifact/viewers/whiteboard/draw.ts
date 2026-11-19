// SPDX-License-Identifier: AGPL-3.0-only
// Excalidraw restores the scene and exports an SVG with its fonts inlined.
// The library subsets each font it needs to the glyphs the scene uses and writes them into the SVG
// as `data:` URLs, so the picture is self-contained (it draws right inside an <img>, and a saved
// copy draws right anywhere). The fonts come from the copy under /artifact/excalidraw/, never from
// the library's CDN fallback (see `guardFontFetches`).
import type { ExcalidrawElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';

import { EXCALIDRAW_LOCAL_ASSET_PATH } from '../../../../components/excalidraw-assets';
import type { WhiteboardScene } from './scene';

/** Where `public/artifact/excalidraw/` is served; one address for the whole app. */
export const WHITEBOARD_ASSET_PATH = EXCALIDRAW_LOCAL_ASSET_PATH;
/** Margin of paper around the drawing, in scene pixels (excalidraw.com exports with 10). */
export const EXPORT_PADDING = 20;
/** Frame names are drawn above the frame: 3px gap plus one 14px line at line height 1.25. */
const FRAME_LABEL_RISE = 3 + 14 * 1.25;

/** The library's fallback for a font it cannot fetch from the asset path. */
const LIBRARY_FONT_CDN = /^https:\/\/esm\.sh\/@excalidraw\/excalidraw(?:@[^/]+)?\/dist\/prod\/(fonts\/[^?#]+)/;

export interface WhiteboardPicture {
  /** The drawing as a self-contained SVG document. */
  svg: Blob;
  /** Size at 100%, in CSS pixels. */
  width: number;
  height: number;
  /** Scene coordinates of the picture's top-left corner; null when they could not be confirmed. */
  origin: { x: number; y: number } | null;
  /** The picture has paper of its own; false for a transparent scene. */
  paper: boolean;
}

type Library = typeof import('@excalidraw/excalidraw');
let library: Promise<Library> | null = null;

/** The local copy of a font the library would fetch from its CDN; null for any other address. */
export function localFontAddress(address: string, base: string): string | null {
  const match = LIBRARY_FONT_CDN.exec(address);
  return match?.[1] ? new URL(match[1], base).href : null;
}

function assetBase(): string {
  return new URL(WHITEBOARD_ASSET_PATH, window.location.href).href;
}

/**
 * The library keeps its font addresses from the first time any part of the app touches its font
 * registry. `components/excalidraw-assets.ts` sets the local path before the library is evaluated
 * anywhere in the app, so the registry normally never learns the CDN. This guard is the second
 * line, for a build or an embedding where something loaded the library first: while a drawing
 * is exported, a request for one of the library's CDN fonts is answered from the local copy
 * instead, so the export never reaches the network whoever loaded the library first. Every other
 * request passes through untouched. Nested exports share one guard; it removes itself afterwards
 * unless something else has replaced `fetch` in the meantime.
 */
let guardDepth = 0;
let guard: { original: typeof fetch; wrapper: typeof fetch } | null = null;

function guardFontFetches(): () => void {
  if (guardDepth === 0) {
    const original = window.fetch;
    const base = assetBase();
    const wrapper: typeof fetch = (input, init) => {
      const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const local = localFontAddress(address, base);
      return original.call(window, local ?? input, init);
    };
    window.fetch = wrapper;
    guard = { original, wrapper };
  }
  guardDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    guardDepth -= 1;
    if (guardDepth === 0 && guard) {
      if (window.fetch === guard.wrapper) window.fetch = guard.original;
      guard = null;
    }
  };
}

/** Loads the library once, after pointing it at the local fonts. */
function loadLibrary(): Promise<Library> {
  if (!library) {
    const host = window as Window & { EXCALIDRAW_ASSET_PATH?: string | string[] };
    if (host.EXCALIDRAW_ASSET_PATH === undefined) host.EXCALIDRAW_ASSET_PATH = assetBase();
    library = import('@excalidraw/excalidraw').catch((error: unknown) => {
      library = null;
      throw error;
    });
  }
  return library;
}

/** Starts fetching the library early (when the file opens), without drawing anything. */
export function preloadWhiteboardLibrary(): void {
  void loadLibrary().catch(() => {
    /* The draw that follows reports the failure. */
  });
}

function isFrameLike(element: ExcalidrawElement): boolean {
  return element.type === 'frame' || element.type === 'magicframe';
}

/**
 * Scene coordinates of the exported picture's corner, computed the way the exporter sizes it
 * (bounds of the elements not clipped inside a frame, plus frame names, plus padding). Confirmed
 * against the size the exporter wrote; null when they disagree, so a camera is never misplaced.
 */
function pictureOrigin(
  elements: readonly NonDeleted<ExcalidrawElement>[],
  size: { width: number; height: number },
  getCommonBounds: Library['getCommonBounds'],
): { x: number; y: number } | null {
  const frames = new Map(elements.filter(isFrameLike).map((frame) => [frame.id, frame]));
  const roots = elements.filter((element) => frames.has(element.id) || !element.frameId || !frames.has(element.frameId));
  if (roots.length === 0) return null;
  const [minX, boundsMinY, maxX, maxY] = getCommonBounds(roots);
  let minY = boundsMinY;
  for (const frame of frames.values()) minY = Math.min(minY, frame.y - FRAME_LABEL_RISE);
  const width = maxX - minX + EXPORT_PADDING * 2;
  const height = maxY - minY + EXPORT_PADDING * 2;
  if (!Number.isFinite(width) || Math.abs(width - size.width) > 1 || Math.abs(height - size.height) > 1) return null;
  return { x: minX - EXPORT_PADDING, y: minY - EXPORT_PADDING };
}

/**
 * Draws the scene. `dark` uses Excalidraw's dark rendering (its inverting filter, pictures kept as
 * they are). Resolves null when nothing is left to draw after the library's own repair pass.
 */
export async function drawScene(scene: WhiteboardScene, dark: boolean): Promise<WhiteboardPicture | null> {
  const { exportToSvg, getCommonBounds, restore } = await loadLibrary();
  const restored = restore(
    { elements: scene.elements as unknown as ExcalidrawElement[], appState: null, files: scene.files as unknown as BinaryFiles },
    null,
    null,
  );
  const elements = restored.elements.filter((element) => !element.isDeleted) as NonDeleted<ExcalidrawElement>[];
  if (elements.length === 0) return null;

  const release = guardFontFetches();
  let svg: SVGSVGElement;
  try {
    svg = await exportToSvg({
      elements,
      files: restored.files,
      // Only what the picture needs: the file's own appState is not passed through, so it cannot
      // ask for an embedded copy of the scene, another scale or another padding.
      appState: {
        viewBackgroundColor: scene.background ?? 'transparent',
        exportBackground: scene.background !== null,
        exportWithDarkMode: dark,
        exportScale: 1,
        exportEmbedScene: false,
      },
      exportPadding: EXPORT_PADDING,
      renderEmbeddables: false,
    });
  } finally {
    release();
  }

  const width = Number.parseFloat(svg.getAttribute('width') ?? '');
  const height = Number.parseFloat(svg.getAttribute('height') ?? '');
  if (!(width > 0) || !(height > 0)) return null;
  const markup = new XMLSerializer().serializeToString(svg);
  return {
    svg: new Blob([markup], { type: 'image/svg+xml' }),
    width,
    height,
    origin: pictureOrigin(elements, { width, height }, getCommonBounds),
    paper: scene.background !== null,
  };
}
