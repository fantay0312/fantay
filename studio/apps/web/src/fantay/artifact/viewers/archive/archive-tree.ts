// SPDX-License-Identifier: AGPL-3.0-only
// The archive's entries as the tree the list draws. The row model (folders first, natural order,
// chains of single-child folders folded into one row, a flat row array for the virtualiser) is the
// 代码 surface's `file-tree.ts`; this adds what an archive listing needs on top: the entry behind
// each row, and each folder's total size and file count. Pure; no React, no DOM.
import type { ProjectFile } from '../../../../types';
import { EXPAND_ALL_LIMIT, buildFileTree, collectDirPaths, type FileTreeNode } from '../../../workspace/code/file-tree';
import type { ArchiveEntry, ArchiveListing } from './archive-reader';

export interface ArchiveFolderStats {
  /** Unpacked bytes of every file below the folder. */
  size: number;
  /** Files (not folders) below the folder. */
  files: number;
}

export interface ArchiveTree {
  roots: readonly FileTreeNode[];
  /** File and link entries by path. */
  files: ReadonlyMap<string, ArchiveEntry>;
  /** Totals by folder row path. */
  folders: ReadonlyMap<string, ArchiveFolderStats>;
  /** Folder rows in total. */
  folderCount: number;
}

export function buildArchiveTree(listing: ArchiveListing): ArchiveTree {
  const files = new Map<string, ArchiveEntry>();
  const items: ProjectFile[] = [];
  for (const entry of listing.entries) {
    if (entry.kind !== 'dir') files.set(entry.path, entry);
    items.push({
      name: entry.path,
      type: entry.kind === 'dir' ? 'dir' : 'file',
      size: entry.size,
      mtime: entry.modified ?? 0,
      kind: 'binary',
      mime: '',
    });
  }
  const roots = buildFileTree(items);
  const folders = new Map<string, ArchiveFolderStats>();
  const measure = (node: FileTreeNode): ArchiveFolderStats => {
    if (node.kind === 'file') return { size: node.file?.size ?? 0, files: 1 };
    const total: ArchiveFolderStats = { size: 0, files: 0 };
    for (const child of node.children) {
      const part = measure(child);
      total.size += part.size;
      total.files += part.files;
    }
    folders.set(node.path, total);
    return total;
  };
  roots.forEach(measure);
  return { roots, files, folders, folderCount: folders.size };
}

/**
 * The folders open when an archive is first shown: all of them when the archive is small, else the
 * top level down to the first folder that holds more than one thing (archives often wrap everything
 * in one folder, which would otherwise greet the reader with a single closed row).
 */
export function initialExpansion(tree: ArchiveTree): string[] {
  if (tree.files.size + tree.folderCount <= EXPAND_ALL_LIMIT) return collectDirPaths(tree.roots);
  const open: string[] = [];
  let level = tree.roots;
  while (level.length === 1 && level[0]?.kind === 'dir') {
    open.push(level[0].path);
    level = level[0].children;
  }
  return open;
}
