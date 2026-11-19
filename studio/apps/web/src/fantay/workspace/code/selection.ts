// SPDX-License-Identifier: AGPL-3.0-only
// Which file the 代码 surface shows, in which view, and which folders are open. One state object and
// pure transitions, so the surface can settle it while rendering (no frame with a stale selection)
// and the rules can be tested without a DOM.
import type { ProjectFile } from '../../../types';
import type { CodeSurfaceRequest } from '../surfaces/code-surface-store';
import type { CodeSurfaceView, TurnFileChange } from '../surfaces/surface-types';
import { ancestorPaths, EXPAND_ALL_LIMIT } from './file-tree';
import { classifyProjectFile } from './text-preview';

export interface SurfaceState {
  /** Name of the file being read; null when nothing is shown. */
  selected: string | null;
  /** True while the surface chose the file itself: it then keeps following the turn's first change. */
  auto: boolean;
  view: CodeSurfaceView;
  /** Row paths of the open folders. */
  expanded: ReadonlySet<string>;
  /** Asks the tree to bring a row into view; `tick` makes a repeated ask for the same row count. */
  reveal: { path: string; tick: number } | null;
  /** Nonce of the last request carried out. */
  handledNonce: number | null;
  /** A requested file that is not in the list yet (the agent may still be writing it). */
  awaited: string | null;
  /** The view that request asked for, applied again when the awaited file arrives. */
  awaitedView: CodeSurfaceView | null;
  /** The inputs last reconciled against, compared by identity. */
  seenDirPaths: readonly string[] | null;
  seenTurnChanges: readonly TurnFileChange[] | null;
}

export interface SurfaceInputs {
  fileCount: number;
  fileByName: ReadonlyMap<string, ProjectFile>;
  /** Every folder row path of the current tree (stable identity per file list). */
  dirPaths: readonly string[];
  turnChanges: readonly TurnFileChange[];
  /** First file the turn changed that still exists, or null. */
  firstChange: string | null;
  /** The most recently modified file that reads as text, or null. */
  latestText: string | null;
  request: CodeSurfaceRequest | null;
}

export const INITIAL_SURFACE_STATE: SurfaceState = {
  selected: null,
  auto: true,
  view: 'source',
  expanded: new Set<string>(),
  reveal: null,
  handledNonce: null,
  awaited: null,
  awaitedView: null,
  seenDirPaths: null,
  seenTurnChanges: null,
};

/** First changed file that can be opened: deleted files and ones not listed yet are skipped. */
export function firstSelectableChange(
  turnChanges: readonly TurnFileChange[],
  fileByName: ReadonlyMap<string, ProjectFile>,
): string | null {
  for (const change of turnChanges) {
    if (change.status !== 'deleted' && fileByName.has(change.path)) return change.path;
  }
  return null;
}

/** The most recently modified file that reads as text. */
export function latestTextFile(files: readonly ProjectFile[]): string | null {
  let best: ProjectFile | null = null;
  for (const file of files) {
    if (file.type === 'dir' || classifyProjectFile(file) !== 'text') continue;
    if (best === null || file.mtime > best.mtime) best = file;
  }
  return best?.name ?? null;
}

function withAncestors(expanded: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const missing = ancestorPaths(path).filter((ancestor) => !expanded.has(ancestor));
  return missing.length === 0 ? expanded : new Set([...expanded, ...missing]);
}

function show(
  state: SurfaceState,
  name: string,
  options: { auto: boolean; view?: CodeSurfaceView },
): SurfaceState {
  return {
    ...state,
    selected: name,
    auto: options.auto,
    view: options.view ?? state.view,
    expanded: withAncestors(state.expanded, name),
    reveal: { path: name, tick: (state.reveal?.tick ?? 0) + 1 },
  };
}

/**
 * Brings the state in line with the current files, turn changes and request. Returns the same object
 * when nothing changes, so a caller can run it on every render and store the result only when it
 * differs.
 */
export function reconcileSurfaceState(state: SurfaceState, inputs: SurfaceInputs): SurfaceState {
  let next = state;

  // A new request: the view applies at once, the file as soon as it exists.
  const request = inputs.request;
  if (request && request.nonce !== next.handledNonce) {
    next = {
      ...next,
      handledNonce: request.nonce,
      awaited: request.file,
      awaitedView: request.file === null ? null : request.view,
      view: request.view ?? next.view,
    };
  }
  if (next.awaited !== null && inputs.fileByName.has(next.awaited)) {
    // The requested view goes with the file: while it was awaited, the fallback below may have
    // switched the view for the file it showed in the meantime.
    next = {
      ...show(next, next.awaited, { auto: false, view: next.awaitedView ?? next.view }),
      awaited: null,
      awaitedView: null,
    };
  }

  // Folders that just appeared open by themselves in a small project; a folder the person closed
  // was seen before and stays closed.
  if (next.seenDirPaths !== inputs.dirPaths) {
    let expanded = next.expanded;
    if (inputs.fileCount <= EXPAND_ALL_LIMIT) {
      const known = new Set(next.seenDirPaths ?? []);
      const fresh = inputs.dirPaths.filter((path) => !known.has(path));
      if (fresh.length > 0) expanded = new Set([...expanded, ...fresh]);
    }
    next = { ...next, expanded, seenDirPaths: inputs.dirPaths };
  }

  // While the surface is choosing by itself it follows the turn: the first changed file, as changes.
  if (next.seenTurnChanges !== inputs.turnChanges) {
    if (next.auto && inputs.firstChange !== null && inputs.firstChange !== next.selected) {
      next = show(next, inputs.firstChange, { auto: true, view: 'changes' });
    }
    next = { ...next, seenTurnChanges: inputs.turnChanges };
  }

  // Nothing selected, or the selected file is gone: fall back.
  if (next.selected === null || !inputs.fileByName.has(next.selected)) {
    if (inputs.firstChange !== null) {
      next = show(next, inputs.firstChange, { auto: true, view: 'changes' });
    } else if (inputs.latestText !== null) {
      next = show(next, inputs.latestText, { auto: true });
    } else if (next.selected !== null) {
      next = { ...next, selected: null, auto: true };
    }
  }

  return next;
}

/**
 * The person picked a file. From the tree the row is already in view, so nothing is revealed.
 * `expand` opens the file's folders without asking the tree to scroll: a pick in the changed list
 * must not move that list out from under the pointer. `reveal` opens them and scrolls to the row.
 */
export function selectFile(
  state: SurfaceState,
  name: string,
  options: { reveal: boolean; expand?: boolean; view?: CodeSurfaceView },
): SurfaceState {
  const base: SurfaceState = {
    ...state,
    selected: name,
    auto: false,
    awaited: null,
    awaitedView: null,
    view: options.view ?? state.view,
  };
  if (!options.reveal && !options.expand) return base;
  const expanded = withAncestors(state.expanded, name);
  if (!options.reveal) return { ...base, expanded };
  return { ...base, expanded, reveal: { path: name, tick: (state.reveal?.tick ?? 0) + 1 } };
}

export function setView(state: SurfaceState, view: CodeSurfaceView): SurfaceState {
  return state.view === view ? state : { ...state, view };
}

/** Opens or closes one folder row; `open` omitted toggles. */
export function toggleDir(state: SurfaceState, rowPath: string, open?: boolean): SurfaceState {
  const isOpen = state.expanded.has(rowPath);
  const want = open ?? !isOpen;
  if (want === isOpen) return state;
  const expanded = new Set(state.expanded);
  if (want) expanded.add(rowPath);
  else expanded.delete(rowPath);
  return { ...state, expanded };
}

/** Opens a folder row and everything above it, and asks the tree to show it. */
export function revealDir(state: SurfaceState, rowPath: string): SurfaceState {
  const expanded = new Set([...withAncestors(state.expanded, rowPath), rowPath]);
  return { ...state, expanded, reveal: { path: rowPath, tick: (state.reveal?.tick ?? 0) + 1 } };
}
