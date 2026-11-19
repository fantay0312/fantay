// SPDX-License-Identifier: AGPL-3.0-only
// The Files library as data: what each file is, which folders exist and how much they hold, and
// which files a folder, a type filter and a search show, in what order.
// One rule holds everywhere: the library shows every file in the open folder and below. Folder
// tiles, the type filter and the search each narrow that set; none of them changes its scope.
// Pure: no React, no DOM, so the surface and its tests share it.
import type { ProjectFile, ProjectFolder } from '../../../types';
import { artifactFileFamily } from '../../artifact/file-family';

/** What a file is to a person. Drives the label under the name and the glyph of a type tile. */
export type LibraryKind =
  | 'page'
  | 'image'
  | 'sketch'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'text'
  | 'sheet'
  | 'slides'
  | 'code'
  | 'data'
  | 'notebook'
  | 'database'
  | 'model'
  | 'archive'
  | 'font'
  | 'file';

/** The type filters, in the order the row shows them. */
export const LIBRARY_GROUPS = ['page', 'document', 'image', 'sheet', 'slides', 'code', 'media', 'other'] as const;
export type LibraryGroup = (typeof LIBRARY_GROUPS)[number];
export type LibraryFilter = 'all' | LibraryGroup;

/** How the card draws the file. `tile` is the designed fallback every other kind can fall to. */
export type LibraryPreviewKind = 'image' | 'page' | 'markdown' | 'table' | 'text' | 'video' | 'tile';

export interface LibraryFile {
  file: ProjectFile;
  /** Project-relative path (the file's `name`). */
  path: string;
  /** Last path segment. */
  label: string;
  /** Parent folder path, '' at the project root. */
  dir: string;
  kind: LibraryKind;
  group: LibraryGroup;
  preview: LibraryPreviewKind;
  /** Lower-case extension without the dot ('' when there is none). */
  extension: string;
}

export interface LibraryFolder {
  path: string;
  label: string;
  /** Files anywhere below this folder. */
  fileCount: number;
  /** Newest change below this folder; the folder's own time when it is empty. */
  mtime: number;
}

export type LibrarySortKey = 'name' | 'modified' | 'size' | 'type';
export interface LibrarySort {
  key: LibrarySortKey;
  direction: 'asc' | 'desc';
}

/** The direction a sort key starts in: newest and largest first, names and types A to Z. */
export const SORT_START: Record<LibrarySortKey, LibrarySort['direction']> = {
  name: 'asc',
  modified: 'desc',
  size: 'desc',
  type: 'asc',
};

const PAGE_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'mdown', 'mkd', 'mkdn']);
/** A picture larger than this is not decoded for a card. */
const IMAGE_PREVIEW_MAX_BYTES = 24 * 1024 * 1024;

// Natural order ("file2" before "file10"), ignoring case and accents.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareLabels(a: string, b: string): number {
  // The code-point tie-break keeps "a.ts" and "A.ts" in one fixed order.
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function classify(file: ProjectFile): Pick<LibraryFile, 'kind' | 'group' | 'preview' | 'extension'> {
  const family = artifactFileFamily(file.name, file.mime);
  const extension = family.extension;
  if (PAGE_EXTENSIONS.has(extension) || file.kind === 'html') {
    return { kind: 'page', group: 'page', preview: 'page', extension };
  }
  if (MARKDOWN_EXTENSIONS.has(extension)) return { kind: 'document', group: 'document', preview: 'markdown', extension };

  switch (family.viewer) {
    case 'image': {
      const decodable = family.format === 'native' || family.format === 'svg';
      return { kind: 'image', group: 'image', preview: decodable && file.size <= IMAGE_PREVIEW_MAX_BYTES ? 'image' : 'tile', extension };
    }
    case 'pdf':
      return { kind: 'pdf', group: 'document', preview: 'tile', extension };
    case 'document':
    case 'ebook':
      return { kind: 'document', group: 'document', preview: 'tile', extension };
    case 'email':
      return { kind: 'document', group: 'document', preview: 'text', extension };
    case 'sheet':
      return { kind: 'sheet', group: 'sheet', preview: family.format === 'csv' || family.format === 'tsv' ? 'table' : 'tile', extension };
    case 'slides':
      return { kind: 'slides', group: 'slides', preview: 'tile', extension };
    case 'notebook':
      return { kind: 'notebook', group: 'code', preview: 'tile', extension };
    case 'diagram':
      return { kind: 'code', group: 'code', preview: 'text', extension };
    case 'whiteboard':
      return { kind: 'sketch', group: 'image', preview: 'tile', extension };
    case 'audio':
      return { kind: 'audio', group: 'media', preview: 'tile', extension };
    case 'video':
      return { kind: 'video', group: 'media', preview: family.format === 'native' ? 'video' : 'tile', extension };
    case 'model':
      return { kind: 'model', group: 'other', preview: 'tile', extension };
    case 'archive':
      return { kind: 'archive', group: 'other', preview: 'tile', extension };
    case 'font':
      return { kind: 'font', group: 'other', preview: 'tile', extension };
    case 'database':
      return { kind: 'database', group: 'other', preview: 'tile', extension };
    case 'text':
      if (family.family === 'code') return { kind: 'code', group: 'code', preview: 'text', extension };
      if (family.family === 'data') return { kind: 'data', group: 'code', preview: 'text', extension };
      return { kind: 'text', group: 'document', preview: 'text', extension };
    default:
      return { kind: 'file', group: 'other', preview: 'tile', extension };
  }
}

/** What a file is, for the card, the filter row and the sort. */
export function describeLibraryFile(file: ProjectFile): LibraryFile {
  const described = classify(file);
  return {
    file,
    path: file.name,
    label: baseName(file.name),
    dir: parentDir(file.name),
    ...described,
    // An empty file has nothing to draw.
    preview: file.size === 0 ? 'tile' : described.preview,
  };
}

/**
 * Every folder of the project with its true size: the files anywhere below it and the newest change
 * among them. Folders come from two places, the path of each file and the persisted folder list
 * (which also names the empty ones), so a folder never reads "0 files" while it is full.
 */
export function indexLibraryFolders(
  files: readonly ProjectFile[],
  folders: readonly ProjectFolder[] | undefined,
): Map<string, LibraryFolder> {
  const index = new Map<string, LibraryFolder>();
  const ensure = (path: string, mtime: number): LibraryFolder => {
    let entry = index.get(path);
    if (!entry) {
      entry = { path, label: baseName(path), fileCount: 0, mtime };
      index.set(path, entry);
    }
    return entry;
  };

  for (const file of files) {
    let slash = file.name.indexOf('/');
    while (slash !== -1) {
      const entry = ensure(file.name.slice(0, slash), 0);
      entry.fileCount += 1;
      if (file.mtime > entry.mtime) entry.mtime = file.mtime;
      slash = file.name.indexOf('/', slash + 1);
    }
  }
  for (const folder of folders ?? []) {
    const path = folder.path.replace(/^\/+|\/+$/g, '');
    if (!path) continue;
    // An empty folder, and each ancestor that exists only because of it, shows its own time.
    let slash = path.indexOf('/');
    while (slash !== -1) {
      const ancestor = ensure(path.slice(0, slash), folder.mtime);
      if (ancestor.fileCount === 0 && folder.mtime > ancestor.mtime) ancestor.mtime = folder.mtime;
      slash = path.indexOf('/', slash + 1);
    }
    const entry = ensure(path, folder.mtime);
    if (entry.fileCount === 0 && folder.mtime > entry.mtime) entry.mtime = folder.mtime;
  }
  return index;
}

/** The folder itself when it exists, else its nearest ancestor that does ('' is the root). */
export function nearestExistingDir(dir: string, index: ReadonlyMap<string, LibraryFolder>): string {
  let current = dir;
  while (current !== '' && !index.has(current)) current = parentDir(current);
  return current;
}

export interface LibraryScope {
  /** Every file in the open folder and below. */
  files: LibraryFile[];
  /** The open folder's own subfolders. */
  folders: LibraryFolder[];
  /** Every folder below the open one (a search looks through these). */
  descendants: LibraryFolder[];
  /** Files per type filter in this scope. A search does not change them. */
  counts: Record<LibraryFilter, number>;
  /** The filters worth showing: `all` plus each group that has files. */
  filters: LibraryFilter[];
}

export function buildLibraryScope(
  files: readonly LibraryFile[],
  index: ReadonlyMap<string, LibraryFolder>,
  currentDir: string,
): LibraryScope {
  const prefix = currentDir === '' ? '' : `${currentDir}/`;
  const scoped = prefix === '' ? [...files] : files.filter((entry) => entry.path.startsWith(prefix));

  const counts = { all: scoped.length } as Record<LibraryFilter, number>;
  for (const group of LIBRARY_GROUPS) counts[group] = 0;
  for (const entry of scoped) counts[entry.group] += 1;

  const folders: LibraryFolder[] = [];
  const descendants: LibraryFolder[] = [];
  for (const folder of index.values()) {
    if (!folder.path.startsWith(prefix) || folder.path === currentDir) continue;
    descendants.push(folder);
    if (parentDir(folder.path) === currentDir) folders.push(folder);
  }

  return {
    files: scoped,
    folders,
    descendants,
    counts,
    filters: ['all', ...LIBRARY_GROUPS.filter((group) => counts[group] > 0)],
  };
}

function compareFiles(a: LibraryFile, b: LibraryFile, key: LibrarySortKey): number {
  switch (key) {
    case 'modified':
      return a.file.mtime - b.file.mtime;
    case 'size':
      return a.file.size - b.file.size;
    case 'type':
      return (
        LIBRARY_GROUPS.indexOf(a.group) - LIBRARY_GROUPS.indexOf(b.group) ||
        compareLabels(a.kind, b.kind) ||
        compareLabels(a.extension, b.extension)
      );
    default:
      return 0;
  }
}

export interface LibraryView {
  folders: LibraryFolder[];
  files: LibraryFile[];
}

/**
 * What the content area lists. Folder tiles belong to browsing: they show under "all" (the open
 * folder's own subfolders, or every folder below it that matches a search) and step aside while a
 * type filter is on, since a folder is not a type.
 */
export function selectLibraryView(
  scope: LibraryScope,
  options: { filter: LibraryFilter; query: string; sort: LibrarySort },
): LibraryView {
  const needle = options.query.trim().toLowerCase();
  const sign = options.sort.direction === 'asc' ? 1 : -1;
  const { key } = options.sort;

  let files = scope.files;
  if (options.filter !== 'all') files = files.filter((entry) => entry.group === options.filter);
  if (needle) files = files.filter((entry) => entry.label.toLowerCase().includes(needle));
  files = [...files].sort(
    (a, b) =>
      sign * compareFiles(a, b, key) ||
      // Equal on the chosen key (always, for "name"): by name, in the chosen direction for a name sort.
      (key === 'name' ? sign : 1) * compareLabels(a.label, b.label) ||
      compareLabels(a.path, b.path),
  );

  let folders: LibraryFolder[] = [];
  if (options.filter === 'all') {
    folders = needle ? scope.descendants.filter((folder) => folder.label.toLowerCase().includes(needle)) : scope.folders;
    folders = [...folders].sort((a, b) =>
      key === 'modified'
        ? sign * (a.mtime - b.mtime) || compareLabels(a.label, b.label)
        : (key === 'name' ? sign : 1) * compareLabels(a.label, b.label) || compareLabels(a.path, b.path),
    );
  }
  return { folders, files };
}

export interface LibraryCrumb {
  label: string;
  path: string;
}

/** "office/reports" → office, office/reports. The root crumb is the caller's. */
export function libraryCrumbs(dir: string): LibraryCrumb[] {
  const parts = dir.split('/').filter(Boolean);
  return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join('/') }));
}

/**
 * A name in two parts for middle truncation: the head gives way with an ellipsis, the tail (the end
 * of the stem and the extension) always shows, so "季度复盘-长文档-终稿.pdf" still ends in "终稿.pdf".
 * Short names come back whole in `head`.
 */
export function splitDisplayName(name: string, keep = 3): { head: string; tail: string } {
  const dot = name.lastIndexOf('.');
  const stemLength = dot > 0 ? dot : name.length;
  if (stemLength <= keep + 6) return { head: name, tail: '' };
  // Cut on a code-point boundary, so a surrogate pair is never split.
  const stem = Array.from(name.slice(0, stemLength));
  if (stem.length <= keep + 6) return { head: name, tail: '' };
  return { head: stem.slice(0, stem.length - keep).join(''), tail: stem.slice(stem.length - keep).join('') + name.slice(stemLength) };
}

export type RelativeTime =
  | { unit: 'now' }
  | { unit: 'minutes' | 'hours' | 'days' | 'weeks'; n: number }
  | { unit: 'date'; date: Date };

/** "just now", "5 minutes ago" … a plain date after a month. */
export function relativeTime(timestamp: number, now: number): RelativeTime {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const diff = now - timestamp;
  if (diff < minute) return { unit: 'now' };
  if (diff < hour) return { unit: 'minutes', n: Math.floor(diff / minute) };
  if (diff < day) return { unit: 'hours', n: Math.floor(diff / hour) };
  if (diff < 7 * day) return { unit: 'days', n: Math.floor(diff / day) };
  if (diff < 30 * day) return { unit: 'weeks', n: Math.floor(diff / (7 * day)) };
  return { unit: 'date', date: new Date(timestamp) };
}

/** How long after its last write a file still counts as being written by the running turn. */
export const WRITING_WINDOW_MS = 45_000;

/**
 * Files the running turn is writing right now: changed since the turn began and within the last
 * moments. A file the turn finished minutes ago is done, even though the turn goes on.
 */
export function writingFiles(
  files: readonly ProjectFile[],
  run: { running: boolean; startedAt: number | null | undefined; now: number },
): Set<string> {
  const writing = new Set<string>();
  if (!run.running || !run.startedAt || !Number.isFinite(run.startedAt)) return writing;
  for (const file of files) {
    if (file.mtime >= run.startedAt && run.now - file.mtime < WRITING_WINDOW_MS) writing.add(file.name);
  }
  return writing;
}
