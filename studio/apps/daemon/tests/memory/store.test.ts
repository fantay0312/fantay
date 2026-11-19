// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../../src/services/memory/store.js";
import { contentHash } from "../../src/services/memory/text.js";
import { MemoryError, type ChunkWindow } from "../../src/services/memory/types.js";

const memoryDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/services/memory");

let clock = 1_000;
let db: Database.Database;
let store: MemoryStore;

beforeEach(() => {
  clock = 1_000;
  db = new Database(":memory:");
  store = new MemoryStore(db, () => clock);
});

function tick(ms = 10): number {
  clock += ms;
  return clock;
}

function expectMemoryError(fn: () => unknown, code: MemoryError["code"], status: number): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MemoryError);
  expect((caught as MemoryError).code).toBe(code);
  expect((caught as MemoryError).status).toBe(status);
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function window(seq: number, content: string, open = false): ChunkWindow {
  return {
    seq,
    content,
    speakers: ["用户", "小月"],
    speakerAgentIds: ["bot-1"],
    messageIds: [`m${seq}a`, `m${seq}b`],
    startAt: 100 + seq,
    endAt: 200 + seq,
    open,
  };
}

describe("MemoryStore items", () => {
  it("inserts version 1 and a created event in one write", () => {
    const row = store.insertItem({ scope: { kind: "project", id: "p1" }, content: "首页主色用青绿" }, "owner");
    expect(row).toMatchObject({
      scopeKind: "project",
      scopeId: "p1",
      principalId: "owner",
      kind: "fact",
      status: "active",
      origin: "user_explicit",
      revision: 1,
      contentRevision: 1,
      versionCount: 1,
      redacted: false,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(row.contentHash).toBe(contentHash("首页主色用青绿"));
    expect(store.getItem(row.id)).toEqual(row);
    expect(store.versions(row.id)).toEqual([
      { version: 1, title: "", content: "首页主色用青绿", actor: "owner", note: "", createdAt: 1_000 },
    ]);
    expect(store.events(row.id)).toMatchObject([
      { type: "created", actor: "owner", itemId: row.id, conflictId: null, data: { status: "active" } },
    ]);
  });

  it("normalizes the profile scope id and records a given event type with data", () => {
    const row = store.insertItem(
      {
        scope: { kind: "profile", id: "ignored" },
        content: "回复用中文",
        kind: "preference",
        status: "pending",
        origin: "imported",
        sourceRefs: [{ kind: "message", id: "m1", quote: "回复用中文" }],
        via: { groupId: "g1", groupName: "协作工作室" },
      },
      "system",
      "imported",
      { from: "legacy" },
    );
    expect(row.scopeId).toBe("");
    const stored = store.getItem(row.id);
    expect(stored?.sourceRefs).toEqual([{ kind: "message", id: "m1", quote: "回复用中文" }]);
    expect(stored?.via).toEqual({ groupId: "g1", groupName: "协作工作室" });
    expect(store.events(row.id)[0]).toMatchObject({ type: "imported", data: { status: "pending", from: "legacy" } });
  });

  it("returns items in the order asked and skips missing ones", () => {
    const a = store.insertItem({ scope: { kind: "bot", id: "b1" }, content: "a" }, "owner");
    const b = store.insertItem({ scope: { kind: "bot", id: "b1" }, content: "b" }, "owner");
    expect(store.getItems([b.id, "missing", a.id, b.id]).map((row) => row.id)).toEqual([b.id, a.id]);
    expect(store.getItems([])).toEqual([]);
  });

  it("filters, orders and pages the item list", () => {
    const bot = { kind: "bot", id: "b1" } as const;
    const first = store.insertItem({ scope: bot, content: "Uses Neovim", kind: "fact" }, "owner");
    tick();
    const second = store.insertItem({ scope: bot, content: "喜欢深色主题", kind: "preference", pinned: true }, "owner");
    tick();
    store.insertItem({ scope: bot, content: "群里定的周会时间", via: { groupId: "g1" } }, "owner");
    tick();
    store.insertItem({ scope: bot, content: "local secret plan", dataClass: "local_only" }, "owner");
    store.insertItem({ scope: { kind: "profile", id: "" }, content: "名字叫小明" }, "owner");
    store.insertItem({ scope: bot, content: "member note", principalId: "member-1" }, "owner");
    store.setStatus(first.id, "archived", { actor: "owner", event: "archived" });

    const active = store.listItems({ scope: bot, statuses: ["active"], principalId: "owner" });
    expect(active.total).toBe(2);
    expect(active.rows.map((row) => row.content)).toEqual(["群里定的周会时间", "喜欢深色主题"]);
    expect(store.listItems({ scope: bot, includeLocalOnly: true, principalId: "owner" }).total).toBe(4);
    expect(store.listItems({ scopeKeys: ["profile:", "bot:b1"], principalId: "owner" }).total).toBe(4);
    expect(store.listItems({ scopeKeys: [] }).total).toBe(0);
    expect(store.listItems({ kind: "preference" }).rows.map((row) => row.id)).toEqual([second.id]);
    expect(store.listItems({ pinned: true }).rows.map((row) => row.id)).toEqual([second.id]);
    expect(store.listItems({ viaGroup: true }).rows.map((row) => row.content)).toEqual(["群里定的周会时间"]);
    expect(store.listItems({ viaGroup: false, scope: bot, principalId: "owner" }).total).toBe(2);
    expect(store.listItems({ text: "NEOVIM" }).rows.map((row) => row.id)).toEqual([first.id]);
    expect(store.listItems({ text: "深色" }).total).toBe(1);
    expect(store.listItems({ principalId: "member-1" }).total).toBe(1);

    const paged = store.listItems({ order: "created_asc", limit: 2, offset: 1 });
    expect(paged.total).toBe(5);
    expect(paged.rows.map((row) => row.content)).toEqual(["喜欢深色主题", "群里定的周会时间"]);
  });

  it("finds an exact duplicate by hash, preferring an active one", () => {
    const scope = { kind: "project", id: "p1" } as const;
    const archived = store.insertItem({ scope, content: "Deploy on Fridays" }, "owner");
    store.setStatus(archived.id, "archived", { actor: "owner", event: "archived" });
    tick();
    const active = store.insertItem({ scope, content: "deploy  on fridays" }, "owner");
    expect(store.findByHash(scope, contentHash("Deploy on Fridays"), "owner")?.id).toBe(active.id);
    expect(store.findByHash(scope, contentHash("Deploy on Fridays"), "member-1")).toBeNull();
    expect(store.findByHash({ kind: "project", id: "p2" }, contentHash("Deploy on Fridays"), "owner")).toBeNull();
  });
});

describe("MemoryStore changes", () => {
  it("appends versions on edit and keeps every earlier text", () => {
    const row = store.insertItem({ scope: { kind: "bot", id: "b1" }, content: "v1", title: "t" }, "owner");
    tick();
    const second = store.appendVersion(row.id, { content: "v2", actor: "agent:b1", note: "纠正" });
    expect(second).toMatchObject({ content: "v2", title: "t", revision: 2, contentRevision: 2, versionCount: 2 });
    tick();
    const third = store.appendVersion(row.id, { content: "v2", title: "new title", actor: "owner" });
    expect(third).toMatchObject({ revision: 3, contentRevision: 3, versionCount: 3, title: "new title" });
    expect(store.appendVersion(row.id, { content: "v2", title: "new title", actor: "owner" })).toEqual(third);
    expect(store.versions(row.id).map((v) => [v.version, v.title, v.content, v.actor, v.note])).toEqual([
      [1, "t", "v1", "owner", ""],
      [2, "t", "v2", "agent:b1", "纠正"],
      [3, "new title", "v2", "owner", ""],
    ]);
    expect(store.events(row.id).map((event) => event.type)).toEqual(["created", "revised", "revised"]);
    expect(store.events(row.id)[1]?.data).toEqual({ version: 2, note: "纠正" });
  });

  it("changes status, pin and metadata with an event each, leaving the text revision alone", () => {
    const row = store.insertItem({ scope: { kind: "bot", id: "b1" }, content: "x", kind: "promise" }, "owner");
    tick();
    const pinned = store.setPinned(row.id, true, "owner");
    expect(pinned).toMatchObject({ pinned: true, revision: 2, contentRevision: 1, updatedAt: clock });
    expect(store.setPinned(row.id, true, "owner").revision).toBe(2);
    const meta = store.patchMeta(row.id, { kind: "decision", dueAt: 5_000, validFrom: undefined }, "owner");
    expect(meta).toMatchObject({ kind: "decision", dueAt: 5_000, validFrom: null, revision: 3, contentRevision: 1 });
    expect(store.patchMeta(row.id, { kind: "decision" }, "owner").revision).toBe(3);
    const superseded = store.setStatus(row.id, "superseded", {
      actor: "owner",
      event: "superseded",
      supersededBy: "other",
      data: { conflictId: "c1" },
    });
    expect(superseded).toMatchObject({ status: "superseded", supersededBy: "other", revision: 4 });
    const back = store.setStatus(row.id, "active", { actor: "owner", event: "reinstated" });
    expect(back).toMatchObject({ status: "active", supersededBy: null, revision: 5, contentRevision: 1 });
    const events = store.events(row.id);
    expect(events.map((event) => event.type)).toEqual(["created", "pinned", "meta_changed", "superseded", "reinstated"]);
    expect(events[2]?.data).toEqual({ changes: { kind: { from: "promise", to: "decision" }, dueAt: { from: null, to: 5_000 } } });
    expect(events[3]?.data).toEqual({ from: "active", to: "superseded", supersededBy: "other", conflictId: "c1" });
  });

  it("throws MEMORY_NOT_FOUND for an unknown item", () => {
    expectMemoryError(() => store.setPinned("missing", true, "owner"), "MEMORY_NOT_FOUND", 404);
    expectMemoryError(() => store.appendVersion("missing", { content: "x", actor: "owner" }), "MEMORY_NOT_FOUND", 404);
  });

  it("lets only the owner redact, clearing every version but keeping the rows and events", () => {
    const row = store.insertItem({ scope: { kind: "bot", id: "b1" }, content: "sk secret-ish", title: "t" }, "owner");
    store.appendVersion(row.id, { content: "second text", actor: "owner" });
    expectMemoryError(() => store.redact(row.id, "agent:b1"), "MEMORY_FORBIDDEN", 403);
    expectMemoryError(() => store.redact(row.id, "system"), "MEMORY_FORBIDDEN", 403);
    expect(store.versions(row.id).map((v) => v.content)).toEqual(["sk secret-ish", "second text"]);

    tick();
    const redacted = store.redact(row.id, "owner");
    expect(redacted).toMatchObject({ content: "", title: "", redacted: true, revision: 3, contentRevision: 3 });
    expect(store.versions(row.id)).toHaveLength(2);
    expect(store.versions(row.id).every((v) => v.content === "" && v.title === "")).toBe(true);
    expect(store.events(row.id).map((event) => event.type)).toEqual(["created", "revised", "redacted"]);
    expect(count("mem_items")).toBe(1);
  });

  it("stores links once and lists both directions", () => {
    store.addLink("a", "b", "derived_from");
    store.addLink("a", "b", "derived_from");
    store.addLink("c", "a", "merged_from");
    expect(store.links("a").map((link) => [link.fromId, link.toId, link.relation])).toEqual([
      ["a", "b", "derived_from"],
      ["c", "a", "merged_from"],
    ]);
    expect(store.links("b")).toHaveLength(1);
  });
});

describe("MemoryStore conflicts", () => {
  function pair() {
    const scope = { kind: "project", id: "p1" } as const;
    const existing = store.insertItem({ scope, content: "预算 5000 元" }, "owner");
    tick();
    const incoming = store.insertItem({ scope, content: "预算 8000 元" }, "owner");
    return { scope, existing, incoming };
  }

  it("raises one pair at most once, in either order", () => {
    const { scope, existing, incoming } = pair();
    const conflict = store.openConflict({
      kind: "conflict",
      scope,
      incomingId: incoming.id,
      existingId: existing.id,
      reason: "数字不一样",
      detector: "heuristic",
      confidence: 0.8,
      suggestion: "keep_new",
    });
    expect(conflict).toMatchObject({
      status: "open",
      incomingId: incoming.id,
      existingId: existing.id,
      suggestion: "keep_new",
      resolution: null,
    });
    const again = { kind: "duplicate", scope, reason: "", detector: "judge", confidence: 1 } as const;
    expect(store.openConflict({ ...again, incomingId: existing.id, existingId: incoming.id })).toBeNull();
    expect(store.openConflict({ ...again, incomingId: incoming.id, existingId: incoming.id })).toBeNull();
    expect(store.events(incoming.id).at(-1)).toMatchObject({
      type: "conflict_opened",
      conflictId: conflict?.id,
      data: { with: existing.id },
    });
    expect(store.openConflictIds([incoming.id, existing.id, "other"])).toEqual(
      new Map([
        [incoming.id, [conflict?.id]],
        [existing.id, [conflict?.id]],
      ]),
    );
  });

  it("closes a conflict once and refuses to close it again", () => {
    const { scope, existing, incoming } = pair();
    const opened = store.openConflict({
      kind: "conflict",
      scope,
      incomingId: incoming.id,
      existingId: existing.id,
      reason: "",
      detector: "explicit",
      confidence: 1,
    });
    tick();
    const closed = store.closeConflict(opened!.id, { resolution: "keep_both", actor: "owner" });
    expect(closed).toMatchObject({ status: "resolved", resolution: "keep_both", resolvedBy: "owner", resolvedAt: clock });
    expectMemoryError(
      () => store.closeConflict(opened!.id, { resolution: "keep_new", actor: "owner" }),
      "MEMORY_CONFLICT_RESOLVED",
      409,
    );
    expectMemoryError(() => store.closeConflict("missing", { resolution: "keep_new", actor: "owner" }), "MEMORY_NOT_FOUND", 404);
    expect(store.openConflictIds([incoming.id]).size).toBe(0);
    expect(store.events(existing.id).at(-1)).toMatchObject({ type: "conflict_resolved", data: { resolution: "keep_both" } });
    expect(store.listConflicts({ status: "open" })).toHaveLength(0);
    expect(store.listConflicts({ status: "resolved", scopeKeys: ["project:p1"] })).toHaveLength(1);
    expect(store.listConflicts({ itemId: existing.id })).toHaveLength(1);
    expect(store.listConflicts({ scopeKeys: ["project:p2"] })).toHaveLength(0);
  });

  it("counts items and open conflicts per scope", () => {
    const { scope, existing, incoming } = pair();
    store.insertItem({ scope, content: "pending one", status: "pending" }, "system");
    const gone = store.insertItem({ scope, content: "gone", principalId: "member-1" }, "owner");
    store.setStatus(gone.id, "rejected", { actor: "owner", event: "rejected" });
    store.openConflict({
      kind: "conflict",
      scope,
      incomingId: incoming.id,
      existingId: existing.id,
      reason: "",
      detector: "heuristic",
      confidence: 0.7,
    });
    expect(store.scopeCounts().get("project:p1")).toEqual({ active: 2, pending: 1, conflicts: 1, archived: 1, chunks: 0 });
    expect(store.scopeCounts("member-1").get("project:p1")).toEqual({
      active: 0,
      pending: 0,
      conflicts: 0,
      archived: 1,
      chunks: 0,
    });
  });
});

describe("MemoryStore raw windows", () => {
  const base = {
    source: "pa" as const,
    conversationId: "conv-1",
    dataClass: "standard" as const,
    principalId: "owner",
  };

  it("writes windows, replaces them from fromSeq and keeps the cursor", () => {
    const first = store.writeWindows({
      ...base,
      fromSeq: 0,
      windows: [window(0, "w0"), window(1, "w1"), window(2, "w2 open", true)],
      cursor: { messageCount: 4, prefixHash: "h1" },
    });
    expect(first.written.map((row) => row.id)).toEqual(["pa:conv-1:0", "pa:conv-1:1", "pa:conv-1:2"]);
    expect(first.replacedIds).toEqual([]);
    expect(first.written[2]).toMatchObject({ open: true, speakers: ["用户", "小月"], messageIds: ["m2a", "m2b"] });
    expect(store.cursor("pa", "conv-1")).toEqual({ messageCount: 4, prefixHash: "h1" });
    expect(store.cursor("studio", "conv-1")).toBeNull();

    tick();
    const second = store.writeWindows({
      ...base,
      fromSeq: 2,
      windows: [window(2, "w2 closed"), window(3, "w3 open", true)],
      cursor: { messageCount: 6, prefixHash: "h2" },
    });
    expect(second.replacedIds).toEqual([]);
    expect(store.getChunk("pa:conv-1:2")).toMatchObject({ content: "w2 closed", open: false, createdAt: 1_000 });
    expect(store.getChunk("pa:conv-1:2")?.contentHash).toBe(contentHash("w2 closed"));

    const rebuilt = store.writeWindows({
      ...base,
      fromSeq: 1,
      windows: [window(1, "w1 edited", true)],
      cursor: { messageCount: 2, prefixHash: "h3" },
    });
    expect(rebuilt.replacedIds.sort()).toEqual(["pa:conv-1:2", "pa:conv-1:3"]);
    expect(store.listChunks({ conversationId: "conv-1" }).rows.map((row) => row.id)).toEqual([
      "pa:conv-1:1",
      "pa:conv-1:0",
    ]);
    expect(store.cursor("pa", "conv-1")).toEqual({ messageCount: 2, prefixHash: "h3" });
  });

  it("lists, pages and finds neighbouring windows", () => {
    store.writeWindows({
      ...base,
      fromSeq: 0,
      windows: [0, 1, 2, 3, 4].map((seq) => window(seq, `w${seq}`, seq === 4)),
      cursor: { messageCount: 10, prefixHash: "h" },
    });
    const page = store.listChunks({ conversationId: "conv-1", limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.rows.map((row) => row.seq)).toEqual([3, 2]);
    expect(store.listChunks({ ids: ["pa:conv-1:0", "pa:conv-1:4", "nope"] }).rows.map((row) => row.seq)).toEqual([4, 0]);
    const middle = store.getChunk("pa:conv-1:2")!;
    expect(store.neighbors(middle, 1).map((row) => row.seq)).toEqual([1, 3]);
    expect(store.neighbors(middle, 0)).toEqual([]);
    expect(store.getChunks(["pa:conv-1:3", "pa:conv-1:1"]).map((row) => row.seq)).toEqual([3, 1]);
  });
});

describe("MemoryStore meta and telemetry", () => {
  it("stores meta values and survives a second schema setup on the same database", () => {
    expect(store.getMeta("schema_version")).toBe("1");
    store.setMeta("engine_config", "{}");
    store.setMeta("engine_config", '{"a":1}');
    const again = new MemoryStore(db, () => clock);
    expect(again.getMeta("engine_config")).toBe('{"a":1}');
    expect(again.getMeta("missing")).toBeNull();
  });

  it("keeps the newest 500 recall rows and reports latency percentiles", () => {
    expect(store.recallLatency()).toBeNull();
    for (let i = 1; i <= 520; i += 1) {
      store.logRecall({ surface: "pa", scopeKeys: ["bot:b1"], hitCount: 1, injectedChars: 10, level: "lexical", latencyMs: i });
    }
    expect(count("mem_recall_log")).toBe(500);
    const min = (db.prepare("SELECT MIN(latency_ms) AS n FROM mem_recall_log").get() as { n: number }).n;
    expect(min).toBe(21);
    expect(store.recallLatency()).toEqual({ p50: 270, p95: 495, samples: 500 });
  });
});

describe("append-only invariants (source scan)", () => {
  const TRUTH = "mem_items|mem_versions|mem_events|mem_links|mem_conflicts";
  // Every module of the engine folder, so a module added later is held to the same rules.
  const sources = readdirSync(memoryDir).filter((file) => file.endsWith(".ts")).map((file) => ({
    file,
    text: readFileSync(path.join(memoryDir, file), "utf8"),
  }));

  it("never deletes from the truth tables (I1)", () => {
    const deleteFromTruth = new RegExp(String.raw`DELETE\s+FROM\s+(?:${TRUTH})\b`, "iu");
    const dynamicDelete = /DELETE\s+FROM\s+["'`]?\s*\$\{/iu;
    const truncate = new RegExp(String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:${TRUTH})\b`, "iu");
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(deleteFromTruth);
      expect(text, file).not.toMatch(dynamicDelete);
      expect(text, file).not.toMatch(truncate);
    }
  });

  it("rewrites stored versions in exactly one statement, the owner-only redact (I2)", () => {
    const updates = sources.flatMap(({ text }) => text.match(/UPDATE\s+mem_versions\b[^"`]*/giu) ?? []);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/SET title = '', content = '', content_hash = ''/u);
  });
});
