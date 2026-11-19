import {
  SEARCH_PROVIDERS,
  searchConnectionKey,
  type SearchProviderId,
  type SearchServiceConfig,
  type SearchProviderConnection,
} from "@open-design/contracts/api/search-service";
import {
  connectionMode,
  engineConfigurationFields,
  engineValues,
  providerEngineKey,
  providerToggleKey,
} from "@fantay/native-web-search";
import type { SearchActions } from "./tokentosea-search-tools.js";

export type SharedSearchConfig = (
  provider: string,
) => Promise<{ apiKey?: string; baseUrl?: string; model?: string }>;
const SHARED: Partial<Record<SearchProviderId, string>> = {
  "xai-responses": "grok",
  "openai-compatible": "openai",
  tavily: "tavily",
};

export async function resolveSearchConnections(
  config: SearchServiceConfig,
  options: {
    account: boolean;
    deepseek: boolean;
    actions: SearchActions;
    shared?: SharedSearchConfig;
    env: NodeJS.ProcessEnv;
  },
) {
  const fields = engineConfigurationFields();
  const values = engineValues(config);
  const connections: Partial<
    Record<SearchProviderId, SearchProviderConnection>
  > = {};
  await Promise.all(
    SEARCH_PROVIDERS.map(async (provider) => {
      const id = provider.id;
      const mode = connectionMode(id, config);
      const ownFields = fields.filter(
        (field) =>
          field.provider === id ||
          (id === "zhipu-mcp" && field.provider === "zhipu-mcp-reader"),
      );
      const isConfigured = () =>
        ownFields.some(
          (field) =>
            field.kind === "secret" && Boolean(values[field.key]?.trim()),
        );
      const requiredConfigured = () =>
        provider.fields.every(
          (field) =>
            !field.required ||
            Boolean(values[providerEngineKey(id, field.key)] ?? field.default),
        );
      if (mode !== "custom") {
        for (const field of ownFields) {
          if (field.kind === "secret" || field.kind === "url")
            values[field.key] = field.default;
        }
      }
      let source: SearchProviderConnection["source"] = "unavailable";
      let available = false;
      if (mode === "custom") {
        source = "custom";
        available = isConfigured() && requiredConfigured();
      } else if (
        (id === "deepseek" && options.deepseek) ||
        (id === "exa" && options.actions["/exa/search"]) ||
        (id === "firecrawl" &&
          options.actions["/firecrawl/search"] &&
          options.actions["/firecrawl/scrape"]) ||
        (id === "tavily" && options.actions["/tavily/search"])
      ) {
        source = "tokentosea";
        available = true;
      } else if (mode === "auto") {
        // Resolve a complete credential/address pair from one source. Never send
        // a borrowed key to a user-supplied search endpoint.
        for (const field of ownFields)
          values[field.key] =
            field.kind === "secret" || field.kind === "url"
              ? field.default
              : (config.engineValues?.[field.key] ?? field.default);
        const environment = Object.fromEntries(
          ownFields
            .filter((field) => Boolean(options.env[field.key]?.trim()))
            .map((field) => [field.key, options.env[field.key]!.trim()]),
        );
        if (
          ownFields.some(
            (field) => field.kind === "secret" && environment[field.key],
          )
        ) {
          Object.assign(values, environment);
          source = "environment";
        } else if (SHARED[id] && options.shared) {
          const shared = await options
            .shared(SHARED[id]!)
            .catch(() => ({}) as Awaited<ReturnType<SharedSearchConfig>>);
          if (shared.apiKey) {
            values[providerEngineKey(id, "apiKey")] = shared.apiKey;
            values[providerEngineKey(id, "baseUrl")] =
              shared.baseUrl ||
              provider.fields.find((field) => field.key === "baseUrl")
                ?.default ||
              "";
            source = "shared";
            // Image-generation model choices are not search model choices.
            // OpenAI automatic search needs an explicit compatible search model.
            if (id === "openai-compatible")
              values.OPENAI_COMPATIBLE_MODEL =
                config.engineValues?.OPENAI_COMPATIBLE_MODEL ??
                options.env.OPENAI_COMPATIBLE_MODEL ??
                "";
          }
        }
        if (id === "openai-compatible") {
          values.OPENAI_COMPATIBLE_API_MODE =
            config.engineValues?.OPENAI_COMPATIBLE_API_MODE ??
            options.env.OPENAI_COMPATIBLE_API_MODE ??
            "responses";
          values.OPENAI_COMPATIBLE_TOOLS =
            config.engineValues?.OPENAI_COMPATIBLE_TOOLS ??
            options.env.OPENAI_COMPATIBLE_TOOLS ??
            "web_search";
        }
        available =
          isConfigured() &&
          requiredConfigured() &&
          (id !== "openai-compatible" ||
            (Boolean(values.OPENAI_COMPATIBLE_MODEL) &&
              values.OPENAI_COMPATIBLE_API_MODE === "responses" &&
              values
                .OPENAI_COMPATIBLE_TOOLS!.split(",")
                .some((tool) =>
                  ["web_search", "web_search_preview"].includes(tool.trim()),
                )));
      }
      const toggle = providerToggleKey(id);
      const explicitToggle =
        config.engineValues?.[toggle] ??
        (config.providers[id]
          ? String(config.providers[id]!.enabled)
          : undefined);
      if (mode !== "custom")
        values[toggle] = String(
          available &&
            (explicitToggle === undefined ||
              ["true", "1", "yes"].includes(explicitToggle)),
        );
      if (id === "zhipu-mcp" && mode !== "custom")
        values.ZHIPU_MCP_READER_ENABLED =
          config.engineValues?.ZHIPU_MCP_READER_ENABLED ?? values[toggle]!;
      values[searchConnectionKey(id)] = mode;
      connections[id] = { mode, source, available };
    }),
  );
  return { config: { ...config, engineValues: values }, connections };
}
