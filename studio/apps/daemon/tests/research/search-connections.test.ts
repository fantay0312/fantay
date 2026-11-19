import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { resolveSearchConnections } from "../../src/research/search-connections.js";
import { SearchService } from "../../src/research/search-service.js";
import {
  TOKENTOSEA_SEARCH_ACTIONS,
  loadSearchActions,
  searchToolInvoker,
} from "../../src/research/tokentosea-search-tools.js";
import type { DeepSeekTokenToSeaRuntime } from "../../src/research/deepseek-tokentosea.js";
import type { SearchServiceConfig } from "@open-design/contracts/api/search-service";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const empty = (): SearchServiceConfig => ({
  version: 1,
  defaultProvider: null,
  providers: {},
});
const options = { account: false, deepseek: false, actions: {}, env: {} };
function runtime() {
  let account = "one";
  const json = vi.fn(
    async (
      resource: string,
      _method?: string,
      value?: unknown,
    ): Promise<Record<string, unknown>> => {
      const body = value as Record<string, unknown>;
      if (resource === "tools/describe")
        return {
          id: body.actionId,
          enabled: account === "one",
          requiresQuote: true,
        };
      if (resource === "tools/quote")
        return {
          id: "quote-one",
          actionId: body.actionId,
          priceVersion: "quote:quote-one",
          reserveUsd: "0.020000",
        };
      if (resource === "tools/invoke")
        return {
          id: "run-one",
          status: "succeeded",
          chargedUsd: "0.01",
          output: {
            results: [
              {
                title: "Verified",
                url: "https://example.org/source",
                text: "Example source",
              },
            ],
          },
        };
      throw new Error(`Unexpected resource ${resource}`);
    },
  );
  const value = {
    current: () => ({
      raw: "secret-session",
      user: { id: account, name: account },
    }),
    models: vi.fn(async () => []),
    authorizationBudget: vi.fn(async () => 1),
    json,
  } as unknown as DeepSeekTokenToSeaRuntime;
  return {
    value,
    json,
    account: (next: string) => {
      account = next;
    },
  };
}

it("reuses existing provider credentials without importing image model choices", async () => {
  const resolved = await resolveSearchConnections(empty(), {
    ...options,
    shared: async (id) =>
      id === "grok"
        ? {
            apiKey: "shared-key",
            baseUrl: "https://shared.example/v1",
            model: "grok-imagine-image",
          }
        : {},
  });
  expect(resolved.connections["xai-responses"]).toEqual({
    mode: "auto",
    source: "shared",
    available: true,
  });
  expect(resolved.config.engineValues).toMatchObject({
    XAI_API_KEY: "shared-key",
    XAI_API_URL: "https://shared.example/v1",
    XAI_ENABLED: "true",
  });
  expect(resolved.config.engineValues.XAI_MODEL).not.toBe("grok-imagine-image");
});

it("keeps custom endpoints isolated from shared keys and honors explicit disable", async () => {
  const shared = vi.fn(async (_id: string) => ({ apiKey: "do-not-borrow" }));
  const resolved = await resolveSearchConnections(
    {
      ...empty(),
      engineValues: {
        TAVILY_API_URL: "https://custom.example",
        TAVILY_ENABLED: "false",
      },
    },
    { ...options, shared },
  );
  expect(resolved.connections.tavily?.mode).toBe("custom");
  expect(resolved.config.engineValues.TAVILY_API_KEY).toBeUndefined();
  expect(resolved.config.engineValues.TAVILY_ENABLED).toBe("false");
  expect(shared.mock.calls.some((call) => call[0] === "tavily")).toBe(false);
});

it("reuses the official OpenAI address while requiring an explicit search model", async () => {
  const shared = async (id: string) =>
    id === "openai" ? { apiKey: "openai-key", model: "gpt-image-1" } : {};
  expect(
    (await resolveSearchConnections(empty(), { ...options, shared }))
      .connections["openai-compatible"]?.available,
  ).toBe(false);
  const resolved = await resolveSearchConnections(
    { ...empty(), engineValues: { OPENAI_COMPATIBLE_MODEL: "search-model" } },
    { ...options, shared },
  );
  expect(resolved.config.engineValues).toMatchObject({
    OPENAI_COMPATIBLE_API_URL: "https://api.openai.com/v1",
    OPENAI_COMPATIBLE_API_KEY: "openai-key",
    OPENAI_COMPATIBLE_MODEL: "search-model",
    OPENAI_COMPATIBLE_API_MODE: "responses",
    OPENAI_COMPATIBLE_TOOLS: "web_search",
  });
  expect(resolved.connections["openai-compatible"]?.available).toBe(true);
});

it("uses configured environment pairs and switches explicitly between automatic and custom", async () => {
  const config = {
    ...empty(),
    engineValues: {
      FANTAY_TAVILY_MODE: "auto",
      TAVILY_API_KEY: "saved-custom",
      TAVILY_API_URL: "https://custom.example",
      TAVILY_ENABLED: "false",
    },
  };
  const auto = await resolveSearchConnections(config, {
    ...options,
    env: {
      TAVILY_API_KEY: "environment-key",
      TAVILY_API_URL: "https://env.example",
    },
  });
  expect(auto.config.engineValues).toMatchObject({
    TAVILY_API_KEY: "environment-key",
    TAVILY_API_URL: "https://env.example",
    TAVILY_ENABLED: "false",
  });
  expect(config.engineValues.TAVILY_API_KEY).toBe("saved-custom");
  const custom = await resolveSearchConnections(
    {
      ...config,
      engineValues: { ...config.engineValues, FANTAY_TAVILY_MODE: "custom" },
    },
    options,
  );
  expect(custom.config.engineValues.TAVILY_API_KEY).toBe("saved-custom");
});

it("only enables account actions confirmed by the current account", async () => {
  const fake = runtime();
  const actions = await loadSearchActions(fake.value);
  const available = await resolveSearchConnections(empty(), {
    ...options,
    account: true,
    actions,
  });
  expect(available.connections.exa).toEqual({
    mode: "auto",
    source: "tokentosea",
    available: true,
  });
  fake.account("two");
  expect(await loadSearchActions(fake.value)).toEqual({});
});

it("keeps retained custom credentials out of disabled automatic account connections", async () => {
  const fake = runtime();
  const config = {
    ...empty(),
    engineValues: {
      FANTAY_EXA_MODE: "auto",
      EXA_API_KEY: "retained-custom-key",
      EXA_BASE_URL: "https://custom.example",
      EXA_ENABLED: "false",
    },
  };
  const resolved = await resolveSearchConnections(config, {
    ...options,
    account: true,
    actions: await loadSearchActions(fake.value),
  });
  expect(resolved.config.engineValues.EXA_ENABLED).toBe("false");
  expect(resolved.config.engineValues.EXA_API_KEY).toBe("");
  expect(resolved.config.engineValues.EXA_BASE_URL).not.toBe(
    "https://custom.example",
  );
  expect(config.engineValues.EXA_API_KEY).toBe("retained-custom-key");
});

it("quotes normalized input and reuses the same receipt on network recovery and engine retries", async () => {
  const fake = runtime();
  const actions = await loadSearchActions(fake.value);
  const original = fake.json.getMockImplementation()!;
  let failed = false;
  fake.json.mockImplementation(async (...args) => {
    if (args[0] === "tools/invoke" && !failed) {
      failed = true;
      throw new Error("connection lost");
    }
    return original(...args);
  });
  const invoke = searchToolInvoker(fake.value, actions);
  const input = {
    query: "question",
    type: "neural",
    numResults: 5,
    useAutoprompt: true,
  };
  const first = await invoke(
    "/exa/search",
    input,
    new AbortController().signal,
  );
  expect(
    await invoke("/exa/search", input, new AbortController().signal),
  ).toEqual(first);
  const quotes = fake.json.mock.calls.filter(
    (call) => call[0] === "tools/quote",
  );
  const invokes = fake.json.mock.calls.filter(
    (call) => call[0] === "tools/invoke",
  );
  expect(quotes).toHaveLength(1);
  expect(quotes[0]?.[2]).toEqual({
    actionId: TOKENTOSEA_SEARCH_ACTIONS["/exa/search"],
    input: { body: { query: "question", type: "auto", numResults: 5 } },
  });
  expect(invokes).toHaveLength(2);
  expect(invokes[0]?.[2]).toEqual(invokes[1]?.[2]);
  expect(invokes[0]?.[2]).toMatchObject({
    maxCostUsd: "0.020000",
    quoteId: "quote-one",
    priceVersion: "quote:quote-one",
  });
});

it("does not invoke a quote that exceeds the current account budget", async () => {
  const fake = runtime();
  vi.spyOn(fake.value, "authorizationBudget").mockResolvedValue(0.01);
  const invoke = searchToolInvoker(
    fake.value,
    await loadSearchActions(fake.value),
  );
  await expect(
    invoke("/exa/search", { query: "question" }, new AbortController().signal),
  ).rejects.toMatchObject({ status: 402 });
  expect(fake.json.mock.calls.some((call) => call[0] === "tools/invoke")).toBe(
    false,
  );
});

it("stops on pending billing without creating another paid call", async () => {
  const fake = runtime();
  const actions = await loadSearchActions(fake.value);
  const original = fake.json.getMockImplementation()!;
  fake.json.mockImplementation(async (...args) =>
    args[0] === "tools/invoke"
      ? { id: "pending-one", status: "running", pendingConfirmation: true }
      : original(...args),
  );
  const invoke = searchToolInvoker(fake.value, actions);
  const input = { query: "question" };
  await expect(
    invoke("/exa/search", input, new AbortController().signal),
  ).rejects.toMatchObject({ code: "TOKENTOSEA_BILLING_PENDING" });
  await expect(
    invoke("/exa/search", input, new AbortController().signal),
  ).rejects.toThrow();
  expect(
    fake.json.mock.calls.filter((call) => call[0] === "tools/invoke"),
  ).toHaveLength(1);
});

it("runs the bundled Exa engine via TokenToSea without saving account credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-account-exa-"));
  roots.push(root);
  const fake = runtime();
  const service = new SearchService(root, fake.value);
  const result = await service.search({ query: "question", provider: "exa" });
  expect(result.sources[0]?.url).toBe("https://example.org/source");
  await service.updateEngine({
    values: { FANTAY_EXA_MODE: "auto" },
    defaultProvider: "exa",
  });
  const saved = await readFile(
    path.join(root, "search-providers.json"),
    "utf8",
  );
  expect(saved).not.toContain("secret-session");
  expect(saved).not.toContain("127.0.0.1");
  expect((await service.settings()).connections?.exa?.source).toBe(
    "tokentosea",
  );
  fake.account("two");
  expect((await service.settings()).connections?.exa?.source).toBe(
    "unavailable",
  );
}, 20_000);

it("runs Firecrawl search and fetch through the corresponding quoted actions", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "search-account-firecrawl-"),
  );
  roots.push(root);
  const fake = runtime();
  const original = fake.json.getMockImplementation()!;
  fake.json.mockImplementation(async (...args) => {
    if (args[0] !== "tools/invoke") return original(...args);
    const packet = args[2] as { actionId: string };
    return {
      id: "run-firecrawl",
      status: "succeeded",
      output: {
        success: true,
        data:
          packet.actionId === TOKENTOSEA_SEARCH_ACTIONS["/firecrawl/scrape"]
            ? { markdown: "# Verified page\nNative fetch content." }
            : {
                web: [
                  {
                    title: "Verified page",
                    url: "https://example.org/page",
                    description: "Source description",
                  },
                ],
              },
      },
    };
  });
  const service = new SearchService(root, fake.value);
  expect(
    (
      await service.search({
        query: "question",
        provider: "firecrawl",
        maxResults: 20,
      })
    ).sources[0]?.url,
  ).toBe("https://example.org/page");
  expect(
    (await service.fetch("https://example.org/page", "firecrawl")).content,
  ).toContain("Native fetch content");
  const quotes = fake.json.mock.calls.filter(
    (call) => call[0] === "tools/quote",
  );
  expect(quotes).toHaveLength(2);
  expect(quotes[0]?.[2]).toMatchObject({ input: { body: { limit: 10 } } });
  expect(quotes[1]?.[2]).toEqual({
    actionId: TOKENTOSEA_SEARCH_ACTIONS["/firecrawl/scrape"],
    input: {
      body: {
        url: "https://example.org/page",
        formats: ["markdown"],
        parsers: [],
      },
    },
  });
}, 20_000);
