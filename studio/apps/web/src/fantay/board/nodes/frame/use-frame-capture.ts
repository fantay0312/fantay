// SPDX-License-Identifier: AGPL-3.0-only
// Capture (spec 03 §5.3, plan R15): Pick lifts part of a page onto the board and into chat. The frame's selection
// bridge (`od:comment-mode {mode:'picker'}`, both transports) reports hover and click targets; Enter (or the 截取
// button) captures the picked element, mod+Enter the whole page. The PNG is uploaded once, placed as an image node
// right of the frame with a `lineage` edge, selected, and staged in the composer through `STAGE_ATTACHMENT_EVENT`.
// Markup (frame and desktop web) reuses `PreviewDrawOverlay` unchanged (`ANNOTATION_EVENT`), see
// `CaptureMarkupLayer.tsx`. This module holds the session state and the pure capture steps.
import type { ChatAttachment } from '@open-design/contracts';

import type { FrameCommentTarget } from '../../engine/message-router';
import type { BoardCaptureTool, DictKey } from '../../model/types';

export interface FrameCaptureState {
  nodeId: string;
  kind: 'frame' | 'web';
  tool: BoardCaptureTool;
  hover: FrameCommentTarget | null;
  target: FrameCommentTarget | null;
  working: boolean;
}

export interface CaptureNotice {
  key: DictKey;
  vars?: Record<string, string | number>;
  tone?: 'default' | 'success' | 'danger';
}

export interface CapturePlacement {
  path: string;
  title: string;
  /** natural size of the captured PNG */
  width: number;
  height: number;
}

export interface FrameCaptureDeps {
  nodeId: string;
  kind: 'frame' | 'web';
  /** postMessage to the frame's current document */
  post(message: unknown): void;
  /** the PNG of the picked element (`target`) or of the whole page (`full`) */
  captureImage(input: { target: FrameCommentTarget | null; full: boolean }): Promise<{ blob: Blob; width: number; height: number } | null>;
  upload(file: File): Promise<{ path: string; name: string } | null>;
  /** adds the image node right of the frame plus a lineage edge and selects it; returns the node id */
  place(placement: CapturePlacement): string | null;
  stage(attachment: ChatAttachment): void;
  notify(notice: CaptureNotice): void;
  nodeTitle(): string;
  fullPageLabel(): string;
  captureTitle(page: string, element: string): string;
  now?(): Date;
}

export interface FrameCaptureSession {
  readonly nodeId: string;
  getState(): FrameCaptureState;
  subscribe(listener: () => void): () => void;
  /** the frame document (re)loaded: turns the picker on again */
  frameLoaded(): void;
  setTool(tool: BoardCaptureTool): void;
  hover(target: FrameCommentTarget): void;
  leave(): void;
  pick(target: FrameCommentTarget): void;
  clearTarget(): void;
  /** captures the picked element (`full: false`) or the whole page; resolves the new image node id */
  capture(full: boolean): Promise<string | null>;
  end(): void;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** ASCII slug of a label (≤ 40); empty for CJK-only text. */
export function captureSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** `capture-<slug(page)>-<slug(element)>-<yyyyMMdd-HHmmss>.png` (03 §5.3). */
export function captureFileName(page: string, element: string, now: Date): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const parts = [captureSlug(page) || 'page', captureSlug(element) || 'full'];
  return `capture-${parts.join('-')}-${stamp}.png`;
}

/**
 * The crop of a snapshot for a target: the bridge reports CSS px of the frame's viewport, the snapshot has
 * `snapshot.w / viewportCssWidth` image px per CSS px (device pixel ratio, layout zoom). Clamped to the image.
 */
export function captureCropRect(
  position: { x: number; y: number; width: number; height: number },
  snapshot: { w: number; h: number },
  viewportCssWidth: number,
): { x: number; y: number; width: number; height: number } {
  const scale = viewportCssWidth > 0 ? snapshot.w / viewportCssWidth : 1;
  const x = Math.max(0, Math.floor(position.x * scale));
  const y = Math.max(0, Math.floor(position.y * scale));
  const right = Math.min(snapshot.w, Math.ceil((position.x + position.width) * scale));
  const bottom = Math.min(snapshot.h, Math.ceil((position.y + position.height) * scale));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** Screen rect of a target inside an iframe drawn at `scale` screen px per CSS px. */
export function targetScreenRect(
  iframeRect: { left: number; top: number },
  position: { x: number; y: number; width: number; height: number },
  scale: number,
): { left: number; top: number; width: number; height: number } {
  return {
    left: iframeRect.left + position.x * scale,
    top: iframeRect.top + position.y * scale,
    width: position.width * scale,
    height: position.height * scale,
  };
}

/** Upload → image node + lineage edge → select → stage in chat (R15). Resolves the new node id. */
export async function runFrameCapture(deps: FrameCaptureDeps, input: { target: FrameCommentTarget | null; full: boolean }): Promise<string | null> {
  const image = await deps.captureImage(input).catch(() => null);
  if (!image) {
    // no snapshot of the page came back: name the page it was taken from
    deps.notify({ key: 'board.capture.failed', vars: { reason: deps.nodeTitle() }, tone: 'danger' });
    return null;
  }
  const page = deps.nodeTitle();
  const element = input.full || !input.target ? deps.fullPageLabel() : input.target.label || deps.fullPageLabel();
  const name = captureFileName(page, input.full || !input.target ? '' : input.target.label, deps.now ? deps.now() : new Date());
  const file = new File([image.blob], name, { type: 'image/png' });
  const uploaded = await deps.upload(file).catch(() => null);
  if (!uploaded) {
    deps.notify({ key: 'board.capture.failed', vars: { reason: name }, tone: 'danger' });
    return null;
  }
  const nodeId = deps.place({ path: uploaded.path, title: deps.captureTitle(page, element), width: image.width, height: image.height });
  deps.stage({ path: uploaded.path, name: uploaded.name, kind: 'image' });
  deps.notify({ key: 'board.capture.added', tone: 'success' });
  return nodeId;
}

export function createFrameCaptureSession(deps: FrameCaptureDeps, initialTool: BoardCaptureTool = 'pick'): FrameCaptureSession {
  const listeners = new Set<() => void>();
  let state: FrameCaptureState = {
    nodeId: deps.nodeId,
    kind: deps.kind,
    tool: deps.kind === 'web' ? 'markup' : initialTool,
    hover: null,
    target: null,
    working: false,
  };
  let ended = false;
  const set = (patch: Partial<FrameCaptureState>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const pickerOn = (on: boolean): void => {
    if (deps.kind !== 'frame') return;
    deps.post({ type: 'od:comment-mode', enabled: on, mode: 'picker' });
  };
  return {
    nodeId: deps.nodeId,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    frameLoaded() {
      if (ended) return;
      pickerOn(state.tool === 'pick');
    },
    setTool(tool) {
      if (ended || state.tool === tool) return;
      if (deps.kind === 'web' && tool === 'pick') return;
      pickerOn(tool === 'pick');
      set({ tool, hover: null, target: null });
    },
    hover(target) {
      if (ended || state.tool !== 'pick') return;
      set({ hover: target });
    },
    leave() {
      if (state.hover) set({ hover: null });
    },
    pick(target) {
      if (ended || state.tool !== 'pick') return;
      set({ target, hover: null });
    },
    clearTarget() {
      if (state.target) set({ target: null });
    },
    async capture(full) {
      if (ended || state.working || state.tool !== 'pick') return null;
      if (!full && !state.target) return null;
      set({ working: true });
      try {
        return await runFrameCapture(deps, { target: full ? null : state.target, full });
      } finally {
        if (!ended) set({ working: false, target: null });
      }
    },
    end() {
      if (ended) return;
      ended = true;
      pickerOn(false);
      listeners.clear();
    },
  };
}
