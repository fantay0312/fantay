// SPDX-License-Identifier: AGPL-3.0-only
// Frame "导出图片" (amendment C4): renders a project page to PNG at 1× or 2× of its CSS size. The project's existing
// export path renders first (`POST /api/projects/:id/export/image`: the desktop renderer, the same pixels as the 文件
// tab's Export as image — the whole page at the frame's viewport size). Where that renderer is unavailable (pure web:
// 501) the live frame's snapshot bridge renders it, and on desktop the compositor region as a last resort. The PNG
// is written into the project (`exports/`, writable projects) and offered as a download.
import type { WorkspaceCollabContext } from '@open-design/contracts';

import type { PreviewSnapshot, ProjectImageExportResult } from '../../../runtime/exports';
import { basenameOf } from '../nodes/frame/project-files';

export type FrameExportScale = 1 | 2;

export const FRAME_EXPORT_DIR = 'exports';

/** `<base>.png` at 1×, `<base>-2x.png` at 2×. */
export function frameExportName(path: string, scale: FrameExportScale): string {
  const base = basenameOf(path).replace(/\.[^.]+$/, '') || 'page';
  return scale === 2 ? `${base}-2x.png` : `${base}.png`;
}

/** Output size of a snapshot normalized to `scale` × the frame's CSS width (aspect kept, so full pages stay long). */
export function exportOutputSize(snapshot: { w: number; h: number }, cssWidth: number, scale: FrameExportScale): { width: number; height: number } {
  const width = Math.max(1, Math.round(cssWidth * scale));
  const height = Math.max(1, Math.round((snapshot.h * width) / Math.max(1, snapshot.w)));
  return { width, height };
}

export interface FrameExportInput {
  projectId: string;
  path: string;
  /** frame CSS size (world px) */
  w: number;
  h: number;
  scale: FrameExportScale;
  deck: boolean;
  workspaceContext: WorkspaceCollabContext | null;
}

export interface FrameExportDeps {
  /** the project's off-screen renderer (`exportProjectImageDataUrl`) */
  renderViaDaemon(input: { projectId: string; fileName: string; width: number; height: number; deck: boolean; workspaceContext: WorkspaceCollabContext | null }): Promise<ProjectImageExportResult>;
  /** the live frame's snapshot bridge, then the desktop compositor (null when neither can render it) */
  renderViaFrame(): Promise<PreviewSnapshot | null>;
  /** resamples a snapshot data URL to the output size as PNG */
  resample(dataUrl: string, width: number, height: number): Promise<Blob>;
}

export type FrameExportResult =
  | { ok: true; blob: Blob; name: string; width: number; height: number; via: 'daemon' | 'frame' }
  | { ok: false; reason: string };

/** Renders a frame to PNG (daemon renderer first, the live frame's bridges when it is unavailable). */
export async function renderFrameImage(input: FrameExportInput, deps: FrameExportDeps): Promise<FrameExportResult> {
  let snapshot: PreviewSnapshot | null = null;
  let via: 'daemon' | 'frame' = 'daemon';
  const daemon = await deps
    .renderViaDaemon({ projectId: input.projectId, fileName: input.path, width: input.w, height: input.h, deck: input.deck, workspaceContext: input.workspaceContext })
    .catch((error: unknown): ProjectImageExportResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  if (daemon.ok) snapshot = daemon.snapshot;
  else if ('unavailable' in daemon && daemon.unavailable) {
    via = 'frame';
    snapshot = await deps.renderViaFrame().catch(() => null);
    if (!snapshot) return { ok: false, reason: daemon.reason };
  } else {
    return { ok: false, reason: 'error' in daemon ? daemon.error : 'export failed' };
  }
  const size = exportOutputSize(snapshot, input.w, input.scale);
  const blob = await deps.resample(snapshot.dataUrl, size.width, size.height);
  return { ok: true, blob, name: frameExportName(input.path, input.scale), width: size.width, height: size.height, via };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('export image failed to decode'));
    image.src = src;
  });
}

/** Canvas resample to PNG (high-quality smoothing). */
export async function resampleToPng(dataUrl: string, width: number, height: number): Promise<Blob> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas 2d context is not available');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('png encoding failed'))), 'image/png'));
}
