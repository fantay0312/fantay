import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { clone, digest, fail, id, inside, object, rewritePaths, writeJSON } from './common.js';

const TIMELINES = ['draft_info.json', 'draft_content.json'];

export function readDocument(file, codec) {
  const raw = fs.readFileSync(file);
  let value, encrypted = false;
  try { value = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); }
  catch {
    if (!codec) fail('ENCRYPTED_DRAFT', `Cannot read ${file} as plaintext JSON; use the optional verified native codec`);
    value = codec.decode(raw);
    encrypted = true;
  }
  object(value, file);
  return { value, encrypted, hash: digest(file) };
}

export function readDraft(input, { codec } = {}) {
  const requested = path.resolve(input);
  if (!fs.existsSync(requested)) fail('NOT_FOUND', `Draft not found: ${requested}`);
  const inputDir = fs.statSync(requested).isDirectory() ? requested : path.dirname(requested);
  if (fs.lstatSync(inputDir).isSymbolicLink()) fail('UNSAFE_PATH', 'Source draft directory cannot be a symlink');
  const dir = fs.realpathSync(inputDir);
  assertTree(dir);
  const documents = new Map();
  const read = relative => {
    if (!documents.has(relative)) documents.set(relative, readDocument(path.join(dir, relative), codec));
    return documents.get(relative).value;
  };
  let base = '';
  if (fs.existsSync(path.join(dir, 'Timelines/project.json'))) {
    const project = read('Timelines/project.json');
    const timeline = project.main_timeline_id;
    if (typeof timeline !== 'string' || !/^[A-Za-z0-9_-]+$/.test(timeline)) fail('UNSUPPORTED_LAYOUT', 'Invalid active timeline identifier');
    if (!Array.isArray(project.timelines) || project.timelines.filter(t => !t.is_marked_delete).length !== 1 ||
        !project.timelines.some(t => t.id === timeline && !t.is_marked_delete)) {
      fail('UNSUPPORTED_LAYOUT', 'Only single active timeline projects are supported; multi-timeline projects are preserved and refused');
    }
    base = path.join('Timelines', timeline);
  }
  const names = TIMELINES.filter(name => fs.existsSync(path.join(dir, base, name)));
  if (!names.length) fail('INVALID_DRAFT', 'No draft_info.json or draft_content.json timeline found');
  const relative = path.join(base, names[0]);
  const data = read(relative);
  const nativeEmpty = documents.get(relative).encrypted && data.tracks === undefined && (data.duration ?? 0) === 0;
  if ((!Array.isArray(data.tracks) && !nativeEmpty) || !data.materials || Array.isArray(data.materials)) fail('INVALID_DRAFT', 'Timeline requires tracks[] and materials{}');
  for (const name of names.slice(1)) {
    const other = read(path.join(base, name));
    if (!isDeepStrictEqual(data, other)) fail('AMBIGUOUS_DRAFT', 'draft_info.json and draft_content.json disagree; select an unambiguous draft copy first');
  }
  if (base) {
    for (const name of TIMELINES) {
      if (fs.existsSync(path.join(dir, name))) {
        const root = read(name);
        if (!isDeepStrictEqual(root.tracks, data.tracks) || !isDeepStrictEqual(root.materials, data.materials)) {
          fail('AMBIGUOUS_DRAFT', 'Root and active timeline disagree');
        }
      }
    }
  }
  const meta = fs.existsSync(path.join(dir, 'draft_meta_info.json')) ? read('draft_meta_info.json') : {};
  if (meta.cloud_draft_sync || meta.draft_cloud_sync || meta.draft_cloud_id ||
      ['tm_draft_cloud_space_id', 'tm_draft_cloud_user_id', 'tm_draft_cloud_entry_id'].some(key => Number(meta[key]) > 0)) {
    fail('CLOUD_DRAFT_UNSUPPORTED', 'Download a standalone local copy before editing a cloud-linked draft');
  }
  const normalized = clone(data);
  // Native 11.6 serializes through protobuf and omits default-valued fields.
  normalized.fps ??= 30;
  normalized.duration ??= 0;
  if (nativeEmpty) normalized.tracks = [];
  return { dir, data: normalized, original: clone(normalized), meta: clone(meta), documents, relative, codec };
}

export function assertTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail('UNSAFE_PATH', `Symlink in draft tree: ${file}`);
    if (entry.isDirectory()) assertTree(file);
    else if (!entry.isFile()) fail('UNSAFE_PATH', `Unsupported file type: ${file}`);
  }
}

export function assertUnchanged(loaded) {
  for (const [relative, doc] of loaded.documents) {
    const file = path.join(loaded.dir, relative);
    if (!fs.existsSync(file) || digest(file) !== doc.hash) fail('CONCURRENT_CHANGE', `Draft changed after loading: ${relative}`);
  }
}

function resolvePotentialPath(file) {
  let ancestor = path.resolve(file);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('UNSAFE_PATH', `Cannot resolve output ancestor: ${file}`);
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, path.resolve(file)));
}

export function assertSeparate(source, output) {
  if (!source) return;
  const realSource = fs.realpathSync(source), dest = path.resolve(output), realDest = resolvePotentialPath(dest);
  if (inside(source, dest) || inside(dest, source) || inside(realSource, realDest) || inside(realDest, realSource)) fail('UNSAFE_PATH', 'Output and source must be separate directories');
}

export async function withOutputAsync(output, source, action) {
  // Reserve an output lock while asynchronous media probing is in progress.
  const dest = path.resolve(output);
  const parent = path.dirname(dest);
  assertSeparate(source, dest);
  fs.mkdirSync(parent, { recursive: true });
  assertSeparate(source, dest);
  const lock = dest + '.fantay-lock';
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('LOCKED', `Another operation holds ${lock}`); throw error; }
  let stage;
  try {
    stage = fs.mkdtempSync(path.join(parent, '.fantay-jy-stage-'));
    if (fs.existsSync(dest)) fail('OUTPUT_EXISTS', `Output already exists: ${dest}`);
    const result = await action(stage, dest);
    if (fs.existsSync(dest)) fail('OUTPUT_EXISTS', `Output appeared during save: ${dest}`);
    fs.renameSync(stage, dest);
    return result;
  } finally {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}

function persist(file, data, encrypted, codec) {
  if (encrypted) fs.writeFileSync(file, codec.encode(data));
  else writeJSON(file, data);
}

export function saveEdited(loaded, stage, dest, { name, addedAssets = [] } = {}) {
  assertUnchanged(loaded);
  fs.cpSync(loaded.dir, stage, { recursive: true, force: false, errorOnExist: false });
  // Remove stale native recovery snapshots and templates in the new copy.
  // They could otherwise restore the unedited timeline on first open.
  for (const relative of ['.backup', 'draft_info.json.bak', 'draft_content.json.bak']) fs.rmSync(path.join(stage, relative), { recursive: true, force: true });
  for (const asset of addedAssets) {
    const target = path.join(stage, 'materials', path.basename(asset));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(asset, target, fs.constants.COPYFILE_EXCL);
  }
  const newId = id();
  const data = rewritePaths(loaded.data, loaded.dir, dest);
  const title = name ?? loaded.meta.draft_name ?? path.basename(dest);
  const now = Date.now() * 1000;
  const commonKeys = ['tracks', 'materials', 'duration', 'canvas_config', 'fps'];
  for (const [relative, doc] of loaded.documents) {
    let value = rewritePaths(clone(doc.value), loaded.dir, dest);
    if (relative === loaded.relative) value = clone(data);
    if (relative === 'draft_meta_info.json') {
      Object.assign(value, { draft_id: newId, draft_name: title, draft_fold_path: dest, draft_root_path: path.dirname(dest), draft_json_file: path.join(dest, 'draft_info.json'), tm_duration: data.duration, tm_draft_modified: now });
    } else if (relative === 'Timelines/project.json') {
      value.id = newId;
      value.update_time = now;
    } else {
      for (const key of commonKeys) value[key] = clone(data[key]);
      value.update_time = Date.now();
      // In a native project the root and active files share a timeline ID;
      // draft_meta_info owns the separate project ID.
      if (!loaded.relative.startsWith('Timelines' + path.sep)) value.id = newId;
      const template = path.join(stage, path.dirname(relative), 'template-2.tmp');
      if (fs.existsSync(template)) persist(template, value, doc.encrypted, loaded.codec);
    }
    persist(path.join(stage, relative), value, doc.encrypted, loaded.codec);
  }
  if (!loaded.documents.has('draft_meta_info.json')) writeJSON(path.join(stage, 'draft_meta_info.json'), { draft_id: newId, draft_name: title, draft_fold_path: dest, draft_root_path: path.dirname(dest), tm_duration: data.duration, tm_draft_modified: now });
  assertUnchanged(loaded);
  return { draftPath: dest, projectId: newId, duration: data.duration / 1_000_000 };
}
