// SPDX-License-Identifier: Apache-2.0
// Planner input gathering for `POST /api/projects/:id/board/sync` (spec 04 §4.5 steps 1–7). Runs before the commit
// transaction (it awaits file stats). Every query against upstream tables (messages, conversations, media_tasks and
// the chat-artifact tables) lives in this file, so an upstream schema change surfaces in board-sync.test.ts first.
import type Database from 'better-sqlite3';
import {
  MEDIA_SURFACES,
  boardKindForPath,
  isSafeBoardPath,
  type BoardContent,
  type BoardNode,
  type BoardSyncLedger,
  type BoardSyncRequest,
  type MediaFailureNextStep,
  type MediaSurface,
} from '@open-design/contracts';

import { getChatArtifactSnapshot, getWorkspaceArtifact, listMessageArtifactRows } from '../../chat-artifacts/store.js';
import { assignMediaTaskBatches } from '../../media/task-batches.js';
import { listMediaTasksByProject, type MediaTaskRow } from '../../media/tasks.js';
import {
  BOARD_SYNC_LOOKBACK_MS,
  boardNodeFileRefs,
  boardRefStatusKey,
  boardSeedCandidates,
  excerptBoardTurnPrompt,
  type BoardFocusTarget,
  type BoardPlannerMediaTask,
  type BoardPlannerTurn,
  type BoardRefField,
  type BoardRefStatus,
} from './planner.js';

type SqliteDb = Database.Database;

/** Number of assistant turns read per sync. */
export const BOARD_SYNC_TURN_LIMIT = 100;
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'canceled']);
const LIVE_PREFIX = 'live:';
const MAX_LIVE_ARTIFACT_ID_LENGTH = 200;

export interface BoardResolvedProjectFile {
  name: string;
  mtime: number;
}

export interface BoardSyncGatherDeps {
  db: SqliteDb;
  projectsRoot: string;
  resolveProjectFilePath: (projectsRoot: string, projectId: string, name: string, metadata?: unknown) => Promise<BoardResolvedProjectFile>;
  listFiles: (projectsRoot: string, projectId: string, opts?: { metadata?: unknown }) => Promise<Array<{ name: string; mtime: number }>>;
  getProject: (db: SqliteDb, id: string) => { id: string; metadata?: unknown } | null;
}

export interface GatherBoardSyncInput {
  projectId: string;
  metadata: unknown;
  request: BoardSyncRequest;
  content: BoardContent;
  ledger: BoardSyncLedger;
  now: number;
}

export interface GatheredBoardSyncInputs {
  seedFiles: Array<{ path: string; mtime: number }> | null;
  turns: BoardPlannerTurn[];
  mediaTasks: BoardPlannerMediaTask[];
  refStatuses: Map<string, BoardRefStatus>;
  snapshotCovers: Map<string, { snapshotId: string; sourceMtime?: number }>;
  focusTargets: Map<string, BoardFocusTarget | null>;
  /** Canonical paths the planner may place, with their mtime; their identities are ensured inside the commit. */
  candidatePaths: Map<string, number | undefined>;
}

interface TurnRow {
  id: string;
  conversationId: string;
  runId: string | null;
  runStatus: string | null;
  producedFilesJson: string | null;
  createdAt: number;
  position: number;
}

const TURN_COLUMNS = `m.id AS id, m.conversation_id AS conversationId, m.run_id AS runId, m.run_status AS runStatus,
       m.produced_files_json AS producedFilesJson, m.created_at AS createdAt, m.position AS position`;

function producedFileNames(json: string | null): string[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const names: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

/** A media task's node already shows its file (no stat needed for the task's output). */
function isConvertedMediaNode(node: BoardNode | undefined): boolean {
  if (!node) return false;
  if ((node.kind === 'image' || node.kind === 'video' || node.kind === 'audio') && node.pending) return false;
  return boardNodeFileRefs(node).length > 0;
}

function lastProgressLine(progress: readonly string[]): string | undefined {
  for (let index = progress.length - 1; index >= 0; index -= 1) {
    const line = progress[index]?.trim();
    if (line) return line;
  }
  return undefined;
}

class BoardSyncGatherer {
  private readonly stats = new Map<string, BoardResolvedProjectFile | null>();
  private readonly candidatePaths = new Map<string, number | undefined>();

  constructor(private readonly deps: BoardSyncGatherDeps, private readonly input: GatherBoardSyncInput) {}

  /** Canonical project file for a name, or null when it is missing, unsafe or outside the project. Cached. */
  async statFile(name: string): Promise<BoardResolvedProjectFile | null> {
    if (this.stats.has(name)) return this.stats.get(name)!;
    let resolved: BoardResolvedProjectFile | null = null;
    if (isSafeBoardPath(name)) {
      try {
        const file = await this.deps.resolveProjectFilePath(this.deps.projectsRoot, this.input.projectId, name, this.input.metadata);
        if (file && typeof file.name === 'string') resolved = { name: file.name, mtime: Number(file.mtime) || 0 };
      } catch {
        resolved = null;
      }
    }
    this.stats.set(name, resolved);
    return resolved;
  }

  private addCandidate(path: string, mtime: number | undefined): void {
    if (!this.candidatePaths.has(path)) this.candidatePaths.set(path, mtime);
  }

  async run(): Promise<GatheredBoardSyncInputs> {
    const seedFiles = await this.seedFiles();
    const turns = await this.turns();
    const mediaTasks = await this.mediaTasks();
    const refStatuses = await this.refStatuses();
    const snapshotCovers = this.snapshotCovers(turns);
    const focusTargets = await this.focusTargets();
    return { seedFiles, turns, mediaTasks, refStatuses, snapshotCovers, focusTargets, candidatePaths: this.candidatePaths };
  }

  // 3. Seed files (only before the first seeding).
  private async seedFiles(): Promise<Array<{ path: string; mtime: number }> | null> {
    if (this.input.ledger.seededAt !== null) return null;
    let files: Array<{ name: string; mtime: number }> = [];
    try {
      files = await this.deps.listFiles(this.deps.projectsRoot, this.input.projectId, { metadata: this.input.metadata });
    } catch {
      files = [];
    }
    const seedFiles = files
      .filter((file) => file && typeof file.name === 'string')
      .map((file) => ({ path: file.name, mtime: Number(file.mtime) || 0 }));
    for (const candidate of boardSeedCandidates(seedFiles, this.input.ledger.dismissed)) {
      this.addCandidate(candidate.path, candidate.mtime);
    }
    return seedFiles;
  }

  // 1. Turns: assistant messages since `cursor - 10 min` (before seeding: the latest 100 of the project's history).
  private async turns(): Promise<BoardPlannerTurn[]> {
    const { db } = this.deps;
    const { projectId, ledger, request } = this.input;
    const rows = ledger.seededAt !== null
      ? (db.prepare(
          `SELECT ${TURN_COLUMNS}
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE c.project_id = ? AND m.role = 'assistant' AND m.created_at >= ?
            ORDER BY m.created_at ASC, m.id ASC LIMIT ${BOARD_SYNC_TURN_LIMIT}`,
        ).all(projectId, ledger.cursor - BOARD_SYNC_LOOKBACK_MS) as TurnRow[])
      : (db.prepare(
          `SELECT ${TURN_COLUMNS}
             FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE c.project_id = ? AND m.role = 'assistant' AND m.created_at >= 0
            ORDER BY m.created_at DESC, m.id DESC LIMIT ${BOARD_SYNC_TURN_LIMIT}`,
        ).all(projectId) as TurnRow[]).reverse();
    const hint = request.turn;
    if (hint && !rows.some((row) => row.id === hint.messageId)) {
      const hinted = db.prepare(
        `SELECT ${TURN_COLUMNS}
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = ? AND c.project_id = ? AND m.role = 'assistant'`,
      ).get(hint.messageId, projectId) as TurnRow | undefined;
      if (hinted) {
        rows.push(hinted);
      } else {
        const conversation = db
          .prepare('SELECT id FROM conversations WHERE id = ? AND project_id = ?')
          .get(hint.conversationId, projectId) as { id: string } | undefined;
        if (conversation) {
          rows.push({
            id: hint.messageId,
            conversationId: hint.conversationId,
            runId: hint.runId ?? null,
            runStatus: null,
            producedFilesJson: null,
            createdAt: this.input.now,
            position: Number.MAX_SAFE_INTEGER,
          });
        }
      }
    }
    const promptStatement = db.prepare(
      `SELECT content FROM messages
        WHERE conversation_id = ? AND role = 'user' AND position < ?
        ORDER BY position DESC LIMIT 1`,
    );
    const turns: BoardPlannerTurn[] = [];
    for (const row of rows) {
      const hinted = hint?.messageId === row.id ? hint : undefined;
      const names = [...producedFileNames(row.producedFilesJson), ...(hinted?.paths ?? [])];
      const outputs: Array<{ path: string; mtime?: number }> = [];
      const seen = new Set<string>();
      for (const name of names) {
        if (!boardKindForPath(name)) continue;
        const file = await this.statFile(name);
        if (!file || seen.has(file.name) || !boardKindForPath(file.name)) continue;
        seen.add(file.name);
        outputs.push({ path: file.name, mtime: file.mtime });
        this.addCandidate(file.name, file.mtime);
      }
      const promptRow = promptStatement.get(row.conversationId, row.position) as { content?: unknown } | undefined;
      const prompt = excerptBoardTurnPrompt(promptRow?.content);
      const terminal = (row.runStatus !== null && TERMINAL_RUN_STATUSES.has(row.runStatus))
        || (row.runStatus === null && row.producedFilesJson !== null)
        || hinted?.status === 'terminal';
      turns.push({
        messageId: row.id,
        conversationId: row.conversationId,
        ...(row.runId ? { runId: row.runId } : hinted?.runId ? { runId: hinted.runId } : {}),
        createdAt: row.createdAt,
        terminal,
        ...(prompt ? { prompt } : {}),
        outputs,
      });
    }
    return turns;
  }

  // 2. Media tasks with a run (known placeholders, unfinished tasks and tasks of the current turn window).
  private async mediaTasks(): Promise<BoardPlannerMediaTask[]> {
    const { db } = this.deps;
    const { projectId, ledger, now, content } = this.input;
    const all = listMediaTasksByProject(db, projectId, { includeTerminal: true })
      .filter((task): task is MediaTaskRow & { runId: string } => typeof task.runId === 'string' && task.runId.length > 0);
    if (all.length === 0) return [];
    const memberships = assignMediaTaskBatches(all.map((task) => ({
      id: task.id,
      runId: task.runId,
      surface: task.surface,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      sequence: task.sequence,
    })));
    const windowStart = (ledger.seededAt !== null ? ledger.cursor : now) - BOARD_SYNC_LOOKBACK_MS;
    const nodesById = new Map<string, BoardNode>(content.nodes.map((node) => [node.id, node]));
    const runMessages = new Map<string, { id: string; conversationId: string } | null>();
    const runStatement = db.prepare(
      `SELECT m.id AS id, m.conversation_id AS conversationId
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.run_id = ? AND c.project_id = ? LIMIT 1`,
    );
    const tasks: BoardPlannerMediaTask[] = [];
    for (const task of all) {
      if (!task.surface || !(MEDIA_SURFACES as readonly string[]).includes(task.surface)) continue;
      const ledgerNodeId = ledger.mediaTasks[task.id];
      const unfinished = task.status === 'queued' || task.status === 'running';
      if (ledgerNodeId === undefined && !unfinished && task.startedAt < windowStart) continue;
      const membership = memberships.get(task.id);
      if (!membership) continue;
      if (!runMessages.has(task.runId)) {
        runMessages.set(task.runId, (runStatement.get(task.runId, projectId) as { id: string; conversationId: string } | undefined) ?? null);
      }
      const message = runMessages.get(task.runId) ?? null;
      let filePath: string | undefined;
      const fileName = task.file && typeof task.file === 'object' ? (task.file as { name?: unknown }).name : undefined;
      if (task.status === 'done' && typeof fileName === 'string') {
        const ledgerNode = ledgerNodeId !== undefined ? nodesById.get(ledgerNodeId) : undefined;
        const removed = ledgerNodeId !== undefined && ledgerNode === undefined;
        if (!removed && !isConvertedMediaNode(ledgerNode)) {
          const file = await this.statFile(fileName);
          if (file) {
            filePath = file.name;
            this.addCandidate(file.name, file.mtime);
          }
        }
      }
      const progress = lastProgressLine(task.progress);
      tasks.push({
        taskId: task.id,
        runId: task.runId,
        ...(message ? { messageId: message.id, conversationId: message.conversationId } : {}),
        surface: task.surface as MediaSurface,
        status: task.status,
        batchId: membership.batchId,
        batchIndex: membership.batchIndex,
        batchSize: membership.batchSize,
        sequence: task.sequence,
        ...(filePath ? { filePath } : {}),
        ...(progress ? { progress } : {}),
        ...(task.error
          ? {
              error: {
                message: String(task.error.message ?? ''),
                ...(task.error.nextStep ? { nextStep: task.error.nextStep as MediaFailureNextStep } : {}),
              },
            }
          : {}),
      });
    }
    return tasks;
  }

  // 4. Ref statuses of every file-backed node (identity first, then a stat).
  private async refStatuses(): Promise<Map<string, BoardRefStatus>> {
    const statuses = new Map<string, BoardRefStatus>();
    const { db } = this.deps;
    const { projectId, content } = this.input;
    for (const node of content.nodes) {
      for (const { field, ref } of boardNodeFileRefs(node)) {
        const status = await this.refStatus(node.id, field, ref.path, ref.workspaceArtifactId);
        statuses.set(boardRefStatusKey(node.id, field), status);
      }
      if (node.kind === 'motion' && node.source.type === 'movie') {
        const sourceProjectId = node.source.projectId;
        let present = false;
        if (sourceProjectId === projectId) {
          present = (await this.statFile('movie-studio.json')) !== null;
        } else {
          const other = this.deps.getProject(db, sourceProjectId);
          if (other) {
            try {
              await this.deps.resolveProjectFilePath(this.deps.projectsRoot, sourceProjectId, 'movie-studio.json', other.metadata);
              present = true;
            } catch {
              present = false;
            }
          }
        }
        statuses.set(boardRefStatusKey(node.id, 'source'), { nodeId: node.id, field: 'source', status: present ? 'present' : 'missing' });
      }
    }
    return statuses;
  }

  private async refStatus(nodeId: string, field: BoardRefField, path: string, workspaceArtifactId: string | undefined): Promise<BoardRefStatus> {
    if (workspaceArtifactId) {
      const identity = getWorkspaceArtifact(this.deps.db, workspaceArtifactId);
      if (identity && identity.projectId === this.input.projectId) {
        if (identity.deletedAt !== null || identity.currentPath === null) {
          return { nodeId, field, status: 'deleted', workspaceArtifactId };
        }
        if (identity.currentPath !== path) {
          return { nodeId, field, status: 'renamed', path: identity.currentPath, workspaceArtifactId };
        }
      }
    }
    // Path-only refs, unknown identities and live identities at the same path (a shell `rm`/`mv` leaves the
    // identity live) are stat-checked.
    const file = await this.statFile(path);
    return file
      ? { nodeId, field, status: 'present', mtime: file.mtime, ...(workspaceArtifactId ? { workspaceArtifactId } : {}) }
      : { nodeId, field, status: 'missing', ...(workspaceArtifactId ? { workspaceArtifactId } : {}) };
  }

  // 6. Snapshot covers of the processed turns' chat artifacts, keyed by the artifact's current path.
  private snapshotCovers(turns: readonly BoardPlannerTurn[]): Map<string, { snapshotId: string; sourceMtime?: number }> {
    const covers = new Map<string, { snapshotId: string; sourceMtime?: number }>();
    const { db } = this.deps;
    for (const turn of turns) {
      for (const row of listMessageArtifactRows(db, turn.messageId)) {
        if (!row.snapshotId || !row.workspaceArtifactId) continue;
        const snapshot = getChatArtifactSnapshot(db, row.snapshotId);
        if (!snapshot || snapshot.projectId !== this.input.projectId) continue;
        if (snapshot.captureState !== 'ready' || !snapshot.thumbnailDigest) continue;
        const artifact = getWorkspaceArtifact(db, row.workspaceArtifactId);
        if (!artifact || artifact.deletedAt !== null || !artifact.currentPath) continue;
        covers.set(artifact.currentPath, {
          snapshotId: snapshot.id,
          ...(typeof snapshot.sourceMtime === 'number' ? { sourceMtime: snapshot.sourceMtime } : {}),
        });
      }
    }
    return covers;
  }

  // 7. Focus names: `live:<id>` → live artifact frame; other names → a placeable project file, else unplaceable.
  private async focusTargets(): Promise<Map<string, BoardFocusTarget | null>> {
    const targets = new Map<string, BoardFocusTarget | null>();
    for (const name of this.input.request.focus?.names ?? []) {
      if (targets.has(name)) continue;
      if (name.startsWith(LIVE_PREFIX)) {
        const liveArtifactId = name.slice(LIVE_PREFIX.length).trim();
        targets.set(name, liveArtifactId && liveArtifactId.length <= MAX_LIVE_ARTIFACT_ID_LENGTH ? { kind: 'live', liveArtifactId } : null);
        continue;
      }
      if (!boardKindForPath(name)) {
        targets.set(name, null);
        continue;
      }
      const file = await this.statFile(name);
      if (!file || !boardKindForPath(file.name)) {
        targets.set(name, null);
        continue;
      }
      targets.set(name, { kind: 'file', path: file.name, mtime: file.mtime });
      this.addCandidate(file.name, file.mtime);
    }
    return targets;
  }
}

/** Gathers everything `planBoardSync` needs except identities (ensured inside the commit transaction). */
export function gatherBoardSyncInputs(deps: BoardSyncGatherDeps, input: GatherBoardSyncInput): Promise<GatheredBoardSyncInputs> {
  return new BoardSyncGatherer(deps, input).run();
}
