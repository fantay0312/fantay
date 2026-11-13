// SPDX-License-Identifier: AGPL-3.0-only
// Open-request classification and node lookup (spec 04 §7.1 focus.ts). Names are `ProjectFile.name` (project-relative
// paths) or live-artifact tab ids (`live:<id>`); placeable names can live on the board, the rest open as tabs.
import {
  boardKindForPath,
  isBoardMovieDocumentPath,
  type BoardDocument,
  type BoardNode,
  type ProjectFile,
} from '@open-design/contracts';

import { isLiveArtifactTabId, liveArtifactIdFromTabId, type LiveArtifactWorkspaceEntry } from '../../../types';

export interface BoardOpenRequestClassification {
  placeable: string[];
  unplaceable: string[];
}

/**
 * Splits open-request names. Placeable: live-artifact tab ids and paths `boardKindForPath` maps to a node kind
 * (frames, media, designs, `movie-studio.json`, compositions). Folders and everything else are unplaceable. The file
 * list is not required to contain the path (it may still be refreshing); the daemon validates on sync.
 */
export function classifyOpenRequestNames(
  names: readonly string[],
  files: readonly ProjectFile[],
  _liveArtifacts: readonly LiveArtifactWorkspaceEntry[],
): BoardOpenRequestClassification {
  const folders = new Set(files.filter((file) => file.type === 'dir').map((file) => file.name));
  const placeable: string[] = [];
  const unplaceable: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const isPlaceable = isLiveArtifactTabId(name) || (!folders.has(name) && boardKindForPath(name) !== null);
    (isPlaceable ? placeable : unplaceable).push(name);
  }
  return { placeable, unplaceable };
}

function nodeMatchesName(node: BoardNode, name: string, projectId: string): boolean {
  if (isLiveArtifactTabId(name)) {
    return node.kind === 'frame' && node.liveArtifactId === liveArtifactIdFromTabId(name);
  }
  switch (node.kind) {
    case 'frame':
    case 'image':
    case 'video':
    case 'audio':
      return node.ref?.path === name;
    case 'design':
      return node.ref.path === name;
    case 'motion':
      if (node.render?.path === name) return true;
      if (node.source.type === 'composition') return node.source.ref.path === name;
      return isBoardMovieDocumentPath(name) && node.source.projectId === projectId;
    default:
      return false;
  }
}

/** Node ids showing the given names, in name order (read-only boards focus without a sync). */
export function resolveBoardNodesForNames(board: BoardDocument, names: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    for (const node of board.nodes) {
      if (node.hidden || seen.has(node.id) || !nodeMatchesName(node, name, board.projectId)) continue;
      seen.add(node.id);
      ids.push(node.id);
    }
  }
  return ids;
}
