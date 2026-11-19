// SPDX-License-Identifier: Apache-2.0
// End-to-end over the real engine modules: one owner, a persona, two bots, a group of both, a project with two
// conversations, raw windows from every kind of conversation, recall as every kind of turn, conflicts and their four
// resolutions, distillation, reindex, the local_only rule and the speed targets.
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryScopeKey, type MemoryScopeRef } from "@open-design/contracts";

import {
  MemoryError,
  createMemoryEngine,
  ingestPaConversation,
  resolveReadScopeKeys,
  syncStudioConversation,
  syncStudioProject,
  type EmbeddingProvider,
  type IngestMessage,
  type MemoryAccessContext,
  type MemoryEngineApi,
  type MemoryJudge,
  type MemoryLlm,
  type PaConversationReader,
  type RecallRequest,
  type RecallResult,
  type RememberInput,
  type RerankProvider,
} from "../../src/services/memory/index.js";
import { tokenize } from "../../src/services/memory/text.js";

// ---- fixtures ----------------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Messages are from 2026-11-10 14:00 local time; the engine's clock starts on 2026-11-16. */
const T0 = new Date(2026, 10, 10, 14, 0).getTime();

const PROFILE: MemoryScopeRef = { kind: "profile", id: "" };
const PERSONA: MemoryScopeRef = { kind: "persona", id: "persona-rain" };
const BOT_A: MemoryScopeRef = { kind: "bot", id: "bot-a" };
const BOT_B: MemoryScopeRef = { kind: "bot", id: "bot-b" };
const GROUP: MemoryScopeRef = { kind: "group", id: "group-1" };
const PROJECT: MemoryScopeRef = { kind: "project", id: "proj-1" };
const CONV_1: MemoryScopeRef = { kind: "conversation", id: "conv-1" };

const LABELS: Record<string, string> = {
  "profile:": "个人画像",
  "persona:persona-rain": "小雨",
  "bot:bot-a": "小月",
  "bot:bot-b": "阿星",
  "group:group-1": "协作工作室",
  "project:proj-1": "官网改版",
  "conversation:conv-1": "配色讨论",
  "conversation:conv-2": "首页布局",
  "conversation:pa-a-1": "和小月聊天",
  "conversation:pa-g-1": "协作工作室",
  "conversation:pa-ch-1": "客户频道",
};

/** The kinds of turn in policy.ts, as the daemon would describe them. */
const TURNS = {
  studioConv1: { surface: "studio", projectId: "proj-1", conversationId: "conv-1" },
  studioConv2: { surface: "studio", projectId: "proj-1", conversationId: "conv-2" },
  botAWithProfile: { surface: "pa", agentId: "bot-a", conversationId: "pa-a-1", profileMount: "owner_profile" },
  botAWithPersona: {
    surface: "pa",
    agentId: "bot-a",
    conversationId: "pa-a-1",
    profileMount: "persona_only",
    personaId: "persona-rain",
  },
  botAAlone: { surface: "pa", agentId: "bot-a", conversationId: "pa-a-1", profileMount: "none" },
  botBWithProfile: { surface: "pa", agentId: "bot-b", conversationId: "pa-b-1", profileMount: "owner_profile" },
  groupTurnOfA: { surface: "pa", agentId: "bot-a", groupId: "group-1", conversationId: "pa-g-1" },
  channelShared: {
    surface: "pa",
    agentId: "bot-a",
    groupId: "group-1",
    conversationId: "pa-ch-1",
    channel: { sharedGroupMemory: true },
  },
  channelPrivate: {
    surface: "pa",
    agentId: "bot-a",
    groupId: "group-1",
    conversationId: "pa-ch-1",
    channel: { sharedGroupMemory: false },
  },
} satisfies Record<string, MemoryAccessContext>;

/**
 * One document each: a query that finds it and words that only it contains. Items are written by the story,
 * windows come from the ingested conversations.
 */
const PROBES = [
  { name: "profile", query: "花生过敏", marker: "对花生过敏" },
  { name: "persona", query: "雨天画水彩", marker: "画水彩" },
  { name: "botA", query: "整理日程", marker: "整理主人的日程" },
  { name: "botA-via-group", query: "数据迁移方案", marker: "交付数据迁移方案" },
  { name: "botB", query: "部署流水线告警", marker: "部署流水线的告警" },
  { name: "group", query: "例会 周三", marker: "例会固定在周三下午" },
  { name: "project", query: "首页主色", marker: "#0FB5AE" },
  { name: "conv1-item", query: "按钮圆角", marker: "按钮圆角暂定 8px" },
  { name: "window-1to1-A", query: "京都 温泉旅馆", marker: "京都" },
  { name: "window-group-A", query: "Postgres 迁移", marker: "Postgres 16" },
  { name: "window-group-B-only", query: "CDN Cloudflare", marker: "Cloudflare R2" },
  { name: "window-channel", query: "发票抬头", marker: "发票抬头" },
  { name: "window-studio-1", query: "banner 动画时长", marker: "banner 动画时长定为 300ms" },
  { name: "window-studio-2", query: "导航栏吸顶", marker: "导航栏改成吸顶" },
] as const;
type ProbeName = (typeof PROBES)[number]["name"];

const STUDIO_DDL = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, agent_name TEXT,
    position INTEGER NOT NULL, created_at INTEGER NOT NULL, branch_visible INTEGER NOT NULL DEFAULT 1
  );
`;

const TRUTH_AND_HEAD = ["mem_items", "mem_versions", "mem_events", "mem_links", "mem_conflicts"] as const;

// ---- fakes -------------------------------------------------------------------------------------------------------

const EMBED_DIM = 96;

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Bag of tokens hashed into a small vector: texts sharing words point the same way. */
function embedText(text: string): Float32Array {
  const vector = new Float32Array(EMBED_DIM);
  for (const token of tokenize(text)) {
    const slot = fnv1a(token) % EMBED_DIM;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  return vector;
}

/** A remote embedding service that records every text it is sent. */
function recordingEmbedding(): { provider: EmbeddingProvider; sent: string[] } {
  const sent: string[] = [];
  const provider: EmbeddingProvider = {
    modelId: "fake:hashed:96",
    remote: true,
    async embed(texts) {
      sent.push(...texts);
      return texts.map(embedText);
    },
  };
  return { provider, sent };
}

type LlmCall = Parameters<MemoryLlm["complete"]>[0];

function scriptedLlm(answer: (call: LlmCall) => string | null): { llm: MemoryLlm; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    llm: {
      async complete(call) {
        calls.push(call);
        return answer(call);
      },
    },
    calls,
  };
}

function distilled(memories: Array<Record<string, unknown>>): string {
  return JSON.stringify({ memories });
}

// ---- helpers -----------------------------------------------------------------------------------------------------

/** A ~200-character line, so a group window holds two messages and repeats none of them as overlap. */
function long(text: string): string {
  return text + "。".repeat(Math.max(0, 190 - text.length));
}

function message(
  id: string,
  speaker: string,
  agentId: string | null,
  text: string,
  minute: number,
  dataClass: IngestMessage["dataClass"] = "standard",
): IngestMessage {
  return { id, speaker, agentId, text, at: T0 + minute * MINUTE, dataClass };
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function ledgerCounts(db: Database.Database): Record<(typeof TRUTH_AND_HEAD)[number], number> {
  return Object.fromEntries(TRUTH_AND_HEAD.map((table) => [table, countRows(db, table)])) as Record<
    (typeof TRUTH_AND_HEAD)[number],
    number
  >;
}

function itemIds(db: Database.Database): string[] {
  return (db.prepare("SELECT id FROM mem_items ORDER BY id").pluck().all() as string[]).sort();
}

function vectorRowsOfItem(db: Database.Database, itemId: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM mem_vectors v JOIN mem_docs d ON d.doc_id = v.doc_id " +
          "WHERE d.doc_kind = 'item' AND d.ref_id = ?",
      )
      .get(itemId) as { n: number }
  ).n;
}

function expectMemoryError(fn: () => unknown, code: MemoryError["code"], status: number): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(MemoryError);
  expect((caught as MemoryError).code).toBe(code);
  expect((caught as MemoryError).status).toBe(status);
}

/** The scope keys a hit is readable through: the item's scope, or every scope its window is keyed to. */
function hitScopeKeys(hit: RecallResult["hits"][number]): string[] {
  return hit.docKind === "item" ? [memoryScopeKey(hit.scope)] : (hit.chunk?.scopes ?? []).map(memoryScopeKey);
}

// ---- the story ---------------------------------------------------------------------------------------------------

describe("Fantay Memory 1.0 end to end", () => {
  let clock = T0 + 6 * DAY;
  let db: Database.Database;
  let engine: MemoryEngineApi;
  const embedding = recordingEmbedding();
  const paConversations = new Map<
    string,
    { agentId: string | null; groupId: string | null; channel: boolean; messages: IngestMessage[] }
  >();
  const reader: PaConversationReader = {
    conversation(id) {
      const found = paConversations.get(id);
      if (!found) return null;
      const { agentId, groupId, channel } = found;
      return { id, title: LABELS[`conversation:${id}`] ?? id, agentId, groupId, channel, principalId: "owner" };
    },
    messages: (id) => paConversations.get(id)?.messages ?? [],
  };
  const written: Record<string, string> = {};

  function remember(name: string, input: Omit<RememberInput, "actor"> & { actor?: string }): string {
    clock += MINUTE;
    const result = engine.remember({ actor: "owner", ...input });
    expect(result.created, name).toBe(true);
    written[name] = result.item.id;
    return result.item.id;
  }

  function recall(access: MemoryAccessContext, query: string, extra: Partial<RecallRequest> = {}) {
    return engine.recall({ query, access, limit: 40, budgetChars: 40_000, ...extra });
  }

  /** Which probe documents a turn can find, checking on the way that every hit is readable by that turn (I5). */
  async function visibleProbes(access: MemoryAccessContext): Promise<ProbeName[]> {
    const readable = new Set(resolveReadScopeKeys(access));
    const found = new Set<ProbeName>();
    for (const probe of PROBES) {
      const result = await recall(access, probe.query);
      for (const hit of result.hits) {
        expect(hitScopeKeys(hit).some((key) => readable.has(key)), `${probe.name} → ${hit.id}`).toBe(true);
      }
      if (result.hits.some((hit) => hit.content.includes(probe.marker))) found.add(probe.name);
    }
    return [...found].sort();
  }

  function addStudioConversation(id: string, title: string, lines: Array<[role: string, text: string]>): void {
    db.prepare("INSERT INTO conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      "proj-1",
      title,
      T0,
      T0,
    );
    lines.forEach(([role, text], position) => {
      db.prepare(
        "INSERT INTO messages(id, conversation_id, role, content, agent_name, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(`${id}-m${position}`, id, role, text, role === "assistant" ? "设计师" : null, position, T0 + position * MINUTE);
    });
  }

  beforeAll(async () => {
    db = new Database(":memory:");
    db.exec(STUDIO_DDL);
    engine = createMemoryEngine({
      db,
      dataDir: "",
      now: () => clock,
      labelOf: (scope) => LABELS[memoryScopeKey(scope)],
      providers: { embedding: embedding.provider },
    });

    // Items in every scope.
    remember("profile-pinned", { scope: PROFILE, kind: "preference", content: "回复用中文，结论先行", pinned: true });
    remember("profile", { scope: PROFILE, kind: "profile", content: "主人对花生过敏，点外卖要避开花生" });
    remember("persona", { scope: PERSONA, kind: "profile", content: "人设小雨喜欢在雨天画水彩" });
    remember("botA", { scope: BOT_A, kind: "procedure", content: "小月每周一早上整理主人的日程" });
    remember("botA-via-group", {
      scope: BOT_A,
      kind: "promise",
      content: "小月在群里承诺周五前交付数据迁移方案",
      via: { groupId: "group-1", groupName: "协作工作室", conversationId: "pa-g-1" },
      actor: "system",
      origin: "tool_verified",
    });
    remember("botB", { scope: BOT_B, kind: "procedure", content: "阿星负责检查部署流水线的告警" });
    remember("group", { scope: GROUP, kind: "decision", content: "协作工作室的例会固定在周三下午" });
    remember("project", { scope: PROJECT, kind: "decision", content: "官网首页主色用蓝色 #2D6CDF" });
    remember("conv1-item", { scope: CONV_1, kind: "decision", content: "配色讨论里按钮圆角暂定 8px" });

    // A PA 1:1 with bot A.
    paConversations.set("pa-a-1", {
      agentId: "bot-a",
      groupId: null,
      channel: false,
      messages: [
        message("a1", "用户", null, "我下个月要去京都旅行，帮我记着订温泉旅馆", 0),
        message("a2", "小月", "bot-a", "好的，我会提醒你提前两周订京都的温泉旅馆", 1),
      ],
    });
    // A group room where both bots speak, in different windows.
    paConversations.set("pa-g-1", {
      agentId: null,
      groupId: "group-1",
      channel: false,
      messages: [
        message("g1", "用户", null, long("今天讨论数据库和静态资源怎么安排"), 10),
        message("g2", "小月", "bot-a", long("我建议把数据库迁移到 Postgres 16，先在预发环境跑两周再切换"), 11),
        message("g3", "用户", null, long("静态资源那边谁来负责"), 12),
        message("g4", "阿星", "bot-b", long("我会把静态资源的 CDN 切到 Cloudflare R2，下周给出报价"), 13),
      ],
    });
    // An external channel bound to the group, where bot A answers a customer.
    paConversations.set("pa-ch-1", {
      agentId: "bot-a",
      groupId: "group-1",
      channel: true,
      messages: [
        message("c1", "客户小王", null, "发票抬头怎么开，写公司全称吗", 20),
        message("c2", "小月", "bot-a", "发票抬头写公司全称和税号", 21),
      ],
    });
    for (const id of paConversations.keys()) ingestPaConversation(engine.chunkSink, reader, id);

    // Two conversations of one project.
    addStudioConversation("conv-1", "配色讨论", [
      ["user", "首页 banner 动画时长定为 300ms，缓动用 ease-out"],
      ["assistant", "收到，banner 按 300ms 做"],
    ]);
    addStudioConversation("conv-2", "首页布局", [
      ["user", "导航栏改成吸顶，滚动时缩成 56px 高"],
      ["assistant", "好的，吸顶后高度 56px"],
    ]);
    syncStudioConversation(engine.chunkSink, db, "conv-1");
    syncStudioProject(engine.chunkSink, db, "proj-1");

    await engine.flush();
  });

  afterAll(() => engine.dispose());

  it("lays out the group room so each bot's window is keyed to that bot only", () => {
    const windows = engine.listChunks({ conversationId: "pa-g-1" }).chunks.sort((a, b) => a.seq - b.seq);
    expect(windows.map((w) => w.speakers)).toEqual([
      ["用户", "小月"],
      ["用户", "阿星"],
    ]);
    expect(windows.map((w) => w.scopes.map(memoryScopeKey).sort())).toEqual([
      ["bot:bot-a", "conversation:pa-g-1", "group:group-1"],
      ["bot:bot-b", "conversation:pa-g-1", "group:group-1"],
    ]);
    const channel = engine.listChunks({ conversationId: "pa-ch-1" }).chunks;
    expect(channel.flatMap((w) => w.scopes.map(memoryScopeKey))).toEqual(["conversation:pa-ch-1"]);
    // A scope's window listing goes through the same keys.
    expect(engine.listChunks({ scope: BOT_A }).chunks.map((w) => w.conversationId).sort()).toEqual([
      "pa-a-1",
      "pa-g-1",
    ]);
    expect(engine.scopeCounts().get("project:proj-1")?.chunks).toBe(2);
  });

  it("keeps the old text in the history when a memory is edited", async () => {
    const id = written.project!;
    clock += MINUTE;
    const revised = engine.revise(id, { content: "官网首页主色用青绿 #0FB5AE", note: "改成品牌色", actor: "owner" });
    expect(revised.item.versionCount).toBe(2);
    const history = engine.history(id);
    expect(history.versions.map((v) => v.content)).toEqual(["官网首页主色用蓝色 #2D6CDF", "官网首页主色用青绿 #0FB5AE"]);
    expect(history.events.map((e) => e.type)).toEqual(["created", "revised"]);
    await engine.flush();
    const result = await recall(TURNS.studioConv2, "首页主色");
    expect(result.promptBlock).toContain("#0FB5AE");
    expect(result.promptBlock).not.toContain("#2D6CDF");
  });

  it("archives and restores, and only the owner may", async () => {
    const id = written.botB!;
    expectMemoryError(() => engine.archive(id, "agent:bot-b"), "MEMORY_FORBIDDEN", 403);
    expectMemoryError(() => engine.archive(id, "system"), "MEMORY_FORBIDDEN", 403);
    const before = ledgerCounts(db);
    expect(engine.archive(id, "owner").status).toBe("archived");
    expect((await recall(TURNS.botBWithProfile, "部署流水线告警")).hits).toEqual([]);
    expectMemoryError(() => engine.restore(id, "agent:bot-b"), "MEMORY_FORBIDDEN", 403);
    expect(engine.restore(id, "owner").status).toBe("active");
    const hits = (await recall(TURNS.botBWithProfile, "部署流水线告警")).hits;
    expect(hits.map((hit) => hit.id)).toContain(id);
    expect(engine.history(id).events.map((e) => e.type)).toEqual(["created", "archived", "restored"]);
    const after = ledgerCounts(db);
    expect(after.mem_items).toBe(before.mem_items);
    expect(after.mem_versions).toBe(before.mem_versions);
    expect(after.mem_events).toBe(before.mem_events + 2);
  });

  it("recalls for every kind of turn exactly what the policy lets it read", async () => {
    const expected: Record<keyof typeof TURNS, ProbeName[]> = {
      studioConv1: ["conv1-item", "profile", "project", "window-studio-1", "window-studio-2"],
      // Conversation 2 recalls a window of conversation 1, never conversation 1's own items.
      studioConv2: ["profile", "project", "window-studio-1", "window-studio-2"],
      // What bot A said in the group is readable in its 1:1 afterwards; what only bot B said is not.
      botAWithProfile: ["botA", "botA-via-group", "profile", "window-1to1-A", "window-group-A"],
      botAWithPersona: ["botA", "botA-via-group", "persona", "window-1to1-A", "window-group-A"],
      botAAlone: ["botA", "botA-via-group", "window-1to1-A", "window-group-A"],
      botBWithProfile: ["botB", "profile", "window-group-B-only"],
      // A group turn reads the group and the speaking bot's items, never the profile or the other bot.
      // The bot's raw windows from elsewhere stay out: its private 1:1 with the owner is not quoted into the group.
      groupTurnOfA: ["botA", "botA-via-group", "group", "window-group-A", "window-group-B-only"],
      channelShared: ["group", "window-group-A", "window-group-B-only"],
      channelPrivate: [],
    };
    for (const [turn, probes] of Object.entries(expected) as Array<[keyof typeof TURNS, ProbeName[]]>) {
      expect(await visibleProbes(TURNS[turn]), turn).toEqual([...probes].sort());
    }
  });

  it("shows pinned profile memories only to turns that read the profile", async () => {
    const pinned = written["profile-pinned"]!;
    for (const turn of ["studioConv1", "studioConv2", "botAWithProfile", "botBWithProfile"] as const) {
      const result = await recall(TURNS[turn], "京都");
      expect(result.standing.map((item) => item.id), turn).toEqual([pinned]);
      expect(result.promptBlock).toContain("## Always\n- [profile · preference] 回复用中文，结论先行");
    }
    for (const turn of ["botAWithPersona", "botAAlone", "groupTurnOfA", "channelShared"] as const) {
      const result = await recall(TURNS[turn], "京都");
      expect(result.standing, turn).toEqual([]);
      expect(result.promptBlock).not.toContain("回复用中文");
    }
  });

  it("never pads: an unrelated question yields no hits and only the standing block", async () => {
    const withProfile = await recall(TURNS.studioConv2, "量子物理里的薛定谔方程");
    expect(withProfile.hits).toEqual([]);
    expect(withProfile.promptBlock).toContain("## Always");
    expect(withProfile.promptBlock).not.toContain("## Relevant");
    expect(withProfile.promptBlock).not.toContain("## From earlier conversations");
    const alone = await recall(TURNS.botAAlone, "量子物理里的薛定谔方程");
    expect(alone.hits).toEqual([]);
    expect(alone.promptBlock).toBe("");
    const channel = await recall(TURNS.channelPrivate, "例会时间");
    expect(channel).toMatchObject({ scopes: [], hits: [], standing: [], promptBlock: "" });
  });

  it("formats items learned in a group and windows of earlier conversations", async () => {
    const viaGroup = await recall(TURNS.botAAlone, "数据迁移方案");
    expect(viaGroup.promptBlock).toMatch(
      /- \[bot · promise · 2026-11-16 · learned in group 协作工作室\] 小月在群里承诺周五前交付数据迁移方案/u,
    );
    const earlier = await recall(TURNS.studioConv2, "banner 动画时长");
    expect(earlier.promptBlock).toContain("## From earlier conversations\n### 《配色讨论》 2026-11-10\n[14:00] 用户: 首页 banner");
    const hit = earlier.hits.find((h) => h.docKind === "chunk");
    expect(hit?.scope).toEqual({ kind: "project", id: "proj-1" });
    expect(earlier.level).toBe("hybrid");
  });

  it("hides an item outside its validity window from recall and from the standing layer", async () => {
    const kept = remember("kept-promise", {
      scope: BOT_A,
      kind: "promise",
      content: "小月答应帮主人预约牙医复诊",
      validUntil: clock - 1,
    });
    const later = remember("not-yet", {
      scope: BOT_A,
      kind: "rule",
      content: "从下个月起小月每天提醒主人喝水",
      pinned: true,
      validFrom: clock + DAY,
    });
    await engine.flush();
    expect((await recall(TURNS.botAAlone, "牙医复诊")).hits).toEqual([]);
    expect((await recall(TURNS.botAAlone, "提醒喝水")).standing).toEqual([]);
    expect(engine.listItems({ scope: BOT_A }).items.map((item) => item.id)).toEqual(
      expect.arrayContaining([kept, later]),
    );
    clock += 2 * DAY;
    expect((await recall(TURNS.botAAlone, "提醒喝水")).standing.map((item) => item.id)).toEqual([later]);
    engine.revise(later, { pinned: false, actor: "owner" });
  });

  it("redacts text, versions and the derived vectors but keeps the rows", async () => {
    const id = remember("redacted", { scope: BOT_A, content: "小月记得主人小时候住在基隆" });
    await engine.flush();
    expect(vectorRowsOfItem(db, id)).toBe(1);
    expectMemoryError(() => engine.redact(id, "agent:bot-a"), "MEMORY_FORBIDDEN", 403);
    const before = ledgerCounts(db);
    const item = engine.redact(id, "owner");
    expect(item).toMatchObject({ redacted: true, content: "" });
    expect(engine.history(id).versions.map((v) => v.content)).toEqual([""]);
    expect(vectorRowsOfItem(db, id)).toBe(0);
    expect((await recall(TURNS.botAAlone, "基隆")).hits).toEqual([]);
    const after = ledgerCounts(db);
    expect(after.mem_items).toBe(before.mem_items);
    expect(after.mem_versions).toBe(before.mem_versions);
    expect(after.mem_events).toBe(before.mem_events + 1);
  });

  describe("conflicts", () => {
    /** Asserts a step removed nothing: every ledger table only grew and every item row is still there. */
    function expectNothingDeleted(step: () => void): void {
      const counts = ledgerCounts(db);
      const ids = itemIds(db);
      step();
      const after = ledgerCounts(db);
      for (const table of TRUTH_AND_HEAD) expect(after[table], table).toBeGreaterThanOrEqual(counts[table]);
      expect(after.mem_events).toBeGreaterThan(counts.mem_events);
      expect(itemIds(db)).toEqual(expect.arrayContaining(ids));
    }

    function openPair(scope: MemoryScopeRef, existingText: string, incomingText: string, actor = "owner") {
      clock += MINUTE;
      const existing = engine.remember({ scope, content: existingText, actor: "owner" }).item;
      clock += MINUTE;
      const incoming = engine.remember({ scope, content: incomingText, actor });
      const conflict = incoming.conflicts.find((c) => c.existing.id === existing.id);
      expect(conflict, incomingText).toBeDefined();
      expect(conflict!.incoming.id).toBe(incoming.item.id);
      return { existing, incoming: incoming.item, conflict: conflict! };
    }

    it("keep_new: the new one stays, the old one is superseded, recall stops showing the disagreement", async () => {
      const { existing, incoming, conflict } = openPair(PROJECT, "官网改版的预算是 5000 元", "官网改版的预算是 8000 元");
      expect(conflict).toMatchObject({ kind: "conflict", detector: "heuristic", status: "open", suggestion: "keep_new" });
      expect(engine.getItem(existing.id)?.openConflictIds).toEqual([conflict.id]);

      const open = await recall(TURNS.studioConv2, "官网改版的预算");
      const line = open.promptBlock.split("\n").find((l) => l.startsWith("- CONFLICT"));
      expect(line).toBe(
        "- CONFLICT (unresolved, do not pick a side; say they disagree): " +
          "(2026-11-18) 官网改版的预算是 5000 元  |  (2026-11-18) 官网改版的预算是 8000 元",
      );
      const inConflict = open.hits.filter((hit) => hit.inConflict).map((hit) => hit.id);
      expect(inConflict).toEqual(expect.arrayContaining([existing.id, incoming.id]));

      expectMemoryError(
        () => engine.resolveConflict(conflict.id, { resolution: "keep_new", actor: "agent:bot-a" }),
        "MEMORY_FORBIDDEN",
        403,
      );
      expectNothingDeleted(() => {
        const done = engine.resolveConflict(conflict.id, { resolution: "keep_new", actor: "owner" });
        expect(done.conflict).toMatchObject({ status: "resolved", resolution: "keep_new" });
      });
      expect(engine.getItem(incoming.id)?.status).toBe("active");
      expect(engine.getItem(existing.id)).toMatchObject({ status: "superseded", supersededBy: incoming.id });
      expect(engine.history(incoming.id).links).toContainEqual(
        expect.objectContaining({ fromId: incoming.id, toId: existing.id, relation: "supersedes" }),
      );
      expectMemoryError(
        () => engine.resolveConflict(conflict.id, { resolution: "keep_old", actor: "owner" }),
        "MEMORY_CONFLICT_RESOLVED",
        409,
      );
      const closed = await recall(TURNS.studioConv2, "官网改版的预算");
      expect(closed.promptBlock).toContain("8000 元");
      expect(closed.promptBlock).not.toContain("5000 元");
      expect(closed.promptBlock).not.toContain("CONFLICT");
    });

    it("keep_old: the existing one stays and the newer guess is rejected", async () => {
      const { existing, incoming, conflict } = openPair(
        BOT_A,
        "小月的周报在周一上午 9 点发出",
        "小月的周报在周一上午 10 点发出",
        "agent:bot-a",
      );
      expect(incoming.origin).toBe("llm_inferred");
      expect(conflict.suggestion).toBe("keep_old");
      expectNothingDeleted(() => engine.resolveConflict(conflict.id, { resolution: "keep_old", actor: "owner" }));
      expect(engine.getItem(existing.id)?.status).toBe("active");
      expect(engine.getItem(incoming.id)?.status).toBe("rejected");
      const result = await recall(TURNS.botAAlone, "周报几点发出");
      expect(result.promptBlock).toContain("9 点发出");
      expect(result.promptBlock).not.toContain("10 点发出");
    });

    it("merge: a new memory holds the merged text and both sources are superseded by it", async () => {
      const { existing, incoming, conflict } = openPair(GROUP, "群里的周报模板用表格", "群里的周报模板不用表格");
      const draft = await engine.mergeDraft(conflict.id);
      expect(draft).toEqual({ content: "群里的周报模板用表格\n群里的周报模板不用表格", source: "joined" });
      expectMemoryError(
        () => engine.resolveConflict(conflict.id, { resolution: "merge", actor: "owner" }),
        "MEMORY_INVALID",
        400,
      );
      const merged = "群里的周报模板正文用列表，数据部分用表格";
      let mergedId = "";
      expectNothingDeleted(() => {
        const done = engine.resolveConflict(conflict.id, { resolution: "merge", mergedContent: merged, actor: "owner" });
        mergedId = done.conflict.mergedItemId ?? "";
        expect(done.items.map((item) => item.id).sort()).toEqual([existing.id, incoming.id, mergedId].sort());
      });
      expect(engine.getItem(mergedId)).toMatchObject({
        status: "active",
        origin: "user_explicit",
        scope: GROUP,
        content: merged,
      });
      for (const source of [existing.id, incoming.id]) {
        expect(engine.getItem(source)).toMatchObject({ status: "superseded", supersededBy: mergedId });
      }
      expect(engine.history(mergedId).links.filter((l) => l.relation === "merged_from").map((l) => l.toId).sort()).toEqual(
        [existing.id, incoming.id].sort(),
      );
      await engine.flush();
      const result = await recall(TURNS.groupTurnOfA, "周报模板");
      expect(result.promptBlock).toContain(merged);
      expect(result.promptBlock).not.toContain("群里的周报模板用表格");
      expect(result.promptBlock).not.toContain("不用表格");
    });

    it("keep_both: both stay active, they are linked, and the pair is never raised again", async () => {
      const { existing, incoming, conflict } = openPair(PROFILE, "主人喜欢深色主题", "主人讨厌深色主题");
      expectNothingDeleted(() => engine.resolveConflict(conflict.id, { resolution: "keep_both", actor: "owner" }));
      expect(engine.getItem(existing.id)).toMatchObject({ status: "active", openConflictIds: [] });
      expect(engine.getItem(incoming.id)).toMatchObject({ status: "active", openConflictIds: [] });
      expect(engine.history(existing.id).links).toContainEqual(
        expect.objectContaining({ fromId: incoming.id, toId: existing.id, relation: "relates" }),
      );
      const tidy = await engine.tidy(PROFILE);
      expect(tidy.conflictsOpened).toBe(0);
      expect(engine.listConflicts({ status: "open", scope: PROFILE })).toEqual([]);
      const result = await recall(TURNS.studioConv1, "深色主题");
      expect(result.promptBlock).toContain("主人喜欢深色主题");
      expect(result.promptBlock).toContain("主人讨厌深色主题");
      expect(result.promptBlock).not.toContain("CONFLICT");
    });
  });

  describe("distillation", () => {
    const groupTranscript = [
      "用户: 下周开始周报改成双周一次",
      "小月: 好的，我从下周起按双周整理周报",
      "阿星: 我负责周报里的部署数据",
    ].join("\n");

    it("writes proposals in review mode, into the offered scopes only, and they are not recalled until accepted", async () => {
      const { llm, calls } = scriptedLlm(() =>
        distilled([
          { scope: "bot:bot-a", kind: "promise", content: "小月从下周起按双周整理周报", quote: "我从下周起按双周整理周报" },
          { scope: "group:group-1", kind: "decision", content: "协作工作室的周报改成双周一次", quote: "下周开始周报改成双周一次" },
          // Not offered: bot B was not a target of this run.
          { scope: "bot:bot-b", kind: "fact", content: "阿星负责周报里的部署数据", quote: "我负责周报里的部署数据" },
          // Its quote is not in the transcript.
          { scope: "group:group-1", kind: "fact", content: "大家同意每天开站会", quote: "每天开站会" },
        ]),
      );
      const results = await engine.distill({
        transcript: groupTranscript,
        targets: [
          { scope: BOT_A, hint: "what 小月 itself should remember" },
          { scope: GROUP, hint: "conclusions the whole group shares" },
        ],
        source: "群聊 · 协作工作室",
        via: { groupId: "group-1", groupName: "协作工作室", conversationId: "pa-g-1" },
        mode: "review",
        llm,
      });
      expect(calls).toHaveLength(1);
      expect(results.map((r) => [memoryScopeKey(r.item.scope), r.item.status, r.item.origin])).toEqual([
        ["bot:bot-a", "pending", "llm_inferred"],
        ["group:group-1", "pending", "llm_inferred"],
      ]);
      expect(results.every((r) => r.item.via?.groupId === "group-1" && r.item.source === "群聊 · 协作工作室")).toBe(true);
      const proposal = results[0]!.item;
      expect((await recall(TURNS.botAAlone, "双周整理周报")).hits.map((h) => h.id)).not.toContain(proposal.id);

      expectMemoryError(() => engine.accept(proposal.id, "agent:bot-a"), "MEMORY_FORBIDDEN", 403);
      expect(engine.accept(proposal.id, "owner").item.status).toBe("active");
      await engine.flush();
      expect((await recall(TURNS.botAAlone, "双周整理周报")).hits.map((h) => h.id)).toContain(proposal.id);
      expect(engine.reject(results[1]!.item.id, "owner").status).toBe("rejected");
    });

    it("writes active memories in auto mode and nothing at all when the mode is off", async () => {
      const transcript = "用户: 按钮的主色统一改成品牌青绿\n设计师: 好的，所有主按钮都用品牌青绿";
      const { llm, calls } = scriptedLlm(() =>
        distilled([
          { scope: "project:proj-1", kind: "decision", content: "官网所有主按钮统一使用品牌青绿", quote: "按钮的主色统一改成品牌青绿" },
          { scope: "conversation:conv-1", kind: "fact", content: "配色讨论确认了主按钮配色", quote: "所有主按钮都用品牌青绿" },
          { scope: "profile:", kind: "preference", content: "主人偏爱青绿色", quote: "品牌青绿" },
        ]),
      );
      const targets = [
        { scope: CONV_1, hint: "only matters inside this conversation thread" },
        { scope: PROJECT, hint: "true for the whole project" },
      ];
      expect(await engine.distill({ transcript, targets, source: "项目对话 · 配色讨论", mode: "off", llm })).toEqual([]);
      expect(calls).toHaveLength(0);

      const results = await engine.distill({ transcript, targets, source: "项目对话 · 配色讨论", mode: "auto", llm });
      expect(results.map((r) => [memoryScopeKey(r.item.scope), r.item.status])).toEqual([
        ["project:proj-1", "active"],
        ["conversation:conv-1", "active"],
      ]);
      await engine.flush();
      const hits = (await recall(TURNS.studioConv1, "主按钮 品牌青绿")).hits.map((h) => h.id);
      expect(hits).toEqual(expect.arrayContaining(results.map((r) => r.item.id)));
      expect(engine.listItems({ scope: PROFILE, text: "青绿" }).items).toEqual([]);
    });
  });

  it("rebuilds the projection without changing what recall finds", async () => {
    const snapshot = async () => {
      const out: string[] = [];
      for (const turn of ["studioConv2", "botAWithProfile", "groupTurnOfA", "botBWithProfile"] as const) {
        for (const probe of PROBES) {
          const result = await recall(TURNS[turn], probe.query);
          out.push(
            `${turn}/${probe.name}: ${result.level} ${result.hits.map((h) => `${h.id}=${h.score}`).join(",")}`,
            result.promptBlock,
          );
        }
      }
      return out;
    };
    const before = await snapshot();
    const documents = engine.status().documents;
    const indexed = engine.status().embedding.indexed;

    expect((await engine.reindex()).documents).toBe(documents);
    expect(await snapshot()).toEqual(before);

    const sentBefore = embedding.sent.length;
    expect((await engine.reindex({ vectors: true })).documents).toBe(documents);
    await engine.flush();
    expect(embedding.sent.length - sentBefore).toBe(indexed);
    expect(engine.status().embedding).toMatchObject({ indexed, ready: true });
    expect(await snapshot()).toEqual(before);
  });

  it("only appended to the ledger and raised no conflict the story did not set up", () => {
    const conflicts = engine.listConflicts({});
    expect(conflicts.map((c) => [c.status, c.resolution]).sort()).toEqual([
      ["resolved", "keep_both"],
      ["resolved", "keep_new"],
      ["resolved", "keep_old"],
      ["resolved", "merge"],
    ]);
    for (const id of Object.values(written)) expect(engine.getRow(id), id).not.toBeNull();
    expect(countRows(db, "mem_versions")).toBeGreaterThanOrEqual(countRows(db, "mem_items"));
  });
});

// ---- local_only never leaves the machine (I6) --------------------------------------------------------------------

describe("local_only text and remote providers", () => {
  it("never reaches a remote embedding, reranker, judge or model call without being marked local_only", async () => {
    const SECRET = /体检|血糖/u;
    const embedding = recordingEmbedding();
    const reranked: string[] = [];
    const reranker: RerankProvider = {
      id: "fake-reranker",
      remote: true,
      async rerank(query, documents) {
        reranked.push(query, ...documents);
        return documents.map((_, i) => documents.length - i);
      },
    };
    const judged: string[] = [];
    const judge: MemoryJudge = {
      id: "fake-judge",
      remote: true,
      async compare(incoming, existing) {
        judged.push(incoming.content, existing.content);
        return { relation: "unrelated", confidence: 0.95, reason: "无关" };
      },
    };
    const { llm, calls } = scriptedLlm((call) =>
      call.system.startsWith("Merge two memories")
        ? "合并后的文本"
        : distilled([{ scope: "profile:", kind: "fact", content: "主人的血糖偏高需要复查", quote: "血糖偏高" }]),
    );
    const db = new Database(":memory:");
    const engine = createMemoryEngine({ db, dataDir: "", llm, providers: { embedding: embedding.provider, reranker, judge } });
    try {
      engine.remember({ scope: PROFILE, content: "主人每周跑步三次", actor: "owner" });
      engine.remember({ scope: PROFILE, content: "主人每周跑步时听播客", actor: "owner" });
      const first = engine.remember({
        scope: PROFILE,
        content: "体检报告显示血糖偏高，复查定在 3 月",
        dataClass: "local_only",
        actor: "owner",
      });
      const second = engine.remember({
        scope: PROFILE,
        content: "体检报告显示血糖偏高，复查定在 4 月",
        dataClass: "local_only",
        actor: "owner",
      });
      // The remote judge is skipped for a local_only pair; the built-in rules decide at once.
      expect(second.conflicts.map((c) => [c.existing.id, c.detector])).toEqual([[first.item.id, "heuristic"]]);
      const reader: PaConversationReader = {
        conversation: (id) => ({ id, title: "", agentId: "bot-a", groupId: null, channel: false, principalId: "owner" }),
        messages: () => [message("m1", "用户", null, "体检报告的结论是血糖略高", 0, "local_only")],
      };
      ingestPaConversation(engine.chunkSink, reader, "pa-private");
      await engine.flush();

      // A standard turn's own question is standard text and may be embedded; the local_only documents it would
      // match stay invisible to it.
      const standard = await engine.recall({ query: "复查定在几月", access: { surface: "studio" } });
      expect(standard.hits).toEqual([]);
      const local = await engine.recall({ query: "体检报告 血糖", access: { surface: "studio", dataClass: "local_only" } });
      expect(local.hits.map((h) => h.id)).toEqual(expect.arrayContaining([first.item.id, second.item.id]));
      expect(local.level).toBe("lexical");
      const ownBot = await engine.recall({
        query: "体检报告",
        access: { surface: "pa", agentId: "bot-a", dataClass: "local_only" },
      });
      expect(ownBot.hits.map((h) => h.docKind)).toContain("chunk");
      const running = await engine.recall({ query: "跑步", access: { surface: "studio" } });
      expect(running.level).toBe("hybrid_rerank");
      expect(reranked.length).toBeGreaterThan(0);

      await engine.distill({
        transcript: "用户: 体检报告的结论是血糖偏高",
        targets: [{ scope: PROFILE, hint: "stable facts" }],
        source: "测试",
        dataClass: "local_only",
      });
      await engine.mergeDraft(second.conflicts[0]!.id);
      await engine.flush();

      for (const [name, texts] of [
        ["embedding", embedding.sent],
        ["reranker", reranked],
        ["judge", judged],
      ] as const) {
        expect(texts.filter((text) => SECRET.test(text)), name).toEqual([]);
      }
      expect(calls.length).toBe(2);
      expect(calls.every((call) => call.dataClass === "local_only")).toBe(true);
    } finally {
      engine.dispose();
    }
  });
});

// ---- speed at the brief's scale ----------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HAN =
  "的一是在不了有和人这中大为上个我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所" +
  "得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日";
const LATIN = ["deploy", "cache", "schema", "token", "release", "pipeline", "docker", "vector", "react", "sqlite",
  "bucket", "proxy", "router", "webhook", "cron", "latency", "budget", "invoice", "banner", "palette"];

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

describe("speed at the brief's scale (lexical level, 20k items + 50k windows)", () => {
  it("recalls and writes within the desktop budget", { timeout: 300_000 }, async () => {
    const random = mulberry32(20261116);
    const words = Array.from({ length: 3000 }, (_, i) =>
      i % 25 === 0 ? LATIN[i % LATIN.length]! : HAN[Math.floor(random() * HAN.length)]! + HAN[Math.floor(random() * HAN.length)]!,
    );
    // Zipf-like: a few words are everywhere, most are rare.
    const word = (): string => words[Math.floor(words.length * random() ** 3)]!;
    const sentence = (count: number): string => Array.from({ length: count }, word).join("");
    const now = T0 + 30 * DAY;
    const db = new Database(":memory:");
    const engine = createMemoryEngine({ db, dataDir: "", now: () => now });
    try {
      const loadStarted = performance.now();
      const scopes: MemoryScopeRef[] = [
        ...Array.from({ length: 30 }, () => PROFILE),
        ...Array.from({ length: 80 }, () => PROJECT),
        ...Array.from({ length: 45 }, (_, i) => ({ kind: "project" as const, id: `proj-${2 + (i % 9)}` })),
        ...Array.from({ length: 30 }, (_, i) => ({ kind: "bot" as const, id: `bot-${i % 20}` })),
        ...Array.from({ length: 15 }, (_, i) => ({ kind: "group" as const, id: `group-${i % 5}` })),
      ];
      db.transaction(() => {
        for (let i = 0; i < 20_000; i += 1) {
          engine.remember({
            scope: scopes[i % scopes.length]!,
            content: `${sentence(6 + Math.floor(random() * 10))} ${i}`,
            actor: "owner",
            skipConflictCheck: true,
          });
        }
      })();
      db.transaction(() => {
        for (let c = 0; c < 2_500; c += 1) {
          const studio = c < 1_900;
          const conversationId = `conv-${c}`;
          const windows = Array.from({ length: 20 }, (_, seq) => {
            const lines = Array.from({ length: 6 }, (_, l) => `[10:${String(l).padStart(2, "0")}] ${l % 2 ? "助手" : "用户"}: ${sentence(12)}`);
            const startAt = now - (2_500 - c) * 3_600_000 + seq * 600_000;
            return {
              seq,
              content: lines.join("\n"),
              speakers: ["用户", "助手"],
              speakerAgentIds: [],
              messageIds: lines.map((_, l) => `${conversationId}-${seq}-${l}`),
              startAt,
              endAt: startAt + 300_000,
              open: seq === 19,
            };
          });
          engine.chunkSink.writeWindows({
            source: studio ? "studio" : "pa",
            conversationId,
            fromSeq: 0,
            windows,
            dataClass: "standard",
            principalId: "owner",
            cursor: { messageCount: 0, prefixHash: "" },
            scope: studio
              ? { source: "studio", conversationId, projectId: c < 1_000 ? "proj-1" : `proj-${2 + (c % 9)}` }
              : { source: "pa", conversationId, agentId: `bot-${c % 20}` },
          });
        }
      })();
      const loadMs = performance.now() - loadStarted;
      expect(engine.status().documents).toBe(70_000);

      const turns: MemoryAccessContext[] = [
        { surface: "studio", projectId: "proj-1", conversationId: "conv-3" },
        { surface: "pa", agentId: "bot-4", conversationId: "conv-2004", profileMount: "owner_profile" },
      ];
      const queries = Array.from({ length: 60 }, () => Array.from({ length: 2 + Math.floor(random() * 4) }, word).join(" "));
      for (const query of queries.slice(0, 5)) await engine.recall({ query, access: turns[0]! });
      const recallTimes: number[] = [];
      let hits = 0;
      for (const [i, query] of queries.entries()) {
        const started = performance.now();
        const result = await engine.recall({ query, access: turns[i % turns.length]! });
        recallTimes.push(performance.now() - started);
        hits += result.hits.length;
      }

      const writeTimes: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        const content = `${sentence(8 + Math.floor(random() * 8))} 写入 ${i}`;
        const started = performance.now();
        engine.remember({ scope: PROJECT, content, actor: "owner" });
        writeTimes.push(performance.now() - started);
      }

      const recallP95 = percentile(recallTimes, 0.95);
      const writeP95 = percentile(writeTimes, 0.95);
      console.log(
        `[memory e2e speed] load ${Math.round(loadMs)} ms for 20000 items + 50000 windows; ` +
          `recall p50 ${percentile(recallTimes, 0.5).toFixed(1)} ms, p95 ${recallP95.toFixed(1)} ms, ` +
          `max ${Math.max(...recallTimes).toFixed(1)} ms, ${(hits / queries.length).toFixed(1)} hits per query ` +
          `(target p95 < 60 ms); write p50 ${percentile(writeTimes, 0.5).toFixed(1)} ms, p95 ${writeP95.toFixed(1)} ms ` +
          `(target < 15 ms)`,
      );
      // Loose bounds (the printed numbers are compared with the brief's targets): a slower CI machine passes,
      // a scan over every document of the scope does not.
      expect(recallP95).toBeLessThan(150);
      expect(writeP95).toBeLessThan(45);
    } finally {
      engine.dispose();
    }
  });
});
