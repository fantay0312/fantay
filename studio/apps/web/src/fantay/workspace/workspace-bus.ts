// SPDX-License-Identifier: AGPL-3.0-only
// Workspace command bus (spec 07 §2.1(a) + plan R21 `design` draft): a tiny typed module registry, no
// window events. Obligations: the board subscribes to `board.insert` while a project board is mounted
// and drains queued inserts on mount; the shell/FileWorkspace subscribes to `workspace.openEditor`
// (show the 文件 surface, then open the file tab — never a board focus) and `workspace.view`; the
// sidebar subscribes to `sidebar.focus`. A subscriber returns true only when it handled the command
// (for example only for its own projectId), so later senders can fall back (navigate / queue).
import type { BoardNodeProvenance, MOVIE_DOCUMENT_FILE } from '@open-design/contracts';

/** Material provenance carried by a board draft; one shape with the board contract (plan R3d). */
export type NodeProvenance = BoardNodeProvenance;

/** What the board must be able to create. The board maps a draft to its own node type. */
export type FantayNodeDraft =
  | { kind: 'image' | 'video' | 'frame'; path: string; title?: string; provenance?: NodeProvenance }
  | { kind: 'web'; url: string; title?: string; provenance?: NodeProvenance }
  | { kind: 'note'; text: string; title?: string; provenance?: NodeProvenance }
  | { kind: 'motion'; projectId: string; path: typeof MOVIE_DOCUMENT_FILE; title?: string }
  /** R21: a saved design document (`.fig` / `.op`); `sourceNodeId` adds a lineage edge from that node. */
  | { kind: 'design'; path: string; title?: string; sourceNodeId?: string };

export type WorkspaceCommand =
  | { type: 'board.insert'; projectId: string; drafts: FantayNodeDraft[]; at?: { x: number; y: number }; select?: boolean }
  | { type: 'workspace.openEditor'; projectId: string; fileName: string }
  | { type: 'workspace.view'; projectId: string; view: 'board' | 'files'; focus?: { kind: 'motion' } }
  | { type: 'sidebar.focus'; section: 'motion' };

type CommandOf<T extends WorkspaceCommand['type']> = Extract<WorkspaceCommand, { type: T }>;
/** Exported alias of the per-type command shape, for subscribers' handler signatures. */
export type WorkspaceCommandOf<T extends WorkspaceCommand['type']> = CommandOf<T>;

type AnyHandler = (command: WorkspaceCommand) => boolean;

const subscribers = new Map<WorkspaceCommand['type'], AnyHandler[]>();
const queuedBoardInserts = new Map<string, CommandOf<'board.insert'>[]>();

/** Returns true when a subscriber handled the command. Later subscribers are asked first (stack order). */
export function sendWorkspaceCommand(command: WorkspaceCommand): boolean {
  const handlers = subscribers.get(command.type);
  if (!handlers || handlers.length === 0) return false;
  const snapshot = handlers.slice();
  for (let index = snapshot.length - 1; index >= 0; index -= 1) {
    if (snapshot[index]!(command) === true) return true;
  }
  return false;
}

/** Handler returns true when handled; later subscribers win (stack order). Returns unsubscribe. */
export function subscribeWorkspaceCommand<T extends WorkspaceCommand['type']>(
  type: T, handler: (command: CommandOf<T>) => boolean,
): () => void {
  const entry: AnyHandler = (command) => handler(command as CommandOf<T>);
  const list = subscribers.get(type);
  if (list) list.push(entry);
  else subscribers.set(type, [entry]);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = subscribers.get(type);
    if (!current) return;
    const index = current.indexOf(entry);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) subscribers.delete(type);
  };
}

export function hasWorkspaceSubscriber(type: WorkspaceCommand['type']): boolean {
  return (subscribers.get(type)?.length ?? 0) > 0;
}

/** Board inserts that arrive while no board is mounted for that project. In-memory, per tab. */
export function queueBoardInsert(command: CommandOf<'board.insert'>): void {
  const list = queuedBoardInserts.get(command.projectId);
  if (list) list.push(command);
  else queuedBoardInserts.set(command.projectId, [command]);
}

/** Returns (and forgets) the queued inserts of `projectId`, oldest first. */
export function drainQueuedBoardInserts(projectId: string): CommandOf<'board.insert'>[] {
  const list = queuedBoardInserts.get(projectId) ?? [];
  queuedBoardInserts.delete(projectId);
  return list;
}

export function resetWorkspaceBusForTests(): void {
  subscribers.clear();
  queuedBoardInserts.clear();
}
