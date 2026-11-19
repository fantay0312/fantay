import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSearchError } from "@fantay/native-web-search";
import type { DeepSeekTokenToSeaRuntime } from "./deepseek-tokentosea.js";

// Public action IDs from TokenToSea's curated catalog. Availability is always
// checked through the current account; the catalog snapshot is not authority.
export const TOKENTOSEA_SEARCH_ACTIONS = {
  "/exa/search": "act_29770b294e52b4e5dc75078bf146f582",
  "/exa/search/deep": "act_43bd511cd4d01c3c625db308306d424b",
  "/firecrawl/search": "act_c38dbc7eef84c12ef8079115daddb2a1",
  "/firecrawl/scrape": "act_83d02a8fd5aa9379d09ac68a954823f2",
  "/tavily/search": "act_e14bb37ca9fbecc569946e65e5aebddc",
} as const;
export type SearchActionRoute = keyof typeof TOKENTOSEA_SEARCH_ACTIONS;
export interface SearchAction {
  id: string;
  enabled: boolean;
  requiresQuote: boolean;
}
export type SearchActions = Partial<Record<SearchActionRoute, SearchAction>>;

export async function loadSearchActions(
  runtime: DeepSeekTokenToSeaRuntime,
): Promise<SearchActions> {
  if (!runtime.current()?.user) return {};
  const rows = await Promise.all(
    Object.entries(TOKENTOSEA_SEARCH_ACTIONS).map(async ([route, id]) => {
      try {
        const action = await runtime.json<SearchAction>(
          "tools/describe",
          "POST",
          { actionId: id },
          {},
          AbortSignal.timeout(8000),
        );
        return action.id === id && action.enabled && action.requiresQuote
          ? ([route, action] as const)
          : null;
      } catch {
        return null;
      }
    }),
  );
  return Object.fromEntries(rows.filter((row) => row !== null));
}

function toolInput(
  route: string,
  input: Record<string, unknown>,
): { route: SearchActionRoute; input: { body: Record<string, unknown> } } {
  let body = { ...input };
  if (route === "/exa/search") {
    delete body.useAutoprompt;
    if (!body.type || body.type === "neural" || body.type === "keyword")
      body.type = "auto";
    if (String(body.type).startsWith("deep")) route = "/exa/search/deep";
  } else if (route === "/firecrawl/search") {
    body.limit = Math.max(1, Math.min(10, Number(body.limit) || 5));
  } else if (route === "/firecrawl/scrape") {
    // The marketplace scrape operation exposes these fields, not the direct
    // API's timeout/waitFor controls. Keep retries bound to the same input.
    body = {
      url: body.url,
      formats: body.formats ?? ["markdown"],
      parsers: [],
    };
  } else if (route === "/tavily/search") {
    body.include_usage = true;
  }
  if (!(route in TOKENTOSEA_SEARCH_ACTIONS))
    throw new WebSearchError(
      "TokenToSea 暂未提供此操作，请使用其他服务或切换自定义配置。",
      "SEARCH_OPERATION_UNAVAILABLE",
      422,
    );
  return { route: route as SearchActionRoute, input: { body } };
}

interface ToolRun {
  id: string;
  status: string;
  output?: unknown;
  pendingConfirmation?: boolean;
  chargedUsd?: string;
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function outputFor(route: string, value: unknown): Record<string, unknown> {
  // Tool service removes transport envelopes. Some routes retain a data
  // wrapper; keep native Firecrawl's data wrapper, unwrap Exa/Tavily's.
  if (!object(value))
    throw new WebSearchError(
      "TokenToSea 搜索返回格式无效。",
      "INVALID_SEARCH_RESULT",
    );
  if (route.startsWith("/firecrawl/")) {
    if (object(value.data) && ("web" in value.data || "markdown" in value.data))
      return value;
    if ("web" in value || "markdown" in value)
      return { success: true, data: value };
    if (Array.isArray(value.data))
      return { success: true, data: { web: value.data } };
  }
  if (object(value.data) && !Array.isArray(value.results)) return value.data;
  return value;
}

/** One instance per engine run: retries reuse the same paid operation. */
export function searchToolInvoker(
  runtime: DeepSeekTokenToSeaRuntime,
  actions: SearchActions,
) {
  const requests = new Map<string, Promise<Record<string, unknown>>>();
  return (
    route: string,
    rawInput: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    const prepared = toolInput(route, rawInput);
    const key = JSON.stringify(prepared);
    let work = requests.get(key);
    if (!work) {
      work = invoke(runtime, actions, prepared.route, prepared.input, signal);
      requests.set(key, work);
    }
    return work;
  };
}

async function invoke(
  runtime: DeepSeekTokenToSeaRuntime,
  actions: SearchActions,
  route: SearchActionRoute,
  input: { body: Record<string, unknown> },
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const action = actions[route];
  if (!runtime.current()?.user || !action)
    throw new WebSearchError(
      "当前 TokenToSea 账号没有可用的此项搜索操作，请使用其他服务或自定义配置。",
      "SEARCH_OPERATION_UNAVAILABLE",
      422,
    );
  const maximum = await runtime.authorizationBudget();
  if (!Number.isFinite(maximum) || maximum <= 0)
    throw new WebSearchError(
      "TokenToSea 可用授权额度不足。",
      "TOKENTOSEA_BUDGET_REQUIRED",
      402,
    );
  const quote = await runtime.json<{
    id: string;
    actionId: string;
    priceVersion: string;
    reserveUsd: string;
  }>("tools/quote", "POST", { actionId: action.id, input }, {}, signal);
  const reserve = Number(quote.reserveUsd);
  if (
    !quote.id ||
    quote.actionId !== action.id ||
    quote.priceVersion !== `quote:${quote.id}` ||
    !Number.isFinite(reserve) ||
    reserve < 0
  )
    throw new WebSearchError(
      "TokenToSea 返回了无效的搜索报价。",
      "INVALID_SEARCH_QUOTE",
      422,
    );
  if (reserve > maximum)
    throw new WebSearchError(
      "本次搜索报价超过 TokenToSea 可用授权额度。",
      "TOKENTOSEA_BUDGET_REQUIRED",
      402,
    );
  const packet = {
    actionId: action.id,
    input,
    requestKey: randomUUID(),
    priceVersion: quote.priceVersion,
    quoteId: quote.id,
    maxCostUsd: reserve.toFixed(6),
  };
  let run: ToolRun;
  try {
    run = await runtime.json<ToolRun>(
      "tools/invoke",
      "POST",
      packet,
      {},
      signal,
    );
  } catch (error) {
    signal.throwIfAborted();
    const status = (error as { status?: number }).status;
    if (status && status < 500 && status !== 408) throw error;
    // Same request key, quote and payload recover the existing server receipt.
    run = await runtime.json<ToolRun>(
      "tools/invoke",
      "POST",
      packet,
      {},
      signal,
    );
  }
  if (!/^[\w-]+$/.test(run.id))
    throw new WebSearchError(
      "TokenToSea 返回了无效的搜索任务。",
      "INVALID_RECEIPT",
    );
  while (true) {
    signal.throwIfAborted();
    if (run.pendingConfirmation)
      throw new WebSearchError(
        "TokenToSea 搜索账单待核验，请在 AI 用量中查看。",
        "TOKENTOSEA_BILLING_PENDING",
        422,
      );
    if (run.status === "succeeded")
      return {
        ...outputFor(route, run.output),
        tokentosea: { runId: run.id, chargedUsd: run.chargedUsd },
      };
    if (run.status !== "running")
      throw new WebSearchError(
        "TokenToSea 搜索未完成，请查看 AI 用量记录。",
        "TOKENTOSEA_SEARCH_FAILED",
        422,
      );
    await delay(500, undefined, { signal });
    run = await runtime.json<ToolRun>(
      `tools/runs/${run.id}`,
      "GET",
      undefined,
      {},
      signal,
    );
  }
}
