// SPDX-License-Identifier: AGPL-3.0-only
// Board selection → ONE chat context item (spec 04 §7.6, plan R15). The composer shows one active workspace context
// chip, so a multi-node selection is a single `board-selection` item carrying `nodes[]` plus a `title` summary for the
// transcript paths that ignore `nodes`.
import {
  BOARD_LIMITS,
  BOARD_SELECTION_CONTEXT_KIND,
  formatBoardVariantLabel,
  stableBoardId,
  type BoardDocument,
  type BoardGroupNode,
  type BoardNode,
  type WorkspaceContextBoardNode,
  type WorkspaceContextItem,
} from '@open-design/contracts';

import { BOARD_TAB_ID } from '../data/constants';
import { boardGroupDisplayTitle, boardNodeDisplayLabel, boardNodeFilePath, type BoardTranslate } from './labels';

export type { BoardTranslate } from './labels';

const ID_JOIN_LIMIT = 200;
const TITLE_LIMIT = 500;
const LABEL_LIMIT = 120;
const TEXT_LIMIT = 500;
const GROUP_LIMIT = 120;
const VARIANT_LIMIT = 32;

function cap(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * Local copy of FileWorkspace's private `joinDisplayPath` (FileWorkspace is not edited to export it): strips
 * trailing separators from the root and leading ones from the child, then joins with `/`.
 */
export function joinBoardDisplayPath(root: string, child: string): string {
  const cleanRoot = root.replace(/[\\/]+$/u, '');
  const cleanChild = child.replace(/^[\\/]+/u, '');
  return cleanChild ? `${cleanRoot}/${cleanChild}` : cleanRoot;
}

function childrenOf(board: BoardDocument, groupId: string): BoardNode[] {
  return board.nodes.filter((node) => node.parentId === groupId);
}

function nodeText(node: BoardNode): string | undefined {
  if (node.kind === 'note' || node.kind === 'shape') return node.text || undefined;
  if (node.kind === 'generator') return node.prompt || undefined;
  return undefined;
}

function contextLabel(board: BoardDocument, node: BoardNode, t: BoardTranslate): string {
  return node.kind === 'group'
    ? boardGroupDisplayTitle(node, childrenOf(board, node.id), t)
    : boardNodeDisplayLabel(node, t);
}

function contextNode(board: BoardDocument, byId: ReadonlyMap<string, BoardNode>, node: BoardNode, t: BoardTranslate): WorkspaceContextBoardNode {
  const out: WorkspaceContextBoardNode = { id: node.id, kind: node.kind, label: cap(contextLabel(board, node, t), LABEL_LIMIT) };
  const path = boardNodeFilePath(node);
  if (path) out.path = path;
  if (node.kind === 'web') out.url = node.url;
  const text = nodeText(node);
  if (text) out.text = cap(text, TEXT_LIMIT);
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  if (parent && parent.kind === 'group') {
    out.group = cap(boardGroupDisplayTitle(parent as BoardGroupNode, childrenOf(board, parent.id), t), GROUP_LIMIT);
  }
  if (node.variantLabel) out.variantLabel = cap(formatBoardVariantLabel(node.variantLabel), VARIANT_LIMIT);
  return out;
}

/**
 * - empty selection → null;
 * - a selected group contributes itself plus its descendants; hidden nodes are dropped; board paint order;
 * - at most `BOARD_LIMITS.maxSelectionContextNodes` (24) nodes;
 * - id `board-selection:<sorted ids>` (≤ 200 chars, else `board-selection:` + `stableBoardId('n', joined)`);
 * - label: the node's display label for one node, else `board.context.selectionLabel` with the selection count;
 * - one file-backed node: `path` (+ `absolutePath` when `projectDir` is known); one web node: `url`;
 * - `title`: `"<kind> <path|label>; …"` ≤ 500 chars, for prompt paths that ignore `nodes`.
 */
export function boardSelectionContextItem(input: {
  board: BoardDocument;
  selectedIds: readonly string[];
  t: BoardTranslate;
  projectDir?: string | null;
}): WorkspaceContextItem | null {
  const { board, t } = input;
  if (input.selectedIds.length === 0) return null;
  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  const included = new Set<string>();
  const include = (id: string): void => {
    const node = byId.get(id);
    if (!node || included.has(id)) return;
    included.add(id);
    if (node.kind === 'group') for (const child of childrenOf(board, id)) include(child.id);
  };
  for (const id of input.selectedIds) include(id);
  const visible = board.nodes.filter((node) => included.has(node.id) && !node.hidden);
  if (visible.length === 0) return null;
  const nodes = visible.slice(0, BOARD_LIMITS.maxSelectionContextNodes);
  const sortedIds = nodes.map((node) => node.id).sort();
  const joined = sortedIds.join(',');
  const id = `${BOARD_SELECTION_CONTEXT_KIND}:${joined.length <= ID_JOIN_LIMIT ? joined : stableBoardId('n', joined)}`;
  const contextNodes = nodes.map((node) => contextNode(board, byId, node, t));
  const single = nodes.length === 1 ? nodes[0]! : null;
  const label = single ? contextNodes[0]!.label : t('board.context.selectionLabel', { count: visible.length });
  const title = cap(
    contextNodes.map((node) => `${node.kind} ${node.path ?? node.url ?? node.label}`).join('; '),
    TITLE_LIMIT,
  );
  const item: WorkspaceContextItem = {
    id,
    kind: BOARD_SELECTION_CONTEXT_KIND,
    label,
    tabId: BOARD_TAB_ID,
    title,
    nodes: contextNodes,
  };
  if (single) {
    const path = boardNodeFilePath(single);
    if (path) {
      item.path = path;
      if (input.projectDir) item.absolutePath = joinBoardDisplayPath(input.projectDir, path);
    }
    if (single.kind === 'web') item.url = single.url;
  }
  return item;
}
