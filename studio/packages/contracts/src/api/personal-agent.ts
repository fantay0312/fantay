import { z } from "zod";

export const paModelSchema = z.object({
  // Local runtime IDs also include user-defined agent profiles.
  runtime: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  modelId: z.string().trim().min(1).max(200),
});
export const paAgentInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().min(1).max(4000),
  avatar: z.string().max(12).default("PA"),
  model: paModelSchema,
  enabled: z.boolean().default(true),
  tools: z.array(z.enum(["respond", "create_project"])).default(["respond"]),
});
export const paGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  memberIds: z.array(z.string().min(1)).min(1).max(12),
  moderatorId: z.string().min(1),
  reviewerId: z.string().min(1).nullable().optional(),
  mode: z.enum(["discussion", "collaboration", "review"]).default("discussion"),
});
export const paDataClassSchema = z.enum(["standard", "local_only"]);
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
  kind: z.enum(["discussion", "project"]).default("discussion"),
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
export const paMemoryInputSchema = z.object({
  content: z.string().trim().min(1).max(16000),
  source: z.string().trim().min(1).max(500),
  scope: z.enum(["private", "agent", "group", "project"]),
  scopeId: z.string().max(100).nullable().default(null),
  kind: z.enum(["preference", "fact", "procedure"]).optional(),
  validFrom: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  validUntil: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  dataClass: paDataClassSchema.optional(),
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
  memoryRefs?: Array<{ id: string; revision: number }>;
  dataClass?: PaDataClass;
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
  kind: "discussion" | "project";
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
  memoryRefs?: Array<{ id: string; revision: number }>;
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
  principalId?: string;
}
export interface PaMemoryCandidate extends PaEntity {
  taskId: string;
  attemptId: string;
  content: string;
  dataClass: PaDataClass;
  status: "pending" | "accepted" | "dismissed";
  memoryId?: string;
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
  execution?: { localSandbox: boolean; remoteWorker: boolean };
}
