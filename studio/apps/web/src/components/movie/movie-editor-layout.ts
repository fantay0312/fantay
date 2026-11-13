import { createContext, useContext } from 'react';
import { movieShotStarts, type MovieDocument, type MovieEditOperation, type MovieShot } from '@open-design/contracts';

/**
 * Ask the inspector to show a tab (and optionally a section or caption cue), e.g. from a timeline
 * transition badge or caption chip. `nonce` makes repeated requests for the same tab observable.
 */
export interface MovieInspectorRequest {
  tab: 'video' | 'captions' | 'audio' | 'animation' | 'adjust' | 'speed' | 'text';
  section?: 'transition';
  cueId?: string;
  nonce: number;
}

/**
 * The editing surface has two layouts over one document, selection and history:
 * - compact: the project pane beside the project chat (AI edits there; people make quick cuts here);
 * - full: the pane is maximized or wide, and every manual editing tool is shown.
 * MovieEditingWorkspace provides the value; the timeline and inspector adapt to it.
 */
export type MovieEditorLayout = 'compact' | 'full';

export const MovieEditorLayoutContext = createContext<MovieEditorLayout>('full');
MovieEditorLayoutContext.displayName = 'MovieEditorLayoutContext';

export function useMovieEditorLayout(): MovieEditorLayout {
  return useContext(MovieEditorLayoutContext);
}

/**
 * Workspace-owned actions that controls created outside the workspace (inspector, timeline) can trigger:
 * the export popover, the Jianying draft dialog, and revealing the inspector (dock focus in full layout,
 * the Adjust popover in compact layout).
 */
export interface MovieEditorActions {
  openExport(): void;
  openJianying(mode: 'create' | 'edit'): void;
  openInspector(): void;
}

const NO_ACTIONS: MovieEditorActions = { openExport() {}, openJianying() {}, openInspector() {} };
export const MovieEditorActionsContext = createContext<MovieEditorActions>(NO_ACTIONS);
MovieEditorActionsContext.displayName = 'MovieEditorActionsContext';

export function useMovieEditorActions(): MovieEditorActions {
  return useContext(MovieEditorActionsContext);
}

/** Clip spans in output seconds, using absolute placement when present. */
export function movieClipSpans(d: MovieDocument): Array<{ shot: MovieShot; index: number; start: number; end: number; track: number }> {
  const starts = movieShotStarts(d);
  return d.shots.map((shot, index) => ({ shot, index, start: starts[index] ?? 0, end: (starts[index] ?? 0) + shot.duration, track: shot.placement?.track ?? 0 }));
}

/**
 * The clip a cut/trim command acts on: the selected clip when there is one, otherwise the clip under the
 * playhead on the highest track (visual clips before detached audio). Locked clips are never returned
 * unless explicitly selected, so callers still check `locked` before editing.
 */
export function movieTargetShot(d: MovieDocument, time: number, selectedId?: string | null): MovieShot | undefined {
  const selected = selectedId ? d.shots.find(s => s.id === selectedId) : undefined;
  if (selected) return selected;
  const under = movieClipSpans(d).filter(span => !span.shot.locked && time > span.start && time < span.end);
  under.sort((a, b) => Number(Boolean(a.shot.clip?.audioOnly)) - Number(Boolean(b.shot.clip?.audioOnly)) || b.track - a.track);
  return under[0]?.shot;
}

/** Output time relative to the start of `shot`, or null when the shot is not on the timeline. */
export function movieLocalTime(d: MovieDocument, shot: MovieShot, time: number): number | null {
  const index = d.shots.findIndex(s => s.id === shot.id);
  if (index < 0) return null;
  return time - (movieShotStarts(d)[index] ?? 0);
}

/** The track 剪映 calls 主轨: track 0. Legacy sequential films (no placements) behave as one main track. */
export const MOVIE_MAIN_TRACK = 0;
/** The shared edit API accepts at most this many operations per request (one request = one undo step). */
export const MOVIE_MAX_EDIT_OPERATIONS = 100;

export type MovieCutKind = 'split' | 'trim-before' | 'trim-after' | 'delete' | 'ripple-delete';

export interface MovieCutOptions {
  /** 主轨磁吸: cuts on the main track close the gap they leave. */
  magnet: boolean;
  newShotId?: string;
}

export function movieIsSequential(d: MovieDocument): boolean {
  return !d.shots.some(s => s.placement);
}

/**
 * Clips of the same lane kind (picture or detached audio) on `track` that start at or after `from`, excluding
 * `exceptId`, in ascending start order. Returns null when one of them is locked: shifting a locked clip would make the
 * shared edit API reject the batch.
 */
function followers(d: MovieDocument, track: number, from: number, exceptId: string, audioOnly: boolean) {
  const spans = movieClipSpans(d).filter(span => span.shot.id !== exceptId && Boolean(span.shot.clip?.audioOnly) === audioOnly && span.track === track && span.start >= from - 1e-6);
  if (spans.some(span => span.shot.locked)) return null;
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * One undoable batch for a cut command, shared by the toolbar, context menu and keyboard.
 * - split: `split-clip` at `local` seconds.
 * - trim-before (Q) keeps [local, end]; trim-after (W) keeps [0, local].
 * - delete removes the clip; ripple-delete also closes the gap in its lane.
 * With 主轨磁吸 on, trims and deletes on the main track close the gap (later picture clips there move left).
 * Gaps are closed with explicit moves of same-kind clips, so detached audio sharing a track number keeps its timing.
 * Falls back to the plain edit when a follower is locked or the batch would exceed the edit API's operation limit.
 * Sequential legacy films already close gaps by construction.
 */
export function movieCutOperations(d: MovieDocument, target: MovieShot, local: number, kind: MovieCutKind, options: MovieCutOptions): MovieEditOperation[] {
  if (kind === 'split') return [{ op: 'split-clip', shotId: target.id, at: local, ...(options.newShotId ? { newShotId: options.newShotId } : {}) }];
  const span = movieClipSpans(d).find(item => item.shot.id === target.id);
  const audioOnly = Boolean(target.clip?.audioOnly);
  const onMain = !audioOnly && (span?.track ?? MOVIE_MAIN_TRACK) === MOVIE_MAIN_TRACK;
  const ripple = (kind === 'ripple-delete' || (options.magnet && onMain)) && Boolean(span) && !movieIsSequential(d);
  const removing = kind === 'delete' || kind === 'ripple-delete';
  const base: MovieEditOperation = removing ? { op: 'remove-shot', shotId: target.id }
    : kind === 'trim-before' ? { op: 'trim-clip', shotId: target.id, start: local, end: target.duration }
    : { op: 'trim-clip', shotId: target.id, start: 0, end: local };
  if (!ripple || !span) return [base];
  const later = followers(d, span.track, span.end, target.id, audioOnly);
  if (!later) return [base];
  const removed = removing ? target.duration : kind === 'trim-before' ? local : target.duration - local;
  const ops: MovieEditOperation[] = [base];
  if (kind === 'trim-before') ops.push({ op: 'move-clip', shotId: target.id, at: span.start, track: span.track });
  for (const item of later) ops.push({ op: 'move-clip', shotId: item.shot.id, at: Math.max(0, item.start - removed), track: item.track });
  return ops.length > MOVIE_MAX_EDIT_OPERATIONS ? [base] : ops;
}

/** Where ⌘D/Duplicate puts a copy: right after the original when that stretch of its track is free, else the film end. */
export function movieDuplicatePlacement(d: MovieDocument, shot: MovieShot): { at: number; track: number } {
  const spans = movieClipSpans(d);
  const own = spans.find(span => span.shot.id === shot.id);
  const track = own?.track ?? MOVIE_MAIN_TRACK;
  const filmEnd = Math.max(0, ...spans.map(span => span.end));
  if (!own) return { at: filmEnd, track };
  const from = own.end, to = own.end + shot.duration;
  const blocked = spans.some(span => span.shot.id !== shot.id && span.track === track && span.start < to - 1e-6 && span.end > from + 1e-6);
  return { at: blocked ? filmEnd : from, track };
}

/**
 * Lock or unlock clips in one batch. In a sequential film (no placements) the shared edit API gives every clip a
 * placement on the first timeline move; a locked clip without one would then count as changed and block that move.
 * Locking therefore pins every clip at its current position in the same batch, before the lock applies.
 */
export function movieLockOperations(d: MovieDocument, shots: readonly MovieShot[], locked: boolean): MovieEditOperation[] {
  const ops: MovieEditOperation[] = shots.filter(s => Boolean(s.locked) !== locked).map(s => ({ op: 'lock-clip', shotId: s.id, locked }));
  if (!ops.length || !locked || !movieIsSequential(d)) return ops;
  const pin = movieClipSpans(d).find(span => !span.shot.locked);
  return pin ? [{ op: 'move-clip', shotId: pin.shot.id, at: pin.start, track: MOVIE_MAIN_TRACK }, ...ops] : ops;
}

/** Previous/next cut point (clip edges on any track, plus 0) relative to `time`. */
export function movieEditPoint(d: MovieDocument, time: number, direction: -1 | 1): number | null {
  const points = [...new Set([0, ...movieClipSpans(d).flatMap(span => [span.start, span.end])].map(t => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b);
  const found = direction > 0 ? points.find(t => t > time + 1e-4) : [...points].reverse().find(t => t < time - 1e-4);
  return found ?? null;
}
