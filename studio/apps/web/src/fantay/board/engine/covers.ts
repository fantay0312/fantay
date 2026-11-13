// SPDX-License-Identifier: AGPL-3.0-only
// Cover pipeline (spec 03 §3.6 with plan R1): nodes that are not live show a cover instead of an iframe. Covers
// come, in order, from the board's own cover (fresh when captured from the current file), a chat-artifact
// snapshot, a stale board cover, then a kind source (design export). A live node captures its cover once it has
// rendered: desktop host compositor pixels when available, else the in-iframe snapshot bridge; the image is
// downscaled to ≤ 768 px WebP, uploaded with `uploadBoardCover` and written with `update {cover}` (R1: 04's digest
// covers, never into the project folder, I6). Captures run one at a time.
import {
  chatArtifactStaticCoverUrl,
  type BoardCoverRef,
  type BoardUploadedCoverRef,
  type ChatMessage,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { boardCoverSrc, uploadBoardCover } from '../data/board-api';
import { nodeFilePath } from '../model/contract-adapter';
import type { EngineNode, NodeRuntime } from '../model/types';
import { getThumbnailDimensions } from '../nodes/media/image-source';

export const COVER_MAX_EDGE = 768;
export const COVER_WEBP_QUALITY = 0.86;
/** wait this long after a live frame loaded before capturing (fonts, late layout) */
export const COVER_CAPTURE_IDLE_MS = 1_500;
export const COVER_CAPTURE_TIMEOUT_MS = 4_000;
/** contract: a cover is stale when `file.mtime > sourceMtime + 1000` */
export const COVER_STALE_SLACK_MS = 1_000;

export type NodeCover = NonNullable<NodeRuntime['cover']>;

export interface CoverImage {
  blob: Blob;
  width: number;
  height: number;
}

/** The contract cover a node carries (frame, web, video, design, motion). */
export function contractCoverOf(node: EngineNode): BoardCoverRef | undefined {
  switch (node.kind) {
    case 'frame':
    case 'web':
    case 'video':
    case 'design':
    case 'motion':
      return node.data.cover ?? undefined;
    default:
      return undefined;
  }
}

/** A cover is fresh when it was captured from the file version on disk (unknown file → fresh). */
export function isCoverFresh(cover: BoardCoverRef | undefined, fileMtime: number | undefined): boolean {
  if (!cover) return false;
  if (fileMtime === undefined || !Number.isFinite(fileMtime)) return true;
  if (cover.sourceMtime === undefined) return false;
  return fileMtime <= cover.sourceMtime + COVER_STALE_SLACK_MS;
}

/** The newest chat-artifact snapshot of a file (newest message first; label or workspace identity match). */
export function chatSnapshotCoverUrl(
  messages: readonly ChatMessage[],
  path: string,
  workspaceArtifactId?: string,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const refs = messages[index]?.artifactRefs;
    if (!refs || refs.length === 0) continue;
    for (let refIndex = refs.length - 1; refIndex >= 0; refIndex -= 1) {
      const ref = refs[refIndex];
      if (!ref) continue;
      const matches = ref.label === path || (!!workspaceArtifactId && ref.workspaceArtifactId === workspaceArtifactId);
      if (!matches) continue;
      const url = chatArtifactStaticCoverUrl(ref);
      if (url) return url;
    }
  }
  return null;
}

export interface ResolveCoverInput {
  node: EngineNode;
  /** the file this node shows, when the file list knows it */
  file?: { mtime: number } | undefined;
  messages: readonly ChatMessage[];
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  /** `extensions.resolveDesignCover(path)` for design nodes */
  designCoverUrl?: string | null;
}

/** Cover precedence of 03 §3.6: fresh board cover > chat snapshot > stale board cover > kind source > none. */
export function resolveCover(input: ResolveCoverInput): NodeCover | undefined {
  const { node, projectId, workspaceContext } = input;
  const contract = contractCoverOf(node);
  const fileMtime = input.file?.mtime;
  if (contract && isCoverFresh(contract, fileMtime)) {
    return { url: boardCoverSrc(projectId, contract, workspaceContext), stale: false, source: 'board' };
  }
  const path = nodeFilePath(node);
  if (path) {
    const identity = node.kind === 'frame' || node.kind === 'video' || node.kind === 'design'
      ? node.data.ref?.workspaceArtifactId
      : undefined;
    const chat = chatSnapshotCoverUrl(input.messages, path, identity);
    if (chat) return { url: chat, stale: true, source: 'chat-snapshot' };
  }
  if (contract) return { url: boardCoverSrc(projectId, contract, workspaceContext), stale: true, source: 'board' };
  if (node.kind === 'design' && input.designCoverUrl) {
    return { url: input.designCoverUrl, stale: false, source: 'design-export' };
  }
  return undefined;
}

/** True when the node should capture a new cover while it is live. */
export function needsCoverCapture(node: EngineNode, fileMtime: number | undefined): boolean {
  if (fileMtime === undefined) return false;
  return !isCoverFresh(contractCoverOf(node), fileMtime);
}

/* ── capture ──────────────────────────────────────────────────────────────────────────────────── */

export interface PreviewSnapshotLike {
  dataUrl: string;
  w: number;
  h: number;
}

export interface CaptureLiveCoverDeps {
  hostAvailable(): boolean;
  captureHost(rect: { left: number; top: number; width: number; height: number }): Promise<PreviewSnapshotLike | null>;
  requestSnapshot(iframe: HTMLIFrameElement, timeoutMs: number): Promise<PreviewSnapshotLike | null>;
  downscale(src: Blob | string, maxEdge?: number): Promise<CoverImage>;
  viewport(): { width: number; height: number };
}

async function defaultCaptureDeps(): Promise<CaptureLiveCoverDeps> {
  const exports = await import('../../../runtime/exports');
  return {
    hostAvailable: () => exports.isOpenDesignHostAvailable(),
    captureHost: (rect) => exports.captureHostRegionSnapshot(rect),
    requestSnapshot: (iframe, timeoutMs) => exports.requestPreviewSnapshot(iframe, timeoutMs),
    downscale: (src, maxEdge) => downscaleToWebp(src, maxEdge),
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
  };
}

function fullyInside(rect: DOMRect | { left: number; top: number; width: number; height: number }, viewport: { width: number; height: number }): boolean {
  return rect.left >= 0 && rect.top >= 0 && rect.left + rect.width <= viewport.width && rect.top + rect.height <= viewport.height;
}

/**
 * Captures the pixels of a live iframe: host compositor (real pixels) when the desktop host is present, the iframe
 * is fully on screen and drawn at ≥ 50 %, else the in-iframe snapshot bridge (both transports carry it).
 */
export async function captureLiveCover(
  input: { iframe: HTMLIFrameElement; preferHost: boolean; onScreenScale: number; timeoutMs?: number; maxEdge?: number },
  deps?: CaptureLiveCoverDeps,
): Promise<CoverImage | null> {
  const d = deps ?? (await defaultCaptureDeps());
  const maxEdge = input.maxEdge ?? COVER_MAX_EDGE;
  const rect = input.iframe.getBoundingClientRect();
  if (input.preferHost && d.hostAvailable() && input.onScreenScale >= 0.5 && fullyInside(rect, d.viewport())) {
    const snapshot = await d.captureHost({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    if (snapshot) return d.downscale(snapshot.dataUrl, maxEdge);
  }
  const snapshot = await d.requestSnapshot(input.iframe, input.timeoutMs ?? COVER_CAPTURE_TIMEOUT_MS);
  if (!snapshot) return null;
  return d.downscale(snapshot.dataUrl, maxEdge);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('cover image failed to decode'));
    image.src = src;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
}

/** Downscales an image (blob or data/object URL) to ≤ `maxEdge` px, WebP 0.86 (PNG where WebP encoding is missing). */
export async function downscaleToWebp(src: Blob | string, maxEdge = COVER_MAX_EDGE): Promise<CoverImage> {
  let source: CanvasImageSource & { width: number; height: number };
  let revoke: string | null = null;
  if (typeof src !== 'string' && typeof createImageBitmap === 'function') {
    source = await createImageBitmap(src);
  } else {
    let url = src as string;
    if (typeof src !== 'string') {
      url = URL.createObjectURL(src);
      revoke = url;
    }
    try {
      const image = await loadImage(url);
      source = Object.assign(image, { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
    } finally {
      if (revoke) URL.revokeObjectURL(revoke);
    }
  }
  const { width, height } = getThumbnailDimensions(source.width, source.height, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas 2d context is not available');
  context.drawImage(source, 0, 0, width, height);
  if ('close' in source && typeof (source as ImageBitmap).close === 'function') (source as ImageBitmap).close();
  const webp = await canvasBlob(canvas, 'image/webp', COVER_WEBP_QUALITY);
  if (webp && webp.type === 'image/webp') return { blob: webp, width, height };
  const png = await canvasBlob(canvas, 'image/png');
  if (!png) throw new Error('cover could not be encoded');
  return { blob: png, width, height };
}

/** The current frame of a `<video>` as a ≤ 768 px cover (first-frame poster, 03 §4.0). */
export async function captureVideoCover(video: HTMLVideoElement, maxEdge = COVER_MAX_EDGE): Promise<CoverImage | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const { width, height } = getThumbnailDimensions(w, h, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, width, height);
  } catch {
    return null;
  }
  const webp = await canvasBlob(canvas, 'image/webp', COVER_WEBP_QUALITY);
  if (webp && webp.type === 'image/webp') return { blob: webp, width, height };
  const png = await canvasBlob(canvas, 'image/png');
  return png ? { blob: png, width, height } : null;
}

/* ── one capture at a time ────────────────────────────────────────────────────────────────────── */

export interface CaptureQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** tasks waiting or running */
  size(): number;
}

/** FIFO, one task at a time (captures are expensive: one snapshot bridge render or compositor read each). */
export function createCaptureQueue(): CaptureQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      pending += 1;
      const next = tail.then(task, task);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next.finally(() => {
        pending -= 1;
      });
    },
    size: () => pending,
  };
}

/** The board's shared capture queue. */
export const coverCaptureQueue = createCaptureQueue();

/* ── save ─────────────────────────────────────────────────────────────────────────────────────── */

export interface SaveNodeCoverInput {
  projectId: string;
  nodeId: string;
  image: CoverImage;
  sourceMtime?: number | undefined;
  workspaceContext: WorkspaceCollabContext | null;
  /** writes the cover onto the node (`update {cover}`, never undoable) */
  update(nodeId: string, cover: BoardUploadedCoverRef): void;
}

/** Uploads a cover to the board cover store and points the node at it (plan R1). */
export async function saveNodeCover(
  input: SaveNodeCoverInput,
  deps: { upload?: typeof uploadBoardCover } = {},
): Promise<BoardUploadedCoverRef | null> {
  const upload = deps.upload ?? uploadBoardCover;
  try {
    const response = await upload(
      input.projectId,
      input.image.blob,
      { width: input.image.width, height: input.image.height, ...(input.sourceMtime !== undefined ? { sourceMtime: input.sourceMtime } : {}) },
      { workspaceContext: input.workspaceContext },
    );
    input.update(input.nodeId, response.cover);
    return response.cover;
  } catch {
    return null;
  }
}
