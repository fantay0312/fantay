// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — project conversations (Studio chat runs) read and learn through the engine.
//
// Before a run: the project's conversations are synced into raw windows and one recall builds the <memory>
// block that rides the turn's user body. After a run: the conversation is synced again and, when Settings →
// 记忆 → 从对话中学习 is on, the turn is distilled into conversation, project or profile memories.
// Neither side may fail or stall a run, so every path ends in "" or a settled promise.

import { createHash } from "node:crypto";
import type { MemoryScopeRef, PaMemorySourceRef } from "@open-design/contracts";
import type { SqliteDb } from "../../db.js";
import { readMemoryConfig } from "../../memory.js";
import {
  sweepDeletedStudioConversations,
  syncStudioConversation,
  syncStudioProject,
  type DistillTarget,
  type MemoryEngineApi,
  type MemoryLlm,
} from "./index.js";

const RECALL_TIMEOUT_MS = 800;
/** Time a turn may spend bringing the project's other conversations up to date; the rest continues in the background. */
const SYNC_BUDGET_MS = 120;
const BACKFILL_STEP_MS = 60;
const BACKFILL_PAUSE_MS = 25;
/** Windows made only of these last messages are already in the model's context. */
const RECENT_MESSAGES_IN_CONTEXT = 20;
/** A headless caller may send the whole transcript as the query; its tail is the latest turn. */
const QUERY_MAX_CHARS = 2_000;
/** Same budget per side as the Settings extractor this replaces. */
const TURN_TEXT_MAX_CHARS = 4_000;
/** Retries re-fire the close hook with the same turn; one model call per turn is enough. */
const RECENT_TURNS_LIMIT = 256;

const USER_SPEAKER = "用户";
const ASSISTANT_SPEAKER = "助手";

export interface StudioMemoryBridgeDeps {
  engine: MemoryEngineApi;
  /** The daemon database (tables `conversations` and `messages`). */
  db: SqliteDb;
  /** Daemon data root; Settings → 记忆 switches live under it. */
  dataDir: string;
  /** Model for learning from a turn when the run brings none. Null leaves it to the engine's own model. */
  llm: MemoryLlm | null;
  /** Test seam. */
  recallTimeoutMs?: number | undefined;
}

export interface StudioRecallInput {
  projectId?: string | null | undefined;
  conversationId?: string | null | undefined;
  /** The latest user turn. */
  query: string;
}

export interface StudioAfterRunInput {
  projectId?: string | null | undefined;
  conversationId?: string | null | undefined;
  /** The latest user turn; empty skips learning. */
  userText: string;
  assistantText: string;
  assistantMessageId?: string | null | undefined;
  /** The run's own model choice (its agent or API provider). */
  llm?: MemoryLlm | null | undefined;
}

export interface StudioMemoryBridge {
  /**
   * Brings the conversations of every project up to date in the background, a short step at a time, so that
   * conversations from before this engine existed are searchable without waiting for each project's next run.
   * Does nothing while Settings → 记忆 is off. Never rejects.
   */
  backfillAll(): Promise<void>;
  /** The `<memory>` block for this turn, or "" when there is none, memory is off, or recall took too long. */
  recallForRun(input: StudioRecallInput): Promise<string>;
  /** Syncs the conversation at once; the promise settles when background learning is done and never rejects. */
  afterRun(input: StudioAfterRunInput): Promise<void>;
}

export function createStudioMemoryBridge(deps: StudioMemoryBridgeDeps): StudioMemoryBridge {
  const { engine, db, dataDir } = deps;
  const timeoutMs = deps.recallTimeoutMs ?? RECALL_TIMEOUT_MS;
  const recentMessages = db.prepare(
    `SELECT id FROM messages
      WHERE conversation_id = ? AND branch_visible = 1 AND role IN ('user', 'assistant')
      ORDER BY position DESC
      LIMIT ${RECENT_MESSAGES_IN_CONTEXT}`,
  );
  const conversationTitle = db.prepare(`SELECT title FROM conversations WHERE id = ?`);
  const recentTurns = new Set<string>();

  const projectIds = db.prepare(`SELECT DISTINCT project_id AS id FROM conversations ORDER BY updated_at DESC`);
  const backfillQueue: string[] = [];
  const backfillQueued = new Set<string>();
  let backfillRunning = false;

  /**
   * Finishes a project's sync in short steps between other work, so a large project never stalls a turn. One
   * project at a time: several running side by side would hold the event loop back to back.
   */
  function backfill(projectId: string): void {
    if (backfillQueued.has(projectId)) return;
    backfillQueued.add(projectId);
    backfillQueue.push(projectId);
    if (backfillRunning) return;
    backfillRunning = true;
    setTimeout(backfillStep, BACKFILL_PAUSE_MS).unref();
  }

  function backfillStep(): void {
    const projectId = backfillQueue[0];
    if (projectId === undefined) {
      backfillRunning = false;
      return;
    }
    let done = true;
    try {
      done = syncStudioProject(engine.chunkSink, db, projectId, { budgetMs: BACKFILL_STEP_MS });
    } catch (error) {
      // A project that cannot be synced now is dropped from the queue; its next run tries again.
      console.warn("[memory] studio project sync failed", error);
    }
    if (done) {
      backfillQueue.shift();
      backfillQueued.delete(projectId);
    }
    if (backfillQueue.length > 0) setTimeout(backfillStep, BACKFILL_PAUSE_MS).unref();
    else backfillRunning = false;
  }

  async function recall(projectId: string, conversationId: string | null, query: string, signal: AbortSignal) {
    const settings = await readMemoryConfig(dataDir);
    if (!settings.enabled || signal.aborted) return "";
    // Conversations deleted since the last turn (in this project or any other) stop being quoted from now on.
    sweepDeletedStudioConversations(engine.chunkSink, db);
    if (!syncStudioProject(engine.chunkSink, db, projectId, { budgetMs: SYNC_BUDGET_MS, first: conversationId })) {
      backfill(projectId);
    }
    const excludeMessageIds = conversationId
      ? new Set((recentMessages.all(conversationId) as Array<{ id: string }>).map((row) => row.id))
      : undefined;
    const result = await engine.recall({
      query,
      access: { surface: "studio", projectId, conversationId, ownerProfile: settings.profileEnabled !== false },
      excludeMessageIds,
      logAs: "studio",
      signal,
    });
    return result.promptBlock;
  }

  async function learn(projectId: string, conversationId: string, input: StudioAfterRunInput): Promise<void> {
    const userText = input.userText.trim();
    if (!userText) return;
    const settings = await readMemoryConfig(dataDir);
    if (!settings.enabled || !settings.chatExtractionEnabled) return;
    if (engine.config().autoMemory === "off") return;
    const assistantText = input.assistantText.trim();
    const signature = turnSignature(conversationId, userText, assistantText);
    if (recentTurns.has(signature)) return;
    rememberTurn(recentTurns, signature);

    const lines = [`${USER_SPEAKER}: ${userText.slice(0, TURN_TEXT_MAX_CHARS)}`];
    if (assistantText) lines.push(`${ASSISTANT_SPEAKER}: ${assistantText.slice(0, TURN_TEXT_MAX_CHARS)}`);
    const title = (conversationTitle.get(conversationId) as { title: string | null } | undefined)?.title?.trim();
    const sourceRefs: PaMemorySourceRef[] = input.assistantMessageId
      ? [{ kind: "message", id: input.assistantMessageId, conversationId }]
      : [];
    const llm = input.llm ?? deps.llm;
    await engine.distill({
      transcript: lines.join("\n\n"),
      targets: studioTargets(projectId, conversationId, settings.profileEnabled !== false),
      source: title ? `项目对话 · ${title}` : "项目对话",
      sourceRefs,
      // Left out, the engine uses its own model.
      ...(llm ? { llm } : {}),
    });
  }

  return {
    async backfillAll() {
      try {
        // Whether memory is on or off, what was deleted is not kept.
        sweepDeletedStudioConversations(engine.chunkSink, db);
        const settings = await readMemoryConfig(dataDir);
        if (!settings.enabled) return;
        for (const row of projectIds.all() as Array<{ id: string | null }>) if (row.id) backfill(row.id);
      } catch (error) {
        console.warn("[memory] studio backfill failed", error);
      }
    },

    async recallForRun(input) {
      const projectId = input.projectId?.trim();
      const query = input.query.trim().slice(-QUERY_MAX_CHARS);
      if (!projectId || !query) return "";
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<string>((resolve) => {
        timer = setTimeout(() => {
          resolve("");
          controller.abort();
        }, timeoutMs);
        timer.unref();
      });
      try {
        return await Promise.race([
          recall(projectId, input.conversationId?.trim() || null, query, controller.signal),
          timedOut,
        ]);
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[memory] studio recall failed", error);
        return "";
      } finally {
        clearTimeout(timer);
      }
    },

    afterRun(input) {
      const conversationId = input.conversationId?.trim();
      if (!conversationId) return Promise.resolve();
      try {
        syncStudioConversation(engine.chunkSink, db, conversationId);
      } catch (error) {
        console.warn("[memory] studio conversation sync failed", error);
      }
      const projectId = input.projectId?.trim();
      if (!projectId) return Promise.resolve();
      return learn(projectId, conversationId, input).catch((error: unknown) => {
        console.warn("[memory] studio distill failed", error);
      });
    },
  };
}

function studioTargets(projectId: string, conversationId: string, ownerProfile: boolean): DistillTarget[] {
  const target = (scope: MemoryScopeRef, hint: string): DistillTarget => ({ scope, hint });
  return [
    target({ kind: "conversation", id: conversationId }, "only matters inside this conversation thread"),
    target({ kind: "project", id: projectId }, "true for the whole project"),
    // With the owner profile switched off in Settings, nothing is read from it and nothing is added to it.
    ...(ownerProfile ? [target({ kind: "profile", id: "" }, "stable facts and preferences about the owner")] : []),
  ];
}

function turnSignature(conversationId: string, userText: string, assistantText: string): string {
  return createHash("sha256").update(JSON.stringify([conversationId, userText, assistantText])).digest("hex");
}

function rememberTurn(turns: Set<string>, signature: string): void {
  turns.add(signature);
  if (turns.size <= RECENT_TURNS_LIMIT) return;
  const oldest = turns.values().next().value;
  if (oldest !== undefined) turns.delete(oldest);
}
