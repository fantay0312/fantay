import { createHash } from "node:crypto";
import type { PaAttempt, PaChatWire, PaDataClass } from "@open-design/contracts";
import type { PaDeltaSink, PaModelResult, PaModelRuntime } from "../runtimes/personal-agent.js";
import { PaError, type PaStore } from "../storage/personal-agent-store.js";
import type { PaImageInput } from "../integrations/pa-channel-transport.js";

export const paDigest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const PA_MAX_MODEL_BYTES = 2 * 1024 * 1024;
export const PA_MAX_CONTEXT_BYTES = 768 * 1024;

export function paRouteAllows(dataClass: PaDataClass | undefined, runtime: PaAttempt["agentSnapshot"]["model"]["runtime"]): boolean {
  return dataClass !== "local_only" || runtime === "ollama";
}

// Redact recognizable credentials before model egress. This does not classify
// arbitrary user text or replace the explicit local-only routing rule.
export function redactPaCredentials(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[credential removed]")
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+\/=-]{8,}/gi, "Bearer [credential removed]")
    .replace(/\b(?:sk-(?:ant-|proj-)?[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[\w]{20,}|AKIA[A-Z0-9]{16})\b/g, "[credential removed]")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b["']?\s*[:=]\s*)(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;&}"']{8,})/gi,
      (match, prefix: string) => {
        const quote = match[prefix.length];
        return quote === '"' || quote === "'" ? `${prefix}${quote}[credential removed]${quote}` : `${prefix}[credential removed]`;
      });
}

/** How far back from the end the live tail rules look. Anchored at the end, their greedy classes rescan the rest of
 *  the text from every start, which is quadratic over a whole live buffer of hostile text; a credential still arriving
 *  is short (a longer one is already whole and gone through redactPaCredentials, or not a credential at all). */
const PA_LIVE_TAIL_CHARS = 4096;

/** Redaction for text that is still growing: redactPaCredentials, then a credential that may still be arriving at
 *  the very end is held back. */
export function redactPaLiveText(value: string): string {
  let out = redactPaCredentials(value);
  const key = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(out);   // a complete pair is already gone, so no END follows
  if (key) out = out.slice(0, key.index);
  const at = Math.max(0, out.length - PA_LIVE_TAIL_CHARS);
  let tail = out.slice(at);
  for (const rule of [/\bBearer[ \t]+[A-Za-z0-9._~+\/=-]*$/i, /\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[\w-]*$/]) {
    const match = rule.exec(tail);
    if (match) tail = tail.slice(0, match.index);
  }
  // Keep the key and the separator; the value (bare, or an open quote that has not closed yet) is cut.
  tail = tail.replace(/(\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*|'[^'\r\n]*|\S*)$/i, "$1");
  return out.slice(0, at) + tail;
}

export class PaGateway {
  constructor(private readonly store: PaStore, private readonly runtime: PaModelRuntime) {}

  async infer(
    attempt: PaAttempt, prompt: string, signal: AbortSignal,
    execute?: (wire: string, signal: AbortSignal) => Promise<PaModelResult>,
    purpose: "model" | "plan" = "model",
    chat?: PaChatWire,
    onDelta?: PaDeltaSink,
    images?: PaImageInput[],
  ): Promise<PaModelResult> {
    const model = attempt.agentSnapshot.model;
    if (!attempt.authority?.capabilities.includes("respond") || !execute && !paRouteAllows(attempt.dataClass, model.runtime))
      throw new PaError("当前模型或授权无法处理此任务的密级", 403, "PA_ROUTE_DENIED");
    const wire = redactPaCredentials(prompt);
    const wireChat = chat && !execute ? {
      ...chat,
      system: redactPaCredentials(chat.system),
      transcript: redactPaCredentials(chat.transcript),
      messages: chat.messages.map((message) => ({ ...message, content: redactPaCredentials(message.content) })),
    } : undefined;
    if (Buffer.byteLength(wire) > PA_MAX_CONTEXT_BYTES)
      throw new PaError("任务及验收证据超过模型上下文上限，请拆分任务", 413, "PA_CONTEXT_LIMIT");
    signal.throwIfAborted();
    let open = true;
    // Closed by a stop too: what a stopping runtime still prints before it exits is not shown as live text.
    const emit: PaDeltaSink | undefined = onDelta && !execute
      ? (chunk, meta) => { if (open && !signal.aborted) { try { onDelta(chunk, meta); } catch { /* a live preview never fails a model call */ } } }
      : undefined;
    this.store.audit(attempt.taskId, purpose === "plan" ? "gateway.plan_dispatched" : "gateway.model_dispatched", {
      attemptId: attempt.id,
      runId: attempt.runId,
      model,
      dataClass: attempt.dataClass ?? "standard",
      authority: attempt.authority,
      requestDigest: paDigest(wire),
      requestBytes: Buffer.byteLength(wire),
      ...(wireChat ? { chatDigest: paDigest(JSON.stringify(wireChat)) } : {}),
      ...(images?.length ? { imageDigests: images.map(image => paDigest(image.data)) } : {}),
      ...(attempt.reservedCostUsd !== undefined ? { reservedCostUsd: attempt.reservedCostUsd } : {}),
    }, `${attempt.id}:${purpose}-dispatched`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const stopDeadline = new Promise<never>((_, reject) => {
      onAbort = () => {
        timer = setTimeout(() => reject(new PaError("执行者未确认停止，结果待核对", 409, "PA_STOP_UNKNOWN")), 5000);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let result: PaModelResult;
    try {
      const operation = execute ? execute(wire, signal) : this.runtime.execute(model, wire, attempt.runId, signal, {
        ...(attempt.dataClass ? { dataClass: attempt.dataClass } : {}),
        ...(attempt.reservedCostUsd !== undefined ? { maxCostUsd: attempt.reservedCostUsd } : {}),
        ...(wireChat ? { chat: wireChat } : {}),
        ...(emit ? { onDelta: emit } : {}),
        ...(images?.length ? { images } : {}),
      });
      result = await Promise.race([operation, stopDeadline]);
    } finally {
      open = false;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    signal.throwIfAborted();
    if (typeof result.text !== "string" || !result.text.trim() || Buffer.byteLength(result.text) > PA_MAX_MODEL_BYTES)
      throw new PaError("模型返回内容为空或超出上限", 422, "PA_INVALID_OUTPUT");
    return { ...result, text: redactPaCredentials(result.text) };
  }
}
