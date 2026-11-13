// Read-only material library service behind `/api/materials/*`.
//
// One instance per daemon (created at route registration, never at module
// scope). The library root is re-resolved on every call; the parsed index is
// cached by file signature inside the instance.

import { open as openFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  MaterialContextResponse,
  MaterialDetail,
  MaterialDetailResponse,
  MaterialLibraryStatus,
  MaterialLibraryRootSource,
  MaterialSearchResponse,
  MaterialSummaryResponse,
} from '@open-design/contracts';
import {
  MATERIAL_CONTEXT_MAX_IDS,
  MATERIAL_NOTICE,
  MATERIAL_SEARCH_DEFAULT_LIMIT,
} from '@open-design/contracts';

import { MaterialCatalogStore, type MaterialCatalog, type MaterialRecord } from './catalog.js';
import { renderMaterialContextMarkdown } from './context-markdown.js';
import {
  compareBrowseMaterials,
  compareRankedMaterials,
  MATERIAL_SEARCH_META,
  prepareMaterialQuery,
  scoreMaterialPrepared,
  type MaterialSearchMeta,
} from './discovery.js';
import { toMaterialDetail, toMaterialSummaryItem } from './dto.js';
import {
  MaterialError,
  MaterialLibraryUnavailableError,
  invalidRequest,
  missingFile,
  unknownId,
  unsafePath,
} from './errors.js';
import { assertNoSymlinkSegments, assertRealInside, resolveIndexedPath } from './paths.js';
import { resolveMaterialLibraryRoot, type MaterialLibraryRootInput } from './root.js';

/** Image types served by the thumbnail route, by lowercase extension. */
export const MATERIAL_THUMBNAIL_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/** Thumbnails above this size are refused (the archive's largest is ~0.6 MB). */
export const MATERIAL_THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Raster type from magic bytes. The archive has screenshots saved as JPEG
 * under a `.png` name; with `nosniff` the declared type should be truthful.
 * Only switches between raster types — never to SVG.
 */
export function sniffRasterImageType(head: Uint8Array): string | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  if (head.length >= 8 && head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 12 && ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'image/avif';
  return null;
}

async function readHead(file: string, bytes: number): Promise<Uint8Array> {
  const handle = await openFile(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function matchesMaterialCategory(recordCategory: string, queryCategory: string): boolean {
  if (recordCategory === queryCategory) return true;
  if (queryCategory === '组件') {
    return recordCategory === '交互组件' || recordCategory === 'AI 组件';
  }
  if (queryCategory === '模板与资料') {
    return recordCategory === '页面模板' || recordCategory === '参考资料';
  }
  return false;
}

export interface MaterialSearchParams {
  libraryId?: string;
  q?: string;
  category?: string;
  kind?: string;
  collection?: string;
  section?: string;
  limit?: number;
  offset?: number;
}

export interface MaterialThumbnailFile {
  absolutePath: string;
  contentType: string;
  size: number;
  isSvg: boolean;
}

export interface MaterialsServiceOptions extends Partial<Omit<MaterialLibraryRootInput, 'dataRoots'>> {
  dataRoots: readonly string[];
  rootSource?: MaterialLibraryRootSource;
}

export interface MaterialsService {
  status(): Promise<MaterialLibraryStatus>;
  summary(libraryId?: string): Promise<MaterialSummaryResponse>;
  search(params: MaterialSearchParams): Promise<MaterialSearchResponse>;
  detail(id: string): Promise<MaterialDetailResponse>;
  details?(ids: readonly string[]): Promise<MaterialDetail[]>;
  context(ids: readonly string[], task: string): Promise<MaterialContextResponse>;
  thumbnail(id: string): Promise<MaterialThumbnailFile>;
  /** The open catalog plus the full record of `id`, for apply. */
  openRecord(id: string): Promise<{ catalog: MaterialCatalog; record: MaterialRecord }>;
  /** The open catalog; throws `library-unavailable` with a reason. */
  open(): Promise<MaterialCatalog>;
  /** Every connected archive is read-only, including when another archive is the copy source. */
  libraryRoots?(): Promise<string[]>;
}

export function createMaterialsService(options: MaterialsServiceOptions): MaterialsService {
  const store = new MaterialCatalogStore();
  const rootInput = (): MaterialLibraryRootInput => ({
    env: options.env ?? process.env,
    projectRoot: options.projectRoot ?? null,
    packaged: options.packaged ?? false,
    dataRoots: options.dataRoots,
    ...(options.indexDirectory ? { indexDirectory: options.indexDirectory } : {}),
  });

  async function open(): Promise<MaterialCatalog> {
    const resolution = resolveMaterialLibraryRoot(rootInput());
    if (!resolution.ok) throw new MaterialLibraryUnavailableError(resolution.reason, resolution.message);
    return store.load(resolution.root, options.rootSource ?? resolution.source, options.indexDirectory);
  }

  async function statusWithCatalog(): Promise<{ status: MaterialLibraryStatus; catalog: MaterialCatalog | null }> {
    const resolution = resolveMaterialLibraryRoot(rootInput());
    if (!resolution.ok) {
      return {
        status: {
          enabled: false,
          root: resolution.root,
          rootSource: resolution.source,
          reason: resolution.reason,
          message: resolution.message,
        },
        catalog: null,
      };
    }
    try {
      const catalog = await store.load(resolution.root, options.rootSource ?? resolution.source, options.indexDirectory);
      return {
        status: {
          enabled: true,
          root: catalog.root,
          rootSource: catalog.rootSource,
          indexUpdatedAt: catalog.indexUpdatedAt,
        },
        catalog,
      };
    } catch (error) {
      if (error instanceof MaterialLibraryUnavailableError) {
        return {
          status: {
            enabled: false,
            root: resolution.root,
            rootSource: resolution.source,
            reason: error.reason,
            message: error.message,
          },
          catalog: null,
        };
      }
      throw error;
    }
  }

  async function status(): Promise<MaterialLibraryStatus> {
    return (await statusWithCatalog()).status;
  }

  function lookup(catalog: MaterialCatalog, id: string): MaterialRecord {
    const record = catalog.byId.get(id);
    if (!record) throw unknownId(id);
    return record;
  }

  async function openRecord(id: string) {
    const catalog = await open();
    lookup(catalog, id);
    const record = (await store.fullRecords(catalog, [id])).get(id)!;
    return { catalog, record };
  }

  async function details(ids: readonly string[]): Promise<MaterialDetail[]> {
    if (ids.length === 0) return [];
    const catalog = await open();
    for (const id of ids) lookup(catalog, id);
    const records = await store.fullRecords(catalog, ids);
    return Promise.all(ids.map((id) => toMaterialDetail(catalog, records.get(id)!)));
  }

  return {
    open,
    status,
    openRecord,
    details,

    async summary() {
      const { status: libraryStatus, catalog } = await statusWithCatalog();
      if (!libraryStatus.enabled || !catalog) {
        return { status: libraryStatus, total: 0, categories: {}, kinds: {}, collections: {}, notice: MATERIAL_NOTICE };
      }
      return {
        status: libraryStatus,
        total: catalog.records.length,
        categories: catalog.facets.categories,
        kinds: catalog.facets.kinds,
        collections: catalog.facets.collections,
        notice: MATERIAL_NOTICE,
      };
    },

    async search(params) {
      const catalog = await open();
      const query = params.q ?? '';
      const prepared = prepareMaterialQuery(query);
      const limit = params.limit ?? MATERIAL_SEARCH_DEFAULT_LIMIT;
      const offset = params.offset ?? 0;
      const ranked: Array<{ score: number; kind: string; title: string; titleLower: string; id: string; record: MaterialRecord }> = [];
      for (const record of catalog.records) {
        if (params.category && !matchesMaterialCategory(record.category, params.category)) continue;
        if (params.kind && record.kind !== params.kind) continue;
        if (params.collection && record.collection !== params.collection) continue;
        if (params.section && record.section !== params.section) continue;
        const score = scoreMaterialPrepared(record, prepared);
        if (score) {
          const titleLower = (record as Record<symbol, MaterialSearchMeta | undefined>)[MATERIAL_SEARCH_META]?.titleLower ?? record.title.toLowerCase();
          ranked.push({ score, kind: record.kind, title: record.title, titleLower, id: record.id, record });
        }
      }
      ranked.sort(prepared.length === 0 ? compareBrowseMaterials : compareRankedMaterials);
      const end = offset + limit;
      const page = ranked.slice(offset, end);
      return {
        query,
        total: ranked.length,
        offset,
        returned: page.length,
        nextOffset: end < ranked.length ? end : null,
        items: page.map((entry) => toMaterialSummaryItem(entry.record)),
        notice: MATERIAL_NOTICE,
      };
    },

    async detail(id) {
      const { catalog, record } = await openRecord(id);
      return { item: await toMaterialDetail(catalog, record), notice: MATERIAL_NOTICE };
    },

    async context(rawIds, task) {
      const ids = [...new Set(rawIds)];
      if (ids.length === 0) throw invalidRequest('Select at least one ID.');
      if (ids.length > MATERIAL_CONTEXT_MAX_IDS) {
        throw invalidRequest(`Select at most ${MATERIAL_CONTEXT_MAX_IDS} IDs per packet.`);
      }
      const items = await details(ids);
      return { ids, markdown: renderMaterialContextMarkdown(task, items, MATERIAL_NOTICE), notice: MATERIAL_NOTICE };
    },

    async thumbnail(id) {
      const catalog = await open();
      const record = lookup(catalog, id);
      const relative = record.thumbnail;
      if (typeof relative !== 'string' || !relative) throw missingFile(`${id} has no indexed thumbnail`);
      const extension = path.posix.extname(relative).toLowerCase();
      const contentType = MATERIAL_THUMBNAIL_TYPES[extension];
      if (!contentType) throw unsafePath(`Thumbnail type is not served: ${extension || '(none)'}`);
      const absolutePath = resolveIndexedPath(catalog, relative);
      await assertNoSymlinkSegments(absolutePath, catalog.root, relative);
      await assertRealInside(absolutePath, catalog.root, relative);
      let info;
      try {
        info = await stat(absolutePath);
      } catch {
        throw missingFile(`Missing local file: ${relative}`);
      }
      if (!info.isFile()) throw missingFile(`Thumbnail is not a regular file: ${relative}`);
      if (info.size > MATERIAL_THUMBNAIL_MAX_BYTES) {
        throw new MaterialError(
          'invalid-request',
          413,
          `Thumbnail exceeds ${MATERIAL_THUMBNAIL_MAX_BYTES} bytes: ${relative}`,
        );
      }
      const isSvg = extension === '.svg';
      let servedType = contentType;
      if (!isSvg) {
        try {
          servedType = sniffRasterImageType(await readHead(absolutePath, 16)) ?? contentType;
        } catch {
          throw missingFile(`Missing local file: ${relative}`);
        }
      }
      return { absolutePath, contentType: servedType, size: info.size, isSvg };
    },
  };
}
