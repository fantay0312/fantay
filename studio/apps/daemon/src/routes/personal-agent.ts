import type { Express, Request, Response } from "express";
import { userInfo } from "node:os";
import { z } from "zod";
import {
  paAgentInputSchema,
  paGroupInputSchema,
  paGoalInputSchema,
  paRoutineInputSchema,
  paMemoryInputSchema,
  paTaskInputSchema,
  paArtifactMergeSchema,
  paControlPatchSchema,
} from "@open-design/contracts";
import type { PaArtifact, PaAttempt, PaConversation, PaMemory, PaMemoryCandidate, PaMessage, PaTask } from "@open-design/contracts";
import type { PersonalAgentService } from "../services/personal-agent-service.js";
import type { PersonalAgentChannels } from "../services/personal-agent-channels.js";
import { PaError } from "../storage/personal-agent-store.js";
import { isTokenToSeaWriteOrigin } from "../http/tokentosea-origin.js";
import { transcribePaVoice } from "../services/personal-agent-voice.js";
import { paWorkerCaps, type PaMember } from "../services/pa/config.js";
import { workerLeaseSchema, workerResultSchema } from "../services/pa/distributed.js";

export interface RegisterPersonalAgentRoutesDeps {
  personalAgent: PersonalAgentService;
  personalAgentChannels: PersonalAgentChannels;
}
export function registerPersonalAgentRoutes(
  app: Express,
  { personalAgent: service, personalAgentChannels: channels }: RegisterPersonalAgentRoutesDeps,
): void {
  const revision = {
    parse(value: unknown): number {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 1
      )
        throw new PaError("需要有效的内容版本");
      return value;
    },
  };
  const text = (value: unknown, max = 16000): string => {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new PaError("请输入有效内容");
    return value.trim();
  };
  const taskInput = (req: Request) => paTaskInputSchema.parse({
    ...req.body,
    budget: req.body?.budget && typeof req.body.budget === "object" && !Array.isArray(req.body.budget)
      ? { ...service.defaultTaskBudget(), ...req.body.budget }
      : req.body?.budget ?? service.defaultTaskBudget(),
  });
  const kernel = service.kernel;
  const enterprise = kernel?.mode === "enterprise";
  const memberOf = (req: Request) => req.res?.locals.paMember as PaMember | undefined;
  const canSee = (req: Request, task: PaTask) => !enterprise || !!memberOf(req) && kernel!.policy.owns(memberOf(req)!, task);
  const handle =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const result = await fn(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        const validationError =
          error instanceof Error && error.name === "ZodError";
        const status =
          error instanceof PaError ? error.status : validationError ? 400 : 500;
        res
          .status(status)
          .json({
            error: {
              code: error instanceof PaError ? error.code : "PA_REQUEST_FAILED",
              message:
                error instanceof PaError
                  ? error.message
                  : validationError
                    ? "输入格式不正确，请检查必填项"
                    : "PA 操作失败，请重试",
            },
          });
      }
    };
  app.use("/api/pa", (req, res, next) => {
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress ?? "",
      )
    ) {
      res
        .status(403)
        .json({
          error: { code: "PA_LOCAL_ONLY", message: "PA 目前仅支持本机访问" },
        });
      return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site" || !isTokenToSeaWriteOrigin(req)) {
      res
        .status(403)
        .json({
          error: { code: "PA_INVALID_ORIGIN", message: "请求来源无效" },
        });
      return;
    }
    next();
  });
  app.get("/api/pa/mode", handle(req => {
    const member = enterprise ? kernel!.identity.member(req.get("authorization")) : null;
    return { mode: kernel?.mode ?? "personal", authorized: !enterprise || !!member, ...(member ? { role: member.role, tenantId: kernel!.tenantId } : {}) };
  }));
  for (const action of ["claim", "heartbeat", "result"] as const) {
    app.post(`/api/pa/workers/${action}`, handle(req => {
      const worker = kernel?.identity.worker(req.get("authorization"));
      const scheduler = kernel?.scheduler.distributed;
      if (!worker || !scheduler) throw new PaError("执行设备未登记或授权已撤销", 401, "PA_WORKER_AUTH");
      if (action === "claim") {
        const offer = z.object({ capabilities: z.array(paWorkerCaps).max(2).optional() }).strict().parse(req.body);
        return scheduler.claim(worker, offer.capabilities);
      }
      if (action === "heartbeat") scheduler.heartbeat(worker, workerLeaseSchema.parse(req.body));
      else {
        const { lease, result } = z.object({ lease: workerLeaseSchema, result: workerResultSchema }).strict().parse(req.body);
        scheduler.complete(worker, lease, result);
      }
      return { ok: true };
    }));
  }
  if (enterprise) app.use("/api/pa", (req, res, next) => {
    const member = kernel!.identity.member(req.get("authorization"));
    const deny = (status: number, code: string, message: string) => res.status(status).json({ error: { code, message } });
    if (!member) return deny(401, "PA_ENTERPRISE_AUTH", "需要企业访问令牌");
    res.locals.paMember = member;
    const read = req.method === "GET" || req.method === "HEAD";
    const resource = req.path;
    const shared = ["/", "/models", "/control", "/activity", "/feed", "/projects", "/node"].includes(resource);
    const admin = member.role === "admin" && (
      /^\/(?:agents|groups|conversations)(?:\/[a-zA-Z0-9_-]+(?:\/clone)?)?$/.test(resource) ||
      ["/audit", "/audit/verify", "/control", "/enterprise/revoke"].includes(resource));
    if (admin || read && shared || !read && member.role !== "viewer" && ["/tasks", "/memories"].includes(resource)) return next();
    const match = /^\/(tasks|attempts|artifacts|memories|memory-candidates)\/([a-zA-Z0-9_-]+)(?:\/(events|output|download|history|amend|cancel|resume|reconcile|merge|migrate|resolve))?$/.exec(resource);
    if (!match || !read && member.role === "viewer")
      return deny(403, "PA_CAPABILITY_DENIED", "此主体无权访问该能力");
    const [, collection, id] = match;
    if (collection === "memories") {
      const memory = service.store.get<PaMemory>("memories", id!);
      if (memory && (member.role === "admin" || memory.principalId === member.id)) return next();
    } else {
      const source = collection === "memory-candidates" ? "memory_candidates" : collection as "artifacts" | "attempts";
      const taskId = collection === "tasks" ? id : service.store.get<PaArtifact | PaAttempt | PaMemoryCandidate>(source, id!)?.taskId;
      const task = taskId ? service.store.get<PaTask>("tasks", taskId) : null;
      if (task && kernel!.policy.owns(member, task)) return next();
    }
    return deny(404, "PA_NOT_FOUND", "记录不存在");
  });
  app.get(
    "/api/pa",
    handle(req => {
      const snapshot = service.snapshot();
      if (!enterprise) return snapshot;
      const tasks = snapshot.tasks.filter(task => canSee(req, task));
      const ids = new Set(tasks.map(task => task.id));
      const member = memberOf(req)!;
      return {
        ...snapshot, tasks,
        messages: snapshot.messages.filter(message => message.taskId && ids.has(message.taskId)),
        attempts: snapshot.attempts.filter(attempt => ids.has(attempt.taskId)),
        artifacts: snapshot.artifacts.filter(artifact => ids.has(artifact.taskId)),
        memories: snapshot.memories.filter(memory => member.role === "admin" || memory.principalId === member.id),
        memoryCandidates: snapshot.memoryCandidates?.filter(item => ids.has(item.taskId)),
      };
    }),
  );
  const visibleToDevice = (task: PaTask) => task.dataClass !== "local_only" && !task.channelId;
  const deviceTask = (req: Request) => {
    const task = service.store.require<PaTask>("tasks", String(req.params.id));
    if (!visibleToDevice(task)) throw new PaError("任务不可通过设备访问", 404, "PA_NOT_FOUND");
    return task;
  };
  const deviceSummary = (task: PaTask) => ({
    id: task.id, goal: task.goal.slice(0, 240), conversationId: task.conversationId,
    status: task.status, waitingReason: task.waitingReason, waitKind: task.waitKind, updatedAt: task.updatedAt,
  });
  app.get("/api/pa/device", handle(() => ({
    conversations: service.store.list<PaConversation>("conversations")
      .filter(item => !item.channelId).map(({ id, title }) => ({ id, title })),
    tasks: service.store.list<PaTask>("tasks").filter(visibleToDevice).slice(-40).map(deviceSummary),
  })));
  app.get("/api/pa/device/tasks/:id", handle(req => {
    const task = deviceTask(req);
    return {
      ...deviceSummary(task), evidence: task.evidence, completionCriteria: task.completionCriteria ?? [],
      messages: service.store.list<PaMessage>("messages")
        .filter(message => message.taskId === task.id && message.dataClass !== "local_only")
        .slice(-12).map(({ senderId, content }) => ({ senderId, content })),
    };
  }));
  app.post("/api/pa/device/tasks", handle(req => {
    const input = taskInput(req);
    return deviceSummary(service.submit(input, undefined, undefined, { kind: "device", id: userInfo().username }));
  }));
  app.post("/api/pa/device/tasks/:id/resume", handle(req => deviceSummary(service.resume(deviceTask(req).id))));
  app.post("/api/pa/device/tasks/:id/cancel", handle(req => deviceSummary(service.cancel(deviceTask(req).id))));
  app.get(
    "/api/pa/models",
    handle(() => service.models()),
  );
  app.get('/api/pa/control', handle(() => service.control()));
  app.get('/api/pa/audit', handle(() => kernel?.audit() ?? service.store.verifyAudit()));
  app.post('/api/pa/audit/verify', handle(req => {
    if (!enterprise) throw new PaError("仅企业部署支持签名检查点", 403);
    const value = z.object({
      tenantId: z.string().min(1).max(64), entries: z.number().int().nonnegative(),
      head: z.string().regex(/^[a-f0-9]{64}$/).nullable(), signature: z.string().max(128),
    }).strict().parse(req.body);
    return { valid: kernel!.verifyCheckpoint(value) };
  }));
  app.post('/api/pa/enterprise/revoke', handle(req => {
    if (!enterprise) throw new PaError("此部署未启用企业身份", 403);
    const value = z.object({ kind: z.enum(["member", "worker"]), id: z.string().min(1).max(64) }).strict().parse(req.body);
    kernel!.identity.revoke(value.kind, value.id);
    return { ok: true };
  }));
  app.get('/api/pa/artifacts/:id/download', handle(async (req, res) => {
    const file = await service.downloadPrivateArtifact(String(req.params.id));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.attachment(file.name).type("application/octet-stream").send(file.bytes);
  }));
  app.get('/api/pa/feed', handle(req => {
    const before = Number(req.query.before ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1) throw new PaError('无效的动态分页位置');
    const page = service.store.feed(before, 41);
    const items = enterprise ? page.slice(0, 40).filter(item => {
      const task = item.taskId ? service.store.get<PaTask>("tasks", item.taskId) : null;
      return task && canSee(req, task);
    }) : page.slice(0, 40);
    return { items, nextBefore: page.length > 40 ? page[39]!.sequence : null };
  }));
  app.post('/api/pa/goals', handle(req => service.saveGoal(paGoalInputSchema.parse(req.body))));
  app.patch('/api/pa/goals/:id', handle(req => {
    const { revision: version, ...input } = req.body ?? {};
    return service.saveGoal(paGoalInputSchema.parse(input), String(req.params.id), revision.parse(version));
  }));
  app.post('/api/pa/routines', handle(req => service.saveRoutine(paRoutineInputSchema.parse(req.body))));
  app.patch('/api/pa/routines/:id', handle(req => {
    const { revision: version, ...input } = req.body ?? {};
    return service.saveRoutine(paRoutineInputSchema.parse(input), String(req.params.id), revision.parse(version));
  }));
  app.post('/api/pa/routines/:id/run', handle(req => service.runRoutine(String(req.params.id), revision.parse(req.body?.revision))));
  for (const collection of ['goals', 'routines'] as const) {
    app.delete(`/api/pa/${collection}/:id`, handle(req => {
      const id = String(req.params.id);
      const expected = revision.parse(req.body?.revision);
      return service.store.transaction(() => {
        if (service.store.require(collection, id).revision !== expected)
          throw new PaError('内容已更新，请刷新后重试', 409, 'PA_REVISION_CONFLICT');
        service.store.remove(collection, id);
        return { ok: true };
      });
    }));
  }
  app.post('/api/pa/voice', handle((req) => {
    const abort = new AbortController();
    req.res?.once('close', () => abort.abort());
    return transcribePaVoice(service.dataDirectory, req.body?.audio, req.body?.format, abort.signal);
  }));
  app.get('/api/pa/projects', handle(() => service.projects()));
  app.patch('/api/pa/control', handle(req => service.setControl(paControlPatchSchema.parse(req.body))));
  app.post('/api/pa/control/power', handle(req => {
    if (!['suspend', 'resume'].includes(req.body?.state)) throw new PaError('无效的设备状态');
    return service.powerState(req.body.state);
  }));
  app.get('/api/pa/attempts/:id/output', handle(req => {
    const offset = Number(req.query.offset ?? 0), limit = Number(req.query.limit ?? 16000);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32000) throw new PaError('无效的读取范围');
    return service.outputPage(String(req.params.id), offset, limit, typeof req.query.q === 'string' ? req.query.q : '');
  }));
  app.get(
    "/api/pa/activity",
    handle(req => {
      const tasks = service.store.list<PaTask>("tasks").filter(task => canSee(req, task));
      return {
        running: tasks.filter((task) =>
          ["running", "queued", "verifying", "cancelling"].includes(
            task.status,
          ),
        ).length,
        waiting: tasks.filter((task) => task.status === "waiting").length + (enterprise ? 0 : channels.pendingApprovalCount()),
      };
    }),
  );
  app.get(
    "/api/pa/node",
    handle(() => service.node.capabilities()),
  );
  app.get(
    "/api/pa/attempts/:id",
    handle((req) => service.store.require("attempts", String(req.params.id))),
  );
  app.post(
    "/api/pa/agents",
    handle((req) => service.createAgent(paAgentInputSchema.parse(req.body))),
  );
  app.patch(
    "/api/pa/agents/:id",
    handle((req) =>
      service.updateAgent(
        String(req.params.id),
        paAgentInputSchema.parse(req.body),
        revision.parse(req.body?.revision),
      ),
    ),
  );
  app.post(
    "/api/pa/agents/:id/clone",
    handle((req) => service.cloneAgent(String(req.params.id))),
  );
  app.post(
    "/api/pa/conversations",
    handle((req) => service.createConversation(text(req.body?.agentId, 100))),
  );
  app.post(
    "/api/pa/groups",
    handle((req) => service.createGroup(paGroupInputSchema.parse(req.body))),
  );
  app.patch(
    "/api/pa/groups/:id",
    handle((req) =>
      service.updateGroup(
        String(req.params.id),
        paGroupInputSchema.parse(req.body),
        revision.parse(req.body?.revision),
      ),
    ),
  );
  app.post(
    "/api/pa/tasks",
    handle(req => service.submit(taskInput(req), undefined, undefined, enterprise ? kernel!.identity.principal(memberOf(req)!) : undefined)),
  );
  app.get("/api/pa/tasks/:id", handle(req => service.store.require("tasks", String(req.params.id))));
  app.post("/api/pa/tasks/:id/merge", handle(req => service.mergeArtifacts(String(req.params.id), paArtifactMergeSchema.parse(req.body))));
  app.post("/api/pa/tasks/:id/migrate", handle(req => {
    const id = String(req.params.id);
    const scheduler = kernel?.scheduler.distributed;
    if (!scheduler) throw new PaError("此部署没有远端执行设备", 409, "PA_WORKER_UNAVAILABLE");
    scheduler.migrate(id, text(req.body?.workerId, 64), revision.parse(req.body?.revision));
    return service.store.require<PaTask>("tasks", id);
  }));
  app.post(
    "/api/pa/tasks/:id/amend",
    handle((req) =>
      service.amend(
        String(req.params.id),
        text(req.body?.content),
        revision.parse(req.body?.revision),
      ),
    ),
  );
  app.post(
    "/api/pa/tasks/:id/cancel",
    handle((req) => service.cancel(String(req.params.id))),
  );
  app.post(
    "/api/pa/tasks/:id/resume",
    handle((req) => service.resume(String(req.params.id))),
  );
  app.post('/api/pa/tasks/:id/reconcile', handle(req => service.reconcileTask(String(req.params.id), req.body?.confirmedStopped === true ? { revision: revision.parse(req.body.revision), note: text(req.body.note, 500) } : undefined)));
  app.get(
    "/api/pa/tasks/:id/events",
    handle((req) => service.store.events(String(req.params.id))),
  );
  app.post(
    "/api/pa/memories",
    handle(req => service.saveMemory(paMemoryInputSchema.parse(req.body), undefined, undefined, memberOf(req)?.id)),
  );
  app.get('/api/pa/memories/:id/history', handle(req => service.memoryHistory(String(req.params.id))));
  app.post('/api/pa/memory-candidates/:id/resolve', handle(req => {
    if (typeof req.body?.accept !== "boolean") throw new PaError("请选择保存或忽略");
    return service.resolveMemoryCandidate(String(req.params.id), revision.parse(req.body.revision), req.body.accept);
  }));
  app.patch(
    "/api/pa/memories/:id",
    handle((req) =>
      service.saveMemory(
        paMemoryInputSchema.parse(req.body),
        String(req.params.id),
        revision.parse(req.body?.revision),
        memberOf(req)?.id,
      ),
    ),
  );
  app.delete(
    "/api/pa/memories/:id",
    handle((req) => {
      service.deleteMemory(String(req.params.id));
      return { ok: true };
    }),
  );
}
