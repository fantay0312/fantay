// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
// SPDX-FileCopyrightText: 2026 Fantay contributors
// Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/app/document/export/create.ts
//   and https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/app/document/export/files.ts
// Modified by Fantay: downloads through the editor host page, no telemetry or native save
// dialogs; adds the board cover (exportCover) and the web-page export (exportHtml).
import { zipSync, type Zippable } from 'fflate';
import { DesignBridgeFailure } from '@open-design/contracts/runtime/design-editor-bridge';

import {
  BUILTIN_IO_FORMATS,
  IORegistry,
  computeContentBounds,
  findPageId,
  htmlFormat,
  renderNodesToImage,
  type Editor,
  type EditorState,
  type ExportRequest,
  type RasterExportFormat,
} from '../engine/op';
import type { ExportTargetRequest } from '../store/types';

type IOFormat = NonNullable<ReturnType<IORegistry['getFormat']>>;

export interface ExportedFile {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
}

export interface CoverBounds {
  width: number;
  height: number;
}

export const COVER_DEFAULT_MAX_EDGE = 1600;
const COVER_MIN_SCALE = 0.05;
const COVER_MAX_SCALE = 2;

/** Scale for a cover whose longest side is `maxEdge`, clamped to [0.05, 2] (06 §3.6). */
export function coverScale(bounds: CoverBounds, maxEdge = COVER_DEFAULT_MAX_EDGE): number {
  const longest = Math.max(bounds.width, bounds.height);
  if (!(longest > 0) || !(maxEdge > 0)) return 1;
  return Math.min(COVER_MAX_SCALE, Math.max(COVER_MIN_SCALE, maxEdge / longest));
}

/** Pixel size of a cover rendered at `scale` (at least 1×1). */
export function coverSize(bounds: CoverBounds, scale: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(bounds.width * scale)),
    height: Math.max(1, Math.round(bounds.height * scale)),
  };
}

/** The bytes as a plain-ArrayBuffer view (copied only when they live in shared memory). */
export function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

interface CoverNode {
  id: string;
  visible?: boolean;
}

/** The layers a cover shows: the page's visible top-level children. */
export function coverNodeIds(children: readonly CoverNode[]): string[] {
  return children.filter((node) => node.visible !== false).map((node) => node.id);
}

// Layer/page names flow into zip entry keys; flatten them to a single safe segment.
function sanitizeZipEntryName(name: string): string {
  const withoutControl = Array.from(name)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  const flat = withoutControl
    .replace(/[/\\]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  return flat.length > 0 ? flat : 'export';
}

/** Bundles several exported files into one zip, disambiguating duplicate names. */
export function bundleExportFiles(files: readonly ExportedFile[]): Uint8Array {
  const entries: Zippable = {};
  const used = new Set<string>();
  for (const file of files) {
    let name = sanitizeZipEntryName(file.fileName);
    if (used.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot === -1 ? name : name.slice(0, dot);
      const tail = dot === -1 ? '' : name.slice(dot);
      let index = 2;
      while (used.has(`${stem} (${index})${tail}`)) index++;
      name = `${stem} (${index})${tail}`;
    }
    used.add(name);
    entries[name] = file.bytes;
  }
  return zipSync(entries);
}

function exportBaseName(editor: Editor, target: ExportRequest['target']): string {
  if (target.scope === 'node') return editor.graph.getNode(target.nodeId)?.name ?? 'Export';
  if (target.scope === 'selection' && target.nodeIds.length === 1) {
    return editor.graph.getNode(target.nodeIds[0]!)?.name ?? 'Export';
  }
  if (target.scope === 'page') return editor.graph.getNode(target.pageId)?.name ?? 'Page';
  return 'Export';
}

function exportBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
}

function exportFileName(baseName: string, format: IOFormat, extension: string, scale?: number): string {
  return format.exportOptions?.scale ? `${baseName}@${scale ?? 1}x.${extension}` : `${baseName}.${extension}`;
}

export interface FxExport {
  renderExportImage(ids: string[], scale: number, format: RasterExportFormat, pageId?: string): Promise<Uint8Array<ArrayBuffer> | null>;
  exportTargets(requests: ExportTargetRequest[]): Promise<void>;
  exportCover(opts?: { maxEdge?: number; pageId?: string }): Promise<{ png: Uint8Array; width: number; height: number; pageId: string }>;
  exportHtml(scope: 'page' | 'selection'): Promise<string>;
}

export function createFxExport(
  editor: Editor,
  state: EditorState,
  downloadFile: (bytes: Uint8Array, fileName: string, mime: string) => void,
): FxExport {
  const io = new IORegistry(BUILTIN_IO_FORMATS);

  async function renderExportImage(
    nodeIds: string[],
    scale: number,
    format: RasterExportFormat,
    pageId = state.currentPageId,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    const renderer = editor.renderer;
    if (!renderer) return null;
    const ids = nodeIds.length > 0 ? nodeIds : editor.graph.getChildren(pageId).map((node) => node.id);
    if (ids.length === 0) return null;
    const ownerPageId = findPageId(editor.graph, ids[0]!) ?? pageId;
    const image = renderNodesToImage(renderer.ck, renderer, editor.graph, ownerPageId, ids, { scale, format });
    return image ? ownedBytes(image) : null;
  }

  async function renderExportFile(request: ExportTargetRequest): Promise<ExportedFile> {
    const format = io.getFormat(request.formatId);
    if (!format) throw new Error(`Unknown export format: ${request.formatId}`);
    const options = format.exportOptions?.scale
      ? { scale: request.options?.scale ?? 1, quality: request.options?.quality }
      : undefined;
    const renderer = editor.renderer;
    const result = await io.exportContent(
      request.formatId,
      { graph: editor.graph, target: request.target },
      options,
      renderer ? { canvasKit: renderer.ck, renderer } : undefined,
    );
    return {
      bytes: exportBytes(result.data),
      fileName: exportFileName(exportBaseName(editor, request.target), format, result.extension, request.options?.scale),
      mime: result.mimeType,
    };
  }

  // A single file downloads directly; several are bundled into one zip.
  async function exportTargets(requests: ExportTargetRequest[]): Promise<void> {
    if (requests.length === 0) return;
    const files: ExportedFile[] = [];
    for (const request of requests) files.push(await renderExportFile(request));
    if (files.length === 1) {
      const [file] = files;
      downloadFile(file!.bytes, file!.fileName, file!.mime);
      return;
    }
    const baseNames = new Set(requests.map((request) => exportBaseName(editor, request.target)));
    const zipBaseName = baseNames.size === 1 ? [...baseNames][0]! : 'export';
    downloadFile(bundleExportFiles(files), `${zipBaseName}.zip`, 'application/zip');
  }

  async function exportCover(opts: { maxEdge?: number; pageId?: string } = {}) {
    const pageId = opts.pageId ?? editor.graph.getPages()[0]?.id ?? state.currentPageId;
    const ids = coverNodeIds(editor.graph.getChildren(pageId));
    const visual = ids.length > 0 ? computeContentBounds(editor.graph, ids) : null;
    const bounds = visual ? { width: visual.maxX - visual.minX, height: visual.maxY - visual.minY } : null;
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) {
      throw new DesignBridgeFailure('EMPTY_DOCUMENT', 'The page has no visible layers');
    }
    const renderer = editor.renderer;
    if (!renderer) throw new DesignBridgeFailure('EXPORT_FAILED', 'The canvas is not ready');
    const scale = coverScale(bounds, opts.maxEdge ?? COVER_DEFAULT_MAX_EDGE);
    const png = renderNodesToImage(renderer.ck, renderer, editor.graph, pageId, ids, { scale, format: 'PNG' });
    if (!png) throw new DesignBridgeFailure('EXPORT_FAILED', 'The cover could not be rendered');
    return { png, ...(pngSize(png) ?? coverSize(bounds, scale)), pageId };
  }

  async function exportHtml(scope: 'page' | 'selection'): Promise<string> {
    const pageIds = editor.graph.getChildren(state.currentPageId).map((node) => node.id);
    const selected = [...state.selectedIds];
    const nodeIds = scope === 'selection' && selected.length > 0 ? selected : pageIds;
    if (nodeIds.length === 0) throw new DesignBridgeFailure('EMPTY_DOCUMENT', 'Nothing to export');
    const exported = await htmlFormat.exportContent!(
      { graph: editor.graph, target: { scope: 'selection', nodeIds } },
      { html: 'standalone', assets: 'inline', fonts: 'none' },
    );
    return typeof exported.data === 'string' ? exported.data : new TextDecoder().decode(exported.data);
  }

  return { renderExportImage, exportTargets, exportCover, exportHtml };
}
