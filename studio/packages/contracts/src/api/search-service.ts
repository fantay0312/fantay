import { z } from "zod";
import type { ResearchFindings } from "./research.js";

export const TOKENTOSEA_DEEPSEEK_API_URL = "https://api.tokentosea.com";
export const DEEPSEEK_CONNECTION_KEY = "FANTAY_DEEPSEEK_MODE";
export type DeepSeekConnectionMode = "tokentosea" | "custom";

export type SearchConnectionMode = "auto" | "tokentosea" | "custom";
export type SearchConnectionSource =
  | "tokentosea"
  | "shared"
  | "environment"
  | "custom"
  | "unavailable";
export interface SearchProviderConnection {
  mode: SearchConnectionMode;
  source: SearchConnectionSource;
  available: boolean;
}

export const SEARCH_PROVIDER_IDS = [
  "xai-responses",
  "openai-compatible",
  "tavily",
  "exa",
  "context7",
  "zhipu",
  "zhipu-mcp",
  "jina",
  "firecrawl",
  "tinyfish",
  "deepseek",
  "yuanbao",
  "anysearch",
  "sciverse",
] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];
export const SEARCH_PROVIDER_PREFIX: Record<SearchProviderId, string> = {
  "xai-responses": "XAI",
  "openai-compatible": "OPENAI_COMPATIBLE",
  tavily: "TAVILY",
  exa: "EXA",
  context7: "CONTEXT7",
  zhipu: "ZHIPU",
  "zhipu-mcp": "ZHIPU_MCP",
  jina: "JINA",
  firecrawl: "FIRECRAWL",
  tinyfish: "TINYFISH",
  deepseek: "DEEPSEEK",
  yuanbao: "YUANBAO",
  anysearch: "ANYSEARCH",
  sciverse: "SCIVERSE",
};
export function searchConnectionKey(id: SearchProviderId): string {
  return `FANTAY_${SEARCH_PROVIDER_PREFIX[id]}_MODE`;
}
export type SearchCapability = "search" | "fetch" | "docs" | "academic";

export interface SearchProviderField {
  key: string;
  label: string;
  kind: "text" | "secret" | "url" | "select";
  default?: string;
  placeholder?: string;
  options?: readonly string[];
  required?: boolean;
}

export interface SearchProviderDefinition {
  id: SearchProviderId;
  name: string;
  capabilities: readonly SearchCapability[];
  fields: readonly SearchProviderField[];
  experimental?: boolean;
}

const keyField: SearchProviderField = {
  key: "apiKey",
  label: "API Key",
  kind: "secret",
  required: true,
};
const endpoint = (value: string): SearchProviderField => ({
  key: "baseUrl",
  label: "API 地址",
  kind: "url",
  default: value,
  required: true,
});
const modelField: SearchProviderField = {
  key: "model",
  label: "模型",
  kind: "text",
  placeholder: "选择或输入模型 ID",
  required: true,
};
const toolsField: SearchProviderField = {
  key: "tools",
  label: "联网工具",
  kind: "text",
  placeholder: "web_search,x_search",
};

/** Shared with settings and the native executor so provider fields cannot drift. */
export const SEARCH_PROVIDERS: readonly SearchProviderDefinition[] = [
  {
    id: "xai-responses",
    name: "xAI / Grok",
    capabilities: ["search"],
    fields: [
      endpoint("https://api.x.ai/v1"),
      keyField,
      { ...modelField, default: "grok-4.20-multi-agent-0309" },
      { ...toolsField, default: "web_search,x_search" },
    ],
  },
  {
    id: "openai-compatible",
    name: "OpenAI 兼容接口",
    capabilities: ["search"],
    fields: [
      endpoint("https://api.openai.com/v1"),
      keyField,
      modelField,
      {
        key: "apiMode",
        label: "接口协议",
        kind: "select",
        default: "responses",
        options: ["responses", "chat-completions"],
      },
      { ...toolsField, default: "web_search" },
    ],
  },
  {
    id: "tavily",
    name: "Tavily",
    capabilities: ["search", "fetch"],
    fields: [endpoint("https://api.tavily.com"), keyField],
  },
  {
    id: "exa",
    name: "Exa",
    capabilities: ["search", "docs"],
    fields: [endpoint("https://api.exa.ai"), keyField],
  },
  {
    id: "context7",
    name: "Context7",
    capabilities: ["docs"],
    fields: [
      endpoint("https://context7.com"),
      { ...keyField, required: false },
    ],
  },
  {
    id: "zhipu",
    name: "智谱 Web Search",
    capabilities: ["search"],
    fields: [
      endpoint("https://open.bigmodel.cn/api"),
      keyField,
      {
        key: "engine",
        label: "搜索引擎",
        kind: "select",
        default: "search_std",
        options: [
          "search_std",
          "search_pro",
          "search_pro_sogou",
          "search_pro_quark",
        ],
      },
    ],
  },
  {
    id: "zhipu-mcp",
    name: "智谱 Coding Plan MCP",
    capabilities: ["search", "fetch", "docs"],
    fields: [
      endpoint("https://open.bigmodel.cn/api/mcp/web_search_prime/mcp"),
      keyField,
      {
        key: "fetchUrl",
        label: "网页读取接口",
        kind: "url",
        default: "https://open.bigmodel.cn/api/mcp/web_reader/mcp",
      },
      {
        key: "docsUrl",
        label: "仓库文档接口",
        kind: "url",
        default: "https://open.bigmodel.cn/api/mcp/zread/mcp",
      },
    ],
  },
  {
    id: "jina",
    name: "Jina Reader",
    capabilities: ["fetch"],
    fields: [endpoint("https://r.jina.ai"), { ...keyField, required: false }],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    capabilities: ["search", "fetch"],
    fields: [endpoint("https://api.firecrawl.dev/v2"), keyField],
  },
  {
    id: "tinyfish",
    name: "TinyFish",
    capabilities: ["search", "fetch"],
    fields: [
      endpoint("https://api.search.tinyfish.ai"),
      keyField,
      {
        key: "fetchUrl",
        label: "网页读取接口",
        kind: "url",
        default: "https://api.fetch.tinyfish.ai",
      },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek Search / Fetch",
    capabilities: ["search", "fetch"],
    fields: [endpoint(TOKENTOSEA_DEEPSEEK_API_URL), keyField],
  },
  {
    id: "yuanbao",
    name: "腾讯元宝搜索",
    capabilities: ["search"],
    fields: [
      endpoint("https://wsa.tencentcloudapi.com"),
      { key: "secretId", label: "SecretId", kind: "secret", required: true },
      { key: "secretKey", label: "SecretKey", kind: "secret", required: true },
    ],
  },
  {
    id: "anysearch",
    name: "AnySearch",
    capabilities: ["search", "fetch"],
    experimental: true,
    fields: [
      endpoint("https://api.anysearch.com/mcp"),
      { ...keyField, required: false },
      { key: "domain", label: "检索领域", kind: "text" },
    ],
  },
  {
    id: "sciverse",
    name: "SciVerse",
    capabilities: ["academic"],
    experimental: true,
    fields: [
      endpoint("https://api.sciverse.space"),
      { ...keyField, label: "API Token" },
    ],
  },
];

export interface SearchProviderConfig {
  enabled: boolean;
  values: Record<string, string>;
}
export interface SearchServiceConfig {
  version: 1;
  defaultProvider: SearchProviderId | null;
  providers: Partial<Record<SearchProviderId, SearchProviderConfig>>;
  engineValues?: Record<string, string>;
}
export interface SearchProviderView extends SearchProviderConfig {
  id: SearchProviderId;
  configured: boolean;
  secretPresence: Record<string, boolean>;
}
export interface SearchServiceSettings {
  defaultProvider: SearchProviderId | null;
  providers: SearchProviderView[];
  engineValues: Record<string, string>;
  engineSecretPresence: Record<string, boolean>;
  connections?: Partial<Record<SearchProviderId, SearchProviderConnection>>;
  deepseek?: {
    mode: DeepSeekConnectionMode;
    accountConnected: boolean;
    accountName?: string | undefined;
  };
}

export interface SearchEngineField {
  name: string;
  label: string;
  help: string;
  flags: string[];
  kind: string;
  choices: string[];
  required: boolean;
  default: unknown;
  multiple: boolean;
  nargs?: string | number | null;
}
export interface SearchEngineCommand {
  id: string;
  label: string;
  description: string;
  fields: SearchEngineField[];
  experimental: boolean;
}
export interface SearchEngineConfigField {
  key: string;
  label_zh: string;
  label_en: string;
  help_zh: string;
  kind: string;
  default: string;
  placeholder?: string;
  choices: string[];
  provider: string;
  section: string;
  provider_toggle?: boolean;
}

export const SearchProviderUpdateSchema = z.object({
  enabled: z.boolean(),
  values: z.record(z.string().max(16_384)).default({}),
  clearSecrets: z.array(z.string()).default([]),
  makeDefault: z.boolean().optional(),
});
export type SearchProviderUpdate = z.input<typeof SearchProviderUpdateSchema>;

export const NativeWebSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(12_000),
  provider: z.enum(SEARCH_PROVIDER_IDS).optional(),
  maxResults: z.number().int().min(1).max(20).default(5),
});
export type NativeWebSearchInput = z.input<typeof NativeWebSearchInputSchema>;
export type NativeWebSearchResult = ResearchFindings;
export interface NativeWebFetchResult {
  url: string;
  title: string;
  content: string;
  provider: string;
  fetchedAt: number;
}
export interface SearchProviderModels {
  provider: SearchProviderId;
  models: string[];
}

export function searchProviderDefaults(
  id: SearchProviderId,
): Record<string, string> {
  return Object.fromEntries(
    SEARCH_PROVIDERS.find((provider) => provider.id === id)!.fields.map(
      (field) => [field.key, field.default ?? ""],
    ),
  );
}
