import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createPaModelRuntime } from "../../runtimes/personal-agent.js";
import { PaError } from "../../storage/personal-agent-store.js";
import { paDigest, redactPaCredentials } from "../personal-agent-gateway.js";
import { paSandboxConfig, readPrivatePaFile, trustedPaUrl } from "./config.js";
import { PaOciSandbox } from "./sandbox.js";
import { workerLeaseSchema, workerWorkSchema, type WorkerAssignment, type WorkerResult } from "./distributed.js";

const assignmentSchema = workerLeaseSchema.extend({
  work: workerWorkSchema,
  workHash: z.string().regex(/^[a-f0-9]{64}$/),
  leaseMs: z.number().int().min(1500).max(60000),
  timeoutMs: z.number().int().positive().max(1800000),
}).strict().nullable();

export async function runPaWorker(input: {
  controller: string; tokenFile: string; sandboxConfig?: string; dataDir: string; signal: AbortSignal;
}): Promise<void> {
  const base = trustedPaUrl(input.controller);
  if (base.pathname !== "/") throw new Error("Worker controller must be a base origin");
  const token = readPrivatePaFile(input.tokenFile, 4096).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Invalid worker credential");
  const sandbox = input.sandboxConfig ? new PaOciSandbox(paSandboxConfig.parse(JSON.parse(readPrivatePaFile(input.sandboxConfig, 16384)))) : null;
  const localModels = createPaModelRuntime(input.dataDir);
  const send = (endpoint: "claim" | "heartbeat" | "result", body: unknown, signal: AbortSignal, timeoutMs = 3000) =>
    fetch(new URL(`/api/pa/workers/${endpoint}`, base), {
      method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  const execute = async (assignment: WorkerAssignment) => {
    const { runId, generation, leaseId, work, timeoutMs, leaseMs } = assignment;
    if (paDigest(JSON.stringify(work)) !== assignment.workHash) return;
    const lease = { runId, generation, leaseId };
    const keepalive = new AbortController();
    const signal = AbortSignal.any([input.signal, keepalive.signal, AbortSignal.timeout(timeoutMs)]);
    let aliveUntil = Date.now() + leaseMs;
    const heartbeat = (async () => {
      try {
        while (!signal.aborted) {
          await delay(Math.max(200, Math.floor(leaseMs / 4)), undefined, { signal });
          const requestAt = Date.now();
          const response = await send("heartbeat", lease, signal, Math.min(2000, Math.floor(leaseMs / 3))).catch(() => null);
          if (response?.ok) aliveUntil = requestAt + leaseMs;
          else if (response?.status === 409 || response?.status === 401 || Date.now() >= aliveUntil) keepalive.abort();
        }
      } catch { keepalive.abort(); }
    })();
    try {
      let result: WorkerResult;
      try {
        if (work.kind === "shell" && !sandbox) throw new PaError("No OCI sandbox configured", 503, "PA_SANDBOX_UNAVAILABLE");
        const output = work.kind === "shell"
          ? await sandbox!.execute(work.script, timeoutMs, signal)
          : (await localModels.execute({ runtime: "ollama", modelId: work.modelId }, work.prompt, runId, signal, { dataClass: "local_only" })).text;
        result = { ok: true, output: redactPaCredentials(output) };
      } catch (error) {
        if (signal.aborted) return;
        const code = error instanceof PaError ? error.code : "";
        result = { ok: false, code: code === "PA_SANDBOX_UNAVAILABLE" || code === "PA_SANDBOX_FAILED" || code === "PA_SANDBOX_OUTPUT" ? code : "PA_WORKER_FAILED" };
      }
      while (!signal.aborted) {
        const response = await send("result", { lease, result }, signal, Math.min(2000, Math.floor(leaseMs / 3))).catch(() => null);
        if (response?.ok || response?.status === 409 || response?.status === 401) return;
        await delay(250, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      keepalive.abort();
      await heartbeat;
    }
  };
  while (!input.signal.aborted) {
    const capabilities: Array<"shell" | "ollama"> = ["ollama"];
    if (sandbox && await sandbox.available(input.signal).then(() => true, () => false)) capabilities.push("shell");
    const response = await send("claim", { capabilities }, input.signal).catch(() => null);
    if (response?.status === 401 || response?.status === 403) throw new Error("Worker credential was rejected or revoked");
    if (response?.ok) {
      const assignment = assignmentSchema.safeParse(await response.json());
      if (!assignment.success) throw new Error("Invalid assignment from PA controller");
      if (assignment.data) await execute(assignment.data);
    }
    await delay(250, undefined, { signal: input.signal }).catch(() => undefined);
  }
}
