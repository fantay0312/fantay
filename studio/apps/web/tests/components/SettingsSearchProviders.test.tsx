// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SettingsSearchProviders } from "../../src/components/SettingsSearchProviders";

vi.mock("../../src/i18n", () => ({
  useI18n: () => ({ locale: "zh-CN" }),
  useT: () => (key: string) => key,
}));
vi.mock("../../src/components/SettingsSelect", () => ({
  SettingsSelect: (props: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    "aria-label"?: string;
  }) => (
    <select
      aria-label={props["aria-label"]}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const state = {
  defaultProvider: "xai-responses",
  providers: [],
  engineValues: {
    XAI_API_KEY: "",
    XAI_API_URL: "https://example.org/v1",
    XAI_MODEL: "saved-model",
  },
  engineSecretPresence: { XAI_API_KEY: true },
};
const fields = [
  {
    key: "XAI_API_KEY",
    provider: "xai-responses",
    label_zh: "API Key",
    label_en: "API Key",
    help_zh: "",
    kind: "secret",
    default: "",
    choices: [],
    section: "getting_started",
  },
  {
    key: "XAI_MODEL",
    provider: "xai-responses",
    label_zh: "模型",
    label_en: "Model",
    help_zh: "",
    kind: "text",
    default: "saved-model",
    choices: [],
    section: "getting_started",
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps saved credentials masked and saves edited model settings", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/catalog"))
      return Response.json({ commands: [], fields });
    if (init?.method === "PUT")
      return Response.json({
        ...state,
        engineValues: { ...state.engineValues, XAI_MODEL: "custom-model" },
      });
    return Response.json(state);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsSearchProviders />);
  const key = await screen.findByLabelText("API Key");
  expect((key as HTMLInputElement).value).toBe("");
  expect((key as HTMLInputElement).placeholder).toContain("已保存");
  fireEvent.change(screen.getByLabelText("模型"), {
    target: { value: "custom-model" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PUT")).toBe(
      true,
    ),
  );
  const save = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
  expect(JSON.parse(String(save?.[1]?.body)).values).toEqual({
    XAI_MODEL: "custom-model",
  });
  await screen.findByText("搜索服务配置已保存。");
});

it("loads a configurable provider model catalog without saving secrets", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/catalog"))
      return Response.json({ commands: [], fields });
    if (url.endsWith("/models"))
      return Response.json({ models: ["custom-model"] });
    return Response.json(state);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsSearchProviders />);
  await screen.findByLabelText("API Key");
  fireEvent.click(screen.getByRole("button", { name: "读取模型列表" }));
  await screen.findByText("已读取 1 个模型。");
  expect(screen.getByLabelText("选择模型")).toBeTruthy();
});

it("uses the TokenToSea account by default and exposes custom native endpoints on selection", async () => {
  const deepseekFields = [
    {
      key: "FANTAY_DEEPSEEK_MODE",
      provider: "deepseek",
      label_zh: "连接方式",
      label_en: "Connection",
      help_zh: "",
      kind: "enum",
      default: "tokentosea",
      choices: ["tokentosea", "custom"],
      section: "providers",
    },
    {
      key: "DEEPSEEK_API_KEY",
      provider: "deepseek",
      label_zh: "DeepSeek API Key",
      label_en: "DeepSeek API Key",
      help_zh: "",
      kind: "secret",
      default: "",
      choices: [],
      section: "providers",
    },
    {
      key: "DEEPSEEK_API_URL",
      provider: "deepseek",
      label_zh: "DeepSeek 地址",
      label_en: "URL",
      help_zh: "",
      kind: "url",
      default: "https://api.tokentosea.com",
      choices: [],
      section: "providers",
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/catalog")
        ? Response.json({ commands: [], fields: deepseekFields })
        : Response.json({
            ...state,
            defaultProvider: "deepseek",
            engineValues: { FANTAY_DEEPSEEK_MODE: "tokentosea" },
            deepseek: {
              mode: "tokentosea",
              accountConnected: true,
              accountName: "Test account",
            },
          }),
    ),
  );
  render(<SettingsSearchProviders />);
  await screen.findByText("使用当前 TokenToSea 账号 · Test account");
  expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();
  fireEvent.change(screen.getByLabelText("连接方式"), {
    target: { value: "custom" },
  });
  expect(screen.getByLabelText("DeepSeek API Key")).toBeTruthy();
  expect(screen.getByLabelText("DeepSeek 地址")).toBeTruthy();
});

it("shows automatic connection sources and keeps custom credentials available when switching", async () => {
  const autoFields = [
    {
      ...fields[0]!,
      key: "FANTAY_EXA_MODE",
      provider: "exa",
      label_zh: "连接方式",
      kind: "enum",
      choices: ["auto", "custom"],
      default: "auto",
    },
    {
      ...fields[0]!,
      key: "EXA_API_KEY",
      provider: "exa",
      label_zh: "Exa API Key",
    },
  ];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/catalog"))
      return Response.json({ commands: [], fields: autoFields });
    return Response.json({
      ...state,
      defaultProvider: "exa",
      engineValues: {
        FANTAY_EXA_MODE: init?.method === "PUT" ? "custom" : "auto",
        EXA_API_KEY: "",
      },
      engineSecretPresence: { EXA_API_KEY: true },
      connections: {
        exa: { mode: "auto", source: "tokentosea", available: true },
      },
      deepseek: {
        mode: "tokentosea",
        accountConnected: true,
        accountName: "Account A",
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SettingsSearchProviders />);
  await screen.findByText("使用当前 TokenToSea 账号 · Account A");
  expect(screen.queryByLabelText("Exa API Key")).toBeNull();
  fireEvent.change(screen.getByLabelText("连接方式"), {
    target: { value: "custom" },
  });
  expect(
    (screen.getByLabelText("Exa API Key") as HTMLInputElement).placeholder,
  ).toContain("已保存");
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
  await screen.findByText("搜索服务配置已保存。");
  const save = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
  expect(JSON.parse(String(save?.[1]?.body)).values).toEqual({
    FANTAY_EXA_MODE: "custom",
  });
});
