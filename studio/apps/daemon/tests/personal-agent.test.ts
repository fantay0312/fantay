import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { isProcessGroupAlive } from "@open-design/platform";
import { terminatePaProcess } from "../src/runtimes/personal-agent.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  paTaskInputSchema,
  type PaExecutionLease,
  type PaAttempt,
  type PaTask,
  type PersonalAgent,
} from "@open-design/contracts";
import {
  closeDatabase,
  getProject,
  insertProject,
  openDatabase,
  type SqliteDb,
} from "../src/db.js";
import { PersonalAgentService } from "../src/services/personal-agent-service.js";
import type {
  PaModelRuntime,
  PaModelResult,
} from "../src/runtimes/personal-agent.js";
import { PaError } from "../src/storage/personal-agent-store.js";
import * as projects from "../src/projects.js";
import * as artifacts from "../src/services/personal-agent-artifacts.js";

let dir: string, db: SqliteDb, service: PersonalAgentService;
const result = (text: string): PaModelResult => ({
  text,
  usage: { visibility: "unknown" },
});
const execute = vi.fn<PaModelRuntime["execute"]>();
function create() {
  return new PersonalAgentService({
    db,
    dataDir: dir,
    projectsDir: join(dir, "projects"),
    runtime: { models: async () => [], execute },
  });
}
function submit(overrides: Record<string, unknown> = {}) {
  return service.submit(
    paTaskInputSchema.parse({
      requestId: crypto.randomUUID(),
      conversationId: service.snapshot().conversations[0]!.id,
      goal: "Help with the brief",
      ...overrides,
    }),
  );
}
async function settled(id: string) {
  await vi.waitFor(() =>
    expect(["completed", "failed", "waiting", "cancelled"]).toContain(
      service.store.require<PaTask>("tasks", id).status,
    ),
  );
  return service.store.require<PaTask>("tasks", id);
}
beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), ".tmp-pa-"));
  db = openDatabase(dir, { dataDir: dir });
  execute.mockReset();
  execute.mockResolvedValue(result("A useful answer"));
  service = create();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await service.shutdown();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

describe("local PersonalAgent", () => {
  it("has independent durable identities and chats without creating projects", async () => {
    const task = submit();
    await settled(task.id);
    expect(db.prepare("SELECT count(*) AS count FROM projects").get()).toEqual({
      count: 0,
    });
    const assistant = service.snapshot().agents[0]!;
    const copy = service.cloneAgent(assistant.id);
    expect(copy.id).not.toBe(assistant.id);
    service.updateAgent(
      copy.id,
      { ...copy, model: { runtime: "claude", modelId: "opus" } },
      copy.revision,
    );
    expect(service.snapshot().agents[0]!.model.modelId).toBe("sonnet");
    await service.shutdown();
    service = create();
    expect(service.snapshot().tasks[0]!.status).toBe("completed");
    expect(service.snapshot().messages).toHaveLength(2);
  });
  it("deduplicates event delivery and refuses a conflicting reused key", async () => {
    const first = submit({ requestId: "same-message-key" });
    expect(submit({ requestId: "same-message-key" }).id).toBe(first.id);
    expect(() =>
      submit({ requestId: "same-message-key", goal: "changed" }),
    ).toThrow("不一致");
    await settled(first.id);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("routes default discussion to one moderator and mentions to a specific member", async () => {
    const group = service.snapshot().groups[0]!;
    service.updateGroup(
      group.id,
      { ...group, mode: "discussion" },
      group.revision,
    );
    const first = submit({ conversationId: group.conversationId });
    await settled(first.id);
    expect(first.participantIds).toEqual([group.moderatorId]);
    const reviewer = service.snapshot().agents[1]!;
    const second = submit({
      conversationId: group.conversationId,
      goal: `@${reviewer.name} review this brief`,
    });
    await settled(second.id);
    expect(second.participantIds).toEqual([reviewer.id]);
    expect(() => submit({ targetAgentIds: [reviewer.id] })).toThrow("不属于");
  });
  it("preserves an omitted reviewer and clears an explicitly null reviewer", () => {
    const group = service.snapshot().groups[0]!;
    const input = { name: group.name, memberIds: group.memberIds, moderatorId: group.moderatorId, mode: group.mode };
    const explicit = service.updateGroup(group.id, { ...input, reviewerId: input.memberIds[1]! }, group.revision);
    const kept = service.updateGroup(group.id, input, explicit.revision);
    expect(kept.reviewerId).toBe(explicit.reviewerId);
    expect(service.updateGroup(group.id, { ...input, reviewerId: null }, kept.revision).reviewerId).toBeNull();
  });
  it("creates an ordinary project, verifies files and records a distinct model review", async () => {
    execute
      .mockResolvedValueOnce(
        result(
          JSON.stringify({
            summary: "Made the page",
            files: [
              {
                path: "index.html",
                content:
                  "<!doctype html><html><title>Example</title><body><h1>Brand</h1></body></html>",
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        result(
          JSON.stringify({
            approved: true,
            summary: "Title and requested heading are present",
            issues: [],
          }),
        ),
      );
    const group = service.snapshot().groups[0]!;
    const task = submit({
      conversationId: group.conversationId,
      kind: "project",
      projectName: "PA project",
    });
    const done = await settled(task.id);
    expect(done.status).toBe("completed");
    expect(getProject(db, done.projectId!)?.name).toBe("PA project");
    const snapshot = service.snapshot();
    expect(
      snapshot.attempts.map((item) => item.agentSnapshot.model.modelId),
    ).toEqual(["sonnet", "haiku"]);
    expect(snapshot.artifacts).toHaveLength(1);
    expect(
      readFileSync(
        join(dir, "projects", done.projectId!, snapshot.artifacts[0]!.path),
        "utf8",
      ),
    ).toContain("<h1>Brand</h1>");
    expect(done.evidence).toHaveLength(2);
    expect(execute.mock.calls[1]![1]).toContain("<h1>Brand</h1>");
  });
  it("rejects different aliases that resolve to the same actual model", async () => {
    execute
      .mockResolvedValueOnce({
        ...result(
          JSON.stringify({
            summary: "Made",
            files: [{ path: "brief.md", content: "Brand brief" }],
          }),
        ),
        resolvedModel: "same-actual-model",
      })
      .mockResolvedValueOnce({
        ...result(
          JSON.stringify({ approved: true, summary: "Approved", issues: [] }),
        ),
        resolvedModel: "same-actual-model",
      });
    const task = submit({
      conversationId: service.snapshot().groups[0]!.conversationId,
      kind: "project",
    });
    expect((await settled(task.id)).status).toBe("waiting");
    expect(
      service.store.require<PaTask>("tasks", task.id).waitingReason,
    ).toContain("实际解析为同一模型");
  });
  it("rejects same-model execution and review before any project is created", () => {
    const reviewer = service.snapshot().agents[1]!;
    service.updateAgent(
      reviewer.id,
      { ...reviewer, model: { runtime: "claude", modelId: "sonnet" } },
      reviewer.revision,
    );
    expect(() =>
      submit({
        conversationId: service.snapshot().groups[0]!.conversationId,
        kind: "project",
      }),
    ).toThrow("不同模型");
    expect(execute).not.toHaveBeenCalled();
  });
  it("never treats a model success claim or unsafe file path as verified delivery", async () => {
    execute.mockResolvedValueOnce(
      result(
        JSON.stringify({
          summary: "Done",
          files: [{ path: "../outside.md", content: "no" }],
        }),
      ),
    );
    const task = submit({
      conversationId: service.snapshot().groups[0]!.conversationId,
      kind: "project",
    });
    expect((await settled(task.id)).status).toBe("failed");
    expect(service.snapshot().artifacts).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("persists cancellation first, waits for executor confirmation and ignores late success", async () => {
    let finish!: (value: PaModelResult) => void;
    execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const task = submit();
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    expect(service.cancel(task.id).status).toBe("cancelling");
    expect(
      service.store.require<PaTask>("tasks", task.id).authorization.revoked,
    ).toBe(true);
    finish(result("late success"));
    expect((await settled(task.id)).status).toBe("cancelled");
    expect(service.snapshot().messages).toHaveLength(1);
  });
  it("keeps a snapshot while revoking live agent permission immediately", async () => {
    execute.mockImplementation(
      (_model, _prompt, _run, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new PaError("stopped", 409, "PA_CANCEL_CONFIRMED")),
            { once: true },
          ),
        ),
    );
    const task = submit();
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    const agent = service.snapshot().agents[0]!;
    service.updateAgent(
      agent.id,
      { ...agent, role: "New role", enabled: false },
      agent.revision,
    );
    await settled(task.id);
    expect(service.snapshot().attempts[0]!.agentSnapshot.role).toBe(agent.role);
    expect(service.store.require<PaTask>("tasks", task.id).status).toBe(
      "waiting",
    );
  });
  it("accepts an amendment during execution but does not mark an obsolete answer completed", async () => {
    let finish!: (value: PaModelResult) => void;
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const task = submit();
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    service.amend(
      task.id,
      "Use a quiet style",
      service.store.require<PaTask>("tasks", task.id).revision,
    );
    finish(result("Old response"));
    expect((await settled(task.id)).status).toBe("waiting");
    expect(
      service.store.require<PaTask>("tasks", task.id).amendments[0]!.appliedAt,
    ).toBeNull();
    await vi.waitFor(() => {
      service.resume(task.id);
    });
    expect((await settled(task.id)).status).toBe("completed");
    expect(execute.mock.calls[1]![1]).toContain("Use a quiet style");
  });
  it("bounds attempts and retains interrupted tasks on restart without replay", async () => {
    execute.mockRejectedValue(
      new PaError("login required", 503, "PA_MODEL_UNAVAILABLE"),
    );
    const task = submit({ budget: { maxAttempts: 1, timeoutMs: 1000 } });
    expect((await settled(task.id)).status).toBe("waiting");
    expect(() => service.resume(task.id)).toThrow("上限");
    service.store.update<PaTask>("tasks", task.id, { status: "running" });
    service.store.update<PaAttempt>("attempts", service.snapshot().attempts[0]!.id, { status: "running", endedAt: null });
    await service.shutdown();
    service = create();
    expect(
      service.store.require<PaTask>("tasks", task.id).waitingReason,
    ).toContain("重启");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("isolates private memory from groups and reads corrections/deletions from the source", async () => {
    const memory = service.saveMemory({
      content: "PRIVATE SECRET PREFERENCE",
      source: "user",
      scope: "private",
      scopeId: null,
    });
    let task = submit();
    await settled(task.id);
    expect(execute.mock.calls[0]![1]).toContain("PRIVATE SECRET PREFERENCE");
    const group = service.snapshot().groups[0]!;
    task = submit({ conversationId: group.conversationId });
    await settled(task.id);
    expect(execute.mock.calls[1]![1]).not.toContain(
      "PRIVATE SECRET PREFERENCE",
    );
    const corrected = service.saveMemory(
      { ...memory, content: "Corrected preference" },
      memory.id,
      memory.revision,
    );
    task = submit();
    await settled(task.id);
    expect(execute.mock.lastCall![1]).toContain("Corrected preference");
    expect(execute.mock.lastCall![1]).not.toContain(
      "PRIVATE SECRET PREFERENCE",
    );
    service.deleteMemory(corrected.id);
    task = submit();
    await settled(task.id);
    expect(execute.mock.lastCall![1]).not.toContain("Corrected preference");
  });
  it("keeps node identity stable, rejects unknown capability and deduplicates receipts", async () => {
    const lease: PaExecutionLease = {
      protocolVersion: 1,
      taskId: "task",
      attemptId: "attempt",
      nodeId: service.node.id,
      generation: 1,
      workspaceRef: null,
      credentialRef: null,
      idempotencyKey: "claim",
    };
    expect(service.node.claim(lease, "unknown")).toBe(false);
    expect(service.node.claim(lease, "text")).toBe(true);
    const event = {
      lease,
      eventId: "receipt",
      kind: "result" as const,
      at: Date.now(),
    };
    expect(service.node.event(event)).toBe(true);
    expect(service.node.event(event)).toBe(false);
    expect(() =>
      service.node.event({ ...event, lease: { ...lease, generation: 2 } }),
    ).toThrow("失效");
    const id = service.node.id;
    await service.shutdown();
    service = create();
    expect(service.node.id).toBe(id);
  });
  it("keeps unknown remote cancellation unknown on repeated stop requests", async () => {
    const agent = service.snapshot().agents[0]!;
    service.updateAgent(
      agent.id,
      { ...agent, model: { runtime: "tokentosea", modelId: "test-model" } },
      agent.revision,
    );
    execute.mockImplementation(
      (_model, _prompt, _run, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("remote abort")),
            { once: true },
          ),
        ),
    );
    const task = submit();
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    service.cancel(task.id);
    await vi.waitFor(() =>
      expect(
        service.store.require<PaTask>("tasks", task.id).stopConfirmation,
      ).toBe("unknown"),
    );
    expect(service.cancel(task.id).status).toBe("cancelling");
    await service.shutdown();
    service = create();
    expect(service.cancel(task.id).status).toBe("cancelling");
  });
  it("retains amendments accepted during asynchronous project creation", async () => {
    const actual = projects.ensureProject;
    vi.spyOn(projects, "ensureProject").mockImplementationOnce(
      async (...args) => {
        const task = service.snapshot().tasks[0]!;
        service.amend(task.id, "ADDED DURING CREATE", task.revision);
        return actual(...args);
      },
    );
    execute
      .mockResolvedValueOnce(
        result(
          JSON.stringify({
            summary: "Made",
            files: [{ path: "brief.md", content: "ADDED DURING CREATE" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        result(
          JSON.stringify({
            approved: true,
            summary: "Matches amended goal",
            issues: [],
          }),
        ),
      );
    const task = submit({
      conversationId: service.snapshot().groups[0]!.conversationId,
      kind: "project",
    });
    expect((await settled(task.id)).status).toBe("completed");
    expect(
      service.store.require<PaTask>("tasks", task.id).amendments[0]!.content,
    ).toBe("ADDED DURING CREATE");
    expect(execute.mock.calls[0]![1]).toContain("ADDED DURING CREATE");
  });
  it("revalidates distinct models when the reviewer configuration changes mid-task", async () => {
    execute.mockImplementationOnce(async () => {
      const reviewer = service.snapshot().agents[1]!;
      service.updateAgent(
        reviewer.id,
        { ...reviewer, model: { runtime: "claude", modelId: "sonnet" } },
        reviewer.revision,
      );
      return result(
        JSON.stringify({
          summary: "Made",
          files: [{ path: "brief.md", content: "Brand brief" }],
        }),
      );
    });
    const task = submit({
      conversationId: service.snapshot().groups[0]!.conversationId,
      kind: "project",
    });
    expect((await settled(task.id)).status).toBe("waiting");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite cancellation accepted after review output with completion", async () => {
    execute
      .mockResolvedValueOnce(
        result(
          JSON.stringify({
            summary: "Made",
            files: [{ path: "brief.md", content: "Brand brief" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        result(
          JSON.stringify({ approved: true, summary: "Meets goal", issues: [] }),
        ),
      );
    const update = service.store.update.bind(service.store);
    vi.spyOn(service.store, "update").mockImplementation(
      (collection, id, patch, revision) => {
        const value = update(collection, id, patch, revision);
        if (
          collection === "attempts" &&
          "status" in patch &&
          patch.status === "completed" &&
          service
            .snapshot()
            .attempts.some(
              (attempt) => attempt.id === id && attempt.phase === "review",
            )
        )
          service.cancel(service.snapshot().tasks[0]!.id);
        return value;
      },
    );
    const task = submit({
      conversationId: service.snapshot().groups[0]!.conversationId,
      kind: "project",
    });
    expect((await settled(task.id)).status).toBe("cancelled");
  });
  it("keeps old memory scope and content together when a metadata update fails", () => {
    const group = service.snapshot().groups[0]!;
    const memory = service.saveMemory({
      content: "Shared style",
      source: "user",
      scope: "group",
      scopeId: group.id,
    });
    vi.spyOn(service.store, "update").mockImplementationOnce(() => {
      throw new Error("injected database failure");
    });
    expect(() =>
      service.saveMemory(
        {
          content: "NEW PRIVATE CONTENT",
          source: "user",
          scope: "private",
          scopeId: null,
        },
        memory.id,
        memory.revision,
      ),
    ).toThrow("database failure");
    expect(service.memories()[0]).toMatchObject({
      scope: "group",
      content: "Shared style",
    });
  });
  it("isolates a missing memory file and removes metadata before deleting content", () => {
    const memory = service.saveMemory({
      content: "Preference",
      source: "user",
      scope: "private",
      scopeId: null,
    });
    const metadata = service.store.require<
      import("@open-design/contracts").PaMemory & { fileName: string }
    >("memories", memory.id);
    unlinkSync(join(dir, "pa", "memory", metadata.fileName));
    expect(service.snapshot().memories[0]!.content).toBe("");
    expect(() => service.deleteMemory(memory.id)).not.toThrow();
    expect(service.snapshot().memories).toHaveLength(0);
  });
  it("does not resurrect deleted memory through a historical model answer", async () => {
    const memory = service.saveMemory({
      content: "FORGOTTEN PREFERENCE",
      source: "user",
      scope: "private",
      scopeId: null,
    });
    execute.mockResolvedValueOnce(result("I will use FORGOTTEN PREFERENCE."));
    await settled(submit().id);
    execute.mockResolvedValueOnce(
      result("Repeating FORGOTTEN PREFERENCE from history."),
    );
    await settled(submit().id);
    service.deleteMemory(memory.id);
    await settled(submit().id);
    expect(execute.mock.lastCall![1]).not.toContain("FORGOTTEN PREFERENCE");
    expect(
      service
        .snapshot()
        .messages.some((message) =>
          message.content.includes("FORGOTTEN PREFERENCE"),
        ),
    ).toBe(true);
  });
  it("preserves cancellation when an amendment arrives at the deliverable write boundary", async () => {
    execute.mockResolvedValueOnce(
      result(
        JSON.stringify({
          summary: "Made",
          files: [{ path: "brief.md", content: "Brand brief" }],
        }),
      ),
    );
    const write = artifacts.preparePaArtifacts;
    vi.spyOn(artifacts, "preparePaArtifacts").mockImplementationOnce(
      async (...args) => {
        const prepared = await write(...args);
        const task = service.store.require<PaTask>("tasks", args[2].id);
        service.amend(
          task.id,
          "An amendment at the last readback boundary",
          task.revision,
        );
        service.cancel(task.id);
        return prepared;
      },
    );
    const task = submit({
      conversationId: service.snapshot().groups[0]!.conversationId,
      kind: "project",
    });
    expect((await settled(task.id)).status).toBe("cancelled");
    expect(
      service.store.require<PaTask>("tasks", task.id).stopConfirmation,
    ).toBe("confirmed");
    expect(service.snapshot().artifacts).toHaveLength(0);
  });
  it("does not move project-only memory into ordinary group history", async () => {
    insertProject(db, {
      id: "memory-project",
      name: "Memory project",
      createdAt: 1,
      updatedAt: 1,
    });
    const memory = service.saveMemory({
      content: "PROJECT ONLY",
      source: "project owner",
      scope: "project",
      scopeId: "memory-project",
    });
    const group = service.snapshot().groups[0]!;
    service.updateGroup(
      group.id,
      { ...group, mode: "discussion" },
      group.revision,
    );
    service.store.create<import("@open-design/contracts").PaMessage>(
      "messages",
      {
        conversationId: group.conversationId,
        taskId: null,
        senderId: group.moderatorId,
        content: "A past project answer containing PROJECT ONLY",
        memoryRefs: [{ id: memory.id, revision: memory.revision }],
        replyTo: null,
        targetAgentIds: [],
      },
    );
    await settled(submit({ conversationId: group.conversationId }).id);
    expect(execute.mock.lastCall![1]).not.toContain("PROJECT ONLY");
  });
  it.skipIf(process.platform === "win32")(
    "confirms a real local process group and its child are stopped",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); process.stdout.write('ready'); setInterval(()=>{},1000)",
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.once("data", () => resolve());
          child.once("error", reject);
        });
        expect(isProcessGroupAlive(child.pid)).toBe(true);
        expect(await terminatePaProcess(child.pid!)).toBe(true);
        expect(isProcessGroupAlive(child.pid)).toBe(false);
      } finally {
        if (child.pid) await terminatePaProcess(child.pid);
      }
    },
  );
});
