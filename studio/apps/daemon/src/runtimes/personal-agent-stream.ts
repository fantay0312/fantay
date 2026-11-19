import { StringDecoder } from "node:string_decoder";
import { PaError } from "../storage/personal-agent-store.js";
import type { PaDeltaSink } from "./personal-agent.js";

// Pure readers for the streaming wires of the PA model runtime. They only observe: the caller's existing pass over the
// whole output stays authoritative, and a sink that throws never changes what a reader returns or throws.

const MAX_LINE_BYTES = 4 * 1024 * 1024;

const guarded = (onDelta: PaDeltaSink): PaDeltaSink => (chunk, meta) => {
  try { onDelta(chunk, meta); } catch { /* a live preview never fails a model call */ }
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** UTF-8 safe line splitter (StringDecoder). A line longer than 4 MiB is dropped. */
export function createPaLineReader(onLine: (line: string) => void): {
  push(chunk: Buffer | Uint8Array | string): void; end(): void; bytes(): number;
} {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let pendingBytes = 0;
  let dropping = false;
  let total = 0;
  const emit = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  const take = (text: string) => {
    let start = 0;
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", start)) {
      const piece = text.slice(start, at);
      start = at + 1;
      if (!dropping && pendingBytes + Buffer.byteLength(piece) <= MAX_LINE_BYTES) emit(pending + piece);
      pending = "";
      pendingBytes = 0;
      dropping = false;
    }
    if (start >= text.length || dropping) return;
    const rest = text.slice(start);
    pendingBytes += Buffer.byteLength(rest);
    if (pendingBytes > MAX_LINE_BYTES) {
      dropping = true;
      pending = "";
      pendingBytes = 0;
    } else pending += rest;
  };
  return {
    push(chunk) {
      if (typeof chunk === "string") {
        total += Buffer.byteLength(chunk);
        take(chunk);
        return;
      }
      total += chunk.byteLength;
      take(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    },
    end() {
      take(decoder.end());
      if (pending && !dropping) emit(pending);
      pending = "";
      pendingBytes = 0;
      dropping = false;
    },
    bytes: () => total,
  };
}

/** Claude Code `--output-format stream-json` stdout. */
export function createPaClaudeStreamReader(onDelta: PaDeltaSink): {
  push(chunk: Buffer | string): void; end(): void; bytes(): number;
  result(): Record<string, unknown> | null;        // the last frame with type 'result'
} {
  const report = guarded(onDelta);
  let last: Record<string, unknown> | null = null;
  let reported = false;
  let reset = false;
  const lines = createPaLineReader((line) => {
    if (!line.trim()) return;
    let frame: Record<string, unknown> | null;
    try { frame = record(JSON.parse(line)); } catch { return; }
    if (!frame) return;
    if (frame.type === "result") {
      last = frame;
      return;
    }
    // Only the main turn streams: a forwarded sub-agent frame carries a non-null top-level parent_tool_use_id.
    if (frame.type !== "stream_event" || (frame.parent_tool_use_id !== null && frame.parent_tool_use_id !== undefined)) return;
    const event = record(frame.event);
    if (event?.type === "message_start") {
      // A new assistant message: the final result is the text of the last message, so the earlier text goes.
      if (reported) reset = true;
      return;
    }
    if (event?.type !== "content_block_delta") return;
    const delta = record(event.delta);
    if (delta?.type !== "text_delta" || typeof delta.text !== "string") return;
    const text = delta.text;
    if (reset) {
      reset = false;
      report(text, { reset: true });
    } else report(text);
    reported = true;
  });
  return {
    push: (chunk) => lines.push(chunk),
    end: () => lines.end(),
    bytes: () => lines.bytes(),
    result: () => last,
  };
}

const ollamaUnavailable = () => new PaError("本机模型暂不可用", 503, "PA_MODEL_UNAVAILABLE");
const tooLarge = () => new PaError("模型输出超过上限", 413, "PA_INVALID_OUTPUT");

/** Ollama `/api/chat` with `stream: true` (NDJSON). */
export async function readPaOllamaStream(response: { body: ReadableStream<Uint8Array> | null }, onDelta: PaDeltaSink, maxBytes: number):
  Promise<{ text: string; inputTokens: number | undefined; outputTokens: number | undefined }> {
  const report = guarded(onDelta);
  let text = "";
  let done = false;
  let failed = false;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const lines = createPaLineReader((line) => {
    if (failed || done || !line.trim()) return;
    let frame: Record<string, unknown> | null;
    try { frame = record(JSON.parse(line)); } catch { frame = null; }
    if (!frame || (frame.error !== undefined && frame.error !== null)) {
      failed = true;
      return;
    }
    const content = record(frame.message)?.content;
    if (typeof content === "string" && content) {
      text += content;
      report(content);
    }
    if (frame.done === true) {
      done = true;
      inputTokens = count(frame.prompt_eval_count);
      outputTokens = count(frame.eval_count);
    }
  });
  const reader = response.body?.getReader();
  if (!reader) throw ollamaUnavailable();
  let bytes = 0;
  try {
    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      if ((bytes += value.byteLength) > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      lines.push(value);
      if (failed) {
        void reader.cancel().catch(() => undefined);
        throw ollamaUnavailable();
      }
    }
  } finally { reader.releaseLock(); }
  lines.end();
  if (failed || !done) throw ollamaUnavailable();
  return { text, inputTokens, outputTokens };
}

/** An SSE body: returns the whole body text (what `boundedResponse` returns) and reports text deltas on the way. */
export async function readPaSseText(response: { body: ReadableStream<Uint8Array> | null },
  operation: "/v1/chat/completions" | "/v1/messages", onDelta: PaDeltaSink, maxBytes: number): Promise<string> {
  const report = guarded(onDelta);
  const lines = createPaLineReader((line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let frame: Record<string, unknown> | null;
    // The caller's pass over the whole text is authoritative: a broken frame is its decision, not this reader's.
    try { frame = record(JSON.parse(payload)); } catch { return; }
    if (!frame) return;
    let delta: unknown = "";
    if (operation === "/v1/messages") {
      const block = record(frame.delta);
      delta = block?.type === "text_delta" ? block.text : "";
    } else {
      const choices = Array.isArray(frame.choices) ? frame.choices : [];
      delta = record(record(choices[0])?.delta)?.content ?? "";
    }
    if (typeof delta === "string" && delta) report(delta);
  });
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if ((bytes += value.byteLength) > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
      lines.push(value);
    }
  } finally { reader.releaseLock(); }
  lines.end();
  return Buffer.concat(chunks, bytes).toString("utf8");
}
