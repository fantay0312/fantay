import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  SEARCH_PROVIDERS,
  SearchProviderUpdateSchema,
  searchProviderDefaults,
  searchConnectionKey,
  type NativeWebSearchInput,
  type SearchProviderConfig,
  type SearchProviderId,
  type SearchProviderUpdate,
  type SearchServiceConfig,
  type SearchServiceSettings,
} from "@open-design/contracts/api/search-service";
import {
  engineCommands,
  engineConfigurationFields,
  engineValues,
  executeEngine,
  providerConfigured,
  resolvedProvider,
  webFetch,
  webSearch,
  WebSearchError,
  createNativeSearchBridge,
  searchConfigurationFields,
  connectionMode,
  providerEngineKey,
  providerToggleKey,
  deepSeekMode,
  withDeepSeekDefaults,
  DEEPSEEK_MODE_KEY,
  type SearchTransport,
} from "@fantay/native-web-search";
import {
  invokeTokenToSeaDeepSeek,
  nativeModel,
  type DeepSeekTokenToSeaRuntime,
} from "./deepseek-tokentosea.js";
import {
  loadSearchActions,
  searchToolInvoker,
  type SearchActions,
} from "./tokentosea-search-tools.js";
import {
  resolveSearchConnections,
  type SharedSearchConfig,
} from "./search-connections.js";

export class SearchService {
  private readonly file: string;
  private accountCapabilities?: {
    accountId: string;
    at: number;
    work: Promise<{ deepseek: boolean; actions: SearchActions }>;
  };

  constructor(
    dataDir: string,
    private readonly tokenToSea?: DeepSeekTokenToSeaRuntime,
    private readonly sharedConfig?: SharedSearchConfig,
  ) {
    this.file = path.join(dataDir, "search-providers.json");
  }

  hasSavedConfig(): boolean {
    return existsSync(this.file);
  }

  read(): SearchServiceConfig {
    if (!existsSync(this.file))
      return withDeepSeekDefaults(
        { version: 1, defaultProvider: null, providers: {} },
        false,
      );
    const data = JSON.parse(
      readFileSync(this.file, "utf8"),
    ) as SearchServiceConfig;
    if (
      data.version !== 1 ||
      !data.providers ||
      typeof data.providers !== "object"
    ) {
      throw new WebSearchError(
        "搜索服务配置无法读取，请检查配置文件。",
        "INVALID_CONFIG",
        500,
      );
    }
    return withDeepSeekDefaults(data, true);
  }

  async settings(): Promise<SearchServiceSettings> {
    const saved = this.read();
    const { config, connections } = await this.resolveConnections(saved);
    const rawValues = engineValues(saved);
    const engineSecretPresence: Record<string, boolean> = {};
    const fields = searchConfigurationFields(engineConfigurationFields());
    for (const field of fields) {
      const connection = connections[field.provider as SearchProviderId];
      if (
        connection &&
        connection.mode !== "custom" &&
        !["secret", "url"].includes(field.kind) &&
        config.engineValues[field.key] !== undefined
      )
        rawValues[field.key] = config.engineValues[field.key]!;
    }
    for (const provider of SEARCH_PROVIDERS) {
      rawValues[searchConnectionKey(provider.id)] = connectionMode(
        provider.id,
        saved,
      );
      rawValues[providerToggleKey(provider.id)] =
        config.engineValues![providerToggleKey(provider.id)]!;
    }
    for (const field of fields) {
      if (!(field.key in rawValues)) rawValues[field.key] = field.default;
      if (field.kind !== "secret") continue;
      engineSecretPresence[field.key] = Boolean(rawValues[field.key]);
      rawValues[field.key] = "";
    }
    for (const key of Object.keys(rawValues)) {
      if (!/KEY|TOKEN|SECRET/.test(key)) continue;
      if (!(key in engineSecretPresence))
        engineSecretPresence[key] = Boolean(rawValues[key]);
      rawValues[key] = "";
    }
    return {
      defaultProvider: config.defaultProvider,
      engineValues: rawValues,
      engineSecretPresence,
      connections,
      deepseek: {
        mode: deepSeekMode(config),
        accountConnected: Boolean(this.tokenToSea?.current()?.user),
        accountName: this.tokenToSea?.current()?.user?.name,
      },
      providers: SEARCH_PROVIDERS.map((definition) => {
        const stored = config.providers[definition.id];
        const values = resolvedProvider(definition.id, stored);
        const secretPresence: Record<string, boolean> = {};
        for (const field of definition.fields) {
          if (field.kind !== "secret") continue;
          secretPresence[field.key] = Boolean(values[field.key]);
          values[field.key] = "";
        }
        const toggle = fields.find(
          (field) => field.provider === definition.id && field.provider_toggle,
        );
        const enabled = toggle
          ? rawValues[toggle.key] === "true"
          : (stored?.enabled ?? false);
        const configured = fields
          .filter(
            (field) =>
              field.provider === definition.id && field.kind === "secret",
          )
          .some((field) => engineSecretPresence[field.key]);
        return {
          id: definition.id,
          enabled,
          values,
          secretPresence,
          configured:
            connections[definition.id]?.available ??
            (configured || providerConfigured(definition.id, stored)),
        };
      }),
    };
  }

  private merge(
    id: SearchProviderId,
    changes: SearchProviderUpdate,
    config: SearchServiceConfig,
  ): SearchProviderConfig {
    const input = SearchProviderUpdateSchema.parse(changes);
    const definition = SEARCH_PROVIDERS.find((provider) => provider.id === id);
    if (!definition)
      throw new WebSearchError("未知搜索服务商。", "INVALID_PROVIDER", 400);
    const values = {
      ...searchProviderDefaults(id),
      ...config.providers[id]?.values,
    };
    if (id === "deepseek") {
      if (config.engineValues?.DEEPSEEK_API_URL !== undefined)
        values.baseUrl = config.engineValues.DEEPSEEK_API_URL;
      if (config.engineValues?.DEEPSEEK_API_KEY !== undefined)
        values.apiKey = config.engineValues.DEEPSEEK_API_KEY;
    }
    for (const [key, value] of Object.entries(input.values)) {
      const field = definition.fields.find(
        (candidate) => candidate.key === key,
      );
      if (!field)
        throw new WebSearchError(
          "搜索配置包含未知字段。",
          "INVALID_CONFIG",
          400,
        );
      if (field.kind === "secret" && !value) continue;
      if (field.kind === "url" && value) {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new WebSearchError(
            "请输入有效的 HTTP 或 HTTPS API 地址。",
            "INVALID_CONFIG",
            400,
          );
      }
      if (field.options && !field.options.includes(value))
        throw new WebSearchError("搜索配置选项无效。", "INVALID_CONFIG", 400);
      values[key] = value.trim();
    }
    for (const key of input.clearSecrets) {
      if (
        !definition.fields.some(
          (field) => field.key === key && field.kind === "secret",
        )
      )
        throw new WebSearchError("清除密钥的字段无效。", "INVALID_CONFIG", 400);
      delete values[key];
    }
    if (
      id === "openai-compatible" &&
      values.apiMode === "chat-completions" &&
      values.tools
    ) {
      throw new WebSearchError(
        "Chat Completions 模式请清空联网工具，或选择 Responses 协议。",
        "INVALID_CONFIG",
        400,
      );
    }
    return { enabled: input.enabled, values };
  }

  update(
    id: SearchProviderId,
    changes: SearchProviderUpdate,
  ): Promise<SearchServiceSettings> {
    const config = this.read();
    const next = this.merge(id, changes, config);
    const mode = connectionMode(id, config);
    config.engineValues = {
      ...config.engineValues,
      [providerToggleKey(id)]: String(next.enabled),
    };
    config.engineValues[searchConnectionKey(id)] ??= mode;
    for (const [key, value] of Object.entries(changes.values ?? {})) {
      if (!value) continue;
      config.engineValues[providerEngineKey(id, key)] =
        next.values[key] ?? value;
    }
    for (const key of changes.clearSecrets ?? [])
      config.engineValues[providerEngineKey(id, key)] = "";
    if (Object.values(changes.values ?? {}).some(Boolean))
      config.engineValues[searchConnectionKey(id)] = "custom";
    if (id === "deepseek") {
      config.engineValues = {
        ...config.engineValues,
        DEEPSEEK_ENABLED: String(next.enabled),
      };
      if (changes.values?.baseUrl || changes.values?.apiKey) {
        config.engineValues[DEEPSEEK_MODE_KEY] = "custom";
        config.engineValues.DEEPSEEK_API_URL = next.values.baseUrl ?? "";
        config.engineValues.DEEPSEEK_API_KEY = next.values.apiKey ?? "";
      }
      if (changes.clearSecrets?.includes("apiKey"))
        config.engineValues.DEEPSEEK_API_KEY = "";
    }
    const accountConnection = connectionMode(id, config) !== "custom";
    if (next.enabled && !accountConnection && !providerConfigured(id, next))
      throw new WebSearchError(
        "请先补全此服务商的必填配置。",
        "INVALID_CONFIG",
        400,
      );
    config.providers[id] = next;
    if (changes.makeDefault) {
      if (
        !next.enabled ||
        !SEARCH_PROVIDERS.find(
          (provider) => provider.id === id,
        )?.capabilities.some((capability) => capability !== "fetch")
      ) {
        throw new WebSearchError(
          "默认搜索服务须已启用并支持搜索。",
          "INVALID_CONFIG",
          400,
        );
      }
      config.defaultProvider = id;
    } else if (!next.enabled && config.defaultProvider === id) {
      config.defaultProvider = null;
    }
    this.write(config);
    return this.settings();
  }

  private write(config: SearchServiceConfig): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(config, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, this.file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  catalog() {
    return {
      commands: engineCommands(),
      fields: searchConfigurationFields(engineConfigurationFields()),
    };
  }

  updateEngine(input: {
    values: Record<string, string>;
    clearSecrets?: string[] | undefined;
    defaultProvider?: SearchProviderId | null | undefined;
  }): Promise<SearchServiceSettings> {
    const config = this.read();
    const values = { ...config.engineValues };
    const fields = searchConfigurationFields(engineConfigurationFields());
    for (const [key, value] of Object.entries(input.values)) {
      const field = fields.find((candidate) => candidate.key === key);
      if (!field)
        throw new WebSearchError(
          "包含未知搜索引擎配置项。",
          "INVALID_CONFIG",
          400,
        );
      if (field.kind === "secret" && !value) continue;
      if (field.kind === "url" && value) {
        const url = new URL(value);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new WebSearchError("API 地址无效。", "INVALID_CONFIG", 400);
      }
      if (
        field.choices.length &&
        field.kind !== "csv" &&
        !field.choices.includes(value)
      )
        throw new WebSearchError("配置选项无效。", "INVALID_CONFIG", 400);
      values[key] = value.trim();
    }
    for (const key of input.clearSecrets ?? []) {
      if (!fields.some((field) => field.key === key && field.kind === "secret"))
        throw new WebSearchError("密钥字段无效。", "INVALID_CONFIG", 400);
      values[key] = "";
    }
    for (const provider of SEARCH_PROVIDERS) {
      const modeKey = searchConnectionKey(provider.id);
      if (modeKey in input.values) continue;
      if (
        fields.some(
          (field) =>
            field.provider === provider.id &&
            ["url", "secret"].includes(field.kind) &&
            Boolean(input.values[field.key]),
        )
      )
        values[modeKey] = "custom";
    }
    if (
      !(DEEPSEEK_MODE_KEY in input.values) &&
      [
        "DEEPSEEK_API_URL",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_SEARCH_API_URL",
        "DEEPSEEK_FETCH_API_URL",
      ].some((key) => Boolean(input.values[key]))
    ) {
      values[DEEPSEEK_MODE_KEY] = "custom";
    }
    config.engineValues = values;
    if (input.defaultProvider !== undefined)
      config.defaultProvider = input.defaultProvider;
    this.write(config);
    return this.settings();
  }

  private transport(transport?: SearchTransport): SearchTransport {
    return {
      ...transport,
      configDir: path.join(path.dirname(this.file), "search-engine"),
    };
  }

  private async resolveConnections(saved = this.read()) {
    const accountId = this.tokenToSea?.current()?.user?.id;
    let capabilities: { deepseek: boolean; actions: SearchActions } = {
      deepseek: false,
      actions: {},
    };
    if (accountId && this.tokenToSea) {
      if (
        !this.accountCapabilities ||
        this.accountCapabilities.accountId !== accountId ||
        Date.now() - this.accountCapabilities.at >= 60_000
      ) {
        const runtime = this.tokenToSea;
        this.accountCapabilities = {
          accountId,
          at: Date.now(),
          work: Promise.all([
            runtime
              .models()
              .then((models) => Boolean(nativeModel(models, "search")))
              .catch(() => false),
            loadSearchActions(runtime),
          ]).then(([deepseek, actions]) => ({ deepseek, actions })),
        };
      }
      capabilities = await this.accountCapabilities.work;
    }
    const resolved = await resolveSearchConnections(saved, {
      account: Boolean(accountId),
      ...capabilities,
      ...(this.sharedConfig ? { shared: this.sharedConfig } : {}),
      env: process.env,
    });
    // An untouched installation uses the first available search connection.
    // A saved default (including automatic routing) remains the user's choice.
    if (!this.hasSavedConfig()) {
      const preferred: SearchProviderId[] = [
        "deepseek",
        "tavily",
        "exa",
        "firecrawl",
        "xai-responses",
        "openai-compatible",
      ];
      const selected = preferred.find(
        (id) =>
          resolved.connections[id]?.available &&
          resolved.config.engineValues[providerToggleKey(id)] === "true",
      );
      if (selected) {
        resolved.config.defaultProvider = selected;
        resolved.config.engineValues.SMART_SEARCH_RESEARCH_PREFERRED_PROVIDERS =
          selected;
      }
    }
    return { ...resolved, actions: capabilities.actions };
  }

  private async withAccountBridges<T>(
    transport: SearchTransport | undefined,
    operation: (
      config: SearchServiceConfig,
      transport: SearchTransport,
    ) => Promise<T>,
  ): Promise<T> {
    const { config, connections, actions } = await this.resolveConnections();
    const options = this.transport(transport);
    const accountProviders = SEARCH_PROVIDERS.filter(
      (provider) =>
        connections[provider.id]?.source === "tokentosea" &&
        config.engineValues[providerToggleKey(provider.id)] === "true",
    );
    if (!accountProviders.length) {
      return operation(config, options);
    }
    const runtime = this.tokenToSea;
    const invokeTool = runtime ? searchToolInvoker(runtime, actions) : null;
    const bridge = await createNativeSearchBridge(
      async (route, input, signal) => {
        if (!runtime)
          throw new WebSearchError(
            "请先登录 TokenToSea，再使用 DeepSeek 搜索。",
            "TOKENTOSEA_LOGIN_REQUIRED",
            401,
          );
        if (route === "/v1/tools/search" || route === "/v1/tools/fetch")
          return invokeTokenToSeaDeepSeek(
            runtime,
            route.endsWith("search") ? "search" : "fetch",
            input,
            signal,
          );
        return invokeTool!(route, input, signal);
      },
    );
    try {
      const values = { ...config.engineValues };
      for (const provider of accountProviders) {
        values[providerEngineKey(provider.id, "apiKey")] = bridge.token;
        values[providerEngineKey(provider.id, "baseUrl")] =
          provider.id === "deepseek"
            ? bridge.apiUrl
            : `${bridge.apiUrl}/${provider.id}`;
      }
      if (accountProviders.some((provider) => provider.id === "deepseek")) {
        values.DEEPSEEK_SEARCH_API_URL = "";
        values.DEEPSEEK_FETCH_API_URL = "";
      }
      return await operation(
        {
          ...config,
          engineValues: values,
        },
        options,
      );
    } finally {
      await bridge.close();
    }
  }

  private requireDefaultAccount(
    config: SearchServiceConfig,
    provider?: SearchProviderId,
  ): void {
    const selected = provider ?? config.defaultProvider;
    if (
      selected === "deepseek" &&
      deepSeekMode(config) === "tokentosea" &&
      !this.tokenToSea?.current()?.user
    ) {
      throw new WebSearchError(
        "请先登录 TokenToSea，再使用 DeepSeek 搜索。",
        "TOKENTOSEA_LOGIN_REQUIRED",
        401,
      );
    }
    if (
      selected &&
      connectionMode(selected, config) !== "custom" &&
      config.engineValues?.[providerToggleKey(selected)] !== "true"
    ) {
      throw new WebSearchError(
        "所选搜索服务尚未启用或没有可复用的连接，请检查设置或选择自定义 API。",
        "SEARCH_CONNECTION_UNAVAILABLE",
        422,
      );
    }
  }

  search(input: NativeWebSearchInput, transport?: SearchTransport) {
    return this.withAccountBridges(transport, (config, options) => {
      this.requireDefaultAccount(config, input.provider);
      return webSearch(input, config, options);
    });
  }

  fetch(url: string, provider?: SearchProviderId, transport?: SearchTransport) {
    return this.withAccountBridges(transport, (config, options) => {
      this.requireDefaultAccount(config, provider);
      return webFetch(url, config, provider, options);
    });
  }

  execute(command: string, args: string[], transport?: SearchTransport) {
    return this.withAccountBridges(transport, (config, options) =>
      executeEngine(command, args, config, options),
    );
  }

  async models(
    id: SearchProviderId,
    values: Record<string, string> = {},
    transport?: SearchTransport,
  ) {
    if (id !== "xai-responses" && id !== "openai-compatible")
      throw new WebSearchError(
        "此搜索服务不提供模型列表。",
        "INVALID_PROVIDER",
        400,
      );
    const preview = this.read();
    preview.engineValues = { ...preview.engineValues };
    for (const [key, value] of Object.entries(values)) {
      if (value) preview.engineValues[key] = value;
    }
    const fields = searchConfigurationFields(engineConfigurationFields());
    if (
      !(searchConnectionKey(id) in values) &&
      fields.some(
        (field) =>
          field.provider === id &&
          ["secret", "url"].includes(field.kind) &&
          Boolean(values[field.key]),
      )
    )
      preview.engineValues[searchConnectionKey(id)] = "custom";
    const { config } = await this.resolveConnections(preview);
    config.engineValues[
      id === "xai-responses" ? "XAI_ENABLED" : "OPENAI_COMPATIBLE_ENABLED"
    ] = "true";
    const result = await executeEngine(
      "model/list",
      ["--provider", id],
      config,
      this.transport(transport),
    );
    if (result.ok === false)
      throw new WebSearchError(String(result.error || "读取模型列表失败。"));
    return {
      provider: id,
      models: (result.providers as Array<{ models: string[] }>).flatMap(
        (provider) => provider.models,
      ),
    };
  }
}
