// Read-only view of the archive's generated index files.
//
// - `导览支持/search-index.json` (schema_version 1) holds one compact record per
//   asset. It is validated exactly like `Library.__init__` in
//   `素材库/导览支持/scripts/fantasy_design.py` and cached by mtime + size.
// - `导览支持/assets.jsonl` holds the full records. Like the archive CLI it is
//   streamed line by line and only the requested ids are kept, so large
//   records are never loaded wholesale; found records are cached per file
//   signature.

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type { MaterialLibraryRootSource } from '@open-design/contracts';

import {
  compareCodePoints,
  MATERIAL_SEARCH_META,
  materialSearchableText,
  normalizeMaterialText,
  type MaterialSearchMeta,
} from './discovery.js';
import { MaterialError, MaterialLibraryUnavailableError } from './errors.js';
import { MATERIAL_INDEX_FILE, MATERIAL_RECORDS_FILE, MATERIAL_SUPPORT_DIR } from './root.js';

/** Required string fields of every index record (`fantasy_design.py`, `required`). */
export const MATERIAL_REQUIRED_FIELDS = [
  'id',
  'title',
  'kind',
  'category',
  'collection',
  'path',
  'license',
] as const;

export type MaterialRecord = Record<string, unknown> & {
  id: string;
  title: string;
  kind: string;
  category: string;
  collection: string;
  path: string;
  license: string;
};

export interface MaterialCatalogFacets {
  categories: Record<string, number>;
  kinds: Record<string, number>;
  collections: Record<string, number>;
}

export interface MaterialCatalog {
  /** Realpath of the library root (the `素材库` folder). */
  root: string;
  /** Archive parent, or source root for app-generated folder indexes. */
  base: string;
  rootSource: MaterialLibraryRootSource;
  indexPath: string;
  recordsPath: string;
  indexUpdatedAt: string;
  /** Index records in index order. */
  records: MaterialRecord[];
  byId: Map<string, MaterialRecord>;
  childrenByParent: Map<string, string[]>;
  facets: MaterialCatalogFacets;
}

function signatureOf(info: { mtimeMs: number; size: number }): string {
  return `${info.mtimeMs}:${info.size}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateMaterialIndex(parsed: unknown): MaterialRecord[] {
  if (!isPlainObject(parsed) || parsed.schema_version !== 1 || !Array.isArray(parsed.assets)) {
    throw new MaterialLibraryUnavailableError('invalid-index', 'Unsupported search index schema');
  }
  const assets = parsed.assets as unknown[];
  for (const asset of assets) {
    if (!isPlainObject(asset) || MATERIAL_REQUIRED_FIELDS.some((key) => typeof asset[key] !== 'string')) {
      throw new MaterialLibraryUnavailableError('invalid-index', 'Invalid asset record in search index');
    }
  }
  const records = assets as MaterialRecord[];
  const ids = new Set(records.map((record) => record.id));
  if (ids.size !== records.length) {
    throw new MaterialLibraryUnavailableError('invalid-index', 'Duplicate asset IDs');
  }
  return records;
}

interface CachedIndex {
  key: string;
  catalog: MaterialCatalog;
}

interface CachedRecords {
  key: string;
  records: Map<string, Record<string, unknown>>;
}

const FULL_RECORD_CACHE_LIMIT = 512;

export class MaterialCatalogStore {
  private index: CachedIndex | null = null;
  private full: CachedRecords | null = null;

  /** Load (or reuse) the index of the library at `root`. */
  async load(root: string, rootSource: MaterialLibraryRootSource, indexDirectory?: string): Promise<MaterialCatalog> {
    const supportDir = indexDirectory ?? path.join(root, MATERIAL_SUPPORT_DIR);
    const indexPath = path.join(supportDir, MATERIAL_INDEX_FILE);
    const recordsPath = path.join(supportDir, MATERIAL_RECORDS_FILE);
    let info;
    try {
      info = await stat(indexPath);
    } catch {
      throw new MaterialLibraryUnavailableError(
        'missing-index',
        `Missing ${indexPath}. Rebuild it with \`mise run catalog\`.`,
      );
    }
    const key = `${indexPath}\0${signatureOf(info)}`;
    if (this.index?.key === key) {
      // Same file, maybe reached through a different env source label.
      if (this.index.catalog.rootSource !== rootSource) {
        this.index = { key, catalog: { ...this.index.catalog, rootSource } };
      }
      return this.index.catalog;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(indexPath, 'utf8'));
    } catch (error) {
      throw new MaterialLibraryUnavailableError(
        'invalid-index',
        `Cannot read ${MATERIAL_INDEX_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const records = validateMaterialIndex(parsed);
    const byId = new Map<string, MaterialRecord>();
    const childrenByParent = new Map<string, string[]>();
    const categoryCounts = new Map<string, number>();
    const kindCounts = new Map<string, number>();
    const collectionCounts = new Map<string, number>();
    for (const record of records) {
      byId.set(record.id, record);
      categoryCounts.set(record.category, (categoryCounts.get(record.category) ?? 0) + 1);
      kindCounts.set(record.kind, (kindCounts.get(record.kind) ?? 0) + 1);
      collectionCounts.set(record.collection, (collectionCounts.get(record.collection) ?? 0) + 1);
      const meta: MaterialSearchMeta = {
        haystack: materialSearchableText(record),
        titleNorm: normalizeMaterialText(record.title),
        titleLower: record.title.toLowerCase(),
      };
      Object.defineProperty(record, MATERIAL_SEARCH_META, {
        value: meta,
        enumerable: false,
        configurable: true,
      });
      const parentId = record.parent_id;
      if (typeof parentId === 'string' && parentId) {
        const siblings = childrenByParent.get(parentId);
        if (siblings) siblings.push(record.id);
        else childrenByParent.set(parentId, [record.id]);
      }
    }
    const sortedRecord = (counts: Map<string, number>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const name of [...counts.keys()].sort(compareCodePoints)) out[name] = counts.get(name)!;
      return out;
    };
    const catalog: MaterialCatalog = {
      root,
      base: indexDirectory ? root : path.dirname(root),
      rootSource,
      indexPath,
      recordsPath,
      indexUpdatedAt: new Date(info.mtimeMs).toISOString(),
      records,
      byId,
      childrenByParent,
      facets: {
        categories: sortedRecord(categoryCounts),
        kinds: sortedRecord(kindCounts),
        collections: sortedRecord(collectionCounts),
      },
    };
    this.index = { key, catalog };
    return catalog;
  }

  /**
   * Full records for `ids` from `assets.jsonl` (streamed, first match wins,
   * like `Library.get(full=True)`). Every id must already exist in the index.
   */
  async fullRecords(catalog: MaterialCatalog, ids: readonly string[]): Promise<Map<string, MaterialRecord>> {
    let info;
    try {
      info = await stat(catalog.recordsPath);
    } catch {
      throw new MaterialLibraryUnavailableError(
        'missing-index',
        `Missing ${catalog.recordsPath}. Rebuild it with \`mise run catalog\`.`,
      );
    }
    const key = `${catalog.recordsPath}\0${signatureOf(info)}`;
    if (this.full?.key !== key) this.full = { key, records: new Map() };
    const cache = this.full.records;
    const wanted = new Set(ids.filter((id) => !cache.has(id)));
    if (wanted.size > 0) {
      const found = await streamRecords(catalog.recordsPath, wanted);
      for (const [id, record] of found) {
        if (cache.size >= FULL_RECORD_CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(id, record);
      }
    }
    const out = new Map<string, MaterialRecord>();
    for (const id of ids) {
      const record = cache.get(id);
      if (!record) {
        throw new MaterialError(
          'library-unavailable',
          503,
          `ID missing from ${MATERIAL_RECORDS_FILE}: ${id}; rebuild the catalog with \`mise run catalog\`.`,
        );
      }
      out.set(id, mergeFullRecord(catalog.byId.get(id), record));
    }
    return out;
  }
}

/**
 * The archive CLI uses the full record as-is. Required display fields fall
 * back to the validated index record so a malformed full line cannot produce
 * non-string titles or paths.
 */
function mergeFullRecord(
  indexRecord: MaterialRecord | undefined,
  full: Record<string, unknown>,
): MaterialRecord {
  const merged: Record<string, unknown> = { ...full };
  for (const key of MATERIAL_REQUIRED_FIELDS) {
    if (typeof merged[key] !== 'string') merged[key] = indexRecord?.[key] ?? '';
  }
  return merged as MaterialRecord;
}

async function streamRecords(
  recordsPath: string,
  wanted: Set<string>,
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  const input = createReadStream(recordsPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let candidate: unknown;
      try {
        candidate = JSON.parse(line);
      } catch {
        throw new MaterialError('library-unavailable', 503, `Invalid record in ${MATERIAL_RECORDS_FILE}`);
      }
      if (!isPlainObject(candidate) || typeof candidate.id !== 'string') {
        throw new MaterialError('library-unavailable', 503, `Invalid record in ${MATERIAL_RECORDS_FILE}`);
      }
      if (wanted.has(candidate.id) && !found.has(candidate.id)) {
        found.set(candidate.id, candidate);
        if (found.size === wanted.size) break;
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return found;
}
