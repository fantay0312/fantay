import {
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_PREFIX,
  searchProviderDefaults,
  type SearchProviderId,
  type SearchProviderConfig,
  type SearchServiceConfig,
} from "@open-design/contracts/api/search-service";

const PREFIX = SEARCH_PROVIDER_PREFIX;

export function onlyProviderValues(
  selected: SearchProviderId,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(PREFIX).map(([id, prefix]) => [
        `${prefix}_ENABLED`,
        String(id === selected),
      ]),
    ),
    ZHIPU_MCP_READER_ENABLED: String(selected === "zhipu-mcp"),
  };
}
const OVERRIDES: Partial<Record<SearchProviderId, Record<string, string>>> = {
  exa: { baseUrl: "EXA_BASE_URL" },
  context7: { baseUrl: "CONTEXT7_BASE_URL" },
  jina: { baseUrl: "JINA_READER_API_URL" },
  zhipu: { engine: "ZHIPU_SEARCH_ENGINE" },
  "zhipu-mcp": {
    baseUrl: "ZHIPU_MCP_SEARCH_API_URL",
    fetchUrl: "ZHIPU_MCP_READER_API_URL",
    docsUrl: "ZHIPU_MCP_ZREAD_API_URL",
  },
  tinyfish: {
    baseUrl: "TINYFISH_SEARCH_API_URL",
    fetchUrl: "TINYFISH_FETCH_API_URL",
  },
  sciverse: { apiKey: "SCIVERSE_API_TOKEN" },
};

export function providerEngineKey(id: SearchProviderId, key: string): string {
  const suffix =
    key === "baseUrl"
      ? "API_URL"
      : key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
  return OVERRIDES[id]?.[key] ?? `${PREFIX[id]}_${suffix}`;
}

export function resolvedProvider(
  id: SearchProviderId,
  config?: SearchProviderConfig,
): Record<string, string> {
  return { ...searchProviderDefaults(id), ...config?.values };
}

export function providerConfigured(
  id: SearchProviderId,
  config?: SearchProviderConfig,
): boolean {
  const definition = SEARCH_PROVIDERS.find((provider) => provider.id === id)!;
  const values = resolvedProvider(id, config);
  return definition.fields.every(
    (field) => !field.required || Boolean(values[field.key]?.trim()),
  );
}

export function engineValues(
  config: SearchServiceConfig,
): Record<string, string> {
  const values: Record<string, string> = {
    SMART_SEARCH_INTENT_ROUTER: "local",
  };
  for (const provider of SEARCH_PROVIDERS) {
    const saved = config.providers[provider.id];
    const prefix = PREFIX[provider.id];
    values[`${prefix}_ENABLED`] = String(saved?.enabled ?? false);
    if (!saved) continue;
    for (const [key, value] of Object.entries(
      resolvedProvider(provider.id, saved),
    )) {
      const name = providerEngineKey(provider.id, key);
      if (key !== "domain") values[name] = value;
    }
    if (provider.id === "zhipu-mcp")
      values.ZHIPU_MCP_READER_ENABLED = String(saved.enabled);
  }
  if (config.defaultProvider)
    values.SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS = config.defaultProvider;
  return { ...values, ...config.engineValues };
}
