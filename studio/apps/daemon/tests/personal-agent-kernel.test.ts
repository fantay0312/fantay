import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paTaskInputSchema, type PaTask } from "@open-design/contracts";
import { createPaKernel, type PaKernel } from "../src/services/pa/kernel.js";
import { PersonalAgentService } from "../src/services/personal-agent-service.js";
import { paDigest } from "../src/services/personal-agent-gateway.js";
import type { WorkerAssignment } from "../src/services/pa/distributed.js";

const fixtureRuntime = { models: async () => [], execute: vi.fn() };
const testQuota = { calls: 100, cpuMs: 5000000, costMicros: 1000000 };
let directory: string;
let db: InstanceType<typeof Database>;
let cores: PersonalAgentService[];
let kernels: PaKernel[];

beforeEach(() => {
  directory = mkdtempSync(path.join(process.cwd(), ".tmp-pa-kernel-"));
  db = new Database(":memory:");
  cores = [];
  kernels = [];
});
afterEach(async () => {
  for (const core of cores) await core.shutdown();
  for (const kernel of kernels) kernel.storage.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(tenant: string) {
  const token = () => randomBytes(32).toString("base64url");
  const memberToken = token(), first = token(), second = token();
  const expiresAt = Date.now() + 120000;
  const key = path.join(directory, tenant + ".key");
  const secret = path.join(directory, tenant + ".secret");
  const config = path.join(directory, tenant + ".json");
  writeFileSync(key, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(secret, token(), { mode: 0o600 });
  writeFileSync(config, JSON.stringify({
    version: 1, mode: "enterprise", leaseMs: 1800,
    workers: [["first", first], ["second", second]].map(([id, value]) => ({
      id, tokenSha256: paDigest(value!), expiresAt, capabilities: ["shell"],
    })),
    enterprise: {
      tenantId: tenant, members: [{ id: "owner", role: "admin", group: "all", tokenSha256: paDigest(memberToken), grantVersion: 1, expiresAt }],
      budgets: { tenant: testQuota, groups: { all: testQuota }, roles: { admin: testQuota, operator: testQuota, viewer: testQuota } },
      gateway: {
        endpoint: "http://127.0.0.1:1/model", secret: { type: "file", path: secret },
        models: [{ id: "test", maxTokens: 1024, reserveCostMicros: 10 }],
      },
      auditSigningKeyFile: key,
    },
  }), { mode: 0o600 });
  const kernel = createPaKernel({ configPath: config, db, dataDir: directory, projectsDir: directory, localRuntime: fixtureRuntime });
  kernels.push(kernel);
  return { kernel, memberToken, first, second };
}

function service(kernel: PaKernel) {
  const core = new PersonalAgentService({
    db: kernel.storage.db, dataDir: kernel.storage.dataDir, projectsDir: kernel.storage.projectsDir,
    runtime: kernel.credentials.runtime, kernel,
  });
  cores.push(core);
  return core;
}
const leaseOf = ({ runId, leaseId, generation }: WorkerAssignment) => ({ runId, leaseId, generation });

describe("Personal Agent execution kernel", () => {
  it("fences a moved worker and commits its replacement receipt after controller reattachment", async () => {
    const fixtureA = fixture("alpha");
    const { kernel } = fixtureA;
    let core = service(kernel);
    const scheduler = kernel.scheduler.distributed!;
    const member = kernel.identity.member("Bearer " + fixtureA.memberToken)!;
    const oldWorker = kernel.identity.worker("Bearer " + fixtureA.first)!;
    const newWorker = kernel.identity.worker("Bearer " + fixtureA.second)!;
    const task = core.submit(paTaskInputSchema.parse({
      requestId: randomUUID(), conversationId: core.snapshot().conversations[0]!.id, goal: "Move execution",
      execution: { target: "worker", script: "echo DONE" }, budget: { maxAttempts: 2, timeoutMs: 15000 },
    }), undefined, undefined, kernel.identity.principal(member));
    const original = await vi.waitFor(() => {
      const assignment = scheduler.claim(oldWorker);
      expect(assignment).toBeTruthy();
      return assignment!;
    });
    scheduler.migrate(task.id, newWorker.id, core.store.require<PaTask>("tasks", task.id).revision);
    expect(() => scheduler.complete(oldWorker, leaseOf(original), { ok: true, output: "stale" }))
      .toThrow(expect.objectContaining({ code: "PA_STALE_LEASE" }));
    expect(scheduler.claim(newWorker, ["ollama"])).toBeNull();
    const replacement = scheduler.claim(newWorker)!;
    expect(replacement.generation).toBe(original.generation + 1);
    await core.shutdown();
    core = service(kernel);
    scheduler.complete(newWorker, leaseOf(replacement), { ok: true, output: "DONE" });
    scheduler.complete(newWorker, leaseOf(replacement), { ok: true, output: "DONE" });
    await vi.waitFor(() => expect(core.store.require<PaTask>("tasks", task.id).status).toBe("completed"));
    expect(core.snapshot().attempts).toMatchObject([{ workerReceipt: { workerId: "second", generation: 2 } }]);
    expect(core.store.events(task.id).filter(item => item.kind === "gateway.model_received")).toHaveLength(1);
  });

  it("keeps tenant databases and tokens separate, and signs checkpoints that detect truncation", () => {
    const a = fixture("tenant-a"), b = fixture("tenant-b");
    expect(a.kernel.storage.db).not.toBe(b.kernel.storage.db);
    expect(a.kernel.storage.dataDir).not.toBe(b.kernel.storage.dataDir);
    expect(b.kernel.identity.member("Bearer " + a.memberToken)).toBeNull();
    expect(a.kernel.identity.member("Bearer " + a.first)).toBeNull();
    a.kernel.store.audit(null, "fixture", {}, "test-a");
    expect(b.kernel.audit().entries).toBe(0);
    const checkpoint = a.kernel.audit().checkpoint!;
    expect(a.kernel.verifyCheckpoint(checkpoint)).toBe(true);
    expect(b.kernel.verifyCheckpoint(checkpoint)).toBe(false);
    a.kernel.store.db.prepare("DELETE FROM pa_audit").run();
    expect(a.kernel.verifyCheckpoint(checkpoint)).toBe(false);
    a.kernel.identity.revoke("member", "owner");
    expect(a.kernel.identity.member("Bearer " + a.memberToken)).toBeNull();
  });
});
