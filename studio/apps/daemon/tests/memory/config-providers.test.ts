// SPDX-License-Identifier: Apache-2.0
import Database from "better-sqlite3";
import { MEMORY_ENGINE_DEFAULTS, type MemoryEngineConfig } from "@open-design/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryConfig } from "../../src/services/memory/config.js";
import {
  buildProviders,
  LLM_JUDGE_SYSTEM,
  MemoryProviderError,
  QWEN3_QUERY_INSTRUCTION,
  type MemorySecrets,
} from "../../src/services/memory/providers.js";
import { ensureMemorySchema } from "../../src/services/memory/schema.js";
import { MemoryError, type MemoryLlm } from "../../src/services/memory/types.js";

// ---- Fakes -------------------------------------------------------------------------------------------------------

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

function fakeFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/** Never answers; rejects once the request's signal aborts, as fetch does. */
function hanging(call: FetchCall): Promise<Response> {
  return new Promise((_, reject) => {
    call.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

function metaMap(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getMeta: (key: string) => map.get(key) ?? null,
    setMeta: (key: string, value: string) => void map.set(key, value),
  };
}

function engineConfig(patch: {
  embedding?: Partial<MemoryEngineConfig["embedding"]>;
  reranker?: Partial<MemoryEngineConfig["reranker"]>;
  judge?: Partial<MemoryEngineConfig["judge"]>;
}): MemoryEngineConfig {
  const d = MEMORY_ENGINE_DEFAULTS;
  return {
    autoMemory: d.autoMemory,
    embedding: { ...d.embedding, ...patch.embedding },
    reranker: { ...d.reranker, ...patch.reranker },
    judge: { ...d.judge, ...patch.judge },
    recall: { ...d.recall },
  };
}

const NO_KEYS: MemorySecrets = { embeddingApiKey: "", rerankerApiKey: "", judgeApiKey: "" };

async function failure(promise: Promise<unknown>): Promise<MemoryProviderError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(MemoryProviderError);
  return error as MemoryProviderError;
}

function close(values: readonly number[]) {
  return values.map((value) => expect.closeTo(value, 5));
}

afterEach(() => {
  vi.useRealTimers();
});

// ---- MemoryConfig ------------------------------------------------------------------------------------------------

describe("MemoryConfig", () => {
  it("starts from the defaults and falls back field by field when stored JSON is corrupt", () => {
    expect(new MemoryConfig({ ...metaMap(), env: {} }).get()).toEqual(MEMORY_ENGINE_DEFAULTS);

    const corrupt = new MemoryConfig({ ...metaMap({ engine_config: "{not json", engine_secrets: "oops" }), env: {} });
    expect(corrupt.get()).toEqual(MEMORY_ENGINE_DEFAULTS);
    expect(corrupt.secrets()).toEqual(NO_KEYS);

    const partial = new MemoryConfig({
      ...metaMap({
        engine_config: JSON.stringify({
          autoMemory: "never",
          embedding: { provider: "bogus", model: "m", apiKey: "leaked" },
          recall: { maxHits: 999, minScore: 0.3 },
          judge: "not an object",
        }),
      }),
      env: {},
    });
    const config = partial.get();
    expect(config.autoMemory).toBe("auto");
    expect(config.embedding).toEqual({ ...MEMORY_ENGINE_DEFAULTS.embedding, model: "m" });
    expect(config.recall).toEqual({ ...MEMORY_ENGINE_DEFAULTS.recall, minScore: 0.3 });
    expect(config.judge).toEqual(MEMORY_ENGINE_DEFAULTS.judge);
    expect(partial.secrets().embeddingApiKey).toBe("");
  });

  it("merges each patch over what was stored and persists only the fields a person set", () => {
    const meta = metaMap();
    const config = new MemoryConfig({ ...meta, env: {} });
    config.update({ recall: { maxHits: 20 } });
    const after = config.update({ recall: { minScore: 0.3 }, autoMemory: "review" });
    expect(after.recall).toEqual({ maxHits: 20, budgetChars: 6000, minScore: 0.3 });
    expect(after.autoMemory).toBe("review");
    expect(JSON.parse(meta.map.get("engine_config") ?? "")).toEqual({
      autoMemory: "review",
      recall: { maxHits: 20, minScore: 0.3 },
    });
    expect(new MemoryConfig({ ...meta, env: {} }).get()).toEqual(after);
  });

  it("persists through mem_meta in SQLite", () => {
    const db = new Database(":memory:");
    ensureMemorySchema(db);
    const read = db.prepare("SELECT value FROM mem_meta WHERE key = ?").pluck();
    const write = db.prepare(
      "INSERT INTO mem_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const deps = {
      getMeta: (key: string) => (read.get(key) as string | undefined) ?? null,
      setMeta: (key: string, value: string) => void write.run(key, value),
      env: {},
    };
    new MemoryConfig(deps).update({ judge: { provider: "llm" }, reranker: { apiKey: "rk-1" } });
    const reopened = new MemoryConfig(deps);
    expect(reopened.get().judge.provider).toBe("llm");
    expect(reopened.get().reranker.hasApiKey).toBe(true);
    expect(reopened.secrets().rerankerApiKey).toBe("rk-1");
    db.close();
  });

  it("stores keys apart: set, keep when left out, clear with an empty string", () => {
    const meta = metaMap();
    const config = new MemoryConfig({ ...meta, env: {} });
    const set = config.update({
      embedding: {
        provider: "openai_compatible",
        baseUrl: "https://api.example.com/v1",
        model: "text-embedding-3-small",
        apiKey: "  sk-secret-123\n",
      },
    });
    expect(set.embedding.hasApiKey).toBe(true);
    expect(JSON.stringify(set)).not.toContain("sk-secret-123");
    expect(meta.map.get("engine_config")).not.toContain("sk-secret-123");
    expect(config.secrets().embeddingApiKey).toBe("sk-secret-123");

    expect(config.update({ embedding: { model: "text-embedding-3-large" } }).embedding.hasApiKey).toBe(true);
    expect(config.secrets().embeddingApiKey).toBe("sk-secret-123");

    const cleared = config.update({ embedding: { apiKey: "" } });
    expect(cleared.embedding.hasApiKey).toBe(false);
    expect(config.secrets().embeddingApiKey).toBe("");
    expect(JSON.parse(meta.map.get("engine_secrets") ?? "")).toEqual(NO_KEYS);
  });

  it("returns a copy, so a caller cannot change the cached configuration", () => {
    const config = new MemoryConfig({ ...metaMap(), env: {} });
    config.get().recall.maxHits = 1;
    expect(config.get().recall.maxHits).toBe(MEMORY_ENGINE_DEFAULTS.recall.maxHits);
  });

  it("rejects an invalid patch with MEMORY_INVALID and stores nothing", () => {
    const meta = metaMap();
    const config = new MemoryConfig({ ...meta, env: {} });
    for (const patch of [
      { recall: { maxHits: 0 } },
      { embedding: { baseUrl: "ftp://files.example.com" } },
      { reranker: { url: "https://user:pass@rerank.example.com" } },
      { judge: { apiUrl: "not a url" } },
    ]) {
      expect(() => config.update(patch)).toThrow(MemoryError);
      try {
        config.update(patch);
      } catch (error) {
        expect((error as MemoryError).code).toBe("MEMORY_INVALID");
        expect((error as MemoryError).status).toBe(400);
      }
    }
    expect(meta.map.size).toBe(0);
  });

  it("fills the HTTP reranker from OD_MEMORY_RERANKER_* until a person picks a reranker", () => {
    const env = {
      OD_MEMORY_RERANKER_URL: "http://127.0.0.1:8787/rerank",
      OD_MEMORY_RERANKER_MODEL: "bge-reranker-v2-m3",
      OD_MEMORY_RERANKER_API_KEY: "env-rerank-key",
    };
    const meta = metaMap();
    const config = new MemoryConfig({ ...meta, env });
    expect(config.get().reranker).toEqual({
      provider: "http",
      url: "http://127.0.0.1:8787/rerank",
      model: "bge-reranker-v2-m3",
      hasApiKey: true,
    });
    expect(config.secrets().rerankerApiKey).toBe("env-rerank-key");
    expect(config.providers(null).reranker?.id).toBe("http:bge-reranker-v2-m3");

    const builtin = config.update({ reranker: { provider: "builtin" } });
    expect(builtin.reranker).toEqual(MEMORY_ENGINE_DEFAULTS.reranker);
    expect(config.providers(null).reranker).toBeNull();
    expect(meta.map.get("engine_config")).not.toContain("bge-reranker");
  });

  it("fills Jev from TYPESAFE_* with the documented defaults", () => {
    const keyOnly = new MemoryConfig({ ...metaMap(), env: { TYPESAFE_API_KEY: "tk-env" } });
    expect(keyOnly.get().judge).toEqual(MEMORY_ENGINE_DEFAULTS.judge);
    const jev = keyOnly.update({ judge: { provider: "jev" } });
    expect(jev.judge).toEqual({
      provider: "jev",
      apiUrl: "https://api.typesafe.ai/v1",
      model: "jev-latest",
      hasApiKey: true,
    });
    expect(keyOnly.providers(null).judge?.id).toBe("jev:jev-latest");

    const custom = new MemoryConfig({
      ...metaMap(),
      env: { TYPESAFE_API_KEY: "tk", TYPESAFE_API_URL: "https://jev.internal/v2", TYPESAFE_MODEL: "jev-small" },
    });
    expect(custom.update({ judge: { provider: "jev" } }).judge).toMatchObject({
      apiUrl: "https://jev.internal/v2",
      model: "jev-small",
    });
    expect(custom.update({ judge: { model: "jev-pinned" } }).judge.model).toBe("jev-pinned");
  });

  it("shows Ollama's address and model when they are left empty", () => {
    const config = new MemoryConfig({ ...metaMap(), env: {} });
    expect(config.update({ embedding: { provider: "ollama" } }).embedding).toEqual({
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3-embedding:0.6b",
      dimensions: 0,
      hasApiKey: false,
    });
  });

  it("reuses provider clients until the configuration or the model changes", () => {
    const config = new MemoryConfig({ ...metaMap(), env: {} });
    config.update({ embedding: { provider: "ollama" } });
    const first = config.providers(null);
    expect(config.providers(null)).toBe(first);
    const llm: MemoryLlm = { complete: async () => null };
    expect(config.providers(llm)).not.toBe(first);
    const withLlm = config.providers(llm);
    config.update({ judge: { provider: "llm" } });
    const rebuilt = config.providers(llm);
    expect(rebuilt).not.toBe(withLlm);
    expect(rebuilt.judge?.id).toBe("llm");
    expect(rebuilt.embedding?.modelId).toBe("ollama:qwen3-embedding:0.6b:native");
  });
});

// ---- Embedding ---------------------------------------------------------------------------------------------------

describe("embedding providers", () => {
  it("is null when off or when a custom endpoint lacks its URL or model", () => {
    const { fetch } = fakeFetch(() => json({}));
    const deps = { env: {}, fetch, llm: null };
    expect(buildProviders(engineConfig({}), NO_KEYS, deps).embedding).toBeNull();
    const noUrl = engineConfig({ embedding: { provider: "openai_compatible", model: "m" } });
    expect(buildProviders(noUrl, NO_KEYS, deps).embedding).toBeNull();
    const noModel = engineConfig({ embedding: { provider: "openai_compatible", baseUrl: "https://x.example/v1" } });
    expect(buildProviders(noModel, NO_KEYS, deps).embedding).toBeNull();
  });

  it("Ollama: posts the batch to /api/embed without a key and returns unit vectors", async () => {
    const { fetch, calls } = fakeFetch(() => json({ embeddings: [[3, 4], [0, 2]] }));
    const provider = buildProviders(
      engineConfig({ embedding: { provider: "ollama" } }),
      { ...NO_KEYS, embeddingApiKey: "sk-meant-for-another-host" },
      { env: {}, fetch, llm: null },
    ).embedding;
    expect(provider?.modelId).toBe("ollama:qwen3-embedding:0.6b:native");
    expect(provider?.remote).toBe(false);

    const vectors = await provider!.embed(["第一条", "second"], "document");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/embed");
    expect(calls[0]?.body).toEqual({ model: "qwen3-embedding:0.6b", input: ["第一条", "second"] });
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(vectors.map((v) => Array.from(v))).toEqual([close([0.6, 0.8]), close([0, 1])]);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
  });

  it("prefixes queries, not documents, with the instruction for Qwen3-style models only", async () => {
    const { fetch, calls } = fakeFetch((call) => json({ embeddings: (call.body.input as string[]).map(() => [1, 0]) }));
    const deps = { env: {}, fetch, llm: null };
    const qwen = buildProviders(
      engineConfig({ embedding: { provider: "ollama", model: "dengcao/Qwen3-Embedding-4B:Q5_K_M" } }),
      NO_KEYS,
      deps,
    ).embedding!;
    await qwen.embed(["猫叫什么名字"], "query");
    await qwen.embed(["猫叫团子"], "document");
    expect(calls[0]?.body.input).toEqual([`${QWEN3_QUERY_INSTRUCTION}猫叫什么名字`]);
    expect(calls[1]?.body.input).toEqual(["猫叫团子"]);

    const nomic = buildProviders(
      engineConfig({ embedding: { provider: "ollama", model: "nomic-embed-text" } }),
      NO_KEYS,
      deps,
    ).embedding!;
    await nomic.embed(["what is the cat called"], "query");
    expect(calls[2]?.body.input).toEqual(["what is the cat called"]);
  });

  it("truncates to the configured dimensions and renormalizes (Matryoshka)", async () => {
    const { fetch } = fakeFetch(() => json({ embeddings: [[3, 4, 12, 5]] }));
    const provider = buildProviders(
      engineConfig({ embedding: { provider: "ollama", dimensions: 2 } }),
      NO_KEYS,
      { env: {}, fetch, llm: null },
    ).embedding!;
    expect(provider.modelId).toBe("ollama:qwen3-embedding:0.6b:2");
    const [vector] = await provider.embed(["x"], "document");
    expect(Array.from(vector!)).toEqual(close([0.6, 0.8]));
  });

  it("OpenAI-compatible: Bearer key, dimensions when set, results ordered by index", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ data: [{ index: 1, embedding: [0, 5] }, { index: 0, embedding: [2, 0] }] }),
    );
    const config = engineConfig({
      embedding: {
        provider: "openai_compatible",
        baseUrl: "https://api.example.com/v1/",
        model: "text-embedding-3-small",
        dimensions: 256,
      },
    });
    const provider = buildProviders(config, { ...NO_KEYS, embeddingApiKey: "sk-test" }, { env: {}, fetch, llm: null })
      .embedding!;
    expect(provider.remote).toBe(true);
    expect(provider.modelId).toBe("openai_compatible:text-embedding-3-small:256");
    const vectors = await provider.embed(["a", "b"], "query");
    expect(calls[0]?.url).toBe("https://api.example.com/v1/embeddings");
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-test");
    expect(calls[0]?.body).toEqual({ model: "text-embedding-3-small", input: ["a", "b"], dimensions: 256 });
    expect(vectors.map((v) => Array.from(v))).toEqual([close([1, 0]), close([0, 1])]);

    const native = buildProviders(
      { ...config, embedding: { ...config.embedding, dimensions: 0 } },
      NO_KEYS,
      { env: {}, fetch, llm: null },
    ).embedding!;
    await native.embed(["a", "b"], "document");
    expect(calls[1]?.body).toEqual({ model: "text-embedding-3-small", input: ["a", "b"] });
    expect(calls[1]?.headers.authorization).toBeUndefined();
  });

  it("treats 127.0.0.1, ::1 and localhost as local and everything else as remote", () => {
    const { fetch } = fakeFetch(() => json({}));
    const remoteOf = (baseUrl: string) =>
      buildProviders(
        engineConfig({ embedding: { provider: "openai_compatible", baseUrl, model: "m" } }),
        NO_KEYS,
        { env: {}, fetch, llm: null },
      ).embedding?.remote;
    expect(remoteOf("http://127.0.0.1:8080/v1")).toBe(false);
    expect(remoteOf("http://[::1]:8080/v1")).toBe(false);
    expect(remoteOf("http://localhost:1234/v1")).toBe(false);
    expect(remoteOf("http://192.168.1.20:8080/v1")).toBe(true);
    expect(remoteOf("https://localhost.example.com/v1")).toBe(true);
    const ollamaRemote = buildProviders(
      engineConfig({ embedding: { provider: "ollama", baseUrl: "http://gpu-box:11434" } }),
      NO_KEYS,
      { env: {}, fetch, llm: null },
    ).embedding;
    expect(ollamaRemote?.remote).toBe(true);
  });

  it("reports a wrong response shape clearly", async () => {
    const replies: unknown[] = [
      { embeddings: [[1, 0]] },
      { embeddings: [[1, 0], ["x", 1]] },
      { embeddings: [[1, 0], [1, 0, 0]] },
      { vectors: [] },
    ];
    const { fetch } = fakeFetch((_, index) => json(replies[index]));
    const provider = buildProviders(engineConfig({ embedding: { provider: "ollama" } }), NO_KEYS, {
      env: {},
      fetch,
      llm: null,
    }).embedding!;
    const messages: string[] = [];
    for (let i = 0; i < replies.length; i += 1) {
      const error = await failure(provider.embed(["a", "b"], "document"));
      expect(error.failure).toBe("shape");
      messages.push(error.message);
    }
    expect(messages[0]).toBe("Ollama embedding returned an unexpected response: expected 2 embeddings, got 1");
    expect(messages[1]).toContain("not a list of numbers");
    expect(messages[2]).toContain("differ in size");
    expect(messages[3]).toContain("no embeddings");

    const notJson = fakeFetch(() => new Response("<html>", { status: 200 }));
    const html = buildProviders(engineConfig({ embedding: { provider: "ollama" } }), NO_KEYS, {
      env: {},
      fetch: notJson.fetch,
      llm: null,
    }).embedding!;
    expect((await failure(html.embed(["a"], "document"))).message).toContain("not JSON");
  });

  it("names the provider and HTTP status but never the key or the request text", async () => {
    const { fetch } = fakeFetch(() => json({ error: { message: "Incorrect API key provided: sk-live-999" } }, 401));
    const provider = buildProviders(
      engineConfig({ embedding: { provider: "openai_compatible", baseUrl: "https://api.example.com/v1", model: "m" } }),
      { ...NO_KEYS, embeddingApiKey: "sk-live-999" },
      { env: {}, fetch, llm: null },
    ).embedding!;
    const error = await failure(provider.embed(["我的银行卡密码提示"], "document"));
    expect(error.message).toBe("OpenAI-compatible embedding failed with HTTP 401 (check the API key)");
    expect(error.status).toBe(401);
    expect(error.failure).toBe("http");
    expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(/sk-live-999|银行卡/);
  });

  it("maps a network failure to the host and its error code", async () => {
    const { fetch } = fakeFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const provider = buildProviders(engineConfig({ embedding: { provider: "ollama" } }), NO_KEYS, {
      env: {},
      fetch,
      llm: null,
    }).embedding!;
    const error = await failure(provider.embed(["a"], "document"));
    expect(error.failure).toBe("network");
    expect(error.message).toBe("Ollama embedding could not reach 127.0.0.1:11434 (ECONNREFUSED)");
  });

  it("times out after 15 s and tells a cancelled call apart", async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch(hanging);
    const provider = buildProviders(engineConfig({ embedding: { provider: "ollama" } }), NO_KEYS, {
      env: {},
      fetch,
      llm: null,
    }).embedding!;
    const timedOut = failure(provider.embed(["a"], "document"));
    await vi.advanceTimersByTimeAsync(14_999);
    await vi.advanceTimersByTimeAsync(1);
    const error = await timedOut;
    expect(error.failure).toBe("timeout");
    expect(error.message).toBe("Ollama embedding timed out after 15 s");

    const controller = new AbortController();
    const cancelled = failure(provider.embed(["a"], "document", controller.signal));
    controller.abort();
    expect((await cancelled).failure).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends nothing for an empty batch", async () => {
    const { fetch, calls } = fakeFetch(() => json({ embeddings: [] }));
    const provider = buildProviders(engineConfig({ embedding: { provider: "ollama" } }), NO_KEYS, {
      env: {},
      fetch,
      llm: null,
    }).embedding!;
    expect(await provider.embed([], "document")).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ---- Reranker ----------------------------------------------------------------------------------------------------

describe("reranker", () => {
  const httpConfig = engineConfig({
    reranker: { provider: "http", url: "https://rerank.example.com/v1/rerank", model: "bge-reranker-v2-m3" },
  });

  it("is null for the built-in reranker or without a URL", () => {
    const { fetch } = fakeFetch(() => json({}));
    expect(buildProviders(engineConfig({}), NO_KEYS, { env: {}, fetch, llm: null }).reranker).toBeNull();
    const noUrl = engineConfig({ reranker: { provider: "http" } });
    expect(buildProviders(noUrl, NO_KEYS, { env: {}, fetch, llm: null }).reranker).toBeNull();
  });

  it("posts {model, query, documents, top_n} and reads Cohere/Jina-style results", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] }),
    );
    const reranker = buildProviders(httpConfig, { ...NO_KEYS, rerankerApiKey: "rk" }, { env: {}, fetch, llm: null })
      .reranker!;
    expect(reranker.remote).toBe(true);
    const scores = await reranker.rerank("主色是什么", ["a", "b", "c"]);
    expect(calls[0]?.url).toBe("https://rerank.example.com/v1/rerank");
    expect(calls[0]?.headers.authorization).toBe("Bearer rk");
    expect(calls[0]?.body).toEqual({
      model: "bge-reranker-v2-m3",
      query: "主色是什么",
      documents: ["a", "b", "c"],
      top_n: 3,
    });
    // Index 1 was left out of the results; it ranks last without distorting the others.
    expect(scores).toEqual([0.2, 0.2, 0.9]);
  });

  it("reads a plain scores array and sends no key when none is set", async () => {
    const { fetch, calls } = fakeFetch(() => json({ scores: [0.1, 0.7] }));
    const local = engineConfig({ reranker: { provider: "http", url: "http://localhost:8787/rerank" } });
    const reranker = buildProviders(local, NO_KEYS, { env: {}, fetch, llm: null }).reranker!;
    expect(reranker.remote).toBe(false);
    expect(reranker.id).toBe("http");
    expect(await reranker.rerank("q", ["a", "b"])).toEqual([0.1, 0.7]);
    expect(calls[0]?.headers.authorization).toBeUndefined();
    expect(calls[0]?.body).toEqual({ query: "q", documents: ["a", "b"], top_n: 2 });
  });

  it("rejects a response it cannot read", async () => {
    const replies: unknown[] = [{ scores: [0.1] }, { results: [{ index: 9, relevance_score: 1 }] }, { ranking: [] }];
    const { fetch } = fakeFetch((_, index) => json(replies[index]));
    const reranker = buildProviders(httpConfig, NO_KEYS, { env: {}, fetch, llm: null }).reranker!;
    for (const detail of ["expected 2 numeric scores", "no usable results", "expected results or scores"]) {
      const error = await failure(reranker.rerank("q", ["a", "b"]));
      expect(error.message).toBe(`Reranker returned an unexpected response: ${detail}`);
    }
  });

  it("gives up after 4 s", async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch(hanging);
    const reranker = buildProviders(httpConfig, NO_KEYS, { env: {}, fetch, llm: null }).reranker!;
    const pending = failure(reranker.rerank("q", ["a"]));
    await vi.advanceTimersByTimeAsync(4_000);
    expect((await pending).message).toBe("Reranker timed out after 4 s");
  });
});

// ---- Judges ------------------------------------------------------------------------------------------------------

const older = { content: "首页主色用青绿 #0FB5AE", kind: "decision" as const, at: new Date(2026, 10, 1, 9).getTime() };
const newer = { content: "首页主色改成橙色 #FF7A00", kind: "decision" as const, at: new Date(2026, 10, 12, 21).getTime() };

function jevAnswers(conflict: unknown, duplicate: unknown) {
  return { answers: { conflict: { type: "noul", noul: conflict }, duplicate: { type: "noul", noul: duplicate } } };
}

describe("Jev judge", () => {
  const jevConfig = engineConfig({ judge: { provider: "jev", apiUrl: "https://jev.example.com/v1/", model: "jev-latest" } });
  const keys = { ...NO_KEYS, judgeApiKey: "tk-judge" };

  it("posts {model, state, questions} to /systemone with noul questions", async () => {
    const { fetch, calls } = fakeFetch(() => json(jevAnswers(0.92, 0.1)));
    const judge = buildProviders(jevConfig, keys, { env: {}, fetch, llm: null }).judge!;
    expect(judge.id).toBe("jev:jev-latest");
    expect(judge.remote).toBe(true);
    const verdict = await judge.compare(newer, older);

    expect(calls[0]?.url).toBe("https://jev.example.com/v1/systemone");
    expect(calls[0]?.headers.authorization).toBe("Bearer tk-judge");
    const body = calls[0]!.body;
    expect(Object.keys(body)).toEqual(["model", "state", "questions"]);
    expect(body.model).toBe("jev-latest");
    expect(body.state).toMatchObject({
      existing: { kind: "decision", recorded: "2026-11-01", text: older.content },
      incoming: { kind: "decision", recorded: "2026-11-12", text: newer.content },
    });
    const questions = body.questions as Record<string, { type: string; instructions: string; criteria: object }>;
    expect(Object.keys(questions)).toEqual(["conflict", "duplicate"]);
    for (const question of Object.values(questions)) {
      expect(question.type).toBe("noul");
      expect(question.instructions.length).toBeGreaterThan(20);
      expect(Object.keys(question.criteria)).toEqual(["true", "false"]);
    }
    expect(verdict).toEqual({ relation: "conflict", confidence: 0.92, reason: "两条记忆对同一件事的说法不一致。" });
  });

  it("does not append /systemone twice", async () => {
    const { fetch, calls } = fakeFetch(() => json(jevAnswers(0, 0)));
    const config = engineConfig({ judge: { provider: "jev", apiUrl: "https://jev.example.com/v1/systemone" } });
    await buildProviders(config, keys, { env: {}, fetch, llm: null }).judge!.compare(newer, older);
    expect(calls[0]?.url).toBe("https://jev.example.com/v1/systemone");
  });

  it("maps probabilities with the 0.70 conflict and 0.80 duplicate thresholds", async () => {
    const cases: Array<[number, number, string, number]> = [
      [0.7, 0.95, "conflict", 0.7],
      [0.69, 0.8, "duplicate", 0.8],
      [0.6, 0.79, "unrelated", 0.21],
      [0.05, 0.1, "unrelated", 0.9],
    ];
    const { fetch } = fakeFetch((_, index) => json(jevAnswers(cases[index]![0], cases[index]![1])));
    const judge = buildProviders(jevConfig, keys, { env: {}, fetch, llm: null }).judge!;
    for (const [, , relation, confidence] of cases) {
      const verdict = await judge.compare(
        { content: "Reply in English", kind: "preference", at: 2 },
        { content: "Reply in Chinese", kind: "preference", at: 1 },
      );
      expect(verdict.relation).toBe(relation);
      expect(verdict.confidence).toBeCloseTo(confidence, 6);
      expect(verdict.reason).toMatch(/^The two memories/);
    }
  });

  it("retries 429 and 529 up to two times with backoff", async () => {
    vi.useFakeTimers();
    const statuses = [429, 529];
    const { fetch, calls } = fakeFetch((_, index) => {
      const status = statuses[index];
      return status === undefined ? json(jevAnswers(0.1, 0.9)) : new Response(null, { status });
    });
    const judge = buildProviders(jevConfig, keys, { env: {}, fetch, llm: null }).judge!;
    const pending = judge.compare(newer, older);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(3);
    expect((await pending).relation).toBe("duplicate");
  });

  it("stops after the retries and does not retry other statuses", async () => {
    vi.useFakeTimers();
    const busy = fakeFetch(() => new Response(null, { status: 429 }));
    const pending = failure(
      buildProviders(jevConfig, keys, { env: {}, fetch: busy.fetch, llm: null }).judge!.compare(newer, older),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await pending;
    expect(busy.calls).toHaveLength(3);
    expect(error.message).toBe("Jev judge failed with HTTP 429 (the service is busy)");

    const broken = fakeFetch(() => new Response(null, { status: 500 }));
    const failed = await failure(
      buildProviders(jevConfig, keys, { env: {}, fetch: broken.fetch, llm: null }).judge!.compare(newer, older),
    );
    expect(broken.calls).toHaveLength(1);
    expect(failed.status).toBe(500);
  });

  it("rejects answers that are not probabilities, as the reference client does", async () => {
    const replies: unknown[] = [
      jevAnswers(1.5, 0),
      jevAnswers(true, 0),
      { answers: { conflict: { type: "bool", noul: 0.2 }, duplicate: { type: "noul", noul: 0.1 } } },
      { answers: { conflict: { type: "noul", noul: 0.2 } } },
      { result: "ok" },
    ];
    const { fetch } = fakeFetch((_, index) => json(replies[index]));
    const judge = buildProviders(jevConfig, keys, { env: {}, fetch, llm: null }).judge!;
    for (let i = 0; i < replies.length; i += 1) {
      expect((await failure(judge.compare(newer, older))).failure).toBe("shape");
    }
  });

  it("is null without a key and uses the environment key when one is set", () => {
    const { fetch } = fakeFetch(() => json({}));
    const config = engineConfig({ judge: { provider: "jev" } });
    expect(buildProviders(config, NO_KEYS, { env: {}, fetch, llm: null }).judge).toBeNull();
    const fromEnv = buildProviders(config, NO_KEYS, { env: { TYPESAFE_API_KEY: "tk" }, fetch, llm: null }).judge;
    expect(fromEnv?.id).toBe("jev:jev-latest");
  });
});

describe("LLM judge", () => {
  function judgeWith(reply: string | null | Error) {
    const calls: Array<Parameters<MemoryLlm["complete"]>[0]> = [];
    const llm: MemoryLlm = {
      async complete(input) {
        calls.push(input);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    };
    const { fetch } = fakeFetch(() => json({}));
    const judge = buildProviders(engineConfig({ judge: { provider: "llm" } }), NO_KEYS, { env: {}, fetch, llm }).judge!;
    return { judge, calls };
  }

  it("asks once with both texts, their kinds and dates, and a strict-JSON instruction", async () => {
    const { judge, calls } = judgeWith(
      'Sure:\n```json\n{"relation":"conflict","confidence":0.83,"reason":"新旧主色不同。"}\n```',
    );
    expect(judge.remote).toBe(true);
    const verdict = await judge.compare(newer, older);
    expect(verdict).toEqual({ relation: "conflict", confidence: 0.83, reason: "新旧主色不同。" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.system).toBe(LLM_JUDGE_SYSTEM);
    expect(calls[0]?.system).toMatch(/Chinese or English/);
    expect(calls[0]?.system).toMatch(/exactly one JSON object/);
    const user = calls[0]!.user;
    for (const part of [older.content, newer.content, "2026-11-01", "2026-11-12", '"kind": "decision"']) {
      expect(user).toContain(part);
    }
    expect(user.indexOf('"existing"')).toBeLessThan(user.indexOf('"incoming"'));
  });

  it("clamps the confidence and fills a missing reason in the memories' language", async () => {
    const { judge } = judgeWith('{"relation":"Duplicate","confidence":"1.4"}');
    expect(await judge.compare(newer, older)).toEqual({
      relation: "duplicate",
      confidence: 1,
      reason: "两条记忆说的是同一件事。",
    });
  });

  it("returns unrelated with confidence 0 on any failure", async () => {
    for (const reply of [null, "no idea", '{"relation":"contradiction","confidence":0.9}', '{"relation":"conflict"}', new Error("boom")]) {
      const { judge } = judgeWith(reply);
      const verdict = await judge.compare(newer, older);
      expect(verdict.relation).toBe("unrelated");
      expect(verdict.confidence).toBe(0);
    }
  });

  it("is null without a model", () => {
    const { fetch } = fakeFetch(() => json({}));
    expect(buildProviders(engineConfig({ judge: { provider: "llm" } }), NO_KEYS, { env: {}, fetch, llm: null }).judge)
      .toBeNull();
    expect(buildProviders(engineConfig({}), NO_KEYS, { env: {}, fetch, llm: { complete: async () => null } }).judge)
      .toBeNull();
  });
});
