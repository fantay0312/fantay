// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — everything Personal-Agent-shaped about memory, so the PA service stays readable: the
// PaMemory ⇄ item mapping, the one-time import of the legacy PA store, the conversation reader that feeds raw windows,
// the episode and transcript text builders, and the model adapter over the PA runtime.

import { randomUUID } from "node:crypto";
import type {
  MemoryItem,
  MemoryItemKind,
  MemoryScopeRef,
  PaConversation,
  PaEpisode,
  PaMemory,
  PaMemoryInput,
  PaMemoryKind,
  PaMemorySourceRef,
  PaMemoryStatus,
  PaMessage,
  PaModel,
} from "@open-design/contracts";
import type { PaModelRuntime } from "../../runtimes/personal-agent.js";
import { PaError } from "../../storage/personal-agent-store.js";
import { inspectMemoryWriteSecurity } from "../pa/memory-security.js";
import { paRouteAllows, redactPaCredentials } from "../personal-agent-gateway.js";
import {
  MemoryError,
  type IngestMessage,
  type MemoryEngineApi,
  type MemoryItemRow,
  type MemoryLlm,
  type PaConversationReader,
} from "./index.js";

export type PaMemoryScope = PaMemoryInput["scope"];

const MAX_SOURCE_REFS = 32;
const MODEL_TIMEOUT_MS = 120_000;
const STORY_KINDS: ReadonlySet<string> = new Set(["roll", "draw", "event"]);

// ---- scopes, kinds, statuses ---------------------------------------------------------------------------------------

export function engineScopeOf(scope: PaMemoryScope, scopeId: string | null | undefined): MemoryScopeRef {
  switch (scope) {
    case "private":
      return { kind: "profile", id: "" };
    case "agent":
      return { kind: "bot", id: scopeId ?? "" };
    case "group":
      return { kind: "group", id: scopeId ?? "" };
    case "project":
      return { kind: "project", id: scopeId ?? "" };
  }
}

/** The PA name of an engine scope; persona and conversation scopes have none. */
export function paScopeOf(scope: MemoryScopeRef): { scope: PaMemoryScope; scopeId: string | null } | null {
  switch (scope.kind) {
    case "profile":
      return { scope: "private", scopeId: null };
    case "bot":
      return { scope: "agent", scopeId: scope.id };
    case "group":
      return { scope: "group", scopeId: scope.id };
    case "project":
      return { scope: "project", scopeId: scope.id };
    default:
      return null;
  }
}

export function sameScope(a: MemoryScopeRef, b: MemoryScopeRef): boolean {
  return a.kind === b.kind && (a.kind === "profile" || a.id === b.id);
}

/** The engine knows more kinds than the PA surface; each maps to the PA kind closest to it. */
const PA_KIND: Record<MemoryItemKind, PaMemoryKind> = {
  profile: "profile",
  preference: "preference",
  fact: "fact",
  decision: "fact",
  procedure: "procedure",
  promise: "promise",
  moment: "moment",
  episode: "moment",
  rule: "preference",
  reference: "fact",
  feedback: "preference",
};

export function paKindOf(kind: MemoryItemKind): PaMemoryKind {
  return PA_KIND[kind];
}

/** Pending proposals have no PA status: they live in the inbox, not in the memory list. */
export function paStatusOf(item: Pick<MemoryItem, "status" | "openConflictIds">): PaMemoryStatus | null {
  switch (item.status) {
    case "active":
      return item.openConflictIds.length > 0 ? "challenged" : "active";
    case "superseded":
      return "superseded";
    case "archived":
    case "rejected":
      return "archived";
    default:
      return null;
  }
}

export function toPaMemory(
  item: MemoryItem,
  options: { principalId?: string | undefined; asPrivate?: boolean | undefined } = {},
): PaMemory | null {
  const status = paStatusOf(item);
  const place = paScopeOf(item.scope) ?? (options.asPrivate ? { scope: "private" as const, scopeId: null } : null);
  if (!status || !place) return null;
  const message = item.sourceRefs.find((ref) => ref.kind === "message");
  return {
    id: item.id,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    revision: item.revision,
    content: item.content,
    source: item.source || "记忆",
    scope: place.scope,
    scopeId: place.scopeId,
    kind: paKindOf(item.kind),
    originKind: item.origin,
    pinned: item.pinned,
    status,
    sourceRefs: item.sourceRefs.slice(0, MAX_SOURCE_REFS),
    ...(item.validFrom !== null ? { validFrom: item.validFrom } : {}),
    validUntil: item.validUntil,
    dataClass: item.dataClass,
    dueAt: item.dueAt,
    sourceMessageId: message?.id ?? null,
    ...(options.principalId && options.principalId !== "owner" ? { principalId: options.principalId } : {}),
  };
}

/** `sourceMessageId` is kept as the first message reference, so it maps back the same way. */
export function sourceRefsOf(
  input: Pick<PaMemoryInput, "sourceRefs" | "sourceMessageId">,
  extra: readonly PaMemorySourceRef[] = [],
): PaMemorySourceRef[] {
  const refs: PaMemorySourceRef[] = [];
  const add = (ref: PaMemorySourceRef) => {
    if (!refs.some((known) => known.kind === ref.kind && known.id === ref.id)) refs.push(ref);
  };
  if (input.sourceMessageId) add({ kind: "message", id: input.sourceMessageId });
  for (const ref of input.sourceRefs ?? []) add(ref);
  for (const ref of extra) add(ref);
  return refs.slice(0, MAX_SOURCE_REFS);
}

/** Engine errors as the PA API reports them. */
export function paErrorOf(error: unknown): unknown {
  if (!(error instanceof MemoryError)) return error;
  switch (error.code) {
    case "MEMORY_NOT_FOUND":
      return new PaError("记录不存在", 404, "PA_NOT_FOUND");
    case "MEMORY_REVISION_CONFLICT":
      return new PaError("记忆已更新，请刷新后重试", 409, "PA_REVISION_CONFLICT");
    case "MEMORY_SECRET_BLOCKED":
      return new PaError(error.message, 400, "PA_MEMORY_SECRET_BLOCKED");
    case "MEMORY_FORBIDDEN":
      return new PaError(error.message, 403, "PA_CAPABILITY_DENIED");
    default:
      return new PaError(error.message, error.status, "PA_INVALID_REQUEST");
  }
}

// ---- engine writes, observed -----------------------------------------------------------------------------------------

const ENGINE_WRITES: ReadonlySet<PropertyKey> = new Set([
  "remember",
  "revise",
  "archive",
  "restore",
  "redact",
  "accept",
  "reject",
  "copy",
  "resolveConflict",
  "distill",
  "tidy",
  "reindex",
]);

/**
 * The same engine, calling `onWrite` after every method that can change items. The PA snapshot tag needs it: memory
 * written through the Memory Center never touches the PA store, yet the PA page lists it.
 */
export function watchEngineWrites(engine: MemoryEngineApi, onWrite: () => void): MemoryEngineApi {
  const wrapped = new Map<PropertyKey, unknown>();
  return new Proxy(engine, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const known = wrapped.get(property);
      if (known) return known;
      const method = value as (...args: unknown[]) => unknown;
      const call = ENGINE_WRITES.has(property)
        ? (...args: unknown[]) => {
            const out = method.apply(target, args);
            if (out instanceof Promise) return out.finally(onWrite);
            onWrite();
            return out;
          }
        : method.bind(target);
      wrapped.set(property, call);
      return call;
    },
  });
}

// ---- legacy import ---------------------------------------------------------------------------------------------------

export interface LegacyPaMemory extends PaMemory {
  /** Name of the markdown file that held the text; `<id>.md` when absent. */
  fileName?: string | undefined;
}

export interface LegacyPaMemoryVersion extends LegacyPaMemory {
  memoryId: string;
  sourceRevision: number;
}

export interface LegacyPaSource {
  memories(): LegacyPaMemory[];
  versions(): LegacyPaMemoryVersion[];
  episodes(): PaEpisode[];
  /** Text of a legacy memory file, or null when it is missing or unreadable. */
  readText(fileName: string): string | null;
}

/** A legacy record, or some of its versions, that did not reach the ledger. */
export interface LegacyImportSkip {
  /** The legacy memory or episode id. */
  id: string;
  /**
   * `no_scope`: a shared scope without an id. `no_text`: an episode without a summary. `refused`: versions the write
   * gate refused (they look like a secret or an injected instruction). `missing`: versions whose file is gone.
   * `taken`: the id already names a memory of another scope or member. `error`: the engine refused the record.
   */
  reason: "no_scope" | "no_text" | "refused" | "missing" | "taken" | "error";
  /** Versions left out (the current one included), for `refused` and `missing`. */
  count?: number;
  message?: string;
}

export interface LegacyImportReport {
  /** Memories written by this run. */
  memories: number;
  /** Earlier legacy versions appended by this run. */
  versions: number;
  episodes: number;
  /** No version had text the ledger may hold: the record keeps its id, without text. */
  redacted: number;
  /** The current text was missing or refused: the earlier versions are kept and the memory is put away. */
  putAway: number;
  /** Legacy records not imported. */
  skipped: number;
  conflictsOpened: number;
  /** What was left out and why, at most MAX_REPORTED_SKIPS entries; `skipsOmitted` counts the rest. */
  skips: LegacyImportSkip[];
  skipsOmitted: number;
}

/** What the ledger should hold for one legacy memory, worked out from the legacy rows and files alone. */
interface LegacyPlan {
  /** Versions to store, oldest first. With `standIn`, the last one is a placeholder for the current text. */
  texts: string[];
  /** Why the current text is a placeholder; such a memory is put away, never recalled as if it were real text. */
  standIn: "missing" | "refused" | null;
  /** Nothing the ledger may hold: the single text is a placeholder, cleared once written. */
  empty: boolean;
  /** Versions the write gate refused, the current one included. */
  refused: number;
}

const IMPORT_SOURCE = "旧版记忆";
const IMPORT_NOTE = "导入的旧版本";
const MAX_REPORTED_SKIPS = 100;
const MESSAGE_MAX_CHARS = 200;
const STAND_IN_TEXT: Record<"missing" | "refused", (id: string) => string> = {
  missing: (id) => `（原记忆文件缺失：${id}）`,
  refused: (id) => `（原记忆内容未通过写入安全检查，未导入：${id}）`,
};
const STAND_IN_NOTE: Record<"missing" | "refused", string> = {
  missing: "导入时当前记忆文件缺失，保留此前的版本并归档",
  refused: "导入时当前内容未通过写入安全检查，保留此前的版本并归档",
};
/** Status changes someone already made; a rerun leaves the status of such a memory as it is. */
const STATUS_EVENTS: ReadonlySet<string> = new Set(["archived", "restored", "superseded", "reinstated", "rejected"]);

/**
 * Copies the legacy PA memory store into the engine. Nothing legacy is changed. Ids, revisions, timestamps and
 * principals are kept; earlier versions become earlier versions; `supersedes` becomes a decided conflict (the newer
 * memory kept), `challenges` an open one, `enriches` a `pa_memory` source reference. Every step is decided from the
 * existing row (its scope, version count, current text and status), so a run that was cut short is finished by the
 * next one, and a run over a finished import changes nothing.
 */
export function importLegacyPaMemories(engine: MemoryEngineApi, source: LegacyPaSource): LegacyImportReport {
  const report: LegacyImportReport = {
    memories: 0, versions: 0, episodes: 0, redacted: 0, putAway: 0, skipped: 0, conflictsOpened: 0,
    skips: [], skipsOmitted: 0,
  };
  const legacy = source.memories();
  const byId = new Map(legacy.map((memory) => [memory.id, memory]));
  const history = new Map<string, LegacyPaMemoryVersion[]>();
  for (const version of source.versions()) {
    const list = history.get(version.memoryId) ?? [];
    list.push(version);
    history.set(version.memoryId, list);
  }
  for (const list of history.values()) list.sort((a, b) => a.sourceRevision - b.sourceRevision);

  const plans = new Map<string, LegacyPlan>();
  const seen = new Set<string>();
  const importOne = (memory: LegacyPaMemory): void => {
    if (seen.has(memory.id)) return;
    seen.add(memory.id);
    // The memory a newer one evolves from goes in first, so the relation can be recorded.
    const target = memory.evolves ? byId.get(memory.evolves.targetId) : undefined;
    if (target) importOne(target);
    const plan = importMemory(engine, memory, history.get(memory.id) ?? [], source, byId, report);
    if (plan) plans.set(memory.id, plan);
  };
  // Appending earlier versions runs the engine's duplicate rules against what is already in the scope; importing the
  // memories that have versions first keeps that to the few of them.
  const ordered = [...legacy].sort(
    (a, b) => Number(history.has(b.id)) - Number(history.has(a.id)) || a.createdAt - b.createdAt,
  );
  for (const memory of ordered) importOne(memory);
  // Statuses last: a memory is put away only after every memory that points at it is in.
  for (const memory of legacy) {
    const plan = plans.get(memory.id);
    if (plan) settleMemory(engine, memory, plan, report);
  }
  for (const episode of source.episodes()) importEpisode(engine, episode, report);
  return report;
}

function planOf(
  memory: LegacyPaMemory,
  versions: readonly LegacyPaMemoryVersion[],
  source: LegacyPaSource,
  report: LegacyImportReport,
): LegacyPlan {
  const texts: string[] = [];
  let refused = 0;
  let missing = 0;
  const keep = (text: string | undefined): boolean => {
    if (!text) {
      missing += 1;
      return false;
    }
    // Checked here with the engine's own gate, so a refused version is left out and the later ones still go in.
    if (!inspectMemoryWriteSecurity(text).ok) {
      refused += 1;
      return false;
    }
    if (text !== texts.at(-1)) texts.push(text);
    return true;
  };
  for (const version of versions) keep(source.readText(version.fileName ?? `${version.memoryId}.md`)?.trim());
  const current = source.readText(memory.fileName ?? `${memory.id}.md`)?.trim();
  const kept = keep(current);
  if (refused) listSkip(report, { id: memory.id, reason: "refused", count: refused });
  if (missing) listSkip(report, { id: memory.id, reason: "missing", count: missing });
  if (kept) return { texts, standIn: null, empty: false, refused };
  const standIn = current ? "refused" : "missing";
  const placeholder = STAND_IN_TEXT[standIn](memory.id);
  if (texts.length === 0) return { texts: [placeholder], standIn: null, empty: true, refused };
  return { texts: [...texts, placeholder], standIn, empty: false, refused };
}

function importMemory(
  engine: MemoryEngineApi,
  memory: LegacyPaMemory,
  versions: readonly LegacyPaMemoryVersion[],
  source: LegacyPaSource,
  byId: ReadonlyMap<string, LegacyPaMemory>,
  report: LegacyImportReport,
): LegacyPlan | null {
  if (memory.scope !== "private" && !memory.scopeId) {
    skip(report, { id: memory.id, reason: "no_scope" });
    return null;
  }
  const scope = engineScopeOf(memory.scope, memory.scopeId);
  const principalId = memory.principalId ?? "owner";
  const plan = planOf(memory, versions, source, report);

  const target = memory.evolves && memory.evolves.targetId !== memory.id ? engine.getRow(memory.evolves.targetId) : null;
  const related = target && target.principalId === principalId && sameScope(rowScope(target), scope) ? target : null;
  const relation = related ? memory.evolves!.relation : null;
  const opposes = relation === "supersedes" || relation === "challenges";

  const known = engine.getRow(memory.id);
  if (known && (known.principalId !== principalId || !sameScope(rowScope(known), scope))) {
    skip(report, { id: memory.id, reason: "taken" });
    return null;
  }
  let openedNow: string | null = null;
  if (!known) {
    try {
      const result = engine.remember({
        id: memory.id,
        scope,
        principalId,
        kind: memory.kind ?? "fact",
        origin: memory.originKind ?? "user_explicit",
        pinned: memory.pinned ?? false,
        dataClass: memory.dataClass ?? "standard",
        content: plan.texts[0]!,
        source: memory.source?.trim() || IMPORT_SOURCE,
        sourceRefs: sourceRefsOf(memory, relation === "enriches" ? [{ kind: "pa_memory", id: related!.id }] : []),
        dueAt: memory.dueAt ?? null,
        validFrom: memory.validFrom ?? null,
        validUntil: memory.validUntil ?? null,
        // The last text change lands on the legacy revision, so answers that read it stay current.
        revision: Math.max(1, memory.revision - (plan.texts.length - 1)),
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
        skipConflictCheck: true,
        // Two legacy memories with the same words are two records.
        allowSameText: true,
        ...(opposes ? { conflictsWith: related!.id } : {}),
        actor: "system",
      });
      report.memories += 1;
      if (opposes) openedNow = result.conflicts.find((conflict) => conflict.existing.id === related!.id)?.id ?? null;
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      skip(report, { id: memory.id, reason: "error", message: error.message.slice(0, MESSAGE_MAX_CHARS) });
      return null;
    }
  }
  // A placeholder for the current text waits until the memory is put away (settleMemory).
  appendVersions(engine, memory.id, plan, plan.standIn ? plan.texts.length - 1 : plan.texts.length, report);
  if (opposes) settleRelation(engine, memory.id, related!.id, relation, byId, openedNow, report);
  return plan;
}

/**
 * Appends the planned versions the row does not hold yet, up to `upTo`. The row decides how far an earlier run got:
 * its version count, as long as its current text is the planned one there. A row edited since is left as it is.
 */
function appendVersions(
  engine: MemoryEngineApi,
  id: string,
  plan: LegacyPlan,
  upTo: number,
  report: LegacyImportReport,
): boolean {
  const row = engine.getRow(id);
  if (!row || row.redacted) return false;
  const have = row.versionCount;
  if (have >= upTo || row.content !== plan.texts[have - 1]) return false;
  for (let index = have; index < upTo; index += 1) {
    const standIn = plan.standIn !== null && index === plan.texts.length - 1;
    const notes = [standIn ? STAND_IN_NOTE[plan.standIn!] : IMPORT_NOTE];
    // The first version cannot carry a note, so the count of refused versions goes on the second.
    if (index === 1 && plan.refused) notes.push(`${plan.refused} 个版本未通过写入安全检查，没有导入`);
    try {
      // Legacy versions are edits the owner made; only the owner may change a memory's text.
      engine.revise(id, { content: plan.texts[index]!, actor: "owner", note: notes.join("；") });
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      listSkip(report, { id, reason: "error", message: error.message.slice(0, MESSAGE_MAX_CHARS) });
      return index > have;
    }
    if (!standIn) report.versions += 1;
  }
  return true;
}

/** `supersedes` toward a memory the legacy store marked superseded: the owner already chose the newer one. */
function settleRelation(
  engine: MemoryEngineApi,
  id: string,
  relatedId: string,
  relation: "supersedes" | "challenges",
  byId: ReadonlyMap<string, LegacyPaMemory>,
  openedNow: string | null,
  report: LegacyImportReport,
): void {
  const decided = relation === "supersedes" && byId.get(relatedId)?.status === "superseded";
  if (decided) {
    const conflictId =
      openedNow ??
      engine
        .history(id)
        .conflicts.find((c) => c.status === "open" && c.incoming.id === id && c.existing.id === relatedId)?.id;
    if (!conflictId) return;
    try {
      engine.resolveConflict(conflictId, { resolution: "keep_new", actor: "owner" });
      return;
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
    }
  }
  if (openedNow) report.conflictsOpened += 1;
}

/**
 * Puts a memory away when the legacy store had it put away or its current text is a placeholder, then writes the
 * placeholder and clears a record with no text. Decided from the row: an active row whose status someone already
 * changed keeps it, and only a row that holds nothing but the placeholder is cleared.
 */
function settleMemory(engine: MemoryEngineApi, memory: LegacyPaMemory, plan: LegacyPlan, report: LegacyImportReport): void {
  const row = engine.getRow(memory.id);
  if (!row) return;
  // A superseded memory whose successor is gone has nothing to be superseded by; it is put away instead.
  const away = memory.status === "archived" || memory.status === "superseded" || plan.standIn !== null;
  if (away && row.status === "active" && !engine.history(memory.id).events.some((e) => STATUS_EVENTS.has(e.type))) {
    engine.archive(memory.id, "owner");
  }
  if (plan.standIn && engine.getRow(memory.id)!.status !== "active") {
    if (appendVersions(engine, memory.id, plan, plan.texts.length, report)) report.putAway += 1;
  }
  if (plan.empty) {
    const current = engine.getRow(memory.id)!;
    if (!current.redacted && current.versionCount === 1 && current.content === plan.texts[0]) {
      engine.redact(memory.id, "owner");
      report.redacted += 1;
    }
  }
}

function importEpisode(engine: MemoryEngineApi, episode: PaEpisode, report: LegacyImportReport): void {
  // A record of a task that belonged to a project and to no bot or group is the project's.
  const scope: MemoryScopeRef | null = episode.groupId
    ? { kind: "group", id: episode.groupId }
    : episode.agentId
      ? { kind: "bot", id: episode.agentId }
      : episode.projectId
        ? { kind: "project", id: episode.projectId }
        : null;
  if (!scope) return skip(report, { id: episode.id, reason: "no_scope" });
  const content = episode.summary?.trim();
  if (!content) return skip(report, { id: episode.id, reason: "no_text" });
  const id = `pa-episode-${episode.id}`;
  if (engine.getRow(id)) return;
  try {
    engine.remember({
      id,
      scope,
      principalId: episode.principalId ?? "owner",
      kind: "episode",
      origin: "tool_verified",
      dataClass: episode.dataClass ?? "standard",
      content,
      source: "任务记录",
      sourceRefs: [{ kind: "task", id: episode.taskId, conversationId: episode.conversationId }],
      eventAt: episode.eventEndAt,
      createdAt: episode.createdAt,
      updatedAt: episode.updatedAt,
      skipConflictCheck: true,
      allowSameText: true,
      actor: "system",
    });
    report.episodes += 1;
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error;
    skip(
      report,
      error.code === "MEMORY_SECRET_BLOCKED"
        ? { id: episode.id, reason: "refused", count: 1 }
        : { id: episode.id, reason: "error", message: error.message.slice(0, MESSAGE_MAX_CHARS) },
    );
  }
}

/** A legacy record that was not imported. */
function skip(report: LegacyImportReport, entry: LegacyImportSkip): void {
  report.skipped += 1;
  listSkip(report, entry);
}

/** The report lives in the import marker, so the list is bounded. */
function listSkip(report: LegacyImportReport, entry: LegacyImportSkip): void {
  if (report.skips.length < MAX_REPORTED_SKIPS) report.skips.push(entry);
  else report.skipsOmitted += 1;
}

function rowScope(row: Pick<MemoryItemRow, "scopeKind" | "scopeId">): MemoryScopeRef {
  return { kind: row.scopeKind, id: row.scopeId };
}

// ---- raw conversation windows ----------------------------------------------------------------------------------------

export interface PaReaderDeps {
  conversation(id: string): PaConversation | null;
  messages(conversationId: string): PaMessage[];
  /** Whether a message may be quoted back as raw conversation text. */
  include(message: PaMessage): boolean;
  /** Display name of an agent, null when it no longer exists. */
  agentName(id: string): string | null;
}

export function createPaConversationReader(deps: PaReaderDeps): PaConversationReader {
  return {
    conversation(id) {
      const conversation = deps.conversation(id);
      if (!conversation) return null;
      return {
        id: conversation.id,
        title: conversation.title,
        agentId: conversation.agentId,
        groupId: conversation.groupId,
        channel: Boolean(conversation.channelId),
        principalId: conversation.principalId ?? "owner",
      };
    },
    messages(conversationId) {
      const out: IngestMessage[] = [];
      for (const message of deps.messages(conversationId)) {
        const text = message.content.trim();
        if (!text || !deps.include(message)) continue;
        const owner = message.senderId === "owner";
        out.push({
          id: message.id,
          speaker: owner
            ? STORY_KINDS.has(message.soul?.kind ?? "") ? "旁白" : "用户"
            : (deps.agentName(message.senderId) ?? "助手"),
          agentId: owner ? null : message.senderId,
          text,
          at: message.createdAt,
          dataClass: message.dataClass ?? "standard",
        });
      }
      return out;
    },
  };
}

// ---- text builders ---------------------------------------------------------------------------------------------------

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** What one bot keeps from a finished group task: the discussion, its own part, the outcome. */
export function groupBotEpisodeText(input: {
  groupName: string;
  goal: string;
  contribution: string;
  outcome: string;
}): string {
  const contribution = oneLine(input.contribution, 300);
  const outcome = oneLine(input.outcome, 400);
  return [
    `在群聊「${oneLine(input.groupName, 80)}」讨论：${oneLine(input.goal, 240)}`,
    `我的发言：${contribution || "（没有留下文字）"}`,
    ...(outcome && outcome !== contribution ? [`结果：${outcome}`] : []),
  ].join("；");
}

/** What the group keeps from a finished task. */
export function groupEpisodeText(input: {
  groupName: string;
  goal: string;
  participants: readonly string[];
  outcome: string;
}): string {
  return [
    `群聊「${oneLine(input.groupName, 80)}」完成任务：${oneLine(input.goal, 240)}`,
    ...(input.participants.length ? [`参与：${input.participants.join("、")}`] : []),
    `结果：${oneLine(input.outcome, 400) || "已完成"}`,
  ].join("；");
}

/** What a bot keeps from a finished one-to-one task. */
export function directEpisodeText(input: { goal: string; outcome: string }): string {
  return `完成任务：${oneLine(input.goal, 240)}；结果：${oneLine(input.outcome, 400) || "已完成"}`;
}

/** "Speaker: text" lines, as the distiller reads a transcript. */
export function taskTranscript(lines: ReadonlyArray<{ speaker: string; text: string }>): string {
  return lines
    .map((line) => ({ speaker: line.speaker, text: line.text.trim() }))
    .filter((line) => line.text)
    .map((line) => `${line.speaker}: ${line.text}`)
    .join("\n");
}

// ---- model -----------------------------------------------------------------------------------------------------------

/**
 * A bot's own model as the engine's text model. `local_only` text goes only to a local model (I6), and recognizable
 * credentials are removed before anything leaves.
 */
export function paMemoryLlm(runtime: PaModelRuntime, model: PaModel): MemoryLlm {
  return {
    async complete(input) {
      if (!paRouteAllows(input.dataClass, model.runtime)) return null;
      const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      const prompt = redactPaCredentials(`${input.system}\n\n${input.user}`);
      const result = await runtime.execute(
        model,
        prompt,
        randomUUID(),
        signal,
        input.dataClass ? { dataClass: input.dataClass } : undefined,
      );
      return result.text;
    },
  };
}
