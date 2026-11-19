// SPDX-License-Identifier: AGPL-3.0-only
// What a file-writing tool call did to which file, read from the shape of its input rather than from
// its name alone: Claude Code's `Edit`, pi's `edit`, Gemini's `replace` and the workspace guard's
// `fantay_workspace_edit` are one thing to a reader, and a runtime that names its tools differently
// still says `file_path` and `old_string`. The name only decides the cases the shape cannot (a
// path-only input, a delete). Pure; no React, no DOM.
//
// Adapted from eta apps/web/src/lib/tool-shape.ts @ 793ded7c (MIT): the shape-first reading, the
// edit-pair reader and the Codex fileChange reader.
// Adapted from cindy apps/desktop/src/renderer/features/right-sidebar/lib/lastTurnChangedFiles.ts
// @ 88941ba7 (Apache-2.0): the path fields across runtimes and the fileChange move_path fields.
// Adapted from cindy packages/model-compat/src/upstream/responses/apply-patch-envelope.ts @ 88941ba7,
// which cindy vendors unchanged from opencodex src/responses/apply-patch-envelope.ts @ c155cc79 (MIT):
// the patch operation-line pattern and the `{ input: string }` freeform wrapper.
import { parsePatch } from 'diff';

import { isCommandTool, toolKind } from '../../../runtime/chat/tool-kind';
import { isFileWriteOrEditToolName } from '../../../runtime/file-ops';
import { IN_FLIGHT_TOOL_INPUT_MARKER } from '../../../runtime/tool-events';

export type FileToolShape =
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; edits: Array<{ before: string; after: string }> }
  | {
      kind: 'patch';
      files: Array<{
        path: string;
        status: 'created' | 'modified' | 'deleted';
        hunks: Array<{ before: string | null; after: string }>;
      }>;
    };

type PatchFile = Extract<FileToolShape, { kind: 'patch' }>['files'][number];
type FileHunk = PatchFile['hunks'][number];
type FileEdit = Extract<FileToolShape, { kind: 'edit' }>['edits'][number];
type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function firstString(fields: Fields, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Lines as text, each ended by its newline. Joining with `\n` instead would lose a blank last line
 * (`['a', '']` and `['a']` both end up as one line once counted), and a patch that only adds one.
 */
const linesText = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join('');

/** Same fields, same order as `extractPath` in runtime/file-ops.ts, plus NotebookEdit's. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'filename', 'target_path', 'targetPath'];

/** The first path field that names something: an empty `file_path` beside a real `path` is passed over. */
function firstPath(fields: Fields): string | undefined {
  for (const key of PATH_KEYS) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** claude `old_string`, opencode `oldString`, pi `oldText`, the Anthropic text editor's `old_str`. */
const OLD_KEYS = ['old_string', 'oldString', 'oldText', 'old_str'];
const NEW_KEYS = ['new_string', 'newString', 'newText', 'new_str'];
const CONTENT_KEYS = ['content', 'contents', 'file_text'];
const PATCH_TEXT_KEYS = ['patch', 'patchText', 'patch_text', 'input', 'diff'];

/** One file section of a Codex patch. Its presence is what makes a text a patch. */
const PATCH_OPERATION_LINE = /^\*\*\* (?:Add|Update|Delete) File: .+$/m;
const PATCH_FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_HEADER = /^\*\*\* Move to: (.+)$/;

/** The tool's own name: lowercase, without an `mcp__<server>__` prefix. */
function bareToolName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const lower = name.trim().toLowerCase();
  return lower.startsWith('mcp__') ? (lower.split('__').pop() ?? lower) : lower;
}

/** The file change a tool call describes, or null when the call does not write a file. */
export function fileToolShape(name: unknown, input: unknown): FileToolShape | null {
  if (typeof input === 'string') return shapeOfText(name, input);
  if (!isRecord(input)) return null;
  // The early form of a call whose input is still streaming says what the model intends to write,
  // not what it wrote; the settled call arrives under the same id.
  if (input[IN_FLIGHT_TOOL_INPUT_MARKER] === true) return null;

  const tool = bareToolName(name);
  // A shell tool writes files in ways no input field names; the one readable case is `apply_patch`.
  if (isCommandTool(tool)) return patchShape(commandPatchText(input));

  const path = firstPath(input);
  if (path) {
    // Claude Code's Edit and MultiEdit, opencode's and pi's edit, Gemini's replace.
    const edits = editPairs(input);
    if (edits.length > 0) return { kind: 'edit', path, edits };
    // NotebookEdit names no old text: the cell's new source is all it carries.
    const cellSource = str(input.new_source);
    if (cellSource !== undefined && str(input.notebook_path) !== undefined) {
      return { kind: 'edit', path, edits: [{ before: '', after: cellSource }] };
    }
    const content = firstString(input, CONTENT_KEYS);
    if (content !== undefined) {
      // A base64 body (the MCP write_file tool allows one) changed the file but is not text to diff.
      if (input.encoding === 'base64') return { kind: 'patch', files: [{ path, status: 'modified', hunks: [] }] };
      return { kind: 'write', path, content };
    }
  }

  // Codex's apply_patch, called as a function (`{ input }`, `{ patch }`), by opencode (`patchText`)
  // or through its shell form.
  const patch = patchShape(firstPatchText(input) ?? commandPatchText(input));
  if (patch) return patch;
  // Codex's fileChange item: the changes themselves, as a list or as JSON text.
  const changes = codexChangeFiles(input);
  if (changes.length > 0) return { kind: 'patch', files: changes };

  if (path) {
    const kind = toolKind(tool, input);
    if (kind === 'delete') return { kind: 'patch', files: [{ path, status: 'deleted', hunks: [] }] };
    // A write or edit that carries only its path: this daemon reports a Codex or Cursor file change
    // that way (`Write` for add, `Edit` for update, the patch already counted into `od_diff_stat`),
    // and an oversized input is summarised down to the same shape. The name is the only evidence left.
    if (isFileWriteOrEditToolName(tool)) {
      return { kind: 'patch', files: [{ path, status: kind === 'write' ? 'created' : 'modified', hunks: [] }] };
    }
  }
  return null;
}

/** A call whose whole input is text: a freeform apply_patch body, or its arguments still as JSON. */
function shapeOfText(name: unknown, text: string): FileToolShape | null {
  if (text.trimStart().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) return fileToolShape(name, parsed);
    } catch {
      // Not JSON: read it as the freeform body below.
    }
  }
  return patchShape(text);
}

function editPairs(input: Fields): FileEdit[] {
  const one = (entry: unknown): FileEdit[] => {
    if (!isRecord(entry)) return [];
    const before = firstString(entry, OLD_KEYS);
    // An entry without old text is not a replacement (same rule as `diffStat` in runtime/chat/format.ts).
    if (before === undefined) return [];
    return [{ before, after: firstString(entry, NEW_KEYS) ?? '' }];
  };
  // MultiEdit and pi put several replacements in `edits`; everyone else has one pair at the top.
  const listed = Array.isArray(input.edits) ? input.edits.flatMap(one) : [];
  return listed.length > 0 ? listed : one(input);
}

function firstPatchText(input: Fields): string | undefined {
  for (const key of PATCH_TEXT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && PATCH_OPERATION_LINE.test(value)) return value;
  }
  return undefined;
}

/** `["apply_patch", "<patch>"]`, or `apply_patch <<'EOF' … EOF` inside a shell string. */
function commandPatchText(input: Fields): string | undefined {
  const command = input.command ?? input.cmd;
  const text = Array.isArray(command)
    ? command.filter((part): part is string => typeof part === 'string').join('\n')
    : str(command);
  if (text === undefined || !/\bapply_patch\b/.test(text)) return undefined;
  return PATCH_OPERATION_LINE.test(text) ? text : undefined;
}

function patchShape(text: string | undefined): FileToolShape | null {
  if (text === undefined || !PATCH_OPERATION_LINE.test(text)) return null;
  const files = parseApplyPatch(text);
  return files.length > 0 ? { kind: 'patch', files } : null;
}

/** Collects the `-`/`+`/space lines of a patch body into one before/after pair per `@@` chunk. */
class ChunkReader {
  readonly hunks: FileHunk[] = [];
  private before: string[] = [];
  private after: string[] = [];
  private changed = false;

  /** Feed one body line; lines that are not patch content are ignored. */
  line(line: string): void {
    if (line.startsWith('@@')) {
      this.close();
    } else if (line.startsWith('+')) {
      this.after.push(line.slice(1));
      this.changed = true;
    } else if (line.startsWith('-')) {
      this.before.push(line.slice(1));
      this.changed = true;
    } else if (line.startsWith(' ') || line === '') {
      // Models often drop the leading space of a blank context line.
      const text = line.slice(1);
      this.before.push(text);
      this.after.push(text);
    }
  }

  close(): void {
    if (this.changed) this.hunks.push({ before: linesText(this.before), after: linesText(this.after) });
    this.before = [];
    this.after = [];
    this.changed = false;
  }
}

/**
 * Codex's patch format: `*** Add File:` / `*** Update File:` / `*** Delete File:` sections, an update
 * made of `@@` chunks of `-`/`+`/space lines, an optional `*** Move to:`. Text around the envelope
 * (a shell heredoc's first and last line) is skipped. Neither reference project nor jsdiff parses
 * this format: its `@@` headers carry no line numbers, so it is not a unified diff.
 */
function parseApplyPatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let section: { path: string; operation: string; moveTo?: string; added: string[]; chunks: ChunkReader } | null = null;

  const closeSection = () => {
    if (!section) return;
    const { path, operation, moveTo, added, chunks } = section;
    section = null;
    if (operation === 'Add') {
      files.push({ path, status: 'created', hunks: [{ before: null, after: linesText(added) }] });
    } else if (operation === 'Delete') {
      files.push({ path, status: 'deleted', hunks: [] });
    } else {
      chunks.close();
      files.push(...movedOrModified(path, moveTo, chunks.hunks));
    }
  };

  const lines = text.split('\n');
  // A final newline ends the last line; it is not a blank context line.
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = PATCH_FILE_HEADER.exec(line);
    if (header) {
      closeSection();
      const path = (header[2] ?? '').trim();
      if (path) section = { path, operation: header[1] ?? '', added: [], chunks: new ChunkReader() };
      continue;
    }
    if (!section) continue;
    if (line.startsWith('*** End Patch')) {
      closeSection();
    } else if (line.startsWith('*** ')) {
      const move = PATCH_MOVE_HEADER.exec(line);
      if (move && section.operation === 'Update') section.moveTo = (move[1] ?? '').trim();
      // `*** End of File` and any other marker carry no content.
    } else if (section.operation === 'Add') {
      if (line.startsWith('+')) section.added.push(line.slice(1));
    } else if (section.operation === 'Update') {
      section.chunks.line(line);
    }
  }
  closeSection();
  return files;
}

/** A rename is the old path going away and the new one appearing with the update's edits. */
function movedOrModified(path: string, moveTo: string | undefined, hunks: FileHunk[]): PatchFile[] {
  if (!moveTo || moveTo === path) return [{ path, status: 'modified', hunks }];
  return [
    { path, status: 'deleted', hunks: [] },
    { path: moveTo, status: 'created', hunks },
  ];
}

/** The before/after pairs of a unified diff (`@@ -2,3 +2,4 @@` headers), as Codex's fileChange sends. */
function unifiedDiffHunks(diff: string): FileHunk[] {
  try {
    const strict = new ChunkReader();
    for (const file of parsePatch(diff)) {
      for (const hunk of file.hunks) {
        // `\ No newline at end of file` says nothing about the lines themselves.
        for (const line of hunk.lines) if (!line.startsWith('\\')) strict.line(line);
        strict.close();
      }
    }
    if (strict.hunks.length > 0) return strict.hunks;
  } catch {
    // jsdiff rejects a diff whose hunk headers and bodies disagree; read it loosely below.
  }
  // Without trustworthy headers the line counts are unknown, so the lines are taken as they come.
  const loose = new ChunkReader();
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (!line.startsWith('+++ ') && !line.startsWith('--- ') && !line.startsWith('\\')) loose.line(line);
  }
  loose.close();
  return loose.hunks;
}

/** `add`, `update` or `delete`, wherever the wire puts the tag. */
function codexChangeKind(change: Fields): string | undefined {
  // app-server tags the kind as an object (`{ type: 'update', move_path }`), `exec --json` as a string.
  const tagged = isRecord(change.kind) ? change.kind : {};
  const kind = str(tagged.type) ?? str(change.kind);
  if (kind !== undefined) return kind;
  // The path-keyed wire tags the change itself (`{ type: 'update', unified_diff }`, `{ type: 'add',
  // content }`). A bare `type` on some other object is not a file change, so the body has to be there.
  const hasBody = str(change.unified_diff) !== undefined || str(change.content) !== undefined;
  return hasBody ? str(change.type) : undefined;
}

function codexChangeFiles(input: Fields): PatchFile[] {
  let changes: unknown = input.changes;
  if (changes === undefined && typeof input.input === 'string') changes = input.input;
  if (typeof changes === 'string') {
    if (!/^\s*[[{]/.test(changes)) return [];
    try {
      changes = JSON.parse(changes);
    } catch {
      return [];
    }
  }
  // The older wire keys the changes by path instead of listing them.
  if (isRecord(changes)) {
    changes = Object.entries(changes).map(([path, change]) => ({ ...(isRecord(change) ? change : {}), path }));
  }
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change): PatchFile[] => {
    if (!isRecord(change)) return [];
    const path = str(change.path)?.trim();
    if (!path) return [];
    const tagged = isRecord(change.kind) ? change.kind : {};
    const kind = codexChangeKind(change);
    const body = str(change.diff) ?? str(change.unified_diff) ?? str(change.content);
    if (kind === 'add') {
      // An add's `diff` is the file's whole text, without `+` prefixes.
      return [{ path, status: 'created', hunks: body === undefined ? [] : [{ before: null, after: body }] }];
    }
    if (kind === 'delete') return [{ path, status: 'deleted', hunks: [] }];
    // A kind this cannot name is not reported as an edit.
    if (kind !== 'update') return [];
    const moveTo =
      str(tagged.move_path) ?? str(tagged.movePath) ?? str(change.move_path) ?? str(change.movePath);
    return movedOrModified(path, moveTo?.trim(), body === undefined ? [] : unifiedDiffHunks(body));
  });
}
