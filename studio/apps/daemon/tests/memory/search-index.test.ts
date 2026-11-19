// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryScopeKey, type MemoryScopeRef } from "@open-design/contracts";
import { MemoryIndex } from "../../src/services/memory/search-index.js";
import { contentHash } from "../../src/services/memory/text.js";
import { MemoryVectors } from "../../src/services/memory/vectors.js";
import type { DocFilter, MemoryChunkRow, MemoryItemRow } from "../../src/services/memory/types.js";

const AT = Date.UTC(2026, 10, 10, 4, 0);
let nextId = 0;

function item(scope: MemoryScopeRef, content: string, over: Partial<MemoryItemRow> = {}): MemoryItemRow {
  nextId += 1;
  return {
    id: `item-${nextId}`,
    scopeKind: scope.kind,
    scopeId: scope.id,
    principalId: "owner",
    kind: "fact",
    status: "active",
    origin: "user_explicit",
    pinned: false,
    dataClass: "standard",
    title: "",
    content,
    contentHash: contentHash(content),
    source: "手动添加",
    sourceRefs: [],
    via: null,
    authorId: "owner",
    eventAt: null,
    dueAt: null,
    validFrom: null,
    validUntil: null,
    supersededBy: null,
    revision: 1,
    contentRevision: 1,
    versionCount: 1,
    redacted: false,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function chunk(conversationId: string, seq: number, content: string, over: Partial<MemoryChunkRow> = {}): MemoryChunkRow {
  return {
    id: `studio:${conversationId}:${seq}`,
    source: "studio",
    conversationId,
    seq,
    content,
    contentHash: contentHash(content),
    speakers: ["用户"],
    messageIds: [`${conversationId}-m${seq}`],
    startAt: AT,
    endAt: AT,
    dataClass: "standard",
    principalId: "owner",
    open: false,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

const project = (id: string): MemoryScopeRef => ({ kind: "project", id });
const bot = (id: string): MemoryScopeRef => ({ kind: "bot", id });
const keys = (...scopes: MemoryScopeRef[]) => scopes.map(memoryScopeKey);

describe("MemoryIndex", () => {
  let db: Database.Database;
  let index: MemoryIndex;
  const refs = (hits: Array<{ docId: number }>) => index.docs(hits.map((hit) => hit.docId)).map((doc) => doc.refId);

  beforeEach(() => {
    db = new Database(":memory:");
    index = new MemoryIndex(db);
  });

  describe("Chinese", () => {
    it("finds 北京出差开会 by a word, a city and a full question", () => {
      const doc = item(project("p"), "北京出差开会");
      index.upsertItem(doc);
      index.upsertItem(item(project("p"), "上海的天气很好"));
      const filter = { scopeKeys: keys(project("p")) };
      for (const query of ["出差", "北京", "什么时候去北京出差"]) {
        expect(refs(index.lexical(query, filter, 10)), query).toEqual([doc.id]);
      }
    });

    it("finds quoted Chinese as a phrase in the literal channel", () => {
      const exact = item(project("p"), "下周去北京出差");
      const scattered = item(project("p"), "北京很冷，出差要带外套");
      index.upsertItem(exact);
      index.upsertItem(scattered);
      expect(refs(index.literal("“北京出差”", { scopeKeys: keys(project("p")) }, 10))).toEqual([exact.id]);
    });
  });

  describe("English and identifiers", () => {
    const filter = { scopeKeys: keys(project("p")) };
    let docs: Record<string, MemoryItemRow>;

    beforeEach(() => {
      docs = {
        fn: item(project("p"), "调用 getUserById 获取用户资料"),
        version: item(project("p"), "桌面端已经升级到 v2.3.1 版本"),
        color: item(project("p"), "首页主色用青绿 #0FB5AE"),
        path: item(project("p"), "召回逻辑在 studio/apps/daemon/src/services/memory/retrieval.ts"),
        english: item(project("p"), "The owner prefers dark mode in every editor"),
        noise: item(project("p"), "随便记一条无关的内容 v2 user"),
      };
      for (const doc of Object.values(docs)) index.upsertItem(doc);
    });

    const first = (hits: Array<{ docId: number }>) => refs(hits)[0];

    it("finds identifiers by exact tokens", () => {
      expect(first(index.lexical("getUserById", filter, 10))).toBe(docs.fn!.id);
      expect(first(index.lexical("v2.3.1", filter, 10))).toBe(docs.version!.id);
      expect(first(index.lexical("#0FB5AE", filter, 10))).toBe(docs.color!.id);
      expect(first(index.lexical("retrieval.ts", filter, 10))).toBe(docs.path!.id);
      expect(first(index.lexical("dark mode", filter, 10))).toBe(docs.english!.id);
    });

    it("finds identifiers by partial tokens", () => {
      expect(refs(index.lexical("UserById", filter, 10))).toContain(docs.fn!.id);
      expect(refs(index.lexical("services/memory", filter, 10))).toContain(docs.path!.id);
      expect(refs(index.lexical("prefer", filter, 10))).toEqual([]);
      expect(refs(index.lexical("prefers", filter, 10))).toEqual([docs.english!.id]);
    });

    it("matches literals exactly or by prefix", () => {
      expect(refs(index.literal("UserById", filter, 10))).toEqual([docs.fn!.id]);
      expect(refs(index.literal("v2.3.1", filter, 10))).toEqual([docs.version!.id]);
      expect(refs(index.literal("0FB5", filter, 10))).toEqual([docs.color!.id]);
      expect(refs(index.literal("services/memory/retrieval.ts", filter, 10))).toEqual([docs.path!.id]);
      expect(index.literal("plain words only", filter, 10)).toEqual([]);
    });
  });

  describe("isolation", () => {
    it("restricts by scope inside the query, before LIMIT", () => {
      const mine = [1, 2, 3].map((n) => item(project("small"), `预算 第${n}条`));
      for (const doc of mine) index.upsertItem(doc);
      for (let n = 0; n < 500; n += 1) index.upsertItem(item(project("big"), `预算 预算 预算 预算 ${n}`));
      const hits = index.lexical("预算", { scopeKeys: keys(project("small")) }, 3);
      expect(refs(hits).sort()).toEqual(mine.map((doc) => doc.id).sort());
      const literal = index.literal("“预算”", { scopeKeys: keys(project("small")) }, 3);
      expect(refs(literal).sort()).toEqual(mine.map((doc) => doc.id).sort());
    });

    it("reads nothing with an empty scope list", () => {
      index.upsertItem(item(project("p"), "预算"));
      expect(index.lexical("预算", { scopeKeys: [] }, 10)).toEqual([]);
      expect(index.literal("“预算”", { scopeKeys: [] }, 10)).toEqual([]);
      expect(index.allowedDocIds({ scopeKeys: [] })).toEqual([]);
    });

    it("never returns another bot's documents", () => {
      const own = item(bot("a"), "小月喜欢猫");
      index.upsertItem(own);
      index.upsertItem(item(bot("b"), "小月喜欢猫"));
      expect(refs(index.lexical("喜欢猫", { scopeKeys: keys(bot("a")) }, 10))).toEqual([own.id]);
    });

    it("keeps principals apart and treats an unset principal as the owner", () => {
      const owners = item(project("p"), "预算三万");
      const members = item(project("p"), "预算五万", { principalId: "member-1" });
      index.upsertItem(owners);
      index.upsertItem(members);
      const scopeKeys = keys(project("p"));
      expect(refs(index.lexical("预算", { scopeKeys }, 10))).toEqual([owners.id]);
      expect(refs(index.lexical("预算", { scopeKeys, principalId: "member-1" }, 10))).toEqual([members.id]);
      expect(index.allowedDocIds({ scopeKeys, principalId: "member-1" })).toEqual([index.docIdOf("item", members.id)]);
    });

    it("shows local_only documents only to a local_only turn", () => {
      const secret = item(project("p"), "体检报告 血压偏高", { dataClass: "local_only" });
      index.upsertItem(secret);
      const scopeKeys = keys(project("p"));
      expect(index.lexical("血压", { scopeKeys }, 10)).toEqual([]);
      expect(index.lexical("血压", { scopeKeys, dataClass: "standard" }, 10)).toEqual([]);
      expect(index.allowedDocIds({ scopeKeys })).toEqual([]);
      expect(refs(index.lexical("血压", { scopeKeys, dataClass: "local_only" }, 10))).toEqual([secret.id]);
    });

    it("hides non-active items unless asked to include them", () => {
      const doc = item(project("p"), "旧的配色方案");
      index.upsertItem(doc);
      index.upsertItem({ ...doc, status: "archived", revision: 2 });
      const scopeKeys = keys(project("p"));
      expect(index.lexical("配色", { scopeKeys }, 10)).toEqual([]);
      expect(refs(index.lexical("配色", { scopeKeys, includeHidden: true }, 10))).toEqual([doc.id]);
      index.upsertItem({ ...doc, status: "active", revision: 3 });
      expect(refs(index.lexical("配色", { scopeKeys }, 10))).toEqual([doc.id]);
    });

    it("filters by document kind", () => {
      const doc = item(project("p"), "配色讨论结论");
      index.upsertItem(doc);
      index.upsertChunk(chunk("c1", 0, "[14:02] 用户: 配色怎么定"), keys(project("p"), { kind: "conversation", id: "c1" }));
      const scopeKeys = keys(project("p"));
      expect(refs(index.lexical("配色", { scopeKeys, docKind: "item" }, 10))).toEqual([doc.id]);
      expect(refs(index.lexical("配色", { scopeKeys, docKind: "chunk" }, 10))).toEqual(["studio:c1:0"]);
    });
  });

  describe("maintenance", () => {
    it("keeps the doc id when an item changes and re-tokenizes new text", () => {
      const doc = item(project("p"), "首页主色用青绿");
      const docId = index.upsertItem(doc);
      const revised = { ...doc, content: "首页主色改成橙色", contentHash: contentHash("首页主色改成橙色"), revision: 2 };
      expect(index.upsertItem(revised)).toBe(docId);
      const filter = { scopeKeys: keys(project("p")) };
      expect(index.lexical("青绿", filter, 10)).toEqual([]);
      expect(index.lexical("橙色", filter, 10).map((hit) => hit.docId)).toEqual([docId]);
      expect(index.docs([docId])[0]).toMatchObject({ docKind: "item", refId: doc.id, contentHash: revised.contentHash });
    });

    it("drops the text of a redacted item", () => {
      const doc = item(project("p"), "银行卡尾号 1234");
      index.upsertItem(doc);
      index.upsertItem({ ...doc, content: "", redacted: true, revision: 2 });
      expect(index.lexical("银行卡", { scopeKeys: keys(project("p")), includeHidden: true }, 10)).toEqual([]);
    });

    it("indexes windows under every scope that may read them and removes replaced ones", () => {
      const conversation: MemoryScopeRef = { kind: "conversation", id: "c1" };
      const scopeKeys = keys(conversation, { kind: "group", id: "g" }, bot("a"), bot("b"));
      const docId = index.upsertChunk(chunk("c1", 0, "[09:00] 小月: 周五团建"), scopeKeys);
      expect(index.scopeKeysOf(docId)).toEqual([...scopeKeys].sort());
      expect(index.chunkCounts().get(memoryScopeKey(bot("b")))).toBe(1);
      expect(index.lexical("团建", { scopeKeys: keys(bot("b")) }, 10).map((hit) => hit.docId)).toEqual([docId]);
      index.removeChunks(["studio:c1:0"]);
      expect(index.docIdOf("chunk", "studio:c1:0")).toBeNull();
      expect(index.lexical("团建", { scopeKeys }, 10)).toEqual([]);
      expect(index.chunkCounts().size).toBe(0);
    });

    it("rebuilds from the truth, keeping doc ids so vectors stay attached", () => {
      const vectors = new MemoryVectors(db, () => AT);
      const kept = item(project("p"), "保留下来的记忆");
      const gone = item(project("p"), "不再存在的记忆");
      const keptId = index.upsertItem(kept);
      const goneId = index.upsertItem(gone);
      vectors.upsert(keptId, "m", new Float32Array([1, 0]), kept.contentHash);
      vectors.upsert(goneId, "m", new Float32Array([0, 1]), gone.contentHash);
      const window = chunk("c1", 0, "[10:00] 用户: 重建索引");
      const written = index.rebuild({
        items: [kept],
        chunks: [{ chunk: window, scopeKeys: keys({ kind: "conversation", id: "c1" }) }],
      });
      expect(written).toBe(2);
      expect(index.count()).toBe(2);
      expect(index.docIdOf("item", kept.id)).toBe(keptId);
      expect(index.docIdOf("item", gone.id)).toBeNull();
      expect(vectors.counts("m").indexed).toBe(1);
      const filter: DocFilter = { scopeKeys: keys(project("p"), { kind: "conversation", id: "c1" }) };
      expect(index.lexical("重建索引", filter, 10)).toHaveLength(1);
      expect(index.lexical("保留", filter, 10).map((hit) => hit.docId)).toEqual([keptId]);
    });

    it("keeps the rarest tokens of a long query", () => {
      const rare = item(project("p"), "量子纠缠实验室的钥匙在前台");
      index.upsertItem(rare);
      for (let n = 0; n < 50; n += 1) {
        index.upsertItem(item(project("p"), `今天开会讨论项目进度和下周计划安排以及预算审批流程第${n}次`));
      }
      const query =
        "今天开会讨论项目进度和下周计划安排以及预算审批流程，另外我想问一下量子纠缠实验室的钥匙放在哪里了，谢谢";
      const hits = index.lexical(query, { scopeKeys: keys(project("p")) }, 5);
      expect(refs(hits)).toContain(rare.id);
    });
  });
});
