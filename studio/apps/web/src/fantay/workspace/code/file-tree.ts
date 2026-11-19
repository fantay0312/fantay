// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy apps/desktop/src/renderer/features/cc-agent/workdir-browse/lib/treeRows.ts
// @ 88941ba7 (Apache-2.0): the flat row model a virtualised tree renders, with one row pitch shared
// by the virtualiser and the rows. cindy loads folders lazily over IPC; here the tree is built once
// from the project's flat file list, and chains of single-child folders fold into one row.
// Pure; no React, no DOM.
import type { ProjectFile } from '../../../types';

/** Row pitch; the virtualiser's estimate and the row's CSS height must agree. */
export const TREE_ROW_HEIGHT = 28;
/** Indent per level, in px. */
export const TREE_INDENT = 12;
/** Projects up to this many files open with every folder expanded. */
export const EXPAND_ALL_LIMIT = 60;

export interface FileTreeNode {
  kind: 'dir' | 'file';
  /** Project-relative path; for a folded chain ("src/app") the deepest folder. */
  path: string;
  /** First folder of a folded chain; equals `path` everywhere else. */
  headPath: string;
  label: string;
  children: readonly FileTreeNode[];
  file: ProjectFile | null;
}

export interface FileTreeRow {
  node: FileTreeNode;
  /** 0 at the root. */
  depth: number;
  expanded: boolean;
  /** 1-based position among siblings and their count, for aria-posinset / aria-setsize. */
  posInSet: number;
  setSize: number;
  /** Index of the parent row, -1 at the root. */
  parentIndex: number;
}

interface DraftDir {
  name: string;
  path: string;
  dirs: Map<string, DraftDir>;
  files: ProjectFile[];
}

// Natural order ("file2" before "file10"), ignoring case and accents.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function byLabel(a: FileTreeNode, b: FileTreeNode): number {
  // The code-point tie-break keeps "a.ts" and "A.ts" in one fixed order.
  return collator.compare(a.label, b.label) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}

function toFileNode(file: ProjectFile): FileTreeNode {
  const slash = file.name.lastIndexOf('/');
  return {
    kind: 'file',
    path: file.name,
    headPath: file.name,
    label: slash === -1 ? file.name : file.name.slice(slash + 1),
    children: [],
    file,
  };
}

function toDirNode(dir: DraftDir): FileTreeNode {
  let tail = dir;
  let label = dir.name;
  // A folder holding nothing but one folder adds a click and no information: fold it into its child.
  while (tail.files.length === 0 && tail.dirs.size === 1) {
    const only = tail.dirs.values().next().value as DraftDir;
    label = `${label}/${only.name}`;
    tail = only;
  }
  return { kind: 'dir', path: tail.path, headPath: dir.path, label, children: finishDir(tail), file: null };
}

function finishDir(dir: DraftDir): FileTreeNode[] {
  const dirs = [...dir.dirs.values()].map(toDirNode).sort(byLabel);
  const files = dir.files.map(toFileNode).sort(byLabel);
  return [...dirs, ...files];
}

/** Folders first, then files, each in natural case-insensitive order. */
export function buildFileTree(files: readonly ProjectFile[]): FileTreeNode[] {
  const root: DraftDir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.name.split('/').filter((part) => part.length > 0);
    if (parts.length === 0) continue;
    const isDir = file.type === 'dir';
    const dirCount = isDir ? parts.length : parts.length - 1;
    let cursor = root;
    for (let index = 0; index < dirCount; index += 1) {
      const part = parts[index] as string;
      let next = cursor.dirs.get(part);
      if (!next) {
        next = { name: part, path: cursor.path ? `${cursor.path}/${part}` : part, dirs: new Map(), files: [] };
        cursor.dirs.set(part, next);
      }
      cursor = next;
    }
    if (!isDir) cursor.files.push(file);
  }
  return finishDir(root);
}

/** The visible rows in display order. `'all'` ignores the expansion state (used while filtering). */
export function flattenFileTree(
  roots: readonly FileTreeNode[],
  expanded: ReadonlySet<string> | 'all',
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  const visit = (nodes: readonly FileTreeNode[], depth: number, parentIndex: number): void => {
    nodes.forEach((node, index) => {
      const open = node.kind === 'dir' && (expanded === 'all' || expanded.has(node.path));
      rows.push({ node, depth, expanded: open, posInSet: index + 1, setSize: nodes.length, parentIndex });
      if (open) visit(node.children, depth + 1, rows.length - 1);
    });
  };
  visit(roots, 0, -1);
  return rows;
}

/**
 * Keeps the files whose path contains `query` (case-insensitive) and the folders leading to them.
 * An empty query returns `roots` itself, so callers can tell "not filtering" by identity.
 */
export function filterFileTree(roots: readonly FileTreeNode[], query: string): readonly FileTreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return roots;
  const prune = (nodes: readonly FileTreeNode[]): FileTreeNode[] => {
    const kept: FileTreeNode[] = [];
    for (const node of nodes) {
      if (node.kind === 'file') {
        if (node.path.toLowerCase().includes(needle)) kept.push(node);
        continue;
      }
      const children = prune(node.children);
      if (children.length > 0) kept.push({ ...node, children });
    }
    return kept;
  };
  return prune(roots);
}

/** "a/b/c.ts" → ["a", "a/b"]. */
export function ancestorPaths(path: string): string[] {
  const out: string[] = [];
  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
    if (at > 0) out.push(path.slice(0, at));
  }
  return out;
}

/** Every folder row's path, in display order. */
export function collectDirPaths(roots: readonly FileTreeNode[]): string[] {
  const out: string[] = [];
  const visit = (nodes: readonly FileTreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue;
      out.push(node.path);
      visit(node.children);
    }
  };
  visit(roots);
  return out;
}

/**
 * The row path of the folder `dirPath` lives in. A folded chain answers for every folder inside it:
 * with one "src/app" row, both "src" and "src/app" resolve to "src/app". Null when there is none.
 */
export function findDirRowPath(roots: readonly FileTreeNode[], dirPath: string): string | null {
  for (const node of roots) {
    if (node.kind !== 'dir') continue;
    if (node.path === dirPath) return node.path;
    const insideChain =
      node.path.startsWith(`${dirPath}/`) &&
      (dirPath === node.headPath || dirPath.startsWith(`${node.headPath}/`));
    if (insideChain) return node.path;
    if (dirPath.startsWith(`${node.path}/`)) return findDirRowPath(node.children, dirPath);
  }
  return null;
}
