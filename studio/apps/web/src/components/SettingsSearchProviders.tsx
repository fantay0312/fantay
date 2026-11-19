import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@open-design/components";
import {
  SEARCH_PROVIDERS,
  DEEPSEEK_CONNECTION_KEY,
  TOKENTOSEA_DEEPSEEK_API_URL,
  searchConnectionKey,
  type SearchEngineCommand,
  type SearchEngineConfigField,
  type SearchProviderId,
  type SearchServiceSettings,
} from "@open-design/contracts/api/search-service";
import { useI18n } from "../i18n";
import { Switch } from "../fantay/ui/switch";
import { SettingsSelect } from "./SettingsSelect";
import {
  fetchSearchCatalog,
  fetchSearchModels,
  fetchSearchSettings,
  runSearchCommand,
  saveSearchSettings,
} from "../providers/search-service";

export function SettingsSearchProviders({
  onOpenAccount,
}: { onOpenAccount?: () => void } = {}) {
  const { locale } = useI18n();
  const zh = locale.startsWith("zh");
  const copy = (chinese: string, english: string) => (zh ? chinese : english);
  const [settings, setSettings] = useState<SearchServiceSettings | null>(null);
  const [fields, setFields] = useState<SearchEngineConfigField[]>([]);
  const [commands, setCommands] = useState<SearchEngineCommand[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [clearSecrets, setClearSecrets] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState("deepseek");
  const [view, setView] = useState("providers");
  const [defaultProvider, setDefaultProvider] =
    useState<SearchProviderId | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [commandId, setCommandId] = useState("search");
  const [argumentsByName, setArgumentsByName] = useState<
    Record<string, string>
  >({});
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchSearchSettings(controller.signal),
      fetchSearchCatalog(controller.signal),
    ])
      .then(([state, catalog]) => {
        setSettings(state);
        setValues(state.engineValues);
        setDefaultProvider(state.defaultProvider);
        setSelected(state.defaultProvider ?? "deepseek");
        setFields(catalog.fields);
        setCommands(catalog.commands);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(String(cause.message));
      });
    return () => {
      controller.abort();
      requestRef.current?.abort();
    };
  }, []);

  const tokenToSeaDeepSeek =
    selected === "deepseek" &&
    (values[DEEPSEEK_CONNECTION_KEY] ??
      settings?.deepseek?.mode ??
      "tokentosea") === "tokentosea";
  const selectedProvider = SEARCH_PROVIDERS.find(
    (provider) => provider.id === selected,
  );
  const connectionKey = selectedProvider
    ? searchConnectionKey(selectedProvider.id)
    : "";
  const connection = selectedProvider
    ? settings?.connections?.[selectedProvider.id]
    : undefined;
  const automatic =
    tokenToSeaDeepSeek ||
    (values[connectionKey] ?? connection?.mode) === "auto";
  const visibleFields = useMemo(
    () =>
      fields
        .filter((field) =>
          selected === "engine"
            ? !SEARCH_PROVIDERS.some(
                (provider) => provider.id === field.provider,
              )
            : field.provider === selected ||
              (selected === "zhipu-mcp" &&
                field.provider === "zhipu-mcp-reader"),
        )
        .filter(
          (field) => !automatic || !["secret", "url"].includes(field.kind),
        ),
    [fields, selected, automatic],
  );
  const command = commands.find((item) => item.id === commandId);
  const dirty =
    changed.size > 0 ||
    clearSecrets.size > 0 ||
    defaultProvider !== settings?.defaultProvider;

  function update(key: string, value: string) {
    generation.current += 1;
    requestRef.current?.abort();
    setValues((current) => ({ ...current, [key]: value }));
    setChanged((current) => new Set(current).add(key));
    if (value)
      setClearSecrets((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    setModels([]);
    setNotice("");
  }

  async function save() {
    setBusy("save");
    setError("");
    try {
      const saved = await saveSearchSettings({
        values: Object.fromEntries(
          [...changed].map((key) => [key, values[key] ?? ""]),
        ),
        clearSecrets: [...clearSecrets],
        defaultProvider,
      });
      setSettings(saved);
      setValues(saved.engineValues);
      setChanged(new Set());
      setClearSecrets(new Set());
      setNotice(
        copy("搜索服务配置已保存。", "Search provider settings saved."),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function loadModels() {
    const token = ++generation.current;
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    setBusy("models");
    setError("");
    try {
      const data = await fetchSearchModels(
        selected as SearchProviderId,
        Object.fromEntries(
          visibleFields.map((field) => [field.key, values[field.key] ?? ""]),
        ),
        controller.signal,
      );
      if (token === generation.current) {
        setModels(data.models);
        setNotice(
          copy(
            `已读取 ${data.models.length} 个模型。`,
            `Loaded ${data.models.length} models.`,
          ),
        );
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      if (token === generation.current) setBusy("");
    }
  }

  async function execute() {
    if (!command) return;
    const args: string[] = [];
    for (const field of command.fields) {
      const value = argumentsByName[field.name] ?? "";
      if (!value.trim()) continue;
      if (field.kind === "bool") {
        if (value === "true" && field.flags[0]) args.push(field.flags[0]);
        continue;
      }
      const items = field.multiple
        ? value
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean)
        : [value];
      if (field.flags[0]) {
        if (field.nargs === "+" || field.nargs === "*")
          args.push(field.flags[0], ...items);
        else if (field.multiple)
          for (const item of items) args.push(field.flags[0], item);
        else args.push(field.flags[0], value);
      } else args.push(...items);
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy("run");
    setError("");
    setResult(null);
    try {
      setResult(await runSearchCommand(commandId, args, controller.signal));
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }

  function configField(field: SearchEngineConfigField) {
    const value = values[field.key] ?? field.default;
    const label = zh ? field.label_zh : field.label_en;
    const secret = field.kind === "secret";
    return (
      <div className="search-setting-field" key={field.key}>
        <label htmlFor={`search-${field.key}`}>{label}</label>
        {field.kind === "bool" ? (
          <Switch
            id={`search-${field.key}`}
            checked={value === "true"}
            disabled={Boolean(busy)}
            onCheckedChange={(checked) => update(field.key, String(checked))}
            aria-label={label}
          />
        ) : field.kind === "enum" ? (
          <SettingsSelect
            id={`search-${field.key}`}
            value={value}
            disabled={Boolean(busy)}
            options={field.choices.map((choice) => ({
              value: choice,
              label:
                field.key === connectionKey
                  ? choice === "tokentosea"
                    ? copy("TokenToSea（默认）", "TokenToSea (default)")
                    : choice === "auto"
                      ? copy(
                          "自动复用（默认）",
                          "Reuse available connection (default)",
                        )
                      : copy("自定义 API", "Custom API")
                  : choice,
            }))}
            onChange={(next) => update(field.key, next)}
            aria-label={label}
          />
        ) : (
          <div className="search-input-row">
            <input
              id={`search-${field.key}`}
              type={
                secret
                  ? "password"
                  : field.kind === "int" || field.kind === "float"
                    ? "number"
                    : "text"
              }
              value={clearSecrets.has(field.key) ? "" : value}
              disabled={Boolean(busy)}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                secret &&
                settings?.engineSecretPresence[field.key] &&
                !clearSecrets.has(field.key)
                  ? copy("已保存，留空保留", "Saved; leave blank to keep")
                  : field.placeholder || field.default
              }
              onChange={(event) => update(field.key, event.target.value)}
            />
            {secret && settings?.engineSecretPresence[field.key] ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={Boolean(busy)}
                onClick={() => {
                  setClearSecrets((current) => new Set(current).add(field.key));
                  update(field.key, "");
                }}
              >
                {copy("清除", "Clear")}
              </Button>
            ) : null}
          </div>
        )}
        {field.key.endsWith("_MODEL") && models.length ? (
          <SettingsSelect
            value={value}
            options={models.map((model) => ({ value: model, label: model }))}
            onChange={(next) => update(field.key, next)}
            aria-label={copy("选择模型", "Choose a model")}
          />
        ) : null}
        {field.help_zh ? <p>{zh ? field.help_zh : field.key}</p> : null}
      </div>
    );
  }

  if (!settings && !error)
    return (
      <p role="status">
        {copy("正在读取搜索服务配置…", "Loading search settings…")}
      </p>
    );
  return (
    <section
      className="search-provider-settings"
      data-testid="settings-search-providers"
    >
      <div className="search-settings-views">
        <Button
          variant={view === "providers" ? "primary" : "secondary"}
          onClick={() => setView("providers")}
        >
          {copy("服务商配置", "Provider settings")}
        </Button>
        <Button
          variant={view === "tools" ? "primary" : "secondary"}
          onClick={() => setView("tools")}
        >
          {copy("搜索与研究", "Search and research")}
        </Button>
      </div>
      {error ? (
        <p className="search-settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      {view === "providers" ? (
        <>
          <div className="search-settings-controls">
            <div className="search-setting-field">
              <label>{copy("搜索服务", "Search provider")}</label>
              <SettingsSelect
                value={selected}
                disabled={Boolean(busy)}
                options={[
                  ...SEARCH_PROVIDERS.map((provider) => ({
                    value: provider.id,
                    label: provider.name,
                  })),
                  {
                    value: "engine",
                    label: copy(
                      "意图路由与高级设置",
                      "Routing and advanced settings",
                    ),
                  },
                ]}
                onChange={(next) => {
                  setSelected(next);
                  setModels([]);
                }}
                aria-label={copy("搜索服务", "Search provider")}
              />
            </div>
            <div className="search-setting-field">
              <label>{copy("默认搜索服务", "Default search provider")}</label>
              <SettingsSelect
                value={defaultProvider ?? ""}
                disabled={Boolean(busy)}
                options={[
                  { value: "", label: copy("自动选路", "Automatic routing") },
                  ...SEARCH_PROVIDERS.filter((provider) =>
                    provider.capabilities.some(
                      (capability) => capability !== "fetch",
                    ),
                  ).map((provider) => ({
                    value: provider.id,
                    label: provider.name,
                  })),
                ]}
                onChange={(next) =>
                  setDefaultProvider(next ? (next as SearchProviderId) : null)
                }
                aria-label={copy("默认搜索服务", "Default search provider")}
              />
            </div>
          </div>
          {automatic ? (
            <div className="search-account-connection">
              <p role="status">
                {connection?.source === "shared"
                  ? copy(
                      "复用 Fantay 已有的 API 配置，无需重复填写密钥。",
                      "Reusing the API configured in Fantay. No additional key needed.",
                    )
                  : connection?.source === "environment"
                    ? copy(
                        "复用已有环境配置，无需重复填写密钥。",
                        "Reusing the existing environment configuration.",
                      )
                    : connection?.source === "tokentosea" ||
                        (!connection && settings?.deepseek?.accountConnected)
                      ? copy(
                          `使用当前 TokenToSea 账号${settings?.deepseek?.accountName ? ` · ${settings.deepseek.accountName}` : ""}`,
                          "Using the signed-in TokenToSea account",
                        )
                      : copy(
                          "暂未找到可复用的连接。可登录 TokenToSea、检查已有 API 配置，或切换自定义 API。",
                          "No reusable connection is available. Sign in to TokenToSea, check your existing API settings, or select Custom API.",
                        )}
              </p>
              {tokenToSeaDeepSeek ? <p>{TOKENTOSEA_DEEPSEEK_API_URL}</p> : null}
              {!settings?.deepseek?.accountConnected && onOpenAccount ? (
                <Button variant="secondary" onClick={onOpenAccount}>
                  {copy("打开账户设置", "Open account settings")}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="search-provider-fields">
            {visibleFields.map(configField)}
          </div>
          <div className="search-settings-actions">
            <Button
              variant="primary"
              disabled={!dirty || Boolean(busy)}
              onClick={() => {
                void save();
              }}
            >
              {busy === "save"
                ? copy("保存中…", "Saving…")
                : copy("保存配置", "Save settings")}
            </Button>
            {["xai-responses", "openai-compatible"].includes(selected) ? (
              <Button
                variant="secondary"
                disabled={Boolean(busy)}
                onClick={() => {
                  void loadModels();
                }}
              >
                {busy === "models"
                  ? copy("读取中…", "Loading…")
                  : copy("读取模型列表", "Load models")}
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <div className="search-setting-field">
            <label>{copy("工具", "Tool")}</label>
            <SettingsSelect
              value={commandId}
              disabled={Boolean(busy)}
              options={commands.map((item) => ({
                value: item.id,
                label: item.label,
              }))}
              onChange={(next) => {
                setCommandId(next);
                setArgumentsByName({});
                setResult(null);
              }}
              aria-label={copy("工具", "Tool")}
            />
          </div>
          <p className="search-command-description">{command?.description}</p>
          <div className="search-provider-fields">
            {command?.fields.map((field) => (
              <div className="search-setting-field" key={field.name}>
                <label htmlFor={`search-command-${field.name}`}>
                  {field.label}
                  {field.required ? " *" : ""}
                </label>
                {field.kind === "bool" ? (
                  <Switch
                    id={`search-command-${field.name}`}
                    checked={argumentsByName[field.name] === "true"}
                    onCheckedChange={(checked) =>
                      setArgumentsByName((current) => ({
                        ...current,
                        [field.name]: String(checked),
                      }))
                    }
                    aria-label={field.label}
                  />
                ) : field.choices.length ? (
                  <SettingsSelect
                    value={argumentsByName[field.name] ?? ""}
                    options={[
                      { value: "", label: copy("默认", "Default") },
                      ...field.choices.map((choice) => ({
                        value: String(choice),
                        label: String(choice),
                      })),
                    ]}
                    onChange={(next) =>
                      setArgumentsByName((current) => ({
                        ...current,
                        [field.name]: next,
                      }))
                    }
                    aria-label={field.label}
                  />
                ) : (
                  <textarea
                    id={`search-command-${field.name}`}
                    rows={field.name === "query" ? 3 : 1}
                    value={argumentsByName[field.name] ?? ""}
                    placeholder={
                      field.default == null ? "" : String(field.default)
                    }
                    disabled={Boolean(busy)}
                    onChange={(event) =>
                      setArgumentsByName((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                  />
                )}
                {field.help ? <p>{field.help}</p> : null}
              </div>
            ))}
          </div>
          <div className="search-settings-actions">
            <Button
              variant="primary"
              disabled={Boolean(busy) || dirty}
              onClick={() => {
                void execute();
              }}
            >
              {busy === "run"
                ? copy("执行中…", "Running…")
                : copy("运行工具", "Run tool")}
            </Button>
            {busy === "run" ? (
              <Button
                variant="secondary"
                onClick={() => requestRef.current?.abort()}
              >
                {copy("停止", "Stop")}
              </Button>
            ) : null}
            {dirty ? (
              <span>{copy("请先保存配置", "Save settings first")}</span>
            ) : null}
          </div>
          {result ? (
            <div className="search-tool-result">
              <pre>
                {String(
                  result.display_text ||
                    result.content ||
                    JSON.stringify(result, null, 2),
                )}
              </pre>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
