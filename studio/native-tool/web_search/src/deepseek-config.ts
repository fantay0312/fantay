import {
  DEEPSEEK_CONNECTION_KEY,
  TOKENTOSEA_DEEPSEEK_API_URL,
  type DeepSeekConnectionMode,
  type SearchEngineConfigField,
  type SearchServiceConfig,
} from "@open-design/contracts/api/search-service";

export const DEEPSEEK_MODE_KEY = DEEPSEEK_CONNECTION_KEY;

export function withDeepSeekDefaults(
  config: SearchServiceConfig,
  existing: boolean,
): SearchServiceConfig {
  const values = { ...config.engineValues };
  const provider = config.providers.deepseek;
  const previousCustom = Boolean(
    provider ||
    values.DEEPSEEK_API_KEY ||
    values.DEEPSEEK_API_URL ||
    values.DEEPSEEK_SEARCH_API_URL ||
    values.DEEPSEEK_FETCH_API_URL,
  );
  const mode =
    values[DEEPSEEK_MODE_KEY] ?? (previousCustom ? "custom" : "tokentosea");
  return {
    ...config,
    defaultProvider: existing ? config.defaultProvider : "deepseek",
    engineValues: {
      DEEPSEEK_ENABLED: String(
        provider?.enabled ??
          (mode === "tokentosea" &&
            (!config.defaultProvider || config.defaultProvider === "deepseek")),
      ),
      DEEPSEEK_API_URL: provider?.values.baseUrl || TOKENTOSEA_DEEPSEEK_API_URL,
      ...values,
      [DEEPSEEK_MODE_KEY]: mode,
    },
  };
}

export function deepSeekMode(
  config: SearchServiceConfig,
): DeepSeekConnectionMode {
  return config.engineValues?.[DEEPSEEK_MODE_KEY] === "tokentosea"
    ? "tokentosea"
    : "custom";
}

export function deepSeekConfigurationFields(
  fields: SearchEngineConfigField[],
): SearchEngineConfigField[] {
  const mode: SearchEngineConfigField = {
    key: DEEPSEEK_MODE_KEY,
    provider: "deepseek",
    section: "providers",
    kind: "enum",
    default: "tokentosea",
    choices: ["tokentosea", "custom"],
    label_zh: "连接方式",
    label_en: "Connection",
    help_zh: "TokenToSea 使用当前登录账号；自定义原生 API 使用下方地址和密钥。",
  };
  const result = fields.map((field) => {
    if (field.key === "DEEPSEEK_API_URL")
      return {
        ...field,
        default: TOKENTOSEA_DEEPSEEK_API_URL,
        help_zh:
          "自定义 DeepSeek 原生 API 基础地址，例如 https://api.deepseek.com。也可填写完整原生接口地址。",
      };
    if (field.key === "DEEPSEEK_API_KEY")
      return {
        ...field,
        help_zh:
          "填写自定义原生 API 服务商的 Bearer Key。TokenToSea 账号模式使用当前账号授权。",
      };
    return field;
  });
  result.splice(
    Math.max(
      0,
      result.findIndex((field) => field.provider === "deepseek"),
    ),
    0,
    mode,
  );
  return result;
}
