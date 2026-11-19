// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_ENGINE_DEFAULTS } from "@open-design/contracts";
import { MemoryConfig } from "../../src/services/memory/config.js";
import { createMemoryEngine } from "../../src/services/memory/engine.js";
import {
  createLocalModels,
  LOCAL_MODELS,
  type LocalModelSpec,
  type LocalTokenizer,
  type OrtModuleLike,
  type OrtSessionLike,
  type OrtTensorLike,
} from "../../src/services/memory/local-models.js";
import { buildProviders, QWEN3_QUERY_INSTRUCTION } from "../../src/services/memory/providers.js";
import type { EmbeddingProvider, MemoryLocalRuntime, RerankProvider } from "../../src/services/memory/types.js";

// ---- fixtures ----------------------------------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fantay-local-models-"));
  roots.push(dir);
  return dir;
}

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** File contents of the two fake models; the specs carry their real sizes and hashes. */
const CONTENT: Record<string, Buffer> = {
  "emb/onnx/model.onnx": Buffer.from("fake embedding model ".repeat(400)),
  "emb/tokenizer.json": Buffer.from('{"fake":"tokenizer"}'),
  "emb/tokenizer_config.json": Buffer.from('{"fake":"config"}'),
  "rr/onnx/model.onnx": Buffer.from("fake reranker model ".repeat(300)),
  "rr/tokenizer.json": Buffer.from('{"fake":"rr tokenizer"}'),
  "rr/tokenizer_config.json": Buffer.from('{"fake":"rr config"}'),
};

function fileOf(id: string, relative: string) {
  const data = CONTENT[`${id}/${relative}`]!;
  return { path: relative, bytes: data.length, sha256: sha256(data) };
}

const EMB: LocalModelSpec = {
  id: "emb",
  role: "embedding",
  name: "Fake Embedding",
  license: "Apache-2.0",
  repo: "test/emb",
  revision: "rev1",
  files: ["onnx/model.onnx", "tokenizer.json", "tokenizer_config.json"].map((file) => fileOf("emb", file)),
  onnx: "onnx/model.onnx",
  tokenizer: "tokenizer.json",
  tokenizerConfig: "tokenizer_config.json",
  output: "last_hidden_state",
  maxTokens: 8,
  queryMaxTokens: 6,
  eosId: 99,
  kvHeads: 2,
  headDim: 4,
  defaultDimensions: 3,
  queryPrefix: "Q:",
};

const RR: LocalModelSpec = {
  id: "rr",
  role: "reranker",
  name: "Fake Reranker",
  license: "Apache-2.0",
  repo: "test/rr",
  revision: "rev2",
  files: ["onnx/model.onnx", "tokenizer.json", "tokenizer_config.json"].map((file) => fileOf("rr", file)),
  onnx: "onnx/model.onnx",
  tokenizer: "tokenizer.json",
  tokenizerConfig: "tokenizer_config.json",
  output: "logits",
  maxTokens: 12,
  queryMaxTokens: 3,
  clsId: 0,
  sepId: 2,
};

function installModels(dir: string, ids: readonly string[] = ["emb", "rr"]): void {
  for (const [key, data] of Object.entries(CONTENT)) {
    const [id, ...rest] = key.split("/");
    if (!ids.includes(id!)) continue;
    const file = path.join(dir, id!, ...rest);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
}

/** One id per character: "a" → 97. */
const fakeTokenizer: LocalTokenizer = {
  encode: (text) => ({ ids: Array.from(text).map((char) => char.codePointAt(0)!) }),
};

class FakeTensor implements OrtTensorLike {
  constructor(
    readonly type: string,
    readonly data: BigInt64Array | Float32Array,
    readonly dims: readonly number[],
  ) {}
}

interface Run {
  model: string;
  feeds: Record<string, FakeTensor>;
  fetches: readonly string[];
}

/**
 * A fake onnxruntime. The embedding model's hidden state at position i is [i + 1, id_i, 1, 0, …] (width 5), so the
 * last-token vector is predictable; the reranker's logit is (sum of ids) / 1000 − 1.
 */
function fakeOrt(options: { gate?: Promise<void> } = {}) {
  const runs: Run[] = [];
  const created: Array<{ file: string; options: Record<string, unknown> }> = [];
  const released: string[] = [];
  const module: OrtModuleLike = {
    Tensor: FakeTensor as unknown as OrtModuleLike["Tensor"],
    InferenceSession: {
      async create(file, sessionOptions) {
        created.push({ file, options: sessionOptions });
        const reranker = file.includes(`${path.sep}rr${path.sep}`);
        const session: OrtSessionLike = {
          inputNames: reranker
            ? ["input_ids", "attention_mask", "token_type_ids"]
            : ["input_ids", "attention_mask", "position_ids", "past_key_values.0.key", "past_key_values.0.value"],
          async run(feeds, fetches) {
            const typed = feeds as Record<string, FakeTensor>;
            runs.push({ model: reranker ? "rr" : "emb", feeds: typed, fetches });
            await options.gate;
            const ids = Array.from(typed.input_ids!.data as BigInt64Array, Number);
            if (reranker) {
              return { logits: new FakeTensor("float32", Float32Array.of(ids.reduce((a, b) => a + b, 0) / 1000 - 1), [1, 1]) };
            }
            const width = 5;
            const hidden = new Float32Array(ids.length * width);
            ids.forEach((id, i) => hidden.set([i + 1, id, 1, 0, 0], i * width));
            return { last_hidden_state: new FakeTensor("float32", hidden, [1, ids.length, width]) };
          },
          async release() {
            released.push(reranker ? "rr" : "emb");
          },
        };
        return session;
      },
    },
  };
  return { module, runs, created, released };
}

function unit(values: number[]): number[] {
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

function runtime(
  dir: string,
  ort: OrtModuleLike,
  extra: Partial<Parameters<typeof createLocalModels>[0]> = {},
): MemoryLocalRuntime {
  return createLocalModels({
    dataDir: dir,
    env: {},
    models: [EMB, RR],
    runtimePresent: () => true,
    loadRuntime: async () => ort,
    loadTokenizer: async () => fakeTokenizer,
    threads: 2,
    ...extra,
  });
}

/** Resolves on the next onChange call that satisfies `test`. */
function changes() {
  const waiters: Array<{ test: () => boolean; resolve: () => void }> = [];
  return {
    onChange: () => {
      for (const waiter of [...waiters]) {
        if (!waiter.test()) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    },
    until: (test: () => boolean) =>
      test() ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ test, resolve })),
  };
}

// ---- inference ---------------------------------------------------------------------------------------------------

describe("local models — inference", () => {
  it("pools the last token, truncates to the configured size and normalizes", async () => {
    const dir = tempDir();
    installModels(path.join(dir, "memory-models"));
    const ort = fakeOrt();
    const local = runtime(dir, ort.module);
    const provider = local.embedding(3)!;
    expect(provider).toMatchObject({ modelId: "local:emb:3", remote: false });
    const [vector] = await provider.embed(["ab"], "document");
    // ids a=97 b=98, then the end-of-text id 99 at position 2: hidden [3, 99, 1, 0, 0], cut to 3, normalized.
    expect(Array.from(vector!)).toEqual(unit([3, 99, 1]).map((v) => Math.fround(v)));
    expect(ort.runs[0]!.fetches).toEqual(["last_hidden_state"]);
    expect(Array.from(ort.runs[0]!.feeds.position_ids!.data as BigInt64Array, Number)).toEqual([0, 1, 2]);
    expect(ort.runs[0]!.feeds["past_key_values.0.key"]!.dims).toEqual([1, 2, 0, 4]);
    expect(local.embedding(0)!.modelId).toBe("local:emb:3");
    expect(local.embedding(2)).not.toBe(provider);
    local.dispose();
  });

  it("adds the query instruction to queries only and caps both lengths", async () => {
    const dir = tempDir();
    installModels(path.join(dir, "memory-models"));
    const ort = fakeOrt();
    const local = runtime(dir, ort.module);
    const provider = local.embedding(5)!;
    await provider.embed(["abcdefghijkl"], "document");
    await provider.embed(["xyz"], "query");
    const ids = ort.runs.map((run) => Array.from(run.feeds.input_ids!.data as BigInt64Array, Number));
    // Documents: 7 tokens of text + end-of-text (maxTokens 8). Queries: "Q:" + text, 5 + end-of-text (6).
    expect(ids[0]).toEqual([..."abcdefg"].map((c) => c.codePointAt(0)!).concat(99));
    expect(ids[1]).toEqual([..."Q:xyz"].map((c) => c.codePointAt(0)!).concat(99));
    expect(QWEN3_QUERY_INSTRUCTION).toContain("Instruct:");
    expect(LOCAL_MODELS.find((spec) => spec.role === "embedding")).toMatchObject({ queryPrefix: QWEN3_QUERY_INSTRUCTION });
    local.dispose();
  });

  it("runs every text on its own, in order", async () => {
    const dir = tempDir();
    installModels(path.join(dir, "memory-models"));
    const ort = fakeOrt();
    const local = runtime(dir, ort.module);
    const texts = ["a", "bbbb", "cc"];
    const vectors = await local.embedding(5)!.embed(texts, "document");
    expect(ort.runs).toHaveLength(3);
    expect(ort.runs.every((run) => run.feeds.input_ids!.dims[0] === 1)).toBe(true);
    // The pooled position (length + 1) identifies which text each vector came from.
    expect(vectors.map((v) => Math.round((v[0]! / v[2]!) * 10) / 10)).toEqual([2, 5, 3]);
    local.dispose();
  });

  it("scores query–document pairs with the model's pair layout and a sigmoid", async () => {
    const dir = tempDir();
    installModels(path.join(dir, "memory-models"));
    const ort = fakeOrt();
    const local = runtime(dir, ort.module);
    const reranker = local.reranker() as RerankProvider;
    expect(reranker).toMatchObject({ id: "local:rr", remote: false });
    const scores = await reranker.rerank("abcd", ["x", "yyyyyyyyyyyy"]);
    const ids = ort.runs.map((run) => Array.from(run.feeds.input_ids!.data as BigInt64Array, Number));
    const q = [..."abc"].map((c) => c.codePointAt(0)!);
    // <s> query </s></s> document </s>, the query cut to 3 tokens and the pair to 12.
    expect(ids[0]).toEqual([0, ...q, 2, 2, 120, 2]);
    expect(ids[1]).toEqual([0, ...q, 2, 2, ...Array(5).fill(121), 2]);
    expect(Array.from(ort.runs[0]!.feeds.token_type_ids!.data as BigInt64Array, Number)).toEqual(Array(8).fill(0));
    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
    expect(scores[0]).toBeCloseTo(sigmoid(ids[0]!.reduce((a, b) => a + b, 0) / 1000 - 1), 6);
    expect(scores[1]).toBeCloseTo(sigmoid(ids[1]!.reduce((a, b) => a + b, 0) / 1000 - 1), 6);
    local.dispose();
  });

  it("creates each session once, with 2–4 threads, and releases them on dispose", async () => {
    const dir = tempDir();
    installModels(path.join(dir, "memory-models"));
    const ort = fakeOrt();
    const local = runtime(dir, ort.module, { threads: undefined });
    await local.embedding(3)!.embed(["a"], "document");
    await local.embedding(3)!.embed(["b"], "query");
    await local.reranker()!.rerank("a", ["b"]);
    expect(ort.created.map((entry) => path.basename(path.dirname(path.dirname(entry.file))))).toEqual(["emb", "rr"]);
    const threads = ort.created[0]!.options.intraOpNumThreads as number;
    expect(threads).toBeGreaterThanOrEqual(2);
    expect(threads).toBeLessThanOrEqual(4);
    local.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ort.released.sort()).toEqual(["emb", "rr"]);
    expect(local.embedding(3)).toBeNull();
  });

  it("lets a waiting query run before the remaining background documents", async () => {
    const dir = tempDir();
    installModels(path.join(dir, "memory-models"));
    let open!: () => void;
    const ort = fakeOrt({ gate: new Promise<void>((resolve) => (open = resolve)) });
    const local = runtime(dir, ort.module);
    const provider = local.embedding(3)!;
    const background = provider.embed(["d1", "d2", "d3"], "document");
    await new Promise((resolve) => setImmediate(resolve));
    const query = provider.embed(["q"], "query");
    await new Promise((resolve) => setImmediate(resolve));
    open();
    await Promise.all([background, query]);
    const order = ort.runs.map((run) => String.fromCodePoint(Number((run.feeds.input_ids!.data as BigInt64Array)[0])));
    // d1 was already running; the query goes next, before d2 and d3.
    expect(order).toEqual(["d", "Q", "d", "d"]);
    local.dispose();
  });

  it("rejects a job whose caller gave up while it waited, and keeps serving the ones behind it", async () => {
    const dir = tempDir();
    installModels(path.join(dir, "memory-models"));
    let open!: () => void;
    const ort = fakeOrt({ gate: new Promise<void>((resolve) => (open = resolve)) });
    const local = runtime(dir, ort.module);
    const provider = local.embedding(3)!;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const first = provider.embed(["d1"], "document");
      await new Promise((resolve) => setImmediate(resolve));
      // Waits behind d1; its caller times out before its turn comes.
      const gaveUp = new AbortController();
      const waiting = provider.embed(["q1"], "query", gaveUp.signal);
      const behind = provider.embed(["q2"], "query");
      await new Promise((resolve) => setImmediate(resolve));
      gaveUp.abort();
      open();
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      await expect(first).resolves.toHaveLength(1);
      await expect(behind).resolves.toHaveLength(1);
      await new Promise((resolve) => setImmediate(resolve));
      // The cancelled job never ran, and nothing escaped the queue.
      expect(ort.runs).toHaveLength(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      local.dispose();
    }
  });
});

// ---- availability ------------------------------------------------------------------------------------------------

describe("local models — availability", () => {
  it("offers nothing when the runtime is missing from this build", async () => {
    const dir = tempDir();
    installModels(path.join(dir, "memory-models"));
    const local = createLocalModels({ dataDir: dir, env: {}, models: [EMB, RR], runtimePresent: () => false });
    expect(local.available()).toBe(false);
    expect(local.embedding(3)).toBeNull();
    expect(local.reranker()).toBeNull();
    await expect(local.download("emb")).rejects.toThrow(/cannot run/);
    expect(local.models().map((model) => model.state)).toEqual(["ready", "ready"]);
  });

  it("turns unavailable, and says so, when the runtime fails to load", async () => {
    const dir = tempDir();
    installModels(path.join(dir, "memory-models"));
    let changed = 0;
    const local = createLocalModels({
      dataDir: dir,
      env: {},
      models: [EMB, RR],
      runtimePresent: () => true,
      loadRuntime: async () => {
        throw new Error("dlopen failed: onnxruntime_binding.node");
      },
      loadTokenizer: async () => fakeTokenizer,
      onChange: () => (changed += 1),
    });
    const provider = local.embedding(3)!;
    await expect(provider.embed(["a"], "document")).rejects.toThrow(/dlopen failed/);
    expect(local.available()).toBe(false);
    expect(local.embedding(3)).toBeNull();
    expect(changed).toBeGreaterThan(0);
  });

  it("reports absent models, a folder override, and no provider until a model is ready", () => {
    const dir = tempDir();
    const override = tempDir();
    installModels(override, ["rr"]);
    const local = createLocalModels({
      dataDir: dir,
      env: { OD_MEMORY_MODELS_DIR: override },
      models: [EMB, RR],
      runtimePresent: () => true,
    });
    expect(local.models()).toEqual([
      expect.objectContaining({ id: "emb", role: "embedding", state: "absent", progress: 0, error: null }),
      expect.objectContaining({ id: "rr", role: "reranker", state: "ready", progress: 1, license: "Apache-2.0" }),
    ]);
    expect(local.models()[0]!.sizeBytes).toBe(EMB.files.reduce((sum, file) => sum + file.bytes, 0));
    expect(local.embedding(3)).toBeNull();
    expect(local.reranker()).not.toBeNull();
  });

  it("pins the shipped registry to verified files", () => {
    for (const spec of LOCAL_MODELS) {
      expect(spec.license).toBe("Apache-2.0");
      expect(spec.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(spec.files.map((file) => file.path)).toEqual(
        expect.arrayContaining([spec.onnx, spec.tokenizer, spec.tokenizerConfig]),
      );
      for (const file of spec.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.bytes).toBeGreaterThan(0);
      }
    }
    expect(LOCAL_MODELS.map((spec) => spec.role).sort()).toEqual(["embedding", "reranker"]);
  });
});

// ---- download ----------------------------------------------------------------------------------------------------

interface ServeOptions {
  ignoreRange?: boolean;
  /** Stop the stream (with an error) after this many bytes of the matching file. */
  breakAfter?: { file: string; bytes: number };
  /** Hold the stream of the matching file until `release` resolves. */
  hold?: { file: string; release: Promise<void> };
  corrupt?: string;
}

function fakeHub(options: ServeOptions = {}) {
  const requests: Array<{ url: string; range: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, range: headers.get("range") });
    const match = /\/test\/(emb|rr)\/resolve\/rev\d\/(.+)$/.exec(url);
    const key = match ? `${match[1]}/${match[2]}` : "";
    let data = CONTENT[key];
    if (!data) return new Response("missing", { status: 404 });
    if (options.corrupt === key) data = Buffer.concat([data.subarray(0, data.length - 1), Buffer.from("!")]);
    const range = /^bytes=(\d+)-$/.exec(headers.get("range") ?? "");
    const start = range && !options.ignoreRange ? Number(range[1]) : 0;
    const body = data.subarray(start);
    const breakAt = options.breakAfter?.file === key ? options.breakAfter.bytes : null;
    const hold = options.hold?.file === key ? options.hold.release : null;
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const first = breakAt === null ? body : body.subarray(0, breakAt);
        controller.enqueue(new Uint8Array(first.subarray(0, Math.ceil(first.length / 2))));
        if (hold) {
          await Promise.race([
            hold,
            new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true })),
          ]);
          if (signal?.aborted) return controller.error(signal.reason);
        }
        controller.enqueue(new Uint8Array(first.subarray(Math.ceil(first.length / 2))));
        if (breakAt === null) return controller.close();
        // The connection drops after what was received reached the disk.
        await new Promise((resolve) => setTimeout(resolve, 30));
        controller.error(new Error("connection reset"));
      },
    });
    return start > 0
      ? new Response(stream, {
          status: 206,
          headers: { "content-range": `bytes ${start}-${data.length - 1}/${data.length}` },
        })
      : new Response(stream, { status: 200, headers: { "content-length": String(data.length) } });
  };
  return { fetchImpl, requests };
}

describe("local models — download", () => {
  it("downloads every file from the pinned revision, verifies it and makes the model ready", async () => {
    const dir = tempDir();
    const hub = fakeHub();
    const watch = changes();
    const local = runtime(dir, fakeOrt().module, {
      fetch: hub.fetchImpl,
      env: { OD_MEMORY_MODEL_BASE_URL: "https://mirror.example/" },
      onChange: watch.onChange,
    });
    expect(local.embedding(3)).toBeNull();
    await local.download("emb");
    expect(local.models()[0]!.state).toBe("downloading");
    await watch.until(() => local.models()[0]!.state === "ready");
    expect(hub.requests.map((request) => request.url)).toEqual(
      EMB.files.map((file) => `https://mirror.example/test/emb/resolve/rev1/${file.path}`),
    );
    for (const file of EMB.files) {
      expect(readFileSync(path.join(dir, "memory-models", "emb", file.path))).toEqual(CONTENT[`emb/${file.path}`]);
      expect(existsSync(path.join(dir, "memory-models", "emb", `${file.path}.partial`))).toBe(false);
    }
    expect(local.models()[0]).toMatchObject({ state: "ready", progress: 1, error: null });
    expect(local.embedding(3)).not.toBeNull();
  });

  it("resumes a broken download with a Range request", async () => {
    const dir = tempDir();
    const target = "emb/onnx/model.onnx";
    const broken = fakeHub({ breakAfter: { file: target, bytes: 1000 } });
    const watch = changes();
    const first = runtime(dir, fakeOrt().module, { fetch: broken.fetchImpl, onChange: watch.onChange });
    await first.download("emb");
    await watch.until(() => first.models()[0]!.state === "failed");
    const partial = path.join(dir, "memory-models", "emb", "onnx", "model.onnx.partial");
    expect(statSync(partial).size).toBe(1000);
    expect(first.models()[0]!.error).toMatch(/connection reset|stopped early/);

    const hub = fakeHub();
    const again = changes();
    const second = runtime(dir, fakeOrt().module, { fetch: hub.fetchImpl, onChange: again.onChange });
    await second.download("emb");
    await again.until(() => second.models()[0]!.state === "ready");
    expect(hub.requests[0]).toMatchObject({ range: "bytes=1000-" });
    expect(readFileSync(path.join(dir, "memory-models", "emb", "onnx", "model.onnx"))).toEqual(CONTENT[target]);
  });

  it("starts over when the server ignores the Range header", async () => {
    const dir = tempDir();
    const file = path.join(dir, "memory-models", "emb", "tokenizer.json.partial");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "xx");
    const hub = fakeHub({ ignoreRange: true });
    const watch = changes();
    const local = runtime(dir, fakeOrt().module, { fetch: hub.fetchImpl, onChange: watch.onChange });
    await local.download("emb");
    await watch.until(() => local.models()[0]!.state === "ready");
    expect(hub.requests.find((request) => request.url.endsWith("/tokenizer.json"))).toMatchObject({ range: "bytes=2-" });
    expect(readFileSync(path.join(dir, "memory-models", "emb", "tokenizer.json"))).toEqual(CONTENT["emb/tokenizer.json"]);
  });

  it("never leaves a file that fails its checksum, and reports the failure", async () => {
    const dir = tempDir();
    const hub = fakeHub({ corrupt: "emb/tokenizer.json" });
    const watch = changes();
    const local = runtime(dir, fakeOrt().module, { fetch: hub.fetchImpl, onChange: watch.onChange });
    await local.download("emb");
    await watch.until(() => local.models()[0]!.state === "failed");
    const folder = path.join(dir, "memory-models", "emb");
    expect(existsSync(path.join(folder, "tokenizer.json"))).toBe(false);
    expect(existsSync(path.join(folder, "tokenizer.json.partial"))).toBe(false);
    expect(local.models()[0]!.error).toMatch(/checksum/);
    expect(local.embedding(3)).toBeNull();
  });

  it("cancels: the partial file stays for the next attempt and the model is not ready", async () => {
    const dir = tempDir();
    let release!: () => void;
    const hub = fakeHub({ hold: { file: "emb/onnx/model.onnx", release: new Promise((resolve) => (release = resolve)) } });
    const watch = changes();
    const local = runtime(dir, fakeOrt().module, { fetch: hub.fetchImpl, onChange: watch.onChange });
    await local.download("emb");
    await local.download("emb");
    const partial = path.join(dir, "memory-models", "emb", "onnx", "model.onnx.partial");
    for (let i = 0; i < 200 && !(existsSync(partial) && statSync(partial).size > 0); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(local.models()[0]).toMatchObject({ state: "downloading" });
    expect(local.models()[0]!.progress).toBeGreaterThan(0);
    local.cancel("emb");
    await watch.until(() => local.models()[0]!.state !== "downloading");
    release();
    expect(local.models()[0]).toMatchObject({ state: "absent", error: null });
    expect(statSync(partial).size).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, "memory-models", "emb", "onnx", "model.onnx"))).toBe(false);
    expect(hub.requests.filter((request) => request.url.endsWith("model.onnx"))).toHaveLength(1);
  });

  it("refuses an unknown model and a runtime without a folder", async () => {
    const local = createLocalModels({ dataDir: "", env: {}, models: [EMB, RR], runtimePresent: () => true });
    await expect(local.download("nope")).rejects.toThrow(/Unknown local model/);
    await expect(local.download("emb")).rejects.toThrow(/no folder/);
    expect(() => local.cancel("nope")).toThrow(/Unknown local model/);
  });
});

// ---- providers and engine ----------------------------------------------------------------------------------------

/** A runtime whose embedding becomes ready when `ready` flips. */
function fakeRuntime(options: { available?: boolean } = {}) {
  const calls: string[] = [];
  let ready = false;
  const embedded: string[] = [];
  const embedding: EmbeddingProvider = {
    modelId: "local:fake:4",
    remote: false,
    async embed(texts) {
      embedded.push(...texts);
      return texts.map(() => Float32Array.of(1, 0, 0, 0));
    },
  };
  const reranker: RerankProvider = { id: "local:fake-rr", remote: false, rerank: async (_q, docs) => docs.map(() => 0.5) };
  const bySize = new Map<number, EmbeddingProvider>();
  const sized = (dimensions: number): EmbeddingProvider => {
    const known = bySize.get(dimensions) ?? { ...embedding, modelId: `local:fake:${dimensions}` };
    bySize.set(dimensions, known);
    return known;
  };
  const local: MemoryLocalRuntime = {
    available: () => options.available ?? true,
    models: () => [
      { id: "fake", role: "embedding", name: "Fake", sizeBytes: 10, license: "Apache-2.0", state: ready ? "ready" : "absent", progress: ready ? 1 : 0, error: null },
    ],
    download: async (id) => {
      calls.push(`download:${id}`);
    },
    cancel: (id) => calls.push(`cancel:${id}`),
    embedding: (dimensions) => (ready ? sized(dimensions) : null),
    reranker: () => (ready ? reranker : null),
    dispose: () => calls.push("dispose"),
  };
  return { local, calls, embedded, makeReady: () => (ready = true) };
}

describe("local models — providers and engine", () => {
  it("builds the local providers from the runtime, and nothing without one", () => {
    const { local, makeReady } = fakeRuntime();
    const config = {
      ...MEMORY_ENGINE_DEFAULTS,
      embedding: { ...MEMORY_ENGINE_DEFAULTS.embedding, provider: "local" as const, dimensions: 256 },
      reranker: { ...MEMORY_ENGINE_DEFAULTS.reranker, provider: "local" as const },
    };
    const keys = { embeddingApiKey: "", rerankerApiKey: "", judgeApiKey: "" };
    const deps = { env: {}, fetch: globalThis.fetch, llm: null };
    expect(buildProviders(config, keys, { ...deps, local })).toMatchObject({ embedding: null, reranker: null });
    makeReady();
    const built = buildProviders(config, keys, { ...deps, local });
    expect(built.embedding).toMatchObject({ modelId: "local:fake:256", remote: false });
    expect(built.reranker).toMatchObject({ id: "local:fake-rr", remote: false });
    expect(buildProviders(config, keys, deps)).toMatchObject({ embedding: null, reranker: null });
  });

  it("rebuilds the cached providers when a local model becomes ready", () => {
    const { local, makeReady } = fakeRuntime();
    const meta = new Map<string, string>();
    const settings = new MemoryConfig({ getMeta: (key) => meta.get(key) ?? null, setMeta: (key, value) => meta.set(key, value), env: {} });
    settings.update({ embedding: { provider: "local" } });
    const before = settings.providers(null, local);
    expect(before.embedding).toBeNull();
    expect(settings.providers(null, local)).toBe(before);
    makeReady();
    expect(settings.providers(null, local).embedding?.modelId).toBe("local:fake:0");
  });

  it("reports the runtime in status, forwards model actions, and refuses what it cannot do", async () => {
    const { local, calls } = fakeRuntime();
    const engine = createMemoryEngine({ db: new Database(":memory:"), dataDir: "", local });
    expect(engine.status()).toMatchObject({ localRuntime: true, localModels: [expect.objectContaining({ id: "fake" })] });
    await engine.localModelAction("fake", "download");
    await engine.localModelAction("fake", "cancel");
    expect(calls).toEqual(["download:fake", "cancel:fake"]);
    await expect(engine.localModelAction("nope", "download")).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND", status: 404 });
    engine.dispose();
    expect(calls).toContain("dispose");

    const unavailable = fakeRuntime({ available: false });
    const other = createMemoryEngine({ db: new Database(":memory:"), dataDir: "", local: unavailable.local });
    expect(other.status().localRuntime).toBe(false);
    await expect(other.localModelAction("fake", "download")).rejects.toMatchObject({ code: "MEMORY_INVALID", status: 409 });
    other.dispose();

    const none = createMemoryEngine({ db: new Database(":memory:"), dataDir: "", local: null });
    expect(none.status()).toMatchObject({ localRuntime: false, localModels: [] });
    none.dispose();
  });

  it("embeds what was waiting once the local model becomes ready", async () => {
    const { local, embedded, makeReady } = fakeRuntime();
    const engine = createMemoryEngine({ db: new Database(":memory:"), dataDir: "", local });
    engine.updateConfig({ embedding: { provider: "local", dimensions: 4 } });
    engine.remember({ scope: { kind: "profile", id: "" }, content: "回复用中文", actor: "owner" });
    await engine.flush();
    expect(engine.status()).toMatchObject({ level: "lexical", embedding: { ready: false } });
    expect(embedded).toEqual([]);
    makeReady();
    expect(engine.status().embedding).toMatchObject({ provider: "local", ready: true });
    await new Promise((resolve) => setImmediate(resolve));
    await engine.flush();
    expect(embedded).toEqual(["回复用中文"]);
    expect(engine.status()).toMatchObject({ level: "hybrid", embedding: { indexed: 1, waiting: 0 } });
    engine.dispose();
  });

  it("creates its own runtime under the data folder when none is passed", () => {
    const dir = tempDir();
    const engine = createMemoryEngine({ db: new Database(":memory:"), dataDir: dir });
    expect(engine.status().localModels.map((model) => model.id)).toEqual(LOCAL_MODELS.map((spec) => spec.id));
    if (!process.env.OD_MEMORY_MODELS_DIR) {
      expect(engine.status().localModels.every((model) => model.state === "absent")).toBe(true);
    }
    engine.dispose();
  });
});

// ---- the real models (only when they are on disk) ----------------------------------------------------------------

const MODELS_DIR = process.env.OD_MEMORY_MODELS_DIR;

describe.skipIf(!MODELS_DIR)("local models — the real files", () => {
  it("embeds and reranks Chinese text sensibly on this machine", { timeout: 120_000 }, async () => {
    const local = createLocalModels({ dataDir: "", env: { OD_MEMORY_MODELS_DIR: MODELS_DIR } });
    expect(local.available()).toBe(true);
    expect(local.models().map((model) => model.state)).toEqual(["ready", "ready"]);
    const embedding = local.embedding(0)!;
    expect(embedding.modelId).toBe("local:qwen3-embedding-0.6b:512");
    const docs = ["用户最喜欢的颜色是青绿色。", "部署脚本在 scripts/deploy.sh。", "周三下午和设计团队开评审会。"];
    const vectors = await embedding.embed(docs, "document");
    const [query] = await embedding.embed(["我喜欢什么颜色？"], "query");
    const cos = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);
    for (const vector of vectors) {
      expect(vector).toHaveLength(512);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 4);
    }
    expect(cos(query!, vectors[0]!)).toBeGreaterThan(cos(query!, vectors[1]!) + 0.1);
    const alone = (await embedding.embed([docs[2]!], "document"))[0]!;
    expect(cos(alone, vectors[2]!)).toBeGreaterThan(0.9999);

    const reranker = local.reranker()!;
    const [capital] = await reranker.rerank("中国的首都在哪儿", ["北京"]);
    // The model card's logit is 1.2315 (sigmoid 0.774); the int8 export gives about 1.12.
    expect(capital!).toBeGreaterThan(0.7);
    const [relevant, unrelated] = await reranker.rerank("我喜欢什么颜色？", [docs[0]!, docs[1]!]);
    expect(relevant!).toBeGreaterThan(unrelated! + 0.2);
    local.dispose();
  });
});
