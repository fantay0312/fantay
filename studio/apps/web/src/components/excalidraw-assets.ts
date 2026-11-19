// Excalidraw takes its fonts from `window.EXCALIDRAW_ASSET_PATH` and, failing that, from a public
// CDN. The app ships those fonts (`public/artifact/excalidraw/fonts/`, a byte-identical copy of the
// package's own), so every module that imports the library imports this one first: the library
// keeps the addresses from the moment it first builds its font registry, and by then the path has
// to point at the local copy. The drawing viewer can render its fonts offline.

/** Where `public/artifact/excalidraw/` is served; the library appends `fonts/<Family>/<file>`. */
export const EXCALIDRAW_LOCAL_ASSET_PATH = '/artifact/excalidraw/';

if (typeof window !== 'undefined') {
  const host = window as Window & { EXCALIDRAW_ASSET_PATH?: string | string[] };
  if (host.EXCALIDRAW_ASSET_PATH === undefined) {
    host.EXCALIDRAW_ASSET_PATH = new URL(EXCALIDRAW_LOCAL_ASSET_PATH, window.location.href).href;
  }
}
