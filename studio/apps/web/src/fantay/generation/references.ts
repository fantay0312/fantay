// SPDX-License-Identifier: AGPL-3.0-only
// Reference pictures for a run (spec 05 §4.7). The daemon reads references only as project-relative PNG/JPEG/
// WebP/GIF files ≤ 16 MB, so every other picture connected to a generator (an AVIF/SVG/oversized image node,
// a frame/web/design cover) is converted once into a "proxy" under `board-media/refs/` and reused:
// image nodes keep it in `refProxy` (keyed by `${path}@${mtime}`), covers in a session map.
import {
  collectGeneratorInputs,
  isDaemonReadyImage,
  shortGenerationId,
  boardCoverApiPath,
  type BoardMediaFile,
  type GenerationGraph,
  type GenerationGraphNode,
  type ProjectFile,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { workspaceResourceUrl } from '../../collab/workspace-identity';
import { projectRawUrl } from '../../providers/registry';
import { coverReferenceOf, referenceSourceKey, type GenerationBoardPort } from './board-adapter';
import { listProjectFilesFresh, uploadToProject, type DispatchDeps } from './dispatch';

/** Long edge of a reference proxy. */
export const REFERENCE_PROXY_MAX_LONG_EDGE = 4096;

/**
 * URL of a board media file for `<img>`/`<video>`/fetch: project files through `/raw` (workspace identity in
 * the query, because media loads cannot carry headers); cover pseudo paths through the board cover routes.
 */
export function mediaUrl(projectId: string, path: string, workspaceContext: WorkspaceCollabContext | null): string {
  const cover = coverReferenceOf(path);
  if (cover?.source === 'board-cover') {
    return workspaceResourceUrl(boardCoverApiPath(projectId, cover.digest), workspaceContext);
  }
  if (cover?.source === 'chat-artifact-snapshot') {
    return workspaceResourceUrl(
      `/api/projects/${encodeURIComponent(projectId)}/chat-artifact-snapshots/${encodeURIComponent(cover.snapshotId)}/thumbnail`,
      workspaceContext,
    );
  }
  return workspaceResourceUrl(projectRawUrl(projectId, path, workspaceContext), workspaceContext);
}

export interface ReferenceConversion {
  blob: Blob;
  ext: 'png' | 'webp' | 'jpg';
  width: number;
  height: number;
}
/** Decode → downscale (long edge ≤ 4096) → encode for the project (≤ 15 MB). */
export type ReferenceConverter = (source: Blob) => Promise<ReferenceConversion>;

export interface PrepareReferenceImagesArgs {
  graph: GenerationGraph;
  generatorId: string;
  deps: DispatchDeps;
  board: GenerationBoardPort;
  locale: string;
  /** Called for every input that stays not ready (the service emits `reference-prepare-failed`). */
  onPrepareFailed?: ((nodeId: string) => void) | undefined;
  /** Proxies of cover references made in this session, by source key (covers have no `refProxy` field). */
  coverProxies?: Map<string, BoardMediaFile> | undefined;
  /** Injected in tests; defaults to createImageBitmap/canvas + `encodeForProject`. */
  convert?: ReferenceConverter | undefined;
}

type DecodedImage = { source: CanvasImageSource; width: number; height: number; release(): void };

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // SVG and a few formats decode only through an <img>.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('The reference image could not be decoded.'));
      element.src = url;
    });
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!(width > 0 && height > 0)) throw new Error('The reference image has no size.');
    return { source: image, width, height, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export const defaultReferenceConverter: ReferenceConverter = async (source) => {
  const decoded = await decodeImage(source);
  try {
    const scale = Math.min(1, REFERENCE_PROXY_MAX_LONG_EDGE / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D canvas context for the reference image.');
    context.drawImage(decoded.source, 0, 0, width, height);
    // Spec 05 §6.6 encoder (media-tools): PNG → WebP 0.92 → JPEG 0.88 (opaque only; it samples the canvas
    // for transparency) until ≤ 15 MB. Loaded on demand: proxies are rare.
    const { encodeForProject } = await import('../media-tools/encode');
    const encoded = await encodeForProject(canvas);
    return { blob: encoded.blob, ext: encoded.ext, width, height };
  } finally {
    decoded.release();
  }
};

function withImage(node: GenerationGraphNode, image: NonNullable<GenerationGraphNode['image']>): GenerationGraphNode {
  return { ...node, image };
}

/**
 * Makes every image input of the generator daemon-ready where possible and returns the graph the compiler
 * should see. Inputs that cannot be prepared stay not ready (the compiler warns `reference-not-ready` and
 * skips them) and are reported through `onPrepareFailed`. Never throws.
 */
export async function prepareReferenceImages(args: PrepareReferenceImagesArgs): Promise<GenerationGraph> {
  const { graph, generatorId, deps, board } = args;
  const convert = args.convert ?? defaultReferenceConverter;
  const pending = collectGeneratorInputs(graph, generatorId).inputs.filter(
    (input) => input.kind === 'image' && input.image && !input.image.daemonReady,
  );
  if (pending.length === 0) return graph;

  const replaced = new Map<string, GenerationGraphNode>();
  let projectFiles: ProjectFile[] | null | undefined;
  for (const input of pending) {
    if (replaced.has(input.nodeId)) continue;
    const node = graph.nodes.find((entry) => entry.id === input.nodeId);
    const picture = node?.image;
    if (!node || !picture) continue;
    const isCover = coverReferenceOf(picture.path) !== null;
    const sourceFile = node.kind === 'image' ? node.media?.file : undefined;
    if (!isCover && !sourceFile) {
      args.onPrepareFailed?.(node.id);
      continue;
    }
    const sourceKey = isCover ? picture.path : referenceSourceKey(sourceFile!);
    const known = isCover ? args.coverProxies?.get(sourceKey) : undefined;
    if (known) {
      replaced.set(node.id, withImage(node, { ...known, daemonReady: true }));
      continue;
    }
    const desiredPrefix = `board-media/refs/ref-${shortGenerationId(sourceKey)}.`;
    if (isCover) {
      if (projectFiles === undefined) {
        try {
          projectFiles = await listProjectFilesFresh(deps);
        } catch {
          projectFiles = null;
        }
      }
      const existing = projectFiles?.find((file) => file.type !== 'dir' && file.name.startsWith(desiredPrefix));
      if (existing) {
        const reused: BoardMediaFile = {
          path: existing.name,
          ...(existing.mime ? { mime: existing.mime } : {}),
          ...(typeof existing.size === 'number' ? { size: existing.size } : {}),
          ...(typeof existing.mtime === 'number' ? { mtime: existing.mtime } : {}),
        };
        if (isDaemonReadyImage(reused)) {
          args.coverProxies?.set(sourceKey, reused);
          replaced.set(node.id, withImage(node, { ...reused, daemonReady: true }));
          continue;
        }
      }
    }
    try {
      const response = await deps.fetch(mediaUrl(deps.projectId, isCover ? picture.path : sourceFile!.path, deps.workspaceContext));
      if (!response.ok) throw new Error(`reference fetch ${response.status}`);
      const converted = await convert(await response.blob());
      const uploaded = await uploadToProject(
        deps,
        converted.blob,
        `board-media/refs/ref-${shortGenerationId(sourceKey)}.${converted.ext}`,
      );
      if (!uploaded) throw new Error('reference upload failed');
      const proxy: BoardMediaFile = {
        path: uploaded.name,
        width: converted.width,
        height: converted.height,
        ...(uploaded.mime ? { mime: uploaded.mime } : {}),
        ...(typeof uploaded.size === 'number' ? { size: uploaded.size } : {}),
        ...(typeof uploaded.mtime === 'number' ? { mtime: uploaded.mtime } : {}),
      };
      if (!isDaemonReadyImage(proxy)) throw new Error('reference proxy is not daemon-ready');
      if (isCover) {
        args.coverProxies?.set(sourceKey, proxy);
      } else {
        board.apply([{ type: 'node.patchData', id: node.id, patch: { refProxy: { path: proxy.path, sourceKey } } }], {
          label: 'generation.refProxy',
          undoable: false,
          flush: true,
        });
      }
      replaced.set(node.id, withImage(node, { ...proxy, daemonReady: true }));
    } catch {
      args.onPrepareFailed?.(node.id);
    }
  }
  if (replaced.size === 0) return graph;
  return { ...graph, nodes: graph.nodes.map((node) => replaced.get(node.id) ?? node) };
}
