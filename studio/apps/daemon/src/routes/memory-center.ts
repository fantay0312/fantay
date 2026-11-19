// SPDX-License-Identifier: Apache-2.0
// Memory Center HTTP routes (`/api/memory-center/*`). The contract is `packages/contracts/src/api/memory-center.ts`;
// the logic lives in `services/memory-center-service.ts`. This file is the transport: the loopback / origin /
// enterprise-token gate, query coercion, and the mapping of failures to `{ code, message, error: { code, message } }`.

import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  copyMemoryItemSchema,
  createMemoryItemSchema,
  memoryChunkListQuerySchema,
  memoryItemActionSchema,
  memoryItemListQuerySchema,
  memoryLocalModelActionSchema,
  memoryRecallSchema,
  memoryReindexSchema,
  memoryTidySchema,
  resolveMemoryConflictSchema,
  resolveMemoryPendingSchema,
  updateAgentMemoryPolicySchema,
  updateMemoryEngineConfigSchema,
  updateMemoryItemSchema,
} from "@open-design/contracts";
import type { SqliteDb } from "../db.js";
import { isTokenToSeaWriteOrigin } from "../http/tokentosea-origin.js";
import { PaError } from "../storage/personal-agent-store.js";
import { paCanManageLibrary, type PaMember } from "../services/pa/config.js";
import { MemoryError } from "../services/memory/index.js";
import type { PersonalAgentService } from "../services/personal-agent-service.js";
import { MemoryCenterService, type MemoryCaller } from "../services/memory-center-service.js";

export interface RegisterMemoryCenterRoutesDeps {
  personalAgent: PersonalAgentService;
  db: SqliteDb;
  runtimeDataDir: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// ---- query coercion: everything arrives as a string -------------------------------------------------------------

function first(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof raw === "string" ? raw : undefined;
}

/** A non-empty trimmed string, or undefined. */
function text(value: unknown): string | undefined {
  const raw = first(value)?.trim();
  return raw ? raw : undefined;
}

/** "true"/"false" become booleans; anything else is passed on so the schema rejects it. */
function flag(value: unknown): unknown {
  const raw = text(value);
  if (raw === undefined) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return raw;
}

function count(value: unknown): unknown {
  const raw = text(value);
  return raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

function present(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

const conflictListQuerySchema = z.object({ status: z.enum(["open", "resolved"]).optional() });

function itemListQuery(query: Request["query"]): unknown {
  return present({
    scopeKind: text(query.scopeKind),
    // The profile scope has no id; leaving it out and sending it empty mean the same.
    scopeId: first(query.scopeId),
    status: text(query.status),
    kind: text(query.kind),
    pinned: flag(query.pinned),
    viaGroup: flag(query.viaGroup),
    query: text(query.query),
    includeStudio: flag(query.includeStudio),
    limit: count(query.limit),
    offset: count(query.offset),
  });
}

function chunkListQuery(query: Request["query"]): unknown {
  return present({
    scopeKind: text(query.scopeKind),
    scopeId: first(query.scopeId),
    conversationId: text(query.conversationId),
    limit: count(query.limit),
    offset: count(query.offset),
  });
}

// ---- failures -----------------------------------------------------------------------------------------------------

interface Failure {
  status: number;
  code: string;
  message: string;
}

function failureOf(error: unknown): Failure {
  if (error instanceof MemoryError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof PaError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof Error && error.name === "ZodError") {
    const issue = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues?.[0];
    const detail = issue ? `（${[...issue.path, issue.message].join("：")}）` : "";
    return { status: 400, code: "MEMORY_CENTER_VALIDATION_FAILED", message: `输入参数格式不正确${detail}` };
  }
  return { status: 500, code: "MEMORY_CENTER_REQUEST_FAILED", message: "记忆中心操作失败，请重试" };
}

function reject(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message, error: { code, message } });
}

// ---- routes -------------------------------------------------------------------------------------------------------

export function registerMemoryCenterRoutes(
  app: Express,
  deps: RegisterMemoryCenterRoutesDeps,
): MemoryCenterService {
  const service = new MemoryCenterService(deps);
  const pa = deps.personalAgent;
  const kernel = pa.kernel;
  const enterprise = kernel?.mode === "enterprise";
  const memberOf = (req: Request) => req.res?.locals.paMember as PaMember | undefined;
  const callerOf = (req: Request): MemoryCaller => ({ member: memberOf(req) });

  const handle =
    (fn: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        res.setHeader("Cache-Control", "no-store");
        const result = await fn(req, res);
        if (!res.headersSent) res.json(result);
      } catch (error) {
        const failure = failureOf(error);
        reject(res, failure.status, failure.code, failure.message);
      }
    };

  /** Recall and the merge draft read memory (the draft may call a model) and change nothing. */
  const readsOnly = (req: Request): boolean =>
    req.method === "GET" ||
    req.method === "HEAD" ||
    (req.method === "POST" && (req.path === "/recall" || /^\/conflicts\/[^/]+\/merge-draft$/.test(req.path)));

  /**
   * The engine settings and the bots' memory policies are shared by the whole organization: only those who manage the
   * library change them. A bot belongs to the library, so when an organization server owns the library nobody changes
   * a bot here (`botsAreLibrary`).
   */
  const requireManager = (req: Request, botsAreLibrary = false): void => {
    if (!enterprise) return;
    const member = memberOf(req);
    const allowed = member && paCanManageLibrary(member) && !(botsAreLibrary && pa.libraryManagedRemotely);
    if (!allowed) throw new PaError("此主体无权访问该能力", 403, "PA_CAPABILITY_DENIED");
  };

  app.use("/api/memory-center", (req, res, next) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
      reject(res, 403, "MEMORY_CENTER_LOCAL_ONLY", "记忆中心仅允许本机回环地址访问");
      return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site" || !isTokenToSeaWriteOrigin(req)) {
      reject(res, 403, "MEMORY_CENTER_INVALID_ORIGIN", "请求来源无效");
      return;
    }
    if (enterprise) {
      const member = kernel!.identity.member(req.get("authorization"));
      if (!member) {
        reject(res, 401, "PA_ENTERPRISE_AUTH", "需要企业访问令牌");
        return;
      }
      if (member.role === "viewer" && !readsOnly(req)) {
        reject(res, 403, "PA_CAPABILITY_DENIED", "此主体无权访问该能力");
        return;
      }
      res.locals.paMember = member;
    }
    next();
  });

  app.get(
    "/api/memory-center/overview",
    handle((req) => service.overview(callerOf(req))),
  );

  // -- items
  app.get(
    "/api/memory-center/items",
    handle((req) => service.listItems(memoryItemListQuerySchema.parse(itemListQuery(req.query)), callerOf(req))),
  );
  app.post(
    "/api/memory-center/items",
    handle((req) => service.createItem(createMemoryItemSchema.parse(req.body ?? {}), callerOf(req))),
  );
  app.get(
    "/api/memory-center/items/:id",
    handle((req) => service.getItem(String(req.params.id), callerOf(req))),
  );
  app.patch(
    "/api/memory-center/items/:id",
    handle((req) =>
      service.updateItem(String(req.params.id), updateMemoryItemSchema.parse(req.body ?? {}), callerOf(req)),
    ),
  );
  app.get(
    "/api/memory-center/items/:id/history",
    handle((req) => service.history(String(req.params.id), callerOf(req))),
  );
  app.post(
    "/api/memory-center/items/:id/action",
    handle((req) =>
      service.itemAction(String(req.params.id), memoryItemActionSchema.parse(req.body ?? {}), callerOf(req)),
    ),
  );
  app.post(
    "/api/memory-center/items/:id/copy",
    handle((req) =>
      service.copyItem(String(req.params.id), copyMemoryItemSchema.parse(req.body ?? {}), callerOf(req)),
    ),
  );

  // -- inbox
  app.get(
    "/api/memory-center/inbox",
    handle((req) => service.inbox(callerOf(req))),
  );
  app.post(
    "/api/memory-center/pending/:id/resolve",
    handle((req) =>
      service.resolvePending(String(req.params.id), resolveMemoryPendingSchema.parse(req.body ?? {}), callerOf(req)),
    ),
  );

  // -- conflicts
  app.get(
    "/api/memory-center/conflicts",
    handle((req) =>
      service.listConflicts(conflictListQuerySchema.parse(present({ status: text(req.query.status) })), callerOf(req)),
    ),
  );
  app.get(
    "/api/memory-center/conflicts/:id",
    handle((req) => service.getConflict(String(req.params.id), callerOf(req))),
  );
  app.post(
    "/api/memory-center/conflicts/:id/resolve",
    handle((req) =>
      service.resolveConflict(String(req.params.id), resolveMemoryConflictSchema.parse(req.body ?? {}), callerOf(req)),
    ),
  );
  app.post(
    "/api/memory-center/conflicts/:id/merge-draft",
    handle((req) => service.mergeDraft(String(req.params.id), callerOf(req))),
  );

  // -- recall and raw windows
  app.post(
    "/api/memory-center/recall",
    handle((req) => service.recall(memoryRecallSchema.parse(req.body ?? {}), callerOf(req))),
  );
  app.get(
    "/api/memory-center/chunks",
    handle((req) => service.listChunks(memoryChunkListQuerySchema.parse(chunkListQuery(req.query)), callerOf(req))),
  );
  app.get(
    "/api/memory-center/chunks/:id",
    handle((req) => service.getChunk(String(req.params.id), callerOf(req))),
  );

  // -- engine
  app.get(
    "/api/memory-center/engine",
    handle(() => service.getEngine()),
  );
  app.put(
    "/api/memory-center/engine",
    handle((req) => {
      requireManager(req);
      return service.updateEngine(updateMemoryEngineConfigSchema.parse(req.body ?? {}));
    }),
  );
  app.post(
    "/api/memory-center/engine/reindex",
    handle((req) => {
      requireManager(req);
      return service.reindex(memoryReindexSchema.parse(req.body ?? {}));
    }),
  );
  app.post(
    "/api/memory-center/engine/tidy",
    handle((req) => {
      requireManager(req);
      return service.tidy(memoryTidySchema.parse(req.body ?? {}));
    }),
  );
  app.post(
    "/api/memory-center/engine/models/:id",
    handle((req) => {
      requireManager(req);
      return service.modelAction(String(req.params.id), memoryLocalModelActionSchema.parse(req.body ?? {}).action);
    }),
  );

  // -- bot policy
  const updatePolicy = handle((req) => {
    requireManager(req, true);
    return service.updateAgentPolicy(
      String(req.params.id),
      updateAgentMemoryPolicySchema.parse(req.body ?? {}),
      callerOf(req),
    );
  });
  app.patch("/api/memory-center/agents/:id/policy", updatePolicy);
  app.put("/api/memory-center/agents/:id/policy", updatePolicy);

  return service;
}
