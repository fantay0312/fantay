// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — dense vectors. mem_vectors holds one L2-normalized Float32 BLOB per (document, model); a
// contiguous in-memory matrix per model is loaded on first use and kept current on upsert, and search is a
// brute-force dot product over the documents the caller may read (fast enough below ~300k vectors).
// MemoryEmbedder fills the table in the background and never lets a provider failure reach its caller.

import type { SqliteDb } from "../../db.js";
import { ensureMemorySchema } from "./schema.js";
import type { ChannelHit, EmbeddingProvider, IndexedDoc, MemoryIndexApi, MemoryVectorsApi } from "./types.js";

function normalized(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sum);
  if (norm === 0 || Math.abs(norm - 1) < 1e-6) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i]! / norm;
  return out;
}

function encode(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function decode(blob: Buffer): Float32Array {
  if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength >>> 2);
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/** Top-k by descending score, kept in a small sorted array (k is at most a few dozen). */
class TopK {
  readonly ids: number[] = [];
  readonly scores: number[] = [];
  constructor(private readonly k: number) {}

  floor(): number {
    return this.scores.length < this.k ? -Infinity : this.scores[this.scores.length - 1]!;
  }

  offer(id: number, score: number): void {
    if (score <= this.floor()) return;
    let at = this.scores.length;
    while (at > 0 && this.scores[at - 1]! < score) at -= 1;
    this.scores.splice(at, 0, score);
    this.ids.splice(at, 0, id);
    if (this.scores.length > this.k) {
      this.scores.pop();
      this.ids.pop();
    }
  }

  hits(): ChannelHit[] {
    return this.ids.map((docId, i) => ({ docId, score: this.scores[i]! }));
  }
}

/** All vectors of one model, row-major, for one dimension. */
class VectorMatrix {
  private data = new Float32Array(0);
  private docIds: number[] = [];
  private readonly rowOf = new Map<number, number>();
  /** Rows zeroed by `drop` until the document is embedded again. */
  private readonly dropped = new Set<number>();
  dim = 0;

  get size(): number {
    return this.docIds.length;
  }

  put(docId: number, vector: Float32Array): void {
    if (this.dim === 0) this.dim = vector.length;
    if (vector.length !== this.dim) return;
    let row = this.rowOf.get(docId);
    if (row === undefined) {
      row = this.docIds.length;
      this.grow(row + 1);
      this.docIds.push(docId);
      this.rowOf.set(docId, row);
    }
    this.data.set(vector, row * this.dim);
    this.dropped.delete(docId);
  }

  /** Zeroes a document's row; the slot is reused if the document is embedded again. */
  drop(docId: number): void {
    const row = this.rowOf.get(docId);
    if (row === undefined) return;
    this.data.fill(0, row * this.dim, (row + 1) * this.dim);
    this.dropped.add(docId);
  }

  scores(query: Float32Array, docIds: readonly number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (query.length !== this.dim) return out;
    for (const docId of docIds) {
      const row = this.rowOf.get(docId);
      if (row !== undefined && !this.dropped.has(docId)) out.set(docId, this.dot(row, query));
    }
    return out;
  }

  search(query: Float32Array, allowed: ReadonlySet<number>, limit: number): ChannelHit[] {
    if (query.length !== this.dim || this.size === 0 || limit <= 0) return [];
    const top = new TopK(limit);
    // Walk whichever side is smaller: the allowed set (a narrow scope) or the whole matrix.
    if (allowed.size * 4 < this.size) {
      for (const docId of allowed) {
        const row = this.rowOf.get(docId);
        if (row !== undefined) top.offer(docId, this.dot(row, query));
      }
    } else {
      for (let row = 0; row < this.docIds.length; row += 1) {
        const docId = this.docIds[row]!;
        if (allowed.has(docId)) top.offer(docId, this.dot(row, query));
      }
    }
    return top.hits();
  }

  private dot(row: number, query: Float32Array): number {
    const data = this.data;
    const base = row * this.dim;
    let sum = 0;
    for (let i = 0; i < this.dim; i += 1) sum += data[base + i]! * query[i]!;
    return sum;
  }

  private grow(rows: number): void {
    const needed = rows * this.dim;
    if (needed <= this.data.length) return;
    const next = new Float32Array(Math.max(needed, this.data.length * 2, this.dim * 256));
    next.set(this.data);
    this.data = next;
  }
}

export class MemoryVectors implements MemoryVectorsApi {
  private readonly matrices = new Map<string, VectorMatrix>();
  private readonly statements;

  constructor(
    db: SqliteDb,
    private readonly now: () => number,
  ) {
    ensureMemorySchema(db);
    this.statements = {
      upsert: db.prepare(
        "INSERT INTO mem_vectors(doc_id, model_id, dim, vec, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(doc_id, model_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, " +
          "content_hash = excluded.content_hash, created_at = excluded.created_at",
      ),
      load: db.prepare<[string], { docId: number; vec: Buffer }>(
        "SELECT v.doc_id AS docId, v.vec FROM mem_vectors v JOIN mem_docs d ON d.doc_id = v.doc_id " +
          "WHERE v.model_id = ? ORDER BY v.doc_id",
      ),
      hashOf: db
        .prepare<[number, string], string>("SELECT content_hash FROM mem_vectors WHERE doc_id = ? AND model_id = ?")
        .pluck(),
      stale: db.prepare<[string, number], { docId: number; contentHash: string }>(
        "SELECT d.doc_id AS docId, d.content_hash AS contentHash FROM mem_docs d " +
          "LEFT JOIN mem_vectors v ON v.doc_id = d.doc_id AND v.model_id = ? " +
          "WHERE d.recallable = 1 AND (v.doc_id IS NULL OR v.content_hash <> d.content_hash) " +
          "ORDER BY d.doc_id DESC LIMIT ?",
      ),
      forget: db.prepare<[number]>("DELETE FROM mem_vectors WHERE doc_id = ?"),
      clearModel: db.prepare<[string]>("DELETE FROM mem_vectors WHERE model_id = ?"),
      counts: db.prepare<[string], { indexed: number | null; waiting: number | null }>(
        "SELECT SUM(CASE WHEN v.content_hash = d.content_hash THEN 1 ELSE 0 END) AS indexed, " +
          "SUM(CASE WHEN v.doc_id IS NULL OR v.content_hash <> d.content_hash THEN 1 ELSE 0 END) AS waiting " +
          "FROM mem_docs d LEFT JOIN mem_vectors v ON v.doc_id = d.doc_id AND v.model_id = ? WHERE d.recallable = 1",
      ),
    };
  }

  upsert(docId: number, modelId: string, vector: Float32Array, contentHash: string): void {
    const unit = normalized(vector);
    this.statements.upsert.run(docId, modelId, unit.length, encode(unit), contentHash, this.now());
    this.matrices.get(modelId)?.put(docId, unit);
  }

  search(queryVector: Float32Array, modelId: string, allowed: ReadonlySet<number>, limit: number): ChannelHit[] {
    if (allowed.size === 0) return [];
    return this.matrix(modelId).search(normalized(queryVector), allowed, limit);
  }

  scores(queryVector: Float32Array, modelId: string, docIds: readonly number[]): Map<number, number> {
    if (docIds.length === 0) return new Map();
    return this.matrix(modelId).scores(normalized(queryVector), docIds);
  }

  stale(modelId: string, limit: number): Array<{ docId: number; contentHash: string }> {
    return this.statements.stale.all(modelId, Math.max(0, Math.floor(limit)));
  }

  counts(modelId: string): { indexed: number; waiting: number } {
    const row = this.statements.counts.get(modelId);
    return { indexed: row?.indexed ?? 0, waiting: row?.waiting ?? 0 };
  }

  /** Whether the document already has a vector of this text for this model (lets the embedder skip it). */
  isCurrent(docId: number, modelId: string, contentHash: string): boolean {
    return this.statements.hashOf.get(docId, modelId) === contentHash;
  }

  reset(): void {
    this.matrices.clear();
  }

  /** Removes every vector of one document (its text was redacted: the embedding is derived from it). */
  forget(docId: number): void {
    this.statements.forget.run(docId);
    for (const matrix of this.matrices.values()) matrix.drop(docId);
  }

  /** Removes every vector of one model so it is computed again. */
  clear(modelId: string): void {
    this.statements.clearModel.run(modelId);
    this.matrices.delete(modelId);
  }

  private matrix(modelId: string): VectorMatrix {
    let matrix = this.matrices.get(modelId);
    if (!matrix) {
      matrix = new VectorMatrix();
      for (const row of this.statements.load.iterate(modelId)) matrix.put(row.docId, decode(row.vec));
      this.matrices.set(modelId, matrix);
    }
    return matrix;
  }
}

// ---- background embedding ----------------------------------------------------------------------------------------

const BATCH_SIZE = 16;
const MAX_IN_FLIGHT = 2;
/** After a provider failure new work is dropped for this long (it stays stale in SQLite and is requeued later). */
const FAILURE_COOLDOWN_MS = 10_000;

export interface MemoryEmbedderDeps {
  index: MemoryIndexApi;
  vectors: MemoryVectorsApi;
  /** Text to embed, null when the document is gone. */
  textOf: (doc: IndexedDoc) => string | null;
  provider: () => EmbeddingProvider | null;
  onError: (error: unknown) => void;
  onOk: () => void;
}

interface VectorFreshness {
  isCurrent(docId: number, modelId: string, contentHash: string): boolean;
}

function hasFreshness(vectors: MemoryVectorsApi): vectors is MemoryVectorsApi & VectorFreshness {
  return typeof (vectors as Partial<VectorFreshness>).isCurrent === "function";
}

export class MemoryEmbedder {
  private readonly queue = new Set<number>();
  private readonly controllers = new Set<AbortController>();
  private waiters: Array<() => void> = [];
  private inFlight = 0;
  private scheduled = false;
  private stopped = false;
  private cooldownUntil = 0;
  /** A batch failed; after the next success every stale document is queued again. */
  private recovering = false;

  constructor(private readonly deps: MemoryEmbedderDeps) {}

  /** No-op without a provider. */
  enqueue(docId: number): void {
    if (this.stopped || Date.now() < this.cooldownUntil || !this.provider()) return;
    this.queue.add(docId);
    this.schedule();
  }

  /** Queues every document missing a current vector. */
  requeueStale(): void {
    if (this.stopped) return;
    const provider = this.provider();
    if (!provider) return;
    try {
      const limit = Math.max(1, this.deps.index.count());
      for (const row of this.deps.vectors.stale(provider.modelId, limit)) this.queue.add(row.docId);
    } catch (error) {
      this.report(error);
      return;
    }
    this.cooldownUntil = 0;
    this.schedule();
  }

  /** Resolves when the queue is drained. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  stop(): void {
    this.stopped = true;
    this.queue.clear();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.release();
  }

  private provider(): EmbeddingProvider | null {
    try {
      return this.deps.provider();
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  private isIdle(): boolean {
    return this.stopped || (this.queue.size === 0 && this.inFlight === 0 && !this.scheduled);
  }

  private release(): void {
    if (!this.isIdle()) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Defers the pump one turn so enqueues made together share a batch. */
  private schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (!this.stopped && this.inFlight < MAX_IN_FLIGHT && this.queue.size > 0) {
      const batch: number[] = [];
      for (const docId of this.queue) {
        batch.push(docId);
        this.queue.delete(docId);
        if (batch.length === BATCH_SIZE) break;
      }
      this.inFlight += 1;
      void this.runBatch(batch).finally(() => {
        this.inFlight -= 1;
        this.pump();
      });
    }
    this.release();
  }

  private async runBatch(docIds: number[]): Promise<void> {
    const provider = this.provider();
    if (!provider) {
      this.queue.clear();
      return;
    }
    let targets: Array<{ doc: IndexedDoc; text: string }>;
    try {
      targets = this.embeddable(docIds, provider);
    } catch (error) {
      this.report(error);
      return;
    }
    if (targets.length === 0) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const vectors = await provider.embed(
        targets.map((target) => target.text),
        "document",
        controller.signal,
      );
      if (this.stopped) return;
      if (vectors.length !== targets.length) {
        throw new Error(`embedding returned ${vectors.length} vectors for ${targets.length} texts`);
      }
      // The text may have changed or been redacted while the model was busy; only a vector of the current text
      // is kept.
      const current = new Map(this.deps.index.docs(targets.map((target) => target.doc.docId)).map((d) => [d.docId, d]));
      targets.forEach(({ doc }, i) => {
        const now = current.get(doc.docId);
        if (!now?.recallable || now.contentHash !== doc.contentHash) return;
        this.deps.vectors.upsert(doc.docId, provider.modelId, vectors[i]!, doc.contentHash);
      });
      this.safely(() => this.deps.onOk());
      if (this.recovering) {
        this.recovering = false;
        this.requeueStale();
      }
    } catch (error) {
      if (this.stopped) return;
      this.report(error);
      this.queue.clear();
      this.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
      this.recovering = true;
    } finally {
      this.controllers.delete(controller);
    }
  }

  /** Documents of the batch that still need a vector and may be sent to this provider. */
  private embeddable(docIds: number[], provider: EmbeddingProvider): Array<{ doc: IndexedDoc; text: string }> {
    const fresh = hasFreshness(this.deps.vectors) ? this.deps.vectors : null;
    const out: Array<{ doc: IndexedDoc; text: string }> = [];
    for (const doc of this.deps.index.docs(docIds)) {
      if (!doc.recallable) continue;
      // local_only text never leaves the machine.
      if (provider.remote && doc.dataClass === "local_only") continue;
      if (fresh?.isCurrent(doc.docId, provider.modelId, doc.contentHash)) continue;
      const text = this.deps.textOf(doc);
      if (text?.trim()) out.push({ doc, text });
    }
    return out;
  }

  private report(error: unknown): void {
    this.safely(() => this.deps.onError(error));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch {
      // A failing status callback must not break background embedding.
    }
  }
}
