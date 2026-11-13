// Saved references to external archives. Only this registry belongs to daemon
// data; adding/removing a reference never modifies the archive itself.
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  MaterialDetail, MaterialLibrary, MaterialLibrariesResponse, MaterialSummaryItem,
  MaterialSummaryResponse,
} from '@open-design/contracts';
import { MATERIAL_CONTEXT_MAX_IDS, MATERIAL_NOTICE, MATERIAL_SEARCH_DEFAULT_LIMIT } from '@open-design/contracts';
import { expandHomePrefix } from '../home-expansion.js';
import { renderMaterialContextMarkdown } from './context-markdown.js';
import {
  compareBrowseMaterials,
  compareRankedMaterials,
  MATERIAL_SEARCH_META,
  prepareMaterialQuery,
  scoreMaterialPrepared,
  type MaterialSearchMeta,
} from './discovery.js';
import { toMaterialSummaryItem } from './dto.js';
import { invalidRequest, MaterialLibraryUnavailableError, unknownId } from './errors.js';
import { createMaterialsService, matchesMaterialCategory, type MaterialsService, type MaterialsServiceOptions } from './service.js';
import { MATERIAL_INDEX_FILE, MATERIAL_SUPPORT_DIR, resolveMaterialLibraryRoot } from './root.js';
import { scanMaterialFolder } from './scan.js';

interface SavedLibrary {
  id: string; name: string; root: string;
  kind?: 'archive' | 'folder'; generation?: string; scannedAt?: string;
}
interface Registry { libraries: SavedLibrary[]; hiddenRoots: string[] }
interface LibraryEntry { library: MaterialLibrary; service: MaterialsService }

export interface MaterialLibrariesService extends MaterialsService {
  libraries(): Promise<MaterialLibrariesResponse>;
  addLibrary(root: string, name?: string): Promise<MaterialLibrary>;
  removeLibrary(id: string): Promise<void>;
  scanLibrary(id: string): Promise<MaterialLibrary>;
}

const qualifiedId = (libraryId: string, id: string) => libraryId === 'default' ? id : `${libraryId}:${id}`;

function projectItem<T extends MaterialSummaryItem>(item: T, library: MaterialLibrary): T {
  const id = qualifiedId(library.id, item.id);
  return {
    ...item, id, libraryId: library.id, libraryName: library.name,
    ...(item.parentId ? { parentId: qualifiedId(library.id, item.parentId) } : {}),
    thumbnailUrl: item.thumbnailUrl ? `/api/materials/items/${encodeURIComponent(id)}/thumbnail` : null,
  };
}

function projectDetail(item: MaterialDetail, library: MaterialLibrary): MaterialDetail {
  return { ...projectItem(item, library), children: item.children.map((id) => qualifiedId(library.id, id)) };
}

export function createMaterialLibrariesService(
  options: MaterialsServiceOptions & { dataDir: string },
): MaterialLibrariesService {
  const registryPath = path.join(options.dataDir, 'material-libraries.json');
  const fallback = createMaterialsService(options);
  const services = new Map<string, MaterialsService>();
  let writes: Promise<unknown> = Promise.resolve();
  let cachedRegistry: { sig: string; value: Registry } | null = null;
  const scans = new Map<string, ReturnType<typeof scanMaterialFolder>>();

  async function readRegistry(): Promise<Registry> {
    let info;
    try { info = await stat(registryPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        cachedRegistry = null;
        return { libraries: [], hiddenRoots: [] };
      }
      throw error;
    }
    const sig = `${info.mtimeMs}:${info.size}`;
    if (cachedRegistry?.sig === sig) return cachedRegistry.value;
    const raw = await readFile(registryPath, 'utf8');
    const value = JSON.parse(raw) as Registry;
    if (!Array.isArray(value.libraries) || !Array.isArray(value.hiddenRoots)
      || value.libraries.some((entry) => !entry || !/^library_[a-f0-9]{20}$/.test(entry.id)
        || typeof entry.name !== 'string' || typeof entry.root !== 'string' || !path.isAbsolute(entry.root)
        || (entry.kind !== undefined && entry.kind !== 'archive' && entry.kind !== 'folder')
        || (entry.kind === 'folder' && (typeof entry.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.generation))))
      || value.hiddenRoots.some((entry) => typeof entry !== 'string')) {
      throw invalidRequest('Saved material library settings are invalid.');
    }
    cachedRegistry = { sig, value };
    return value;
  }

  function mutate<T>(change: (registry: Registry) => Promise<T>): Promise<T> {
    const result = writes.then(async () => {
      const current = await readRegistry();
      const registry: Registry = {
        libraries: current.libraries.map((entry) => ({ ...entry })),
        hiddenRoots: [...current.hiddenRoots],
      };
      const output = await change(registry);
      await mkdir(options.dataDir, { recursive: true });
      const temporary = `${registryPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(registry, null, 2), { mode: 0o600 });
      await rename(temporary, registryPath);
      cachedRegistry = null;
      return output;
    });
    writes = result.catch(() => undefined);
    return result;
  }

  function serviceFor(entry: SavedLibrary): MaterialsService {
    const key = `${entry.root}:${entry.generation ?? 'archive'}`;
    const cached = services.get(key);
    if (cached) return cached;
    const indexDirectory = entry.kind === 'folder'
      ? path.join(options.dataDir, 'material-indexes', entry.id, entry.generation!) : undefined;
    const service = createMaterialsService({ ...options, rootSource: 'selected', ...(indexDirectory ? { indexDirectory } : {}),
      env: { FANTASY_DESIGN_LIBRARY: entry.root } });
    services.set(key, service);
    return service;
  }

  function scan(root: string, id: string) {
    let pending = scans.get(root);
    if (!pending) {
      pending = scanMaterialFolder(root, path.join(options.dataDir, 'material-indexes', id));
      scans.set(root, pending);
      void pending.finally(() => scans.delete(root)).catch(() => undefined);
    }
    return pending;
  }

  async function entriesWithSummaries(): Promise<Array<LibraryEntry & { summary: MaterialSummaryResponse }>> {
    await writes;
    const registry = await readRegistry();
    const result: Array<LibraryEntry & { summary: MaterialSummaryResponse }> = await Promise.all(registry.libraries.map(async (entry) => {
      const service = serviceFor(entry);
      const itemSummary = await service.summary();
      const status = { ...itemSummary.status, rootSource: 'selected' as const };
      return {
        service,
        summary: { ...itemSummary, status },
        library: { ...entry, status, total: itemSummary.total },
      };
    }));
    const fallbackSummary = await fallback.summary();
    const root = fallbackSummary.status.root;
    if (root && !registry.hiddenRoots.includes(root) && !result.some((entry) => entry.library.root === root)) {
      result.unshift({
        service: fallback,
        summary: fallbackSummary,
        library: {
          id: 'default',
          name: path.basename(root),
          root,
          status: fallbackSummary.status,
          total: fallbackSummary.total,
        },
      });
    }
    return result;
  }

  async function entries(): Promise<LibraryEntry[]> {
    return (await entriesWithSummaries()).map(({ service, library }) => ({ service, library }));
  }

  async function selected(libraryId?: string): Promise<LibraryEntry[]> {
    const all = await entries();
    if (!libraryId) return all;
    const match = all.find((entry) => entry.library.id === libraryId);
    if (!match) throw invalidRequest('Material library is no longer connected.');
    return [match];
  }

  async function resolveItem(id: string): Promise<{ entry: LibraryEntry; rawId: string }> {
    await writes;
    const registry = await readRegistry();
    const match = /^(library_[a-f0-9]{20}):(.*)$/s.exec(id);
    if (match) {
      const saved = registry.libraries.find((value) => value.id === match[1]);
      if (!saved) throw unknownId(id);
      const service = serviceFor(saved);
      return {
        entry: {
          service,
          library: { ...saved, status: { enabled: true, root: saved.root, rootSource: 'selected' }, total: 0 },
        },
        rawId: match[2]!,
      };
    }
    const fallbackStatus = await fallback.status();
    const root = fallbackStatus.root;
    if (root) {
      // An explicitly connected automatic library gains a stable qualified ID.
      // Previously saved raw references must still resolve to that same root.
      const saved = registry.libraries.find((value) => value.root === root);
      if (saved) {
        return {
          entry: {
            service: serviceFor(saved),
            library: { ...saved, status: { ...fallbackStatus, rootSource: 'selected' }, total: 0 },
          },
          rawId: id,
        };
      }
      if (!registry.hiddenRoots.includes(root)) {
        return {
          entry: {
            service: fallback,
            library: { id: 'default', name: path.basename(root), root, status: fallbackStatus, total: 0 },
          },
          rawId: id,
        };
      }
    }
    throw unknownId(id);
  }

  async function summary(libraryId?: string): Promise<MaterialSummaryResponse> {
    const all = await entriesWithSummaries();
    const active = libraryId ? all.filter((entry) => entry.library.id === libraryId) : all;
    const summaries = active.map((entry) => entry.summary);
    const available = summaries.filter((value) => value.status.enabled);
    const counts = (key: 'categories' | 'kinds' | 'collections') => {
      const result: Record<string, number> = {};
      for (const value of available) for (const [name, count] of Object.entries(value[key])) {
        Object.defineProperty(result, name, { value: (Object.hasOwn(result, name) ? result[name]! : 0) + count,
          enumerable: true, configurable: true, writable: true });
      }
      return result;
    };
    const status = available[0]?.status ?? summaries[0]?.status ?? {
      enabled: false, root: null, rootSource: null, reason: 'not-configured' as const,
    };
    return { libraryId: libraryId ?? '', status: available.length > 1 ? { enabled: true, root: null, rootSource: null } : status,
      total: available.reduce((sum, value) => sum + value.total, 0), categories: counts('categories'),
      kinds: counts('kinds'), collections: counts('collections'), notice: MATERIAL_NOTICE,
      libraries: all.map((entry) => entry.library) };
  }

  return {
    summary,
    async status() { return (await summary()).status; },
    async libraries() { return { libraries: (await entries()).map((entry) => entry.library) }; },
    async addLibrary(rawRoot, rawName) {
      const root = expandHomePrefix(rawRoot.trim());
      if (!path.isAbsolute(root)) throw invalidRequest('Choose an absolute material library folder path.');
      const resolution = resolveMaterialLibraryRoot({ env: { FANTASY_DESIGN_LIBRARY: root },
        projectRoot: null, packaged: true, dataRoots: options.dataRoots, requireIndex: false });
      if (!resolution.ok) throw new MaterialLibraryUnavailableError(resolution.reason, resolution.message);
      const entry: SavedLibrary = { id: `library_${createHash('sha256').update(resolution.root).digest('hex').slice(0, 20)}`,
        name: rawName?.trim().slice(0, 100) || path.basename(resolution.root), root: resolution.root, kind: 'archive' };
      const hasArchive = await access(path.join(entry.root, MATERIAL_SUPPORT_DIR, MATERIAL_INDEX_FILE)).then(() => true, () => false);
      if (!hasArchive) {
        const generated = await scan(entry.root, entry.id);
        entry.kind = 'folder'; entry.generation = generated.generation; entry.scannedAt = generated.scannedAt;
      }
      const service = serviceFor(entry);
      await service.open();
      await mutate(async (registry) => {
        const existing = registry.libraries.find((value) => value.root === entry.root);
        if (!existing) registry.libraries.push(entry);
        else { entry.name = rawName?.trim().slice(0, 100) || existing.name; Object.assign(existing, entry); }
        registry.hiddenRoots = registry.hiddenRoots.filter((value) => value !== entry.root);
      });
      const state = await service.summary();
      return { ...entry, status: { ...state.status, rootSource: 'selected' }, total: state.total };
    },
    async scanLibrary(id) {
      await writes;
      const saved = (await readRegistry()).libraries.find((entry) => entry.id === id);
      if (!saved) throw invalidRequest('Material library is no longer connected.');
      if (saved.kind === 'folder') {
        const resolution = resolveMaterialLibraryRoot({ env: { FANTASY_DESIGN_LIBRARY: saved.root },
          projectRoot: null, packaged: true, dataRoots: options.dataRoots, requireIndex: false });
        if (!resolution.ok) throw new MaterialLibraryUnavailableError(resolution.reason, resolution.message);
        const generated = await scan(resolution.root, id);
        await mutate(async (registry) => {
          const current = registry.libraries.find((entry) => entry.id === id);
          if (!current) throw invalidRequest('Material library is no longer connected.');
          current.generation = generated.generation; current.scannedAt = generated.scannedAt;
        });
        services.clear();
      }
      return (await entries()).find((entry) => entry.library.id === id)!.library;
    },
    async removeLibrary(id) {
      const entry = (await entries()).find((value) => value.library.id === id);
      if (!entry) throw invalidRequest('Material library is no longer connected.');
      await mutate(async (registry) => {
        registry.libraries = registry.libraries.filter((value) => value.id !== id);
        if (!registry.hiddenRoots.includes(entry.library.root)) registry.hiddenRoots.push(entry.library.root);
      });
      services.clear();
    },
    async open() {
      const entry = (await entries()).find((value) => value.library.status.enabled);
      if (!entry) throw new MaterialLibraryUnavailableError('not-configured', 'Add a material library folder first.');
      return entry.service.open();
    },
    async libraryRoots() { return (await entries()).map((entry) => entry.library.root); },
    async openRecord(id) {
      const { entry, rawId } = await resolveItem(id);
      return entry.service.openRecord(rawId);
    },
    async search(params) {
      const selectedEntries = await selected(params.libraryId);
      const available = selectedEntries.filter((entry) => entry.library.status.enabled);
      if (available.length === 0) throw new MaterialLibraryUnavailableError('not-configured', 'No connected material library is available.');
      const query = params.q ?? '';
      const prepared = prepareMaterialQuery(query);
      const ranked = [];
      for (const entry of available) {
        const catalog = await entry.service.open();
        for (const record of catalog.records) {
          if (params.kind && record.kind !== params.kind) continue;
          if (params.category && !matchesMaterialCategory(record.category, params.category)) continue;
          if (params.collection && record.collection !== params.collection) continue;
          if (params.section && record.section !== params.section) continue;
          const score = scoreMaterialPrepared(record, prepared);
          if (score) {
            const titleLower = (record as Record<symbol, MaterialSearchMeta | undefined>)[MATERIAL_SEARCH_META]?.titleLower ?? record.title.toLowerCase();
            ranked.push({
              score,
              kind: record.kind,
              title: record.title,
              titleLower,
              id: qualifiedId(entry.library.id, record.id),
              record,
              library: entry.library,
            });
          }
        }
      }
      ranked.sort(prepared.length === 0 ? compareBrowseMaterials : compareRankedMaterials);
      const offset = params.offset ?? 0;
      const end = offset + (params.limit ?? MATERIAL_SEARCH_DEFAULT_LIMIT);
      const items = ranked.slice(offset, end).map((value) => projectItem(toMaterialSummaryItem(value.record), value.library));
      return { query, total: ranked.length, offset, returned: items.length,
        nextOffset: end < ranked.length ? end : null, items, notice: MATERIAL_NOTICE };
    },
    async detail(id) {
      const { entry, rawId } = await resolveItem(id);
      const detail = await entry.service.detail(rawId);
      return { ...detail, item: projectDetail(detail.item, entry.library) };
    },
    async thumbnail(id) {
      const { entry, rawId } = await resolveItem(id);
      return entry.service.thumbnail(rawId);
    },
    async context(rawIds, task) {
      const ids = [...new Set(rawIds)];
      if (!ids.length || ids.length > MATERIAL_CONTEXT_MAX_IDS) throw invalidRequest(`Select 1..${MATERIAL_CONTEXT_MAX_IDS} IDs.`);
      const resolved = await Promise.all(ids.map((id) => resolveItem(id)));
      const byLibrary = new Map<string, { entry: LibraryEntry; rawIds: string[]; indexes: number[] }>();
      resolved.forEach(({ entry, rawId }, index) => {
        let group = byLibrary.get(entry.library.id);
        if (!group) byLibrary.set(entry.library.id, (group = { entry, rawIds: [], indexes: [] }));
        group.rawIds.push(rawId);
        group.indexes.push(index);
      });
      const items = new Array<MaterialDetail>(ids.length);
      await Promise.all([...byLibrary.values()].map(async ({ entry, rawIds: groupIds, indexes }) => {
        const fetched = entry.service.details
          ? await entry.service.details(groupIds)
          : await Promise.all(groupIds.map(async (rawId) => (await entry.service.detail(rawId)).item));
        fetched.forEach((detail, idx) => {
          items[indexes[idx]!] = projectDetail(detail, entry.library);
        });
      }));
      return { ids, markdown: renderMaterialContextMarkdown(task, items, MATERIAL_NOTICE), notice: MATERIAL_NOTICE };
    },
  };
}
