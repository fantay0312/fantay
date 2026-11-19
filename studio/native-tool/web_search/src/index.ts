import {
  NativeWebSearchInputSchema,
  type NativeWebFetchResult,
  type NativeWebSearchInput,
  type NativeWebSearchResult,
  type SearchProviderConfig,
  type SearchProviderId,
  type SearchServiceConfig,
} from "@open-design/contracts/api/search-service";
import {
  executeEngine,
  WebSearchError,
  type EngineResult,
  type SearchTransport,
} from "./engine.js";
import { engineValues, onlyProviderValues } from './configuration.js';

export * from "./configuration.js";
export * from "./engine.js";
export * from './deepseek-bridge.js';
export * from './deepseek-config.js';
export * from './connections.js';

function assertSuccess(result: EngineResult): void {
  if (result.ok === false)
    throw new WebSearchError(
      String(result.error || result.message || "搜索未完成。"),
      String(result.error_type || "SEARCH_FAILED"),
      502,
    );
}

export async function webSearch(
  input: NativeWebSearchInput,
  config: SearchServiceConfig,
  transport: SearchTransport = {},
): Promise<NativeWebSearchResult> {
  const parsed = NativeWebSearchInputSchema.parse(input);
  const args = [parsed.query, "--extra-sources", String(parsed.maxResults)];
  if (parsed.provider) args.push("--providers", parsed.provider);
  const data = await executeEngine("search", args, config, transport);
  assertSuccess(data);
  const rawSources = [
    data.sources,
    data.primary_sources,
    data.citations,
  ].flatMap((value) => (Array.isArray(value) ? value : []));
  const sources = new Map<string, NativeWebSearchResult["sources"][number]>();
  for (const value of rawSources) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    const url = String(row.url || row.link || "");
    if (!/^https?:\/\//.test(url) || sources.has(url)) continue;
    sources.set(url, {
      url,
      title: String(row.title || url),
      snippet: String(row.content || row.description || row.extracts || ""),
      provider: String(data.provider || "smart-search"),
    });
  }
  return {
    query: parsed.query,
    summary: String(data.content || data.answer || ""),
    sources: [...sources.values()].slice(0, parsed.maxResults),
    provider: String(data.provider || "smart-search"),
    depth: "shallow",
    fetchedAt: Date.now(),
  };
}

export async function webFetch(
  url: string,
  config: SearchServiceConfig,
  provider?: SearchProviderId,
  transport: SearchTransport = {},
): Promise<NativeWebFetchResult> {
  const selectedConfig = provider ? { ...config, engineValues: { ...engineValues(config), ...onlyProviderValues(provider) } } : config;
  const data = await executeEngine("fetch", [url], selectedConfig, transport);
  assertSuccess(data);
  return {
    url,
    title: String(data.title || url),
    content: String(data.content || ""),
    provider:
      provider ?? (String(data.provider || "tavily") as SearchProviderId),
    fetchedAt: Date.now(),
  };
}

export async function listProviderModels(
  id: SearchProviderId,
  provider: SearchProviderConfig,
  transport: SearchTransport = {},
): Promise<string[]> {
  const config: SearchServiceConfig = {
    version: 1,
    defaultProvider: null,
    providers: { [id]: provider },
  };
  const result = await executeEngine(
    "model/list",
    ["--provider", id],
    config,
    transport,
  );
  assertSuccess(result);
  return (result.providers as Array<{ models: string[] }>).flatMap(
    (item) => item.models,
  );
}
