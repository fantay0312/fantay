// SPDX-License-Identifier: AGPL-3.0-only
// Material drag-and-drop payload (spec 07 §7.1). The drawer writes it on a card's `dragstart`; the board
// accepts it on `dragover` (`hasMaterialDrag`, the payload itself is unreadable until drop) and reads it
// on `drop` (`readMaterialDrag`) before calling `insertMaterialToBoard`. A drop may come from another
// window or app, so the reader validates every field and rebuilds a clean item instead of trusting it.
import type { MaterialCapabilities, MaterialSummaryItem } from '@open-design/contracts';

export const FANTAY_MATERIAL_MIME = 'application/x-fantay-material+json';

/** Bigger payloads are rejected before parsing (a real one is well under 8 KiB). */
export const MATERIAL_DRAG_MAX_BYTES = 64 * 1024;

export type MaterialDragItem = Pick<
  MaterialSummaryItem,
  'id' | 'title' | 'kind' | 'capabilities' | 'source' | 'license' | 'subtitle' | 'description' | 'thumbnailUrl'
>;

export interface MaterialDragPayload {
  v: 1;
  item: MaterialDragItem;
}

const MATERIAL_USES: ReadonlySet<string> = new Set(['source_file', 'local_reference', 'website_record']);

/** The fields a board insert needs, copied so the payload never carries the whole summary record. */
export function toMaterialDragItem(item: MaterialDragItem): MaterialDragItem {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    capabilities: { ...item.capabilities },
    ...(item.source !== undefined ? { source: item.source } : {}),
    license: item.license,
    ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
    description: item.description,
    thumbnailUrl: item.thumbnailUrl,
  };
}

/** Sets the JSON payload, a `text/plain` title for other drop targets, and `effectAllowed = 'copy'`. */
export function writeMaterialDrag(dataTransfer: DataTransfer, item: MaterialSummaryItem | MaterialDragItem): void {
  const payload: MaterialDragPayload = { v: 1, item: toMaterialDragItem(item) };
  dataTransfer.setData(FANTAY_MATERIAL_MIME, JSON.stringify(payload));
  dataTransfer.setData('text/plain', item.title);
  dataTransfer.effectAllowed = 'copy';
}

/** True when the drag carries a material (usable in `dragover`, where `getData` returns ''). */
export function hasMaterialDrag(dataTransfer: DataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes(FANTAY_MATERIAL_MIME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readCapabilities(value: unknown): MaterialCapabilities {
  const source = isRecord(value) ? value : {};
  const material = typeof source.material === 'string' && MATERIAL_USES.has(source.material)
    ? (source.material as MaterialCapabilities['material'])
    : 'source_file';
  return {
    material,
    previewEntry: source.previewEntry === true,
    designTokens: source.designTokens === true,
    sourceManifest: source.sourceManifest === true,
    licenseDocument: source.licenseDocument === true,
  };
}

/** The payload of a drop, or null for anything else (wrong version, no id/title, oversized or garbage JSON). */
export function readMaterialDrag(dataTransfer: DataTransfer | null | undefined): MaterialDragPayload | null {
  if (!dataTransfer) return null;
  let raw: string;
  try {
    raw = dataTransfer.getData(FANTAY_MATERIAL_MIME);
  } catch {
    return null;
  }
  if (!raw || raw.length > MATERIAL_DRAG_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.item)) return null;
  const item = parsed.item;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (!id || !title) return null;
  const source = optionalString(item.source);
  const subtitle = optionalString(item.subtitle);
  return {
    v: 1,
    item: {
      id,
      title,
      kind: typeof item.kind === 'string' ? item.kind : '',
      capabilities: readCapabilities(item.capabilities),
      ...(source !== undefined ? { source } : {}),
      license: typeof item.license === 'string' ? item.license : '',
      ...(subtitle !== undefined ? { subtitle } : {}),
      description: typeof item.description === 'string' ? item.description : '',
      thumbnailUrl: typeof item.thumbnailUrl === 'string' ? item.thumbnailUrl : null,
    },
  };
}
