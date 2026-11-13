import type { PaModelOption } from "@open-design/contracts";
import { Agent, fetch as directFetch } from "undici";
import type { PaModelRuntime } from "../../runtimes/personal-agent.js";
import { PaError } from "../../storage/personal-agent-store.js";
import { PA_MAX_MODEL_BYTES, redactPaCredentials } from "../personal-agent-gateway.js";
import { readPrivatePaFile, trustedPaUrl, type PaEnterpriseConfig } from "./config.js";

const direct = new Agent();

async function readResponse(response: Awaited<ReturnType<typeof directFetch>>, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const entry = await reader.read();
      if (entry.done) return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      if ((bytes += entry.value.byteLength) > limit) {
        void reader.cancel().catch(() => undefined);
        throw new Error("Response limit");
      }
      chunks.push(entry.value);
    }
  } finally { reader.releaseLock(); }
}

type Secret = PaEnterpriseConfig["gateway"]["secret"];
export interface PaCredentialDriver {
  readonly runtime: PaModelRuntime;
}

function checkedSecret(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(value))
    throw new PaError("模型网关凭据不可用", 503, "PA_MODEL_UNAVAILABLE");
  return value;
}

async function secretValue(secret: Secret, signal: AbortSignal): Promise<string> {
  try {
    if (secret.type === "file") return checkedSecret(readPrivatePaFile(secret.path, 8192).trim());
    const base = trustedPaUrl(secret.url);
    if (base.pathname !== "/") throw new Error("Vault base origin required");
    const token = checkedSecret(readPrivatePaFile(secret.tokenFile, 8192).trim());
    const resource = new URL(`/v1/${secret.mount}/data/${secret.path}`, base);
    const response = await directFetch(resource, {
      dispatcher: direct,
      headers: { "X-Vault-Token": token }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw new Error("Vault unavailable");
    const value = await readResponse(response, 256 * 1024) as { data?: { data?: Record<string, unknown> } };
    return checkedSecret(value.data?.data?.[secret.field]);
  } catch {
    signal.throwIfAborted();
    throw new PaError("无法读取模型网关凭据", 503, "PA_MODEL_UNAVAILABLE");
  }
}

export function createPaManagedCredentials(config: PaEnterpriseConfig["gateway"]): PaCredentialDriver {
  const endpoint = trustedPaUrl(config.endpoint);
  return {
    runtime: {
      async models(): Promise<PaModelOption[]> {
        return config.models.map(model => ({ runtime: "managed", modelId: model.id, label: model.id, available: true }));
      },
      async execute(model, prompt, runId, signal) {
        const route = config.models.find(item => item.id === model.modelId);
        if (model.runtime !== "managed" || !route)
          throw new PaError("模型不在企业路由授权范围", 403, "PA_ROUTE_DENIED");
        const credential = await secretValue(config.secret, signal);
        signal.throwIfAborted();
        try {
          const response = await directFetch(endpoint, {
            dispatcher: direct,
            method: "POST", redirect: "error", signal,
            headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "idempotency-key": runId },
            body: JSON.stringify({ model: route.id, messages: [{ role: "user", content: prompt }], max_tokens: route.maxTokens, stream: false }),
          });
          if (response.status >= 500) throw new PaError("上游回执未知，请对账", 503, "PA_RESULT_UNKNOWN");
          if (!response.ok) throw new PaError("企业模型拒绝请求", 503, "PA_MODEL_UNAVAILABLE");
          const payload = await readResponse(response, PA_MAX_MODEL_BYTES) as {
            model?: string;
            choices?: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const raw = payload.choices?.[0]?.message?.content;
          if (!raw?.trim()) throw new Error("No managed model result");
          const text = redactPaCredentials(raw.replaceAll(credential, "[credential removed]"));
          const positiveInt = (input: unknown) => typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : undefined;
          return {
            text, resolvedModel: typeof payload.model === "string" ? redactPaCredentials(payload.model.replaceAll(credential, "[credential removed]")) : route.id,
            usage: payload.usage ? {
              visibility: "reported", inputTokens: positiveInt(payload.usage.prompt_tokens), outputTokens: positiveInt(payload.usage.completion_tokens),
            } : { visibility: "unknown" },
          };
        } catch (error) {
          if (error instanceof PaError) throw error;
          throw new PaError("企业模型回执未知，请对账后继续", 503, "PA_RESULT_UNKNOWN");
        }
      },
    },
  };
}
