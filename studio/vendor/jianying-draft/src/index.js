import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { clone, fail, id, json, mediaPath, string, US, writeJSON } from './common.js';
import { assertSeparate, readDraft, saveEdited, withOutputAsync } from './storage.js';
import { validateData } from './validate.js';

export { createDraft, parseSrt } from './build.js';
export { editDraft } from './edit.js';
export { readDraft } from './storage.js';
export { nativeCodec } from './codec.js';
export { DraftError } from './common.js';

export function inspectDraft(input, options = {}) {
  const loaded = readDraft(input, options), data = loaded.data;
  return {
    path: loaded.dir, name: loaded.meta.draft_name ?? data.name, projectId: loaded.meta.draft_id ?? data.id,
    timelineId: data.id, layout: loaded.relative, version: data.new_version,
    encoding: [...loaded.documents.values()].some(doc => doc.encrypted) ? 'native' : 'plaintext',
    duration: (data.duration ?? 0) / US, fps: data.fps, canvas: data.canvas_config,
    tracks: data.tracks.map(track => ({ id: track.id, type: track.type, name: track.name, attribute: track.attribute,
      segments: track.segments.map(segment => ({ id: segment.id, materialId: segment.material_id,
        start: (segment.target_timerange.start ?? 0) / US, duration: segment.target_timerange.duration / US,
        sourceStart: segment.source_timerange ? (segment.source_timerange.start ?? 0) / US : null,
        sourceDuration: segment.source_timerange ? segment.source_timerange.duration / US : null,
        speed: segment.speed ?? 1, volume: segment.volume ?? 1,
        text: (() => { const text = data.materials.texts?.find(t => t.id === segment.material_id); try { return text ? JSON.parse(text.content).text : undefined; } catch { return undefined; } })(),
      })) })),
  };
}

export function validateDraft(input, options = {}) {
  const loaded = readDraft(input, options);
  return validateData(loaded.data, { dir: loaded.dir, checkMedia: options.checkMedia !== false });
}

export function defaultDraftsRoot() {
  return path.join(os.homedir(), 'Movies/JianyingPro/User Data/Projects/com.lveditor.draft');
}

export function doctor({ app = '/Applications/VideoFusion-macOS.app', root = defaultDraftsRoot() } = {}) {
  const run = (file, args) => { try { return execFileSync(file, args, { encoding: 'utf8', timeout: 5000 }).trim(); } catch { return null; } };
  const plist = path.join(app, 'Contents/Info.plist');
  return { platform: process.platform, arch: process.arch, node: process.versions.node,
    app: { path: app, installed: fs.existsSync(plist), version: fs.existsSync(plist) ? run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]) : null },
    ffprobe: run('ffprobe', ['-version'])?.split('\n')[0] ?? null,
    draftsRoot: root, draftsRootExists: fs.existsSync(root),
    capabilities: { plaintextCreate: true, plaintextEdit: true, nativeCodecRequiresLocalBuild: true, nativeCodecVersion: '11.6.0 / macOS arm64', videoExport: false, multiTimelineEdit: false },
  };
}

export function listDrafts(root = defaultDraftsRoot()) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => ({ name: e.name, path: path.join(root, e.name) }));
}

function assertEditorClosed() {
  if (process.platform !== 'darwin') return;
  const processes = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8' });
  if (processes.split('\n').some(line => line.trim().endsWith('/Contents/MacOS/VideoFusion-macOS'))) fail('EDITOR_RUNNING', 'Quit Jianying before installing drafts, so its project registry cannot overwrite the change');
}

export async function installDraft(input, { root = defaultDraftsRoot(), name, codec } = {}) {
  assertEditorClosed();
  const loaded = readDraft(input, { codec });
  const check = validateData(loaded.data, { dir: loaded.dir, checkMedia: true });
  if (!check.valid) fail('INVALID_DRAFT', 'Cannot install an invalid draft', check.errors);
  const title = string(name ?? loaded.meta.draft_name ?? path.basename(loaded.dir), 'name');
  if (title === '.' || title === '..' || /[\/\\\0]/.test(title)) fail('UNSAFE_PATH', 'Draft name must be a single directory name');
  root = path.resolve(root);
  assertSeparate(loaded.dir, path.join(root, title));
  fs.mkdirSync(root, { recursive: true });
  const registryFile = path.join(root, 'root_meta_info.json');
  if (fs.existsSync(registryFile) && fs.lstatSync(registryFile).isSymbolicLink()) fail('UNSAFE_PATH', 'Registry cannot be a symlink');
  const lock = path.join(root, '.fantay-registry-lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); } catch { fail('LOCKED', 'Draft registry is locked by another operation'); }
  let installed;
  try {
    const raw = fs.existsSync(registryFile) ? fs.readFileSync(registryFile) : null;
    const registry = raw ? json(registryFile) : { all_draft_store: [], draft_ids: 0, root_path: root };
    if (!Array.isArray(registry.all_draft_store)) fail('INVALID_REGISTRY', 'Registry requires all_draft_store[]');
    const output = path.join(root, title);
    const result = await withOutputAsync(output, loaded.dir, (stage, dest) => saveEdited(loaded, stage, dest, { name: title }));
    installed = result.draftPath;
    assertEditorClosed();
    if (raw ? !fs.existsSync(registryFile) || !raw.equals(fs.readFileSync(registryFile)) : fs.existsSync(registryFile)) fail('CONCURRENT_CHANGE', 'Registry changed during installation');
    const media = new Set(['videos', 'images', 'audios'].flatMap(bucket => loaded.data.materials[bucket] ?? []).filter(m => m.path).map(m => mediaPath(m.path, loaded.dir)));
    const materialBytes = [...media].reduce((total, file) => total + fs.statSync(file).size, 0);
    const entry = { ...clone(loaded.meta), draft_id: result.projectId, draft_name: title, draft_fold_path: installed, draft_root_path: root,
      draft_json_file: path.join(installed, fs.existsSync(path.join(installed, 'draft_info.json')) ? 'draft_info.json' : 'draft_content.json'),
      draft_cover: fs.existsSync(path.join(installed, 'draft_cover.jpg')) ? path.join(installed, 'draft_cover.jpg') : '',
      draft_timeline_materials_size: materialBytes, draft_is_invisible: false, draft_cloud_sync: false,
      tm_duration: loaded.data.duration, tm_draft_create: Date.now() * 1000, tm_draft_modified: Date.now() * 1000, tm_draft_removed: 0 };
    // A copied project must not carry cloud linkage from its source.
    for (const key of Object.keys(entry)) if (key.startsWith('draft_cloud_') || key.startsWith('tm_draft_cloud_')) delete entry[key];
    registry.all_draft_store.push(entry);
    registry.draft_ids = registry.all_draft_store.length;
    registry.root_path = root;
    const backupDir = path.join(root, '.fantay-registry-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = raw ? path.join(backupDir, `root-${Date.now()}-${id()}.json`) : null;
    if (raw) fs.writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 });
    const temp = path.join(root, `.fantay-registry-${id()}.tmp`);
    try { writeJSON(temp, registry); fs.renameSync(temp, registryFile); }
    finally { fs.rmSync(temp, { force: true }); }
    return { ...result, registry: registryFile, registryBackup: backup };
  } catch (error) {
    if (installed) fs.rmSync(installed, { recursive: true, force: true });
    throw error;
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}
