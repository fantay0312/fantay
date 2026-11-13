// snake_case archive records → camelCase contract DTOs.

import type {
  MaterialCapabilities,
  MaterialDetail,
  MaterialFileField,
  MaterialFileRef,
  MaterialPaletteColor,
  MaterialSummaryItem,
  MaterialUse,
} from '@open-design/contracts';
import { MATERIAL_FILE_FIELDS } from '@open-design/contracts';

import type { MaterialCatalog, MaterialRecord } from './catalog.js';
import { deriveMaterialCapabilities } from './discovery.js';
import {
  assertRealInside,
  isRegularFile,
  materialCollectionRoot,
  resolveIndexedPath,
  toPosixRelative,
} from './paths.js';

const MATERIAL_USES: readonly MaterialUse[] = ['source_file', 'local_reference', 'website_record'];

export function materialThumbnailUrl(id: string): string {
  return `/api/materials/items/${encodeURIComponent(id)}/thumbnail`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function mapPalette(value: unknown): MaterialPaletteColor[] {
  if (!Array.isArray(value)) return [];
  const out: MaterialPaletteColor[] = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object') {
      const { name, value: color } = entry as Record<string, unknown>;
      if (typeof name === 'string' && typeof color === 'string') out.push({ name, value: color });
    }
  }
  return out;
}

function mapCapabilities(record: MaterialRecord): MaterialCapabilities {
  const raw = record.capabilities;
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : deriveMaterialCapabilities(record);
  const fallback = deriveMaterialCapabilities(record);
  const material = MATERIAL_USES.includes(source.material as MaterialUse)
    ? (source.material as MaterialUse)
    : fallback.material;
  return {
    material,
    previewEntry: Boolean(source.preview_entry),
    designTokens: Boolean(source.design_tokens),
    sourceManifest: Boolean(source.source_manifest),
    licenseDocument: Boolean(source.license_document),
  };
}

/** Website records are bookmarks: never copied, only referenced. */
export function isWebsiteRecord(record: MaterialRecord): boolean {
  return record.kind === 'website' || mapCapabilities(record).material === 'website_record';
}

export function toMaterialSummaryItem(record: MaterialRecord): MaterialSummaryItem {
  const item: MaterialSummaryItem = {
    id: record.id,
    title: record.title,
    kind: record.kind,
    category: record.category,
    collection: record.collection,
    description: typeof record.description === 'string' ? record.description : '',
    tags: stringArray(record.tags),
    license: record.license,
    palette: mapPalette(record.palette),
    capabilities: mapCapabilities(record),
    thumbnailUrl: optionalString(record.thumbnail) ? materialThumbnailUrl(record.id) : null,
  };
  const subtitle = optionalString(record.subtitle);
  if (subtitle) item.subtitle = subtitle;
  const section = optionalString(record.section);
  if (section) item.section = section;
  const status = optionalString(record.status);
  if (status) item.status = status;
  const useStatus = optionalString(record.use_status);
  if (useStatus) item.useStatus = useStatus;
  const source = optionalString(record.source);
  if (source) item.source = source;
  const previewKind = optionalString(record.preview_kind);
  if (previewKind) item.previewKind = previewKind;
  const previewNote = optionalString(record.preview_note);
  if (previewNote) item.previewNote = previewNote;
  const parentId = optionalString(record.parent_id);
  if (parentId) item.parentId = parentId;
  return item;
}

/** Indexed files in `MATERIAL_FILE_FIELDS` order (`fantasy_design.py` `FIELDS`). */
export async function materialFileRefs(
  catalog: MaterialCatalog,
  record: MaterialRecord,
): Promise<MaterialFileRef[]> {
  const refs: MaterialFileRef[] = [];
  for (const field of MATERIAL_FILE_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || !value) continue;
    const absolutePath = resolveIndexedPath(catalog, value);
    await assertRealInside(absolutePath, catalog.root, value);
    refs.push({
      field: field as MaterialFileField,
      relativePath: toPosixRelative(catalog.root, absolutePath),
      absolutePath,
      exists: await isRegularFile(absolutePath),
    });
  }
  return refs;
}

/**
 * Detail projection of a full (`assets.jsonl`) record. Like `show` in the
 * archive CLI, an indexed path that leaves the library fails the whole
 * record with `unsafe-path`.
 */
export async function toMaterialDetail(catalog: MaterialCatalog, record: MaterialRecord): Promise<MaterialDetail> {
  const absolutePath = resolveIndexedPath(catalog, record.path);
  await assertRealInside(absolutePath, catalog.root, record.path);
  const files = await materialFileRefs(catalog, record);
  const collectionRoot = await materialCollectionRoot(catalog, record);
  const detail: MaterialDetail = {
    ...toMaterialSummaryItem(record),
    absolutePath,
    collectionRoot,
    files,
    children: [...(catalog.childrenByParent.get(record.id) ?? [])],
  };
  const subcategories = stringArray(record.subcategories);
  if (subcategories.length > 0) detail.subcategories = subcategories;
  const notes = optionalString(record.notes);
  if (notes) detail.notes = notes;
  return detail;
}

const COMPACT_KEYS = [
  'id', 'title', 'subtitle', 'kind', 'category', 'collection', 'section',
  'description', 'tags', 'subcategories', 'path', 'document', 'preview',
  'tokens', 'source_manifest', 'license', 'license_document', 'source',
  'status', 'use_status', 'notes', 'palette', 'capabilities',
  'thumbnail', 'preview_kind', 'preview_label', 'preview_note', 'parent_id',
  'visualskills',
] as const;

/** `discovery.compact`: the record's documented keys, dropping empty values. */
export function compactMaterialRecord(record: MaterialRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of COMPACT_KEYS) {
    const value = record[key];
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}
