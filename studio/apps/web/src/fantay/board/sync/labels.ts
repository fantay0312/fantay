// SPDX-License-Identifier: AGPL-3.0-only
// Display labels of board nodes and groups (spec 04 §7.1 labels.ts), shared by the selection → chat context item,
// capture file names and the board UI.
import {
  boardKindForPath,
  formatBoardVariantLabel,
  parseBoardVariantPath,
  type BoardGroupNode,
  type BoardNode,
  type BoardPendingMedia,
  type BoardSectionKind,
} from '@open-design/contracts';

import type { Dict } from '../../../i18n/types';

/** Same shape as `ChatComposer.tsx`'s translate function (`useT()`). */
export type BoardTranslate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

const TEXT_LABEL_MAX = 60;

/** Project-relative path a node shows (frame/image/video/audio/design ref, motion composition source). */
export function boardNodeFilePath(node: BoardNode): string | null {
  switch (node.kind) {
    case 'frame':
    case 'image':
    case 'video':
    case 'audio':
      return node.ref?.path ?? null;
    case 'design':
      return node.ref.path;
    case 'motion':
      return node.source.type === 'composition' ? node.source.ref.path : null;
    default:
      return null;
  }
}

export function boardPathBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() ?? path;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function urlHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function firstLine(text: string | undefined, max = TEXT_LABEL_MAX): string | null {
  const line = (text ?? '').split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Variant label of a file-backed node: `"<base> · <Label>"` (`hero.variant-bold.html` → `hero · Bold`). */
function variantDisplay(node: BoardNode, path: string | null): string | null {
  const parsed = path ? parseBoardVariantPath(path) : null;
  const raw = node.variantLabel ?? parsed?.label;
  if (!raw || !path) return null;
  const base = parsed?.base ?? stripExtension(boardPathBasename(path));
  return `${base} · ${formatBoardVariantLabel(raw)}`;
}

/**
 * title → variant `"<base> · <Label>"` → basename(ref.path) → url host → note/shape text or generator prompt (first
 * line, ≤ 60) → `board.context.untitledNode`.
 */
export function boardNodeDisplayLabel(node: BoardNode, t: BoardTranslate): string {
  const title = node.title?.trim();
  if (title) return title;
  const path = boardNodeFilePath(node);
  const variant = variantDisplay(node, path);
  if (variant) return variant;
  if (path) return boardPathBasename(path);
  if (node.kind === 'web') {
    const host = urlHost(node.url);
    if (host) return host;
  }
  if (node.kind === 'note' || node.kind === 'shape') {
    const text = firstLine(node.text);
    if (text) return text;
  }
  if (node.kind === 'generator') {
    const prompt = firstLine(node.prompt.replace(/@\[node:[^\]]+\]/g, ' '));
    if (prompt) return prompt;
  }
  if (node.kind === 'group') return boardGroupDisplayTitle(node, [], t);
  return t('board.context.untitledNode');
}

const SECTION_KEYS: Record<BoardSectionKind, keyof Dict> = {
  frame: 'board.group.section.frame',
  design: 'board.group.section.design',
  motion: 'board.group.section.motion',
  image: 'board.group.section.image',
  video: 'board.group.section.video',
  audio: 'board.group.section.audio',
};

const BATCH_KEYS: Record<'image' | 'video' | 'audio', keyof Dict> = {
  image: 'board.group.batch.image',
  video: 'board.group.batch.video',
  audio: 'board.group.batch.audio',
};

function batchKindOf(children: readonly BoardNode[]): 'image' | 'video' | 'audio' | null {
  for (const child of children) {
    if (child.kind === 'image' || child.kind === 'video' || child.kind === 'audio') return child.kind;
  }
  return null;
}

/** Name of a variants row from its key (`pages/hero#frame` → `hero`) or from its base node. */
function variantsName(group: BoardGroupNode, children: readonly BoardNode[], t: BoardTranslate): string {
  const key = group.variantKey;
  if (key && !key.startsWith('batch:')) {
    const hash = key.lastIndexOf('#');
    const prefix = hash >= 0 ? key.slice(0, hash) : key;
    const name = boardPathBasename(prefix);
    if (name) return name;
  }
  const base = children.find((child) => child.id === group.baseNodeId) ?? children[0];
  if (base) {
    const path = boardNodeFilePath(base);
    const parsed = path ? parseBoardVariantPath(path) : null;
    if (parsed) return parsed.base;
    if (path) return stripExtension(boardPathBasename(path));
    return boardNodeDisplayLabel(base, t);
  }
  return t('board.context.untitledNode');
}

/** Group title: its own title, else by role (section kind, turn fallback, variants / batch counts). */
export function boardGroupDisplayTitle(group: BoardGroupNode, children: readonly BoardNode[], t: BoardTranslate): string {
  const title = group.title?.trim();
  if (title) return title;
  switch (group.role) {
    case 'section':
      return group.sectionKind ? t(SECTION_KEYS[group.sectionKind]) : t('board.context.untitledNode');
    case 'turn':
      return t('board.group.turnFallback');
    case 'variants': {
      if (group.variantKey?.startsWith('batch:')) {
        const kind = batchKindOf(children);
        if (kind) return t(BATCH_KEYS[kind], { count: children.length });
      }
      return t('board.group.variants', { name: variantsName(group, children, t), count: children.length });
    }
    default:
      return t('board.context.untitledNode');
  }
}

const PENDING_KEYS: Record<BoardPendingMedia['status'], keyof Dict> = {
  queued: 'board.node.pending.queued',
  running: 'board.node.pending.running',
  failed: 'board.node.pending.failed',
  interrupted: 'board.node.pending.interrupted',
};

export function boardPendingLabel(pending: Pick<BoardPendingMedia, 'status'>, t: BoardTranslate): string {
  return t(PENDING_KEYS[pending.status]);
}

/** True when a placeable path would be a board node at all (re-exported for the focus helpers). */
export function isBoardPlaceablePath(path: string): boolean {
  return boardKindForPath(path) !== null;
}
