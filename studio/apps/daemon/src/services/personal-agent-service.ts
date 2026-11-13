import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AsyncResource } from "node:async_hooks";
import type {
  PaAgentInput,
  PaArtifact,
  PaArtifactMerge,
  PaAttempt,
  PaConversation,
  PaExecutionLease,
  PaGroup,
  PaGroupInput,
  PaGoal,
  PaGoalInput,
  PaRoutine,
  PaRoutineInput,
  PaMemory,
  PaMemoryCandidate,
  PaMemoryInput,
  PaMessage,
  PaPrincipal,
  PaSnapshot,
  PaTask,
  PaTaskInput,
  PersonalAgent,
} from "@open-design/contracts";
import {
  getProject,
  getWorkspaceProjectByProjectId,
  listProjects,
  insertConversation,
  insertProject,
  updateProject,
  type SqliteDb,
} from "../db.js";
import { ensureProject } from "../projects.js";
import { PaError, PaStore } from "../storage/personal-agent-store.js";
import type { PaModelResult, PaModelRuntime } from "../runtimes/personal-agent.js";
import { composePaPrompt } from "../prompts/personal-agent.js";
import { PaLocalNode } from "./personal-agent-node.js";
import { summarizePaOutput } from './personal-agent-output.js';
import type { PaControl, PaControlPatch, PaOutputPage, PaChannel, PaProjectApproval } from '@open-design/contracts';
import { isPaLocalCliModel, paRemainingTime } from '@open-design/contracts';
import { isValidTimezone, nextRunAtForSchedule } from '../routines.js';
import { parsePaJson, preparePaArtifactMerge, preparePaArtifacts, readVerifiedPaArtifact } from "./personal-agent-artifacts.js";
import { PaGateway, paRouteAllows } from "./personal-agent-gateway.js";
import { paCanReadClass, paMemoryActive, preparePaHistory, selectPaMemories } from "./personal-agent-context.js";
import { PA_DETACH, type WorkerWork } from "./pa/distributed.js";
import type { PaKernel } from "./pa/kernel.js";

const terminal = new Set(["completed", "failed", "cancelled"]);
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const modelKey = (agent: PersonalAgent) =>
  `${agent.model.runtime}/${agent.model.modelId}`;
type StoredPaMemory = PaMemory & { fileName?: string };
type PaMemoryVersion = StoredPaMemory & { memoryId: string; sourceRevision: number };
const hasSandbox = (task: { execution?: PaTask["execution"] }) => Boolean(task.execution?.script || task.execution?.generateScript);
export { parsePaJson } from "./personal-agent-artifacts.js";

export class PersonalAgentService {
  readonly store: PaStore;
  readonly node: PaLocalNode;
  private readonly gateway: PaGateway;
  get kernel(): PaKernel | undefined { return this.deps.kernel; }
  get dataDirectory(): string { return this.deps.dataDir; }
  private active = new Map<
    string,
    { abort: AbortController; done: Promise<void>; pauseRequestedAt?: number }
  >();
  private queue = new Map<string, () => void>();
  private stopping = false;
  private suspended = false;
  private maintenance: ReturnType<typeof setInterval> | undefined;
  constructor(
    private deps: {
      db: SqliteDb;
      dataDir: string;
      projectsDir: string;
      runtime: PaModelRuntime;
      kernel?: PaKernel;
      acceptsNewWork?: () => boolean;
    },
  ) {
    this.store = deps.kernel?.store ?? new PaStore(deps.db);
    this.gateway = new PaGateway(this.store, deps.runtime);
    if (!this.store.get('settings', 'control')) this.store.create<PaControl>('settings', {
      backgroundEnabled: process.platform === 'darwin', paused: false, suspended: false,
      maxConcurrent: 2, defaultMaxAttempts: 6, defaultTimeoutMs: 300000, waitingExpiryMs: 86400000,
      activeCount: 0, pendingCount: 0, lastResumeAt: null,
    }, 'control');
    this.node = new PaLocalNode(this.store, (lease) =>
      this.active.get(lease.taskId)?.abort.abort(),
    );
    mkdirSync(this.memoryDir(), { recursive: true });
    if (!this.store.list("agents").length) {
      const assistant = this.createAgent({
        name: "Fantay",
        role: "理解目标，完成研究整理与可用的设计、文档产物。",
        avatar: "fantay",
        enabled: true,
        tools: ["respond", "create_project"],
        model: deps.kernel?.managedModels[0] ?? { runtime: "claude", modelId: "sonnet" },
      });
      const reviewer = this.createAgent({
        name: "审阅者",
        role: "独立核对成果与用户要求，指出具体问题，不以执行者的自述作为证据。",
        avatar: "审",
        enabled: true,
        tools: ["respond", "create_project"],
        model: deps.kernel?.managedModels[1] ?? deps.kernel?.managedModels[0] ?? { runtime: "claude", modelId: "haiku" },
      });
      this.createConversation(assistant.id);
      this.createGroup({
        name: "协作工作室",
        memberIds: [assistant.id, reviewer.id],
        moderatorId: assistant.id,
        mode: "review",
      });
    }
    // One-time rename of the legacy main assistant (spec §20.1). Deliberately not updateAgent: its revocation loop
    // would touch live tasks. Tasks, attempts (frozen agentSnapshot) and messages (senderId) are never touched.
    const IDENTITY_MARKER = 'identity-fantay-v1';
    if (!this.store.get('settings', IDENTITY_MARKER)) {
      this.store.transaction(() => {
        const legacy = this.store.list<PersonalAgent>('agents').find((a) => a.name === '主助手' && a.avatar === 'PA');
        if (legacy) {
          this.store.update<PersonalAgent>('agents', legacy.id, { name: 'Fantay', avatar: 'fantay' });
          for (const c of this.store.list<PaConversation>('conversations'))
            if (c.agentId === legacy.id && !c.groupId && !c.channelId && c.title === '主助手')
              this.store.update<PaConversation>('conversations', c.id, { title: 'Fantay' });
        }
        this.store.create('settings', { appliedAt: Date.now() } as never, IDENTITY_MARKER);
      });
    }
    // Rebuild dispatch from durable state. A dispatched attempt needs a
    // provider receipt before it is safe to advance without another call.
    const restartQueue = this.store.transaction(() => {
      const attempts = this.store.list<PaAttempt>("attempts");
      const ambiguous = new Set(attempts.filter(attempt => attempt.status === "interrupted").map(attempt => attempt.taskId));
      const receipts = new Set<string>();
      for (const attempt of attempts) {
        if (attempt.status !== "running") continue;
        const task = this.store.require<PaTask>("tasks", attempt.taskId);
        const received = attempt.modelReceipt?.outputSha256 === digest(attempt.output);
        const brokerDispatched = this.store.hasEvent(`${attempt.id}:broker-dispatched`);
        const dispatchedWork = this.store.hasEvent(`${attempt.id}:model-dispatched`);
        const hasPlan = attempt.sandboxPlan?.sha256 === digest(attempt.sandboxPlan?.script ?? "");
        const canCommit = (received || !brokerDispatched && (this.kernel?.scheduler.distributed?.has(attempt.runId) || hasPlan && !dispatchedWork)) && attempt.authority &&
          attempt.authority.participantIndex === task.nextParticipant &&
          attempt.authority.authorizationVersion === task.authorization.version;
        if (canCommit && !task.authorization.revoked && ["queued", "running", "verifying"].includes(task.status)) {
          receipts.add(task.id);
          continue;
        }
        const dispatched = !attempt.authority || dispatchedWork || this.store.hasEvent(`${attempt.id}:plan-dispatched`);
        if (dispatched && !received) ambiguous.add(task.id);
        this.store.update<PaAttempt>("attempts", attempt.id, {
          status: dispatched && !received ? "interrupted" : task.authorization.revoked ? "cancelled" : "failed",
          endedAt: attempt.modelReceipt?.receivedAt ?? Date.now(),
          error: dispatched && !received ? "后台重启，旧执行结果待核对" : "后台重启，未提交本次尝试",
        });
      }
      const queue: string[] = [];
      for (const task of this.store.list<PaTask>("tasks")) {
        if (terminal.has(task.status)) continue;
        if (ambiguous.has(task.id) || task.stopConfirmation === "unknown") {
          this.store.update<PaTask>("tasks", task.id, {
            status: task.status === "cancelling" ? "cancelling" : "waiting",
            waitKind: "external_result",
            stopConfirmation: "unknown",
            waitingReason: "后台已重启，旧执行结果待核对",
            error: null,
          });
          this.store.event(task.id, "task.recovery_required", {});
        } else if (task.status === "cancelling" || task.authorization.revoked) {
          this.store.update<PaTask>("tasks", task.id, { status: "cancelled", stopConfirmation: "confirmed", waitingReason: null });
        } else if (task.status !== "waiting") {
          const nextAgent = this.store.get<PersonalAgent>("agents", task.participantIds[task.nextParticipant] ?? "");
          const needsLogin = !receipts.has(task.id) && nextAgent?.model.runtime === "tokentosea";
          this.store.update<PaTask>("tasks", task.id, {
            status: needsLogin ? "waiting" : "queued",
            waitKind: needsLogin ? "login" : undefined,
            stopConfirmation: "confirmed",
            waitingReason: needsLogin ? "请使用原授权的模型账号恢复任务" : null,
          });
          if (!needsLogin) queue.push(task.id);
        }
      }
      return queue;
    });
    queueMicrotask(() => {
      if (this.stopping || !this.store.db.open) return;
      for (const id of restartQueue)
        if (this.store.get<PaTask>("tasks", id)?.status === "queued") this.enqueue(id);
    });
    this.tickRoutines(Date.now(), false);
    this.maintenance = setInterval(() => {
      this.expireWaitingTasks();
      this.tickRoutines();
    }, 30000);
    this.maintenance.unref();
  }
  control(): PaControl {
    return { ...this.store.require<PaControl>('settings', 'control'), suspended: this.suspended, activeCount: this.active.size, pendingCount: this.queue.size };
  }
  defaultTaskBudget(): PaTask['budget'] {
    const control = this.control();
    return { maxAttempts: control.defaultMaxAttempts, timeoutMs: control.defaultTimeoutMs };
  }
  async setControl(patch: PaControlPatch): Promise<PaControl> {
    this.store.update<PaControl>('settings', 'control', Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<PaControl>);
    if (patch.paused === true) await this.pauseWork('paused');
    if (patch.paused === false && !this.suspended) this.resumePausedWork();
    this.store.event(null, 'control.updated', patch);
    return this.control();
  }
  async powerState(state: 'suspend' | 'resume'): Promise<PaControl> {
    this.suspended = state === 'suspend';
    this.store.event(null, `device.${state}`, {});
    if (this.suspended) await this.pauseWork('device');
    else {
      this.store.update<PaControl>('settings', 'control', { lastResumeAt: Date.now() });
      this.tickRoutines(Date.now(), false);
      if (!this.control().paused) this.resumePausedWork();
    }
    return this.control();
  }
  private async pauseWork(kind: 'paused' | 'device'): Promise<void> {
    for (const task of this.store.list<PaTask>('tasks')) {
      if (!['queued', 'running', 'verifying'].includes(task.status)) continue;
      this.store.update<PaTask>('tasks', task.id, { status: 'waiting', waitKind: kind, waitingSince: Date.now(), waitingReason: kind === 'device' ? '设备休眠，等待唤醒后核对' : 'Fantay 已暂停，等待恢复', stopConfirmation: this.active.has(task.id) ? 'pending' : 'confirmed' });
      this.queue.delete(task.id);
      const active = this.active.get(task.id);
      if (active) { active.pauseRequestedAt = Date.now(); active.abort.abort(); }
      this.store.event(task.id, 'task.paused', { reason: kind });
    }
    await Promise.allSettled([...this.active.values()].map(entry => entry.done));
  }
  private resumePausedWork(): void {
    for (const task of this.store.list<PaTask>('tasks')) {
      if (task.status !== 'waiting' || !['paused', 'device'].includes(task.waitKind ?? '') || task.authorization.revoked || task.stopConfirmation !== 'confirmed') continue;
      if (task.participantIds.some(id => this.store.require<PersonalAgent>('agents', id).model.runtime === 'tokentosea')) {
        this.store.update<PaTask>('tasks', task.id, { waitKind: 'login', waitingReason: '请在桌面确认当前模型账号后恢复' });
        continue;
      }
      try { this.resume(task.id); } catch (error) {
        const reason = error instanceof PaError ? error.message : '恢复条件尚未满足，请核对任务';
        this.store.update<PaTask>('tasks', task.id, { waitKind: error instanceof PaError && error.code === 'PA_BUDGET' ? 'budget' : 'recovery', waitingReason: reason });
        this.store.event(task.id, 'task.resume_blocked', { reason });
      }
    }
    this.pump();
  }
  private expireWaitingTasks(): void {
    if (this.stopping) return;
    const now = Date.now();
    for (const task of this.store.list<PaTask>('tasks')) {
      if (task.status !== 'waiting' || task.waitKind === 'paused' || task.waitKind === 'device' || task.stopConfirmation === 'unknown') continue;
      const since = task.waitingSince ?? task.updatedAt;
      if (now - since < this.control().waitingExpiryMs) continue;
      this.store.update<PaTask>('tasks', task.id, { status: 'failed', waitingReason: null, error: '等待已超过设定期限；目标和已有成果保留，可手动恢复' });
      this.store.event(task.id, 'task.wait_expired', {});
    }
  }
  outputPage(id: string, offset = 0, limit = 16000, query = ''): PaOutputPage {
    const attempt = this.store.require<PaAttempt>('attempts', id);
    const start = Math.max(0, Math.min(attempt.output.length, Math.floor(offset)));
    const end = Math.min(attempt.output.length, start + Math.max(1, Math.min(32000, Math.floor(limit))));
    const matches: PaOutputPage['matches'] = [];
    if (query) {
      const needle = query.slice(0, 200), matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      matcher.lastIndex = start;
      for (let match = matcher.exec(attempt.output); match && matches.length < 50; match = matcher.exec(attempt.output)) matches.push({ offset: match.index, excerpt: attempt.output.slice(Math.max(0, match.index - 80), match.index + match[0].length + 160) });
    }
    return { attemptId: id, offset: start, nextOffset: end < attempt.output.length ? end : null, totalChars: attempt.output.length, text: attempt.output.slice(start, end), matches };
  }
  channelConversation(channel: PaChannel, remoteKey: string): PaConversation {
    const id = `channel-${digest(`${channel.id}:${channel.authorizationVersion}:${remoteKey}`).slice(0, 40)}`;
    const current = this.store.get<PaConversation>('conversations', id);
    const fields = { title: channel.name, channelId: channel.id, externalThreadId: remoteKey,
      agentId: channel.targetKind === 'agent' ? channel.targetId : null, groupId: channel.targetKind === 'group' ? channel.targetId : null,
      allowSharedMemory: channel.shareGroupMemory, allowProject: channel.allowProject };
    return current ? this.store.update<PaConversation>('conversations', id, fields) : this.store.create<PaConversation>('conversations', fields, id);
  }
  revokeChannel(channelId: string): void {
    for (const task of this.store.list<PaTask>('tasks')) if (task.channelId === channelId && !terminal.has(task.status)) this.cancel(task.id);
  }
  models() {
    return this.deps.runtime.models();
  }
  private managedLocalProject(id: string) {
    const project = getProject(this.deps.db, id);
    return project && !project.metadata?.baseDir && !project.metadata?.teamMirrorRevokedAt && !getWorkspaceProjectByProjectId(this.deps.db, id) ? project : null;
  }
  projects(): Array<{ id: string; name: string }> {
    if (this.kernel?.storage.privateProjects) return [];
    return listProjects(this.deps.db).filter(project => this.managedLocalProject(project.id)).map(project => ({ id: String(project.id), name: String(project.name) }));
  }
  snapshot(): PaSnapshot {
    return {
      agents: this.store.list("agents"),
      groups: this.store.list("groups"),
      conversations: this.store.list("conversations"),
      messages: this.store.list("messages"),
      tasks: this.store.list("tasks"),
      attempts: this.store
        .list<PaAttempt>("attempts")
        .map((attempt) => ({ ...attempt, output: "" })),
      artifacts: this.store.list("artifacts"),
      memories: this.memories(),
      memoryCandidates: this.store.list<PaMemoryCandidate>("memory_candidates").filter(item => item.status === "pending"),
      goals: this.store.list('goals'),
      routines: this.store.list('routines'),
      node: this.node.capabilities(),
      ...(this.kernel ? { mode: this.kernel.mode } : {}),
      ...(this.kernel ? { execution: { localSandbox: !!this.kernel.isolation, remoteWorker: !!this.kernel.scheduler.distributed } } : {}),
    };
  }
  saveGoal(input: PaGoalInput, id?: string, revision?: number): PaGoal {
    const taskIds = [...new Set(input.taskIds)];
    for (const taskId of taskIds) this.store.require<PaTask>('tasks', taskId);
    return id ? this.store.update<PaGoal>('goals', id, { ...input, taskIds }, revision)
      : this.store.create<PaGoal>('goals', { ...input, taskIds });
  }
  private routineTarget(id: string): void {
    const conversation = this.store.require<PaConversation>('conversations', id);
    const agent = conversation.agentId ? this.store.get<PersonalAgent>('agents', conversation.agentId) : null;
    if (conversation.channelId || conversation.groupId || !agent?.enabled || !agent.tools.includes('respond') || agent.model.runtime === 'tokentosea')
      throw new PaError('例行任务需要使用已启用的 Claude 或 Ollama 智能体的一对一会话');
  }
  private nextRoutineRun(input: PaRoutineInput, now: number): number | null {
    return input.enabled ? nextRunAtForSchedule({ kind: 'daily', time: input.time, timezone: input.timezone }, new Date(now))?.getTime() ?? null : null;
  }
  saveRoutine(input: PaRoutineInput, id?: string, revision?: number): PaRoutine {
    if (!isValidTimezone(input.timezone)) throw new PaError('请选择有效的时区');
    if (input.enabled || !id) this.routineTarget(input.conversationId);
    const patch = { ...input, nextRunAt: this.nextRoutineRun(input, Date.now()), lastError: null };
    return id ? this.store.update<PaRoutine>('routines', id, patch, revision)
      : this.store.create<PaRoutine>('routines', { ...patch, lastTaskId: null });
  }
  private submitRoutine(routine: PaRoutine, requestId: string): PaTask {
    if (this.stopping || this.suspended || this.control().paused)
      throw new PaError('Fantay 当前已暂停，恢复后可运行例行任务', 409);
    this.routineTarget(routine.conversationId);
    const previous = routine.lastTaskId && this.store.get<PaTask>('tasks', routine.lastTaskId);
    if (previous && !terminal.has(previous.status))
      throw new PaError('上一项例行任务仍在处理，请先查看结果', 409);
    return this.submit({
      requestId, conversationId: routine.conversationId, goal: routine.prompt,
      targetAgentIds: [], kind: 'discussion', budget: this.defaultTaskBudget(),
    }, undefined, routine.id);
  }
  runRoutine(id: string, revision: number): PaTask {
    return this.store.transaction(() => {
      const routine = this.store.require<PaRoutine>('routines', id);
      if (routine.revision !== revision) throw new PaError('例行任务已更新，请刷新后重试', 409, 'PA_REVISION_CONFLICT');
      const task = this.submitRoutine(routine, `routine:${id}:manual:${revision}`);
      this.store.update<PaRoutine>('routines', id, { lastTaskId: task.id, lastError: null }, revision);
      return task;
    });
  }
  tickRoutines(now = Date.now(), allowDueRun = true): void {
    if (this.stopping || this.deps.acceptsNewWork?.() === false) return;
    for (const item of this.store.list<PaRoutine>('routines')) {
      if (!item.enabled || item.nextRunAt === null || item.nextRunAt > now) continue;
      this.store.transaction(() => {
        const routine = this.store.require<PaRoutine>('routines', item.id);
        if (routine.revision !== item.revision) return;
        // Skip missed slots and the second occurrence of a repeated wall-clock time.
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: routine.timezone, dateStyle: 'short' });
        const slot = day.format(item.nextRunAt!);
        const requestId = `routine:${routine.id}:${slot}`;
        const patch: Partial<PaRoutine> = { nextRunAt: this.nextRoutineRun(routine, now) };
        if (allowDueRun && now - item.nextRunAt! <= 60000 && !this.store.hasTaskRequest(requestId)) {
          try {
            patch.lastTaskId = this.submitRoutine(routine, requestId).id;
            patch.lastError = null;
          } catch (error) {
            patch.lastError = error instanceof PaError ? error.message : '例行任务启动失败，请检查智能体配置';
          }
        }
        this.store.update<PaRoutine>('routines', routine.id, patch, routine.revision);
      });
    }
  }

  hasActiveWork(): boolean {
    return this.active.size > 0 || this.queue.size > 0
      || this.store.list<PaTask>('tasks').some((task) => task.status === 'queued');
  }
  createAgent(input: PaAgentInput): PersonalAgent {
    return this.store.create("agents", input);
  }
  updateAgent(
    id: string,
    input: PaAgentInput,
    revision: number,
  ): PersonalAgent {
    const agent = this.store.update<PersonalAgent>(
      "agents",
      id,
      input,
      revision,
    );
    // Configuration snapshots stay immutable; capability revocation is live.
    for (const task of this.store.list<PaTask>("tasks"))
      if (
        !terminal.has(task.status) &&
        task.participantIds.includes(id) &&
        (!agent.enabled ||
          !agent.tools.includes("respond") ||
          (task.kind === "project" && !agent.tools.includes("create_project")))
      ) {
        this.store.update<PaTask>("tasks", task.id, {
          status: "waiting",
          waitingReason: `智能体 ${agent.name} 已停用或权限已撤销`,
        });
        this.queue.delete(task.id);
        this.active.get(task.id)?.abort.abort();
      }
    return agent;
  }
  cloneAgent(id: string): PersonalAgent {
    const old = this.store.require<PersonalAgent>("agents", id);
    return this.createAgent({
      name: `${old.name.slice(0, 55)} 副本`,
      role: old.role,
      avatar: old.avatar === 'fantay' ? '' : old.avatar,
      enabled: old.enabled,
      tools: old.tools,
      model: old.model,
    });
  }
  createConversation(agentId: string): PaConversation {
    const agent = this.store.require<PersonalAgent>("agents", agentId);
    return this.store.create<PaConversation>("conversations", {
      title: agent.name,
      agentId,
      groupId: null,
    });
  }
  private validateGroup(input: PaGroupInput): void {
    if (
      new Set(input.memberIds).size !== input.memberIds.length ||
      !input.memberIds.includes(input.moderatorId)
    )
      throw new PaError("群组成员不能重复，主持者必须是群组成员");
    if (
      input.reviewerId &&
      (!input.memberIds.includes(input.reviewerId) ||
        input.reviewerId === input.moderatorId)
    )
      throw new PaError("审阅者必须是主持者之外的群组成员");
    for (const id of input.memberIds) this.store.require("agents", id);
  }
  createGroup(input: PaGroupInput): PaGroup {
    this.validateGroup(input);
    return this.store.transaction(() => {
      const groupId = randomUUID();
      const conversation = this.store.create<PaConversation>("conversations", {
        title: input.name,
        agentId: null,
        groupId,
      });
      return this.store.create<PaGroup>(
        "groups",
        { ...input, conversationId: conversation.id },
        groupId,
      );
    });
  }
  updateGroup(id: string, input: PaGroupInput, revision: number): PaGroup {
    const saved = this.store.transaction(() => {
      const group = this.store.update<PaGroup>("groups", id, {
        ...input,
        reviewerId: input.reviewerId === undefined ? this.store.require<PaGroup>("groups", id).reviewerId : input.reviewerId,
      }, revision);
      this.validateGroup(group);
      this.store.update<PaConversation>("conversations", group.conversationId, {
        title: group.name,
      });
      return group;
    });
    for (const task of this.store.list<PaTask>("tasks")) {
      if (terminal.has(task.status) || task.status === "cancelling" || task.stopConfirmation === "unknown") continue;
      const conversation = this.store.get<PaConversation>("conversations", task.conversationId);
      if (conversation?.groupId !== id ||
        task.participantIds.slice(task.nextParticipant).every(agentId => saved.memberIds.includes(agentId))) continue;
      this.store.update<PaTask>("tasks", task.id, {
        status: "waiting", waitKind: "agent", waitingSince: Date.now(), waitingReason: "协作成员权限已改变，请核对任务参与者",
      });
      this.queue.delete(task.id);
      this.active.get(task.id)?.abort.abort();
    }
    return saved;
  }
  private participants(
    input: PaTaskInput,
    conversation: PaConversation,
  ): string[] {
    const group = conversation.groupId
      ? this.store.require<PaGroup>("groups", conversation.groupId)
      : null;
    const members = group?.memberIds ?? [conversation.agentId!];
    let selected = [...new Set(input.targetAgentIds)];
    if (input.replyTo) {
      const reply = this.store.require<PaMessage>("messages", input.replyTo);
      if (reply.conversationId !== conversation.id)
        throw new PaError("回复目标不属于当前会话");
      if (!paCanReadClass(input.dataClass, reply.dataClass))
        throw new PaError("回复本机专用消息时，须启用仅本机处理", 403, "PA_ROUTE_DENIED");
      if (!selected.length && reply.senderId !== "owner")
        selected = [reply.senderId];
    }
    if (!selected.length)
      selected = members.filter((id) =>
        input.goal.includes(
          `@${this.store.require<PersonalAgent>("agents", id).name}`,
        ),
      );
    if (selected.some((id) => !members.includes(id)))
      throw new PaError("指定智能体不属于当前会话");
    if (!selected.length)
      selected =
        input.kind === "project" ||
        group?.mode === "collaboration" ||
        group?.mode === "review" ||
        input.goal.includes("@全体")
          ? [...members]
          : [group?.moderatorId ?? members[0]!];
    if (
      group &&
      selected.length > 1 &&
      (input.kind === "project" || group.mode === "review")
    ) {
      const reviewer =
        group.reviewerId ??
        members.filter((id) => id !== group.moderatorId).at(-1);
      if (
        reviewer &&
        selected.includes(reviewer) &&
        selected.includes(group.moderatorId)
      )
        selected = [
          ...selected.filter(
            (id) => id !== reviewer && id !== group.moderatorId,
          ),
          group.moderatorId,
          reviewer,
        ];
    }
    if (input.kind === "project") {
      if (selected.length < 2)
        throw new PaError("创建项目需要至少两名成员，分别执行与独立审阅");
      const producer = this.store.require<PersonalAgent>(
        "agents",
        selected[selected.length - 2]!,
      );
      const reviewer = this.store.require<PersonalAgent>(
        "agents",
        selected[selected.length - 1]!,
      );
      if (modelKey(producer) === modelKey(reviewer))
        throw new PaError("执行者与审阅者请选择不同模型");
    }
    return selected;
  }
  submit(input: PaTaskInput, approvalId?: string, routineId?: string, origin?: Extract<PaPrincipal, { kind: "channel" | "device" | "enterprise" }>): PaTask {
    if ((this.kernel?.mode === "enterprise") !== (origin?.kind === "enterprise"))
      throw new PaError("任务需要当前部署的身份授权", 403, "PA_DELEGATION_DENIED");
    if (input.execution && (!this.kernel || origin?.kind === "channel" || origin?.kind === "device" || routineId))
      throw new PaError("此发起者没有独立执行授权", 403, "PA_CAPABILITY_DENIED");
    if (input.execution?.target === "worker" && (!this.kernel?.scheduler.distributed || input.dataClass === "local_only"))
      throw new PaError("没有授权的远端设备，或密级限制派发", 403, "PA_ROUTE_DENIED");
    if (input.execution?.script && input.execution.generateScript)
      throw new PaError("请选择自定义脚本或智能体生成脚本", 400, "PA_SANDBOX_INPUT");
    if (input.execution?.gatewayModel && (!hasSandbox(input) || input.dataClass === "local_only" ||
      this.kernel?.mode !== "enterprise" || !this.kernel.managedModels.some(model => model.modelId === input.execution?.gatewayModel)))
      throw new PaError("隔离输出仅能提交到已授权的企业模型网关", 403, "PA_ROUTE_DENIED");
    if (input.projectId && this.kernel?.storage.privateProjects)
      throw new PaError("企业成果仅可写入租户独立空间", 403, "PA_ROUTE_DENIED");
    if (origin?.kind === "device" && input.dataClass === "local_only")
      throw new PaError("此密级仅能在本机使用", 403, "PA_ROUTE_DENIED");
    const requestFingerprint = digest(JSON.stringify(input));
    const previous = this.store
      .list<PaTask>("tasks")
      .find((task) => task.requestId === input.requestId);
    if (previous) {
      if (origin?.kind === "enterprise" && (previous.principal?.kind !== "enterprise" ||
        previous.principal.id !== origin.id || previous.principal.tenantId !== origin.tenantId))
        throw new PaError("请求标识不可用", 409, "PA_IDEMPOTENCY_CONFLICT");
      if (origin?.kind === "device" && (previous.dataClass === "local_only" || previous.channelId) ||
        origin?.kind === "channel" && (previous.channelId !== origin.id ||
          previous.principal?.kind === "channel" && previous.principal.subjectId !== origin.subjectId))
        throw new PaError("此请求已由其他主体受理", 409, "PA_IDEMPOTENCY_CONFLICT");
      if (
        (previous.requestFingerprint &&
          previous.requestFingerprint !== requestFingerprint) ||
        previous.goal !== input.goal ||
        previous.conversationId !== input.conversationId ||
        previous.kind !== input.kind
      )
        throw new PaError(
          "重复请求的内容不一致",
          409,
          "PA_IDEMPOTENCY_CONFLICT",
        );
      return previous;
    }
    const conversation = this.store.require<PaConversation>(
      "conversations",
      input.conversationId,
    );
    if (origin?.kind === "enterprise" && input.replyTo) {
      const message = this.store.get<PaMessage>("messages", input.replyTo);
      const parent = message?.taskId ? this.store.get<PaTask>("tasks", message.taskId)?.principal : null;
      if (parent?.kind !== "enterprise" || parent.id !== origin.id || parent.tenantId !== origin.tenantId)
        throw new PaError("回复记录不存在", 404, "PA_NOT_FOUND");
    }
    if (conversation.channelId && input.dataClass === "local_only")
      throw new PaError("本机专用任务须从桌面发起", 403, "PA_ROUTE_DENIED");
    if (input.dataClass === "local_only" && input.projectId)
      throw new PaError("本机专用成果保存在 PA 私有空间，不能写入普通项目", 403, "PA_ROUTE_DENIED");
    if (origin?.kind === "channel" && (conversation.channelId !== origin.id || conversation.externalThreadId !== origin.threadId))
      throw new PaError("渠道身份与会话不匹配", 403, "PA_CAPABILITY_DENIED");
    if (origin?.kind === "device" && (conversation.channelId || input.dataClass === "local_only"))
      throw new PaError("此会话或密级仅能在本机使用", 403, "PA_ROUTE_DENIED");
    const associated = input.projectId ? this.managedLocalProject(input.projectId) : null;
    if (input.projectId && (input.kind !== 'project' || !associated || conversation.channelId)) throw new PaError('只能从桌面关联本机托管项目；团队项目和导入目录请使用原项目工作区', 403);
    if (conversation.channelId && input.kind === 'project' && !conversation.allowProject) {
      const approval = approvalId ? this.store.get<PaProjectApproval>('approvals', approvalId) : null;
      const channel = this.store.require<PaChannel>('channels', conversation.channelId);
      if (!approval || approval.state !== 'approved' || approval.channelId !== channel.id || approval.authorizationVersion !== channel.authorizationVersion || approval.requestId !== input.requestId || approval.goalHash !== digest(input.goal) || approval.parametersHash !== requestFingerprint || approval.expiresAt < Date.now() || approval.taskId) throw new PaError('此渠道未获准创建本地项目，请在桌面批准本次请求', 403, 'PA_APPROVAL_REQUIRED');
    }
    const participantIds = this.participants(input, conversation);
    if (hasSandbox(input) && (input.kind !== "discussion" || participantIds.length !== 1 || input.execution?.script !== undefined && !input.execution.script.trim()))
      throw new PaError("显式隔离脚本需要单一执行者及讨论任务", 400, "PA_SANDBOX_INPUT");
    const providerAccountId = !conversation.channelId && !routineId && origin?.kind !== "device" ? this.deps.runtime.accountId?.() : undefined;
    const principal: PaPrincipal = origin ?? (routineId ? { kind: "routine", id: routineId } : { kind: "owner", id: "owner" });
    const reviewRequired =
      input.kind === "project" ||
      (participantIds.length > 1 &&
        Boolean(
          conversation.groupId &&
          this.store.require<PaGroup>("groups", conversation.groupId).mode ===
            "review",
        ));
    if (
      reviewRequired &&
      modelKey(
        this.store.require<PersonalAgent>("agents", participantIds.at(-2)!),
      ) ===
        modelKey(
          this.store.require<PersonalAgent>("agents", participantIds.at(-1)!),
        )
    )
      throw new PaError("执行者与审阅者请选择不同模型");
    const task = this.store.transaction(() => {
      const value = this.store.create<PaTask>("tasks", {
        ...(routineId ? { routineId } : {}),
        requestId: input.requestId,
        ...(conversation.channelId ? { channelId: conversation.channelId, channelAuthorizationVersion: this.store.require<PaChannel>('channels', conversation.channelId).authorizationVersion } : {}),
        requestFingerprint,
        reviewRequired,
        conversationId: input.conversationId,
        goal: input.goal,
        principal,
        ...(input.completionCriteria ? { completionCriteria: input.completionCriteria } : {}),
        ...(input.dataClass ? { dataClass: input.dataClass } : {}),
        ...(input.execution ? { execution: input.execution } : {}),
        kind: input.kind,
        projectName: associated ? String(associated.name) : input.projectName ?? input.goal.slice(0, 60),
        projectId: associated ? String(associated.id) : null,
        projectConversationId: associated ? randomUUID() : null,
        status: "queued",
        waitingReason: null,
        error: null,
        participantIds,
        nextParticipant: 0,
        budget: input.budget,
        authorization: {
          ...(approvalId ? { approvalId } : {}),
          localProject: input.kind === "project",
          externalWrites: false,
          version: 1,
          revoked: false,
          ...(providerAccountId ? { providerAccountId } : {}),
        },
        amendments: [],
        evidence: [],
      });
      this.store.create<PaMessage>("messages", {
        conversationId: conversation.id,
        taskId: value.id,
        senderId: "owner",
        ...(routineId ? { routineId } : {}),
        content: input.goal,
        ...(input.dataClass ? { dataClass: input.dataClass } : {}),
        targetAgentIds: input.targetAgentIds,
        replyTo: input.replyTo ?? null,
      });
      if (associated) insertConversation(this.deps.db, { id: value.projectConversationId, projectId: associated.id, title: input.goal.slice(0, 80), createdAt: Date.now(), updatedAt: Date.now() });
      if (approvalId) this.store.update<PaProjectApproval>('approvals', approvalId, { taskId: value.id });
      this.store.event(value.id, "task.accepted", { participantIds, principal, requestFingerprint });
      return value;
    });
    this.enqueueAccepted(task);
    return task;
  }
  amend(id: string, content: string, revision: number): PaTask {
    const task = this.store.require<PaTask>("tasks", id);
    if (terminal.has(task.status) || task.status === "cancelling")
      throw new PaError("已结束的任务不能追加要求，请发起新任务");
    const next = this.store.update<PaTask>(
      "tasks",
      id,
      {
        amendments: [
          ...task.amendments,
          {
            revision: task.revision + 1,
            content,
            receivedAt: Date.now(),
            appliedAt: null,
          },
        ],
      },
      revision,
    );
    this.store.event(id, "task.amended", { revision: next.revision, content });
    return next;
  }
  cancel(id: string): PaTask {
    const task = this.store.require<PaTask>("tasks", id);
    if (terminal.has(task.status)) return task;
    const active = this.active.get(id);
    const unknown =
      task.stopConfirmation === "unknown" ||
      this.attempts(id).some((attempt) => attempt.status === "interrupted");
    const next = this.store.update<PaTask>("tasks", id, {
      status: active || unknown ? "cancelling" : "cancelled",
      stopConfirmation: unknown ? "unknown" : active ? "pending" : "confirmed",
      waitingReason: unknown
        ? "旧执行者或模型服务端结果待核对"
        : active
          ? "正在停止执行者；已有项目与成果保留"
          : null,
      authorization: {
        ...task.authorization,
        revoked: true,
        version: task.authorization.version + 1,
      },
    });
    this.store.event(id, "task.cancel_requested", {});
    const cancelExecution = () => {
      if (!this.store.get<PaTask>('tasks', id)?.authorization.revoked) return;
      this.queue.delete(id); this.node.cancelTask(id); active?.abort.abort();
    };
    if (this.store.db.inTransaction) queueMicrotask(cancelExecution); else cancelExecution();
    return next;
  }
  resume(id: string): PaTask {
    const task = this.store.require<PaTask>("tasks", id);
    if (task.status !== "waiting" && task.status !== "failed")
      throw new PaError("该任务当前不能恢复");
    if (task.authorization.revoked)
      throw new PaError("原任务授权已撤销，请创建新任务");
    if (this.active.has(id))
      throw new PaError("旧执行者尚未停止，请稍后重试", 409, "PA_EXECUTOR_RUNNING");
    const attempts = this.attempts(id);
    if (
      task.stopConfirmation === "unknown" ||
      attempts.some((attempt) => attempt.status === "interrupted")
    )
      throw new PaError(
        "旧执行者状态未知，请先核对结果，避免重复运行",
        409,
        "PA_RECOVERY_REQUIRED",
      );
    if (attempts.length >= task.budget.maxAttempts)
      throw new PaError("已达到尝试次数上限，请新建任务", 429, "PA_BUDGET");
    if (paRemainingTime(task, attempts) <= 0)
      throw new PaError("本任务累计执行时间已达到上限，请新建任务", 429, "PA_BUDGET");
    const next = this.store.update<PaTask>("tasks", id, {
      status: "queued",
      waitingReason: null,
      waitKind: undefined,
      waitingSince: undefined,
      expiresAt: undefined,
      error: null,
    });
    this.enqueueAccepted(next);
    return next;
  }
  async reconcileTask(id: string, confirmation?: { revision: number; note: string }): Promise<PaTask> {
    let task = this.store.require<PaTask>('tasks', id);
    const expectedRevision = task.revision;
    if (confirmation && (confirmation.revision !== expectedRevision || confirmation.note.trim().length < 3 || confirmation.note.length > 500)) throw new PaError('请核对当前任务并填写明确的结束确认说明', 409);
    if (this.active.has(id)) throw new PaError('执行者仍由本机跟踪，请等待停止完成', 409, 'PA_EXECUTOR_RUNNING');
    const attempts = this.attempts(id).filter(attempt => attempt.status === 'interrupted');
    if (task.stopConfirmation !== 'unknown' && !attempts.length) return task;
    const checked = attempts.length ? attempts : this.attempts(id).slice(-1);
    if (!checked.length) {
      task = this.store.update<PaTask>('tasks', id, { stopConfirmation: 'confirmed', status: task.authorization.revoked ? 'cancelled' : 'waiting', waitKind: 'recovery', waitingReason: task.authorization.revoked ? null : '未发现已启动的执行尝试，可以恢复' });
      return task;
    }
    for (const attempt of checked) {
      const state = await this.deps.runtime.reconcile?.(attempt.agentSnapshot.model, attempt.runId) ?? 'unknown';
      if (state === 'running') throw new PaError('旧执行者仍在运行，不能重新分派', 409, 'PA_EXECUTOR_RUNNING');
      if (state === 'unknown' && !confirmation) throw new PaError('此适配器无法自动确认远端结果，请在服务端核对后明确确认，未自动重试', 409, 'PA_RECOVERY_REQUIRED');
    }
    for (const artifact of this.store.list<PaArtifact>('artifacts').filter(artifact => artifact.taskId === id)) {
      if (!this.privateProject(task) && !getProject(this.deps.db, artifact.projectId))
        throw new PaError('关联项目已不存在，请核对已有成果', 409);
      if (!(await readVerifiedPaArtifact(this.projectRoot(task), artifact)))
        throw new PaError('已有成果缺失或发生变化，请先核对项目，未自动重试', 409);
    }
    task = this.store.require<PaTask>('tasks', id);
    if (this.active.has(id) || task.revision !== expectedRevision) throw new PaError('任务状态已变化，请重新核对', 409);
    const timeBudgetExhausted = paRemainingTime(task, this.attempts(id)) <= 0;
    return this.store.transaction(() => {
      for (const attempt of attempts) this.store.update<PaAttempt>('attempts', attempt.id, { status: task.authorization.revoked ? 'cancelled' : 'failed', error: '已核对本机执行者退出；旧尝试未重放' });
      this.store.event(id, 'task.recovery_verified', { runIds: checked.map(attempt => attempt.runId), artifactsChecked: true, source: confirmation ? 'owner-confirmed' : 'process-observed', ...(confirmation ? { note: confirmation.note.trim() } : {}) });
      return this.store.update<PaTask>('tasks', id, {
        status: task.authorization.revoked ? 'cancelled' : 'waiting',
        stopConfirmation: 'confirmed',
        waitKind: timeBudgetExhausted ? 'budget' : 'recovery',
        waitingSince: Date.now(),
        waitingReason: task.authorization.revoked ? null : timeBudgetExhausted ? '旧执行者已退出；本任务累计执行时间已达到上限，请新建任务' : '旧执行者已退出，已有成果已核对，可以恢复',
        error: null,
        ...(timeBudgetExhausted ? { timeBudgetExhausted: true } : {}),
      });
    });
  }
  private enqueueAccepted(task: PaTask): void {
    if (!this.store.db.inTransaction) {
      this.enqueue(task.id);
      return;
    }
    queueMicrotask(() => {
      if (!this.store.db.open || this.stopping) return;
      const current = this.store.get<PaTask>('tasks', task.id);
      if (current?.status === 'queued' && current.revision === task.revision && !current.authorization.revoked) this.enqueue(task.id);
    });
  }
  private enqueue(id: string): void {
    // Preserve the accepting request's account context, even when another task
    // frees a slot. Never borrow the last active user's model credentials.
    this.queue.set(
      id,
      AsyncResource.bind(() => {
        const abort = new AbortController();
        const done = Promise.resolve()
          .then(() => this.run(id, abort))
          .finally(() => {
            const pausedDuringRun = this.active.get(id)?.pauseRequestedAt !== undefined;
            this.active.delete(id);
            if (pausedDuringRun && !this.stopping && !this.suspended && !this.control().paused) this.resumePausedWork();
            else this.pump();
          });
        this.active.set(id, { abort, done });
      }),
    );
    this.pump();
  }
  private pump(): void {
    const control = this.control();
    if (this.stopping || control.paused || this.suspended) return;
    for (const [id, start] of this.queue) {
      if (this.active.size >= control.maxConcurrent) break;
      const conversationId = this.store.require<PaTask>(
        "tasks",
        id,
      ).conversationId;
      if (
        [...this.active.keys()].some(
          (key) =>
            this.store.require<PaTask>("tasks", key).conversationId ===
            conversationId,
        )
      )
        continue;
      this.queue.delete(id);
      start();
    }
  }
  private attempts(id: string): PaAttempt[] {
    return this.store
      .list<PaAttempt>("attempts")
      .filter((attempt) => attempt.taskId === id);
  }
  private reserveCost(task: PaTask, agent: PersonalAgent): number | undefined {
    const limit = task.budget.maxCostUsd;
    if (agent.model.runtime !== "tokentosea") {
      if (limit !== undefined && !(task.dataClass === "local_only" && agent.model.runtime === "ollama"))
        throw new PaError("此模型没有可强制执行的费用限额，请选择 TokenToSea 或本机专用 Ollama", 409, "PA_BUDGET");
      return undefined;
    }
    const usedMicros = this.attempts(task.id).reduce((sum, item) => {
      if (item.agentSnapshot.model.runtime !== "tokentosea" ||
        item.authority && !this.store.hasEvent(`${item.id}:model-dispatched`) && !this.store.hasEvent(`${item.id}:plan-dispatched`)) return sum;
      return sum + Math.round((item.reservedCostUsd ?? 0.25) * 1e6);
    }, 0);
    const remaining = Math.min(250000, Math.floor((limit ?? task.budget.maxAttempts * 0.25) * 1e6) - usedMicros);
    if (remaining <= 0) throw new PaError("本任务的模型费用额度已用尽", 429, "PA_BUDGET");
    return remaining / 1e6;
  }
  private async createProject(task: PaTask): Promise<PaTask> {
    if (this.privateProject(task)) {
      if (task.projectId) return task;
      return this.store.transaction(() => {
        const value = this.store.update<PaTask>("tasks", task.id, { projectId: randomUUID() });
        this.store.event(task.id, "project.private_allocated", { projectId: value.projectId });
        return value;
      });
    }
    if (task.projectId) {
      if (!getProject(this.deps.db, task.projectId))
        throw new PaError("关联项目已被删除，请创建新任务", 409);
      return task;
    }
    // Project identity and the operation receipt commit together. A crash before
    // mkdir is harmless: ensureProject is idempotent on the recorded identity.
    const projectId = randomUUID(),
      conversationId = randomUUID(),
      now = Date.now();
    task = this.store.transaction(() => {
      insertProject(this.deps.db, {
        id: projectId,
        name: task.projectName,
        metadata: {
          kind: "prototype",
          intent: "personal-agent",
          paTaskId: task.id,
        },
        createdAt: now,
        updatedAt: now,
      });
      insertConversation(this.deps.db, {
        id: conversationId,
        projectId,
        title: task.projectName,
        createdAt: now,
        updatedAt: now,
      });
      this.store.audit(task.id, "project.created", {
        projectId,
        conversationId,
        authorityVersion: task.authorization.version,
        parametersDigest: digest(JSON.stringify([task.projectName, projectId, conversationId])),
      }, `${task.id}:project-created`);
      return this.store.update<PaTask>("tasks", task.id, {
        projectId,
        projectConversationId: conversationId,
      });
    });
    await ensureProject(this.deps.projectsDir, projectId);
    return task;
  }
  private assertAuthorized(id: string, agentId: string): PaTask {
    const task = this.store.require<PaTask>("tasks", id);
    if (this.kernel && !this.kernel.identity.valid(task))
      throw new PaError("原任务委托已过期或撤销", 403, "PA_DELEGATION_DENIED");
    const conversation = this.store.require<PaConversation>("conversations", task.conversationId);
    const members = conversation.groupId
      ? this.store.require<PaGroup>("groups", conversation.groupId).memberIds
      : [conversation.agentId];
    if (!task.participantIds.includes(agentId) || !members.includes(agentId))
      throw new PaError("执行者已不属于此会话的授权范围", 403, "PA_AGENT_UNAVAILABLE");
    if (task.projectId && !this.privateProject(task) && !this.managedLocalProject(task.projectId)) throw new PaError('项目已删除或范围已改变，停止写入并保留任务', 403, 'PA_PROJECT_UNAVAILABLE');
    if (task.channelId) {
      const channel = this.store.get<PaChannel>('channels', task.channelId);
      const approval = task.authorization.approvalId ? this.store.get<PaProjectApproval>('approvals', task.authorization.approvalId) : null;
      const onceApproved = approval?.state === 'approved' && approval.taskId === task.id && approval.channelId === channel?.id && approval.authorizationVersion === channel.authorizationVersion;
      if (!channel?.enabled || task.channelAuthorizationVersion !== channel.authorizationVersion || (task.kind === 'project' && !channel.allowProject && !onceApproved)) throw new PaError('渠道授权已撤销', 403, 'PA_AGENT_UNAVAILABLE');
      if (task.principal?.kind === "channel" &&
        (task.principal.id !== channel.id || task.principal.authorizationVersion !== channel.authorizationVersion ||
          !channel.allowedSenderIds.includes(task.principal.subjectId)))
        throw new PaError("渠道发起者授权已撤销", 403, "PA_AGENT_UNAVAILABLE");
    }
    const agent = this.store.require<PersonalAgent>("agents", agentId);
    if (task.routineId && agent.model.runtime === 'tokentosea')
      throw new PaError('例行任务的智能体已切换模型，请改回 Claude 或 Ollama 后恢复', 409, 'PA_AGENT_UNAVAILABLE');
    if (
      task.authorization.revoked ||
      task.status === "cancelling" ||
      task.status === "cancelled"
    )
      throw new PaError("任务授权已撤销", 409, "PA_CANCEL_CONFIRMED");
    if (
      !agent.enabled ||
      !agent.tools.includes("respond") ||
      (task.kind === "project" &&
        (!task.authorization.localProject ||
          !agent.tools.includes("create_project")))
    )
      throw new PaError(
        "智能体已停用或权限已撤销",
        403,
        "PA_AGENT_UNAVAILABLE",
      );
    return task;
  }
  private attemptAuthority(attempt: PaAttempt, signal: AbortSignal): PaTask {
    signal.throwIfAborted();
    const task = this.assertAuthorized(attempt.taskId, attempt.agentSnapshot.id);
    if (!attempt.authority || attempt.authority.authorizationVersion !== task.authorization.version ||
      attempt.authority.participantIndex !== task.nextParticipant ||
      task.participantIds[task.nextParticipant] !== attempt.authority.agentId ||
      !this.memoryRefsCurrent(attempt.memoryRefs) ||
      (task.status !== "running" && task.status !== "verifying" && task.status !== "queued"))
      throw new PaError("尝试授权、任务阶段或上下文已改变", 409, "PA_STALE_LEASE");
    return task;
  }
  private acceptReceipt(attempt: PaAttempt, result: PaModelResult, signal: AbortSignal, lease?: PaExecutionLease): PaAttempt {
    return this.store.transaction(() => {
      this.attemptAuthority(attempt, signal);
      if (lease) this.node.event({ lease, eventId: `${attempt.id}:result`, kind: "result", at: Date.now() });
      this.store.audit(attempt.taskId, "gateway.model_received", {
        attemptId: attempt.id, outputDigest: digest(result.text), usage: result.usage,
        ...(result.workerReceipt ? { worker: result.workerReceipt } : {}),
      }, `${attempt.id}:model-received`);
      return this.store.update<PaAttempt>("attempts", attempt.id, {
        output: result.text, usage: result.usage, resolvedModel: result.resolvedModel,
        ...(result.workerReceipt ? { workerReceipt: result.workerReceipt } : {}),
        modelReceipt: { outputSha256: digest(result.text), receivedAt: Date.now() },
      });
    });
  }
  private async brokerSandboxOutput(attempt: PaAttempt, result: PaModelResult, signal: AbortSignal): Promise<PaModelResult> {
    const task = this.attemptAuthority(attempt, signal);
    const route = task.execution?.gatewayModel;
    if (!route) return result;
    const model = { runtime: "managed" as const, modelId: route };
    const wire = result.text;
    if (Buffer.byteLength(wire) > 64 * 1024)
      throw new PaError("隔离输出超出网关调用上限", 413, "PA_CONTEXT_LIMIT");
    const key = `${attempt.id}:broker-dispatched`;
    if (this.store.hasEvent(key)) throw new PaError("此前网关调用结果待核对", 409, "PA_RESULT_UNKNOWN");
    const kernel = this.kernel!;
    kernel.policy.admits(task, model, null);
    kernel.policy.reserve(task, attempt, null, 0, { kind: "broker", model });
    this.store.audit(task.id, "gateway.broker_dispatched", {
      attemptId: attempt.id, model, requestDigest: digest(wire), requestBytes: Buffer.byteLength(wire),
    }, key);
    const response = await kernel.credentials.runtime.execute(model, wire, attempt.runId, signal);
    return { ...response, ...(result.workerReceipt ? { workerReceipt: result.workerReceipt } : {}) };
  }
  private async planSandbox(attempt: PaAttempt, prompt: string, signal: AbortSignal): Promise<PaAttempt> {
    const task = this.attemptAuthority(attempt, signal);
    const model = attempt.agentSnapshot.model;
    const kernel = this.kernel!;
    kernel.policy.admits(task, model, null);
    kernel.policy.reserve(task, attempt, null, 0, { kind: "plan", model });
    const result = await this.gateway.infer(attempt, `${prompt}\n\nFor this task, return only JSON {"script":"POSIX shell program"}. The program will run in /tmp as an unprivileged user. It has no network, external filesystem, provider credentials, or tools outside its container. Write the deliverable to stdout. Use only tools provided by a Debian Node image.`,
      signal, undefined, "plan");
    const parsed = parsePaJson(result.text);
    if (typeof parsed.script !== "string" || !parsed.script.trim() || Buffer.byteLength(parsed.script) > 64000)
      throw new PaError("智能体未生成有效的隔离脚本", 422, "PA_SANDBOX_INPUT");
    const work: WorkerWork = { kind: "shell", script: parsed.script };
    return this.store.transaction(() => {
      kernel.policy.admits(this.attemptAuthority(attempt, signal), model, work);
      const sha256 = digest(work.script);
      this.store.audit(task.id, "gateway.plan_received", { attemptId: attempt.id, sha256, usage: result.usage },
        `${attempt.id}:plan-received`);
      return this.store.update<PaAttempt>("attempts", attempt.id, {
        sandboxPlan: { script: work.script, sha256, receivedAt: Date.now() },
      });
    });
  }

  private dispatchWork(attempt: PaAttempt, prompt: string, work: WorkerWork | null, deadline: number, signal: AbortSignal): Promise<PaModelResult> {
    const task = this.attemptAuthority(attempt, signal);
    const kernel = this.kernel;
    const budgetMs = Math.max(1, deadline - Date.now());
    if (work?.kind === "shell" && !attempt.authority?.capabilities.includes("sandbox_exec"))
      throw new PaError("此尝试没有隔离执行授权", 403, "PA_CAPABILITY_DENIED");
    kernel?.policy.admits(task, attempt.agentSnapshot.model, work);
    kernel?.policy.reserve(task, attempt, work, budgetMs);
    const scheduler = kernel?.scheduler.distributed;
    const isolation = kernel?.isolation;
    const dispatch = task.execution?.target === "worker" && work && scheduler
      ? (wire: string, workSignal: AbortSignal) => scheduler.execute(attempt,
          work.kind === "ollama" ? { ...work, prompt: wire } : { ...work, script: wire }, budgetMs, workSignal)
      : work?.kind === "shell" && isolation
        ? async (wire: string, workSignal: AbortSignal): Promise<PaModelResult> => ({
            text: await isolation.execute(wire, budgetMs, workSignal), usage: { visibility: "unknown" },
          })
        : undefined;
    return this.gateway.infer(attempt, work?.kind === "shell" ? work.script : prompt, signal, dispatch);
  }
  private async commitPhase(attempt: PaAttempt, signal: AbortSignal): Promise<PaTask> {
    const task = this.attemptAuthority(attempt, signal);
    const { phase, output, agentSnapshot: agent } = attempt;
    if (attempt.modelReceipt?.outputSha256 !== digest(output))
      throw new PaError("模型回执与结果不一致", 409, "PA_RECEIPT_MISMATCH");
    const structured = phase === "respond" ? null : parsePaJson(output);
    const summary = typeof structured?.summary === "string" ? structured.summary.slice(0, 4000) : null;
    const issues = structured?.issues;
    const verification: string[] = [];
    let rejected = false;
    if (phase === "review") {
      if (typeof structured?.approved !== "boolean" || summary === null ||
        !Array.isArray(issues) || issues.some(issue => typeof issue !== "string"))
        throw new PaError("审阅结果格式无效", 422);
      const producer = attempt.evidenceAttemptId ? this.store.get<PaAttempt>("attempts", attempt.evidenceAttemptId) : null;
      if (!producer || producer.taskId !== task.id || producer.status !== "completed")
        throw new PaError("审阅证据已失效", 409, "PA_ARTIFACT_CONFLICT");
      if (producer?.resolvedModel && attempt.resolvedModel &&
        producer.resolvedModel.split(",").sort().join(",") === attempt.resolvedModel.split(",").sort().join(","))
        throw new PaError("两个模型配置实际解析为同一模型，请更换独立审阅模型", 409, "PA_AGENT_UNAVAILABLE");
      rejected = !structured.approved || issues.length > 0;
      if (!rejected && !task.amendments.some(item => item.appliedAt === null)) {
        const artifacts = this.store.list<PaArtifact>("artifacts").filter(item => item.attemptId === producer?.id);
        if (task.kind === "project" && !artifacts.length)
          throw new PaError("没有可验证的项目成果", 422);
        for (const artifact of artifacts) {
          if (!(await readVerifiedPaArtifact(this.projectRoot(task), artifact)))
            throw new PaError("成果在审阅期间发生变化，请重新核对", 409, "PA_ARTIFACT_CONFLICT");
        }
        if (artifacts.length) verification.push(`${artifacts.length} 个文件已读回并校验内容指纹`);
        verification.push(`独立模型审阅：${summary}`);
      }
    }
    const prepared = phase === "produce" ? await preparePaArtifacts(
      this.store, this.projectRoot(task), task, attempt, () => this.attemptAuthority(attempt, signal),
    ) : null;
    const messageContent = phase === "respond" ? summarizePaOutput(output, 8000) :
      (summary === null ? output.slice(0, 4000) : [summary, ...(Array.isArray(issues) ? issues : [])].join("\n")).slice(0, 8000);
    return this.store.transaction(() => {
      const latest = this.attemptAuthority(attempt, signal);
      if (this.store.require<PaAttempt>("attempts", attempt.id).status !== "running")
        throw new PaError("此尝试已提交或停止", 409, "PA_STALE_LEASE");
      prepared?.publish();
      const files = prepared?.files ?? [];
      this.store.update<PaAttempt>("attempts", attempt.id, {
        status: "completed", endedAt: attempt.modelReceipt!.receivedAt,
      });
      this.store.create<PaMessage>("messages", {
        conversationId: latest.conversationId, taskId: latest.id, senderId: agent.id,
        content: messageContent, model: agent.model, attemptId: attempt.id,
        targetAgentIds: [], replyTo: null,
        ...(attempt.memoryRefs ? { memoryRefs: attempt.memoryRefs } : {}),
        ...(attempt.dataClass ? { dataClass: attempt.dataClass } : {}),
      }, attempt.id);
      for (const file of files) this.store.create<PaArtifact>("artifacts", {
        ...file, ...(this.privateProject(latest) ? { privateStorage: true } : {}),
      }, digest(`${attempt.id}\0${file.path}`));
      if (files.length) {
        if (!this.privateProject(latest)) updateProject(this.deps.db, latest.projectId!, { updatedAt: Date.now() });
        this.store.audit(latest.id, "artifacts.verified", {
          attemptId: attempt.id,
          files: files.map(file => ({ path: file.path, sha256: file.sha256, baseVersionId: file.baseVersionId })),
        }, `${attempt.id}:artifacts`);
      }
      const amended = latest.amendments.some(item => item.appliedAt === null);
      if (amended || rejected) return this.store.update<PaTask>("tasks", latest.id, {
        status: "waiting",
        waitKind: amended ? "input" : "verification",
        waitingSince: Date.now(),
        nextParticipant: phase === "review" ? Math.max(0, latest.nextParticipant - 1) : latest.nextParticipant,
        waitingReason: amended ? "执行期间收到新要求，恢复后会重新执行并验收" : `审阅发现待改进项：${summary}`,
        evidence: rejected && !amended ? [...latest.evidence, `审阅：${summary}`] : latest.evidence,
      });
      return this.store.update<PaTask>("tasks", latest.id, {
        nextParticipant: latest.nextParticipant + 1,
        evidence: [...latest.evidence, ...verification],
      });
    });
  }
  private async run(id: string, abort: AbortController): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let currentAttempt: PaAttempt | undefined;
    let lease: PaExecutionLease | undefined;
    let timedOut = false;
    try {
      let task = this.store.require<PaTask>("tasks", id);
      const remainingMs = paRemainingTime(task, this.attempts(id));
      if (remainingMs <= 0)
        throw new PaError(
          "本任务累计执行时间已达到上限，请新建任务",
          429,
          "PA_BUDGET",
        );
      timeout = setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, remainingMs);
      const deadline = Date.now() + remainingMs;
      timeout.unref();
      while (task.nextParticipant < task.participantIds.length) {
        abort.signal.throwIfAborted();
        const scheduler = this.kernel?.scheduler.distributed;
        const acknowledged = this.attempts(id).filter(item => item.status === "running" &&
          (item.modelReceipt || scheduler?.has(item.runId) || item.sandboxPlan) && item.authority?.participantIndex === task.nextParticipant).at(-1);
        if (acknowledged) {
          currentAttempt = acknowledged;
          if (!acknowledged.modelReceipt) {
            this.attemptAuthority(acknowledged, abort.signal);
            const plan = acknowledged.sandboxPlan;
            const result = scheduler?.has(acknowledged.runId) ? await scheduler.wait(acknowledged.runId, abort.signal) :
              plan && plan.sha256 === digest(plan.script) && !this.store.hasEvent(`${acknowledged.id}:model-dispatched`)
                ? await this.dispatchWork(acknowledged, "", { kind: "shell", script: plan.script }, deadline, abort.signal)
                : (() => { throw new PaError("隔离执行回执待核对", 409, "PA_STOP_UNKNOWN"); })();
            const final = await this.brokerSandboxOutput(acknowledged, result, abort.signal);
            currentAttempt = this.acceptReceipt(acknowledged, final, abort.signal);
          }
          task = await this.commitPhase(currentAttempt, abort.signal);
          currentAttempt = undefined;
          if (task.status === "waiting") return;
          continue;
        }
        const agentId = task.participantIds[task.nextParticipant]!;
        task = this.assertAuthorized(id, agentId);
        const agent = this.store.require<PersonalAgent>("agents", agentId);
        if ((!hasSandbox(task) || task.execution?.generateScript) && !paRouteAllows(task.dataClass, agent.model.runtime))
          throw new PaError("本机专用任务需要为本阶段选择本机 Ollama", 409, "PA_ROUTE_DENIED");
        if ((!hasSandbox(task) || task.execution?.generateScript) && agent.model.runtime === "tokentosea" && this.deps.runtime.accountId &&
          (!task.authorization.providerAccountId || task.authorization.providerAccountId !== this.deps.runtime.accountId()))
          throw new PaError("请使用任务原授权的 TokenToSea 账号；未绑定账号的任务请重新发起", 403, "PA_MODEL_UNAVAILABLE");
        const reservedCostUsd = task.execution?.script ? undefined : this.reserveCost(task, agent);
        if (this.attempts(id).length >= task.budget.maxAttempts)
          throw new PaError("已达到本任务尝试次数上限", 429, "PA_BUDGET");
        if (task.kind === "project") task = await this.createProject(task);
        abort.signal.throwIfAborted();
        task = this.assertAuthorized(id, agentId);
        const phase =
          (task.reviewRequired ?? task.kind === "project") &&
          task.nextParticipant === task.participantIds.length - 1
            ? "review"
            : task.kind === "project" &&
                task.nextParticipant === task.participantIds.length - 2
              ? "produce"
              : "respond";
        if (phase === "review") {
          const producer = this.attempts(id)
            .filter(
              (attempt) =>
                attempt.status === "completed" && attempt.phase !== "review",
            )
            .at(-1);
          if (!producer || modelKey(producer.agentSnapshot) === modelKey(agent))
            throw new PaError(
              "实际执行与审阅必须使用不同模型，请调整审阅者配置",
              409,
              "PA_AGENT_UNAVAILABLE",
            );
        }
        task = this.store.update<PaTask>("tasks", id, {
          status: phase === "review" ? "verifying" : "running",
          waitingReason: null,
          amendments: task.amendments.map((item) => ({
            ...item,
            appliedAt: item.appliedAt ?? Date.now(),
          })),
        });
        const conversation = this.store.require<PaConversation>(
          "conversations",
          task.conversationId,
        );
        const memories = this.applicableMemories(
          conversation,
          agent.id,
          task.projectId,
          task.dataClass,
          task.principal?.kind === "enterprise" ? task.principal.id : undefined,
        );
        const selectedMemories = selectPaMemories(memories, [task.goal, ...task.amendments.map(item => item.content)].join("\n"));
        const visibleMemoryIds = new Set(memories.map((memory) => memory.id));
        const allowed = (refs: PaMessage["memoryRefs"]) =>
          this.memoryRefsCurrent(refs) &&
          (!refs || refs.every((ref) => visibleMemoryIds.has(ref.id)));
        const messages = this.store
          .list<PaMessage>("messages")
          .filter(
            (message) =>
              message.conversationId === conversation.id &&
              message.taskId !== id &&
              paCanReadClass(task.dataClass, message.dataClass) &&
              this.canRecallMessage(task, message) &&
              allowed(message.memoryRefs),
          )
          .slice(-20);
        const contributions = this.attempts(id).filter(
          (attempt) =>
            attempt.status === "completed" && paCanReadClass(task.dataClass, attempt.dataClass) && allowed(attempt.memoryRefs),
        );
        const latestEvidence = phase === "review" ? this.attempts(id).filter(attempt => attempt.status === "completed" &&
          attempt.phase === (task.kind === "project" ? "produce" : "respond")).at(-1) : undefined;
        const reviewEvidence = latestEvidence ? contributions.find(attempt => attempt.id === latestEvidence.id) : undefined;
        if (phase === "review" && !reviewEvidence) {
          this.store.update<PaTask>("tasks", id, {
            status: "waiting", waitKind: "verification", waitingSince: Date.now(),
            nextParticipant: Math.max(0, task.nextParticipant - 1),
            waitingReason: "审阅者无法读取当前成果或其来源，恢复后将重新生成",
          });
          return;
        }
        const history = preparePaHistory(messages, contributions, reviewEvidence?.id);
        const memoryRefs = [
          ...new Map(
            [
              ...selectedMemories.map((memory) => ({
                id: memory.id,
                revision: memory.revision,
              })),
              ...history.messages.flatMap((message) => message.memoryRefs ?? []),
              ...contributions.slice(-4).flatMap((attempt) => attempt.memoryRefs ?? []),
            ].map((ref) => [ref.id, ref]),
          ).values(),
        ];
        currentAttempt = this.store.create<PaAttempt>("attempts", {
          taskId: id,
          runId: randomUUID(),
          nodeId: this.node.id,
          protocolVersion: 1,
          agentSnapshot: agent,
          phase,
          dataClass: task.dataClass ?? "standard",
          authority: {
            principal: task.principal ?? { kind: "owner", id: "owner" },
            agentId,
            authorizationVersion: task.authorization.version,
            participantIndex: task.nextParticipant,
            capabilities: hasSandbox(task) ? ["respond", "sandbox_exec"] : phase === "produce" ? ["respond", "create_project"] : ["respond"],
          },
          status: "running",
          taskRevision: task.revision,
          memoryRefs,
          contextRefs: history.refs,
          ...(reservedCostUsd === undefined ? {} : { reservedCostUsd }),
          ...(reviewEvidence ? { evidenceAttemptId: reviewEvidence.id } : {}),
          startedAt: Date.now(),
          endedAt: null,
          output: "",
          error: null,
          usage: { visibility: "unknown" },
        });
        lease = {
          protocolVersion: 1,
          taskId: id,
          attemptId: currentAttempt.id,
          nodeId: this.node.id,
          generation: currentAttempt.revision,
          workspaceRef: task.projectId,
          credentialRef: agent.model.runtime,
          idempotencyKey: currentAttempt.runId,
        };
        if (
          !this.node.claim(
            lease,
            phase === "produce"
              ? "project-files"
              : phase === "review"
                ? "review"
                : "text",
          )
        )
          throw new PaError("执行节点无法领取该任务", 409);
        this.node.heartbeat(lease);
        heartbeat = setInterval(() => {
          if (lease && !abort.signal.aborted && !this.node.heartbeat(lease)) abort.abort();
        }, 10000);
        heartbeat.unref();
        const prompt = composePaPrompt({
          agent,
          task,
          phase,
          messages: history.messages,
          memories: selectedMemories,
          contributions: history.contributions,
        });
        if (task.execution?.generateScript) currentAttempt = await this.planSandbox(currentAttempt, prompt, abort.signal);
        const script = task.execution?.script ?? currentAttempt.sandboxPlan?.script;
        const work: WorkerWork | null = script !== undefined ? { kind: "shell", script } :
          task.execution?.target === "worker" ? { kind: "ollama", modelId: agent.model.modelId, prompt } : null;
        const result = await this.dispatchWork(currentAttempt, prompt, work, deadline, abort.signal);
        const finalResult = await this.brokerSandboxOutput(currentAttempt, result, abort.signal);
        currentAttempt = this.acceptReceipt(currentAttempt, finalResult, abort.signal, lease);
        task = await this.commitPhase(currentAttempt, abort.signal);
        clearInterval(heartbeat);
        this.node.release(lease);
        lease = undefined;
        currentAttempt = undefined;
        if (task.status === "waiting") return;
      }
      abort.signal.throwIfAborted();
      this.store.transaction(() => {
        task = this.assertAuthorized(id, task.participantIds.at(-1)!);
        if (task.amendments.some(item => item.appliedAt === null)) {
          this.store.update<PaTask>("tasks", id, {
            status: "waiting",
            waitKind: "input",
            waitingSince: Date.now(),
            nextParticipant: Math.max(0, task.nextParticipant - (task.reviewRequired ? 2 : 1)),
            waitingReason: "收到新要求，恢复后会重新执行并验收",
          });
          return;
        }
        this.store.update<PaTask>("tasks", id, {
          status: "completed",
          waitingReason: null,
          error: null,
          evidence: hasSandbox(task)
            ? [...task.evidence, "隔离执行标准输出已持久保存"]
            : task.kind === "discussion"
            ? [...task.evidence, "成员回答已持久保存；未执行外部操作"]
            : task.evidence,
        });
        this.proposeProcedure(task);
        this.store.audit(id, "task.completed", { nextParticipant: task.nextParticipant }, `${id}:completed`);
      });
    } catch (error) {
      const task = this.store.require<PaTask>("tasks", id);
      const isolatedRemote = !!currentAttempt && Boolean(this.kernel?.scheduler.distributed?.has(currentAttempt.runId));
      const brokerDispatched = !!currentAttempt && this.store.hasEvent(`${currentAttempt.id}:broker-dispatched`);
      if (isolatedRemote && !brokerDispatched && abort.signal.reason === PA_DETACH && !task.authorization.revoked) return;
      const code = error instanceof PaError ? error.code : "";
      const networkCode = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code ?? (error as { code?: unknown } | null)?.code;
      const networkUnavailable = code === 'PA_NETWORK' || typeof networkCode === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(networkCode);
      const cancelled = task.authorization.revoked;
      const dispatchedWithoutReceipt = currentAttempt && !currentAttempt.modelReceipt &&
        (this.store.hasEvent(`${currentAttempt.id}:model-dispatched`) || this.store.hasEvent(`${currentAttempt.id}:plan-dispatched`));
      const remoteUnknown =
        code === "PA_STOP_UNKNOWN" ||
        Boolean((brokerDispatched || !isolatedRemote && (!hasSandbox(task) || task.execution?.generateScript && !currentAttempt?.sandboxPlan)) && dispatchedWithoutReceipt && currentAttempt && !isPaLocalCliModel(currentAttempt.agentSnapshot.model) &&
          (networkUnavailable || abort.signal.aborted || code === "PA_RESULT_UNKNOWN" || networkCode === "tokentosea_billing_pending"));
      const message = networkUnavailable ? '网络连接中断，任务已保留；恢复网络后核对并继续' : timedOut
        ? "本次执行达到时间上限；已有成果保留"
        : error instanceof PaError
          ? error.message
          : abort.signal.aborted
            ? "执行已中断；已有成果保留"
            : "执行失败，请检查模型连接后重试";
      if (lease && abort.signal.aborted && !remoteUnknown) {
        try { this.node.event({ lease, eventId: `${lease.attemptId}:cancelled`, kind: "cancelled", at: Date.now() }); }
        catch (error) { if (!(error instanceof PaError) || error.code !== "PA_STALE_LEASE") throw error; }
      }
      if (currentAttempt?.status === "running")
        this.store.update<PaAttempt>("attempts", currentAttempt.id, {
          status: remoteUnknown
            ? "interrupted"
            : cancelled
              ? "cancelled"
              : "failed",
          endedAt: Date.now(),
          durationMs: Math.max(0, (this.active.get(id)?.pauseRequestedAt ?? Date.now()) - currentAttempt.startedAt),
          error: message,
        });
      this.store.update<PaTask>("tasks", id, {
        status: remoteUnknown
          ? cancelled
            ? "cancelling"
            : "waiting"
          : cancelled
            ? "cancelled"
            : timedOut || networkUnavailable ||
                code === "PA_MODEL_UNAVAILABLE" ||
                code === "PA_AGENT_UNAVAILABLE" ||
                code === "PA_ROUTE_DENIED" ||
                code === "PA_WORKER_UNAVAILABLE" ||
                code === "PA_SANDBOX_UNAVAILABLE" ||
                code === "PA_DELEGATION_DENIED" ||
                code === "PA_BUDGET" ||
                this.stopping ||
                task.status === "waiting"
              ? "waiting"
              : "failed",
        ...(abort.signal.aborted || remoteUnknown
          ? {
              stopConfirmation: remoteUnknown
                ? ("unknown" as const)
                : ("confirmed" as const),
            }
          : {}),
        waitingReason: remoteUnknown
          ? "已停止新调度；执行者或模型服务端结果待核对"
          : cancelled
            ? null
            : ['paused', 'device'].includes(task.waitKind ?? '') ? task.waitingReason : message,
        waitingSince: Date.now(),
        ...(timedOut ? { timeBudgetExhausted: true } : {}),
        waitKind: remoteUnknown ? 'external_result' : task.waitKind ?? (networkUnavailable ? 'network' : code === 'PA_BUDGET' || timedOut ? 'budget' : code === 'PA_MODEL_UNAVAILABLE' ? 'login' : code === 'PA_ROUTE_DENIED' ? 'agent' : code === 'PA_WORKER_UNAVAILABLE' || code === 'PA_SANDBOX_UNAVAILABLE' ? 'device' : 'recovery'),
        error: cancelled ? null : message,
      });
      this.store.event(id, "task.interrupted", { code, message });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (lease) this.node.release(lease);
    }
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.maintenance);
    this.queue.clear();
    for (const [id, entry] of this.active) {
      const active = this.attempts(id).filter(item => item.status === "running").at(-1);
      if (active && this.kernel?.scheduler.distributed?.has(active.runId)) entry.abort.abort(PA_DETACH);
      else entry.abort.abort();
    }
    await Promise.allSettled(
      [...this.active.values()].map((entry) => entry.done),
    );
  }
  private memoryDir(): string {
    return path.join(this.deps.dataDir, "pa", "memory");
  }
  private canRecallMessage(task: PaTask, message: PaMessage): boolean {
    if (task.principal?.kind !== "enterprise") return true;
    const previous = message.taskId ? this.store.get<PaTask>("tasks", message.taskId)?.principal : undefined;
    return previous?.kind === "enterprise" && previous.tenantId === task.principal.tenantId && previous.id === task.principal.id;
  }
  private projectRoot(task: PaTask): string {
    if (this.kernel?.storage.privateProjects)
      return task.dataClass === "local_only" ? path.join(this.deps.dataDir, "private-projects") : this.deps.projectsDir;
    return task.dataClass === "local_only" ? path.join(this.deps.dataDir, "pa", "private-projects") : this.deps.projectsDir;
  }
  private privateProject(task: PaTask): boolean {
    return task.dataClass === "local_only" || this.kernel?.storage.privateProjects === true;
  }
  async downloadPrivateArtifact(id: string): Promise<{ name: string; bytes: Buffer }> {
    const artifact = this.store.require<PaArtifact>("artifacts", id);
    const task = this.store.require<PaTask>("tasks", artifact.taskId);
    if (!this.privateProject(task) || artifact.projectId !== task.projectId)
      throw new PaError("未找到本机专用成果", 404);
    const bytes = await readVerifiedPaArtifact(this.projectRoot(task), artifact);
    if (!bytes) throw new PaError("本机成果缺失或已改变", 409, "PA_ARTIFACT_CONFLICT");
    return { name: path.basename(artifact.path), bytes };
  }
  async mergeArtifacts(taskId: string, input: PaArtifactMerge): Promise<PaArtifact> {
    const task = this.store.require<PaTask>("tasks", taskId);
    const left = this.store.require<PaArtifact>("artifacts", input.leftVersionId);
    const right = this.store.require<PaArtifact>("artifacts", input.rightVersionId);
    if (left.id === right.id || left.taskId !== task.id || right.taskId !== task.id ||
      left.projectId !== task.projectId || right.projectId !== task.projectId ||
      (left.dataClass ?? "standard") !== (task.dataClass ?? "standard") ||
      (right.dataClass ?? "standard") !== (task.dataClass ?? "standard") ||
      path.basename(left.path).toLowerCase() !== path.basename(right.path).toLowerCase())
      throw new PaError("请选择同一任务中同一文件的两个版本", 409, "PA_ARTIFACT_CONFLICT");
    const id = digest(JSON.stringify([task.id, left.id, right.id, digest(input.content)]));
    const previous = this.store.get<PaArtifact>("artifacts", id);
    if (previous) return previous;
    const check = () => {
      const current = this.store.require<PaTask>("tasks", task.id);
      if (current.status !== "completed" || current.revision !== input.revision ||
        !this.privateProject(task) && !this.managedLocalProject(task.projectId!))
        throw new PaError("请刷新已完成任务，核对成果后重试", 409, "PA_REVISION_CONFLICT");
    };
    check();
    const root = this.projectRoot(task);
    const inputs = await Promise.all([readVerifiedPaArtifact(root, left), readVerifiedPaArtifact(root, right)]);
    if (inputs.some(value => value === null))
      throw new PaError("有源版本缺失或已改变，请核对后合并", 409, "PA_ARTIFACT_CONFLICT");
    const prepared = await preparePaArtifactMerge(this.store, root, task, left, right, id, input.content, check);
    return this.store.transaction(() => {
      const committed = this.store.get<PaArtifact>("artifacts", id);
      if (committed) return committed;
      check();
      prepared.publish();
      const result = this.store.create<PaArtifact>("artifacts", {
        ...prepared.file,
        ...(this.privateProject(task) ? { privateStorage: true } : {}),
        verification: [...prepared.file.verification, "所有者显式合并"],
      }, id);
      this.store.update<PaTask>("tasks", task.id, {}, input.revision);
      if (!this.privateProject(task)) updateProject(this.deps.db, task.projectId!, { updatedAt: Date.now() });
      this.store.audit(task.id, "artifacts.owner_merged", {
        artifactId: result.id, parents: result.mergedFrom, sha256: result.sha256, principal: "owner",
      }, `${result.id}:merged`);
      return result;
    });
  }
  private proposeProcedure(task: PaTask): void {
    if (task.channelId || task.routineId || !task.reviewRequired) return;
    const review = this.attempts(task.id).filter(item => item.phase === "review" && item.status === "completed").at(-1);
    if (!review || !this.memoryRefsCurrent(review.memoryRefs)) return;
    const result = parsePaJson(review.output);
    if (result.approved !== true || !Array.isArray(result.issues) || result.issues.length ||
      typeof result.procedure !== "string" || !result.procedure.trim() || result.procedure.length > 2000) return;
    this.store.create<PaMemoryCandidate>("memory_candidates", {
      taskId: task.id, attemptId: review.id, status: "pending", dataClass: task.dataClass ?? "standard",
      content: result.procedure.trim(),
    }, task.id);
  }
  resolveMemoryCandidate(id: string, revision: number, accept: boolean): PaMemoryCandidate {
    const item = this.store.require<PaMemoryCandidate>("memory_candidates", id);
    if (item.revision !== revision || item.status !== "pending")
      throw new PaError("记忆候选已处理，请刷新", 409, "PA_REVISION_CONFLICT");
    return this.store.transaction(() => {
      if (!accept) return this.store.update<PaMemoryCandidate>("memory_candidates", id, { status: "dismissed", content: "" }, revision);
      const task = this.store.require<PaTask>("tasks", item.taskId);
      const attempt = this.store.require<PaAttempt>("attempts", item.attemptId);
      if (task.status !== "completed" || !this.memoryRefsCurrent(attempt.memoryRefs))
        throw new PaError("候选的任务或来源已失效", 409, "PA_REVISION_CONFLICT");
      const memory = this.saveMemory({
        content: item.content, kind: "procedure", scope: task.projectId && !this.privateProject(task) ? "project" : "private",
        scopeId: this.privateProject(task) ? null : task.projectId, dataClass: item.dataClass, source: `PA task ${item.taskId} / attempt ${item.attemptId}`,
      }, undefined, undefined, task.principal?.kind === "enterprise" ? task.principal.id : undefined);
      return this.store.update<PaMemoryCandidate>("memory_candidates", id, { status: "accepted", content: "", memoryId: memory.id }, revision);
    });
  }
  memoryRefsCurrent(refs: PaMessage["memoryRefs"]): boolean {
    return (
      !refs ||
      refs.every(
          (ref) => {
            const memory = this.store.get<PaMemory>("memories", ref.id);
            if (memory) return memory.revision === ref.revision && paMemoryActive(memory);
            const version = this.store.get<PaMemoryVersion>("memory_versions", ref.id);
            const latest = version ? this.store.get<PaMemory>("memories", version.memoryId) : null;
            return version?.revision === ref.revision && latest !== null &&
              this.memoryVersionApplicable(version, latest);
          },
      )
    );
  }
  private invalidateMemoryReaders(id: string): void {
    for (const task of this.store.list<PaTask>("tasks")) {
      if (terminal.has(task.status) || task.authorization.revoked) continue;
      const affected = this.attempts(task.id).find((attempt) =>
        attempt.memoryRefs?.some((ref) => ref.id === id),
      );
      if (!affected) continue;
      this.store.update<PaTask>("tasks", task.id, {
        status: "waiting",
        nextParticipant: 0,
        waitingReason: "相关记忆已修正或删除；恢复后将使用新的上下文重新执行",
      });
      this.queue.delete(task.id);
      this.active.get(task.id)?.abort.abort();
    }
  }
  memories(): PaMemory[] {
    return this.store.list<StoredPaMemory>("memories").map(memory => this.readMemory(memory));
  }
  memoryHistory(id: string): Array<{ revision: number; memory: PaMemory }> {
    const current = this.store.require<StoredPaMemory>("memories", id);
    return [
      ...this.store.list<PaMemoryVersion>("memory_versions").filter(item => item.memoryId === id)
        .map(item => ({ revision: item.sourceRevision, memory: this.readMemory(item) })),
      { revision: current.revision, memory: this.readMemory(current) },
    ];
  }
  private readMemory(memory: StoredPaMemory): PaMemory {
    const { fileName, ...metadata } = memory;
    try {
      return { ...metadata, content: readFileSync(path.join(this.memoryDir(), fileName ?? `${memory.id}.md`), "utf8") };
    } catch {
      return { ...metadata, content: "" };
    }
  }
  private memoryVersionApplicable(version: PaMemoryVersion, latest: PaMemory): boolean {
    return paMemoryActive(version) && (latest.validFrom ?? 0) > Date.now() &&
      latest.scope === version.scope && latest.scopeId === version.scopeId && latest.dataClass === version.dataClass;
  }
  private applicableMemories(
    conversation: PaConversation,
    agentId: string,
    projectId: string | null,
    dataClass: PaTask["dataClass"],
    principalId?: string,
  ): PaMemory[] {
    const records = this.store.list<StoredPaMemory>("memories");
    const byId = new Map(records.map(item => [item.id, item]));
    const applicableVersions = this.store.list<PaMemoryVersion>("memory_versions").filter(item => {
      const latest = byId.get(item.memoryId);
      return latest && this.memoryVersionApplicable(item, latest);
    });
    return [...records, ...applicableVersions]
      .filter(memory => this.kernel?.mode !== "enterprise" || Boolean(principalId) && memory.principalId === principalId)
      .filter(memory => paMemoryActive(memory) && paCanReadClass(dataClass, memory.dataClass))
      .filter(memory => !conversation.channelId || (conversation.allowSharedMemory === true && memory.scope === 'group' && memory.scopeId === conversation.groupId))
      .filter((memory) =>
        conversation.groupId
          ? (memory.scope === "group" &&
              memory.scopeId === conversation.groupId) ||
            (memory.scope === "project" &&
              Boolean(projectId) &&
              memory.scopeId === projectId)
          : memory.scope === "private" ||
            (memory.scope === "agent" && memory.scopeId === agentId) ||
            (memory.scope === "project" &&
              Boolean(projectId) &&
              memory.scopeId === projectId),
      )
      .map(memory => this.readMemory(memory))
      .filter(memory => memory.content);
  }
  saveMemory(input: PaMemoryInput, id?: string, revision?: number, principalId?: string): PaMemory {
    if (this.kernel?.mode === "enterprise" && (!principalId || input.scope !== "private"))
      throw new PaError("企业记忆须绑定已授权的个人作用域", 403, "PA_CAPABILITY_DENIED");
    if (input.scope !== "private" && !input.scopeId)
      throw new PaError("请选择记忆适用的智能体、群组或项目");
    if (input.scope === "agent") this.store.require("agents", input.scopeId!);
    if (input.scope === "group") this.store.require("groups", input.scopeId!);
    if (input.scope === "project" && !getProject(this.deps.db, input.scopeId!))
      throw new PaError("项目不存在");
    if (
      id &&
      this.store.require<PaMemory>("memories", id).revision !== revision
    )
      throw new PaError("记忆已更新，请刷新后重试", 409);
    const memoryId = id ?? randomUUID();
    const old = id ? this.store.require<StoredPaMemory>("memories", id) : null;
    const kind = input.kind ?? old?.kind;
    const dataClass = input.dataClass ?? old?.dataClass;
    const validFrom = input.validFrom ?? (kind === "fact" ? Date.now() : old?.validFrom);
    const validUntil = input.validUntil === undefined ? old?.validUntil : input.validUntil;
    if (validUntil != null && validUntil <= (validFrom ?? 0))
      throw new PaError("记忆失效时间必须晚于生效时间");
    const archive = old?.kind === "fact" && kind === "fact" && validFrom! > (old.validFrom ?? 0) &&
      old.scope === input.scope && old.scopeId === input.scopeId && old.dataClass === dataClass;
    const fileName = `${memoryId}-${randomUUID()}.md`;
    const file = path.join(this.memoryDir(), fileName);
    writeFileSync(file, input.content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    // Markdown is the only content source. The SQLite row stores metadata only.
    const metadata = { ...input, kind, dataClass, validFrom, validUntil, content: "", fileName,
      ...(principalId ? { principalId: old?.principalId ?? principalId } : {}) };
    let memory: StoredPaMemory;
    try {
      memory = this.store.transaction(() => {
        if (archive) this.store.create<PaMemoryVersion>("memory_versions", {
          ...old,
          fileName: old.fileName ?? `${old.id}.md`,
          memoryId,
          sourceRevision: old.revision,
          validUntil: Math.min(old.validUntil ?? Infinity, validFrom!),
        }, `${memoryId}:${old.revision}`);
        return id
          ? this.store.update<StoredPaMemory>("memories", id, metadata, revision)
          : this.store.create<StoredPaMemory>("memories", metadata, memoryId);
      });
    } catch (error) {
      try {
        unlinkSync(file);
      } catch {
        /* unreferenced content is never recalled */
      }
      throw error;
    }
    if (old && !archive) {
      try {
        unlinkSync(path.join(this.memoryDir(), old.fileName ?? `${old.id}.md`));
      } catch {
        /* stale content is never recalled */
      }
    }
    if (id) this.invalidateMemoryReaders(id);
    return { ...memory, content: input.content };
  }
  deleteMemory(id: string): void {
    const memory = this.store.require<StoredPaMemory>("memories", id);
    const history = this.store.list<PaMemoryVersion>("memory_versions").filter(item => item.memoryId === id);
    this.store.transaction(() => {
      this.store.remove("memories", id);
      for (const item of history) this.store.remove("memory_versions", item.id);
    });
    for (const key of [id, ...history.map(item => item.id)]) this.invalidateMemoryReaders(key);
    for (const item of [memory, ...history]) {
      try { unlinkSync(path.join(this.memoryDir(), item.fileName ?? `${item.id}.md`)); }
      catch { /* metadata deletion already removed all recall authority */ }
    }
  }
}
