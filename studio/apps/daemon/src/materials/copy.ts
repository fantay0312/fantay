// Copy selected material files into a new folder outside the library.
//
// Selection follows `copy_files` / `choose_file` / `walk_files` in
// `素材库/导览支持/scripts/fantasy_design.py`:
// - requested indexed fields and collection-relative files/directories; with
//   no selection the main `path` (plus the indexed `thumbnail`, so the copy
//   is attachable as an image);
// - always plus the recorded provenance fields `document`, `license_document`
//   and `source_manifest`;
// - directories are walked without following symlinks, skipping dependency
//   and cache folders and dotfiles; a file symlink rejects the copy;
// - at most 200 files and 64 MiB.
// The daemon is stricter than the CLI in one place: no symlink is allowed in
// any segment of a selected path (the plugin asset guard).
//
// Every copied file is SHA-256 verified against the source and the folder
// gets a `fantasy-design-receipt.json`. The destination is created
// exclusively; a failure removes only the folder this call created. Nothing
// is ever written inside the library.

import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MaterialFileField, MaterialLibraryRootSource } from '@open-design/contracts';
import { MATERIAL_FILE_FIELDS, MATERIAL_NOTICE } from '@open-design/contracts';

import type { MaterialCatalog, MaterialRecord } from './catalog.js';
import { compactMaterialRecord } from './dto.js';
import { MaterialError, invalidRequest, missingFile, unsafePath } from './errors.js';
import {
  assertNoSymlinkSegments,
  assertRealInside,
  isInsideByIdentity,
  isPathInsideOrSame,
  materialCollectionRoot,
  posixParts,
  resolveIndexedPath,
  toPosixRelative,
} from './paths.js';

export const MATERIAL_COPY_MAX_FILES = 200;
export const MATERIAL_COPY_MAX_BYTES = 64 * 1024 * 1024;
export const MATERIAL_RECEIPT_FILE = 'fantasy-design-receipt.json';
export const MATERIAL_RECEIPT_CREATOR = 'fantay-studio';

/** `IGNORED` and `AGENT_DOT_DIRS` in `fantasy_design.py`. */
const IGNORED_NAMES = new Set(['.git', 'node_modules', '__pycache__', '.DS_Store', '.venv']);
const ALLOWED_AGENT_DOT_DIRS = new Set(['.agents', '.claude', '.cursor', '.opencode', '.codex', '.gemini']);
const PROVENANCE_FIELDS: readonly MaterialFileField[] = ['document', 'license_document', 'source_manifest'];

export interface MaterialCopySelection {
  fields?: readonly MaterialFileField[];
  files?: readonly string[];
}

export interface MaterialCopyPlanEntry {
  /** Absolute source path inside the library. */
  source: string;
  /** Source path relative to the library root. */
  sourceRelativePath: string;
  /** Destination path relative to the new copy folder. */
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface MaterialCopyPlan {
  record: MaterialRecord;
  /** Folder the destination layout is relative to (collection root, entry dir or root). */
  layoutRoot: string;
  entries: MaterialCopyPlanEntry[];
  /** Destination-relative paths of the copied main entry and thumbnail, when copied. */
  mainEntry: string | null;
  thumbnail: string | null;
}

function isMaterialFileField(value: unknown): value is MaterialFileField {
  return typeof value === 'string' && (MATERIAL_FILE_FIELDS as readonly string[]).includes(value);
}

export function parseMaterialFileFields(value: unknown): MaterialFileField[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidRequest('fields must be an array of indexed field names');
  const out: MaterialFileField[] = [];
  for (const entry of value) {
    if (!isMaterialFileField(entry)) {
      throw invalidRequest(`Unknown field: ${String(entry)}; use one of ${MATERIAL_FILE_FIELDS.join(', ')}`);
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

async function sha256File(target: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

interface Selected {
  abs: string;
  label: string;
}

async function chooseField(
  catalog: MaterialCatalog,
  record: MaterialRecord,
  field: MaterialFileField,
): Promise<Selected> {
  const value = record[field];
  if (typeof value !== 'string' || !value) throw invalidRequest(`${record.id} has no ${field} entry`);
  const abs = resolveIndexedPath(catalog, value);
  await assertNoSymlinkSegments(abs, catalog.root, value);
  await assertRealInside(abs, catalog.root, value);
  return { abs, label: value };
}

async function chooseCollectionFile(
  catalog: MaterialCatalog,
  collectionRoot: string | null,
  relative: string,
): Promise<Selected> {
  if (!collectionRoot) {
    throw invalidRequest('This record has no collection directory; select fields instead.');
  }
  const parts = posixParts(relative);
  if (
    !relative ||
    relative.includes('\0') ||
    path.isAbsolute(relative) ||
    parts.length === 0 ||
    parts.includes('..') ||
    parts.some((part) => IGNORED_NAMES.has(part))
  ) {
    throw unsafePath('Use a collection-relative path; traversal is not allowed.');
  }
  const abs = path.resolve(collectionRoot, relative);
  if (!isPathInsideOrSame(abs, collectionRoot)) throw unsafePath('Selected path leaves collection');
  await assertNoSymlinkSegments(abs, catalog.root, relative);
  await assertRealInside(abs, collectionRoot, relative);
  return { abs, label: relative };
}

interface CollectState {
  files: Map<string, number>;
  bytes: number;
}

function addFile(state: CollectState, file: string, size: number): void {
  if (state.files.has(file)) return;
  state.files.set(file, size);
  if (state.files.size > MATERIAL_COPY_MAX_FILES) {
    throw new MaterialError(
      'copy-limit',
      413,
      `Copy exceeds ${MATERIAL_COPY_MAX_FILES} files; select a narrower directory.`,
    );
  }
  state.bytes += size;
}

/** `walk_files`: never follow directory symlinks, skip hidden and dependency stores. */
async function walkDirectory(state: CollectState, dir: string, root: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (
      IGNORED_NAMES.has(entry.name) ||
      (entry.name.startsWith('.') && !(entry.isDirectory() && ALLOWED_AGENT_DOT_DIRS.has(entry.name.toLowerCase())))
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let targetIsDir = false;
      try {
        targetIsDir = (await stat(full)).isDirectory();
      } catch {
        targetIsDir = false;
      }
      if (targetIsDir) continue;
      throw unsafePath(`Copy does not follow file symlinks: ${toPosixRelative(root, full)}`);
    }
    if (entry.isDirectory()) {
      await walkDirectory(state, full, root);
      continue;
    }
    if (!entry.isFile()) throw unsafePath(`Unsafe copy source: ${toPosixRelative(root, full)}`);
    const real = await assertRealInside(full, root, toPosixRelative(root, full));
    addFile(state, real, (await stat(real)).size);
  }
}

async function expandSelection(state: CollectState, selected: Selected, root: string): Promise<void> {
  let info;
  try {
    info = await lstat(selected.abs);
  } catch {
    throw missingFile(`Missing file: ${selected.label}`);
  }
  if (info.isSymbolicLink()) throw unsafePath('Copy does not follow selected symlinks.');
  if (info.isDirectory()) {
    await walkDirectory(state, selected.abs, root);
    return;
  }
  if (!info.isFile()) throw unsafePath(`Unsafe copy source: ${selected.label}`);
  addFile(state, selected.abs, info.size);
}

function chooseLayoutRoot(files: readonly string[], candidates: readonly (string | null)[], root: string): string {
  for (const candidate of candidates) {
    if (candidate && files.every((file) => isPathInsideOrSame(file, candidate) && file !== candidate)) {
      return candidate;
    }
  }
  return root;
}

export async function planMaterialCopy(
  catalog: MaterialCatalog,
  record: MaterialRecord,
  selection: MaterialCopySelection,
): Promise<MaterialCopyPlan> {
  const collectionRoot = await materialCollectionRoot(catalog, record);
  const selected: Selected[] = [];
  for (const file of selection.files ?? []) {
    if (typeof file !== 'string') throw invalidRequest('files must be strings');
    selected.push(await chooseCollectionFile(catalog, collectionRoot, file));
  }
  for (const field of selection.fields ?? []) selected.push(await chooseField(catalog, record, field));
  if (selected.length === 0) {
    selected.push(await chooseField(catalog, record, 'path'));
    if (typeof record.thumbnail === 'string' && record.thumbnail) {
      selected.push(await chooseField(catalog, record, 'thumbnail'));
    }
  }
  for (const field of PROVENANCE_FIELDS) {
    if (typeof record[field] === 'string' && record[field]) selected.push(await chooseField(catalog, record, field));
  }

  const state: CollectState = { files: new Map(), bytes: 0 };
  for (const entry of selected) await expandSelection(state, entry, catalog.root);
  if (state.bytes > MATERIAL_COPY_MAX_BYTES) {
    throw new MaterialError('copy-limit', 413, 'Copy exceeds 64 MiB; select fewer files.');
  }

  const files = [...state.files.keys()];
  const mainAbs = resolveIndexedPath(catalog, record.path);
  const layoutRoot = chooseLayoutRoot(files, [collectionRoot, path.dirname(mainAbs)], catalog.root);
  const entries: MaterialCopyPlanEntry[] = [];
  for (const file of files) {
    entries.push({
      source: file,
      sourceRelativePath: toPosixRelative(catalog.root, file),
      relativePath: toPosixRelative(layoutRoot, file),
      bytes: state.files.get(file) ?? 0,
      sha256: await sha256File(file),
    });
  }
  entries.sort((a, b) => (a.sourceRelativePath < b.sourceRelativePath ? -1 : a.sourceRelativePath > b.sourceRelativePath ? 1 : 0));

  const destinationOf = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null;
    const abs = resolveIndexedPath(catalog, value);
    return state.files.has(abs) ? toPosixRelative(layoutRoot, abs) : null;
  };
  return {
    record,
    layoutRoot,
    entries,
    mainEntry: destinationOf(record.path),
    thumbnail: destinationOf(record.thumbnail),
  };
}

export interface ExecuteMaterialCopyInput {
  plan: MaterialCopyPlan;
  /** Existing absolute directory that receives the new `<folder>[-N]/`. */
  parentDir: string;
  folderName: string;
  libraryRoot: string;
  rootSource: MaterialLibraryRootSource;
  /** Extra receipt context, e.g. the project id and project-relative folder. */
  receiptContext: (folder: string) => Record<string, unknown>;
}

export interface ExecuteMaterialCopyResult {
  folder: string;
  destination: string;
}

const MAX_FOLDER_SUFFIX = 1000;

async function createExclusiveFolder(parentDir: string, folderName: string): Promise<string> {
  for (let n = 1; n <= MAX_FOLDER_SUFFIX; n += 1) {
    const name = n === 1 ? folderName : `${folderName}-${n}`;
    try {
      await mkdir(path.join(parentDir, name));
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw invalidRequest(`Too many existing copies of ${folderName}; choose another dir.`);
}

export async function executeMaterialCopy(input: ExecuteMaterialCopyInput): Promise<ExecuteMaterialCopyResult> {
  const { plan } = input;
  if (
    isPathInsideOrSame(input.parentDir, input.libraryRoot) ||
    (await isInsideByIdentity(input.parentDir, input.libraryRoot))
  ) {
    throw unsafePath('Copy destination must be outside the source library.');
  }
  const folder = await createExclusiveFolder(input.parentDir, input.folderName);
  const destination = path.join(input.parentDir, folder);
  try {
    for (const entry of plan.entries) {
      const output = path.resolve(destination, entry.relativePath);
      if (!isPathInsideOrSame(output, destination) || output === destination) {
        throw unsafePath(`Unsafe destination path: ${entry.relativePath}`);
      }
      await mkdir(path.dirname(output), { recursive: true });
      await copyFile(entry.source, output, fsConstants.COPYFILE_EXCL);
      if ((await sha256File(output)) !== entry.sha256) {
        throw new MaterialError('missing-file', 409, 'Source changed during copy; retry from a stable archive.');
      }
    }
    const receipt = {
      schema_version: 1,
      created_by: MATERIAL_RECEIPT_CREATOR,
      created_at: new Date().toISOString(),
      id: plan.record.id,
      source_library_root: input.libraryRoot,
      source_library_root_from: input.rootSource,
      ...input.receiptContext(folder),
      asset: compactMaterialRecord(plan.record),
      files: plan.entries.map((entry) => ({
        source_relative_path: entry.sourceRelativePath,
        relative_path: entry.relativePath,
        bytes: entry.bytes,
        sha256: entry.sha256,
      })),
      notice: MATERIAL_NOTICE,
      dependencies_resolved: false,
    };
    await writeFile(path.join(destination, MATERIAL_RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { folder, destination };
}
