// Reads a tool plugin package folder into the shape the plugin host runs.
//
// Two manifests are understood, and one package may carry both:
// - `package.json#fantay.plugin`: a Fantay tool plugin (display text, icon, host and client entries).
// - `package.json#dsh`: a DeepSeek Harness bundle. `dsh.bundle.patch` lists the host rows to start
//   (`- insert: [{ id, name, config }]`), and `dsh.client` marks `exports["./client"]` as the
//   workspace module.
//
// Nothing here runs plugin code: it only reads files and resolves entry paths inside the package.
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import type { OpenDesignHostToolPluginText } from '@open-design/host';

const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const ICON_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
const ICON_MAX_BYTES = 256 * 1024;
const LOCALES = ['zh', 'en'] as const;

/** A `!!js` scalar from a patch file: an expression evaluated against the plugin context at start. */
export interface ToolPluginExpression { __jsExpr: string }

/** One host entry of a plugin: a module started with `ctx.plugin(module, config)`. */
export interface ToolPluginRow {
  id: string;
  /** The module name as the manifest wrote it. */
  name: string;
  /** Resolved entry file, or null when the name is not a file of this package. */
  entry: string | null;
  config: unknown;
  inject: string[];
  disabled: boolean;
}

export interface ToolPluginPackage {
  /** The package name; also the plugin id. */
  id: string;
  root: string;
  version?: string;
  title?: OpenDesignHostToolPluginText;
  description?: OpenDesignHostToolPluginText;
  icon?: string;
  shortcut?: string;
  flavor: 'fantay' | 'dsh';
  rows: ToolPluginRow[];
  client: { file: string; moduleId: string } | null;
}

export class ToolPluginPackageError extends Error {}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** A path inside the package, or null when it would leave the folder. */
function inside(root: string, target: string): string | null {
  const file = resolve(root, target);
  const rel = relative(root, file);
  return rel && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel) ? file : null;
}

function exportTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  for (const condition of ['import', 'node', 'default']) {
    const target = exportTarget(value[condition]);
    if (target) return target;
  }
  return null;
}

/** Resolves a package subpath (`.` or `./client`) through `exports`, with `*` patterns. */
function resolveExport(manifest: Json, subpath: string): string | null {
  const exportsField = manifest.exports;
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : null;
  if (!isRecord(exportsField)) return null;
  if (!Object.keys(exportsField).some(key => key.startsWith('.'))) {
    return subpath === '.' ? exportTarget(exportsField) : null;
  }
  const exact = exportTarget(exportsField[subpath]);
  if (exact) return exact;
  for (const [pattern, value] of Object.entries(exportsField)) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (subpath.length < head.length + tail.length || !subpath.startsWith(head) || !subpath.endsWith(tail)) continue;
    const target = exportTarget(value);
    if (target) return target.replace('*', subpath.slice(head.length, subpath.length - tail.length));
  }
  return null;
}

function existingFile(file: string | null): string | null {
  if (!file) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function mainEntry(root: string, manifest: Json): string | null {
  const target = resolveExport(manifest, '.') ?? (typeof manifest.main === 'string' ? manifest.main : 'index.js');
  return existingFile(inside(root, target));
}

/** The file a row's module name points at: the package itself, one of its subpaths, or a relative file. */
function resolveRowEntry(root: string, manifest: Json, name: string, base: string): string | null {
  const packageName = manifest.name as string;
  if (name === packageName) return mainEntry(root, manifest);
  if (name.startsWith(packageName + '/')) {
    const subpath = './' + name.slice(packageName.length + 1);
    return existingFile(inside(root, resolveExport(manifest, subpath) ?? subpath));
  }
  if (name.startsWith('./') || name.startsWith('../') || isAbsolute(name)) {
    return existingFile(inside(root, resolve(base, name)));
  }
  return null;
}

function parsePatchFile(file: string): unknown {
  const document = parseDocument(readFileSync(file, 'utf8'), {
    customTags: [{
      tag: 'tag:yaml.org,2002:js',
      resolve: (expression: string): ToolPluginExpression => ({ __jsExpr: expression }),
    }],
  });
  if (document.errors.length > 0) throw new ToolPluginPackageError(`${file}: ${document.errors[0]!.message}`);
  return document.toJS();
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return isRecord(value) ? Object.keys(value) : [];
}

/**
 * Applies a bundle's patch files the way the Harness loader does for one layer: `insert` appends rows,
 * and `{ id, …keys }` replaces those keys on an earlier row (`config` is replaced, not merged).
 * Groups and nested includes are Harness-profile features and are skipped.
 */
function readPatchRows(root: string, manifest: Json, patches: string[]): ToolPluginRow[] {
  const rows: ToolPluginRow[] = [];
  for (const patch of patches) {
    const file = existingFile(inside(root, patch));
    if (!file) throw new ToolPluginPackageError(`Patch file not found: ${patch}`);
    const entries = parsePatchFile(file);
    if (!Array.isArray(entries)) throw new ToolPluginPackageError(`${patch} must be a top-level list`);
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (Array.isArray(entry.insert)) {
        if (typeof entry.id === 'string') continue;
        for (const item of entry.insert) {
          if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string' || item.group === true) continue;
          rows.push({
            id: item.id,
            name: item.name,
            entry: resolveRowEntry(root, manifest, item.name, dirname(file)),
            config: item.config,
            inject: stringList(item.inject),
            disabled: item.disabled === true,
          });
        }
        continue;
      }
      const target = typeof entry.id === 'string' ? rows.find(row => row.id === entry.id) : undefined;
      if (!target || (typeof entry.name === 'string' && entry.name !== target.name)) continue;
      if ('config' in entry) target.config = entry.config;
      if ('disabled' in entry) target.disabled = entry.disabled === true;
      if ('inject' in entry) target.inject = stringList(entry.inject);
    }
  }
  return rows;
}

function text(value: unknown): OpenDesignHostToolPluginText | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** `meta.title` and `meta.description` of the Harness locale files (`exports["./locale/<lang>.json"]`). */
function localeMeta(root: string, manifest: Json): { title?: Record<string, string>; description?: Record<string, string> } {
  const title: Record<string, string> = {};
  const description: Record<string, string> = {};
  for (const locale of LOCALES) {
    const file = existingFile(inside(root, resolveExport(manifest, `./locale/${locale}.json`) ?? `locale/${locale}.json`));
    if (!file) continue;
    try {
      const dict = readJson(file);
      if (!isRecord(dict)) continue;
      const meta = isRecord(dict.meta) ? dict.meta : {};
      const localeTitle = meta.title ?? dict.name;
      const localeDescription = meta.description ?? dict.description;
      if (typeof localeTitle === 'string' && localeTitle) title[locale] = localeTitle;
      if (typeof localeDescription === 'string' && localeDescription) description[locale] = localeDescription;
    } catch {
      // A broken locale file only costs the display text.
    }
  }
  return {
    ...(Object.keys(title).length > 0 ? { title } : {}),
    ...(Object.keys(description).length > 0 ? { description } : {}),
  };
}

function readIcon(root: string, target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined;
  const file = existingFile(inside(root, target));
  const type = file ? ICON_TYPES[extname(file).toLowerCase()] : undefined;
  if (!file || !type) return undefined;
  try {
    if (statSync(file).size > ICON_MAX_BYTES) return undefined;
    return `data:${type};base64,${readFileSync(file).toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** Reads the package at `root`. Throws `ToolPluginPackageError` when it is not a plugin package. */
export function readToolPluginPackage(root: string): ToolPluginPackage {
  let manifest: unknown;
  try {
    manifest = readJson(join(root, 'package.json'));
  } catch {
    throw new ToolPluginPackageError('No readable package.json in this folder');
  }
  if (!isRecord(manifest) || typeof manifest.name !== 'string' || !PACKAGE_NAME.test(manifest.name)) {
    throw new ToolPluginPackageError('package.json needs a valid "name"');
  }
  const fantay = isRecord(manifest.fantay) && isRecord(manifest.fantay.plugin) ? manifest.fantay.plugin : null;
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : null;
  const bundle = dsh && isRecord(dsh.bundle) ? dsh.bundle : null;
  const dshClient = dsh && isRecord(dsh.client) && dsh.client.platform === 'web';
  if (!fantay && !bundle && !dshClient) {
    throw new ToolPluginPackageError('package.json declares neither "fantay.plugin" nor a "dsh" bundle');
  }

  let rows: ToolPluginRow[] = [];
  if (bundle) {
    const patches = typeof bundle.patch === 'string' ? [bundle.patch] : stringList(bundle.patch);
    rows = readPatchRows(root, manifest, patches);
  } else if (fantay?.host !== false) {
    const entry = typeof fantay?.host === 'string' ? existingFile(inside(root, fantay.host)) : mainEntry(root, manifest);
    if (typeof fantay?.host === 'string' && !entry) throw new ToolPluginPackageError(`Host entry not found: ${fantay.host}`);
    if (entry) rows = [{ id: manifest.name, name: manifest.name, entry, config: fantay?.config, inject: [], disabled: false }];
  }

  const clientTarget = typeof fantay?.client === 'string' ? fantay.client : resolveExport(manifest, './client');
  const clientFile = clientTarget ? existingFile(inside(root, clientTarget)) : null;
  if (typeof fantay?.client === 'string' && !clientFile) throw new ToolPluginPackageError(`Client entry not found: ${fantay.client}`);
  if (rows.length === 0 && !clientFile) throw new ToolPluginPackageError('The package has no host entry and no client module');

  const locale = localeMeta(root, manifest);
  const title = text(fantay?.title) ?? locale.title;
  const description = text(fantay?.description) ?? locale.description ?? text(manifest.description);
  const icon = readIcon(root, fantay?.icon) ?? readIcon(root, manifest.icon) ?? readIcon(root, resolveExport(manifest, './icon'));
  return {
    id: manifest.name,
    root,
    flavor: fantay ? 'fantay' : 'dsh',
    rows,
    client: clientFile ? { file: clientFile, moduleId: manifest.name } : null,
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(typeof fantay?.shortcut === 'string' ? { shortcut: fantay.shortcut } : {}),
  };
}
