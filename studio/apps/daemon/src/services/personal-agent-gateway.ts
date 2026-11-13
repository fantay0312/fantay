import { createHash } from "node:crypto";
import type { PaAttempt, PaDataClass } from "@open-design/contracts";
import type { PaModelResult, PaModelRuntime } from "../runtimes/personal-agent.js";
import { PaError, type PaStore } from "../storage/personal-agent-store.js";

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

export class PaGateway {
  constructor(private readonly store: PaStore, private readonly runtime: PaModelRuntime) {}

  async infer(
    attempt: PaAttempt, prompt: string, signal: AbortSignal,
    execute?: (wire: string, signal: AbortSignal) => Promise<PaModelResult>,
    purpose: "model" | "plan" = "model",
  ): Promise<PaModelResult> {
    const model = attempt.agentSnapshot.model;
    if (!attempt.authority?.capabilities.includes("respond") || !execute && !paRouteAllows(attempt.dataClass, model.runtime))
      throw new PaError("当前模型或授权无法处理此任务的密级", 403, "PA_ROUTE_DENIED");
    const wire = redactPaCredentials(prompt);
    if (Buffer.byteLength(wire) > PA_MAX_CONTEXT_BYTES)
      throw new PaError("任务及验收证据超过模型上下文上限，请拆分任务", 413, "PA_CONTEXT_LIMIT");
    signal.throwIfAborted();
    this.store.audit(attempt.taskId, purpose === "plan" ? "gateway.plan_dispatched" : "gateway.model_dispatched", {
      attemptId: attempt.id,
      runId: attempt.runId,
      model,
      dataClass: attempt.dataClass ?? "standard",
      authority: attempt.authority,
      requestDigest: paDigest(wire),
      requestBytes: Buffer.byteLength(wire),
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
      });
      result = await Promise.race([operation, stopDeadline]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    signal.throwIfAborted();
    if (typeof result.text !== "string" || !result.text.trim() || Buffer.byteLength(result.text) > PA_MAX_MODEL_BYTES)
      throw new PaError("模型返回内容为空或超出上限", 422, "PA_INVALID_OUTPUT");
    return { ...result, text: redactPaCredentials(result.text) };
  }
}
