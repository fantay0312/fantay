// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/pages/canvas/project.tsx
// (L1812-1844, L1931-1990, L2063-2086: capture, crop, split and upscale handlers).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: outputs are project files (persist.ts) placed as derived image
// nodes with `derived` edges through the generation board port; "use as reference", "send to chat",
// "open in design editor" and the video-node "edit video" action (amendment C5) are new.
import {
  GENERATION_LIMITS,
  canConnectToGenerator,
  createGeneratorNodeInput,
  findFreePlacement,
  mediaNodeSizeFor,
  type BoardMediaFile,
  type GenerationBoardOp,
  type GenerationGraphNode,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import type { Dict } from '../../i18n/types';
import { STAGE_ATTACHMENT_EVENT, type StageAttachmentEventDetail } from '../../components/ChatComposer';
import { generatorPlacementRightOf } from '../generation/components/create-generator';
import { requestGeneratorPanelFocus } from '../generation/components/generator-ui-store';
import type { MediaToolContext } from '../media-nodes/node-tools';
import { insertMotionFromBoard, type InsertMotionFromBoardResult } from '../motion/motion-projects';
import { FANTAY_OPEN_DESIGN_EDITOR_EVENT, type OpenDesignEditorDetail } from './events';
import { cropToBlob, splitToBlobs, upscaleToBlob, type NormalizedRect, type SplitParams, type UpscaleParams } from './image-ops';
import { createIdSource } from './ids';
import { mediaBaseName, mediaStemName, mediaUrl } from './media-url';
import { measureImageBlob, persistToolOutput, toolOutputStem, type PersistDeps } from './persist';
import { captureVideoFrame, type VideoFramePosition } from './video-frame';

type DictKey = keyof Dict;

/** Gap between pieces of a split grid (world px). */
const SPLIT_GAP = 16;
/** Derived crops are at least this wide on the board (world px), unless the source is narrower. */
const MIN_CROP_NODE_WIDTH = 220;
/** How long "open in design editor" waits for the design host's ack. */
export const DESIGN_EDITOR_ACK_TIMEOUT_MS = 1500;

/* ── shared helpers ─────────────────────────────────────────────────────────────────────── */

/** The node's displayed media (the primary candidate's file for generated nodes). */
export function mediaFileOf(node: GenerationGraphNode): BoardMediaFile | null {
  return node.media?.file ?? null;
}

/** Name used in derived titles: the node title, else the file stem, else the untitled label. */
export function mediaDisplayName(node: GenerationGraphNode, t: MediaToolContext['t']): string {
  const title = node.title?.trim();
  if (title) return title;
  const file = mediaFileOf(node);
  if (file) return mediaStemName(file.path);
  return t(node.kind === 'video' ? 'fantay.media.untitledVideo' : 'fantay.media.untitledImage');
}

function idsOf(ctx: MediaToolContext): { next(): string } {
  return ctx.ids ?? createIdSource();
}

function nowOf(ctx: MediaToolContext): number {
  return ctx.now ? ctx.now() : Date.now();
}

function persistDepsOf(ctx: MediaToolContext): PersistDeps {
  const deps: PersistDeps = { projectId: ctx.projectId, workspaceContext: ctx.workspaceContext };
  if (ctx.upload) deps.upload = ctx.upload;
  return deps;
}

function notifyError(ctx: MediaToolContext, key: DictKey): void {
  ctx.notify({ tone: 'error', message: ctx.t(key) });
}

interface DerivedImage {
  file: BoardMediaFile;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
}

/** Adds derived image nodes (+ `derived` edges from the source) as one undoable step and selects them. */
function addDerivedImages(ctx: MediaToolContext, derived: DerivedImage[], label: string): string[] {
  const ids = idsOf(ctx);
  const ops: GenerationBoardOp[] = [];
  const newIds: string[] = [];
  for (const item of derived) {
    const id = ids.next();
    newIds.push(id);
    ops.push({
      type: 'node.add',
      node: { id, kind: 'image', x: Math.round(item.x), y: Math.round(item.y), w: Math.round(item.w), h: Math.round(item.h), title: item.title, data: { file: item.file } },
    });
    ops.push({ type: 'edge.add', edge: { id: ids.next(), from: ctx.node.id, to: id, role: 'derived' } });
  }
  if (ops.length === 0) return [];
  ctx.board.apply(ops, { label, undoable: true, flush: true });
  ctx.board.select(newIds);
  return newIds;
}

function sourceUrl(ctx: MediaToolContext, file: BoardMediaFile): string {
  return mediaUrl(ctx.projectId, file.path, ctx.workspaceContext);
}

async function dimsOf(blob: Blob, fallback: { width: number; height: number } | null): Promise<{ width: number; height: number } | null> {
  return (await measureImageBlob(blob)) ?? fallback;
}

/* ── crop / split / upscale / frame ─────────────────────────────────────────────────────── */

/**
 * Crops the node's image (`rect` normalized; none → centred square) into a new image node right of
 * the source: width `min(source.w, max(220, crop px))`, aspect kept; title `fantay.media.derived.crop`.
 */
export async function cropImageNode(ctx: MediaToolContext, rect?: NormalizedRect): Promise<string | null> {
  const file = mediaFileOf(ctx.node);
  if (!file) return null;
  let blob: Blob;
  try {
    blob = await cropToBlob(sourceUrl(ctx, file), rect);
  } catch {
    notifyError(ctx, 'fantay.media.toolFailed');
    return null;
  }
  const fallbackDims =
    file.width && file.height && rect
      ? { width: Math.max(1, Math.round(rect.width * file.width)), height: Math.max(1, Math.round(rect.height * file.height)) }
      : null;
  const dims = await dimsOf(blob, fallbackDims);
  const saved = await persistToolOutput(persistDepsOf(ctx), blob, 'crops', toolOutputStem('crops', ctx.node.id, nowOf(ctx)), dims ?? undefined);
  if (!saved) {
    notifyError(ctx, 'fantay.media.saveFailed');
    return null;
  }
  const source = ctx.node;
  const pxWidth = dims?.width ?? source.w;
  const ratio = dims ? dims.height / Math.max(1, dims.width) : rect ? (rect.height * source.h) / Math.max(1e-6, rect.width * source.w) : 1;
  const w = Math.min(source.w, Math.max(MIN_CROP_NODE_WIDTH, pxWidth));
  const h = Math.max(8, Math.round(w * ratio));
  const at = findFreePlacement(ctx.board.getGraph(), { x: source.x + source.w + GENERATION_LIMITS.outputGapX, y: source.y, w, h });
  const [id] = addDerivedImages(
    ctx,
    [{ file: saved, x: at.x, y: at.y, w, h, title: ctx.t('fantay.media.derived.crop', { name: mediaDisplayName(source, ctx.t) }) }],
    'media.crop',
  );
  return id ?? null;
}

/** Normalized (0..1) cut positions of one axis, as `buildSplitCuts` cuts a 10 000 px image. */
function normalizedCuts(lines: number[] | undefined, count: number): number[] {
  const extent = 10_000;
  const cells = Math.max(1, Math.floor(count) || 1);
  if (!lines?.length) return Array.from({ length: cells + 1 }, (_, index) => index / cells);
  const interior = lines
    .filter((line) => Number.isFinite(line) && line > 0 && line < 1)
    .map((line) => Math.round(line * extent) / extent)
    .sort((a, b) => a - b)
    .filter((cut, index, all) => index === 0 || cut !== all[index - 1]);
  return [0, ...interior, 1];
}

/**
 * Splits the node's image into a grid of image nodes right of the source; each piece keeps its share
 * of the source frame, pieces are 16 px apart and the whole grid is placed with `findFreePlacement`.
 * Titles `fantay.media.derived.piece {name,row,col}` (1-based).
 */
export async function splitImageNode(ctx: MediaToolContext, params: SplitParams): Promise<string[]> {
  const file = mediaFileOf(ctx.node);
  if (!file) return [];
  let pieces: Array<{ row: number; column: number; blob: Blob }>;
  try {
    pieces = await splitToBlobs(sourceUrl(ctx, file), params);
  } catch {
    notifyError(ctx, 'fantay.media.toolFailed');
    return [];
  }
  const now = nowOf(ctx);
  const deps = persistDepsOf(ctx);
  const saved: Array<{ row: number; column: number; file: BoardMediaFile }> = [];
  for (const piece of pieces) {
    const dims = await measureImageBlob(piece.blob);
    const result = await persistToolOutput(deps, piece.blob, 'splits', toolOutputStem('splits', ctx.node.id, now, piece), dims ?? undefined);
    if (!result) {
      notifyError(ctx, 'fantay.media.saveFailed');
      return [];
    }
    saved.push({ row: piece.row, column: piece.column, file: result });
  }
  const source = ctx.node;
  const xCuts = normalizedCuts(params.verticalLines, params.columns);
  const yCuts = normalizedCuts(params.horizontalLines, params.rows);
  const columns = xCuts.length - 1;
  const rows = yCuts.length - 1;
  const gridW = source.w + SPLIT_GAP * Math.max(0, columns - 1);
  const gridH = source.h + SPLIT_GAP * Math.max(0, rows - 1);
  const origin = findFreePlacement(ctx.board.getGraph(), { x: source.x + source.w + GENERATION_LIMITS.outputGapX, y: source.y, w: gridW, h: gridH });
  const name = mediaDisplayName(source, ctx.t);
  const derived = saved.map(({ row, column, file: pieceFile }): DerivedImage => {
    const left = xCuts[column] ?? 0;
    const right = xCuts[column + 1] ?? 1;
    const top = yCuts[row] ?? 0;
    const bottom = yCuts[row + 1] ?? 1;
    return {
      file: pieceFile,
      x: origin.x + left * source.w + column * SPLIT_GAP,
      y: origin.y + top * source.h + row * SPLIT_GAP,
      w: Math.max(8, (right - left) * source.w),
      h: Math.max(8, (bottom - top) * source.h),
      title: ctx.t('fantay.media.derived.piece', { name, row: row + 1, col: column + 1 }),
    };
  });
  return addDerivedImages(ctx, derived, 'media.split');
}

/** Upscales locally (no AI) into a new image node right of the source, sized by `mediaNodeSizeFor`. */
export async function upscaleImageNode(ctx: MediaToolContext, params: UpscaleParams): Promise<string | null> {
  const file = mediaFileOf(ctx.node);
  if (!file) return null;
  let blob: Blob;
  try {
    blob = await upscaleToBlob(sourceUrl(ctx, file), params);
  } catch {
    notifyError(ctx, 'fantay.media.toolFailed');
    return null;
  }
  const dims = await measureImageBlob(blob);
  const saved = await persistToolOutput(persistDepsOf(ctx), blob, 'upscales', toolOutputStem('upscales', ctx.node.id, nowOf(ctx)), dims ?? undefined);
  if (!saved) {
    notifyError(ctx, 'fantay.media.saveFailed');
    return null;
  }
  const source = ctx.node;
  const size = mediaNodeSizeFor('image', dims ?? { width: source.w, height: source.h });
  const at = findFreePlacement(ctx.board.getGraph(), { x: source.x + source.w + GENERATION_LIMITS.outputGapX, y: source.y, w: size.w, h: size.h });
  const [id] = addDerivedImages(
    ctx,
    [{ file: saved, x: at.x, y: at.y, w: size.w, h: size.h, title: ctx.t('fantay.media.derived.upscale', { name: mediaDisplayName(source, ctx.t) }) }],
    'media.upscale',
  );
  return id ?? null;
}

const FRAME_POSITION_KEYS: Record<VideoFramePosition, DictKey> = {
  first: 'fantay.media.tool.captureFirst',
  current: 'fantay.media.tool.captureCurrent',
  last: 'fantay.media.tool.captureLast',
};

/**
 * Captures a frame of the node's video (first, last, or the live element's current time — 0 when
 * the video is not mounted, i.e. the poster frame) into an image node right of the video, moved down
 * until free. Title `fantay.media.frame.title {name, position}`.
 */
export async function captureVideoFrameNode(ctx: MediaToolContext, position: VideoFramePosition): Promise<string | null> {
  const file = mediaFileOf(ctx.node);
  if (!file) return null;
  ctx.notify({ tone: 'info', message: ctx.t('fantay.media.saving') });
  let frame: { blob: Blob; width: number; height: number };
  try {
    frame = await captureVideoFrame(sourceUrl(ctx, file), position, ctx.videoElement?.currentTime ?? 0);
  } catch {
    notifyError(ctx, 'fantay.media.frame.failed');
    return null;
  }
  const dims = { width: frame.width, height: frame.height };
  const saved = await persistToolOutput(persistDepsOf(ctx), frame.blob, 'frames', toolOutputStem('frames', ctx.node.id, nowOf(ctx)), dims);
  if (!saved) {
    notifyError(ctx, 'fantay.media.saveFailed');
    return null;
  }
  const source = ctx.node;
  const size = mediaNodeSizeFor('image', dims);
  const at = findFreePlacement(ctx.board.getGraph(), { x: source.x + source.w + GENERATION_LIMITS.outputGapX, y: source.y, w: size.w, h: size.h });
  const title = ctx.t('fantay.media.frame.title', { name: mediaDisplayName(source, ctx.t), position: ctx.t(FRAME_POSITION_KEYS[position]) });
  const [id] = addDerivedImages(ctx, [{ file: saved, x: at.x, y: at.y, w: size.w, h: size.h, title }], 'media.frame');
  return id ?? null;
}

/* ── download / reference / chat / design editor / motion ───────────────────────────────── */

/** Downloads a project media file through a temporary `<a download>`. */
export function downloadMedia(projectId: string, file: BoardMediaFile, workspaceContext: WorkspaceCollabContext | null): void {
  if (typeof document === 'undefined') return;
  const anchor = document.createElement('a');
  anchor.href = mediaUrl(projectId, file.path, workspaceContext);
  anchor.download = mediaBaseName(file.path);
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

function generatorDisplayName(node: GenerationGraphNode, t: MediaToolContext['t']): string {
  const title = node.title?.trim();
  if (title) return title;
  return t(node.generator?.surface === 'video' ? 'fantay.gen.node.titleVideo' : 'fantay.gen.node.titleImage');
}

/**
 * "Use as reference": connects the node to the last active generator (a `reference` edge, undoable)
 * and selects it; when there is no such generator, creates an image generator right of the node
 * with the edge and opens its panel. An already connected last generator is only selected (no
 * duplicate edge, no second generator). Toasts `fantay.gen.refs.connectedTo`. Null when the node
 * cannot be a reference (no picture).
 */
export function useAsReference(ctx: MediaToolContext): { generatorId: string; created: boolean } | null {
  const node = ctx.node;
  if (!canConnectToGenerator(node, ctx.graph)) return null;
  const ids = idsOf(ctx);
  const last = ctx.lastActiveGeneratorId
    ? ctx.graph.nodes.find((entry) => entry.id === ctx.lastActiveGeneratorId && entry.kind === 'generator')
    : undefined;
  if (last) {
    const connected = ctx.graph.edges.some((edge) => edge.role === 'reference' && edge.from === node.id && edge.to === last.id);
    if (!connected) {
      ctx.board.apply(
        [{ type: 'edge.add', edge: { id: ids.next(), from: node.id, to: last.id, role: 'reference' } }],
        { label: 'generation.reference.add', undoable: true, flush: true },
      );
    }
    ctx.board.select([last.id]);
    requestGeneratorPanelFocus(last.id, 'refs');
    ctx.notify({ tone: 'success', message: ctx.t('fantay.gen.refs.connectedTo', { name: generatorDisplayName(last, ctx.t) }) });
    return { generatorId: last.id, created: false };
  }
  const generatorId = ids.next();
  const at = generatorPlacementRightOf(ctx.board, node);
  const generator = createGeneratorNodeInput({ id: generatorId, x: at.x, y: at.y, surface: 'image' });
  ctx.board.apply(
    [
      { type: 'node.add', node: generator },
      { type: 'edge.add', edge: { id: ids.next(), from: node.id, to: generatorId, role: 'reference' } },
    ],
    { label: 'generation.reference.create', undoable: true, flush: true },
  );
  ctx.board.select([generatorId]);
  requestGeneratorPanelFocus(generatorId, 'prompt');
  ctx.notify({ tone: 'success', message: ctx.t('fantay.gen.refs.connectedTo', { name: ctx.t('fantay.gen.node.titleImage') }) });
  return { generatorId, created: true };
}

/**
 * Stages project media in the chat composer (`STAGE_ATTACHMENT_EVENT`, the files are already in the
 * project): images as `image`, videos as `file`. Then reveals the chat column.
 */
export function sendToChat(
  files: Array<{ file: BoardMediaFile; title?: string; kind: 'image' | 'video' }>,
  onRevealChat?: () => void,
): void {
  if (typeof window === 'undefined' || files.length === 0) return;
  const detail: StageAttachmentEventDetail = {
    attachments: files.map((entry) => ({
      path: entry.file.path,
      name: entry.title?.trim() || mediaBaseName(entry.file.path),
      kind: entry.kind === 'image' ? 'image' : 'file',
      ...(typeof entry.file.size === 'number' ? { size: entry.file.size } : {}),
    })),
  };
  window.dispatchEvent(new CustomEvent<StageAttachmentEventDetail>(STAGE_ATTACHMENT_EVENT, { detail }));
  onRevealChat?.();
}

/**
 * Asks the design host (`DesignEditorEventBridge`, spec 06) to create a design document from the
 * node's image. Resolves `opened` on a positive ack within 1500 ms; otherwise `unavailable` and
 * toasts `fantay.media.designUnavailable`.
 */
export function openInDesignEditor(ctx: MediaToolContext): Promise<'opened' | 'unavailable'> {
  const file = mediaFileOf(ctx.node);
  const unavailable = (): 'unavailable' => {
    notifyError(ctx, 'fantay.media.designUnavailable');
    return 'unavailable';
  };
  if (!file || typeof window === 'undefined') return Promise.resolve(unavailable());
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: 'opened' | 'unavailable') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result === 'opened' ? 'opened' : unavailable());
    };
    const timer = setTimeout(() => settle('unavailable'), DESIGN_EDITOR_ACK_TIMEOUT_MS);
    const detail: OpenDesignEditorDetail = {
      projectId: ctx.projectId,
      request: { kind: 'new-from-image', image: { ...file }, title: mediaDisplayName(ctx.node, ctx.t), sourceNodeId: ctx.node.id },
      ack: (result) => settle(result.ok ? 'opened' : 'unavailable'),
    };
    window.dispatchEvent(new CustomEvent<OpenDesignEditorDetail>(FANTAY_OPEN_DESIGN_EDITOR_EVENT, { detail }));
  });
}

/**
 * Amendment C5 "剪辑视频": seeds a footage film from the node's video and opens the motion editor
 * (`insertMotionFromBoard`, W1 seam). When the seam reports a status (`opened-editor`), it is shown
 * as a toast. Null when the node has no video file.
 */
export function editVideoInMotion(ctx: MediaToolContext): InsertMotionFromBoardResult | null {
  const file = mediaFileOf(ctx.node);
  if (!file) return null;
  const result = insertMotionFromBoard({ projectId: ctx.projectId, kind: 'footage', files: [file.path] });
  if (result.status === 'opened-editor') ctx.notify({ tone: 'info', message: ctx.t(result.statusKey) });
  return result;
}
