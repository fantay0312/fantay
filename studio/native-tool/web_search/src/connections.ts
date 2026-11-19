import {
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_PREFIX,
  searchConnectionKey,
  type SearchProviderId,
  type SearchConnectionMode,
  type SearchServiceConfig,
  type SearchEngineConfigField,
} from "@open-design/contracts/api/search-service";
import { providerEngineKey } from "./configuration.js";
import { deepSeekConfigurationFields } from "./deepseek-config.js";

export function connectionMode(
  id: SearchProviderId,
  config: SearchServiceConfig,
): SearchConnectionMode {
  const mode = config.engineValues?.[searchConnectionKey(id)];
  if (
    mode === "auto" ||
    mode === "custom" ||
    (id === "deepseek" && mode === "tokentosea")
  )
    return mode;
  const provider = SEARCH_PROVIDERS.find((item) => item.id === id)!;
  const custom = provider.fields.some(
    (field) =>
      (field.kind === "secret" || field.kind === "url") &&
      Boolean(
        config.providers[id]?.values[field.key] ||
        config.engineValues?.[providerEngineKey(id, field.key)],
      ),
  );
  return custom ? "custom" : "auto";
}

export function searchConfigurationFields(
  fields: SearchEngineConfigField[],
): SearchEngineConfigField[] {
  const result = deepSeekConfigurationFields(fields);
  for (const provider of SEARCH_PROVIDERS) {
    if (provider.id === "deepseek") continue;
    result.splice(
      Math.max(
        0,
        result.findIndex((field) => field.provider === provider.id),
      ),
      0,
      {
        key: searchConnectionKey(provider.id),
        provider: provider.id,
        section: "providers",
        kind: "enum",
        default: "auto",
        choices: ["auto", "custom"],
        label_zh: "连接方式",
        label_en: "Connection",
        help_zh:
          "自动复用可用的 TokenToSea 服务或已有 API 配置；也可单独填写自定义配置。",
      },
    );
  }
  return result;
}

export function providerToggleKey(id: SearchProviderId): string {
  return `${SEARCH_PROVIDER_PREFIX[id]}_ENABLED`;
}
