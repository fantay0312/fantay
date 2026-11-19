// SPDX-License-Identifier: AGPL-3.0-only
// What one assistant turn did to the project's files, read from the turn's own tool calls: the
// activity engine's evidence, and the content of the 代码 surface's changes view. Nothing here reads
// the disk; a change is only as complete as the tool input the runtime sent. Pure; no React, no DOM.
//
// Adapted from cindy apps/desktop/src/renderer/features/right-sidebar/lib/lastTurnChangedFiles.ts
// @ 88941ba7 (Apache-2.0): the path normalisation (`slashPath`, `isAbsoluteLikePath`,
// `absoluteToWorkdirRelative`).
import { decideAutoOpenAfterWrite } from '../../../components/auto-open-file';
import { countChangedLines } from './line-diff';
import type { TurnFileChange, TurnFileHunk } from './surface-types';
import { fileToolShape, type FileToolShape } from './tool-shape';

export interface TurnChangeOptions {
  /** Absolute project directory, when known; absolute tool paths under it become project-relative. */
  resolvedDir?: string | null;
  /** Project-relative names of the files that exist now. */
  fileNames: readonly string[];
  /** Project-relative names that existed before the turn, when known; lets a whole-file write be classified created vs modified. */
  preTurnFileNames?: ReadonlySet<string> | null;
}

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function slashPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

const WINDOWS_DRIVE_PATH = /^[a-zA-Z]:\//;

/** After `slashPath`: POSIX absolute, a collapsed UNC share, or a Windows drive path. */
function isAbsoluteLikePath(path: string): boolean {
  return path.startsWith('/') || WINDOWS_DRIVE_PATH.test(path);
}

/** Windows file systems ignore case, so a drive path is compared folded; POSIX paths compare exactly. */
function comparisonKey(path: string): string {
  return WINDOWS_DRIVE_PATH.test(path) ? path.toLowerCase() : path;
}

/** `file` relative to `root` when it lies inside it, else null. Both already slash-normalised. */
function absoluteToWorkdirRelative(file: string, root: string): string | null {
  if (!comparisonKey(file).startsWith(`${comparisonKey(root)}/`)) return null;
  // Sliced from the original so the file's own casing survives the folded comparison.
  return file.slice(root.length + 1) || null;
}

/**
 * Maps a tool call's path to a project-relative name, or null when the call touched something
 * outside the project. One resolver serves a whole conversation, so the file list is wrapped once
 * and every distinct path is matched once.
 */
function createPathResolver(options: TurnChangeOptions): (rawPath: string, deleted: boolean) => string | null {
  const root = options.resolvedDir ? slashPath(options.resolvedDir.trim()).replace(/\/$/, '') : '';
  let candidates: Array<{ name: string }> | null = null;
  let listed: Set<string> | null = null;
  const matched = new Map<string, string | null>();

  // Exact name, a unique segment-aligned suffix, or a unique basename: the same rule that decides
  // which file a finished write opens, so the two cannot name different files for one path.
  const matchFileName = (path: string): string | null => {
    const known = matched.get(path);
    if (known !== undefined) return known;
    listed ??= new Set(options.fileNames);
    candidates ??= options.fileNames.map((name) => ({ name }));
    // A listed name is that file, settled before the shared rule runs: on its own that rule calls
    // `pages/index.html` ambiguous beside a root `index.html` (the root name is a suffix of the
    // path too) and the nested file's changes would be dropped.
    const fileName = listed.has(path) ? path : decideAutoOpenAfterWrite(path, candidates).fileName;
    matched.set(path, fileName);
    return fileName;
  };

  return (rawPath, deleted) => {
    const path = slashPath(rawPath.trim()).replace(/^(?:\.\/)+/, '');
    if (!path || path === '.') return null;
    // Placing a `..` path needs the agent's working directory, which a tool input does not carry.
    if (path.split('/').includes('..')) return null;
    if (isAbsoluteLikePath(path)) {
      // Lying under the project directory is proof on its own; the file list may not have caught up
      // with a file written a moment ago.
      const relative = root ? absoluteToWorkdirRelative(path, root) : null;
      return relative ?? matchFileName(path);
    }
    // A deleted file is in no file list any more, so its own relative path has to stand.
    return matchFileName(path) ?? (deleted ? path : null);
  };
}

/** How one call touched one file. `add` is the runtime saying it created the file; a `write` only says it wrote all of it. */
type TouchKind = 'write' | 'add' | 'edit' | 'delete';

interface FileTouch {
  path: string;
  kind: TouchKind;
  hunks: readonly TurnFileHunk[];
}

function touchesOf(shape: FileToolShape): FileTouch[] {
  if (shape.kind === 'write') {
    return [{ path: shape.path, kind: 'write', hunks: [{ before: null, after: shape.content }] }];
  }
  if (shape.kind === 'edit') return [{ path: shape.path, kind: 'edit', hunks: shape.edits }];
  return shape.files.map((file) => ({
    path: file.path,
    kind: file.status === 'created' ? 'add' : file.status === 'deleted' ? 'delete' : 'edit',
    hunks: file.hunks,
  }));
}

interface LineCounts {
  added: number;
  removed: number;
}

const isLineCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Line counts the daemon made from the original input (`od_diff_stat`). It sends them when the text
 * itself did not travel: a Codex patch is counted and dropped, and an oversized Write or Edit is
 * shortened. Whatever text is left in the input would then count wrong, so these win.
 */
function carriedLineCounts(input: unknown): LineCounts | null {
  const carried = isRecord(input) ? input.od_diff_stat : null;
  if (!isRecord(carried) || !isLineCount(carried.added) || !isLineCount(carried.removed)) return null;
  return { added: carried.added, removed: carried.removed };
}

function countHunks(hunks: readonly TurnFileHunk[]): LineCounts {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    const counts = countChangedLines(hunk.before, hunk.after);
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed };
}

interface FileEntry {
  path: string;
  first: TouchKind;
  last: TouchKind;
  hunks: TurnFileHunk[];
  added: number;
  removed: number;
}

function statusOf(entry: FileEntry, preTurnFileNames: ReadonlySet<string> | null | undefined): TurnFileChange['status'] {
  if (entry.last === 'delete') return 'deleted';
  const existedBefore = preTurnFileNames ? preTurnFileNames.has(entry.path) : null;
  // The runtime said it added the file; only a snapshot that already holds it says otherwise.
  if (entry.first === 'add') return existedBefore === true ? 'modified' : 'created';
  // A whole-file write also overwrites, so it needs the snapshot to prove the file is new.
  if (entry.first === 'write') return existedBefore === false ? 'created' : 'modified';
  return 'modified';
}

/** Ids of the calls whose result came back as an error. The last result for an id wins. */
function failedToolUseIds(events: readonly unknown[]): Set<string> {
  const failed = new Set<string>();
  for (const event of events) {
    if (!isRecord(event) || event.kind !== 'tool_result') continue;
    // `tool_use_id` is how some older stored events spell it.
    const id = typeof event.toolUseId === 'string' ? event.toolUseId : event.tool_use_id;
    if (typeof id !== 'string' || !id) continue;
    if (event.isError === true) failed.add(id);
    else failed.delete(id);
  }
  return failed;
}

function collectWith(
  events: readonly unknown[],
  resolvePath: (rawPath: string, deleted: boolean) => string | null,
  preTurnFileNames: ReadonlySet<string> | null | undefined,
): TurnFileChange[] {
  const failed = failedToolUseIds(events);
  const counted = new Set<string>();
  // A Map keeps insertion order, which is the order files were first touched in.
  const entries = new Map<string, FileEntry>();

  for (const event of events) {
    if (!isRecord(event) || event.kind !== 'tool_use') continue;
    const id = typeof event.id === 'string' ? event.id : '';
    // A failed call changed nothing. A call with no result yet still counts: the turn may be streaming.
    if (id && failed.has(id)) continue;
    const shape = fileToolShape(event.name, event.input);
    if (!shape) continue;
    // A replayed stream delivers the same call twice; it happened once.
    if (id) {
      if (counted.has(id)) continue;
      counted.add(id);
    }

    const touches = touchesOf(shape);
    const carried = touches.length === 1 ? carriedLineCounts(event.input) : null;
    for (const touch of touches) {
      const path = resolvePath(touch.path, touch.kind === 'delete');
      if (!path) continue;
      const counts = carried ?? countHunks(touch.hunks);
      const entry = entries.get(path);
      if (!entry) {
        entries.set(path, { path, first: touch.kind, last: touch.kind, hunks: [...touch.hunks], ...counts });
        continue;
      }
      entry.last = touch.kind;
      for (const hunk of touch.hunks) entry.hunks.push(hunk);
      entry.added += counts.added;
      entry.removed += counts.removed;
    }
  }

  return Array.from(entries.values(), (entry) => ({
    path: entry.path,
    status: statusOf(entry, preTurnFileNames),
    hunks: entry.hunks,
    added: entry.added,
    removed: entry.removed,
  }));
}

/**
 * The files one turn's tool calls changed, first-touched first, every call on a file merged in call
 * order. Calls whose result is an error and paths outside the project are left out.
 */
export function collectTurnFileChanges(events: readonly unknown[], options: TurnChangeOptions): TurnFileChange[] {
  return collectWith(events, createPathResolver(options), options.preTurnFileNames);
}

/**
 * The changes of the most recent assistant message that has any, else []. `preTurnFileNames`
 * describes the current turn; for an older message it can only make a created file read as modified.
 */
export function latestTurnFileChanges(
  messages: readonly { role: string; events?: readonly unknown[] | null }[],
  options: TurnChangeOptions,
): TurnFileChange[] {
  const resolvePath = createPathResolver(options);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant' || !message.events?.length) continue;
    const changes = collectWith(message.events, resolvePath, options.preTurnFileNames);
    if (changes.length > 0) return changes;
  }
  return [];
}
