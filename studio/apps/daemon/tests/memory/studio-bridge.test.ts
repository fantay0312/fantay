// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteMemoryEntry,
  listMemoryEntries,
  readMemoryEntry,
  upsertMemoryEntry,
  writeMemoryConfig,
} from "../../src/memory.js";
import { completeWithMemoryProvider } from "../../src/memory-llm.js";
import { __resetExtractionsForTests, listExtractions } from "../../src/memory-extractions.js";
import {
  createMemoryEngine,
  syncStudioProject,
  type MemoryEngineApi,
  type MemoryLlm,
} from "../../src/services/memory/index.js";
import { createStudioMemoryBridge, type StudioMemoryBridge } from "../../src/services/memory/studio-bridge.js";

const STUDIO_DDL = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, agent_name TEXT,
    position INTEGER NOT NULL, created_at INTEGER NOT NULL, branch_visible INTEGER NOT NULL DEFAULT 1
  );
`;

const T0 = Date.UTC(2026, 10, 9, 6, 0, 0);
const MINUTE = 60_000;

type Turn = ["user" | "assistant", string];

let db: Database.Database;
let dataDir: string;
let engine: MemoryEngineApi;
let clock: number;

function addConversation(id: string, title: string, turns: readonly Turn[], at = T0): void {
  db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    "proj-1",
    title,
    at,
    at + turns.length * MINUTE,
  );
  const insert = db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, agent_name, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  turns.forEach(([role, content], index) =>
    insert.run(`${id}-m${index}`, id, role, content, role === "assistant" ? "Claude" : null, index, at + index * MINUTE),
  );
}

function scriptedLlm(reply: (input: { system: string; user: string }) => string | null): MemoryLlm & {
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    async complete(input) {
      calls.push({ system: input.system, user: input.user });
      return reply(input);
    },
  };
}

function bridgeWith(overrides: Partial<Parameters<typeof createStudioMemoryBridge>[0]> = {}): StudioMemoryBridge {
  return createStudioMemoryBridge({ engine, db, dataDir, llm: null, ...overrides });
}

/** The engine with one method replaced, everything else forwarded. */
function engineWith(patch: Partial<MemoryEngineApi>): MemoryEngineApi {
  return new Proxy(engine, {
    get(target, key, receiver) {
      if (key in patch) return patch[key as keyof MemoryEngineApi];
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "od-studio-bridge-"));
  db = new Database(":memory:");
  db.exec(STUDIO_DDL);
  clock = T0 + 60 * MINUTE;
  engine = createMemoryEngine({ db, dataDir, now: () => clock });
  addConversation("conv-1", "配色讨论", [
    ["user", "首页 banner 动画时长定为 300ms，缓动用 ease-out"],
    ["assistant", "收到，banner 按 300ms 做"],
  ]);
});

afterEach(async () => {
  engine.dispose();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("recallForRun", () => {
  it("recalls a window of a sibling conversation and skips what this conversation already holds", async () => {
    addConversation(
      "conv-2",
      "首页布局",
      [
        ["user", "导航栏改成吸顶，banner 动画时长先不管"],
        ["assistant", "好的，导航栏吸顶"],
        ["user", "banner 动画时长之前定的多少？"],
      ],
      T0 + 30 * MINUTE,
    );
    const block = await bridgeWith().recallForRun({
      projectId: "proj-1",
      conversationId: "conv-2",
      query: "banner 动画时长之前定的多少？",
    });
    expect(block.startsWith("<memory>")).toBe(true);
    expect(block).toContain("banner 动画时长定为 300ms");
    // conv-2's own messages are all among its last 20, so its window is not quoted back.
    expect(block).not.toContain("导航栏改成吸顶");
    expect(engine.listChunks({ conversationId: "conv-1" }).total).toBe(1);
    expect(engine.status().recallLatencyMs?.samples).toBe(1);
  });

  it("returns nothing when Settings → 记忆 is off, and syncs nothing", async () => {
    await writeMemoryConfig(dataDir, { enabled: false });
    const block = await bridgeWith().recallForRun({ projectId: "proj-1", conversationId: "conv-2", query: "banner 动画时长" });
    expect(block).toBe("");
    expect(engine.listChunks({ conversationId: "conv-1" }).total).toBe(0);
  });

  it("returns nothing without a project or a query", async () => {
    const bridge = bridgeWith();
    expect(await bridge.recallForRun({ projectId: null, conversationId: "conv-1", query: "banner 动画时长" })).toBe("");
    expect(await bridge.recallForRun({ projectId: "proj-1", conversationId: "conv-1", query: "   " })).toBe("");
    expect(engine.listChunks({ conversationId: "conv-1" }).total).toBe(0);
  });

  it("returns nothing when no memory clears the cutoff", async () => {
    const block = await bridgeWith().recallForRun({ projectId: "proj-1", conversationId: "conv-9", query: "量子物理薛定谔方程" });
    expect(block).toBe("");
  });

  it("gives up after the timeout and aborts the recall", async () => {
    let seen: AbortSignal | undefined;
    const slow = engineWith({
      recall: (request) =>
        new Promise((_resolve, reject) => {
          seen = request.signal;
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const block = await bridgeWith({ engine: slow, recallTimeoutMs: 20 }).recallForRun({
      projectId: "proj-1",
      conversationId: "conv-2",
      query: "banner 动画时长",
    });
    expect(block).toBe("");
    expect(seen?.aborted).toBe(true);
  });

  it("turns a failing recall into an empty block", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = engineWith({ recall: () => Promise.reject(new Error("index is gone")) });
    const block = await bridgeWith({ engine: broken }).recallForRun({ projectId: "proj-1", query: "banner" });
    expect(block).toBe("");
    expect(warn).toHaveBeenCalledWith("[memory] studio recall failed", expect.any(Error));
    warn.mockRestore();
  });

  it("leaves the owner profile out when Settings has it switched off", async () => {
    engine.remember({ scope: { kind: "profile", id: "" }, content: "偏好 banner 动画时长不超过 400ms", pinned: true, actor: "owner" });
    const input = { projectId: "proj-1", conversationId: "conv-2", query: "banner 动画时长之前定的多少？" };
    expect(await bridgeWith().recallForRun(input)).toContain("不超过 400ms");
    await writeMemoryConfig(dataDir, { profileEnabled: false });
    const block = await bridgeWith().recallForRun(input);
    expect(block).toContain("banner 动画时长定为 300ms");
    expect(block).not.toContain("不超过 400ms");
  });

  it("syncs the turn's own conversation first and leaves the rest for later when the time is used up", () => {
    for (const id of ["conv-2", "conv-3", "conv-4"]) {
      addConversation(id, id, [["user", `${id} 里说过按钮圆角用 12px`], ["assistant", "好的"]]);
    }
    const total = (id: string) => engine.listChunks({ conversationId: id }).total;
    // No time at all: only the conversation named first is brought up to date.
    expect(syncStudioProject(engine.chunkSink, db, "proj-1", { budgetMs: -1, first: "conv-3" })).toBe(false);
    expect(["conv-1", "conv-2", "conv-3", "conv-4"].map(total)).toEqual([0, 0, 1, 0]);
    // Calling again continues: finished conversations are skipped, the others are synced.
    expect(syncStudioProject(engine.chunkSink, db, "proj-1")).toBe(true);
    expect(["conv-1", "conv-2", "conv-3", "conv-4"].map(total)).toEqual([1, 1, 1, 1]);
    expect(syncStudioProject(engine.chunkSink, db, "proj-1", { budgetMs: -1 })).toBe(true);
  });

  it("stops quoting a conversation once it is deleted, whichever way it was removed", async () => {
    addConversation("conv-2", "首页布局", [["user", "banner 动画时长之前定的多少？"]], T0 + 30 * MINUTE);
    const ask = () => bridgeWith().recallForRun({ projectId: "proj-1", conversationId: "conv-2", query: "banner 动画时长之前定的多少？" });
    expect(await ask()).toContain("banner 动画时长定为 300ms");
    expect(engine.listChunks({ conversationId: "conv-1" }).total).toBe(1);

    // The row and its messages are removed directly: no delete hook is involved.
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run("conv-1");
    db.prepare("DELETE FROM conversations WHERE id = ?").run("conv-1");
    expect(await ask()).not.toContain("300ms");
    expect(engine.listChunks({ conversationId: "conv-1" }).total).toBe(0);

    // The startup pass clears it too, even while memory is switched off.
    addConversation("conv-3", "临时", [["user", "临时约定导出格式用 WebP"], ["assistant", "好的"]]);
    await ask();
    expect(engine.listChunks({ conversationId: "conv-3" }).total).toBe(1);
    db.prepare("DELETE FROM conversations WHERE id = ?").run("conv-3");
    await writeMemoryConfig(dataDir, { enabled: false });
    await bridgeWith().backfillAll();
    expect(engine.listChunks({ conversationId: "conv-3" }).total).toBe(0);
  });

  it("backfills every project in the background, and not at all while memory is off", async () => {
    db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "other-1", "proj-2", "另一个项目", T0, T0 + MINUTE,
    );
    db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, agent_name, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("other-1-m0", "other-1", "user", "另一个项目里约定导出格式用 PNG", null, 0, T0);
    const total = (id: string) => engine.listChunks({ conversationId: id }).total;

    await writeMemoryConfig(dataDir, { enabled: false });
    await bridgeWith().backfillAll();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect([total("conv-1"), total("other-1")]).toEqual([0, 0]);

    await writeMemoryConfig(dataDir, { enabled: true });
    await bridgeWith().backfillAll();
    await vi.waitFor(() => expect([total("conv-1"), total("other-1")]).toEqual([1, 1]), { timeout: 2_000, interval: 20 });
  });

  it("queries with the tail of an over-long query", async () => {
    let query = "";
    const spy = engineWith({
      recall: async (request) => {
        query = request.query;
        return engine.recall(request);
      },
    });
    await bridgeWith({ engine: spy }).recallForRun({
      projectId: "proj-1",
      query: `${"旧的对话 ".repeat(800)}banner 动画时长`,
    });
    expect(query.length).toBe(2_000);
    expect(query.endsWith("banner 动画时长")).toBe(true);
  });
});

describe("afterRun", () => {
  const userText = "以后这个项目的按钮圆角都用 12px";
  const assistantText = "好的，按钮圆角统一改成 12px";
  const projectMemory = JSON.stringify({
    memories: [
      {
        scope: "project:proj-1",
        kind: "decision",
        content: "这个项目的按钮圆角统一用 12px",
        quote: "按钮圆角都用 12px",
        eventDate: null,
        dueDate: null,
      },
    ],
  });

  beforeEach(() => {
    addConversation("conv-2", "首页布局", [
      ["user", userText],
      ["assistant", assistantText],
    ]);
  });

  const run = { projectId: "proj-1", conversationId: "conv-2", userText, assistantText, assistantMessageId: "conv-2-m1" };

  it("syncs the conversation even when learning is off", async () => {
    const llm = scriptedLlm(() => projectMemory);
    await bridgeWith({ llm }).afterRun(run);
    expect(engine.listChunks({ conversationId: "conv-2" }).total).toBe(1);
    expect(llm.calls).toHaveLength(0);
  });

  it("distils the turn into the offered scopes when 从对话中学习 is on", async () => {
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    const llm = scriptedLlm(() => projectMemory);
    await bridgeWith({ llm }).afterRun(run);
    expect(llm.calls).toHaveLength(1);
    const call = llm.calls[0]!;
    for (const key of ["conversation:conv-2", "project:proj-1", "profile:"]) expect(call.user).toContain(key);
    expect(call.user).toContain(`用户: ${userText}`);
    expect(call.user).toContain(`助手: ${assistantText}`);
    const { items } = engine.listItems({ scope: { kind: "project", id: "proj-1" } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      content: "这个项目的按钮圆角统一用 12px",
      status: "active",
      origin: "llm_inferred",
      source: "项目对话 · 首页布局",
    });
    expect(items[0]?.sourceRefs).toEqual([
      { kind: "message", id: "conv-2-m1", conversationId: "conv-2", quote: "按钮圆角都用 12px" },
    ]);
  });

  it("asks for review instead of writing when the engine is set to review", async () => {
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    engine.updateConfig({ autoMemory: "review" });
    await bridgeWith({ llm: scriptedLlm(() => projectMemory) }).afterRun(run);
    const pending = engine.listItems({ scope: { kind: "project", id: "proj-1" }, statuses: ["pending"] }).items;
    expect(pending.map((item) => item.content)).toEqual(["这个项目的按钮圆角统一用 12px"]);
  });

  it("does not call a model when the engine's auto memory is off or memory is off", async () => {
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    engine.updateConfig({ autoMemory: "off" });
    const llm = scriptedLlm(() => projectMemory);
    await bridgeWith({ llm }).afterRun(run);
    expect(llm.calls).toHaveLength(0);

    engine.updateConfig({ autoMemory: "auto" });
    await writeMemoryConfig(dataDir, { enabled: false });
    await bridgeWith({ llm }).afterRun(run);
    expect(llm.calls).toHaveLength(0);
  });

  it("asks once per turn, prefers the run's own model, and skips an empty user turn", async () => {
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    const fallback = scriptedLlm(() => null);
    const runModel = scriptedLlm(() => null);
    const bridge = bridgeWith({ llm: fallback });
    await bridge.afterRun({ ...run, llm: runModel });
    await bridge.afterRun({ ...run, llm: runModel });
    expect(runModel.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0);
    await bridge.afterRun({ ...run, userText: "  " });
    expect(fallback.calls).toHaveLength(0);
    await bridge.afterRun({ ...run, assistantText: "换一个回答" });
    expect(fallback.calls).toHaveLength(1);
  });

  it("never rejects, whatever fails", async () => {
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = engineWith({
      distill: () => Promise.reject(new Error("model exploded")),
      chunkSink: {
        cursor: () => null,
        writeWindows: () => {
          throw new Error("disk full");
        },
      },
    });
    await expect(bridgeWith({ engine: broken, llm: scriptedLlm(() => null) }).afterRun(run)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[memory] studio conversation sync failed", expect.any(Error));
    expect(warn).toHaveBeenCalledWith("[memory] studio distill failed", expect.any(Error));
    warn.mockRestore();
  });

  it("does nothing without a conversation", async () => {
    await writeMemoryConfig(dataDir, { chatExtractionEnabled: true });
    const llm = scriptedLlm(() => projectMemory);
    await bridgeWith({ llm }).afterRun({ ...run, conversationId: null });
    expect(llm.calls).toHaveLength(0);
  });
});

describe("composeChatUserRequestForAgent with a memory recall", () => {
  let compose: typeof import("../../src/server.js").composeChatUserRequestForAgent;
  const transcript = "## user\n换个配色";
  const block = "<memory>\nMemory recalled for this request.\n## Relevant\n- [project · decision] 主色用青绿\n</memory>";
  const todos = [{ content: "补 FAQ", status: "pending" as const }];

  beforeAll(async () => {
    ({ composeChatUserRequestForAgent: compose } = await import("../../src/server.js"));
  }, 60_000);

  it("leaves the body byte-for-byte unchanged without a block", () => {
    const variants = [
      [transcript, "换个配色", {}],
      [transcript, "换个配色", { skipTranscript: true }],
      ["## user\n[form answers - discovery]\n- 风格: 极简", "[form answers - discovery]\n- 风格: 极简", {}],
      [transcript, "继续", { previousTurnTaskList: todos, resumeContinuationOriginalRequest: "做一个首页" }],
    ] as const;
    for (const [message, current, options] of variants) {
      const base = compose(message, current, options);
      expect(compose(message, current, { ...options, memoryRecall: null })).toBe(base);
      expect(compose(message, current, { ...options, memoryRecall: "" })).toBe(base);
      expect(compose(message, current, { ...options, memoryRecall: "  \n" })).toBe(base);
    }
  });

  it("puts the block before the turn's own words, in both the full and the resumed body", () => {
    const full = compose(transcript, "换个配色", { memoryRecall: block });
    expect(full).toBe(`${block}\n\n${transcript}`);
    const resumed = compose(transcript, "换个配色", { skipTranscript: true, memoryRecall: block });
    expect(resumed).toBe(`${block}\n\n换个配色`);
  });

  it("orders it after the continuation context and before the task list", () => {
    const body = compose(transcript, "继续", {
      memoryRecall: block,
      previousTurnTaskList: todos,
      resumeContinuationOriginalRequest: "做一个首页",
    });
    const at = (needle: string) => body.indexOf(needle);
    expect(at("做一个首页")).toBeGreaterThanOrEqual(0);
    expect(at("做一个首页")).toBeLessThan(at("<memory>"));
    expect(at("</memory>")).toBeLessThan(at("补 FAQ"));
    expect(at("补 FAQ")).toBeLessThan(at(transcript));
  });
});

describe("Settings → 记忆 keeps replaced and deleted text", () => {
  const draft = { id: "project_palette", name: "Palette", description: "Main colour", type: "project" as const };

  it("copies the previous file to .history before an overwrite that changes it", async () => {
    await upsertMemoryEntry(dataDir, { ...draft, body: "主色用蓝色 #2D6CDF" });
    const first = await readFile(join(dataDir, "memory", "project_palette.md"), "utf8");
    const entry = await upsertMemoryEntry(dataDir, { ...draft, body: "主色用青绿 #0FB5AE" });
    expect(entry).toMatchObject({ id: "project_palette", name: "Palette", type: "project" });
    const historyDir = join(dataDir, "memory", ".history", "project_palette");
    const kept = await readdir(historyDir);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^\d+\.md$/);
    expect(await readFile(join(historyDir, kept[0]!), "utf8")).toBe(first);
    expect((await readMemoryEntry(dataDir, "project_palette"))?.body.trim()).toBe("主色用青绿 #0FB5AE");

    // Writing the same text again keeps nothing new.
    await upsertMemoryEntry(dataDir, { ...draft, body: "主色用青绿 #0FB5AE" });
    expect(await readdir(historyDir)).toHaveLength(1);
  });

  it("moves a deleted entry to .trash, and the listing ignores both folders", async () => {
    await upsertMemoryEntry(dataDir, { ...draft, body: "主色用蓝色" });
    await upsertMemoryEntry(dataDir, { ...draft, body: "主色用青绿" });
    await upsertMemoryEntry(dataDir, { id: "user_role", name: "Role", description: "", type: "user", body: "设计师" });
    await expect(deleteMemoryEntry(dataDir, "project_palette")).resolves.toBeUndefined();
    const trashed = await readdir(join(dataDir, "memory", ".trash"));
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/^project_palette-\d+\.md$/);
    expect(await readFile(join(dataDir, "memory", ".trash", trashed[0]!), "utf8")).toContain("主色用青绿");
    expect(await readMemoryEntry(dataDir, "project_palette")).toBeNull();
    expect((await listMemoryEntries(dataDir)).map((entry) => entry.id)).toEqual(["user_role"]);
    // Deleting what is already gone stays quiet and makes no trash.
    await deleteMemoryEntry(dataDir, "project_palette");
    expect(await readdir(join(dataDir, "memory", ".trash"))).toHaveLength(1);
  });
});

describe("completeWithMemoryProvider", () => {
  const prompt = { system: "Reply with exactly one JSON object.", user: "{}" };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OD_MEMORY_MODEL", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) {
      vi.stubEnv(key, "");
    }
    fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: "{\"ok\":true}" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    __resetExtractionsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns null without a provider, and records nothing", async () => {
    expect(await completeWithMemoryProvider(dataDir, prompt)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listExtractions()).toEqual([]);
  });

  it("returns null when memory is off, even with a provider", async () => {
    await writeMemoryConfig(dataDir, {
      enabled: false,
      extraction: { provider: "openai", apiKey: "k", baseUrl: "http://127.0.0.1:9/v1", model: "m" },
    });
    expect(await completeWithMemoryProvider(dataDir, prompt)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps local_only text away from a remote provider", async () => {
    await writeMemoryConfig(dataDir, { extraction: { provider: "anthropic", apiKey: "k", model: "m" } });
    expect(await completeWithMemoryProvider(dataDir, prompt, { dataClass: "local_only" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the configured provider, in JSON mode only when the instructions ask for JSON", async () => {
    await writeMemoryConfig(dataDir, {
      extraction: { provider: "openai", apiKey: "k", baseUrl: "http://127.0.0.1:9/v1", model: "m" },
    });
    expect(await completeWithMemoryProvider(dataDir, prompt, { dataClass: "local_only" })).toBe("{\"ok\":true}");
    await completeWithMemoryProvider(dataDir, { system: "Merge two memories into one text.", user: "a\nb" });
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(bodies[0]).toMatchObject({ model: "m", response_format: { type: "json_object" } });
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(listExtractions()).toEqual([]);
  });

  it("throws a provider failure to the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await writeMemoryConfig(dataDir, {
      extraction: { provider: "openai", apiKey: "k", baseUrl: "http://127.0.0.1:9/v1", model: "m" },
    });
    await expect(completeWithMemoryProvider(dataDir, prompt)).rejects.toThrow(/openai 500/);
    warn.mockRestore();
  });
});
