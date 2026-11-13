// SPDX-License-Identifier: AGPL-3.0-only
// Motion model (spec 07 §3.2): frame and node sizes, the film status precedence, cover resolution,
// time formatting and capability rules shared by the board node, the editor and the create flow.
// Pure: no DOM, no requests.
import {
  MOVIE_DOCUMENT_FILE,
  movieCurrentRender,
  movieDuration,
  type MovieDocument,
  type MovieRender,
  type MovieReviewAssets,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { workspaceResourceUrl } from '../../collab/workspace-identity';
import type { Dict } from '../../i18n/types';

/** `keyof Dict` (`i18n/types.ts` exports no `DictKey`, amendment B16). */
type DictKey = keyof Dict;

export type MovieAspect = MovieDocument['aspect']; // '16:9' | '9:16' | '1:1'

/** The board's motion data for a film (plan R5: the board persists title/aspect only). */
export interface MotionNodeData {
  projectId: string; // today always the board's own project
  path: typeof MOVIE_DOCUMENT_FILE; // one film per project
  title?: string; // shown before the document loads
  aspect?: MovieAspect;
  /** A strip cover known from elsewhere; used while its render is still the latest. Not persisted (R5). */
  cover?: { url: string; frames: number; renderId: string };
}

export const MOTION_SKILL_ID = 'fantay-movie';
export const MOTION_NODE_FOOTER_H = 44;

/** Native frame size; must equal `buildMovieHtml` (contracts `runtime/movie-html.ts`). */
export function motionFrameSize(aspect: MovieAspect): { width: number; height: number } {
  if (aspect === '9:16') return { width: 1080, height: 1920 };
  if (aspect === '1:1') return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

/** Node box: the stage at the film's aspect plus the 44px footer. */
export function motionNodeSize(aspect: MovieAspect): { w: number; h: number } {
  if (aspect === '9:16') return { w: 270, h: 480 + MOTION_NODE_FOOTER_H };
  if (aspect === '1:1') return { w: 360, h: 360 + MOTION_NODE_FOOTER_H };
  return { w: 480, h: 270 + MOTION_NODE_FOOTER_H };
}

export type MotionStatus =
  | { kind: 'draft'; shots: number }
  | { kind: 'producing'; phase: 'armed' | 'preparing' | 'rendering' }
  | { kind: 'rendering'; progress?: string }
  | { kind: 'failed'; error?: string }
  | { kind: 'stale'; version: number }
  | { kind: 'rendered'; version: number }
  | { kind: 'approved'; version: number }
  | { kind: 'delivered'; version: number };

function renderVersion(doc: MovieDocument, renderId: string | null | undefined): number {
  const index = renderId ? doc.renders.findIndex((render) => render.id === renderId) : -1;
  return index >= 0 ? index + 1 : doc.renders.length;
}

function isProducing(doc: MovieDocument): boolean {
  const status = doc.production?.status;
  return status === 'armed' || status === 'preparing' || status === 'rendering';
}

/**
 * First match wins: (1) production armed/preparing/rendering → producing; (2) the last render is
 * running → rendering; (3) delivery → delivered; (4) the current render is approved → approved;
 * (5) a current render → rendered; (6) the last render failed → failed; (7) any done render →
 * stale; (8) draft. Versions are 1-based positions in `doc.renders`.
 */
export function motionStatus(doc: MovieDocument): MotionStatus {
  const production = doc.production;
  if (production && isProducing(doc)) {
    return { kind: 'producing', phase: production.status as 'armed' | 'preparing' | 'rendering' };
  }
  const last = doc.renders.at(-1);
  if (last?.status === 'running') {
    return last.progress ? { kind: 'rendering', progress: last.progress } : { kind: 'rendering' };
  }
  if (doc.delivery) return { kind: 'delivered', version: renderVersion(doc, doc.delivery.renderId) };
  const current = movieCurrentRender(doc);
  if (current && doc.approvedRenderId === current.id) {
    return { kind: 'approved', version: renderVersion(doc, current.id) };
  }
  if (current) return { kind: 'rendered', version: renderVersion(doc, current.id) };
  if (last?.status === 'failed') return last.error ? { kind: 'failed', error: last.error } : { kind: 'failed' };
  const done = [...doc.renders].reverse().find((render) => render.status === 'done');
  if (done) return { kind: 'stale', version: renderVersion(doc, done.id) };
  return { kind: 'draft', shots: doc.shots.length };
}

export type MotionTone = 'neutral' | 'brand' | 'success' | 'danger';

/** The status chip: producing/rendering read as live (brand), failed danger, approved/delivered success. */
export function motionStatusLabel(status: MotionStatus): {
  key: DictKey;
  vars?: Record<string, string | number>;
  tone: MotionTone;
} {
  switch (status.kind) {
    case 'producing':
      return { key: 'motion.node.status.producing', tone: 'brand' };
    case 'rendering':
      return { key: 'motion.node.status.rendering', tone: 'brand' };
    case 'failed':
      return { key: 'motion.node.status.failed', tone: 'danger' };
    case 'stale':
      return { key: 'motion.node.status.stale', vars: { version: status.version }, tone: 'neutral' };
    case 'rendered':
      return { key: 'motion.node.status.rendered', vars: { version: status.version }, tone: 'neutral' };
    case 'approved':
      return { key: 'motion.node.status.approved', vars: { version: status.version }, tone: 'success' };
    case 'delivered':
      return { key: 'motion.node.status.delivered', tone: 'success' };
    case 'draft':
      return { key: 'motion.node.status.draft', vars: { shots: status.shots }, tone: 'neutral' };
  }
}

/** A production or a render is running (status rules 1 or 2). */
export function isMovieBusy(doc: MovieDocument): boolean {
  return isProducing(doc) || doc.renders.at(-1)?.status === 'running';
}

/** The current render when there is one, else the most recent finished render. */
export function latestDoneRender(doc: MovieDocument): { render: MovieRender; version: number } | null {
  const render = movieCurrentRender(doc) ?? [...doc.renders].reverse().find((item) => item.status === 'done');
  return render ? { render, version: renderVersion(doc, render.id) } : null;
}

/** Project file URL through the workspace identity query (as the editor and FileWorkspace do). */
export function movieRawUrl(
  projectId: string,
  path: string,
  workspaceContext?: WorkspaceCollabContext | null,
): string {
  const safePath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return workspaceResourceUrl(`/api/projects/${encodeURIComponent(projectId)}/raw/${safePath}`, workspaceContext);
}

/** What a cover shows. (07 names this type `MotionCover`; renamed so it does not clash with the component.) */
export type MotionCoverSource =
  | { kind: 'strip'; url: string; frames: number; renderId: string }
  | { kind: 'image'; url: string }
  | { kind: 'poster'; background: string; foreground: string; accent: string; title: string };

/**
 * Precedence: (1) the filmstrip of `latestDoneRender` (loaded review assets, else `cached` when its
 * renderId matches); (2) the first style-preview frame of the current content revision, else the
 * first production frame; (3) a poster from the style colours and the first shot title.
 */
export function resolveMotionCover(input: {
  projectId: string;
  doc: MovieDocument | null;
  strip: MovieReviewAssets | null;
  cached?: MotionNodeData['cover'];
  workspaceContext?: WorkspaceCollabContext | null;
}): MotionCoverSource | null {
  const { projectId, doc, strip, cached, workspaceContext } = input;
  if (!doc) return cached ? { kind: 'strip', ...cached } : null;
  const latest = latestDoneRender(doc);
  if (latest && strip && strip.renderId === latest.render.id && strip.thumbnailCount > 0) {
    return {
      kind: 'strip',
      url: movieRawUrl(projectId, strip.thumbnailFile, workspaceContext),
      frames: strip.thumbnailCount,
      renderId: strip.renderId,
    };
  }
  if (latest && cached && cached.renderId === latest.render.id) return { kind: 'strip', ...cached };
  const preview = doc.stylePreview;
  const frame =
    preview && preview.contentRevision === doc.contentRevision && preview.frames[0]
      ? preview.frames[0]
      : doc.production?.frames?.[0];
  if (frame) return { kind: 'image', url: movieRawUrl(projectId, frame, workspaceContext) };
  return {
    kind: 'poster',
    background: doc.style.background,
    foreground: doc.style.foreground,
    accent: doc.style.accent,
    title: doc.shots[0]?.title || doc.title,
  };
}

/** The strip tile for `time`: clamp(floor(time / duration × frames), 0, frames − 1). */
export function stripFrameIndex(time: number, duration: number, frames: number): number {
  if (!(frames > 1) || !(duration > 0) || !Number.isFinite(time)) return 0;
  return Math.max(0, Math.min(frames - 1, Math.floor((time / duration) * frames)));
}

/**
 * Review strips are `frames` tiles of 160×90 with the film letterboxed inside each tile. For a
 * 16:9 film this is `${index / (frames - 1) × 100}% 0`; other aspects show only the film's part of
 * the tile (pass `aspect`).
 */
export function stripBackgroundPosition(index: number, frames: number, aspect: MovieAspect = '16:9'): string {
  const { inner, offset } = stripTileFrame(aspect);
  const span = frames * STRIP_TILE_W - inner;
  const percent = span > 0 ? ((index * STRIP_TILE_W + offset) / span) * 100 : 0;
  return `${roundPercent(percent)}% 0`;
}

/** `background-size` that makes one tile's film area fill the cover box. */
export function stripBackgroundSize(frames: number, aspect: MovieAspect = '16:9'): string {
  const { inner } = stripTileFrame(aspect);
  return `${roundPercent((Math.max(1, frames) * STRIP_TILE_W * 100) / inner)}% 100%`;
}

const STRIP_TILE_W = 160;
const STRIP_TILE_H = 90;

function stripTileFrame(aspect: MovieAspect): { inner: number; offset: number } {
  const { width, height } = motionFrameSize(aspect);
  const inner = Math.min(STRIP_TILE_W, (STRIP_TILE_H * width) / height);
  return { inner, offset: (STRIP_TILE_W - inner) / 2 };
}

function roundPercent(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 3.24 → "0:03" ("0:03.2" with tenths); 62 → "1:02". Negative or non-finite → 0. */
export function formatMotionTime(seconds: number, opts?: { tenths?: boolean }): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  if (opts?.tenths) {
    const tenths = Math.floor(safe * 10 + 1e-6);
    const whole = Math.floor(tenths / 10);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${tenths % 10}`;
  }
  const whole = Math.floor(safe + 1e-6);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Same gate as the daemon (`routes/movie.ts` startRender): samples approved for this revision, nothing running. */
export function motionRenderCapability(doc: MovieDocument): {
  available: boolean;
  reasonKey?: 'motion.node.renderBlocked' | 'motion.node.renderRunning';
} {
  if (isMovieBusy(doc)) return { available: false, reasonKey: 'motion.node.renderRunning' };
  if (doc.samplesApproved !== doc.contentRevision) return { available: false, reasonKey: 'motion.node.renderBlocked' };
  return { available: true };
}

export function motionCaptureCapability(doc: MovieDocument): {
  available: boolean;
  reasonKey?: 'motion.node.captureUnavailable';
} {
  return latestDoneRender(doc) ? { available: true } : { available: false, reasonKey: 'motion.node.captureUnavailable' };
}

/** Board mode bar for a selected motion node: Navigate = the footer controls, Edit = open the editor, Capture = a frame. */
export function motionModeBarCapabilities(doc: MovieDocument): { edit: true; capture: boolean } {
  return { edit: true, capture: motionCaptureCapability(doc).available };
}

/** Film length in seconds (sum of shot durations). */
export function motionDuration(doc: Pick<MovieDocument, 'shots'>): number {
  return movieDuration(doc);
}
