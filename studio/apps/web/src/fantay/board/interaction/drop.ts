// SPDX-License-Identifier: AGPL-3.0-only
// OS file drop and upload (spec 03 §3.13): files dropped on the board (or picked with Upload) go into the project
// with the composer's upload API (`.fig`/`.op` into `designs/`), measured first so each node opens at the file's
// aspect, staggered from the drop point (idea after infinite-canvas project.tsx, no code copied), and added in one
// transaction. Unsupported files are still uploaded and reported. External drags (materials, 07) go to
// `extensions.onExternalDrop` first.
import { useEffect } from 'react';
import {
  BOARD_AUDIO_EXTENSIONS,
  BOARD_IMAGE_EXTENSIONS,
  BOARD_VIDEO_EXTENSIONS,
  defaultBoardNodeSize,
  fitNodeSize,
  stableBoardId,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { uploadProjectFiles } from '../../../providers/registry';
import { screenToWorld } from '../camera/camera';
import type { BoardExtensions } from '../extensions';
import type { DictKey, Point, Size } from '../model/types';
import type { BoardEngine } from '../store/board-engine';
import type { NewNodeDraft } from '../store/ops';

export type DropKind = 'image' | 'video' | 'audio' | 'frame' | 'design' | 'unsupported';

/** Stagger between the nodes of one drop (world px). */
export const DROP_STAGGER = 40;
/** Picker filters (03 §3.13): the toolbar's Upload image, and Insert ▸ Upload files. */
export const UPLOAD_IMAGE_ACCEPT = 'image/*';
export const UPLOAD_FILES_ACCEPT = 'image/*,video/*,audio/*,.html,.htm,.fig,.op';

function endsWithAny(name: string, extensions: readonly string[]): boolean {
  return extensions.some((ext) => name.endsWith(ext));
}

export function classifyDropFile(file: Pick<File, 'name' | 'type'>): DropKind {
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  if (name.endsWith('.fig') || name.endsWith('.op')) return 'design';
  if (name.endsWith('.html') || name.endsWith('.htm') || type === 'text/html') return 'frame';
  if (type.startsWith('image/') || endsWithAny(name, BOARD_IMAGE_EXTENSIONS)) return 'image';
  if (type.startsWith('video/') || endsWithAny(name, BOARD_VIDEO_EXTENSIONS)) return 'video';
  if (type.startsWith('audio/') || endsWithAny(name, BOARD_AUDIO_EXTENSIONS)) return 'audio';
  return 'unsupported';
}

/** Upload folder per kind: design documents live in `designs/`, everything else at the project root. */
export function uploadDirFor(kind: DropKind): string | undefined {
  return kind === 'design' ? 'designs' : undefined;
}

export interface MediaMeasure {
  w: number;
  h: number;
  durationMs?: number;
}

/** Natural size of an image (`createImageBitmap`) or a video (metadata of a temporary element). */
export async function measureMediaFile(file: File, kind: DropKind): Promise<MediaMeasure | null> {
  try {
    if (kind === 'image' && typeof createImageBitmap === 'function' && !file.name.toLowerCase().endsWith('.svg')) {
      const bitmap = await createImageBitmap(file);
      const size = { w: bitmap.width, h: bitmap.height };
      bitmap.close();
      return size.w > 0 && size.h > 0 ? size : null;
    }
    if (kind === 'video' && typeof document !== 'undefined') {
      const url = URL.createObjectURL(file);
      try {
        return await new Promise<MediaMeasure | null>((resolve) => {
          const video = document.createElement('video');
          const timer = setTimeout(() => resolve(null), 4_000);
          video.preload = 'metadata';
          video.muted = true;
          video.onloadedmetadata = () => {
            clearTimeout(timer);
            resolve(video.videoWidth > 0 && video.videoHeight > 0
              ? { w: video.videoWidth, h: video.videoHeight, ...(Number.isFinite(video.duration) ? { durationMs: Math.round(video.duration * 1000) } : {}) }
              : null);
          };
          video.onerror = () => {
            clearTimeout(timer);
            resolve(null);
          };
          video.src = url;
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** World size of a dropped file's node (03 §3.13, §4.0 defaults). */
export function dropNodeSize(kind: DropKind, measure: MediaMeasure | null): Size {
  switch (kind) {
    case 'image':
      return measure ? fitNodeSize(measure.w, measure.h, 512, 512) : { w: 512, h: 512 };
    case 'video':
      return measure ? fitNodeSize(measure.w, measure.h, 640, 640) : { w: 640, h: 360 };
    case 'audio':
      return { w: 320, h: 72 };
    case 'design': {
      const size = defaultBoardNodeSize('design');
      return { w: size.w, h: size.h };
    }
    default: {
      const size = defaultBoardNodeSize('frame', { device: 'desktop' });
      return { w: size.w, h: size.h };
    }
  }
}

/** The node draft of an uploaded file, centred on `center`. */
export function dropNodeDraft(kind: Exclude<DropKind, 'unsupported'>, path: string, center: Point, measure: MediaMeasure | null): NewNodeDraft {
  const size = dropNodeSize(kind, measure);
  const data: Record<string, unknown> = { ref: { path } };
  if ((kind === 'image' || kind === 'video') && measure) {
    data.naturalWidth = measure.w;
    data.naturalHeight = measure.h;
    if (kind === 'video' && measure.durationMs !== undefined) data.durationMs = measure.durationMs;
  }
  if (kind === 'frame') data.device = 'desktop';
  if (kind === 'design') data.format = path.toLowerCase().endsWith('.op') ? 'op' : 'fig';
  return {
    kind,
    id: stableBoardId('n', `path:${path}`),
    x: center.x - size.w / 2,
    y: center.y - size.h / 2,
    w: size.w,
    h: size.h,
    data,
  };
}

export interface DropGhost {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UploadNotice {
  key: DictKey;
  vars?: Record<string, string | number>;
  tone?: 'default' | 'success' | 'danger';
}

export interface UploadAndPlaceInput {
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  files: readonly File[];
  /** world point the first node is centred on */
  at: Point;
  /** adds the drafts in one transaction (paths already on the board are reused, I1); resolves their ids */
  place(drafts: Array<{ draft: NewNodeDraft; path: string }>): string[];
  notify(notice: UploadNotice): void;
  onGhosts?(ghosts: readonly DropGhost[] | null): void;
  refresh?(): void;
  upload?: typeof uploadProjectFiles;
  measure?: (file: File, kind: DropKind) => Promise<MediaMeasure | null>;
}

/** Uploads dropped or picked files and places a node per supported file; resolves the node ids. */
export async function uploadAndPlace(input: UploadAndPlaceInput): Promise<string[]> {
  const upload = input.upload ?? uploadProjectFiles;
  const measure = input.measure ?? measureMediaFile;
  const entries = input.files.map((file, index) => ({
    file,
    kind: classifyDropFile(file),
    center: { x: input.at.x + index * DROP_STAGGER, y: input.at.y + index * DROP_STAGGER },
  }));
  if (entries.length === 0) return [];
  const measures = await Promise.all(entries.map((entry) => measure(entry.file, entry.kind).catch(() => null)));
  const ghosts: DropGhost[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'unsupported') return;
    const size = dropNodeSize(entry.kind, measures[index] ?? null);
    ghosts.push({ name: entry.file.name, x: entry.center.x - size.w / 2, y: entry.center.y - size.h / 2, w: size.w, h: size.h });
  });
  input.onGhosts?.(ghosts);
  if (entries.length > 1) input.notify({ key: 'board.drop.uploading', vars: { count: entries.length } });
  const groups = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const dir = uploadDirFor(entry.kind) ?? '';
    const list = groups.get(dir);
    if (list) list.push(index);
    else groups.set(dir, [index]);
  });
  const drafts: Array<{ draft: NewNodeDraft; path: string }> = [];
  try {
    for (const [dir, indexes] of groups) {
      const result = await upload(input.projectId, indexes.map((index) => entries[index]!.file), dir || undefined, input.workspaceContext);
      indexes.forEach((entryIndex, position) => {
        const entry = entries[entryIndex]!;
        const uploaded = result.uploaded[position];
        if (!uploaded?.path) {
          input.notify({ key: 'board.drop.failed', vars: { name: entry.file.name }, tone: 'danger' });
          return;
        }
        if (entry.kind === 'unsupported') {
          input.notify({ key: 'board.drop.unsupported', vars: { name: entry.file.name } });
          return;
        }
        drafts.push({ draft: dropNodeDraft(entry.kind, uploaded.path, entry.center, measures[entryIndex] ?? null), path: uploaded.path });
      });
    }
  } finally {
    input.onGhosts?.(null);
  }
  const ids = drafts.length > 0 ? input.place(drafts) : [];
  input.refresh?.();
  return ids;
}

/** World point of a client position on the board stage (the stage centre when the event carries no position). */
export function clientToWorld(engine: BoardEngine, client: { clientX: number; clientY: number }): Point {
  const cam = engine.camera.get();
  if (!Number.isFinite(client.clientX) || !Number.isFinite(client.clientY)) {
    const stage = engine.camera.stageSize();
    return screenToWorld(cam, { x: stage.w / 2, y: stage.h / 2 });
  }
  const rect = engine.camera.elements()?.stage.getBoundingClientRect();
  return screenToWorld(cam, { x: client.clientX - (rect?.left ?? 0), y: client.clientY - (rect?.top ?? 0) });
}

function hasFiles(transfer: DataTransfer | null): boolean {
  return !!transfer && Array.from(transfer.types ?? []).includes('Files');
}

/**
 * OS drag and drop over the board root: shows the drop overlay while files are dragged over, hands external drags
 * (materials) to the extension, and uploads dropped files at the drop point.
 */
export function useBoardDrop(
  engine: BoardEngine,
  options: {
    readOnly: boolean;
    getExtensions(): BoardExtensions | undefined;
    onFiles(files: File[], world: Point): void;
  },
): void {
  const { readOnly } = options;
  const getExtensions = options.getExtensions;
  const onFiles = options.onFiles;
  useEffect(() => {
    const root = engine.camera.elements()?.root;
    if (!root || readOnly) return undefined;
    let depth = 0;
    const external = (transfer: DataTransfer | null): boolean => {
      if (!transfer) return false;
      try {
        return getExtensions()?.acceptsExternalDrag?.(transfer) === true;
      } catch {
        return false;
      }
    };
    const accepts = (transfer: DataTransfer | null): boolean => hasFiles(transfer) || external(transfer);
    const setActive = (active: boolean): void => {
      if (engine.store.getState().ui.dropActive !== active) engine.store.setUi({ dropActive: active });
    };
    const onEnter = (event: DragEvent): void => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      setActive(true);
    };
    const onOver = (event: DragEvent): void => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (event: DragEvent): void => {
      if (!accepts(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };
    const onDrop = (event: DragEvent): void => {
      const transfer = event.dataTransfer;
      if (!accepts(transfer)) return;
      event.preventDefault();
      depth = 0;
      setActive(false);
      const world = clientToWorld(engine, event);
      if (transfer && external(transfer)) {
        try {
          if (getExtensions()?.onExternalDrop?.(transfer, world)) return;
        } catch {
          /* fall through to files */
        }
      }
      const files = transfer ? Array.from(transfer.files ?? []) : [];
      if (files.length > 0) onFiles(files, world);
    };
    root.addEventListener('dragenter', onEnter);
    root.addEventListener('dragover', onOver);
    root.addEventListener('dragleave', onLeave);
    root.addEventListener('drop', onDrop);
    return () => {
      root.removeEventListener('dragenter', onEnter);
      root.removeEventListener('dragover', onOver);
      root.removeEventListener('dragleave', onLeave);
      root.removeEventListener('drop', onDrop);
      setActive(false);
    };
  }, [engine, readOnly, getExtensions, onFiles]);
}
