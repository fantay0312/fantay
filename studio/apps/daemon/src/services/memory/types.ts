// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — internal interfaces of the memory engine.
//
// Module ownership (each module implements the interface named after it and depends on the others only
// through these interfaces):
//   store.ts          MemoryStoreApi      rows, versions, events, links, conflicts, raw windows, meta
//   search-index.ts   MemoryIndexApi      mem_docs / mem_doc_scopes / mem_fts
//   vectors.ts        MemoryVectorsApi    mem_vectors + in-memory matrix
//   retrieval.ts      MemoryRetrieverApi  recall pipeline and prompt block
//   config.ts         MemoryConfigApi     engine configuration and stored keys
//   providers.ts      MemoryProviders     embedding / rerank / judge clients built from the configuration
//   distill.ts        MemoryDistillerApi  turns a transcript into proposed memories
//   ingest.ts         conversation readers and the window builder, writing through ChunkSink
//   engine.ts         MemoryEngineApi     the facade everything outside this folder uses

import type {
  MemoryAutoMode,
  MemoryChunk,
  MemoryConflict,
  MemoryConflictKind,
  MemoryConflictResolution,
  MemoryEngineConfig,
  MemoryEngineStatus,
  MemoryEvent,
  MemoryEventType,
  MemoryItem,
  MemoryItemKind,
  MemoryItemStatus,
  MemoryItemVersion,
  MemoryLink,
  MemoryLocalModel,
  MemoryLinkRelation,
  MemoryMergeDraftResponse,
  MemoryRecallResponse,
  MemoryScopeCounts,
  MemoryScopeRef,
  MemoryTidyResponse,
  MemoryVia,
  PaDataClass,
  PaMemoryOriginKind,
  PaMemorySourceRef,
  UpdateMemoryEngineConfigRequest,
} from "@open-design/contracts";
import type { SqliteDb } from "../../db.js";
import type { ChunkScopeInput, MemoryAccessContext } from "./policy.js";

/** `owner`, `system`, or `agent:<id>`. Only `owner` may archive, restore, redact or resolve a conflict. */
export type MemoryActor = string;

// ---- Rows --------------------------------------------------------------------------------------------------------

export interface MemoryItemRow {
  id: string;
  scopeKind: MemoryScopeRef["kind"];
  scopeId: string;
  principalId: string;
  kind: MemoryItemKind;
  status: MemoryItemStatus;
  origin: PaMemoryOriginKind;
  pinned: boolean;
  dataClass: PaDataClass;
  title: string;
  content: string;
  contentHash: string;
  source: string;
  sourceRefs: PaMemorySourceRef[];
  via: MemoryVia | null;
  authorId: string | null;
  eventAt: number | null;
  dueAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  supersededBy: string | null;
  revision: number;
  /** Value of `revision` when the text last changed. */
  contentRevision: number;
  versionCount: number;
  redacted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryConflictRow {
  id: string;
  kind: MemoryConflictKind;
  scopeKind: MemoryScopeRef["kind"];
  scopeId: string;
  incomingId: string;
  existingId: string;
  reason: string;
  detector: MemoryConflict["detector"];
  confidence: number;
  suggestion: MemoryConflictResolution | null;
  status: "open" | "resolved";
  resolution: MemoryConflictResolution | null;
  mergedItemId: string | null;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface MemoryChunkRow {
  id: string;
  source: "pa" | "studio";
  conversationId: string;
  seq: number;
  content: string;
  contentHash: string;
  speakers: string[];
  messageIds: string[];
  startAt: number;
  endAt: number;
  dataClass: PaDataClass;
  principalId: string;
  open: boolean;
  createdAt: number;
  updatedAt: number;
}

// ---- store.ts ----------------------------------------------------------------------------------------------------

export interface NewItemRow {
  id?: string | undefined;
  scope: MemoryScopeRef;
  principalId?: string | undefined;
  kind?: MemoryItemKind | undefined;
  status?: MemoryItemStatus | undefined;
  origin?: PaMemoryOriginKind | undefined;
  pinned?: boolean | undefined;
  dataClass?: PaDataClass | undefined;
  title?: string | undefined;
  content: string;
  source?: string | undefined;
  sourceRefs?: PaMemorySourceRef[] | undefined;
  via?: MemoryVia | null | undefined;
  authorId?: string | null | undefined;
  eventAt?: number | null | undefined;
  dueAt?: number | null | undefined;
  validFrom?: number | null | undefined;
  validUntil?: number | null | undefined;
  revision?: number | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
}

export interface ItemFilter {
  scope?: MemoryScopeRef | undefined;
  /** Any of these scopes (scope keys). */
  scopeKeys?: readonly string[] | undefined;
  statuses?: readonly MemoryItemStatus[] | undefined;
  kind?: MemoryItemKind | undefined;
  pinned?: boolean | undefined;
  viaGroup?: boolean | undefined;
  /** Case-insensitive substring over title and content. */
  text?: string | undefined;
  principalId?: string | undefined;
  /** Hide `local_only` items unless true. */
  includeLocalOnly?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  order?: "updated_desc" | "created_desc" | "created_asc" | undefined;
}

export interface WriteWindowsInput {
  source: "pa" | "studio";
  conversationId: string;
  /** Windows with seq >= fromSeq are replaced by `windows`. 0 rebuilds the conversation. */
  fromSeq: number;
  windows: ChunkWindow[];
  dataClass: PaDataClass;
  principalId: string;
  cursor: { messageCount: number; prefixHash: string };
}

export interface MemoryStoreApi {
  readonly db: SqliteDb;
  transaction<T>(fn: () => T): T;

  insertItem(input: NewItemRow, actor: MemoryActor, eventType?: MemoryEventType): MemoryItemRow;
  getItem(id: string): MemoryItemRow | null;
  getItems(ids: readonly string[]): MemoryItemRow[];
  listItems(filter: ItemFilter): { rows: MemoryItemRow[]; total: number };
  findByHash(scope: MemoryScopeRef, contentHash: string, principalId: string): MemoryItemRow | null;
  /** Stores new text as the next version. The previous text stays in mem_versions. */
  appendVersion(
    id: string,
    input: { content: string; title?: string | undefined; actor: MemoryActor; note?: string | undefined },
  ): MemoryItemRow;
  setStatus(
    id: string,
    status: MemoryItemStatus,
    input: {
      actor: MemoryActor;
      event: MemoryEventType;
      supersededBy?: string | null | undefined;
      data?: Record<string, unknown> | undefined;
    },
  ): MemoryItemRow;
  setPinned(id: string, pinned: boolean, actor: MemoryActor): MemoryItemRow;
  patchMeta(
    id: string,
    patch: {
      kind?: MemoryItemKind | undefined;
      dueAt?: number | null | undefined;
      validFrom?: number | null | undefined;
      validUntil?: number | null | undefined;
    },
    actor: MemoryActor,
    /** Why the change was made; kept on the event. */
    note?: string,
  ): MemoryItemRow;
  /** Clears the text of the item and of every stored version. The rows and events stay. */
  redact(id: string, actor: MemoryActor): MemoryItemRow;
  recordEvent(
    event: Omit<MemoryEvent, "seq" | "at" | "data"> & { data?: Record<string, unknown> | undefined },
  ): void;
  versions(id: string): MemoryItemVersion[];
  events(id: string): MemoryEvent[];
  links(id: string): MemoryLink[];
  addLink(fromId: string, toId: string, relation: MemoryLinkRelation): void;

  /** Returns null when this pair was already raised once (open or resolved). */
  openConflict(input: {
    kind: MemoryConflictKind;
    scope: MemoryScopeRef;
    incomingId: string;
    existingId: string;
    reason: string;
    detector: MemoryConflict["detector"];
    confidence: number;
    suggestion?: MemoryConflictResolution | null | undefined;
  }): MemoryConflictRow | null;
  getConflict(id: string): MemoryConflictRow | null;
  listConflicts(filter: {
    status?: "open" | "resolved" | undefined;
    scopeKeys?: readonly string[] | undefined;
    itemId?: string | undefined;
    limit?: number | undefined;
  }): MemoryConflictRow[];
  closeConflict(
    id: string,
    input: { resolution: MemoryConflictResolution; mergedItemId?: string | null | undefined; actor: MemoryActor },
  ): MemoryConflictRow;
  /** Open-conflict ids per item id. */
  openConflictIds(itemIds: readonly string[]): Map<string, string[]>;
  /** Item counts per scope key, optionally for one principal. `chunks` is filled by the engine. */
  scopeCounts(principalId?: string): Map<string, MemoryScopeCounts>;

  cursor(source: "pa" | "studio", conversationId: string): { messageCount: number; prefixHash: string } | null;
  /** Replaces windows from `fromSeq` on and stores the cursor. Returns the rows written and the ids replaced. */
  writeWindows(input: WriteWindowsInput): { written: MemoryChunkRow[]; replacedIds: string[] };
  getChunk(id: string): MemoryChunkRow | null;
  getChunks(ids: readonly string[]): MemoryChunkRow[];
  listChunks(filter: {
    conversationId?: string | undefined;
    ids?: readonly string[] | undefined;
    principalId?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }): { rows: MemoryChunkRow[]; total: number };
  neighbors(chunk: MemoryChunkRow, radius: number): MemoryChunkRow[];

  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  logRecall(entry: {
    surface: string;
    scopeKeys: readonly string[];
    hitCount: number;
    injectedChars: number;
    level: string;
    latencyMs: number;
  }): void;
  recallLatency(): { p50: number; p95: number; samples: number } | null;
}

// ---- search-index.ts ---------------------------------------------------------------------------------------------

export interface IndexedDoc {
  docId: number;
  docKind: "item" | "chunk";
  refId: string;
  dataClass: PaDataClass;
  principalId: string;
  recallable: boolean;
  eventAt: number;
  contentHash: string;
}

export interface DocFilter {
  /** Documents readable by any of these scopes. Empty means nothing is readable. */
  scopeKeys: readonly string[];
  /**
   * When given, a raw window must also be readable by one of these scopes (a subset of `scopeKeys`);
   * items are unaffected. Left out, windows follow `scopeKeys`.
   */
  windowScopeKeys?: readonly string[] | undefined;
  /** The asking turn's data class; `local_only` documents need a `local_only` turn. */
  dataClass?: PaDataClass | undefined;
  principalId?: string | undefined;
  docKind?: "item" | "chunk" | undefined;
  /** Include documents hidden from recall (the Memory Center searching archived items). */
  includeHidden?: boolean | undefined;
}

export interface ChannelHit {
  docId: number;
  /** Higher is better; comparable only within one channel. */
  score: number;
}

export interface MemoryIndexApi {
  /** Adds or refreshes the document of an item. Non-active items stay indexed with recallable = 0. */
  upsertItem(item: MemoryItemRow): number;
  upsertChunk(chunk: MemoryChunkRow, scopeKeys: readonly string[]): number;
  /** Removes projection rows of replaced windows. */
  removeChunks(chunkIds: readonly string[]): void;
  /** BM25 over tokens, restricted to the filter inside the index. */
  lexical(query: string, filter: DocFilter, limit: number): ChannelHit[];
  /** Exact phrases, identifiers, numbers and quoted strings taken from the query. */
  literal(query: string, filter: DocFilter, limit: number): ChannelHit[];
  /** Every document id the filter allows (used to mask the vector scan). */
  allowedDocIds(filter: DocFilter): number[];
  docs(docIds: readonly number[]): IndexedDoc[];
  docIdOf(docKind: "item" | "chunk", refId: string): number | null;
  /** Number of raw windows readable per scope key. */
  chunkCounts(): Map<string, number>;
  /** Scope keys of one document. */
  scopeKeysOf(docId: number): string[];
  count(): number;
  /** Drops and rebuilds every projection row from the given truth. */
  rebuild(source: {
    items: Iterable<MemoryItemRow>;
    chunks: Iterable<{ chunk: MemoryChunkRow; scopeKeys: readonly string[] }>;
  }): number;
  /** Removes index rows whose memory or window no longer exists, and compacts the index. Returns how many. */
  removeOrphans(): number;
}

// ---- vectors.ts --------------------------------------------------------------------------------------------------

export interface MemoryVectorsApi {
  upsert(docId: number, modelId: string, vector: Float32Array, contentHash: string): void;
  /** Cosine top-k over the allowed documents. */
  search(queryVector: Float32Array, modelId: string, allowed: ReadonlySet<number>, limit: number): ChannelHit[];
  /** Cosine of the query to each listed document that has a vector of this model; documents without one are absent. */
  scores(queryVector: Float32Array, modelId: string, docIds: readonly number[]): Map<number, number>;
  /** Documents with no vector for this model, or a vector of older text. */
  stale(modelId: string, limit: number): Array<{ docId: number; contentHash: string }>;
  counts(modelId: string): { indexed: number; waiting: number };
  /** Forget cached matrices (after a rebuild). */
  reset(): void;
}

// ---- providers.ts / config.ts ------------------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** Stable id of provider + model + dimensions; vectors of different ids are never compared. */
  readonly modelId: string;
  /** True when text leaves this machine. `local_only` text is never sent to a remote provider. */
  readonly remote: boolean;
  embed(texts: readonly string[], kind: "query" | "document", signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface RerankProvider {
  readonly id: string;
  readonly remote: boolean;
  /** One relevance score per document, higher is better. */
  rerank(query: string, documents: readonly string[], signal?: AbortSignal): Promise<number[]>;
}

export type JudgeRelation = "conflict" | "duplicate" | "refines" | "unrelated";

export interface JudgeVerdict {
  relation: JudgeRelation;
  /** 0..1 */
  confidence: number;
  /** One plain sentence in the language of the memories. */
  reason: string;
}

export interface MemoryJudge {
  readonly id: string;
  readonly remote: boolean;
  /** `incoming` is the newer memory. */
  compare(
    incoming: { content: string; kind: MemoryItemKind; at: number },
    existing: { content: string; kind: MemoryItemKind; at: number },
    signal?: AbortSignal,
  ): Promise<JudgeVerdict>;
}

/** A general text model, supplied by the daemon (Settings → 记忆 model, or the bot's own model). */
export interface MemoryLlm {
  complete(input: {
    system: string;
    user: string;
    maxTokens?: number | undefined;
    dataClass?: PaDataClass | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<string | null>;
}

export interface MemoryProviders {
  embedding: EmbeddingProvider | null;
  reranker: RerankProvider | null;
  /** A model-backed judge, or null to rely on the built-in rules alone. */
  judge: MemoryJudge | null;
}

/** Models that run on this machine (local-models.ts). */
export interface MemoryLocalRuntime {
  /** Whether the inference runtime can be loaded in this build. */
  available(): boolean;
  models(): MemoryLocalModel[];
  /** Starts (or resumes) a download; resolves when it is queued, not when it is done. */
  download(id: string): Promise<void>;
  cancel(id: string): void;
  /** The embedding model as a provider, or null until it is downloaded and loadable. */
  embedding(dimensions: number): EmbeddingProvider | null;
  reranker(): RerankProvider | null;
  dispose(): void;
}

export interface MemoryConfigApi {
  get(): MemoryEngineConfig;
  update(patch: UpdateMemoryEngineConfigRequest): MemoryEngineConfig;
  /** Stored keys; never returned over HTTP. */
  secrets(): { embeddingApiKey: string; rerankerApiKey: string; judgeApiKey: string };
  /** Builds clients for the current configuration. `llm` backs the `llm` judge; `local` backs the `local` providers. */
  providers(llm: MemoryLlm | null, local?: MemoryLocalRuntime | null): MemoryProviders;
}

// ---- retrieval.ts ------------------------------------------------------------------------------------------------

export interface RecallRequest {
  query: string;
  /** A real turn: the engine works out the readable scopes. */
  access?: MemoryAccessContext | undefined;
  /** Or explicit scopes (the Memory Center's search box). Ignored when `access` is given. */
  scopes?: readonly MemoryScopeRef[] | undefined;
  dataClass?: PaDataClass | undefined;
  principalId?: string | undefined;
  limit?: number | undefined;
  budgetChars?: number | undefined;
  /** Default true. */
  includeChunks?: boolean | undefined;
  /** Default true: pinned items of the readable scopes are always included, within their own budget. */
  includeStanding?: boolean | undefined;
  /** Messages already in the model's context; windows made only of them are skipped. */
  excludeMessageIds?: ReadonlySet<string> | undefined;
  /** Record this recall in mem_recall_log under this surface name. */
  logAs?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface RecallResult extends MemoryRecallResponse {
  /**
   * Items placed into the prompt block, with the revision that was read. `standing` marks an item that is there
   * only because it is pinned, not because it was recalled for this request.
   */
  itemRefs: Array<{ id: string; revision: number; standing?: boolean }>;
}

export interface MemoryRetrieverApi {
  recall(request: RecallRequest): Promise<RecallResult>;
}

// ---- distill.ts --------------------------------------------------------------------------------------------------

export interface DistillTarget {
  scope: MemoryScopeRef;
  /** What belongs in this scope, in one line, shown to the model. */
  hint: string;
}

export interface DistillInput {
  /** The exchange to learn from, as "Speaker: text" lines. */
  transcript: string;
  /** Scopes the result may be written to. The model picks one per memory. */
  targets: readonly DistillTarget[];
  /** Memories already known in those scopes, so they are not proposed again. */
  known?: readonly string[] | undefined;
  dataClass?: PaDataClass | undefined;
  signal?: AbortSignal | undefined;
}

export interface DistilledMemory {
  scope: MemoryScopeRef;
  kind: MemoryItemKind;
  content: string;
  /** Verbatim words from the transcript that support it. */
  quote: string;
  eventAt: number | null;
  dueAt: number | null;
}

export interface MemoryDistillerApi {
  /** Returns [] when no model is available or nothing is worth keeping. */
  distill(input: DistillInput, llm: MemoryLlm | null): Promise<DistilledMemory[]>;
  mergeDraft(a: string, b: string, llm: MemoryLlm | null): Promise<MemoryMergeDraftResponse>;
}

// ---- ingest.ts ---------------------------------------------------------------------------------------------------

/** One message of a conversation, as the window builder needs it. */
export interface IngestMessage {
  id: string;
  /** Display name: "用户", a bot's name, or a channel member's name. */
  speaker: string;
  /** The bot that wrote it, when a bot did. */
  agentId: string | null;
  text: string;
  at: number;
  dataClass: PaDataClass;
}

export interface ChunkWindow {
  seq: number;
  content: string;
  speakers: string[];
  speakerAgentIds: string[];
  messageIds: string[];
  startAt: number;
  endAt: number;
  /** The last window of a conversation stays open and is replaced as messages arrive. */
  open: boolean;
}

/** Where ingest writes. Implemented by the engine (store + index). */
export interface ChunkSink {
  cursor(source: "pa" | "studio", conversationId: string): { messageCount: number; prefixHash: string } | null;
  writeWindows(input: WriteWindowsInput & { scope: Omit<ChunkScopeInput, "speakerAgentIds"> }): void;
}

// ---- engine.ts ---------------------------------------------------------------------------------------------------

export interface RememberInput extends NewItemRow {
  /** `pending` stores a proposal that is not recalled until a person accepts it. Default `active`. */
  status?: "active" | "pending" | undefined;
  /** The writer already knows which memory this one disagrees with; a conflict is opened with it. */
  conflictsWith?: string | undefined;
  /** Imports: do not look for conflicts. */
  skipConflictCheck?: boolean | undefined;
  /**
   * Import only: write this item even when the same text already exists in the scope. Two legacy memories with the
   * same words are two records; folding them would make one of them vanish.
   */
  allowSameText?: boolean | undefined;
  actor: MemoryActor;
}

export interface RememberResult {
  item: MemoryItem;
  /** False when the same text already existed in that scope; that item is returned and a `confirmed` event added. */
  created: boolean;
  conflicts: MemoryConflict[];
}

/**
 * A change to an existing memory. Text, title, kind, pin and due date are the owner's to change: a bot or the
 * system that knows better writes a new memory (`remember` with `conflictsWith`) and a person decides. The one
 * thing a non-owner may change is the validity window, so that a memory can stop or resume being recalled.
 */
export interface ReviseInput {
  content?: string | undefined;
  title?: string | undefined;
  kind?: MemoryItemKind | undefined;
  pinned?: boolean | undefined;
  dueAt?: number | null | undefined;
  validFrom?: number | null | undefined;
  validUntil?: number | null | undefined;
  note?: string | undefined;
  /** Optimistic lock; a mismatch throws MemoryError("MEMORY_REVISION_CONFLICT", 409). */
  revision?: number | undefined;
  actor: MemoryActor;
}

export interface EngineListQuery extends ItemFilter {
  /** Default ["active"]. */
  statuses?: readonly MemoryItemStatus[] | undefined;
}

export interface EngineDistillInput {
  transcript: string;
  targets: readonly DistillTarget[];
  source: string;
  sourceRefs?: PaMemorySourceRef[] | undefined;
  via?: MemoryVia | null | undefined;
  authorId?: string | null | undefined;
  dataClass?: PaDataClass | undefined;
  principalId?: string | undefined;
  /** Overrides the configured auto-memory mode for this call. */
  mode?: MemoryAutoMode | undefined;
  /** The model to use for this call; falls back to the engine's model. */
  llm?: MemoryLlm | null | undefined;
  /**
   * Scopes whose existing memories may be shown to the model as "already known". Defaults to the target scopes.
   * Narrow it to what the called model's own bot can read: in a group, one bot's model must not be handed another
   * bot's memories. Exact repeats are still dropped when the proposal is written.
   */
  knownScopes?: readonly MemoryScopeRef[] | undefined;
  signal?: AbortSignal | undefined;
}

export interface MemoryEngineDeps {
  /** Database that holds the memory tables. */
  db: SqliteDb;
  dataDir: string;
  now?: (() => number) | undefined;
  llm?: MemoryLlm | null | undefined;
  /** Display name of a scope; used to fill `scopeLabel`. */
  labelOf?: ((scope: MemoryScopeRef) => string | undefined) | undefined;
  /** Test seam: replaces the providers built from the configuration. */
  providers?: Partial<MemoryProviders> | undefined;
  /** Test seam: replaces the local model runtime the engine creates under `dataDir` (null: none). */
  local?: MemoryLocalRuntime | null | undefined;
  fetch?: typeof fetch | undefined;
}

export class MemoryError extends Error {
  constructor(
    public code:
      | "MEMORY_NOT_FOUND"
      | "MEMORY_REVISION_CONFLICT"
      | "MEMORY_INVALID"
      | "MEMORY_FORBIDDEN"
      | "MEMORY_SECRET_BLOCKED"
      | "MEMORY_CONFLICT_RESOLVED"
      /** The side chosen to be kept was already put away; the owner restores it first (409). */
      | "MEMORY_SIDE_PUT_AWAY",
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export interface MemoryEngineApi {
  // -- write. Every method is synchronous on SQLite; model work (embedding, judge) continues in the background.
  remember(input: RememberInput): RememberResult;
  revise(id: string, input: ReviseInput): { item: MemoryItem; conflicts: MemoryConflict[] };
  archive(id: string, actor: MemoryActor, revision?: number): MemoryItem;
  restore(id: string, actor: MemoryActor, revision?: number): MemoryItem;
  redact(id: string, actor: MemoryActor): MemoryItem;
  /** pending → active, optionally with corrected text, kind or scope. */
  accept(
    id: string,
    actor: MemoryActor,
    patch?: { content?: string | undefined; kind?: MemoryItemKind | undefined; scope?: MemoryScopeRef | undefined },
    revision?: number,
  ): RememberResult;
  /** pending → rejected. */
  reject(id: string, actor: MemoryActor, revision?: number): MemoryItem;
  /** Copies an item into another scope; the copy links back with `derived_from`. */
  copy(id: string, scope: MemoryScopeRef, actor: MemoryActor, title?: string): RememberResult;
  resolveConflict(
    id: string,
    input: {
      resolution: MemoryConflictResolution;
      mergedContent?: string | undefined;
      mergedTitle?: string | undefined;
      actor: MemoryActor;
    },
  ): { conflict: MemoryConflict; items: MemoryItem[] };

  // -- read
  getItem(id: string): MemoryItem | null;
  /** The stored row, including `principalId` and `contentRevision`. */
  getRow(id: string): MemoryItemRow | null;
  listItems(query: EngineListQuery): { items: MemoryItem[]; total: number };
  history(id: string): {
    item: MemoryItem;
    versions: MemoryItemVersion[];
    events: MemoryEvent[];
    links: MemoryLink[];
    related: MemoryItem[];
    conflicts: MemoryConflict[];
  };
  listConflicts(filter?: {
    status?: "open" | "resolved" | undefined;
    scope?: MemoryScopeRef | undefined;
    principalId?: string | undefined;
    limit?: number | undefined;
  }): MemoryConflict[];
  getConflict(id: string): MemoryConflict | null;
  mergeDraft(conflictId: string, llm?: MemoryLlm | null): Promise<MemoryMergeDraftResponse>;
  /** Item counts and window counts per scope key. */
  scopeCounts(principalId?: string): Map<string, MemoryScopeCounts>;

  // -- recall
  recall(request: RecallRequest): Promise<RecallResult>;

  // -- raw conversation windows
  readonly chunkSink: ChunkSink;
  listChunks(query: {
    scope?: MemoryScopeRef | undefined;
    conversationId?: string | undefined;
    /** Enterprise mode: only this member's windows. Defaults to `owner`. */
    principalId?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }): { chunks: MemoryChunk[]; total: number };
  getChunk(id: string): { chunk: MemoryChunk; neighbors: MemoryChunk[] } | null;

  // -- learning from conversations
  /** Distils a transcript and writes the result as proposals or directly, per the auto-memory mode. */
  distill(input: EngineDistillInput): Promise<RememberResult[]>;
  /** Looks for repeats and disagreements among the items of one scope (or all) and files them in the inbox. */
  tidy(scope?: MemoryScopeRef): Promise<MemoryTidyResponse>;

  // -- maintenance
  config(): MemoryEngineConfig;
  updateConfig(patch: UpdateMemoryEngineConfigRequest): MemoryEngineConfig;
  status(): MemoryEngineStatus;
  reindex(options?: { vectors?: boolean | undefined }): Promise<{ documents: number; durationMs: number }>;
  /** Download or cancel a local model; `status().localModels` reports progress. */
  localModelAction(id: string, action: "download" | "cancel"): Promise<void>;
  setLlm(llm: MemoryLlm | null): void;
  setLabeler(labelOf: (scope: MemoryScopeRef) => string | undefined): void;
  /** Resolves when background work (embedding, judging) queued so far is done. */
  flush(): Promise<void>;
  dispose(): void;
}
