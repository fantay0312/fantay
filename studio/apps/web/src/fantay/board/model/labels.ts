// SPDX-License-Identifier: AGPL-3.0-only
// Node and group label text (spec 03 §4.0 NodeLabel, §4.8; plan R1): an explicit title wins; nodes in a
// `variants` group read "版本 {index} · {label}" from the group order plus `formatBoardVariantLabel`; file nodes
// fall back to the file name, web nodes to host + path. The spec is locale-free; `formatLabel` applies `t`.
import { formatBoardVariantLabel, sortBoardLayoutItems } from '@open-design/contracts';

import { nodeFilePath } from './contract-adapter';
import type { BoardTranslate, EngineDoc, EngineNode } from './types';

export type LabelSpec =
  | { kind: 'title'; text: string }
  | { kind: 'variant'; index: number; label: string | null }
  | { kind: 'file'; text: string }
  | { kind: 'url'; text: string }
  | { kind: 'group'; role: 'section' | 'turn' | 'variants'; title: string | null; sectionKind: string | null; count: number }
  | { kind: 'generator'; surface: 'image' | 'video' }
  | { kind: 'untitled' };

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** `host + pathname` (no trailing slash for the root path); the raw string when it is not a URL. */
export function urlLabel(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}`;
  } catch {
    return raw;
  }
}

/** localhost / 127.0.0.1 / ::1 (03 §4.0 source tag). */
export function isLocalUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** 1-based position of a node in its `variants` group (group order = contract variant order) plus its label. */
export function variantPosition(doc: EngineDoc, node: EngineNode): { index: number; label: string | null } | null {
  if (node.parentId === null) return null;
  const parent = doc.nodes.get(node.parentId);
  if (!parent || parent.kind !== 'group' || parent.data.role !== 'variants') return null;
  const siblings: EngineNode[] = [];
  for (const id of doc.children.get(parent.id) ?? []) {
    const child = doc.nodes.get(id);
    if (child && child.kind !== 'group' && !child.hidden) siblings.push(child);
  }
  const ordered = sortBoardLayoutItems(
    siblings.map((child) => ({
      id: child.id,
      x: child.x,
      y: child.y,
      w: child.w,
      h: child.h,
      variantLabel: child.variantLabel,
      origin: child.source.origin,
    })),
    'variant',
  );
  const index = ordered.findIndex((item) => item.id === node.id);
  if (index < 0) return null;
  return { index: index + 1, label: node.variantLabel ? formatBoardVariantLabel(node.variantLabel) : null };
}

/** Title of a `variants` group without its own title: the base node's title or file, else the variant key's base name. */
function variantsBaseTitle(doc: EngineDoc, group: EngineNode & { kind: 'group' }): string | null {
  const baseId = group.data.baseNodeId;
  const base = baseId ? doc.nodes.get(baseId) : undefined;
  if (base) {
    if (base.title) return base.title;
    const path = nodeFilePath(base);
    if (path) return basename(path);
  }
  const key = group.data.variantKey;
  if (key && !key.startsWith('batch:')) {
    const name = basename(key.split('#')[0] ?? '');
    return name.length > 0 ? name : null;
  }
  return null;
}

export function nodeLabelSpec(doc: EngineDoc, node: EngineNode): LabelSpec {
  if (node.kind === 'group') {
    return {
      kind: 'group',
      role: node.data.role,
      title: node.title ?? (node.data.role === 'variants' ? variantsBaseTitle(doc, node) : null),
      sectionKind: node.data.sectionKind ?? null,
      count: doc.children.get(node.id)?.length ?? 0,
    };
  }
  if (node.title) return { kind: 'title', text: node.title };
  const variant = variantPosition(doc, node);
  if (variant) return { kind: 'variant', ...variant };
  const path = nodeFilePath(node);
  if (path) return { kind: 'file', text: basename(path) };
  if (node.kind === 'web') return { kind: 'url', text: urlLabel(node.data.url) };
  if (node.kind === 'motion' && node.data.render) return { kind: 'file', text: basename(node.data.render.path) };
  if (node.kind === 'generator') return { kind: 'generator', surface: node.data.surface === 'video' ? 'video' : 'image' };
  return { kind: 'untitled' };
}

const SECTION_KEYS = {
  frame: 'board.group.section.frame',
  design: 'board.group.section.design',
  motion: 'board.group.section.motion',
  image: 'board.group.section.image',
  video: 'board.group.section.video',
  audio: 'board.group.section.audio',
} as const;

export function formatLabel(spec: LabelSpec, t: BoardTranslate): string {
  switch (spec.kind) {
    case 'title':
    case 'file':
    case 'url':
      return spec.text;
    case 'variant':
      return spec.label
        ? t('board.node.variantTitle', { index: spec.index, name: spec.label })
        : t('board.node.variantTitleShort', { index: spec.index });
    case 'group': {
      if (spec.role === 'variants') {
        return t('board.node.variantsGroup', { title: spec.title ?? t('board.kind.group'), count: spec.count });
      }
      if (spec.title) return spec.title;
      if (spec.role === 'turn') return t('board.group.turnFallback');
      const key = spec.sectionKind ? SECTION_KEYS[spec.sectionKind as keyof typeof SECTION_KEYS] : undefined;
      return key ? t(key) : t('board.kind.group');
    }
    case 'generator':
      return t(spec.surface === 'video' ? 'fantay.gen.node.titleVideo' : 'fantay.gen.node.titleImage');
    default:
      return t('board.node.untitled');
  }
}

/** Display title of a node (labels, aria, announcements). */
export function nodeDisplayTitle(doc: EngineDoc, node: EngineNode, t: BoardTranslate): string {
  return formatLabel(nodeLabelSpec(doc, node), t);
}
