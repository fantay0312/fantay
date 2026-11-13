// SPDX-License-Identifier: AGPL-3.0-only
// Board capture → chat (spec 04 §7.7, plan R15). A region or node capture becomes a PNG `File` handed to the
// composer through `ANNOTATION_EVENT` (the composer uploads and stages it); nodes whose files already live in the
// project are staged directly through `STAGE_ATTACHMENT_EVENT` (no upload). Toast copy uses the renamed keys of plan
// R16 (`board.capture.addedToChat` / `board.capture.chatFailed`).
import type { BoardNode, ChatAttachment } from '@open-design/contracts';

import { STAGE_ATTACHMENT_EVENT, type StageAttachmentEventDetail } from '../../../components/ChatComposer';
import {
  ANNOTATION_EVENT,
  type AnnotationAction,
  type AnnotationEventDetail,
} from '../../../components/PreviewDrawOverlay';
import type { Dict } from '../../../i18n/types';
import { BOARD_CAPTURE_ACK_TIMEOUT_MS } from '../data/constants';
import { boardNodeFilePath, boardPathBasename } from './labels';

export interface BoardCaptureInput {
  /** PNG produced by the UI (region composite or node snapshot). */
  image: Blob;
  /** Single node fully containing the region, if any. */
  node?: BoardNode | null;
  /** Region in the node's design px. */
  region?: { x: number; y: number; width: number; height: number } | null;
  note?: string;
  /** Default 'draft'. */
  action?: AnnotationAction;
  now?: Date;
}

/** Toast keys for the capture outcome (plan R16 renamed 04's `board.capture.added|failed`). */
export const BOARD_CAPTURE_TOAST_KEYS = {
  added: 'board.capture.addedToChat',
  failed: 'board.capture.chatFailed',
} as const satisfies Record<'added' | 'failed', keyof Dict>;

const SLUG_MAX = 40;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function slugSource(node: BoardNode): string {
  const title = node.title?.trim();
  if (title) return title;
  const path = boardNodeFilePath(node);
  if (path) return boardPathBasename(path).replace(/\.[^.]+$/, '');
  if (node.kind === 'web') {
    try {
      return new URL(node.url).host;
    } catch {
      return node.kind;
    }
  }
  return node.kind;
}

/** `board-capture-<slug>-<YYYYMMDD-HHmmss>.png`; slug = ASCII-lowercased node label (≤ 40), else `board`. */
export function boardCaptureFileName(node: BoardNode | null | undefined, now: Date): string {
  const slug = node
    ? slugSource(node)
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SLUG_MAX)
      .replace(/-+$/g, '')
    : '';
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `board-capture-${slug || 'board'}-${stamp}.png`;
}

/** Path of a node whose file can go to chat as-is (no pending generation, ref present, not missing). */
function stageablePath(node: BoardNode): string | null {
  if (node.missing) return null;
  switch (node.kind) {
    case 'image':
    case 'video':
    case 'audio':
      return node.pending || !node.ref ? null : node.ref.path;
    case 'frame':
      return node.ref?.path ?? null;
    case 'design':
      return node.ref.path;
    default:
      return null;
  }
}

/**
 * Dispatches the capture to the composer (`ANNOTATION_EVENT`, action `draft` by default). Resolves with the
 * composer's ack; `{ ok: false }` after 10 s without one (no composer mounted).
 */
export function dispatchBoardCaptureToChat(input: BoardCaptureInput): Promise<{ ok: boolean; message?: string }> {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return Promise.resolve({ ok: false });
  const node = input.node ?? null;
  const file = new File([input.image], boardCaptureFileName(node, input.now ?? new Date()), { type: 'image/png' });
  const filePath = node ? boardNodeFilePath(node) : null;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; message?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result.message !== undefined ? { ok: result.ok, message: result.message } : { ok: result.ok });
    };
    const timer = setTimeout(() => finish({ ok: false }), BOARD_CAPTURE_ACK_TIMEOUT_MS);
    const detail: AnnotationEventDetail = {
      file,
      note: input.note ?? '',
      action: input.action ?? 'draft',
      target: null,
      ...(filePath ? { filePath } : {}),
      ...(node && input.region ? { markKind: 'stroke' as const, bounds: { ...input.region } } : {}),
      ack: (result) => finish(result),
    };
    try {
      window.dispatchEvent(new CustomEvent<AnnotationEventDetail>(ANNOTATION_EVENT, { detail }));
    } catch {
      finish({ ok: false });
    }
  });
}

/**
 * "Add to chat" for file-backed nodes (images, videos, audio, frames, designs): one `STAGE_ATTACHMENT_EVENT` with
 * their project paths, no upload. Pending, missing and file-less nodes are skipped. Returns how many were staged.
 */
export function stageBoardNodesInChat(nodes: readonly BoardNode[]): number {
  const attachments: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const path = stageablePath(node);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    attachments.push({ path, name: boardPathBasename(path), kind: node.kind === 'image' ? 'image' : 'file' });
  }
  if (attachments.length === 0 || typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return 0;
  window.dispatchEvent(new CustomEvent<StageAttachmentEventDetail>(STAGE_ATTACHMENT_EVENT, { detail: { attachments } }));
  return attachments.length;
}
