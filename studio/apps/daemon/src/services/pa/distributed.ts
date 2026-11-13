import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { PaAttempt, PaEntity, PaTask } from "@open-design/contracts";
import type { PaModelResult } from "../../runtimes/personal-agent.js";
import { PaError, type PaStore } from "../../storage/personal-agent-store.js";
import { paDigest, redactPaCredentials } from "../personal-agent-gateway.js";
import type { PaConfig, PaWorkerIdentity } from "./config.js";

export const PA_DETACH = "pa-controller-shutdown";
export const workerWorkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell"), script: z.string().min(1).max(64000) }).strict(),
  z.object({ kind: z.literal("ollama"), modelId: z.string().min(1).max(200), prompt: z.string().min(1).max(768 * 1024) }).strict(),
]);
export const workerLeaseSchema = z.object({
  runId: z.string().uuid(), generation: z.number().int().positive(), leaseId: z.string().uuid(),
}).strict();
export const workerResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), output: z.string().min(1).max(2 * 1024 * 1024) }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(["PA_SANDBOX_UNAVAILABLE", "PA_SANDBOX_FAILED", "PA_SANDBOX_OUTPUT", "PA_WORKER_FAILED"]) }).strict(),
]);
export type WorkerWork = z.infer<typeof workerWorkSchema>;
export type WorkerLease = z.infer<typeof workerLeaseSchema>;
export type WorkerResult = z.infer<typeof workerResultSchema>;
export type WorkerAssignment = WorkerLease & { work: WorkerWork; workHash: string; leaseMs: number; timeoutMs: number };
type Dispatch = PaEntity & {
  taskId: string; attemptId: string; authorityVersion: number;
  work: WorkerWork | null; workHash: string;
  state: "pending" | "leased" | "completed" | "cancelled" | "unavailable";
  generation: number; workerId: string | null; leaseId: string | null; leaseUntil: number;
  deadline: number; skippedWorkers: string[]; preferredWorker?: string | undefined;
  result?: WorkerResult; resultHash?: string;
};

/** Only effect-free operations are eligible for reassignment after fencing. */
export class PaDistributedScheduler {
  constructor(
    private readonly store: PaStore,
    private readonly config: Pick<PaConfig, "workers" | "leaseMs" | "maxHandoffs">,
    private readonly validPrincipal: (task: PaTask) => boolean,
    private readonly validWorker: (worker: PaWorkerIdentity) => boolean,
  ) {}

  has(runId: string): boolean {
    return this.store.get<Dispatch>("dispatches", runId) !== null;
  }

  private permitted(job: Dispatch): boolean {
    const task = this.store.get<PaTask>("tasks", job.taskId);
    return !!task && !task.authorization.revoked && task.authorization.version === job.authorityVersion &&
      task.dataClass !== "local_only" && ["queued", "running", "verifying"].includes(task.status) &&
      this.store.get<PaAttempt>("attempts", job.attemptId)?.status === "running" && this.validPrincipal(task);
  }

  private supports(worker: PaWorkerIdentity, work: WorkerWork | null): boolean {
    return !!work && worker.expiresAt > Date.now() && this.validWorker(worker) && worker.capabilities.includes(work.kind) &&
      (work.kind !== "ollama" || worker.models.includes(work.modelId));
  }

  private updateExpired(job: Dispatch, now: number): Dispatch {
    if (job.state !== "pending" && job.state !== "leased") return job;
    if (!this.permitted(job) || job.deadline <= now)
      return this.store.update<Dispatch>("dispatches", job.id, { state: "cancelled", work: null }, job.revision);
    if (job.state === "pending" && !this.config.workers.some(worker =>
      !job.skippedWorkers.includes(worker.id) && (!job.preferredWorker || job.preferredWorker === worker.id) && this.supports(worker, job.work)))
      return this.store.update<Dispatch>("dispatches", job.id, { state: "unavailable", work: null }, job.revision);
    const assigned = this.config.workers.find(worker => worker.id === job.workerId);
    if (job.state !== "leased" || job.leaseUntil > now && assigned && this.supports(assigned, job.work)) return job;
    const skippedWorkers = [...new Set([...job.skippedWorkers, job.workerId!])];
    const canMove = job.generation <= this.config.maxHandoffs && this.config.workers.some(worker =>
      !skippedWorkers.includes(worker.id) && this.supports(worker, job.work));
    this.store.audit(job.taskId, "worker.fenced", {
      workerId: job.workerId, generation: job.generation, workHash: job.workHash, reason: "lease_expired",
    }, `${job.id}:fence:${job.generation}`);
    return this.store.update<Dispatch>("dispatches", job.id, {
      state: canMove ? "pending" : "unavailable", skippedWorkers, preferredWorker: undefined,
      ...(canMove ? {} : { work: null }),
    }, job.revision);
  }

  async execute(attempt: PaAttempt, work: WorkerWork, timeoutMs: number, signal: AbortSignal): Promise<PaModelResult> {
    signal.throwIfAborted();
    const safeWork = work.kind === "ollama" ? { ...work, prompt: redactPaCredentials(work.prompt) } : work;
    if (!this.config.workers.some(worker => this.supports(worker, safeWork)))
      throw new PaError("没有具备此能力的已登记执行设备", 409, "PA_WORKER_UNAVAILABLE");
    const hash = paDigest(JSON.stringify(safeWork));
    this.store.transaction(() => {
      const prior = this.store.get<Dispatch>("dispatches", attempt.runId);
      if (prior) {
        if (prior.workHash !== hash) throw new PaError("派发参数已变化", 409, "PA_STALE_LEASE");
        return;
      }
      const job = this.store.create<Dispatch>("dispatches", {
        taskId: attempt.taskId, attemptId: attempt.id, authorityVersion: attempt.authority!.authorizationVersion,
        work: safeWork, workHash: hash, state: "pending", generation: 0, workerId: null, leaseId: null,
        leaseUntil: 0, deadline: Date.now() + Math.min(timeoutMs, 1800000), skippedWorkers: [],
      }, attempt.runId);
      this.store.audit(attempt.taskId, "worker.enqueued", {
        runId: job.id, attemptId: attempt.id, kind: safeWork.kind, workHash: hash,
      }, `${job.id}:enqueued`);
    });
    return this.wait(attempt.runId, signal);
  }

  async wait(runId: string, signal: AbortSignal): Promise<PaModelResult> {
    try {
      while (!signal.aborted) {
        const job = this.store.transaction(() => this.updateExpired(this.store.require<Dispatch>("dispatches", runId), Date.now()));
        if (job.state === "completed" && job.result) {
          if (!job.result.ok) throw new PaError("远端隔离执行失败", 422, job.result.code);
          return {
            text: job.result.output, usage: { visibility: "unknown" },
            workerReceipt: { workerId: job.workerId!, generation: job.generation, workHash: job.workHash },
          };
        }
        if (job.state === "unavailable") throw new PaError("旧租约已失效，等待可用执行设备", 409, "PA_WORKER_UNAVAILABLE");
        if (job.state === "cancelled") throw new PaError("执行租约已终止", 409, "PA_WORKER_UNAVAILABLE");
        await delay(150, undefined, { signal });
      }
      signal.throwIfAborted();
      throw new Error("Remote execution stopped");
    } finally {
      if (signal.aborted && signal.reason !== PA_DETACH) this.cancel(runId);
    }
  }

  cancel(runId: string): void {
    this.store.transaction(() => {
      const job = this.store.get<Dispatch>("dispatches", runId);
      if (!job || (job.state !== "pending" && job.state !== "leased")) return;
      this.store.update<Dispatch>("dispatches", runId, { state: "cancelled", work: null }, job.revision);
      this.store.audit(job.taskId, "worker.fenced", { workerId: job.workerId, generation: job.generation, reason: "cancelled" },
        `${job.id}:fence:${job.generation}`);
    });
  }

  claim(worker: PaWorkerIdentity, offered: readonly WorkerWork["kind"][] = worker.capabilities): WorkerAssignment | null {
    return this.store.transaction(() => {
      const now = Date.now();
      const jobs = this.store.list<Dispatch>("dispatches");
      if (jobs.some(job => job.workerId === worker.id && job.state === "leased" && job.leaseUntil > now && this.permitted(job))) return null;
      for (const candidate of jobs) {
        const job = this.updateExpired(candidate, now);
        if (job.state !== "pending" || !job.work || !offered.includes(job.work.kind) || !this.supports(worker, job.work) ||
          job.skippedWorkers.includes(worker.id) || job.preferredWorker && job.preferredWorker !== worker.id) continue;
        const leaseId = randomUUID();
        const generation = job.generation + 1;
        this.store.update<Dispatch>("dispatches", job.id, {
          state: "leased", workerId: worker.id, leaseId, generation, leaseUntil: Math.min(job.deadline, now + this.config.leaseMs),
        }, job.revision);
        this.store.audit(job.taskId, "worker.claimed", { workerId: worker.id, generation, workHash: job.workHash },
          `${job.id}:claim:${generation}`);
        return { runId: job.id, generation, leaseId, work: job.work, workHash: job.workHash, leaseMs: this.config.leaseMs, timeoutMs: job.deadline - now };
      }
      return null;
    });
  }

  heartbeat(worker: PaWorkerIdentity, lease: WorkerLease): void {
    this.store.transaction(() => {
      const job = this.current(worker, lease);
      this.store.update<Dispatch>("dispatches", job.id, { leaseUntil: Math.min(job.deadline, Date.now() + this.config.leaseMs) }, job.revision);
    });
  }

  complete(worker: PaWorkerIdentity, lease: WorkerLease, result: WorkerResult): void {
    const safe = result.ok ? { ...result, output: redactPaCredentials(result.output) } : result;
    if (safe.ok && Buffer.byteLength(safe.output) > 2 * 1024 * 1024)
      throw new PaError("执行设备输出超过上限", 413, "PA_WORKER_FAILED");
    const hash = paDigest(JSON.stringify(safe));
    this.store.transaction(() => {
      const prior = this.store.get<Dispatch>("dispatches", lease.runId);
      if (prior?.state === "completed" && this.matches(prior, worker, lease) && prior.resultHash === hash) return;
      const job = this.current(worker, lease);
      this.store.update<Dispatch>("dispatches", job.id, { state: "completed", result: safe, resultHash: hash, work: null }, job.revision);
      this.store.audit(job.taskId, "worker.receipt", { workerId: worker.id, generation: lease.generation, workHash: job.workHash, resultHash: hash },
        `${job.id}:result:${lease.generation}`);
    });
  }

  migrate(taskId: string, workerId: string, revision: number): void {
    this.store.transaction(() => {
      const task = this.store.require<PaTask>("tasks", taskId);
      if (task.revision !== revision) throw new PaError("任务已更新，请刷新", 409, "PA_REVISION_CONFLICT");
      const job = this.store.list<Dispatch>("dispatches").find(item =>
        item.taskId === task.id && (item.state === "pending" || item.state === "leased"));
      const worker = this.config.workers.find(item => item.id === workerId);
      if (!job || !worker || !this.supports(worker, job.work) || job.workerId === workerId ||
        job.generation > this.config.maxHandoffs || !this.permitted(job))
        throw new PaError("目标设备不可用，或任务已经无法迁移", 409, "PA_WORKER_UNAVAILABLE");
      if (job.state === "leased") this.store.audit(taskId, "worker.fenced",
        { workerId: job.workerId, generation: job.generation, reason: "migration" }, `${job.id}:fence:${job.generation}`);
      this.store.update<Dispatch>("dispatches", job.id, {
        state: "pending", preferredWorker: workerId, leaseUntil: 0, skippedWorkers: job.skippedWorkers.filter(id => id !== workerId),
      }, job.revision);
      this.store.update<PaTask>("tasks", taskId, {}, revision);
    });
  }

  private matches(job: Dispatch, worker: PaWorkerIdentity, lease: WorkerLease): boolean {
    return job.workerId === worker.id && job.generation === lease.generation && job.leaseId === lease.leaseId;
  }

  private current(worker: PaWorkerIdentity, lease: WorkerLease): Dispatch {
    const job = this.store.get<Dispatch>("dispatches", lease.runId);
    if (!job || job.state !== "leased" || !this.matches(job, worker, lease) || job.leaseUntil <= Date.now() || !this.permitted(job))
      throw new PaError("执行租约已失效", 409, "PA_STALE_LEASE");
    return job;
  }
}
