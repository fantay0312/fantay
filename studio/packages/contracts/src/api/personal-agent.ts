import { z } from "zod";
import type { PaMessageSoul, PaTaskSoul } from "./personal-agent-soul.js";

export const paModelSchema = z.object({
  // Local runtime IDs also include user-defined agent profiles.
  runtime: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  modelId: z.string().trim().min(1).max(200),
});
export const paProfileMountSchema = z.enum(["owner_profile", "persona_only", "none"]);
export type PaProfileMount = z.infer<typeof paProfileMountSchema>;
export const paAutoMemoryModeSchema = z.enum(["off", "candidate", "explicit_auto"]);
export type PaAutoMemoryMode = z.infer<typeof paAutoMemoryModeSchema>;
export const paAgentMemoryPolicySchema = z.object({
  profileMount: paProfileMountSchema.optional(),
  autoMemoryMode: paAutoMemoryModeSchema.optional(),
});
export type PaAgentMemoryPolicy = z.infer<typeof paAgentMemoryPolicySchema>;

export const paAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().min(1).max(4000),
  avatar: z.string().max(12).default("PA"),
  model: paModelSchema,
  enabled: z.boolean().default(true),
  tools: z.array(z.enum(["respond", "create_project"])).default(["respond"]),
  memoryPolicy: paAgentMemoryPolicySchema.optional(),
});
export const paGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(z.string().min(1)).min(1).max(12),
  moderatorId: z.string().min(1),
  reviewerId: z.string().min(1).nullable().optional(),
  mode: z.enum(["discussion", "collaboration", "review"]).default("discussion"),
});
export const paDataClassSchema = z.enum(["standard", "local_only"]);
export interface PaViewCard {
  title: string;
  view: Record<string, unknown>;
  interactive: boolean;
  summary: string;
}
export interface PaViewAnswer { action: string; values: Record<string, unknown> }
export const paTaskCardAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("question"), attemptId: z.string().min(1).max(100), choices: z.array(z.number().int().min(1).max(5)).min(1).max(5) }).strict(),
  z.object({ kind: z.literal("view"), attemptId: z.string().min(1).max(100), action: z.string().min(1).max(100), values: z.record(z.string(), z.unknown()) }).strict(),
]);
export type PaTaskCardAnswer = z.infer<typeof paTaskCardAnswerSchema>;
export type PaDataClass = z.infer<typeof paDataClassSchema>;
export const paExecutionSchema = z.object({
  target: z.enum(["local", "worker"]),
  script: z.string().min(1).max(64000).optional(),
  generateScript: z.literal(true).optional(),
  gatewayModel: z.string().min(1).max(200).optional(),
}).strict();
export type PaExecution = z.infer<typeof paExecutionSchema>;
export const paTaskInputSchema = z.object({
  requestId: z.string().min(8).max(100),
  conversationId: z.string().min(1),
  goal: z.string().trim().min(1).max(32000),
  completionCriteria: z.array(z.string().trim().min(1).max(1000)).max(8).optional(),
  dataClass: paDataClassSchema.optional(),
  execution: paExecutionSchema.optional(),
  targetAgentIds: z.array(z.string().min(1)).max(12).default([]),
  replyTo: z.string().optional(),
  kind: z.enum(["discussion", "project", "chat", "team"]).default("discussion"),
  projectName: z.string().trim().min(1).max(120).optional(),
  projectId: z.string().min(1).max(100).optional(),
  budget: z
    .object({
      maxAttempts: z.number().int().min(1).max(12),
      timeoutMs: z.number().int().min(1000).max(1800000),
      maxCostUsd: z.number().min(0).max(30).optional(),
    })
    .default({ maxAttempts: 6, timeoutMs: 300000 }),
});
export const paMemoryKindSchema = z.enum([
  "profile",
  "preference",
  "fact",
  "procedure",
  "promise",
  "moment",
]);
export type PaMemoryKind = z.infer<typeof paMemoryKindSchema>;
export const paMemoryOriginKindSchema = z.enum([
  "user_explicit",
  "tool_verified",
  "llm_inferred",
  "imported",
]);
export type PaMemoryOriginKind = z.infer<typeof paMemoryOriginKindSchema>;
export const paMemoryStatusSchema = z.enum([
  "active",
  "superseded",
  "challenged",
  "archived",
]);
export type PaMemoryStatus = z.infer<typeof paMemoryStatusSchema>;
export const paMemoryRelationSchema = z.enum([
  "supersedes",
  "enriches",
  "challenges",
]);
export type PaMemoryRelation = z.infer<typeof paMemoryRelationSchema>;
export const paMemoryEvolutionSchema = z.object({
  targetId: z.string().min(1).max(100),
  relation: paMemoryRelationSchema,
});
export type PaMemoryEvolution = z.infer<typeof paMemoryEvolutionSchema>;
export const paMemorySourceRefKindSchema = z.enum([
  "message",
  "task",
  "attempt",
  "studio_memory",
  "raw_chunk",
  "pa_memory",
]);
export type PaMemorySourceRefKind = z.infer<typeof paMemorySourceRefKindSchema>;
export const paMemorySourceRefSchema = z.object({
  kind: paMemorySourceRefKindSchema,
  id: z.string().min(1).max(200),
  conversationId: z.string().max(100).optional(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  quote: z.string().max(2000).optional(),
});
export type PaMemorySourceRef = z.infer<typeof paMemorySourceRefSchema>;

export const paMemoryInputSchema = z.object({
  content: z.string().trim().min(1).max(16000),
  source: z.string().trim().min(1).max(500),
  scope: z.enum(["private", "agent", "group", "project"]),
  scopeId: z.string().max(100).nullable().default(null),
  kind: paMemoryKindSchema.optional(),
  originKind: paMemoryOriginKindSchema.optional(),
  pinned: z.boolean().optional(),
  status: paMemoryStatusSchema.optional(),
  evolves: paMemoryEvolutionSchema.nullable().optional(),
  sourceRefs: z.array(paMemorySourceRefSchema).max(32).optional(),
  validFrom: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  validUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  dataClass: paDataClassSchema.optional(),
  dueAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  sourceMessageId: z.string().max(100).nullable().optional(),
});
export type PaModel = z.infer<typeof paModelSchema>;
export function isPaLocalCliModel(model: PaModel): boolean {
  return !["ollama", "tokentosea", "managed"].includes(model.runtime);
}
export type PaAgentInput = z.infer<typeof paAgentInputSchema>;
export type PaGroupInput = z.infer<typeof paGroupInputSchema>;
export type PaTaskInput = z.infer<typeof paTaskInputSchema>;
export type PaMemoryInput = z.infer<typeof paMemoryInputSchema>;
export const paGoalInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(4000),
  taskIds: z.array(z.string().min(1).max(100)).max(100),
}).strict();
export const paRoutineInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(32000),
  conversationId: z.string().min(1).max(100),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
  enabled: z.boolean().default(false),
  soul: z.object({ kind: z.literal("reachout") }).strict().optional(),
}).strict();
export type PaGoalInput = z.infer<typeof paGoalInputSchema>;
export type PaRoutineInput = z.infer<typeof paRoutineInputSchema>;
export interface PaEntity {
  id: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}
export interface PersonalAgent extends PaEntity, PaAgentInput {}
export interface PaGoal extends PaEntity, PaGoalInput {}
export interface PaRoutine extends PaEntity, PaRoutineInput {
  nextRunAt: number | null;
  lastTaskId: string | null;
  lastError: string | null;
}
export const paFeedKinds = ['task.accepted', 'task.completed', 'task.interrupted', 'task.recovery_required', 'task.cancel_requested', 'channel.send_unconfirmed'] as const;
export interface PaFeedItem {
  sequence: number;
  taskId: string | null;
  kind: typeof paFeedKinds[number];
  at: number;
}
export interface PaGroup extends PaEntity, PaGroupInput {
  conversationId: string;
}
export interface PaConversation extends PaEntity {
  channelId?: string;
  externalThreadId?: string;
  allowSharedMemory?: boolean;
  allowProject?: boolean;
  title: string;
  agentId: string | null;
  groupId: string | null;
  /** Enterprise mode: the member this conversation belongs to. A conversation without one is a shared work room. */
  principalId?: string;
}
/**
 * A memory a turn read, with the revision it read. `standing` marks one that was in the prompt only because it is
 * pinned (always included), not because it was recalled for this request.
 */
export interface PaMemoryRef {
  id: string;
  revision: number;
  standing?: boolean;
}

export interface PaMessage extends PaEntity {
  conversationId: string;
  taskId: string | null;
  senderId: string;
  routineId?: string;
  content: string;
  targetAgentIds: string[];
  replyTo: string | null;
  model?: PaModel;
  attemptId?: string;
  memoryRefs?: PaMemoryRef[];
  dataClass?: PaDataClass;
  soul?: PaMessageSoul;
  viewCard?: PaViewCard;
  viewAnswer?: PaViewAnswer;
}
export type PaPrincipal =
  | { kind: "owner"; id: "owner" }
  | { kind: "enterprise"; id: string; tenantId: string; grantVersion: number; expiresAt: number }
  | { kind: "device"; id: string }
  | { kind: "routine"; id: string }
  | { kind: "channel"; id: string; accountId: string; subjectId: string; threadId: string; authorizationVersion: number };
export type PaTaskStatus =
  | "queued"
  | "running"
  | "waiting"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";
export interface PaTask extends PaEntity {
  routineId?: string;
  channelId?: string;
  channelAuthorizationVersion?: number;
  waitKind?: 'input' | 'approval' | 'external_result' | 'device' | 'agent' | 'login' | 'budget' | 'recovery' | 'paused' | 'network' | 'verification' | undefined;
  channelQuestion?: { attemptId: string; prompt: string; options: string[]; multiple: boolean; askedAt: number } | undefined;
  pendingView?: (PaViewCard & { attemptId: string }) | undefined;
  waitingSince?: number | undefined;
  expiresAt?: number | undefined;
  timeBudgetExhausted?: boolean;
  requestFingerprint?: string;
  stopConfirmation?: "pending" | "confirmed" | "unknown";
  reviewRequired?: boolean;
  requestId: string;
  conversationId: string;
  goal: string;
  completionCriteria?: string[];
  dataClass?: PaDataClass;
  execution?: PaExecution;
  principal?: PaPrincipal;
  kind: PaTaskInput["kind"];
  soul?: PaTaskSoul;
  projectName: string;
  projectId: string | null;
  projectConversationId: string | null;
  status: PaTaskStatus;
  waitingReason: string | null;
  error: string | null;
  participantIds: string[];
  nextParticipant: number;
  budget: PaTaskInput["budget"];
  authorization: {
    approvalId?: string;
    localProject: boolean;
    externalWrites: false;
    version: number;
    revoked: boolean;
    providerAccountId?: string;
  };
  amendments: Array<{
    revision: number;
    content: string;
    receivedAt: number;
    appliedAt: number | null;
  }>;
  evidence: string[];
}
export interface PaAttempt extends PaEntity {
  taskId: string;
  runId: string;
  nodeId: string;
  protocolVersion: 1;
  agentSnapshot: PersonalAgent;
  phase: "respond" | "produce" | "review";
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  taskRevision: number;
  startedAt: number;
  endedAt: number | null;
  durationMs?: number;
  output: string;
  error: string | null;
  resolvedModel?: string | undefined;
  dataClass?: PaDataClass;
  authority?: {
    principal: PaPrincipal;
    agentId: string;
    authorizationVersion: number;
    participantIndex: number;
    capabilities: Array<PersonalAgent["tools"][number] | "sandbox_exec">;
  };
  contextRefs?: Array<{ kind: "message" | "attempt"; id: string; digest: string; bytes: number }>;
  evidenceAttemptId?: string;
  reservedCostUsd?: number;
  modelReceipt?: { outputSha256: string; receivedAt: number } | undefined;
  workerReceipt?: { workerId: string; generation: number; workHash: string };
  sandboxPlan?: { script: string; sha256: string; receivedAt: number };
  memoryRefs?: PaMemoryRef[];
  usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    costUsd?: string | undefined;
    visibility: "reported" | "unknown";
  };
}
export function paRemainingTime(task: PaTask, attempts: readonly PaAttempt[]): number {
  // Older records stored the timeout only as an error message.
  const timedOut = /^(?:本次执行达到时间上限|本任务累计执行时间已达到上限)/;
  if (task.timeBudgetExhausted || timedOut.test(task.error ?? '') || timedOut.test(task.waitingReason ?? '') ||
      attempts.some(attempt => timedOut.test(attempt.error ?? ''))) return 0;
  return task.budget.timeoutMs - attempts.reduce((sum, attempt) =>
    sum + Math.max(0, attempt.durationMs ?? (attempt.endedAt ?? attempt.startedAt) - attempt.startedAt), 0);
}

export interface PaArtifact extends PaEntity {
  taskId: string;
  attemptId: string;
  projectId: string;
  path: string;
  sha256: string;
  bytes: number;
  verification: string[];
  artifactKey?: string;
  baseVersionId?: string | null;
  dataClass?: PaDataClass;
  mergedFrom?: [string, string];
  privateStorage?: boolean;
}
export const paArtifactMergeSchema = z.object({
  leftVersionId: z.string().min(1).max(100),
  rightVersionId: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  content: z.string().min(1).max(500000).refine(value => Boolean(value.trim())),
}).strict();
export type PaArtifactMerge = z.infer<typeof paArtifactMergeSchema>;
export interface PaMemory extends PaEntity, PaMemoryInput {
  principalId?: string | undefined;
}
export interface PaMemoryCandidate extends PaEntity {
  taskId: string;
  attemptId: string;
  content: string;
  dataClass: PaDataClass;
  status: "pending" | "accepted" | "dismissed";
  memoryId?: string | undefined;
  kind?: PaMemoryKind | undefined;
  originKind?: PaMemoryOriginKind | undefined;
  targetScope?: PaMemoryInput["scope"] | undefined;
  targetScopeId?: string | null | undefined;
  evolves?: PaMemoryEvolution | null | undefined;
  conflictMemoryId?: string | undefined;
  dueAt?: number | null | undefined;
  sourceMessageId?: string | undefined;
  agentId?: string | undefined;
  conversationId?: string | undefined;
}
export interface PaEpisode extends PaEntity {
  taskId: string;
  conversationId: string;
  agentId: string | null;
  projectId: string | null;
  groupId: string | null;
  channelId?: string | null | undefined;
  principalId?: string | undefined;
  dataClass: PaDataClass;
  summary: string;
  outcome: "completed" | "failed" | "cancelled";
  artifactIds: string[];
  memoryRefs: PaMemoryRef[];
  eventStartAt: number;
  eventEndAt: number;
}
export interface PaNode {
  id: string;
  protocolVersion: 1;
  location: "local" | "cloud";
  available: boolean;
  capabilities: string[];
  heartbeatAt: number;
}
/** Transport-independent boundary; cloud nodes must implement the same fenced lease protocol. */
export interface PaExecutionLease {
  protocolVersion: 1;
  taskId: string;
  attemptId: string;
  nodeId: string;
  generation: number;
  workspaceRef: string | null;
  credentialRef: string | null;
  idempotencyKey: string;
}
export interface PaNodeEvent {
  lease: PaExecutionLease;
  eventId: string;
  kind: "heartbeat" | "progress" | "result" | "cancelled";
  at: number;
}
export interface PaExecutor {
  capabilities(): PaNode | Promise<PaNode>;
  claim(
    lease: PaExecutionLease,
    capability?: string,
  ): boolean | Promise<boolean>;
  heartbeat(lease: PaExecutionLease): boolean | Promise<boolean>;
  cancel(
    lease: PaExecutionLease,
  ): { confirmed: boolean } | Promise<{ confirmed: boolean }>;
}
export interface PaModelOption extends PaModel {
  label: string;
  available: boolean;
  detail?: string;
}
export interface PaSnapshotMember { id: string; role: "admin" | "operator" | "viewer"; canManageLibrary: boolean }
/** Enterprise mode following an organization server: what was last taken from it. `count` is the members recognised
 *  (directory) or the library items in use (library); `error` is that part's last failure, null once it worked. */
export interface PaOrgLinkStatus {
  url: string;
  /** The organization's companion switches as last received: chats on or off, per-member character memory, personas. */
  companion: { enabled: boolean; memory: boolean; personas: boolean };
  directory: { version: number; syncedAt: number | null; count: number; error: string | null };
  library: { version: number; syncedAt: number | null; count: number; error: string | null };
}
export interface PaSnapshot {
  agents: PersonalAgent[];
  groups: PaGroup[];
  conversations: PaConversation[];
  messages: PaMessage[];
  tasks: PaTask[];
  attempts: PaAttempt[];
  artifacts: PaArtifact[];
  memories: PaMemory[];
  memoryCandidates?: PaMemoryCandidate[];
  goals?: PaGoal[];
  routines?: PaRoutine[];
  node: PaNode;
  mode?: "personal" | "enterprise";
  /** Enterprise mode: who this snapshot was filtered for. `canManageLibrary` gates agents, group chats, characters,
   *  world books and style presets; everyone else reads them and owns only their conversations, personas and memories. */
  member?: PaSnapshotMember;
  /** Present when the daemon follows an organization server: the library is then changed only on that server. */
  org?: PaOrgLinkStatus;
  execution?: { localSandbox: boolean; remoteWorker: boolean };
  soulVersion?: string;
  tag?: string;
}
