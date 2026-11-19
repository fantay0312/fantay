// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — models that run on this machine, so nothing leaves it:
//   embedding  Qwen3-Embedding-0.6B, int8 ONNX export (last-token pooling, L2 norm, Matryoshka truncation)
//   reranker   gte-multilingual-reranker-base, int8 ONNX export (one logit per query–document pair, sigmoid)
// Both are Apache-2.0. They run on onnxruntime-node and are tokenized with @huggingface/tokenizers; both libraries
// are loaded lazily, and when either cannot load, `available()` turns false and the engine stays at the levels it
// can reach without them.
//
// Files are downloaded once into <dataDir>/memory-models/<id>/ (`OD_MEMORY_MODELS_DIR` overrides the folder) from
// https://huggingface.co/<repo>/resolve/<revision>/<path> (`OD_MEMORY_MODEL_BASE_URL` overrides the host for a
// mirror). A file is written as `<path>.partial`, resumed with a Range request, and renamed to its final name only
// after its sha256 matched, so a model that looks ready on disk was verified when it arrived.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MemoryLocalModel } from "@open-design/contracts";
import { QWEN3_QUERY_INSTRUCTION, toUnitVector } from "./providers.js";
import type { EmbeddingProvider, MemoryLocalRuntime, RerankProvider } from "./types.js";

// ---- registry ----------------------------------------------------------------------------------------------------

export interface LocalModelFile {
  /** Path inside the repository; also the path under the model's folder. */
  path: string;
  bytes: number;
  sha256: string;
}

interface LocalModelBase {
  id: string;
  name: string;
  license: string;
  repo: string;
  /** Pinned commit, so the hashes below always describe what is served. */
  revision: string;
  files: readonly LocalModelFile[];
  onnx: string;
  tokenizer: string;
  tokenizerConfig: string;
  /** Name of the output read from a run. */
  output: string;
  /** Longest token sequence one document (or query–document pair) is cut to. */
  maxTokens: number;
  /** Longest query, in tokens. */
  queryMaxTokens: number;
}

export interface LocalEmbeddingSpec extends LocalModelBase {
  role: "embedding";
  /** Appended after truncation; the hidden state at this token is the embedding (last-token pooling). */
  eosId: number;
  /** Shape of the empty KV cache a decoder export expects for a single forward pass. */
  kvHeads: number;
  headDim: number;
  /** Matryoshka size used when the configuration says 0. */
  defaultDimensions: number;
  queryPrefix: string;
}

export interface LocalRerankerSpec extends LocalModelBase {
  role: "reranker";
  clsId: number;
  sepId: number;
}

export type LocalModelSpec = LocalEmbeddingSpec | LocalRerankerSpec;

/** The verified files: sizes and sha256 checked against the copies served at these revisions on 2026-11-16. */
export const LOCAL_MODELS: readonly LocalModelSpec[] = [
  {
    id: "qwen3-embedding-0.6b",
    role: "embedding",
    name: "Qwen3 Embedding 0.6B",
    license: "Apache-2.0",
    repo: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
    revision: "c25a394dd583836952667c12f008335071b3f43d",
    files: [
      {
        path: "onnx/model_int8.onnx",
        bytes: 613_527_539,
        sha256: "6d0ea863f78b4a84afa3c7fcba1ec341572b5e28121aef77b7092b1dfdf679c7",
      },
      {
        path: "tokenizer.json",
        bytes: 11_423_705,
        sha256: "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a",
      },
      {
        path: "tokenizer_config.json",
        bytes: 9_731,
        sha256: "977648852447cb6587327ff3205b0a84cf2fc9f05621d6c8e88a497caafab2e1",
      },
    ],
    onnx: "onnx/model_int8.onnx",
    tokenizer: "tokenizer.json",
    tokenizerConfig: "tokenizer_config.json",
    output: "last_hidden_state",
    maxTokens: 512,
    queryMaxTokens: 256,
    eosId: 151_643,
    kvHeads: 8,
    headDim: 128,
    defaultDimensions: 512,
    queryPrefix: QWEN3_QUERY_INSTRUCTION,
  },
  {
    id: "gte-multilingual-reranker-base",
    role: "reranker",
    name: "GTE Multilingual Reranker Base",
    license: "Apache-2.0",
    repo: "onnx-community/gte-multilingual-reranker-base",
    revision: "ee64367e35a2db0da46bb6497e13a18f8bd585cb",
    files: [
      {
        path: "onnx/model_int8.onnx",
        bytes: 340_858_200,
        sha256: "ccf51dba7f8aa9205753761cfaa68c55f741792501463a3bf25d7e5bcdac7c35",
      },
      {
        path: "tokenizer.json",
        bytes: 17_082_999,
        sha256: "3ffb37461c391f096759f4a9bbbc329da0f36952f88bab061fcf84940c022e98",
      },
      {
        path: "tokenizer_config.json",
        bytes: 1_340,
        sha256: "6f00514620aff01ba8b7291b2394e98daca5be264cb743805232d9ae27494b2a",
      },
    ],
    onnx: "onnx/model_int8.onnx",
    tokenizer: "tokenizer.json",
    tokenizerConfig: "tokenizer_config.json",
    output: "logits",
    maxTokens: 256,
    queryMaxTokens: 64,
    clsId: 0,
    sepId: 2,
  },
];

export const DEFAULT_MODEL_BASE_URL = "https://huggingface.co";
const MODELS_FOLDER = "memory-models";
const PARTIAL_SUFFIX = ".partial";
const ERROR_MAX_CHARS = 300;

// ---- inference seams ---------------------------------------------------------------------------------------------

/** The part of an onnxruntime tensor this module reads. */
export interface OrtTensorLike {
  readonly data: unknown;
  readonly dims: readonly number[];
}

/** The part of an onnxruntime `InferenceSession` this module uses. */
export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  run(feeds: Record<string, unknown>, fetches: readonly string[]): Promise<Record<string, OrtTensorLike>>;
  release(): Promise<void>;
}

/** The part of the onnxruntime-node module this module uses. */
export interface OrtModuleLike {
  InferenceSession: { create(file: string, options: Record<string, unknown>): Promise<OrtSessionLike> };
  Tensor: new (type: "int64" | "float32", data: BigInt64Array | Float32Array, dims: readonly number[]) => unknown;
}

export interface LocalTokenizer {
  encode(text: string, options: { add_special_tokens: boolean }): { ids: readonly number[] };
}

export interface LocalModelsDeps {
  /** Daemon data root; models live under `<dataDir>/memory-models` unless `OD_MEMORY_MODELS_DIR` is set. */
  dataDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  fetch?: typeof fetch | undefined;
  /** A model was downloaded, failed, was cancelled, or the runtime turned out to be unusable. */
  onChange?: (() => void) | undefined;
  /** Test seams. Defaults: onnxruntime-node and @huggingface/tokenizers, loaded on first use. */
  runtimePresent?: (() => boolean) | undefined;
  loadRuntime?: (() => Promise<OrtModuleLike>) | undefined;
  loadTokenizer?: ((tokenizerJson: string, configJson: string) => Promise<LocalTokenizer>) | undefined;
  models?: readonly LocalModelSpec[] | undefined;
  threads?: number | undefined;
}

// ---- small helpers -----------------------------------------------------------------------------------------------

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, ERROR_MAX_CHARS) || "Unknown error";
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function totalBytes(spec: LocalModelSpec): number {
  return spec.files.reduce((sum, file) => sum + file.bytes, 0);
}

function sizeOfSync(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function defaultThreads(): number {
  // Two to four threads: enough for an interactive query, while the rest of the desktop stays responsive.
  return Math.min(4, Math.max(2, Math.floor(os.availableParallelism() / 2)));
}

function moduleResolvable(name: string): boolean {
  try {
    createRequire(import.meta.url).resolve(name);
    return true;
  } catch {
    return false;
  }
}

async function loadOnnxRuntime(): Promise<OrtModuleLike> {
  const loaded = (await import("onnxruntime-node")) as unknown as OrtModuleLike & { default?: OrtModuleLike };
  return typeof loaded.InferenceSession?.create === "function" ? loaded : (loaded.default as OrtModuleLike);
}

async function loadHfTokenizer(tokenizerJson: string, configJson: string): Promise<LocalTokenizer> {
  const { Tokenizer } = await import("@huggingface/tokenizers");
  return new Tokenizer(JSON.parse(tokenizerJson) as object, JSON.parse(configJson) as object) as LocalTokenizer;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function floatData(tensor: OrtTensorLike | undefined, name: string): Float32Array {
  if (!tensor || !(tensor.data instanceof Float32Array)) throw new Error(`model output ${name} is missing`);
  return tensor.data;
}

// ---- one job at a time, queries first ----------------------------------------------------------------------------

type Lane = "query" | "background";

/**
 * Both models share the CPU, and a forward pass cannot be interrupted. Jobs run one at a time; a waiting query
 * (recall's question embedding or rerank) starts before any waiting background batch, so a large backfill delays a
 * turn by at most one batch.
 */
class JobQueue {
  private readonly lanes: Record<Lane, Array<() => void>> = { query: [], background: [] };
  private busy = false;

  run<T>(lane: Lane, job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.lanes[lane].push(() => {
        // Started inside a promise chain: a job that throws before it returns its promise (its caller gave up
        // while it waited its turn) must reject that caller and free the queue, not escape as an unhandled error
        // that takes the process down and leaves every later job waiting.
        void Promise.resolve()
          .then(job)
          .then(resolve, reject)
          .finally(() => {
            this.busy = false;
            this.next();
          });
      });
      this.next();
    });
  }

  private next(): void {
    if (this.busy) return;
    const start = this.lanes.query.shift() ?? this.lanes.background.shift();
    if (!start) return;
    this.busy = true;
    start();
  }
}

// ---- runtime -----------------------------------------------------------------------------------------------------

interface DownloadJob {
  controller: AbortController;
  received: number;
}

interface Loaded {
  session: OrtSessionLike;
  tokenizer: LocalTokenizer;
}

class LocalModels implements MemoryLocalRuntime {
  private readonly specs: readonly LocalModelSpec[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly dir: string | null;
  private readonly threads: number;
  private readonly ready = new Map<string, boolean>();
  private readonly failures = new Map<string, string>();
  private readonly downloads = new Map<string, DownloadJob>();
  private readonly loaded = new Map<string, Promise<Loaded>>();
  private readonly embedders = new Map<number, EmbeddingProvider>();
  private rerankProvider: RerankProvider | null = null;
  private readonly jobs = new JobQueue();
  private runtime: Promise<OrtModuleLike> | null = null;
  private present: boolean | null = null;
  private runtimeError: string | null = null;
  private disposed = false;

  constructor(private readonly deps: LocalModelsDeps) {
    this.specs = deps.models ?? LOCAL_MODELS;
    this.env = deps.env ?? process.env;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.threads = deps.threads ?? defaultThreads();
    const override = this.env.OD_MEMORY_MODELS_DIR?.trim();
    this.dir = override ? path.resolve(override) : deps.dataDir ? path.join(deps.dataDir, MODELS_FOLDER) : null;
    for (const spec of this.specs) this.ready.set(spec.id, this.filesPresent(spec));
  }

  available(): boolean {
    if (this.runtimeError !== null || this.disposed) return false;
    // Only the native ONNX runtime can be missing: installers leave it out of the daemon bundle (it ships
    // platform binaries), while the tokenizer is plain JavaScript and is bundled with the daemon.
    this.present ??= this.deps.runtimePresent ? this.deps.runtimePresent() : moduleResolvable("onnxruntime-node");
    return this.present;
  }

  models(): MemoryLocalModel[] {
    return this.specs.map((spec) => {
      const job = this.downloads.get(spec.id);
      const ready = this.ready.get(spec.id) === true;
      const failure = this.failures.get(spec.id) ?? null;
      const state: MemoryLocalModel["state"] = job ? "downloading" : ready ? "ready" : failure ? "failed" : "absent";
      const size = totalBytes(spec);
      return {
        id: spec.id,
        role: spec.role,
        name: spec.name,
        sizeBytes: size,
        license: spec.license,
        state,
        progress: job ? Math.min(1, job.received / size) : ready ? 1 : 0,
        error: state === "failed" ? failure : null,
      };
    });
  }

  async download(id: string): Promise<void> {
    const spec = this.spec(id);
    if (this.disposed) throw new Error("The local model runtime was stopped.");
    if (!this.available()) throw new Error("Local models cannot run in this build.");
    if (!this.dir) throw new Error("There is no folder to keep local models in.");
    if (this.downloads.has(id) || this.ready.get(id)) return;
    const job: DownloadJob = { controller: new AbortController(), received: 0 };
    this.downloads.set(id, job);
    this.failures.delete(id);
    this.changed();
    void this.fetchModel(spec, this.dir, job).then(
      () => {
        this.ready.set(id, true);
        this.finishDownload(id);
      },
      (error: unknown) => {
        if (!job.controller.signal.aborted) this.failures.set(id, describe(error));
        this.finishDownload(id);
      },
    );
  }

  cancel(id: string): void {
    this.spec(id);
    this.downloads.get(id)?.controller.abort();
  }

  embedding(dimensions: number): EmbeddingProvider | null {
    const spec = this.specs.find((s): s is LocalEmbeddingSpec => s.role === "embedding");
    if (!spec || !this.usable(spec)) return null;
    const size = dimensions > 0 ? dimensions : spec.defaultDimensions;
    let provider = this.embedders.get(size);
    if (!provider) {
      provider = {
        modelId: `local:${spec.id}:${size}`,
        remote: false,
        embed: (texts, kind, signal) => this.embed(spec, size, texts, kind, signal),
      };
      this.embedders.set(size, provider);
    }
    return provider;
  }

  reranker(): RerankProvider | null {
    const spec = this.specs.find((s): s is LocalRerankerSpec => s.role === "reranker");
    if (!spec || !this.usable(spec)) return null;
    this.rerankProvider ??= {
      id: `local:${spec.id}`,
      remote: false,
      rerank: (query, documents, signal) => this.rerank(spec, query, documents, signal),
    };
    return this.rerankProvider;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.downloads.values()) job.controller.abort();
    for (const pending of this.loaded.values()) {
      void pending.then(
        (loaded) => loaded.session.release(),
        () => undefined,
      );
    }
    this.loaded.clear();
  }

  // ---- files -------------------------------------------------------------------------------------------------

  private spec(id: string): LocalModelSpec {
    const spec = this.specs.find((candidate) => candidate.id === id);
    if (!spec) throw new Error(`Unknown local model: ${id}`);
    return spec;
  }

  private usable(spec: LocalModelSpec): boolean {
    return this.ready.get(spec.id) === true && this.available();
  }

  private fileOf(spec: LocalModelSpec, relative: string): string {
    return path.join(this.dir ?? "", spec.id, relative);
  }

  /** Every file is in place with its exact size; files only get their final name after their hash matched. */
  private filesPresent(spec: LocalModelSpec): boolean {
    if (!this.dir) return false;
    return spec.files.every((file) => sizeOfSync(this.fileOf(spec, file.path)) === file.bytes);
  }

  private urlOf(spec: LocalModelSpec, file: LocalModelFile): string {
    const base = (this.env.OD_MEMORY_MODEL_BASE_URL?.trim() || DEFAULT_MODEL_BASE_URL).replace(/\/+$/, "");
    return `${base}/${spec.repo}/resolve/${spec.revision}/${file.path}`;
  }

  private async fetchModel(spec: LocalModelSpec, dir: string, job: DownloadJob): Promise<void> {
    let done = 0;
    for (const file of spec.files) {
      const target = path.join(dir, spec.id, file.path);
      if ((await sizeOf(target)) !== file.bytes) {
        await this.fetchFile(spec, file, target, (bytes) => {
          job.received = done + bytes;
        }, job.controller.signal);
      }
      done += file.bytes;
      job.received = done;
    }
  }

  /** Downloads one file into `<target>.partial`, resuming what is there, then verifies and renames it. */
  private async fetchFile(
    spec: LocalModelSpec,
    file: LocalModelFile,
    target: string,
    progress: (bytes: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const partial = target + PARTIAL_SUFFIX;
    await mkdir(path.dirname(target), { recursive: true });
    let start = (await sizeOf(partial)) ?? 0;
    if (start > file.bytes) {
      await rm(partial, { force: true });
      start = 0;
    }
    if (start < file.bytes) {
      const url = this.urlOf(spec, file);
      const response = await this.fetchImpl(url, {
        headers: start > 0 ? { range: `bytes=${start}-` } : {},
        redirect: "follow",
        signal,
      });
      const resumed = start > 0 && response.status === 206 && rangeStart(response) === start;
      if (!resumed && response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Downloading ${spec.name} failed with HTTP ${response.status}.`);
      }
      if (!response.body) throw new Error(`Downloading ${spec.name} returned no data.`);
      let written = resumed ? start : 0;
      progress(written);
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.byteLength;
          progress(written);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        meter,
        createWriteStream(partial, { flags: resumed ? "a" : "w" }),
        { signal },
      );
    }
    const size = await sizeOf(partial);
    if (size !== file.bytes) {
      if ((size ?? 0) > file.bytes) await rm(partial, { force: true });
      throw new Error(`Downloading ${spec.name} stopped early (${size ?? 0} of ${file.bytes} bytes).`);
    }
    if ((await sha256Of(partial)) !== file.sha256) {
      // A wrong file is never resumed from: the next attempt starts over.
      await rm(partial, { force: true });
      throw new Error(`${spec.name}: ${file.path} did not match its checksum.`);
    }
    await rename(partial, target);
  }

  private finishDownload(id: string): void {
    this.downloads.delete(id);
    this.changed();
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch {
      // A status listener must not break a download.
    }
  }

  // ---- inference ---------------------------------------------------------------------------------------------

  private ort(): Promise<OrtModuleLike> {
    this.runtime ??= (this.deps.loadRuntime ?? loadOnnxRuntime)().catch((error: unknown) => {
      this.runtimeError = describe(error);
      this.changed();
      throw error;
    });
    return this.runtime;
  }

  private load(spec: LocalModelSpec): Promise<Loaded> {
    let pending = this.loaded.get(spec.id);
    if (!pending) {
      pending = (async () => {
        const ort = await this.ort();
        const [tokenizerJson, configJson] = await Promise.all([
          readFile(this.fileOf(spec, spec.tokenizer), "utf8"),
          readFile(this.fileOf(spec, spec.tokenizerConfig), "utf8"),
        ]);
        const tokenizer = await (this.deps.loadTokenizer ?? loadHfTokenizer)(tokenizerJson, configJson);
        const session = await ort.InferenceSession.create(this.fileOf(spec, spec.onnx), {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
          intraOpNumThreads: this.threads,
          interOpNumThreads: 1,
        });
        if (this.disposed) {
          await session.release();
          throw new Error("The local model runtime was stopped.");
        }
        return { session, tokenizer };
      })();
      // A failed load is retried on the next call instead of being remembered forever.
      pending.catch(() => {
        if (this.loaded.get(spec.id) === pending) this.loaded.delete(spec.id);
      });
      this.loaded.set(spec.id, pending);
    }
    return pending;
  }

  private async embed(
    spec: LocalEmbeddingSpec,
    dimensions: number,
    texts: readonly string[],
    kind: "query" | "document",
    signal: AbortSignal | undefined,
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    throwIfAborted(signal);
    const { session, tokenizer } = await this.load(spec);
    const ort = await this.ort();
    const prefix = kind === "query" ? spec.queryPrefix : "";
    const limit = (kind === "query" ? spec.queryMaxTokens : spec.maxTokens) - 1;
    const lane: Lane = kind === "query" ? "query" : "background";
    const out: Float32Array[] = [];
    for (const text of texts) {
      const row = [...tokenizer.encode(prefix + text, { add_special_tokens: false }).ids.slice(0, limit), spec.eosId];
      out.push(
        await this.jobs.run(lane, () => {
          throwIfAborted(signal);
          return embedOne(ort, session, spec, row, dimensions);
        }),
      );
    }
    return out;
  }

  private async rerank(
    spec: LocalRerankerSpec,
    query: string,
    documents: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<number[]> {
    if (documents.length === 0) return [];
    throwIfAborted(signal);
    const { session, tokenizer } = await this.load(spec);
    const ort = await this.ort();
    const question = tokenizer.encode(query, { add_special_tokens: false }).ids.slice(0, spec.queryMaxTokens);
    // <s> query </s></s> document </s>, the pair template of this tokenizer.
    const room = Math.max(1, spec.maxTokens - question.length - 4);
    const out: number[] = [];
    for (const doc of documents) {
      const row = [
        spec.clsId,
        ...question,
        spec.sepId,
        spec.sepId,
        ...tokenizer.encode(doc, { add_special_tokens: false }).ids.slice(0, room),
        spec.sepId,
      ];
      out.push(
        await this.jobs.run("query", () => {
          throwIfAborted(signal);
          return rerankOne(ort, session, spec, row);
        }),
      );
    }
    return out;
  }
}

function rangeStart(response: Response): number | null {
  const match = /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i.exec(response.headers.get("content-range")?.trim() ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Inputs for one sequence. Each document runs on its own: the int8 exports quantize activations with one range per
 * run, so a batch partner changes a document's vector (cosine 0.94 against the same text run alone) and its rerank
 * score, and on CPU a batch of 8 was no faster than 8 single runs (175 ms vs 181 ms, measured).
 */
function feedsFor(
  ort: OrtModuleLike,
  session: OrtSessionLike,
  row: readonly number[],
  cache: { kvHeads: number; headDim: number } | null,
): Record<string, unknown> {
  const dims = [1, row.length];
  const ids = BigInt64Array.from(row, (id) => BigInt(id));
  const feeds: Record<string, unknown> = {};
  for (const name of session.inputNames) {
    if (name === "input_ids") feeds[name] = new ort.Tensor("int64", ids, dims);
    else if (name === "attention_mask") feeds[name] = new ort.Tensor("int64", new BigInt64Array(row.length).fill(1n), dims);
    else if (name === "position_ids") {
      feeds[name] = new ort.Tensor("int64", BigInt64Array.from(row, (_, i) => BigInt(i)), dims);
    } else if (name === "token_type_ids") feeds[name] = new ort.Tensor("int64", new BigInt64Array(row.length), dims);
    else if (name.startsWith("past_key_values.") && cache) {
      // A single forward pass over the whole input: the cache of earlier tokens is empty.
      feeds[name] = new ort.Tensor("float32", new Float32Array(0), [1, cache.kvHeads, 0, cache.headDim]);
    } else {
      throw new Error(`Unsupported model input: ${name}`);
    }
  }
  return feeds;
}

/** The hidden state of the last token (the appended end-of-text token) is the embedding. */
async function embedOne(
  ort: OrtModuleLike,
  session: OrtSessionLike,
  spec: LocalEmbeddingSpec,
  row: readonly number[],
  dimensions: number,
): Promise<Float32Array> {
  const result = await session.run(feedsFor(ort, session, row, spec), [spec.output]);
  const hidden = result[spec.output];
  const data = floatData(hidden, spec.output);
  const size = hidden!.dims[2];
  if (hidden!.dims[1] !== row.length || !size) throw new Error(`model output ${spec.output} has an unexpected shape`);
  const at = (row.length - 1) * size;
  return toUnitVector(data.subarray(at, at + size), dimensions);
}

async function rerankOne(
  ort: OrtModuleLike,
  session: OrtSessionLike,
  spec: LocalRerankerSpec,
  row: readonly number[],
): Promise<number> {
  const result = await session.run(feedsFor(ort, session, row, null), [spec.output]);
  const logit = floatData(result[spec.output], spec.output)[0];
  if (logit === undefined || !Number.isFinite(logit)) throw new Error(`model output ${spec.output} is not a score`);
  return sigmoid(logit);
}

/** The runtime for the local models; nothing is loaded until a model is used. */
export function createLocalModels(deps: LocalModelsDeps): MemoryLocalRuntime {
  return new LocalModels(deps);
}
