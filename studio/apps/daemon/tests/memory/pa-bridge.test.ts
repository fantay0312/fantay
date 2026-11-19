// SPDX-License-Identifier: Apache-2.0
// The Personal Agent side of the memory engine: PaMemory mapping, the one-time import of the legacy PA store, the
// conversation reader, the text builders, the model adapter and the write observer.
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryItem, PaEpisode, PaMessage } from "@open-design/contracts";

import { MemoryError, createMemoryEngine, type MemoryEngineApi } from "../../src/services/memory/index.js";
import {
  createPaConversationReader,
  directEpisodeText,
  engineScopeOf,
  groupBotEpisodeText,
  groupEpisodeText,
  importLegacyPaMemories,
  paErrorOf,
  paKindOf,
  paMemoryLlm,
  paScopeOf,
  paStatusOf,
  sourceRefsOf,
  taskTranscript,
  toPaMemory,
  watchEngineWrites,
  type LegacyPaMemory,
  type LegacyPaMemoryVersion,
  type LegacyPaSource,
} from "../../src/services/memory/pa-bridge.js";
import type { PaModelRuntime } from "../../src/runtimes/personal-agent.js";
import { PaError } from "../../src/storage/personal-agent-store.js";

let db: Database.Database;
let engine: MemoryEngineApi;

beforeEach(() => {
  db = new Database(":memory:");
  engine = createMemoryEngine({ db, dataDir: join(tmpdir(), "pa-bridge-test") });
});
afterEach(() => {
  engine.dispose();
  db.close();
});

const item = (patch: Partial<MemoryItem> = {}): MemoryItem => ({
  id: "m1",
  scope: { kind: "bot", id: "bot-a" },
  kind: "fact",
  status: "active",
  origin: "user_explicit",
  pinned: false,
  dataClass: "standard",
  title: "",
  content: "喜欢雨天散步",
  source: "对话 · 小月",
  sourceRefs: [],
  via: null,
  authorId: "owner",
  eventAt: null,
  dueAt: null,
  validFrom: null,
  validUntil: null,
  supersededBy: null,
  revision: 3,
  versionCount: 1,
  openConflictIds: [],
  redacted: false,
  backing: "ledger",
  readOnly: false,
  createdAt: 10,
  updatedAt: 20,
  ...patch,
});

describe("PaMemory mapping", () => {
  it("maps scopes both ways and leaves persona and conversation scopes out", () => {
    expect(engineScopeOf("private", null)).toEqual({ kind: "profile", id: "" });
    expect(engineScopeOf("agent", "a")).toEqual({ kind: "bot", id: "a" });
    expect(engineScopeOf("group", "g")).toEqual({ kind: "group", id: "g" });
    expect(engineScopeOf("project", "p")).toEqual({ kind: "project", id: "p" });
    expect(paScopeOf({ kind: "profile", id: "" })).toEqual({ scope: "private", scopeId: null });
    expect(paScopeOf({ kind: "bot", id: "a" })).toEqual({ scope: "agent", scopeId: "a" });
    expect(paScopeOf({ kind: "persona", id: "p" })).toBeNull();
    expect(paScopeOf({ kind: "conversation", id: "c" })).toBeNull();
  });

  it("maps statuses: an open conflict reads as challenged, pending is not a PA memory", () => {
    expect(paStatusOf(item())).toBe("active");
    expect(paStatusOf(item({ openConflictIds: ["c1"] }))).toBe("challenged");
    expect(paStatusOf(item({ status: "superseded" }))).toBe("superseded");
    expect(paStatusOf(item({ status: "archived" }))).toBe("archived");
    expect(paStatusOf(item({ status: "rejected" }))).toBe("archived");
    expect(paStatusOf(item({ status: "pending" }))).toBeNull();
    expect(toPaMemory(item({ status: "pending" }))).toBeNull();
  });

  it("maps kinds the PA surface lacks to the closest PA kind", () => {
    expect(paKindOf("episode")).toBe("moment");
    expect(paKindOf("decision")).toBe("fact");
    expect(paKindOf("rule")).toBe("preference");
    expect(paKindOf("promise")).toBe("promise");
  });

  it("builds a PaMemory with the source message, principal and validity", () => {
    const memory = toPaMemory(
      item({ sourceRefs: [{ kind: "message", id: "msg-1", conversationId: "c" }], validFrom: 5, validUntil: 50 }),
      { principalId: "alice" },
    )!;
    expect(memory).toMatchObject({
      id: "m1", scope: "agent", scopeId: "bot-a", status: "active", revision: 3, sourceMessageId: "msg-1",
      validFrom: 5, validUntil: 50, principalId: "alice", originKind: "user_explicit",
    });
    expect(toPaMemory(item())!.principalId).toBeUndefined();
    expect(toPaMemory(item({ scope: { kind: "persona", id: "p" } }))).toBeNull();
    expect(toPaMemory(item({ scope: { kind: "persona", id: "p" } }), { asPrivate: true })).toMatchObject({
      scope: "private", scopeId: null,
    });
  });

  it("keeps sourceMessageId as the first message reference", () => {
    const refs = sourceRefsOf(
      { sourceMessageId: "msg-2", sourceRefs: [{ kind: "attempt", id: "a1" }, { kind: "message", id: "msg-2" }] },
      [{ kind: "pa_memory", id: "m0" }],
    );
    expect(refs).toEqual([{ kind: "message", id: "msg-2" }, { kind: "attempt", id: "a1" }, { kind: "pa_memory", id: "m0" }]);
  });

  it("reports engine errors as PA errors", () => {
    const missing = paErrorOf(new MemoryError("MEMORY_NOT_FOUND", "x", 404)) as PaError;
    expect([missing.status, missing.code]).toEqual([404, "PA_NOT_FOUND"]);
    const stale = paErrorOf(new MemoryError("MEMORY_REVISION_CONFLICT", "x", 409)) as PaError;
    expect([stale.status, stale.code]).toEqual([409, "PA_REVISION_CONFLICT"]);
    const blocked = paErrorOf(new MemoryError("MEMORY_SECRET_BLOCKED", "blocked", 400)) as PaError;
    expect([blocked.status, blocked.code, blocked.message]).toEqual([400, "PA_MEMORY_SECRET_BLOCKED", "blocked"]);
    const other = new Error("x");
    expect(paErrorOf(other)).toBe(other);
  });
});

describe("legacy import", () => {
  const legacyMemory = (patch: Partial<LegacyPaMemory> & { id: string }): LegacyPaMemory => ({
    content: "",
    source: "user",
    scope: "private",
    scopeId: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    revision: 1,
    ...patch,
  });
  function source(input: {
    memories: LegacyPaMemory[];
    versions?: LegacyPaMemoryVersion[];
    episodes?: PaEpisode[];
    files: Record<string, string>;
  }): LegacyPaSource & { reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      memories: () => input.memories,
      versions: () => input.versions ?? [],
      episodes: () => input.episodes ?? [],
      readText: (name) => {
        reads.push(name);
        return input.files[name] ?? null;
      },
    };
  }

  it("imports text, versions, statuses, relations and episodes, and runs again without changing anything", () => {
    const legacy = source({
      memories: [
        legacyMemory({ id: "pref", fileName: "pref-x.md", revision: 4, kind: "fact", originKind: "user_explicit", pinned: true }),
        legacyMemory({ id: "old-city", fileName: "old-city.md", scope: "agent", scopeId: "bot-a", status: "superseded" }),
        legacyMemory({
          id: "new-city", fileName: "new-city.md", scope: "agent", scopeId: "bot-a", revision: 2,
          evolves: { targetId: "old-city", relation: "supersedes" },
        }),
        legacyMemory({ id: "tea", fileName: "tea.md", scope: "agent", scopeId: "bot-a", status: "challenged" }),
        legacyMemory({
          id: "coffee", fileName: "coffee.md", scope: "agent", scopeId: "bot-a",
          evolves: { targetId: "tea", relation: "challenges" },
        }),
        legacyMemory({
          id: "detail", fileName: "detail.md", scope: "agent", scopeId: "bot-a",
          evolves: { targetId: "tea", relation: "enriches" },
        }),
        legacyMemory({ id: "gone", fileName: "gone.md", principalId: "alice" }),
        legacyMemory({ id: "put-away", fileName: "put-away.md", status: "archived" }),
        legacyMemory({ id: "orphan", fileName: "orphan.md", status: "superseded" }),
        legacyMemory({ id: "no-target", scope: "group", scopeId: null }),
      ],
      versions: [
        { ...legacyMemory({ id: "pref:2", fileName: "pref-v1.md" }), memoryId: "pref", sourceRevision: 2 },
        { ...legacyMemory({ id: "pref:3", fileName: "pref-v2.md" }), memoryId: "pref", sourceRevision: 3 },
      ],
      episodes: [
        {
          id: "task-1", taskId: "task-1", conversationId: "conv-g", agentId: null, projectId: null, groupId: "group-1",
          dataClass: "standard", summary: "[Task] 写简介\n[Outcome] 完成", outcome: "completed", artifactIds: [],
          memoryRefs: [], eventStartAt: 1, eventEndAt: 2, createdAt: 3, updatedAt: 3, revision: 1,
        },
        {
          id: "task-2", taskId: "task-2", conversationId: "conv-a", agentId: "bot-a", projectId: null, groupId: null,
          dataClass: "local_only", summary: "[Task] 本机任务", outcome: "completed", artifactIds: [], memoryRefs: [],
          eventStartAt: 1, eventEndAt: 2, createdAt: 3, updatedAt: 3, revision: 1,
        },
      ],
      files: {
        "pref-v1.md": "回复用英文",
        "pref-v2.md": "回复用中文",
        "pref-x.md": "回复用中文，结论先行",
        "old-city.md": "住在上海",
        "new-city.md": "住在杭州",
        "tea.md": "早上喝茶",
        "coffee.md": "早上喝咖啡",
        "detail.md": "茶要绿茶",
        "put-away.md": "旧的爱好",
        "orphan.md": "没有后继的旧记忆",
      },
    });
    const report = importLegacyPaMemories(engine, legacy);
    expect(report).toMatchObject({ memories: 9, versions: 2, episodes: 2, redacted: 1, skipped: 1, conflictsOpened: 1 });
    expect(report.skips).toEqual(
      expect.arrayContaining([{ id: "gone", reason: "missing", count: 1 }, { id: "no-target", reason: "no_scope" }]),
    );
    expect(report.skips).toHaveLength(2);

    // Text, versions and the legacy revision of the last text change.
    const pref = engine.getRow("pref")!;
    expect(pref).toMatchObject({ content: "回复用中文，结论先行", revision: 4, contentRevision: 4, pinned: true });
    expect(engine.history("pref").versions.map((version) => version.content)).toEqual([
      "回复用英文", "回复用中文", "回复用中文，结论先行",
    ]);
    // supersedes: the owner's earlier choice is a decided conflict.
    expect(engine.getRow("old-city")).toMatchObject({ status: "superseded", supersededBy: "new-city" });
    expect(engine.listConflicts({ status: "resolved" }).map((c) => [c.incoming.id, c.existing.id, c.resolution]))
      .toEqual([["new-city", "old-city", "keep_new"]]);
    // challenges: an open conflict, both active.
    const open = engine.listConflicts({ status: "open" });
    expect(open.map((c) => [c.incoming.id, c.existing.id])).toEqual([["coffee", "tea"]]);
    expect(engine.getRow("tea")!.status).toBe("active");
    // enriches: a source reference to the memory it adds to.
    expect(engine.getRow("detail")!.sourceRefs).toContainEqual({ kind: "pa_memory", id: "tea" });
    // A missing file: the id resolves, without text.
    expect(engine.getRow("gone")).toMatchObject({ redacted: true, content: "", principalId: "alice", status: "active" });
    expect(engine.getRow("put-away")!.status).toBe("archived");
    expect(engine.getRow("orphan")!.status).toBe("archived");
    expect(engine.getRow("no-target")).toBeNull();
    // Episodes: the group's in the group, a 1:1's in the bot.
    expect(engine.getRow("pa-episode-task-1")).toMatchObject({ scopeKind: "group", scopeId: "group-1", kind: "episode" });
    expect(engine.getRow("pa-episode-task-2")).toMatchObject({ scopeKind: "bot", scopeId: "bot-a", dataClass: "local_only" });

    const before = engine.listItems({ statuses: ["active", "superseded", "archived", "rejected"], includeLocalOnly: true });
    const again = importLegacyPaMemories(engine, legacy);
    expect(again).toMatchObject({ memories: 0, versions: 0, episodes: 0, redacted: 0, conflictsOpened: 0 });
    const after = engine.listItems({ statuses: ["active", "superseded", "archived", "rejected"], includeLocalOnly: true });
    expect(after.items.map((row) => [row.id, row.revision, row.status])).toEqual(
      before.items.map((row) => [row.id, row.revision, row.status]),
    );
  });

  it("imports a memory whose text the write gate refuses as a redacted record", () => {
    const legacy = source({
      memories: [legacyMemory({ id: "key", fileName: "key.md" })],
      files: { "key.md": "my api_key = sk-ant-abcdefghijklmnopqrstuvwxyz0123" },
    });
    expect(importLegacyPaMemories(engine, legacy)).toMatchObject({
      memories: 1, redacted: 1, skips: [{ id: "key", reason: "refused", count: 1 }],
    });
    expect(engine.getRow("key")).toMatchObject({ redacted: true, content: "" });
  });

  const legacyVersion = (memoryId: string, sourceRevision: number, fileName: string): LegacyPaMemoryVersion => ({
    ...legacyMemory({ id: `${memoryId}:${sourceRevision}`, fileName }),
    memoryId,
    sourceRevision,
  });
  const legacyEpisode = (id: string, patch: Partial<PaEpisode> = {}): PaEpisode => ({
    id, taskId: id, conversationId: `conv-${id}`, agentId: "bot-a", projectId: null, groupId: null,
    dataClass: "standard", summary: `[Task] ${id}`, outcome: "completed", artifactIds: [], memoryRefs: [],
    eventStartAt: 1, eventEndAt: 2, createdAt: 3, updatedAt: 3, revision: 1, ...patch,
  });
  const versionsOf = (target: MemoryEngineApi, id: string) =>
    target.history(id).versions.map((version) => version.content);

  it("imports two memories with the same words in one scope as two records, each keeping its status", () => {
    const legacy = source({
      memories: [
        legacyMemory({ id: "twin-old", fileName: "twin-old.md", status: "archived", createdAt: 1_000 }),
        legacyMemory({ id: "twin-new", fileName: "twin-new.md", createdAt: 2_000 }),
      ],
      episodes: [legacyEpisode("task-a", { summary: "[Task] 写周报" }), legacyEpisode("task-b", { summary: "[Task] 写周报" })],
      files: { "twin-old.md": "我住在杭州", "twin-new.md": "我住在杭州" },
    });
    expect(importLegacyPaMemories(engine, legacy)).toMatchObject({ memories: 2, episodes: 2, skipped: 0, skips: [] });
    expect(engine.getRow("twin-old")).toMatchObject({ status: "archived", content: "我住在杭州" });
    expect(engine.getRow("twin-new")).toMatchObject({ status: "active", content: "我住在杭州" });
    expect(engine.getRow("pa-episode-task-a")!.content).toBe("[Task] 写周报");
    expect(engine.getRow("pa-episode-task-b")!.content).toBe("[Task] 写周报");
  });

  it("keeps the readable versions of a memory whose current file is missing, and puts it away behind a placeholder", () => {
    const legacy = source({
      memories: [legacyMemory({ id: "f", fileName: "f-now.md", revision: 3 })],
      versions: [legacyVersion("f", 1, "f-v1.md"), legacyVersion("f", 2, "f-v2.md")],
      files: { "f-v1.md": "第一版：项目代号 Atlas", "f-v2.md": "第二版：项目代号 Borealis" },
    });
    expect(importLegacyPaMemories(engine, legacy)).toMatchObject({
      memories: 1, versions: 1, putAway: 1, redacted: 0, skips: [{ id: "f", reason: "missing", count: 1 }],
    });
    expect(engine.getRow("f")).toMatchObject({ status: "archived", redacted: false, content: "（原记忆文件缺失：f）" });
    const { versions } = engine.history("f");
    expect(versions.map((version) => version.content)).toEqual([
      "第一版：项目代号 Atlas", "第二版：项目代号 Borealis", "（原记忆文件缺失：f）",
    ]);
    expect(versions.at(-1)!.note).toContain("当前记忆文件缺失");
    // Put away, so the placeholder is never recalled as if it were text.
    expect(engine.listItems({}).items.map((row) => row.id)).not.toContain("f");
  });

  it("starts from the first version the write gate accepts, keeps the later ones and notes how many were refused", () => {
    const secret = "my api_key = sk-ant-abcdefghijklmnopqrstuvwxyz0123";
    const legacy = source({
      memories: [
        legacyMemory({ id: "k", fileName: "k-now.md", revision: 3 }),
        legacyMemory({ id: "k2", fileName: "k2-now.md", revision: 2 }),
      ],
      versions: [legacyVersion("k", 1, "k-v1.md"), legacyVersion("k", 2, "k-v2.md"), legacyVersion("k2", 1, "k2-v1.md")],
      files: {
        "k-v1.md": secret,
        "k-v2.md": "密钥改用环境变量保存",
        "k-now.md": "密钥放在系统钥匙串里",
        "k2-v1.md": "早期备注：周三交稿",
        "k2-now.md": `token ${secret}`,
      },
    });
    const report = importLegacyPaMemories(engine, legacy);
    expect(report).toMatchObject({ memories: 2, redacted: 0, putAway: 1 });
    expect(report.skips).toEqual([{ id: "k", reason: "refused", count: 1 }, { id: "k2", reason: "refused", count: 1 }]);

    expect(engine.getRow("k")).toMatchObject({ status: "active", redacted: false, content: "密钥放在系统钥匙串里" });
    const k = engine.history("k").versions;
    expect(k.map((version) => version.content)).toEqual(["密钥改用环境变量保存", "密钥放在系统钥匙串里"]);
    expect(k[1]!.note).toContain("1 个版本未通过写入安全检查");
    // A refused current text is never replaced by an older one: a placeholder stands in and the memory is put away.
    expect(engine.getRow("k2")).toMatchObject({ status: "archived", redacted: false });
    const k2 = engine.history("k2").versions;
    expect(k2.map((version) => version.content)).toEqual([
      "早期备注：周三交稿", "（原记忆内容未通过写入安全检查，未导入：k2）",
    ]);
    expect(k2[1]!.note).toContain("当前内容未通过写入安全检查");
    expect(JSON.stringify([...k, ...k2])).not.toContain("sk-ant-");
  });

  describe("a rerun", () => {
    const WRITES: ReadonlySet<PropertyKey> = new Set(["remember", "revise", "archive", "restore", "redact", "resolveConflict"]);
    /** Counts engine writes, and throws a plain error (a crash) instead of the `cutAt`-th one. */
    function interrupted(target: MemoryEngineApi, cutAt = Infinity): { engine: MemoryEngineApi; writes: () => number } {
      let writes = 0;
      const proxy = new Proxy(target, {
        get(object, property) {
          const value: unknown = Reflect.get(object, property, object);
          if (typeof value !== "function" || !WRITES.has(property)) return value;
          return (...args: unknown[]) => {
            writes += 1;
            if (writes === cutAt) throw new Error("cut short");
            return (value as (...a: unknown[]) => unknown).apply(object, args);
          };
        },
      });
      return { engine: proxy, writes: () => writes };
    }
    function snapshot(target: MemoryEngineApi) {
      const items = target
        .listItems({ statuses: ["active", "pending", "superseded", "archived", "rejected"], includeLocalOnly: true })
        .items.map((row) => ({
          id: row.id, status: row.status, supersededBy: row.supersededBy, redacted: row.redacted, revision: row.revision,
          versions: target.history(row.id).versions.map((version) => [version.content, version.note]),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const conflicts = [...target.listConflicts({ status: "open" }), ...target.listConflicts({ status: "resolved" })]
        .map((c) => [c.incoming.id, c.existing.id, c.status, c.resolution].join(" "))
        .sort();
      return { items, conflicts };
    }
    const fixture = () =>
      source({
        memories: [
          legacyMemory({ id: "pref", fileName: "pref-now.md", revision: 4, pinned: true }),
          legacyMemory({ id: "old-city", fileName: "old-city.md", scope: "agent", scopeId: "bot-a", status: "superseded" }),
          legacyMemory({
            id: "new-city", fileName: "new-city.md", scope: "agent", scopeId: "bot-a", revision: 2,
            evolves: { targetId: "old-city", relation: "supersedes" },
          }),
          legacyMemory({ id: "tea", fileName: "tea.md", scope: "agent", scopeId: "bot-a", status: "challenged" }),
          legacyMemory({
            id: "coffee", fileName: "coffee.md", scope: "agent", scopeId: "bot-a",
            evolves: { targetId: "tea", relation: "challenges" },
          }),
          legacyMemory({ id: "put-away", fileName: "put-away.md", status: "archived" }),
          legacyMemory({ id: "f", fileName: "f-now.md", revision: 2 }),
          legacyMemory({ id: "gone", fileName: "gone.md" }),
          legacyMemory({ id: "twin-old", fileName: "twin-old.md", status: "archived" }),
          legacyMemory({ id: "twin-new", fileName: "twin-new.md" }),
        ],
        versions: [
          legacyVersion("pref", 2, "pref-v1.md"), legacyVersion("pref", 3, "pref-v2.md"), legacyVersion("f", 1, "f-v1.md"),
        ],
        episodes: [legacyEpisode("task-1", { agentId: null, groupId: "group-1", summary: "[Task] 写简介" })],
        files: {
          "pref-v1.md": "回复用英文", "pref-v2.md": "回复用中文", "pref-now.md": "回复用中文，结论先行",
          "old-city.md": "住在上海", "new-city.md": "住在杭州", "tea.md": "早上喝茶", "coffee.md": "早上喝咖啡",
          "put-away.md": "旧的爱好", "f-v1.md": "第一版：项目代号 Atlas", "twin-old.md": "周五健身", "twin-new.md": "周五健身",
        },
      });

    it("finishes an import that was cut short at any write, ending where an uninterrupted import ends", () => {
      const counted = interrupted(engine);
      importLegacyPaMemories(counted.engine, fixture());
      const whole = snapshot(engine);
      expect(whole.conflicts).toEqual(["coffee tea open ", "new-city old-city resolved keep_new"]);
      expect(counted.writes()).toBeGreaterThan(15);

      for (let cutAt = 1; cutAt <= counted.writes(); cutAt += 1) {
        const partDb = new Database(":memory:");
        const part = createMemoryEngine({ db: partDb, dataDir: join(tmpdir(), "pa-bridge-test") });
        try {
          expect(() => importLegacyPaMemories(interrupted(part, cutAt).engine, fixture())).toThrow("cut short");
          importLegacyPaMemories(part, fixture());
          expect(snapshot(part), `cut at write ${cutAt}`).toEqual(whole);
        } finally {
          part.dispose();
          partDb.close();
        }
      }
    });

    it("leaves what a person changed after the import as it is", () => {
      importLegacyPaMemories(engine, fixture());
      engine.restore("put-away", "owner");
      engine.revise("pref", { content: "回复用中文，先给结论再给理由", actor: "owner" });
      engine.revise("f", { content: "第二版：项目代号 Borealis", actor: "owner" });
      engine.restore("f", "owner");
      const before = snapshot(engine);
      expect(importLegacyPaMemories(engine, fixture())).toMatchObject({
        memories: 0, versions: 0, episodes: 0, redacted: 0, putAway: 0, conflictsOpened: 0,
      });
      expect(snapshot(engine)).toEqual(before);
      expect(engine.getRow("put-away")!.status).toBe("active");
      expect(versionsOf(engine, "pref").at(-1)).toBe("回复用中文，先给结论再给理由");
    });
  });

  it("reports what it left out by id and reason, within a bound", () => {
    const small = importLegacyPaMemories(engine, source({
      memories: [legacyMemory({ id: "no-target", scope: "group", scopeId: null })],
      episodes: [
        legacyEpisode("ep-nowhere", { agentId: null, groupId: null }),
        legacyEpisode("ep-empty", { summary: "  " }),
        legacyEpisode("ep-secret", { summary: "token sk-ant-abcdefghijklmnopqrstuvwxyz0123" }),
      ],
      files: {},
    }));
    expect(small).toMatchObject({ skipped: 4, skipsOmitted: 0 });
    expect(small.skips).toEqual([
      { id: "no-target", reason: "no_scope" },
      { id: "ep-nowhere", reason: "no_scope" },
      { id: "ep-empty", reason: "no_text" },
      { id: "ep-secret", reason: "refused", count: 1 },
    ]);

    const many = importLegacyPaMemories(engine, source({
      memories: Array.from({ length: 105 }, (_, n) => legacyMemory({ id: `lost-${n}`, scope: "group", scopeId: null })),
      files: {},
    }));
    expect(many).toMatchObject({ skipped: 105, skipsOmitted: 5 });
    expect(many.skips).toHaveLength(100);
    expect(many.skips[0]).toEqual({ id: "lost-0", reason: "no_scope" });
  });
});

describe("conversation reader", () => {
  const message = (patch: Partial<PaMessage> & { id: string }): PaMessage => ({
    conversationId: "conv",
    taskId: null,
    senderId: "owner",
    content: "hi",
    targetAgentIds: [],
    replyTo: null,
    createdAt: 100,
    updatedAt: 100,
    revision: 1,
    ...patch,
  });

  it("names speakers, marks bot messages and drops what may not be quoted", () => {
    const reader = createPaConversationReader({
      conversation: (id) =>
        id === "conv"
          ? { id, title: "协作工作室", agentId: null, groupId: "g", channelId: "ch", createdAt: 1, updatedAt: 1, revision: 1 }
          : null,
      messages: () => [
        message({ id: "1", content: "早上好" }),
        message({ id: "2", senderId: "bot-a", content: "早", dataClass: "local_only" }),
        message({ id: "3", senderId: "owner", content: "掷出 6", soul: { kind: "roll" } }),
        message({ id: "4", senderId: "bot-gone", content: "旧消息" }),
        message({ id: "5", senderId: "bot-a", content: "不能引用" }),
        message({ id: "6", content: "   " }),
      ],
      include: (item) => item.id !== "5",
      agentName: (id) => (id === "bot-a" ? "小月" : null),
    });
    expect(reader.conversation("conv")).toEqual({
      id: "conv", title: "协作工作室", agentId: null, groupId: "g", channel: true, principalId: "owner",
    });
    expect(reader.conversation("missing")).toBeNull();
    expect(reader.messages("conv").map((m) => [m.id, m.speaker, m.agentId, m.dataClass])).toEqual([
      ["1", "用户", null, "standard"],
      ["2", "小月", "bot-a", "local_only"],
      ["3", "旁白", null, "standard"],
      ["4", "助手", "bot-gone", "standard"],
    ]);
  });
});

describe("text builders", () => {
  it("writes one line per episode, cutting long parts", () => {
    const own = groupBotEpisodeText({ groupName: "协作工作室", goal: "写一份\n品牌简介", contribution: "给出初稿", outcome: "审阅通过" });
    expect(own).toBe("在群聊「协作工作室」讨论：写一份 品牌简介；我的发言：给出初稿；结果：审阅通过");
    expect(groupBotEpisodeText({ groupName: "g", goal: "x", contribution: "同一段", outcome: "同一段" })).toBe(
      "在群聊「g」讨论：x；我的发言：同一段",
    );
    expect(groupEpisodeText({ groupName: "g", goal: "x", participants: ["小月", "阿星"], outcome: "" })).toBe(
      "群聊「g」完成任务：x；参与：小月、阿星；结果：已完成",
    );
    expect(directEpisodeText({ goal: "a".repeat(300), outcome: "ok" })).toMatch(/^完成任务：a{239}…；结果：ok$/);
    expect(taskTranscript([{ speaker: "用户", text: " 你好 " }, { speaker: "小月", text: "" }])).toBe("用户: 你好");
  });
});

describe("model adapter", () => {
  it("keeps local_only text off remote models and removes credentials", async () => {
    const execute = vi.fn<PaModelRuntime["execute"]>(async () => ({ text: "{}", usage: { visibility: "unknown" } }));
    const runtime: PaModelRuntime = { models: async () => [], execute };
    const cloud = paMemoryLlm(runtime, { runtime: "claude", modelId: "sonnet" });
    expect(await cloud.complete({ system: "s", user: "u", dataClass: "local_only" })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(await cloud.complete({ system: "s", user: "token sk-ant-abcdefghijklmnopqrstuvwxyz" })).toBe("{}");
    expect(execute.mock.calls[0]![1]).toContain("[credential removed]");
    const local = paMemoryLlm(runtime, { runtime: "ollama", modelId: "qwen" });
    await local.complete({ system: "s", user: "u", dataClass: "local_only" });
    expect(execute.mock.calls[1]![4]).toEqual({ dataClass: "local_only" });
  });
});

describe("write observer", () => {
  it("reports writes, not reads", async () => {
    const onWrite = vi.fn();
    const watched = watchEngineWrites(engine, onWrite);
    const { item: written } = watched.remember({ scope: { kind: "profile", id: "" }, content: "早睡", actor: "owner" });
    expect(onWrite).toHaveBeenCalledTimes(1);
    watched.getItem(written.id);
    watched.listItems({});
    expect(onWrite).toHaveBeenCalledTimes(1);
    watched.archive(written.id, "owner");
    expect(onWrite).toHaveBeenCalledTimes(2);
    await watched.distill({ transcript: "", targets: [], source: "x" });
    expect(onWrite).toHaveBeenCalledTimes(3);
    expect(watched.chunkSink).toBe(engine.chunkSink);
  });
});
