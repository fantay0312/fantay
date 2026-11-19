import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSearchError } from "@fantay/native-web-search";
import type {
  TokenToSeaModel,
  TokenToSeaRuntime,
} from "../integrations/tokentosea-runtime.js";

export type DeepSeekTool = "search" | "fetch";
export type DeepSeekTokenToSeaRuntime = Pick<
  TokenToSeaRuntime,
  "current" | "models" | "authorizationBudget" | "json"
>;

interface NativeRun {
  id?: string;
  status?: string;
  billingStatus?: string;
  deliveryState?: string;
  chargedUsd?: string;
  output?: Record<string, unknown>;
  errorCode?: string;
}

export function nativeModel(
  models: TokenToSeaModel[],
  tool: DeepSeekTool,
): TokenToSeaModel | undefined {
  const operation = `/v1/tools/${tool}`;
  return models.find(
    (model) =>
      model.model === `deepseek-${tool}` &&
      model.available !== false &&
      model.executionKind === "official" &&
      model.examples?.some(
        (example) => example.path === operation && example.mode === "json",
      ),
  );
}

/** Uses the current request's account and the existing billing/receipt boundary. */
export async function invokeTokenToSeaDeepSeek(
  runtime: DeepSeekTokenToSeaRuntime,
  tool: DeepSeekTool,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!runtime.current()?.user)
    throw new WebSearchError(
      "请先登录 TokenToSea，再使用 DeepSeek 搜索。",
      "TOKENTOSEA_LOGIN_REQUIRED",
      401,
    );
  const model = nativeModel(await runtime.models(), tool);
  if (!model)
    throw new WebSearchError(
      "当前 TokenToSea 账号没有可用的 DeepSeek 原生搜索接口，请刷新授权或配置自定义 API。",
      "DEEPSEEK_UNAVAILABLE",
      422,
    );
  signal.throwIfAborted();
  const budget = await runtime.authorizationBudget();
  if (!Number.isFinite(budget) || budget < 0.000001)
    throw new WebSearchError(
      "TokenToSea 可用授权额度不足。",
      "TOKENTOSEA_BUDGET_REQUIRED",
      402,
    );
  const packet = { input };
  const prepareInput = {
    model: model.model,
    priceVersion: model.priceVersion,
    path: `/v1/tools/${tool}`,
    mode: "json",
    requestKey: randomUUID(),
    payloadHash: createHash("sha256")
      .update(JSON.stringify(packet))
      .digest("hex"),
    maxCostUsd: Math.min(budget, 1000).toFixed(6),
  };
  let prepared: { id: string };
  try {
    prepared = await runtime.json<{ id: string }>(
      "official/prepare",
      "POST",
      prepareInput,
      {},
      signal,
    );
  } catch (error) {
    signal.throwIfAborted();
    const status = (error as { status?: number }).status;
    if (status && status < 500 && status !== 408) throw error;
    prepared = await runtime.json<{ id: string }>(
      "official/prepare",
      "POST",
      prepareInput,
      {},
      signal,
    );
  }
  if (!/^[\w-]+$/.test(prepared.id))
    throw new WebSearchError(
      "TokenToSea 返回了无效的搜索任务。",
      "INVALID_RECEIPT",
    );
  const resource = `official/runs/${prepared.id}`;
  let terminal = false;
  try {
    let run: NativeRun;
    try {
      run = await runtime.json<NativeRun>(
        `${resource}/invoke`,
        "POST",
        packet,
        {},
        signal,
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status && status < 500 && status !== 408) throw error;
      signal.throwIfAborted();
      run = await runtime.json<NativeRun>(
        resource,
        "GET",
        undefined,
        {},
        signal,
      );
    }
    while (true) {
      signal.throwIfAborted();
      if (
        run.status === "needs_review" ||
        run.billingStatus === "needs_review"
      ) {
        terminal = true;
        throw new WebSearchError(
          "TokenToSea 搜索账单仍待核验，请在 AI 用量中查看该任务。",
          "TOKENTOSEA_BILLING_PENDING",
          422,
        );
      }
      if (
        ["failed", "cancelled", "canceled", "expired"].includes(
          run.status ?? "",
        ) ||
        run.billingStatus === "failed"
      ) {
        terminal = true;
        throw new WebSearchError(
          `TokenToSea 搜索未完成${run.errorCode ? `（${run.errorCode}）` : ""}。`,
          "TOKENTOSEA_SEARCH_FAILED",
          502,
        );
      }
      if (
        run.status === "succeeded" &&
        run.billingStatus === "succeeded" &&
        run.deliveryState === "available" &&
        run.output
      ) {
        terminal = true;
        return {
          ...run.output,
          tokentosea: {
            runId: prepared.id,
            chargedUsd: run.chargedUsd ?? "0.000000",
          },
        };
      }
      await delay(500, undefined, { signal });
      run = await runtime.json<NativeRun>(
        resource,
        "GET",
        undefined,
        {},
        signal,
      );
    }
  } finally {
    if (!terminal)
      await runtime
        .json(`${resource}/cancel`, "POST", {}, {}, AbortSignal.timeout(5000))
        .catch(() => undefined);
  }
}
