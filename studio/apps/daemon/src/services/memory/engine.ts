// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — the engine facade. Composes the ledger (store), the index, vectors, retrieval,
// configuration, providers and the distiller; everything outside this folder goes through it.
//
// Writes are synchronous: the SQLite part of each one runs in a single transaction. Model work (embedding,
// conflict judging, vector candidates) runs afterwards on a small in-process queue; its errors are kept for
// `status()` and never reach a caller.

import {
  MEMORY_CONFLICT_RESOLUTIONS,
  MEMORY_ITEM_KINDS,
  MEMORY_SCOPE_KINDS,
  memoryScopeKey,
  parseMemoryScopeKey,
  type MemoryChunk,
  type MemoryConflict,
  type MemoryConflictKind,
  type MemoryConflictResolution,
  type MemoryEngineConfig,
  type MemoryEngineStatus,
  type MemoryEventType,
  type MemoryItem,
  type MemoryItemKind,
  type MemoryItemStatus,
  type MemoryMergeDraftResponse,
  type MemoryScopeCounts,
  type MemoryScopeRef,
  type MemoryTidyResponse,
  type PaDataClass,
  type PaMemorySourceRef,
  type UpdateMemoryEngineConfigRequest,
} from "@open-design/contracts";
import { assertSafeMemoryWrite } from "../pa/memory-security.js";
import { MemoryConfig } from "./config.js";
import { comparePair, type PairVerdict } from "./conflict-heuristics.js";
import { MemoryDistiller } from "./distill.js";
import { createLocalModels } from "./local-models.js";
import { chunkScopeKeys, remoteAllowed, type ChunkScopeInput } from "./policy.js";
import { MemoryRetriever } from "./retrieval.js";
import { MemoryIndex } from "./search-index.js";
import { MemoryStore, chunkIdOf, conflictPairKey } from "./store.js";
import { contentHash } from "./text.js";
import {
  MemoryError,
  type ChunkSink,
  type DocFilter,
  type EngineDistillInput,
  type EngineListQuery,
  type IndexedDoc,
  type JudgeVerdict,
  type MemoryActor,
  type MemoryChunkRow,
  type MemoryConflictRow,
  type MemoryEngineApi,
  type MemoryEngineDeps,
  type MemoryItemRow,
  type MemoryJudge,
  type MemoryLlm,
  type MemoryLocalRuntime,
  type MemoryProviders,
  type NewItemRow,
  type RecallRequest,
  type RecallResult,
  type RememberInput,
  type RememberResult,
  type ReviseInput,
  type WriteWindowsInput,
} from "./types.js";
import { MemoryEmbedder, MemoryVectors } from "./vectors.js";

/** Lexical (and vector) candidates compared with a newly written item. */
const CANDIDATES = 8;
/** Without a judge the rules alone open a conflict from this confidence on. */
const RULES_OPEN_AT = 0.6;
/** A judge verdict counts (to open or to cancel) from this confidence on. */
const JUDGE_DECIDES_AT = 0.7;
/** Pairs the rules left unrelated still go to the judge when they are this similar. */
const JUDGE_MIN_JACCARD = 0.45;
const JUDGE_MIN_COSINE = 0.8;
const BACKGROUND_CONCURRENCY = 2;
const TIDY_YIELD_EVERY = 50;
const KNOWN_PER_TARGET = 40;
const MAX_SOURCE_REFS = 32;
const ERROR_MAX_CHARS = 300;
const LAST_INDEXED_KEY = "last_indexed_at";

const NO_PROVIDERS: MemoryProviders = { embedding: null, reranker: null, judge: null };

/** Plain name of a scope kind, used when the labeler knows no better name. */
const SCOPE_WORDS: Record<MemoryScopeRef["kind"], string> = {
  profile: "个人画像",
  persona: "人设",
  bot: "角色",
  group: "群组",
  project: "项目",
  conversation: "对话",
};

type ProviderSlot = "embedding" | "reranker" | "judge";
type BackgroundTask = (signal: AbortSignal) => Promise<void>;

/** What one write did, and what is left to do once its transaction has committed. */
interface WriteOutcome {
  row: MemoryItemRow;
  created: boolean;
  opened: MemoryConflictRow[];
  /** Index documents whose text must be (re)embedded. */
  embed: number[];
  later: BackgroundTask[];
}

/** A validated item ready to be inserted. */
type Draft = NewItemRow & {
  scope: MemoryScopeRef;
  content: string;
  principalId: string;
  status: MemoryItemStatus;
};

interface WriteOptions {
  actor: MemoryActor;
  eventType?: MemoryEventType | undefined;
  /** Stored on the creation event. */
  data?: Record<string, unknown> | undefined;
  conflictsWith?: string | undefined;
  skipConflictCheck?: boolean | undefined;
  allowSameText?: boolean | undefined;
}

interface PairOpening {
  kind: MemoryConflictKind;
  detector: MemoryConflict["detector"];
  confidence: number;
  reason: string;
}

/** How a candidate pair is decided: by the rules now, or by the judge in the background. */
interface PairPlan {
  incoming: MemoryItemRow;
  existing: MemoryItemRow;
  rule: PairVerdict;
  marked: boolean;
  via: "rules" | "judge";
}

// ---- small helpers -----------------------------------------------------------------------------------------------

function invalid(message: string, status = 400): MemoryError {
  return new MemoryError("MEMORY_INVALID", message, status);
}

function notFound(what: string, id: string): MemoryError {
  return new MemoryError("MEMORY_NOT_FOUND", `${what} ${id} was not found.`, 404);
}

function requireOwner(actor: MemoryActor, action: string): void {
  if (actor !== "owner") throw new MemoryError("MEMORY_FORBIDDEN", `Only the owner can ${action}.`, 403);
}

function checkRevision(row: MemoryItemRow, revision: number | undefined): void {
  if (revision !== undefined && revision !== row.revision) {
    throw new MemoryError(
      "MEMORY_REVISION_CONFLICT",
      `Memory ${row.id} changed: it is at revision ${row.revision}, not ${revision}.`,
      409,
    );
  }
}

function validScope(scope: MemoryScopeRef | undefined): MemoryScopeRef {
  if (!scope || !(MEMORY_SCOPE_KINDS as readonly string[]).includes(scope.kind)) throw invalid("Unknown memory scope.");
  if (scope.kind === "profile") return { kind: "profile", id: "" };
  if (typeof scope.id !== "string" || !scope.id.trim()) throw invalid(`A ${scope.kind} memory needs a scope id.`);
  return { kind: scope.kind, id: scope.id };
}

function validKind(kind: MemoryItemKind | undefined): void {
  if (kind !== undefined && !(MEMORY_ITEM_KINDS as readonly string[]).includes(kind)) {
    throw invalid(`Unknown memory kind: ${String(kind)}.`);
  }
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw invalid(`${field} must not be empty.`);
  return text;
}

/** The secret / prompt-injection gate every stored text passes (I8). */
function gate(...texts: Array<string | undefined>): void {
  for (const text of texts) {
    if (!text) continue;
    try {
      assertSafeMemoryWrite(text);
    } catch (error) {
      throw new MemoryError("MEMORY_SECRET_BLOCKED", error instanceof Error ? error.message : String(error), 400);
    }
  }
}

function scopeOf(row: { scopeKind: MemoryScopeRef["kind"]; scopeId: string }): MemoryScopeRef {
  return { kind: row.scopeKind, id: row.scopeId };
}

function sameScope(a: MemoryItemRow, b: MemoryScopeRef | MemoryItemRow): boolean {
  const other = "scopeKind" in b ? scopeOf(b) : b;
  return a.scopeKind === other.kind && a.scopeId === (other.kind === "profile" ? "" : other.id);
}

function itemText(row: MemoryItemRow): string {
  return row.title ? `${row.title}\n${row.content}` : row.content;
}

/** The newer of the two (by last change) is the incoming side of a pair. */
function newerFirst(a: MemoryItemRow, b: MemoryItemRow): [MemoryItemRow, MemoryItemRow] {
  return a.updatedAt >= b.updatedAt ? [a, b] : [b, a];
}

function isCandidate(row: MemoryItemRow, other: MemoryItemRow): boolean {
  return (
    other.id !== row.id &&
    other.status === "active" &&
    !other.redacted &&
    other.principalId === row.principalId &&
    sameScope(row, other)
  );
}

/** A hint for the person deciding; never applied automatically. */
function suggestResolution(
  kind: MemoryConflictKind,
  incoming: MemoryItemRow,
  existing: MemoryItemRow,
): MemoryConflictResolution | null {
  if (kind === "duplicate") return "merge";
  if (incoming.origin === "user_explicit" && incoming.updatedAt >= existing.updatedAt) return "keep_new";
  if (existing.origin === "user_explicit" && incoming.origin === "llm_inferred") return "keep_old";
  return null;
}

function inLanguageOf(texts: readonly string[], zh: string, en: string): string {
  return texts.some((text) => /\p{Script=Han}/u.test(text)) ? zh : en;
}

function mostPrivate(a: PaDataClass, b: PaDataClass): PaDataClass {
  return a === "local_only" || b === "local_only" ? "local_only" : "standard";
}

function uniqueRefs(refs: readonly PaMemorySourceRef[]): PaMemorySourceRef[] {
  const seen = new Set<string>();
  return refs
    .filter((ref) => {
      const key = `${ref.kind}\u0000${ref.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_SOURCE_REFS);
}

/** Attaches the distiller's supporting quote to the first source reference. */
function withQuote(refs: readonly PaMemorySourceRef[] | undefined, quote: string): PaMemorySourceRef[] {
  const [first, ...rest] = refs ?? [];
  return first ? [{ ...first, quote: quote.slice(0, 2_000) }, ...rest] : [];
}

/** Routes `local_only` text only to a model call that says so, so the daemon's model can refuse it (I6). */
function withDataClass(llm: MemoryLlm, dataClass: PaDataClass): MemoryLlm {
  return { complete: (input) => llm.complete({ ...input, dataClass }) };
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, ERROR_MAX_CHARS) || "Unknown error";
}

function defaultOrigin(actor: MemoryActor): MemoryItemRow["origin"] {
  return actor === "owner" ? "user_explicit" : "llm_inferred";
}

function defaultAuthor(actor: MemoryActor): string | null {
  if (actor === "owner") return "owner";
  return actor.startsWith("agent:") ? actor.slice("agent:".length) || null : null;
}

/** Documents re-indexed between two pauses; about a tenth of a second of work. */
const REINDEX_BATCH = 200;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function emptyOutcome(row: MemoryItemRow, created: boolean): WriteOutcome {
  return { row, created, opened: [], embed: [], later: [] };
}

/** A tiny work queue: at most `concurrency` tasks at once. */
class BackgroundQueue {
  private readonly waiting: BackgroundTask[] = [];
  private readonly controller = new AbortController();
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly concurrency: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  push(task: BackgroundTask): void {
    if (this.controller.signal.aborted) return;
    this.waiting.push(task);
    this.pump();
  }

  idle(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  stop(): void {
    this.controller.abort();
    this.waiting.length = 0;
    this.settle();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const task = this.waiting.shift()!;
      this.running += 1;
      const signal = this.controller.signal;
      void Promise.resolve()
        .then(() => task(signal))
        .catch((error: unknown) => {
          if (!signal.aborted) this.onError(error);
        })
        .finally(() => {
          this.running -= 1;
          this.pump();
          this.settle();
        });
    }
  }

  private settle(): void {
    if (this.running > 0 || this.waiting.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

// ---- engine ------------------------------------------------------------------------------------------------------

class MemoryEngine implements MemoryEngineApi {
  readonly chunkSink: ChunkSink;

  private readonly now: () => number;
  private readonly store: MemoryStore;
  private readonly index: MemoryIndex;
  private readonly vectors: MemoryVectors;
  private readonly settings: MemoryConfig;
  private readonly distiller: MemoryDistiller;
  private readonly embedder: MemoryEmbedder;
  private readonly retriever: MemoryRetriever;
  private readonly queue: BackgroundQueue;
  private readonly overrides: Partial<MemoryProviders>;
  private readonly local: MemoryLocalRuntime | null;
  private llm: MemoryLlm | null;
  private labeler: (scope: MemoryScopeRef) => string | undefined;
  private merged: { base: MemoryProviders; providers: MemoryProviders } | null = null;
  private readonly errors: Record<ProviderSlot, string | null> = { embedding: null, reranker: null, judge: null };
  /** Pairs a judge already answered in this process (or is answering). */
  private readonly judgedPairs = new Set<string>();
  private conflictsOpened = 0;
  private itemsDistilled = 0;
  private lastIndexedAt: number | null;
  private disposed = false;

  constructor(deps: MemoryEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.llm = deps.llm ?? null;
    this.labeler = deps.labelOf ?? (() => undefined);
    this.overrides = deps.providers ?? {};
    this.store = new MemoryStore(deps.db, this.now);
    this.index = new MemoryIndex(deps.db);
    this.vectors = new MemoryVectors(deps.db, this.now);
    this.settings = new MemoryConfig({
      getMeta: (key) => this.store.getMeta(key),
      setMeta: (key, value) => this.store.setMeta(key, value),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    this.distiller = new MemoryDistiller(this.now);
    this.local =
      deps.local !== undefined
        ? deps.local
        : createLocalModels({
            dataDir: deps.dataDir,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            onChange: () => this.localModelsChanged(),
          });
    // Queued work is conflict judging; its tasks report provider failures themselves, anything else lands here.
    this.queue = new BackgroundQueue(BACKGROUND_CONCURRENCY, (error) => this.recordError("judge", error));
    this.embedder = new MemoryEmbedder({
      index: this.index,
      vectors: this.vectors,
      textOf: (doc) => this.documentText(doc),
      provider: () => this.providers().embedding,
      onError: (error) => this.recordError("embedding", error),
      onOk: () => this.clearError("embedding"),
    });
    this.retriever = new MemoryRetriever({
      store: this.store,
      index: this.index,
      vectors: this.vectors,
      config: () => this.settings.get(),
      providers: () => this.providers(),
      labelOf: (scope) => this.labelOf(scope),
      toItem: (row) => this.toItem(row),
      toChunk: (row) => this.toChunk(row),
      now: this.now,
      onProviderError: (which, error) => this.recordError(which, error),
      onProviderOk: (which) => this.clearError(which),
    });
    this.chunkSink = {
      cursor: (source, conversationId) => this.store.cursor(source, conversationId),
      writeWindows: (input) => this.writeWindows(input),
    };
    const stamp = Number(this.store.getMeta(LAST_INDEXED_KEY));
    this.lastIndexedAt = Number.isFinite(stamp) && stamp > 0 ? stamp : null;
    this.embedder.requeueStale();
  }

  // ---- write -----------------------------------------------------------------------------------------------------

  remember(input: RememberInput): RememberResult {
    const draft = this.draftOf(input);
    const outcome = this.store.transaction(() =>
      this.writeNew(draft, {
        actor: input.actor,
        eventType: draft.origin === "imported" ? "imported" : "created",
        conflictsWith: input.conflictsWith,
        skipConflictCheck: input.skipConflictCheck,
        allowSameText: input.allowSameText,
      }),
    );
    return this.finish(outcome);
  }

  revise(id: string, input: ReviseInput): { item: MemoryItem; conflicts: MemoryConflict[] } {
    const row = this.requireRow(id);
    checkRevision(row, input.revision);
    const content = input.content === undefined ? undefined : requiredText(input.content, "content");
    const title = input.title?.trim();
    const textChanged =
      (content !== undefined && content !== row.content) || (title !== undefined && title !== row.title);
    if (textChanged || input.kind !== undefined || input.pinned !== undefined || input.dueAt !== undefined) {
      requireOwner(input.actor, "edit a memory");
    }
    if (textChanged && row.redacted) throw invalid("A redacted memory cannot be edited.");
    validKind(input.kind);
    if (textChanged) gate(content, title);
    const outcome = this.store.transaction(() => {
      let current = row;
      if (textChanged) {
        current = this.store.appendVersion(id, {
          content: content ?? row.content,
          title,
          actor: input.actor,
          note: input.note,
        });
      }
      if (
        input.kind !== undefined ||
        input.dueAt !== undefined ||
        input.validFrom !== undefined ||
        input.validUntil !== undefined
      ) {
        current = this.store.patchMeta(
          id,
          { kind: input.kind, dueAt: input.dueAt, validFrom: input.validFrom, validUntil: input.validUntil },
          input.actor,
          textChanged ? undefined : input.note,
        );
      }
      if (input.pinned !== undefined) current = this.store.setPinned(id, input.pinned, input.actor);
      const out = emptyOutcome(current, false);
      if (current.revision === row.revision) return out;
      const docId = this.indexItem(current);
      if (textChanged) {
        out.embed.push(docId);
        if (current.status === "active") this.detect(current, docId, out, { vectors: true });
      }
      return out;
    });
    const result = this.finish(outcome);
    return { item: result.item, conflicts: result.conflicts };
  }

  archive(id: string, actor: MemoryActor, revision?: number): MemoryItem {
    requireOwner(actor, "archive a memory");
    return this.changeStatus(id, actor, revision, (row) => {
      if (row.status === "archived") return null;
      if (row.status !== "active") throw invalid(`Only an active memory can be archived; this one is ${row.status}.`, 409);
      return { status: "archived", event: "archived" };
    });
  }

  restore(id: string, actor: MemoryActor, revision?: number): MemoryItem {
    requireOwner(actor, "restore a memory");
    return this.changeStatus(id, actor, revision, (row) => {
      if (row.status === "active") return null;
      if (row.status === "pending") throw invalid("A proposal is accepted, not restored.", 409);
      return row.status === "archived"
        ? { status: "active", event: "restored" }
        : { status: "active", event: "reinstated", supersededBy: null };
    });
  }

  redact(id: string, actor: MemoryActor): MemoryItem {
    requireOwner(actor, "redact a memory");
    const row = this.requireRow(id);
    if (row.redacted) return this.toItem(row);
    const redacted = this.store.transaction(() => {
      const updated = this.store.redact(id, actor);
      this.vectors.forget(this.indexItem(updated));
      return updated;
    });
    return this.toItem(redacted);
  }

  accept(
    id: string,
    actor: MemoryActor,
    patch: { content?: string | undefined; kind?: MemoryItemKind | undefined; scope?: MemoryScopeRef | undefined } = {},
    revision?: number,
  ): RememberResult {
    requireOwner(actor, "accept a proposal");
    const row = this.requireRow(id);
    checkRevision(row, revision);
    if (row.status !== "pending") throw invalid(`Only a proposal can be accepted; this memory is ${row.status}.`, 409);
    const content = patch.content === undefined ? row.content : requiredText(patch.content, "content");
    validKind(patch.kind);
    const target = patch.scope ? validScope(patch.scope) : scopeOf(row);
    if (content !== row.content) gate(content);
    const outcome = this.store.transaction(() =>
      sameScope(row, target)
        ? this.acceptInPlace(row, content, patch.kind, actor)
        : this.acceptElsewhere(row, target, content, patch.kind, actor),
    );
    return this.finish(outcome);
  }

  reject(id: string, actor: MemoryActor, revision?: number): MemoryItem {
    requireOwner(actor, "reject a proposal");
    return this.changeStatus(id, actor, revision, (row) => {
      if (row.status === "rejected") return null;
      if (row.status !== "pending") throw invalid(`Only a proposal can be rejected; this memory is ${row.status}.`, 409);
      return { status: "rejected", event: "rejected" };
    });
  }

  copy(id: string, scope: MemoryScopeRef, actor: MemoryActor, title?: string): RememberResult {
    const source = this.requireRow(id);
    if (source.redacted) throw invalid("A redacted memory cannot be copied.");
    const target = validScope(scope);
    const copyTitle = title?.trim() || source.title;
    gate(source.content, copyTitle);
    const label = this.labelOf(scopeOf(source)) ?? SCOPE_WORDS[source.scopeKind];
    const draft: Draft = {
      ...this.carriedFields(source),
      scope: target,
      status: "active",
      pinned: false,
      title: copyTitle,
      source: `复制自 ${label}`,
    };
    const outcome = this.store.transaction(() => {
      const result = this.writeNew(draft, { actor, eventType: "copied", data: { from: source.id } });
      if (result.created) this.store.addLink(result.row.id, source.id, "derived_from");
      return result;
    });
    return this.finish(outcome);
  }

  resolveConflict(
    id: string,
    input: {
      resolution: MemoryConflictResolution;
      mergedContent?: string | undefined;
      mergedTitle?: string | undefined;
      actor: MemoryActor;
    },
  ): { conflict: MemoryConflict; items: MemoryItem[] } {
    requireOwner(input.actor, "resolve a conflict");
    const conflict = this.store.getConflict(id);
    if (!conflict) throw notFound("Conflict", id);
    if (conflict.status === "resolved") {
      throw new MemoryError("MEMORY_CONFLICT_RESOLVED", "This conflict was already resolved.", 409);
    }
    if (!(MEMORY_CONFLICT_RESOLUTIONS as readonly string[]).includes(input.resolution)) {
      throw invalid(`Unknown resolution: ${String(input.resolution)}.`);
    }
    const incoming = this.requireRow(conflict.incomingId);
    const existing = this.requireRow(conflict.existingId);
    const merge =
      input.resolution === "merge"
        ? { content: requiredText(input.mergedContent, "mergedContent"), title: input.mergedTitle?.trim() }
        : null;
    if (merge) gate(merge.content, merge.title);

    const done = this.store.transaction(() => {
      const actor = input.actor;
      const why = { conflictId: conflict.id };
      let merged: MemoryItemRow | null = null;
      // A resolution decides between memories that are in use. It never brings back one the person already put
      // away (archived, replaced or declined elsewhere): that side keeps its state, and it cannot be the one kept.
      const inUse = (row: MemoryItemRow): boolean => row.status === "active" || row.status === "pending";
      switch (input.resolution) {
        case "keep_new":
          this.keepSide(incoming, "new", actor, why);
          if (inUse(existing)) {
            this.store.setStatus(existing.id, "superseded", {
              actor,
              event: "superseded",
              supersededBy: incoming.id,
              data: why,
            });
            this.store.addLink(incoming.id, existing.id, "supersedes");
          }
          break;
        case "keep_old":
          this.keepSide(existing, "existing", actor, why);
          if (inUse(incoming)) this.store.setStatus(incoming.id, "rejected", { actor, event: "rejected", data: why });
          break;
        case "merge":
          merged = this.insertMerged(incoming, existing, merge!, actor, conflict.id);
          for (const source of [incoming, existing]) {
            if (!inUse(source)) continue;
            this.store.setStatus(source.id, "superseded", {
              actor,
              event: "superseded",
              supersededBy: merged.id,
              data: { ...why, mergedInto: merged.id },
            });
          }
          break;
        case "keep_both":
          for (const side of [incoming, existing]) if (side.status === "pending") this.acceptSide(side, actor, why);
          this.store.addLink(incoming.id, existing.id, "relates");
          break;
      }
      const closed = this.store.closeConflict(conflict.id, {
        resolution: input.resolution,
        mergedItemId: merged?.id ?? null,
        actor,
      });
      const ids = [incoming.id, existing.id, ...(merged ? [merged.id] : [])];
      const out = emptyOutcome(merged ?? incoming, merged !== null);
      for (const row of this.store.getItems([incoming.id, existing.id])) {
        const docId = this.indexItem(row);
        // An accepted proposal is recalled from now on.
        if (row.status === "active") out.embed.push(docId);
      }
      if (merged) {
        const docId = this.indexItem(merged);
        out.embed.push(docId);
        this.detect(merged, docId, out, { vectors: true });
      }
      return { closed, ids, out };
    });
    this.dispatch(done.out);
    return {
      conflict: this.toConflicts([done.closed])[0]!,
      items: this.toItems(this.store.getItems(done.ids)),
    };
  }

  // ---- read ------------------------------------------------------------------------------------------------------

  getItem(id: string): MemoryItem | null {
    const row = this.store.getItem(id);
    return row ? this.toItem(row) : null;
  }

  getRow(id: string): MemoryItemRow | null {
    return this.store.getItem(id);
  }

  listItems(query: EngineListQuery): { items: MemoryItem[]; total: number } {
    const { rows, total } = this.store.listItems({ ...query, statuses: query.statuses ?? ["active"] });
    return { items: this.toItems(rows), total };
  }

  history(id: string): ReturnType<MemoryEngineApi["history"]> {
    const row = this.requireRow(id);
    const links = this.store.links(id);
    const relatedIds = new Set(links.map((link) => (link.fromId === id ? link.toId : link.fromId)));
    if (row.supersededBy) relatedIds.add(row.supersededBy);
    relatedIds.delete(id);
    return {
      item: this.toItem(row),
      versions: this.store.versions(id),
      events: this.store.events(id),
      links,
      related: this.toItems(this.store.getItems([...relatedIds])),
      conflicts: this.toConflicts(this.store.listConflicts({ itemId: id })),
    };
  }

  listConflicts(
    filter: {
      status?: "open" | "resolved" | undefined;
      scope?: MemoryScopeRef | undefined;
      principalId?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): MemoryConflict[] {
    const byPrincipal = filter.principalId !== undefined;
    let rows = this.store.listConflicts({
      status: filter.status,
      scopeKeys: filter.scope ? [memoryScopeKey(validScope(filter.scope))] : undefined,
      limit: byPrincipal ? undefined : filter.limit,
    });
    if (byPrincipal) {
      const owners = new Map(this.store.getItems(rows.map((row) => row.incomingId)).map((r) => [r.id, r.principalId]));
      rows = rows.filter((row) => owners.get(row.incomingId) === filter.principalId);
      if (filter.limit !== undefined) rows = rows.slice(0, filter.limit);
    }
    return this.toConflicts(rows);
  }

  getConflict(id: string): MemoryConflict | null {
    const row = this.store.getConflict(id);
    return row ? (this.toConflicts([row])[0] ?? null) : null;
  }

  async mergeDraft(conflictId: string, llm?: MemoryLlm | null): Promise<MemoryMergeDraftResponse> {
    const conflict = this.store.getConflict(conflictId);
    if (!conflict) throw notFound("Conflict", conflictId);
    const existing = this.requireRow(conflict.existingId);
    const incoming = this.requireRow(conflict.incomingId);
    const model = llm === undefined ? this.llm : llm;
    const local = !remoteAllowed(existing.dataClass) || !remoteAllowed(incoming.dataClass);
    return this.distiller.mergeDraft(
      existing.content,
      incoming.content,
      model && local ? withDataClass(model, "local_only") : model,
    );
  }

  scopeCounts(principalId?: string): Map<string, MemoryScopeCounts> {
    const counts = this.store.scopeCounts(principalId);
    for (const [key, chunks] of this.index.chunkCounts()) {
      const entry = counts.get(key) ?? { active: 0, pending: 0, conflicts: 0, archived: 0, chunks: 0 };
      entry.chunks = chunks;
      counts.set(key, entry);
    }
    return counts;
  }

  // ---- recall ----------------------------------------------------------------------------------------------------

  recall(request: RecallRequest): Promise<RecallResult> {
    return this.retriever.recall(request);
  }

  // ---- raw conversation windows ----------------------------------------------------------------------------------

  listChunks(query: {
    scope?: MemoryScopeRef | undefined;
    conversationId?: string | undefined;
    principalId?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }): { chunks: MemoryChunk[]; total: number } {
    const principalId = query.principalId ?? "owner";
    let conversationId = query.conversationId;
    let ids: string[] | undefined;
    if (query.scope) {
      const scope = validScope(query.scope);
      if (scope.kind === "conversation") {
        if (conversationId !== undefined && conversationId !== scope.id) return { chunks: [], total: 0 };
        conversationId = scope.id;
      } else {
        const docIds = this.index.allowedDocIds({
          scopeKeys: [memoryScopeKey(scope)],
          docKind: "chunk",
          dataClass: "local_only",
          principalId,
          includeHidden: true,
        });
        ids = this.index.docs(docIds).map((doc) => doc.refId);
      }
    }
    const { rows, total } = this.store.listChunks({
      conversationId,
      ids,
      principalId,
      limit: query.limit,
      offset: query.offset,
    });
    return { chunks: rows.map((row) => this.toChunk(row)), total };
  }

  getChunk(id: string): { chunk: MemoryChunk; neighbors: MemoryChunk[] } | null {
    const row = this.store.getChunk(id);
    if (!row) return null;
    return { chunk: this.toChunk(row), neighbors: this.store.neighbors(row, 1).map((n) => this.toChunk(n)) };
  }

  // ---- learning from conversations -------------------------------------------------------------------------------

  async distill(input: EngineDistillInput): Promise<RememberResult[]> {
    const mode = input.mode ?? this.settings.get().autoMemory;
    if (mode === "off" || input.targets.length === 0) return [];
    const llm = input.llm !== undefined ? input.llm : this.llm;
    if (!llm) return [];
    const principalId = input.principalId ?? "owner";
    const memories = await this.distiller.distill(
      {
        transcript: input.transcript,
        targets: input.targets,
        known: this.knownTexts(
          input.knownScopes ?? input.targets.map((target) => target.scope),
          principalId,
          input.dataClass,
        ),
        dataClass: input.dataClass,
        signal: input.signal,
      },
      llm,
    );
    const results: RememberResult[] = [];
    for (const memory of memories) {
      if (input.signal?.aborted || this.disposed) break;
      try {
        const result = this.remember({
          scope: memory.scope,
          kind: memory.kind,
          content: memory.content,
          status: mode === "review" ? "pending" : "active",
          origin: "llm_inferred",
          source: input.source,
          sourceRefs: withQuote(input.sourceRefs, memory.quote),
          via: input.via,
          authorId: input.authorId,
          dataClass: input.dataClass,
          principalId,
          eventAt: memory.eventAt,
          dueAt: memory.dueAt,
          actor: "system",
        });
        if (result.created) this.itemsDistilled += 1;
        results.push(result);
      } catch (error) {
        // A blocked or malformed proposal is dropped; the others are still kept.
        if (!(error instanceof MemoryError)) throw error;
      }
    }
    return results;
  }

  async tidy(scope?: MemoryScopeRef): Promise<MemoryTidyResponse> {
    const started = performance.now();
    const openedBefore = this.conflictsOpened;
    const distilledBefore = this.itemsDistilled;
    const rows = this.store.listItems({
      scope: scope ? validScope(scope) : undefined,
      statuses: ["active"],
      includeLocalOnly: true,
      order: "created_asc",
    }).rows;
    let scanned = 0;
    for (const [index, listed] of rows.entries()) {
      if (this.disposed) break;
      const row = this.store.getItem(listed.id);
      if (row?.status !== "active" || row.redacted) continue;
      scanned += 1;
      const out = this.store.transaction(() => {
        const result = emptyOutcome(row, false);
        // Embedding every item once more just to find vector neighbours would cost one model call per item.
        this.detect(row, this.index.docIdOf("item", row.id) ?? this.indexItem(row), result, { vectors: false });
        return result;
      });
      this.dispatch(out);
      if (index % TIDY_YIELD_EVERY === TIDY_YIELD_EVERY - 1) await yieldToEventLoop();
    }
    await this.queue.idle();
    return {
      ok: true,
      scannedItems: scanned,
      conflictsOpened: this.conflictsOpened - openedBefore,
      itemsProposed: this.itemsDistilled - distilledBefore,
      durationMs: Math.round(performance.now() - started),
    };
  }

  // ---- maintenance -----------------------------------------------------------------------------------------------

  config(): MemoryEngineConfig {
    return this.settings.get();
  }

  updateConfig(patch: UpdateMemoryEngineConfigRequest): MemoryEngineConfig {
    const next = this.settings.update(patch);
    for (const slot of ["embedding", "reranker", "judge"] as const) if (patch[slot]) this.clearError(slot);
    this.embedder.requeueStale();
    return next;
  }

  status(): MemoryEngineStatus {
    const config = this.settings.get();
    const providers = this.providers();
    const embedding = providers.embedding;
    const embeddingReady = embedding !== null && this.errors.embedding === null;
    const rerankerReady = providers.reranker !== null && this.errors.reranker === null;
    const vectorCounts = embedding ? this.vectors.counts(embedding.modelId) : { indexed: 0, waiting: 0 };
    const named = (configured: string, builtin: string, present: boolean): string =>
      configured !== builtin ? configured : present ? "custom" : builtin;
    return {
      level: embeddingReady ? (rerankerReady ? "hybrid_rerank" : "hybrid") : "lexical",
      localRuntime: this.local?.available() ?? false,
      localModels: this.local?.models() ?? [],
      embedding: {
        provider: named(config.embedding.provider, "off", embedding !== null),
        model: config.embedding.model || (embedding?.modelId ?? ""),
        ready: embeddingReady,
        error: this.errors.embedding,
        ...vectorCounts,
      },
      reranker: {
        provider: named(config.reranker.provider, "builtin", providers.reranker !== null),
        model: config.reranker.model || (providers.reranker?.id ?? ""),
        ready: providers.reranker ? rerankerReady : config.reranker.provider === "builtin",
        error: this.errors.reranker,
      },
      judge: {
        provider: named(config.judge.provider, "heuristic", providers.judge !== null),
        model: config.judge.model || (providers.judge?.id ?? ""),
        ready: providers.judge ? this.errors.judge === null : config.judge.provider === "heuristic",
        error: this.errors.judge,
      },
      documents: this.index.count(),
      lastIndexedAt: this.lastIndexedAt,
      recallLatencyMs: this.store.recallLatency(),
    };
  }

  async reindex(options: { vectors?: boolean | undefined } = {}): Promise<{ documents: number; durationMs: number }> {
    const started = performance.now();
    // Every memory and window is written again (text that tokenizes differently now is re-indexed, document ids and
    // their vectors stay), in short batches with a pause between them: a large memory must not freeze the app for
    // the length of the rebuild. Recall keeps working throughout.
    const items = this.store.listItems({ includeLocalOnly: true, order: "created_asc" }).rows;
    const chunks = this.store.listChunks({}).rows;
    let documents = 0;
    const inBatches = async <T>(rows: readonly T[], write: (row: T) => void): Promise<void> => {
      for (let at = 0; at < rows.length && !this.disposed; at += REINDEX_BATCH) {
        const batch = rows.slice(at, at + REINDEX_BATCH);
        this.store.transaction(() => batch.forEach(write));
        documents += batch.length;
        await yieldToEventLoop();
      }
    };
    await inBatches(items, (item) => this.index.upsertItem(item));
    // Chunk scope keys live only in the index, so each window is written back with the keys it has.
    await inBatches(chunks, (chunk) => this.index.upsertChunk(chunk, this.storedChunkKeys(chunk)));
    if (!this.disposed) this.index.removeOrphans();
    this.vectors.reset();
    this.touchIndex();
    // Without `vectors`, vectors whose text is unchanged stay valid (same model, same text). With it, the current
    // model's vectors are dropped and every document is embedded again from a clean provider state.
    if (options.vectors) {
      this.clearError("embedding");
      const embedding = this.providers().embedding;
      if (embedding) this.vectors.clear(embedding.modelId);
    }
    this.embedder.requeueStale();
    return { documents, durationMs: Math.round(performance.now() - started) };
  }

  async localModelAction(id: string, action: "download" | "cancel"): Promise<void> {
    const local = this.local;
    if (!local || !local.models().some((model) => model.id === id)) throw notFound("Local model", id);
    if (action === "cancel") {
      local.cancel(id);
      return;
    }
    if (action !== "download") throw invalid(`Unknown local model action: ${String(action)}.`);
    if (!local.available()) throw invalid("Local models cannot run in this build.", 409);
    try {
      await local.download(id);
    } catch (error) {
      throw invalid(describeError(error), 409);
    }
  }

  setLlm(llm: MemoryLlm | null): void {
    this.llm = llm;
  }

  setLabeler(labelOf: (scope: MemoryScopeRef) => string | undefined): void {
    this.labeler = labelOf;
  }

  async flush(): Promise<void> {
    await this.queue.idle();
    await this.embedder.idle();
    await this.queue.idle();
  }

  dispose(): void {
    this.disposed = true;
    this.queue.stop();
    this.embedder.stop();
    this.local?.dispose();
  }

  // ---- writing internals -----------------------------------------------------------------------------------------

  private draftOf(input: RememberInput): Draft {
    const scope = validScope(input.scope);
    const content = requiredText(input.content, "content");
    const title = input.title?.trim() ?? "";
    const status = input.status ?? "active";
    if (status !== "active" && status !== "pending") throw invalid("A new memory is either active or pending.");
    validKind(input.kind);
    gate(content, title);
    return {
      id: input.id,
      scope,
      principalId: input.principalId ?? "owner",
      kind: input.kind ?? "fact",
      status,
      origin: input.origin ?? defaultOrigin(input.actor),
      pinned: input.pinned ?? false,
      dataClass: input.dataClass ?? "standard",
      title,
      content,
      source: input.source?.trim() || (input.actor === "owner" ? "手动添加" : ""),
      sourceRefs: input.sourceRefs ?? [],
      via: input.via ?? null,
      authorId: input.authorId !== undefined ? input.authorId : defaultAuthor(input.actor),
      eventAt: input.eventAt ?? null,
      dueAt: input.dueAt ?? null,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      revision: input.revision,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
  }

  /** The fields a memory keeps when it is copied or moved into another scope. */
  private carriedFields(row: MemoryItemRow): Omit<Draft, "scope" | "status"> {
    return {
      principalId: row.principalId,
      kind: row.kind,
      origin: row.origin,
      pinned: row.pinned,
      dataClass: row.dataClass,
      title: row.title,
      content: row.content,
      source: row.source,
      sourceRefs: row.sourceRefs,
      via: row.via,
      authorId: row.authorId,
      eventAt: row.eventAt,
      dueAt: row.dueAt,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
    };
  }

  /** Inserts a new item unless the same text is already there; runs conflict detection for active items. */
  private writeNew(draft: Draft, options: WriteOptions): WriteOutcome {
    if (draft.id) {
      const known = this.store.getItem(draft.id);
      if (known) return emptyOutcome(known, false);
    }
    const same = this.store.findByHash(draft.scope, contentHash(draft.content), draft.principalId);
    if (same && !options.allowSameText && this.isRepeat(same, options.actor)) {
      return this.confirmRepeat(same, draft, options);
    }
    if (options.conflictsWith && draft.status === "active") this.requireConflictTarget(draft, options.conflictsWith);
    const data: Record<string, unknown> = { ...options.data };
    if (draft.status === "pending") {
      // Detection waits until a person accepts the proposal; remember what the writer asked for until then.
      if (options.conflictsWith) data.conflictsWith = options.conflictsWith;
      if (options.skipConflictCheck) data.skipConflictCheck = true;
    }
    const row = this.store.insertItem(draft, options.actor, options.eventType ?? "created", data);
    return this.activateWrite(row, true, options);
  }

  /**
   * The same text already exists in the scope. Active and pending items always count; an item a person put
   * away (archived, superseded, rejected) counts unless the owner writes it again.
   */
  private isRepeat(same: MemoryItemRow, actor: MemoryActor): boolean {
    return same.status === "active" || same.status === "pending" || actor !== "owner";
  }

  private confirmRepeat(same: MemoryItemRow, draft: Draft, options: WriteOptions): WriteOutcome {
    if (same.status === "pending" && draft.status === "active" && options.actor === "owner") {
      // The owner wrote what was only proposed: the proposal becomes the memory.
      const accepted = this.store.setStatus(same.id, "active", { actor: options.actor, event: "accepted" });
      return this.activateWrite(accepted, false, options);
    }
    this.store.recordEvent({
      itemId: same.id,
      conflictId: null,
      type: "confirmed",
      actor: options.actor,
      data: draft.source ? { source: draft.source } : {},
    });
    return emptyOutcome(same, false);
  }

  /** Indexes a written item and, when it is active, looks for conflicts. */
  private activateWrite(row: MemoryItemRow, created: boolean, options: WriteOptions): WriteOutcome {
    const docId = this.indexItem(row);
    const out: WriteOutcome = { row, created, opened: [], embed: [docId], later: [] };
    if (row.status !== "active") return out;
    if (options.conflictsWith) this.openExplicit(row, options.conflictsWith, out);
    if (!options.skipConflictCheck) this.detect(row, docId, out, { vectors: true });
    return out;
  }

  private requireConflictTarget(draft: Draft, targetId: string): void {
    const target = this.store.getItem(targetId);
    if (!target) throw notFound("Memory", targetId);
    if (target.principalId !== draft.principalId || !sameScope(target, draft.scope)) {
      throw invalid("A memory can only disagree with a memory of the same scope.");
    }
  }

  private openExplicit(row: MemoryItemRow, targetId: string, out: WriteOutcome): void {
    const target = this.store.getItem(targetId);
    if (!target || !isCandidate(row, target)) return;
    const opened = this.openPair(row, target, {
      kind: "conflict",
      detector: "explicit",
      confidence: 1,
      reason: inLanguageOf(
        [row.content, target.content],
        "写入这条记忆时已指明它和已有的一条记忆不一致。",
        "The writer said this memory disagrees with an existing one.",
      ),
    });
    if (opened) out.opened.push(opened);
  }

  private acceptInPlace(
    row: MemoryItemRow,
    content: string,
    kind: MemoryItemKind | undefined,
    actor: MemoryActor,
  ): WriteOutcome {
    const same = this.store.findByHash(scopeOf(row), contentHash(content), row.principalId);
    if (same && same.id !== row.id && same.status === "active") {
      // Accepting what is already remembered closes the proposal in favour of the existing memory.
      this.indexItem(
        this.store.setStatus(row.id, "rejected", { actor, event: "rejected", data: { duplicateOf: same.id } }),
      );
      this.store.recordEvent({ itemId: same.id, conflictId: null, type: "confirmed", actor, data: { from: row.id } });
      return emptyOutcome(same, false);
    }
    if (content !== row.content) this.store.appendVersion(row.id, { content, actor });
    if (kind !== undefined) this.store.patchMeta(row.id, { kind }, actor);
    const accepted = this.store.setStatus(row.id, "active", { actor, event: "accepted" });
    return this.activateWrite(accepted, true, { actor, ...this.deferredWriteOptions(row.id) });
  }

  private acceptElsewhere(
    row: MemoryItemRow,
    target: MemoryScopeRef,
    content: string,
    kind: MemoryItemKind | undefined,
    actor: MemoryActor,
  ): WriteOutcome {
    const draft: Draft = { ...this.carriedFields(row), scope: target, status: "active", content, kind: kind ?? row.kind };
    const { skipConflictCheck } = this.deferredWriteOptions(row.id);
    const result = this.writeNew(draft, { actor, eventType: "accepted", data: { from: row.id }, skipConflictCheck });
    if (result.created) this.store.addLink(result.row.id, row.id, "derived_from");
    const moved = this.store.setStatus(row.id, "rejected", {
      actor,
      event: "rejected",
      data: { reason: "accepted_into_other_scope", movedTo: result.row.id, scope: memoryScopeKey(target) },
    });
    this.indexItem(moved);
    return result;
  }

  /** What the writer of a proposal asked for, kept on its creation event until it is accepted. */
  private deferredWriteOptions(id: string): Pick<WriteOptions, "conflictsWith" | "skipConflictCheck"> {
    const created = this.store.events(id).find((event) => event.type === "created" || event.type === "imported");
    const conflictsWith = created?.data.conflictsWith;
    return {
      conflictsWith: typeof conflictsWith === "string" ? conflictsWith : undefined,
      skipConflictCheck: created?.data.skipConflictCheck === true,
    };
  }

  private changeStatus(
    id: string,
    actor: MemoryActor,
    revision: number | undefined,
    decide: (
      row: MemoryItemRow,
    ) => { status: MemoryItemStatus; event: MemoryEventType; supersededBy?: string | null } | null,
  ): MemoryItem {
    const row = this.requireRow(id);
    checkRevision(row, revision);
    const next = decide(row);
    if (!next) return this.toItem(row);
    const { updated, docId } = this.store.transaction(() => {
      const changed = this.store.setStatus(id, next.status, {
        actor,
        event: next.event,
        supersededBy: next.supersededBy,
      });
      return { updated: changed, docId: this.indexItem(changed) };
    });
    // A memory that is recalled again may never have been embedded (it was put away right after it was written).
    if (updated.status === "active") this.embedder.enqueue(docId);
    return this.toItem(updated);
  }

  /**
   * The side a person chose to keep: a proposal becomes a memory. A side they put away earlier cannot be kept this
   * way; they restore it first, so nothing comes back without being asked for.
   */
  private keepSide(row: MemoryItemRow, which: "new" | "existing", actor: MemoryActor, data: Record<string, unknown>): void {
    if (row.status === "active") return;
    if (row.status !== "pending") {
      throw new MemoryError(
        "MEMORY_SIDE_PUT_AWAY",
        `The ${which} memory is ${row.status}, so it cannot be the one kept. Restore it first, or choose another option.`,
        409,
      );
    }
    this.acceptSide(row, actor, data);
  }

  private acceptSide(row: MemoryItemRow, actor: MemoryActor, data: Record<string, unknown>): void {
    this.store.setStatus(row.id, "active", { actor, event: "accepted", data });
  }

  private insertMerged(
    incoming: MemoryItemRow,
    existing: MemoryItemRow,
    merge: { content: string; title: string | undefined },
    actor: MemoryActor,
    conflictId: string,
  ): MemoryItemRow {
    const merged = this.store.insertItem(
      {
        scope: scopeOf(incoming),
        principalId: incoming.principalId,
        kind: incoming.kind,
        status: "active",
        origin: "user_explicit",
        pinned: incoming.pinned || existing.pinned,
        dataClass: mostPrivate(incoming.dataClass, existing.dataClass),
        title: merge.title || incoming.title || existing.title,
        content: merge.content,
        source: "合并两条记忆",
        sourceRefs: uniqueRefs([...incoming.sourceRefs, ...existing.sourceRefs]),
        via: incoming.via ?? existing.via,
        authorId: "owner",
        eventAt: incoming.eventAt ?? existing.eventAt,
        dueAt: incoming.dueAt ?? existing.dueAt,
        validFrom: incoming.validFrom ?? existing.validFrom,
        validUntil: incoming.validUntil ?? existing.validUntil,
      },
      actor,
      "created",
      { conflictId, mergedFrom: [incoming.id, existing.id] },
    );
    this.store.addLink(merged.id, incoming.id, "merged_from");
    this.store.addLink(merged.id, existing.id, "merged_from");
    return merged;
  }

  private indexItem(row: MemoryItemRow): number {
    const docId = this.index.upsertItem(row);
    this.touchIndex();
    return docId;
  }

  private touchIndex(): void {
    this.lastIndexedAt = this.now();
    this.store.setMeta(LAST_INDEXED_KEY, String(this.lastIndexedAt));
  }

  /** Runs what a committed write left to do and maps its result. */
  private finish(outcome: WriteOutcome): RememberResult {
    this.dispatch(outcome);
    return { item: this.toItem(outcome.row), created: outcome.created, conflicts: this.toConflicts(outcome.opened) };
  }

  private dispatch(outcome: WriteOutcome): void {
    for (const docId of outcome.embed) this.embedder.enqueue(docId);
    for (const task of outcome.later) this.queue.push(task);
  }

  private writeWindows(input: WriteWindowsInput & { scope: Omit<ChunkScopeInput, "speakerAgentIds"> }): void {
    const { scope, ...write } = input;
    const speakers = new Map(input.windows.map((window) => [window.seq, window.speakerAgentIds]));
    const ids = input.windows.map((window) => chunkIdOf(input.source, input.conversationId, window.seq));
    const previousHash = new Map(this.store.getChunks(ids).map((chunk) => [chunk.id, chunk.contentHash]));
    const changed = this.store.transaction(() => {
      const { written, replacedIds } = this.store.writeWindows(write);
      this.index.removeChunks(replacedIds);
      const embed: number[] = [];
      for (const chunk of written) {
        const keys = chunkScopeKeys({ ...scope, speakerAgentIds: speakers.get(chunk.seq) ?? [] });
        const docId = this.index.upsertChunk(chunk, keys);
        if (previousHash.get(chunk.id) !== chunk.contentHash) embed.push(docId);
      }
      this.touchIndex();
      return embed;
    });
    for (const docId of changed) this.embedder.enqueue(docId);
  }

  // ---- conflict detection ----------------------------------------------------------------------------------------

  /** Looks for repeats and disagreements of an active item within its scope (inside the write transaction). */
  private detect(row: MemoryItemRow, docId: number, out: WriteOutcome, options: { vectors: boolean }): void {
    const seen = new Set<string>([row.id]);
    for (const other of this.lexicalCandidates(row, docId)) {
      seen.add(other.id);
      const plan = this.planPair(row, other, null);
      if (!plan) continue;
      if (plan.via === "rules") {
        const opened = this.openByRules(plan);
        if (opened) out.opened.push(opened);
      } else {
        out.later.push((signal) => this.judgePair(plan, signal));
      }
    }
    if (options.vectors && this.vectorsUsableFor(row)) {
      out.later.push((signal) => this.vectorCandidates(row.id, seen, signal));
    }
  }

  private scopeFilter(row: MemoryItemRow): DocFilter {
    // Every active item of the scope is a candidate, local_only ones included; judging decides what may leave.
    return {
      scopeKeys: [memoryScopeKey(scopeOf(row))],
      principalId: row.principalId,
      docKind: "item",
      dataClass: "local_only",
    };
  }

  private lexicalCandidates(row: MemoryItemRow, docId: number): MemoryItemRow[] {
    const hits = this.index.lexical(row.content, this.scopeFilter(row), CANDIDATES + 1);
    const refOf = new Map(this.index.docs(hits.map((hit) => hit.docId)).map((doc) => [doc.docId, doc.refId]));
    const ids = hits.flatMap((hit) => (hit.docId === docId ? [] : (refOf.get(hit.docId) ?? [])));
    return this.store
      .getItems(ids)
      .filter((other) => isCandidate(row, other))
      .slice(0, CANDIDATES);
  }

  private planPair(row: MemoryItemRow, other: MemoryItemRow, cosine: number | null): PairPlan | null {
    const [incoming, existing] = newerFirst(row, other);
    const rule = comparePair(incoming.content, existing.content);
    const marked = rule.relation === "conflict" || rule.relation === "duplicate";
    if (this.judgeFor(incoming, existing)) {
      const similar = rule.similarity >= JUDGE_MIN_JACCARD || (cosine ?? 0) >= JUDGE_MIN_COSINE;
      return marked || similar ? { incoming, existing, rule, marked, via: "judge" } : null;
    }
    return marked && rule.confidence >= RULES_OPEN_AT ? { incoming, existing, rule, marked, via: "rules" } : null;
  }

  private openByRules(plan: PairPlan): MemoryConflictRow | null {
    return this.openPair(plan.incoming, plan.existing, {
      kind: plan.rule.relation === "duplicate" ? "duplicate" : "conflict",
      detector: "heuristic",
      confidence: plan.rule.confidence,
      reason: plan.rule.reason,
    });
  }

  private openPair(incoming: MemoryItemRow, existing: MemoryItemRow, opening: PairOpening): MemoryConflictRow | null {
    const opened = this.store.openConflict({
      kind: opening.kind,
      scope: scopeOf(incoming),
      incomingId: incoming.id,
      existingId: existing.id,
      reason: opening.reason,
      detector: opening.detector,
      confidence: Math.round(opening.confidence * 100) / 100,
      suggestion: suggestResolution(opening.kind, incoming, existing),
    });
    if (opened) this.conflictsOpened += 1;
    return opened;
  }

  /** The configured judge, unless it is remote and either text is `local_only` (I6). */
  private judgeFor(a: MemoryItemRow, b: MemoryItemRow): MemoryJudge | null {
    const judge = this.providers().judge;
    if (!judge) return null;
    if (judge.remote && (!remoteAllowed(a.dataClass) || !remoteAllowed(b.dataClass))) return null;
    return judge;
  }

  private vectorsUsableFor(row: MemoryItemRow): boolean {
    const embedding = this.providers().embedding;
    return (
      embedding !== null && this.errors.embedding === null && (!embedding.remote || remoteAllowed(row.dataClass))
    );
  }

  /**
   * Background: asks the judge about one pair. A conflict/duplicate verdict opens it; an unrelated/refines
   * verdict cancels what the rules marked; without a usable verdict the rules decide.
   */
  private async judgePair(plan: PairPlan, signal: AbortSignal): Promise<void> {
    // Remembered per text: after either memory is rewritten the pair is a new question for the judge.
    const key = `${conflictPairKey(plan.incoming.id, plan.existing.id)}:${plan.incoming.contentRevision}:${plan.existing.contentRevision}`;
    if (this.judgedPairs.has(key) || this.pairRaised(plan.incoming.id, plan.existing.id)) return;
    const judge = this.judgeFor(plan.incoming, plan.existing);
    if (!judge || !this.unchanged(plan)) return;
    this.judgedPairs.add(key);
    let verdict: JudgeVerdict | null = null;
    try {
      verdict = await judge.compare(
        { content: plan.incoming.content, kind: plan.incoming.kind, at: plan.incoming.updatedAt },
        { content: plan.existing.content, kind: plan.existing.kind, at: plan.existing.updatedAt },
        signal,
      );
      this.clearError("judge");
    } catch (error) {
      this.judgedPairs.delete(key);
      if (signal.aborted) return;
      this.recordError("judge", error);
    }
    if (signal.aborted || this.disposed || !this.unchanged(plan)) return;
    const opening = this.afterJudging(plan, verdict);
    if (opening) this.store.transaction(() => this.openPair(plan.incoming, plan.existing, opening));
  }

  private afterJudging(plan: PairPlan, verdict: JudgeVerdict | null): PairOpening | null {
    if (verdict && verdict.confidence >= JUDGE_DECIDES_AT) {
      if (verdict.relation === "conflict" || verdict.relation === "duplicate") {
        return {
          kind: verdict.relation,
          detector: "judge",
          confidence: verdict.confidence,
          reason: verdict.reason.trim() || plan.rule.reason,
        };
      }
      return null;
    }
    if (!plan.marked || plan.rule.confidence < RULES_OPEN_AT) return null;
    return {
      kind: plan.rule.relation === "duplicate" ? "duplicate" : "conflict",
      detector: "heuristic",
      confidence: plan.rule.confidence,
      reason: plan.rule.reason,
    };
  }

  /** Both items are still active with the text the plan was made from. */
  private unchanged(plan: PairPlan): boolean {
    const [incoming, existing] = this.store.getItems([plan.incoming.id, plan.existing.id]);
    const same = (now: MemoryItemRow | undefined, then: MemoryItemRow) =>
      now?.status === "active" && now.contentRevision === then.contentRevision;
    return same(incoming, plan.incoming) && same(existing, plan.existing);
  }

  private pairRaised(a: string, b: string): boolean {
    return this.store.listConflicts({ itemId: a }).some((c) => c.incomingId === b || c.existingId === b);
  }

  /** Background: nearest items by vector that the lexical channel did not bring up. */
  private async vectorCandidates(itemId: string, seen: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
    const row = this.store.getItem(itemId);
    const embedding = this.providers().embedding;
    if (!row || row.status !== "active" || !embedding || !this.vectorsUsableFor(row)) return;
    let vector: Float32Array | undefined;
    try {
      [vector] = await embedding.embed([itemText(row)], "document", signal);
      this.clearError("embedding");
    } catch (error) {
      if (!signal.aborted) this.recordError("embedding", error);
      return;
    }
    const current = this.store.getItem(itemId);
    if (!vector || signal.aborted || current?.status !== "active" || current.contentRevision !== row.contentRevision) {
      return;
    }
    const allowed = new Set(this.index.allowedDocIds(this.scopeFilter(current)));
    const selfDoc = this.index.docIdOf("item", itemId);
    if (selfDoc !== null) allowed.delete(selfDoc);
    const hits = this.vectors.search(vector, embedding.modelId, allowed, CANDIDATES);
    const cosineOf = new Map<string, number>();
    const scoreOf = new Map(hits.map((hit) => [hit.docId, hit.score]));
    for (const doc of this.index.docs(hits.map((hit) => hit.docId))) {
      if (doc.docKind === "item") cosineOf.set(doc.refId, scoreOf.get(doc.docId) ?? 0);
    }
    const others = this.store.getItems([...cosineOf.keys()]).filter((o) => !seen.has(o.id) && isCandidate(current, o));
    for (const other of others) {
      if (signal.aborted) return;
      const plan = this.planPair(current, other, cosineOf.get(other.id) ?? null);
      if (!plan) continue;
      if (plan.via === "rules") this.store.transaction(() => this.openByRules(plan));
      else await this.judgePair(plan, signal);
    }
  }

  // ---- mapping ---------------------------------------------------------------------------------------------------

  private requireRow(id: string): MemoryItemRow {
    const row = this.store.getItem(id);
    if (!row) throw notFound("Memory", id);
    return row;
  }

  private labelOf(scope: MemoryScopeRef): string | undefined {
    try {
      return this.labeler(scope) || undefined;
    } catch {
      return undefined;
    }
  }

  private toItem(row: MemoryItemRow): MemoryItem {
    return this.toItems([row])[0]!;
  }

  private toItems(rows: readonly MemoryItemRow[]): MemoryItem[] {
    const open = this.store.openConflictIds(rows.map((row) => row.id));
    return rows.map((row) => {
      const scope = scopeOf(row);
      return {
        id: row.id,
        scope,
        scopeLabel: this.labelOf(scope),
        kind: row.kind,
        status: row.status,
        origin: row.origin,
        pinned: row.pinned,
        dataClass: row.dataClass,
        title: row.title,
        content: row.content,
        source: row.source,
        sourceRefs: row.sourceRefs,
        via: row.via,
        authorId: row.authorId,
        eventAt: row.eventAt,
        dueAt: row.dueAt,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        supersededBy: row.supersededBy,
        revision: row.revision,
        versionCount: row.versionCount,
        openConflictIds: open.get(row.id) ?? [],
        redacted: row.redacted,
        backing: "ledger",
        readOnly: false,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  private toConflicts(rows: readonly MemoryConflictRow[]): MemoryConflict[] {
    if (rows.length === 0) return [];
    const items = this.toItems(this.store.getItems(rows.flatMap((row) => [row.incomingId, row.existingId])));
    const byId = new Map(items.map((item) => [item.id, item]));
    return rows.flatMap((row) => {
      const incoming = byId.get(row.incomingId);
      const existing = byId.get(row.existingId);
      if (!incoming || !existing) return [];
      const scope = scopeOf(row);
      return [
        {
          id: row.id,
          kind: row.kind,
          scope,
          scopeLabel: this.labelOf(scope),
          incoming,
          existing,
          reason: row.reason,
          detector: row.detector,
          confidence: row.confidence,
          suggestion: row.suggestion,
          status: row.status,
          resolution: row.resolution,
          mergedItemId: row.mergedItemId,
          createdAt: row.createdAt,
          resolvedAt: row.resolvedAt,
        },
      ];
    });
  }

  private toChunk(row: MemoryChunkRow): MemoryChunk {
    return {
      id: row.id,
      source: row.source,
      conversationId: row.conversationId,
      conversationTitle: this.labelOf({ kind: "conversation", id: row.conversationId }),
      seq: row.seq,
      content: row.content,
      scopes: this.storedChunkKeys(row).flatMap((key) => parseMemoryScopeKey(key) ?? []),
      speakers: row.speakers,
      messageIds: row.messageIds,
      startAt: row.startAt,
      endAt: row.endAt,
      dataClass: row.dataClass,
    };
  }

  /** Scope keys of a window as the index holds them; the conversation itself when it was never indexed. */
  private storedChunkKeys(chunk: MemoryChunkRow): string[] {
    const docId = this.index.docIdOf("chunk", chunk.id);
    const keys = docId === null ? [] : this.index.scopeKeysOf(docId);
    return keys.length > 0 ? keys : [memoryScopeKey({ kind: "conversation", id: chunk.conversationId })];
  }

  private documentText(doc: IndexedDoc): string | null {
    if (doc.docKind === "chunk") return this.store.getChunk(doc.refId)?.content || null;
    const row = this.store.getItem(doc.refId);
    return row && !row.redacted && row.content ? itemText(row) : null;
  }

  private knownTexts(scopes: readonly MemoryScopeRef[], principalId: string, dataClass: PaDataClass | undefined) {
    // local_only memories may only reach a model asked about local_only text.
    const includeLocalOnly = dataClass === "local_only";
    return scopes.flatMap((scope) =>
      this.store
        .listItems({ scope, statuses: ["active", "pending"], principalId, includeLocalOnly, limit: KNOWN_PER_TARGET })
        .rows.map((row) => row.content),
    );
  }

  // ---- providers and their health --------------------------------------------------------------------------------

  /** Clients for the current configuration, with the test seam applied. */
  private providers(): MemoryProviders {
    let base: MemoryProviders;
    try {
      base = this.settings.providers(this.llm, this.local);
    } catch (error) {
      this.recordError("embedding", error);
      base = NO_PROVIDERS;
    }
    if (this.merged?.base === base) return this.merged.providers;
    const before = this.merged;
    const pick = <K extends ProviderSlot>(slot: K): MemoryProviders[K] =>
      this.overrides[slot] !== undefined ? (this.overrides[slot] as MemoryProviders[K]) : base[slot];
    const providers: MemoryProviders = { embedding: pick("embedding"), reranker: pick("reranker"), judge: pick("judge") };
    this.merged = { base, providers };
    // A provider that appears later (a local model finished downloading) gets every waiting document.
    if (before && providers.embedding && providers.embedding !== before.providers.embedding) {
      queueMicrotask(() => {
        if (!this.disposed) this.embedder.requeueStale();
      });
    }
    return providers;
  }

  /** A local model was downloaded, failed or was cancelled: its earlier provider error no longer applies. */
  private localModelsChanged(): void {
    if (this.disposed) return;
    const config = this.settings.get();
    if (config.embedding.provider === "local") this.clearError("embedding");
    if (config.reranker.provider === "local") this.clearError("reranker");
    this.providers();
  }

  private recordError(slot: ProviderSlot, error: unknown): void {
    this.errors[slot] = describeError(error);
  }

  private clearError(slot: ProviderSlot): void {
    this.errors[slot] = null;
  }
}

/** Builds the memory engine over the database that holds (or will hold) the memory tables. */
export function createMemoryEngine(deps: MemoryEngineDeps): MemoryEngineApi {
  return new MemoryEngine(deps);
}
