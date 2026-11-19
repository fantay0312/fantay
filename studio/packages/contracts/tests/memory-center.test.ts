// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  MEMORY_CONFLICT_RESOLUTIONS,
  MEMORY_ENGINE_DEFAULTS,
  MEMORY_EVENT_TYPES,
  MEMORY_ITEM_KINDS,
  MEMORY_ITEM_STATUSES,
  MEMORY_LINK_RELATIONS,
  MEMORY_SCOPE_KINDS,
  copyMemoryItemSchema,
  createMemoryItemSchema,
  memoryChunkListQuerySchema,
  memoryItemActionSchema,
  memoryItemListQuerySchema,
  memoryLocalModelActionSchema,
  memoryRecallSchema,
  memoryReindexSchema,
  memoryScopeKey,
  memoryTidySchema,
  parseMemoryScopeKey,
  resolveMemoryConflictSchema,
  resolveMemoryPendingSchema,
  updateAgentMemoryPolicySchema,
  updateMemoryEngineConfigSchema,
  updateMemoryItemSchema,
  type MemoryScopeRef,
} from "../src/index";

describe("Memory Center contract", () => {
  describe("scopes", () => {
    it("lists the six scope kinds", () => {
      expect(MEMORY_SCOPE_KINDS).toEqual(["profile", "persona", "bot", "group", "project", "conversation"]);
    });

    it("round-trips every scope through its key", () => {
      const scopes: MemoryScopeRef[] = [
        { kind: "profile", id: "" },
        { kind: "persona", id: "persona-1" },
        { kind: "bot", id: "bot-1" },
        { kind: "group", id: "group-1" },
        { kind: "project", id: "proj-1" },
        { kind: "conversation", id: "conv-1" },
      ];
      for (const scope of scopes) {
        const key = memoryScopeKey(scope);
        expect(key).toBe(`${scope.kind}:${scope.id}`);
        expect(parseMemoryScopeKey(key)).toEqual(scope);
      }
    });

    it("keeps ids that contain colons and ignores any id on the profile scope", () => {
      expect(parseMemoryScopeKey("conversation:comment:anchor:1")).toEqual({ kind: "conversation", id: "comment:anchor:1" });
      expect(memoryScopeKey({ kind: "profile", id: "ignored" })).toBe("profile:");
      expect(parseMemoryScopeKey("profile:ignored")).toEqual({ kind: "profile", id: "" });
    });

    it("rejects keys that name no scope", () => {
      expect(parseMemoryScopeKey("")).toBeNull();
      expect(parseMemoryScopeKey("profile")).toBeNull();
      expect(parseMemoryScopeKey(":x")).toBeNull();
      expect(parseMemoryScopeKey("team:abc")).toBeNull();
      expect(parseMemoryScopeKey("bot:")).toBeNull();
    });
  });

  describe("vocabularies", () => {
    it("names the item states, events, links and resolutions the engine writes", () => {
      expect(MEMORY_ITEM_STATUSES).toEqual(["active", "pending", "superseded", "rejected", "archived"]);
      expect(MEMORY_CONFLICT_RESOLUTIONS).toEqual(["keep_new", "keep_old", "merge", "keep_both"]);
      expect(MEMORY_LINK_RELATIONS).toEqual(["merged_from", "derived_from", "supersedes", "relates"]);
      expect(MEMORY_EVENT_TYPES).toContain("redacted");
      expect(MEMORY_EVENT_TYPES).toContain("conflict_resolved");
      expect(MEMORY_ITEM_KINDS).toContain("episode");
    });

    it("has no delete action: memories are archived, restored or (by the owner, explicitly) redacted", () => {
      expect(memoryItemActionSchema.parse({ action: "archive" }).action).toBe("archive");
      expect(memoryItemActionSchema.parse({ action: "restore" }).action).toBe("restore");
      expect(memoryItemActionSchema.parse({ action: "redact", confirm: true }).confirm).toBe(true);
      expect(() => memoryItemActionSchema.parse({ action: "delete" })).toThrow();
    });
  });

  describe("MEMORY_ENGINE_DEFAULTS", () => {
    it("starts at lexical search with the built-in reranker and rule-based conflict checks", () => {
      expect(MEMORY_ENGINE_DEFAULTS).toEqual({
        autoMemory: "auto",
        embedding: { provider: "off", baseUrl: "", model: "", dimensions: 0, hasApiKey: false },
        reranker: { provider: "builtin", url: "", model: "", hasApiKey: false },
        judge: { provider: "heuristic", apiUrl: "", model: "", hasApiKey: false },
        recall: { maxHits: 12, budgetChars: 6000, minScore: 0.18 },
      });
    });

    it("has defaults that its own update schema accepts", () => {
      const { embedding, reranker, judge, recall, autoMemory } = MEMORY_ENGINE_DEFAULTS;
      expect(() =>
        updateMemoryEngineConfigSchema.parse({
          autoMemory,
          embedding: { provider: embedding.provider, baseUrl: embedding.baseUrl, model: embedding.model, dimensions: embedding.dimensions },
          reranker: { provider: reranker.provider, url: reranker.url, model: reranker.model },
          judge: { provider: judge.provider, apiUrl: judge.apiUrl, model: judge.model },
          recall,
        }),
      ).not.toThrow();
    });
  });

  describe("create", () => {
    it("fills the profile id and trims text", () => {
      const parsed = createMemoryItemSchema.parse({ scope: { kind: "profile" }, content: "  回复用中文，结论先行  " });
      expect(parsed.scope).toEqual({ kind: "profile", id: "" });
      expect(parsed.content).toBe("回复用中文，结论先行");
    });

    it("needs text and a known scope and kind", () => {
      expect(() => createMemoryItemSchema.parse({ scope: { kind: "bot", id: "b" }, content: "   " })).toThrow();
      expect(() => createMemoryItemSchema.parse({ scope: { kind: "team", id: "t" }, content: "x" })).toThrow();
      expect(() => createMemoryItemSchema.parse({ scope: { kind: "bot", id: "b" }, content: "x", kind: "hunch" })).toThrow();
      expect(() => createMemoryItemSchema.parse({ content: "x" })).toThrow();
    });

    it("keeps provenance, a group origin and validity", () => {
      const parsed = createMemoryItemSchema.parse({
        scope: { kind: "bot", id: "bot-1" },
        content: "协作工作室周五评审",
        kind: "promise",
        dueAt: 1_800_000_000_000,
        validUntil: null,
        via: { groupId: "g1", groupName: "协作工作室" },
        sourceRefs: [{ kind: "message", id: "m1" }],
      });
      expect(parsed.via?.groupName).toBe("协作工作室");
      expect(parsed.validUntil).toBeNull();
      expect(parsed.sourceRefs).toHaveLength(1);
    });
  });

  describe("update and copy", () => {
    it("allows partial updates and a revision for optimistic locking", () => {
      expect(updateMemoryItemSchema.parse({ pinned: true, revision: 3 })).toEqual({ pinned: true, revision: 3 });
      expect(updateMemoryItemSchema.parse({ dueAt: null }).dueAt).toBeNull();
      expect(() => updateMemoryItemSchema.parse({ content: "" })).toThrow();
      expect(() => updateMemoryItemSchema.parse({ revision: -1 })).toThrow();
    });

    it("does not accept a scope on update: editing never changes scope", () => {
      const parsed = updateMemoryItemSchema.parse({ content: "x", scope: { kind: "group", id: "g" } });
      expect("scope" in parsed).toBe(false);
    });

    it("copies into a scope", () => {
      expect(copyMemoryItemSchema.parse({ scope: { kind: "project", id: "p1" }, title: " 配色 " })).toEqual({
        scope: { kind: "project", id: "p1" },
        title: "配色",
      });
      expect(() => copyMemoryItemSchema.parse({})).toThrow();
    });
  });

  describe("conflict resolution", () => {
    it("accepts the four resolutions", () => {
      for (const resolution of ["keep_new", "keep_old", "keep_both"] as const) {
        expect(resolveMemoryConflictSchema.parse({ resolution }).resolution).toBe(resolution);
      }
    });

    it("needs the merged text to merge", () => {
      expect(() => resolveMemoryConflictSchema.parse({ resolution: "merge" })).toThrow(/mergedContent/);
      expect(() => resolveMemoryConflictSchema.parse({ resolution: "merge", mergedContent: "   " })).toThrow();
      const merged = resolveMemoryConflictSchema.parse({ resolution: "merge", mergedContent: " 两个都对 ", mergedTitle: "合并" });
      expect(merged.mergedContent).toBe("两个都对");
    });

    it("rejects the old resolution names", () => {
      expect(() => resolveMemoryConflictSchema.parse({ resolution: "keep_incoming" })).toThrow();
      expect(() => resolveMemoryConflictSchema.parse({ resolution: "archive_both" })).toThrow();
    });
  });

  describe("pending proposals", () => {
    it("takes accept or reject, with optional corrections", () => {
      expect(resolveMemoryPendingSchema.parse({ accept: false })).toEqual({ accept: false });
      const accepted = resolveMemoryPendingSchema.parse({
        accept: true,
        revision: 2,
        content: " 改过的文字 ",
        scope: { kind: "group", id: "g1" },
        kind: "decision",
      });
      expect(accepted.content).toBe("改过的文字");
      expect(accepted.scope).toEqual({ kind: "group", id: "g1" });
      expect(() => resolveMemoryPendingSchema.parse({})).toThrow();
    });
  });

  describe("recall", () => {
    it("needs a context or scopes", () => {
      expect(() => memoryRecallSchema.parse({ query: "配色" })).toThrow(/context or scopes/);
      expect(memoryRecallSchema.parse({ query: "配色", context: { surface: "studio", projectId: "p1" } }).context?.surface).toBe("studio");
      expect(memoryRecallSchema.parse({ query: "配色", scopes: [{ kind: "profile" }] }).scopes).toEqual([{ kind: "profile", id: "" }]);
    });

    it("bounds the query, the scope list and the budget", () => {
      const scopes = [{ kind: "profile" as const }];
      expect(() => memoryRecallSchema.parse({ query: "   ", scopes })).toThrow();
      expect(() => memoryRecallSchema.parse({ query: "x", scopes: [] })).toThrow();
      expect(() => memoryRecallSchema.parse({ query: "x", scopes, limit: 41 })).toThrow();
      expect(() => memoryRecallSchema.parse({ query: "x", scopes, budgetChars: 100 })).toThrow();
      expect(() => memoryRecallSchema.parse({ query: "x", context: { surface: "web" } })).toThrow();
    });
  });

  describe("list queries", () => {
    it("accepts a status or all, and bounds the page", () => {
      expect(memoryItemListQuerySchema.parse({ status: "all", limit: 500 }).status).toBe("all");
      expect(() => memoryItemListQuerySchema.parse({ status: "deleted" })).toThrow();
      expect(() => memoryItemListQuerySchema.parse({ limit: 501 })).toThrow();
      expect(() => memoryItemListQuerySchema.parse({ limit: 0 })).toThrow();
      expect(() => memoryItemListQuerySchema.parse({ offset: -1 })).toThrow();
    });

    it("takes booleans and numbers as such: coercion from the query string happens in the route", () => {
      expect(() => memoryItemListQuerySchema.parse({ pinned: "true" })).toThrow();
      expect(() => memoryItemListQuerySchema.parse({ limit: "10" })).toThrow();
      expect(memoryItemListQuerySchema.parse({ pinned: true, viaGroup: false, limit: 10 })).toEqual({
        pinned: true,
        viaGroup: false,
        limit: 10,
      });
    });

    it("bounds the window page smaller than the item page", () => {
      expect(memoryChunkListQuerySchema.parse({ limit: 200 }).limit).toBe(200);
      expect(() => memoryChunkListQuerySchema.parse({ limit: 201 })).toThrow();
    });
  });

  describe("engine requests", () => {
    it("accepts the local model providers", () => {
      const parsed = updateMemoryEngineConfigSchema.parse({
        embedding: { provider: "local", dimensions: 512 },
        reranker: { provider: "local" },
      });
      expect(parsed.embedding?.provider).toBe("local");
      expect(parsed.reranker?.provider).toBe("local");
      expect(() => updateMemoryEngineConfigSchema.parse({ embedding: { provider: "cloud" } })).toThrow();
    });

    it("distinguishes leaving a key out (keep it) from sending an empty one (clear it)", () => {
      expect(updateMemoryEngineConfigSchema.parse({ embedding: { model: "m" } }).embedding).toEqual({ model: "m" });
      expect(updateMemoryEngineConfigSchema.parse({ embedding: { apiKey: "" } }).embedding).toEqual({ apiKey: "" });
    });

    it("bounds the recall settings", () => {
      expect(() => updateMemoryEngineConfigSchema.parse({ recall: { minScore: 1.5 } })).toThrow();
      expect(() => updateMemoryEngineConfigSchema.parse({ recall: { maxHits: 0 } })).toThrow();
      expect(() => updateMemoryEngineConfigSchema.parse({ recall: { budgetChars: 100 } })).toThrow();
    });

    it("downloads or cancels a local model", () => {
      expect(memoryLocalModelActionSchema.parse({ action: "download" }).action).toBe("download");
      expect(memoryLocalModelActionSchema.parse({ action: "cancel" }).action).toBe("cancel");
      expect(() => memoryLocalModelActionSchema.parse({ action: "delete" })).toThrow();
    });

    it("reindexes with or without vectors and tidies one scope or all", () => {
      expect(memoryReindexSchema.parse({})).toEqual({});
      expect(memoryReindexSchema.parse({ vectors: true }).vectors).toBe(true);
      expect(memoryTidySchema.parse({}).scope).toBeUndefined();
      expect(memoryTidySchema.parse({ scope: { kind: "bot", id: "b1" } }).scope).toEqual({ kind: "bot", id: "b1" });
    });
  });

  describe("bot policy", () => {
    it("takes the profile mount and the auto-memory mode", () => {
      expect(updateAgentMemoryPolicySchema.parse({ profileMount: "none", autoMemoryMode: "off", revision: 2 })).toEqual({
        profileMount: "none",
        autoMemoryMode: "off",
        revision: 2,
      });
      expect(() => updateAgentMemoryPolicySchema.parse({ profileMount: "leak_all" })).toThrow();
      expect(() => updateAgentMemoryPolicySchema.parse({ autoMemoryMode: "always" })).toThrow();
    });
  });
});
