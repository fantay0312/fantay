// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — shared contract for the memory engine (`/api/memory-center/*`, `od memory`).
// Pure TypeScript + Zod only (no Node, SQLite or HTTP server imports).
//
// Model in one paragraph: a memory is an item that lives in exactly one scope. Its text is stored as
// immutable versions and every state change is an appended event, so nothing is ever destroyed by the
// system. Two memories that disagree open a conflict that only a person resolves (keep new / keep old /
// merge / keep both). Raw conversation windows ("chunks") are indexed next to items and are the second
// retrieval channel.

import { z } from "zod";
import {
  paAutoMemoryModeSchema,
  paDataClassSchema,
  paMemoryOriginKindSchema,
  paMemorySourceRefSchema,
  paProfileMountSchema,
  type PaAutoMemoryMode,
  type PaDataClass,
  type PaMemoryOriginKind,
  type PaMemorySourceRef,
  type PaProfileMount,
  type PersonalAgent,
} from "./personal-agent.js";

// ---- 1. Scopes ---------------------------------------------------------------------------------------------------

/**
 * Who owns a memory.
 * - `profile`      the owner's real profile (个人画像). One per owner; `id` is the empty string.
 * - `persona`      one role-play persona of the owner (人设); `id` is the persona id.
 * - `bot`          one Personal Agent bot's private memory; `id` is the agent id.
 * - `group`        memory shared by the members of one PA group; `id` is the group id.
 * - `project`      memory shared by every conversation of one project; `id` is the project id.
 * - `conversation` memory of one conversation thread (子进程) — a project conversation or a PA conversation;
 *                  `id` is the conversation id.
 */
export const MEMORY_SCOPE_KINDS = [
  "profile",
  "persona",
  "bot",
  "group",
  "project",
  "conversation",
] as const;
export const memoryScopeKindSchema = z.enum(MEMORY_SCOPE_KINDS);
export type MemoryScopeKind = z.infer<typeof memoryScopeKindSchema>;

export const memoryScopeRefSchema = z.object({
  kind: memoryScopeKindSchema,
  id: z.string().max(200).default(""),
});
export interface MemoryScopeRef {
  kind: MemoryScopeKind;
  id: string;
}

/** Stable string form of a scope, used as an index key and in URLs: `bot:<id>`, `profile:`. */
export function memoryScopeKey(scope: MemoryScopeRef): string {
  return `${scope.kind}:${scope.kind === "profile" ? "" : scope.id}`;
}

export function parseMemoryScopeKey(key: string): MemoryScopeRef | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const kind = memoryScopeKindSchema.safeParse(key.slice(0, at));
  if (!kind.success) return null;
  const id = key.slice(at + 1);
  if (kind.data !== "profile" && !id) return null;
  return { kind: kind.data, id: kind.data === "profile" ? "" : id };
}

// ---- 2. Items ----------------------------------------------------------------------------------------------------

export const MEMORY_ITEM_KINDS = [
  "profile", // who the owner is
  "preference", // how they like things done
  "fact", // something true about the world, a project or a person
  "decision", // something that was decided, with its reason
  "procedure", // a reusable way of doing a task
  "promise", // a commitment with an optional due date
  "moment", // something that happened and is worth keeping
  "episode", // a summary of one finished task or discussion
  "rule", // a standing instruction
  "reference", // where something can be found
  "feedback", // a correction the owner gave
] as const;
export const memoryItemKindSchema = z.enum(MEMORY_ITEM_KINDS);
export type MemoryItemKind = z.infer<typeof memoryItemKindSchema>;

/**
 * - `active`     recalled.
 * - `pending`    proposed by the system and waiting for a person to accept or reject; not recalled.
 * - `superseded` a person chose another memory over this one (see `supersededBy`); kept, not recalled.
 * - `rejected`   a person turned it down (a rejected proposal, or the losing side of keep-old); kept, not recalled.
 * - `archived`   a person put it away; kept, not recalled, can be restored.
 */
export const MEMORY_ITEM_STATUSES = [
  "active",
  "pending",
  "superseded",
  "rejected",
  "archived",
] as const;
export const memoryItemStatusSchema = z.enum(MEMORY_ITEM_STATUSES);
export type MemoryItemStatus = z.infer<typeof memoryItemStatusSchema>;

/** Where a memory was learned when it was carried into another scope (group → bot write-back). */
export interface MemoryVia {
  groupId?: string | undefined;
  groupName?: string | undefined;
  conversationId?: string | undefined;
  conversationTitle?: string | undefined;
  projectId?: string | undefined;
  projectName?: string | undefined;
}
export const memoryViaSchema = z.object({
  groupId: z.string().max(200).optional(),
  groupName: z.string().max(200).optional(),
  conversationId: z.string().max(200).optional(),
  conversationTitle: z.string().max(300).optional(),
  projectId: z.string().max(200).optional(),
  projectName: z.string().max(300).optional(),
});

export interface MemoryItem {
  id: string;
  scope: MemoryScopeRef;
  /** Display name of the scope (bot name, group name, project name, conversation title). */
  scopeLabel?: string | undefined;
  kind: MemoryItemKind;
  status: MemoryItemStatus;
  origin: PaMemoryOriginKind;
  pinned: boolean;
  dataClass: PaDataClass;
  title: string;
  content: string;
  /** Human-readable origin, e.g. "手动添加" or "对话 · 小月". */
  source: string;
  sourceRefs: PaMemorySourceRef[];
  via: MemoryVia | null;
  /** `owner`, an agent id, or null when unknown. */
  authorId: string | null;
  /** When the remembered thing happened; `createdAt` is when it was recorded. */
  eventAt: number | null;
  dueAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  supersededBy: string | null;
  /** Bumps on every change; used for optimistic locking. */
  revision: number;
  /** Number of stored text versions (1 = never edited). */
  versionCount: number;
  /** Open conflicts this item is part of. */
  openConflictIds: string[];
  /** The text was cleared by the owner; the record and its history remain. */
  redacted: boolean;
  /**
   * `ledger` items live in the memory engine. `studio` items are entries of Settings → 记忆
   * (rules and profile fields); they are listed here read-only and edited in Settings.
   */
  backing: "ledger" | "studio";
  readOnly: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryItemVersion {
  version: number;
  title: string;
  content: string;
  /** `owner`, `system`, or `agent:<id>`. */
  actor: string;
  note: string;
  createdAt: number;
}

export const MEMORY_EVENT_TYPES = [
  "created",
  "imported",
  "revised",
  "pinned",
  "unpinned",
  "accepted",
  "rejected",
  "archived",
  "restored",
  "superseded",
  "reinstated",
  "redacted",
  "confirmed", // the same memory was learned again
  "copied",
  "meta_changed",
  "conflict_opened",
  "conflict_resolved",
] as const;
export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];

export interface MemoryEvent {
  seq: number;
  itemId: string | null;
  conflictId: string | null;
  type: MemoryEventType;
  actor: string;
  at: number;
  data: Record<string, unknown>;
}

export const MEMORY_LINK_RELATIONS = [
  "merged_from", // from = merged item, to = one of its two sources
  "derived_from", // from = copy or propagated item, to = its source
  "supersedes", // from = winner, to = the memory it replaced (set only by a person)
  "relates", // a person said both stand
] as const;
export type MemoryLinkRelation = (typeof MEMORY_LINK_RELATIONS)[number];

export interface MemoryLink {
  fromId: string;
  toId: string;
  relation: MemoryLinkRelation;
  createdAt: number;
}

// ---- 3. Conflicts ------------------------------------------------------------------------------------------------

/**
 * - `keep_new`  the incoming memory stays active; the existing one becomes `superseded`.
 * - `keep_old`  the existing memory stays active; the incoming one becomes `rejected`.
 * - `merge`     a new memory holding `mergedContent` is created; both sources become `superseded` by it.
 * - `keep_both` both stay active; the pair is recorded as related and is not raised again.
 */
export const MEMORY_CONFLICT_RESOLUTIONS = [
  "keep_new",
  "keep_old",
  "merge",
  "keep_both",
] as const;
export const memoryConflictResolutionSchema = z.enum(MEMORY_CONFLICT_RESOLUTIONS);
export type MemoryConflictResolution = z.infer<typeof memoryConflictResolutionSchema>;

/** `conflict` = they disagree. `duplicate` = they say the same thing and could be merged. */
export type MemoryConflictKind = "conflict" | "duplicate";

export interface MemoryConflict {
  id: string;
  kind: MemoryConflictKind;
  scope: MemoryScopeRef;
  scopeLabel?: string | undefined;
  /** The newer memory. */
  incoming: MemoryItem;
  /** The memory that was already there. */
  existing: MemoryItem;
  /** One plain sentence saying why the two were paired. */
  reason: string;
  /** `explicit` = the writer named the target, `heuristic` = built-in rules, `judge` = a model judged the pair. */
  detector: "explicit" | "heuristic" | "judge";
  confidence: number;
  /** A hint for the person deciding. It is never applied automatically. */
  suggestion: MemoryConflictResolution | null;
  status: "open" | "resolved";
  resolution: MemoryConflictResolution | null;
  mergedItemId: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export const resolveMemoryConflictSchema = z
  .object({
    resolution: memoryConflictResolutionSchema,
    mergedContent: z.string().trim().min(1).max(16000).optional(),
    mergedTitle: z.string().trim().max(200).optional(),
  })
  .refine((value) => value.resolution !== "merge" || Boolean(value.mergedContent), {
    message: "mergedContent is required when resolution is merge",
    path: ["mergedContent"],
  });
export type ResolveMemoryConflictRequest = z.input<typeof resolveMemoryConflictSchema>;

export interface ResolveMemoryConflictResponse {
  conflict: MemoryConflict;
  /** Every item whose state changed, plus the merged item when one was created. */
  items: MemoryItem[];
}

export interface MemoryConflictListResponse {
  conflicts: MemoryConflict[];
  total: number;
}

export interface MemoryMergeDraftResponse {
  /** A merged text to start from. `source` says whether a model wrote it or the two texts were joined. */
  content: string;
  source: "model" | "joined";
}

// ---- 4. Proposals waiting for a person ---------------------------------------------------------------------------

/**
 * One entry of the review inbox. `source: "item"` is an engine item with status `pending`;
 * `source: "pa_candidate"` is a Personal Agent memory candidate (`/api/pa/memory-candidates`).
 */
export interface MemoryPendingEntry {
  id: string;
  source: "item" | "pa_candidate";
  scope: MemoryScopeRef;
  scopeLabel?: string | undefined;
  kind: MemoryItemKind;
  content: string;
  /** Where it was proposed from, in plain words. */
  sourceLabel: string;
  via: MemoryVia | null;
  revision: number;
  createdAt: number;
}

export const resolveMemoryPendingSchema = z.object({
  accept: z.boolean(),
  revision: z.number().int().nonnegative().optional(),
  /** Accept with corrected text. */
  content: z.string().trim().min(1).max(16000).optional(),
  /** Accept into another scope. */
  scope: memoryScopeRefSchema.optional(),
  kind: memoryItemKindSchema.optional(),
});
export type ResolveMemoryPendingRequest = z.input<typeof resolveMemoryPendingSchema>;

export interface ResolveMemoryPendingResponse {
  entryId: string;
  accepted: boolean;
  item: MemoryItem | null;
  /** Conflicts opened by accepting it. */
  conflicts: MemoryConflict[];
}

export interface MemoryInboxResponse {
  conflicts: MemoryConflict[];
  pending: MemoryPendingEntry[];
}

// ---- 5. Item requests --------------------------------------------------------------------------------------------

export const memoryItemListQuerySchema = z.object({
  scopeKind: memoryScopeKindSchema.optional(),
  scopeId: z.string().max(200).optional(),
  /** Defaults to `active`. `all` lists every status. */
  status: z.union([memoryItemStatusSchema, z.literal("all")]).optional(),
  kind: memoryItemKindSchema.optional(),
  pinned: z.boolean().optional(),
  /** Only items carried in from a group (group → bot write-back). */
  viaGroup: z.boolean().optional(),
  query: z.string().max(1000).optional(),
  /** Include read-only Settings entries (`backing: "studio"`). Default true. */
  includeStudio: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type MemoryItemListQuery = z.infer<typeof memoryItemListQuerySchema>;

export interface MemoryItemListResponse {
  items: MemoryItem[];
  total: number;
}

export const createMemoryItemSchema = z.object({
  scope: memoryScopeRefSchema,
  content: z.string().trim().min(1).max(16000),
  title: z.string().trim().max(200).optional(),
  kind: memoryItemKindSchema.optional(),
  pinned: z.boolean().optional(),
  dataClass: paDataClassSchema.optional(),
  origin: paMemoryOriginKindSchema.optional(),
  source: z.string().trim().max(500).optional(),
  sourceRefs: z.array(paMemorySourceRefSchema).max(32).optional(),
  via: memoryViaSchema.optional(),
  eventAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  dueAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  validFrom: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  validUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});
export type CreateMemoryItemRequest = z.input<typeof createMemoryItemSchema>;

export interface CreateMemoryItemResponse {
  item: MemoryItem;
  /** False when the same text already existed in that scope; the existing item is returned. */
  created: boolean;
  conflicts: MemoryConflict[];
}

/**
 * Editing never changes scope. New `content` or `title` is stored as a new version; the earlier text stays in
 * the history. The other fields change in place and are recorded as events.
 */
export const updateMemoryItemSchema = z.object({
  content: z.string().trim().min(1).max(16000).optional(),
  title: z.string().trim().max(200).optional(),
  kind: memoryItemKindSchema.optional(),
  pinned: z.boolean().optional(),
  dueAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  validFrom: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  validUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  note: z.string().trim().max(300).optional(),
  revision: z.number().int().nonnegative().optional(),
});
export type UpdateMemoryItemRequest = z.input<typeof updateMemoryItemSchema>;

export interface MemoryItemResponse {
  item: MemoryItem;
}

export interface UpdateMemoryItemResponse {
  item: MemoryItem;
  conflicts: MemoryConflict[];
}

export interface MemoryItemHistoryResponse {
  item: MemoryItem;
  /** Oldest first. */
  versions: MemoryItemVersion[];
  /** Oldest first. */
  events: MemoryEvent[];
  links: MemoryLink[];
  /** Items named by `links` and `supersededBy`. */
  related: MemoryItem[];
  conflicts: MemoryConflict[];
}

/** `archive` and `restore` are the only "remove" operations; nothing deletes a memory. */
export const memoryItemActionSchema = z.object({
  action: z.enum(["archive", "restore", "redact"]),
  revision: z.number().int().nonnegative().optional(),
  /** Required and true for `redact`, which clears the text and cannot be undone. */
  confirm: z.boolean().optional(),
});
export type MemoryItemActionRequest = z.input<typeof memoryItemActionSchema>;

/** Copies a memory into another scope. The source is untouched and the copy records where it came from. */
export const copyMemoryItemSchema = z.object({
  scope: memoryScopeRefSchema,
  title: z.string().trim().max(200).optional(),
});
export type CopyMemoryItemRequest = z.input<typeof copyMemoryItemSchema>;

// ---- 6. Raw conversation windows ---------------------------------------------------------------------------------

export interface MemoryChunk {
  id: string;
  /** `pa` = a Personal Agent conversation, `studio` = a project conversation. */
  source: "pa" | "studio";
  conversationId: string;
  conversationTitle?: string | undefined;
  seq: number;
  content: string;
  /** Scopes that may read this window. */
  scopes: MemoryScopeRef[];
  speakers: string[];
  messageIds: string[];
  startAt: number;
  endAt: number;
  dataClass: PaDataClass;
}

export const memoryChunkListQuerySchema = z.object({
  scopeKind: memoryScopeKindSchema.optional(),
  scopeId: z.string().max(200).optional(),
  conversationId: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type MemoryChunkListQuery = z.infer<typeof memoryChunkListQuerySchema>;

export interface MemoryChunkListResponse {
  chunks: MemoryChunk[];
  total: number;
}

export interface MemoryChunkDetailResponse {
  chunk: MemoryChunk;
  /** The windows right before and after it in the same conversation. */
  neighbors: MemoryChunk[];
}

// ---- 7. Recall ---------------------------------------------------------------------------------------------------

/**
 * Describes the turn that is asking, so the engine can work out which scopes it may read.
 * `surface: "studio"` is a project conversation; `surface: "pa"` is a Personal Agent turn.
 */
export const memoryRecallContextSchema = z.object({
  surface: z.enum(["studio", "pa"]),
  projectId: z.string().max(200).nullable().optional(),
  conversationId: z.string().max(200).nullable().optional(),
  agentId: z.string().max(200).nullable().optional(),
  groupId: z.string().max(200).nullable().optional(),
});
export type MemoryRecallContext = z.infer<typeof memoryRecallContextSchema>;

export const memoryRecallSchema = z
  .object({
    query: z.string().trim().min(1).max(8000),
    /** Recall as that turn would. */
    context: memoryRecallContextSchema.optional(),
    /** Or search these scopes directly (the Memory Center's search box). */
    scopes: z.array(memoryScopeRefSchema).min(1).max(32).optional(),
    limit: z.number().int().min(1).max(40).optional(),
    budgetChars: z.number().int().min(200).max(40000).optional(),
    includeChunks: z.boolean().optional(),
  })
  .refine((value) => Boolean(value.context) || Boolean(value.scopes), {
    message: "context or scopes is required",
  });
export type MemoryRecallRequest = z.input<typeof memoryRecallSchema>;

/** `lexical` = full-text only, `hybrid` = full-text + vectors, `hybrid_rerank` = plus a reranking model. */
export type MemoryEngineLevel = "lexical" | "hybrid" | "hybrid_rerank";

export interface MemoryRecallHit {
  /** Item id or chunk id. */
  id: string;
  docKind: "item" | "chunk";
  scope: MemoryScopeRef;
  scopeLabel?: string | undefined;
  title: string;
  /** The text handed to the model for this hit. */
  content: string;
  /** Final score in 0..1. */
  score: number;
  /** 1-based rank in each channel that found it. */
  ranks: {
    lexical?: number | undefined;
    literal?: number | undefined;
    vector?: number | undefined;
    fused: number;
    rerank?: number | undefined;
  };
  /** Short plain reasons, e.g. "关键词匹配", "语义相近", "同一对话". */
  why: string[];
  /** The hit is part of an open conflict. */
  inConflict: boolean;
  /**
   * True for a "possibly related" hit: the closest match to a question that no memory clearly answered. It is
   * handed to the model in a section of its own, marked as uncertain.
   */
  possible?: boolean | undefined;
  eventAt: number | null;
  item?: MemoryItem | undefined;
  chunk?: MemoryChunk | undefined;
}

export interface MemoryRecallResponse {
  query: string;
  /** Scopes that were searched. */
  scopes: Array<MemoryScopeRef & { label?: string | undefined }>;
  /** Always-included memories (pinned items of the readable scopes), within their own budget. */
  standing: MemoryItem[];
  hits: MemoryRecallHit[];
  /** The exact text that is (or would be) placed into the prompt. Empty when nothing is relevant. */
  promptBlock: string;
  usedChars: number;
  budgetChars: number;
  level: MemoryEngineLevel;
  latencyMs: { total: number; lexical: number; vector: number; rerank: number };
}

// ---- 8. Overview -------------------------------------------------------------------------------------------------

export interface MemoryScopeCounts {
  active: number;
  pending: number;
  conflicts: number;
  archived: number;
  /** Raw conversation windows readable by this scope. */
  chunks: number;
}

export interface MemoryAgentPolicyView {
  profileMount?: PaProfileMount | undefined;
  autoMemoryMode?: PaAutoMemoryMode | undefined;
  effectiveProfileMount: PaProfileMount;
  effectiveAutoMemoryMode: PaAutoMemoryMode;
}

export interface MemoryScopeNode {
  scope: MemoryScopeRef;
  label: string;
  sublabel?: string | undefined;
  avatar?: string | undefined;
  counts: MemoryScopeCounts;
  /** bot: its memory policy and whether it is a character card. */
  policy?: MemoryAgentPolicyView | undefined;
  isCharacter?: boolean | undefined;
  /** group: member bot ids and names. */
  members?: Array<{ id: string; name: string }> | undefined;
  /** persona: whether it is the default one. */
  isDefault?: boolean | undefined;
  /** project: its conversations. */
  children?: MemoryScopeNode[] | undefined;
  updatedAt?: number | undefined;
}

export interface MemoryOverviewResponse {
  enabled: boolean;
  mode: "personal" | "enterprise";
  profile: MemoryScopeNode;
  personas: MemoryScopeNode[];
  bots: MemoryScopeNode[];
  groups: MemoryScopeNode[];
  projects: MemoryScopeNode[];
  inbox: { conflicts: number; pending: number };
  totals: { items: number; chunks: number };
  engine: MemoryEngineStatus;
}

// ---- 9. Engine configuration and status --------------------------------------------------------------------------

/** How memories distilled from conversations are written: not at all, as proposals, or directly. */
export const memoryAutoModeSchema = z.enum(["off", "review", "auto"]);
export type MemoryAutoMode = z.infer<typeof memoryAutoModeSchema>;

/** `local` runs a downloaded model on this machine; nothing leaves it. */
export const memoryEmbeddingProviderSchema = z.enum(["off", "local", "ollama", "openai_compatible"]);
export type MemoryEmbeddingProviderKind = z.infer<typeof memoryEmbeddingProviderSchema>;
export const memoryRerankProviderSchema = z.enum(["builtin", "local", "http"]);
export type MemoryRerankProviderKind = z.infer<typeof memoryRerankProviderSchema>;
export const memoryJudgeProviderSchema = z.enum(["heuristic", "jev", "llm"]);
export type MemoryJudgeProviderKind = z.infer<typeof memoryJudgeProviderSchema>;

export interface MemoryEngineConfig {
  autoMemory: MemoryAutoMode;
  embedding: {
    provider: MemoryEmbeddingProviderKind;
    baseUrl: string;
    model: string;
    /** 0 = use the model's native size. */
    dimensions: number;
    hasApiKey: boolean;
  };
  reranker: {
    provider: MemoryRerankProviderKind;
    url: string;
    model: string;
    hasApiKey: boolean;
  };
  /** Decides whether two memories conflict or repeat each other. */
  judge: {
    provider: MemoryJudgeProviderKind;
    apiUrl: string;
    model: string;
    hasApiKey: boolean;
  };
  recall: {
    /** Most hits placed into one prompt. */
    maxHits: number;
    /** Characters of memory placed into one prompt. */
    budgetChars: number;
    /** Hits scoring below this are dropped, even if that leaves nothing. */
    minScore: number;
  };
}

export const MEMORY_ENGINE_DEFAULTS: MemoryEngineConfig = {
  autoMemory: "auto",
  embedding: { provider: "off", baseUrl: "", model: "", dimensions: 0, hasApiKey: false },
  reranker: { provider: "builtin", url: "", model: "", hasApiKey: false },
  judge: { provider: "heuristic", apiUrl: "", model: "", hasApiKey: false },
  recall: { maxHits: 12, budgetChars: 6000, minScore: 0.18 },
};

/** `apiKey: ""` clears a stored key; leaving it out keeps it. Keys are never returned. */
export const updateMemoryEngineConfigSchema = z.object({
  autoMemory: memoryAutoModeSchema.optional(),
  embedding: z
    .object({
      provider: memoryEmbeddingProviderSchema.optional(),
      baseUrl: z.string().trim().max(500).optional(),
      model: z.string().trim().max(200).optional(),
      dimensions: z.number().int().min(0).max(4096).optional(),
      apiKey: z.string().max(500).optional(),
    })
    .optional(),
  reranker: z
    .object({
      provider: memoryRerankProviderSchema.optional(),
      url: z.string().trim().max(500).optional(),
      model: z.string().trim().max(200).optional(),
      apiKey: z.string().max(500).optional(),
    })
    .optional(),
  judge: z
    .object({
      provider: memoryJudgeProviderSchema.optional(),
      apiUrl: z.string().trim().max(500).optional(),
      model: z.string().trim().max(200).optional(),
      apiKey: z.string().max(500).optional(),
    })
    .optional(),
  recall: z
    .object({
      maxHits: z.number().int().min(1).max(40).optional(),
      budgetChars: z.number().int().min(500).max(40000).optional(),
      minScore: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type UpdateMemoryEngineConfigRequest = z.input<typeof updateMemoryEngineConfigSchema>;

export interface MemoryProviderState {
  /** Provider id as configured, or `builtin` / `heuristic` / `off`. */
  provider: string;
  model: string;
  ready: boolean;
  /** Last failure in plain words; null when working or never tried. */
  error: string | null;
}

/** A model that can be downloaded once and then runs on this machine. */
export interface MemoryLocalModel {
  id: string;
  role: "embedding" | "reranker";
  /** Display name, e.g. "Qwen3 Embedding 0.6B". */
  name: string;
  sizeBytes: number;
  license: string;
  state: "absent" | "downloading" | "ready" | "failed";
  /** 0..1 while downloading. */
  progress: number;
  error: string | null;
}

export const memoryLocalModelActionSchema = z.object({
  action: z.enum(["download", "cancel"]),
});
export type MemoryLocalModelActionRequest = z.input<typeof memoryLocalModelActionSchema>;

export interface MemoryEngineStatus {
  level: MemoryEngineLevel;
  /** False when this build cannot run local models (the runtime is missing); the UI then hides the option. */
  localRuntime: boolean;
  localModels: MemoryLocalModel[];
  embedding: MemoryProviderState & { indexed: number; waiting: number };
  reranker: MemoryProviderState;
  judge: MemoryProviderState;
  /** Searchable documents (items + windows). */
  documents: number;
  lastIndexedAt: number | null;
  /** Median and 95th-percentile recall time over recent recalls, in ms; null until there are samples. */
  recallLatencyMs: { p50: number; p95: number; samples: number } | null;
}

export interface MemoryEngineResponse {
  config: MemoryEngineConfig;
  status: MemoryEngineStatus;
}

export const memoryReindexSchema = z.object({
  /** Also recompute vectors. */
  vectors: z.boolean().optional(),
});
export type MemoryReindexRequest = z.input<typeof memoryReindexSchema>;

export interface MemoryReindexResponse {
  ok: true;
  documents: number;
  durationMs: number;
}

/** Tidy one scope (or all): look for repeats and disagreements, and distil what was not distilled yet. */
export const memoryTidySchema = z.object({
  scope: memoryScopeRefSchema.optional(),
});
export type MemoryTidyRequest = z.input<typeof memoryTidySchema>;

export interface MemoryTidyResponse {
  ok: true;
  scannedItems: number;
  /** New conflicts and duplicate pairs placed in the inbox. */
  conflictsOpened: number;
  /** Memories newly distilled from conversations (as proposals or directly, per the auto-memory mode). */
  itemsProposed: number;
  durationMs: number;
}

// ---- 10. Bot policy ----------------------------------------------------------------------------------------------

export const updateAgentMemoryPolicySchema = z.object({
  profileMount: paProfileMountSchema.optional(),
  autoMemoryMode: paAutoMemoryModeSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
});
export type UpdateAgentMemoryPolicyRequest = z.input<typeof updateAgentMemoryPolicySchema>;

export interface UpdateAgentMemoryPolicyResponse {
  agent: PersonalAgent;
  node: MemoryScopeNode;
}
