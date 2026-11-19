// SPDX-License-Identifier: AGPL-3.0-only
// What a reader left on a grid, and the rows they were looking at, kept per file outside React.
// The viewer is unmounted when another tab comes forward and when the agent rewrites the file; the
// worker that held the data goes with it. This keeps the last picture: the facts about the file,
// each sheet's selection, column widths and scroll position, and the few windows of rows that were
// on screen. A remount paints from it at once and stays where the reader was while the file is read
// again. One entry in the view-state store per file, whatever the number of sheets.
import { readArtifactViewState, writeArtifactViewState } from '../../use-view-state';
import type { DataGridRow, GridSelection } from './grid-model';

/** Rows per window. */
export const ROW_WINDOW = 200;
/** Windows kept for the sheet on screen. */
const MAX_WINDOWS = 24;
/** Windows kept for a sheet that is not on screen. */
const IDLE_WINDOWS = 3;

interface StoredWindow {
  /** The data the rows were read from; another key means "from an older version of the file". */
  key: string;
  rows: readonly DataGridRow[];
}

export interface RowWindowCache {
  windows: Map<number, StoredWindow>;
}

export interface GridViewState {
  selection: GridSelection | null;
  /** Widths the reader dragged, by column. */
  widths: Record<number, number>;
  scrollTop: number;
  scrollLeft: number;
}

export interface GridSession {
  view: GridViewState;
  cache: RowWindowCache;
}

export interface FileGridSession<Model> {
  /** The file's facts as last read, and the version they were read from. */
  snapshot: { mtime: number; model: Model } | null;
  grids: Map<string, GridSession>;
}

const SLOT = 'grid-session';

/** The file's session, created on first use. */
export function fileGridSession<Model>(projectId: string, fileName: string): FileGridSession<Model> {
  const stored = readArtifactViewState<FileGridSession<Model>>(projectId, fileName, SLOT);
  if (stored) return stored;
  const session: FileGridSession<Model> = { snapshot: null, grids: new Map() };
  writeArtifactViewState(projectId, fileName, SLOT, session);
  return session;
}

/** One sheet's (or table's) state inside a file's session. */
export function gridSession<Model>(session: FileGridSession<Model>, id: string): GridSession {
  let grid = session.grids.get(id);
  if (!grid) {
    grid = { view: { selection: null, widths: {}, scrollTop: 0, scrollLeft: 0 }, cache: { windows: new Map() } };
    session.grids.set(id, grid);
  }
  return grid;
}

/** Stores a window as the most recent one and drops the oldest past the limit. */
export function storeWindow(cache: RowWindowCache, index: number, key: string, rows: readonly DataGridRow[]): void {
  cache.windows.delete(index);
  cache.windows.set(index, { key, rows });
  while (cache.windows.size > MAX_WINDOWS) {
    const oldest = cache.windows.keys().next().value;
    if (oldest === undefined) break;
    cache.windows.delete(oldest);
  }
}

/** Keeps only the latest windows of every sheet but the one on screen. */
export function trimIdleGrids<Model>(session: FileGridSession<Model>, activeId: string): void {
  for (const [id, grid] of session.grids) {
    if (id === activeId) continue;
    while (grid.cache.windows.size > IDLE_WINDOWS) {
      const oldest = grid.cache.windows.keys().next().value;
      if (oldest === undefined) break;
      grid.cache.windows.delete(oldest);
    }
  }
}
