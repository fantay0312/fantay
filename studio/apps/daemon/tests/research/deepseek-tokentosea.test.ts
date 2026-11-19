import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { SearchService } from "../../src/research/search-service.js";
import {
  invokeTokenToSeaDeepSeek,
  type DeepSeekTokenToSeaRuntime,
} from "../../src/research/deepseek-tokentosea.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function fakeRuntime(
  handler?: (
    resource: string,
    method?: string,
    body?: unknown,
    signal?: AbortSignal,
  ) => unknown,
) {
  const json = vi.fn(
    async (
      resource: string,
      method?: string,
      body?: unknown,
      _query?: unknown,
      signal?: AbortSignal,
    ) => {
      if (handler) return handler(resource, method, body, signal);
      if (resource === "official/prepare") return { id: "search-run" };
      return {
        status: "succeeded",
        billingStatus: "succeeded",
        deliveryState: "available",
        chargedUsd: "0.001000",
        output: {
          results: [
            {
              title: "Search result",
              url: "https://example.org/result",
              summary: "Result from the native search API.",
            },
          ],
        },
      };
    },
  );
  const runtime = {
    current: () => ({
      raw: "private-session",
      user: { id: "account-a", name: "Account A" },
    }),
    models: vi.fn(async () =>
      ["search", "fetch"].map((tool) => ({
        id: `official:deepseek-${tool}`,
        model: `deepseek-${tool}`,
        executionKind: "official",
        available: true,
        priceVersion: "price-1",
        examples: [{ path: `/v1/tools/${tool}`, mode: "json", body: {} }],
      })),
    ),
    authorizationBudget: vi.fn(async () => 1),
    json,
  } as unknown as DeepSeekTokenToSeaRuntime;
  return { runtime, json };
}

it("uses the native search product and preserves the exact packet hash", async () => {
  const { runtime, json } = fakeRuntime();
  const input = { query: "question", count: 5 };
  const result = await invokeTokenToSeaDeepSeek(
    runtime,
    "search",
    input,
    new AbortController().signal,
  );
  const prepared = json.mock.calls[0]?.[2] as Record<string, unknown>;
  expect(prepared).toMatchObject({
    model: "deepseek-search",
    path: "/v1/tools/search",
    mode: "json",
    maxCostUsd: "1.000000",
  });
  expect(prepared.payloadHash).toBe(
    createHash("sha256").update(JSON.stringify({ input })).digest("hex"),
  );
  expect(json.mock.calls[1]?.slice(0, 3)).toEqual([
    "official/runs/search-run/invoke",
    "POST",
    { input },
  ]);
  expect(result.results).toEqual(expect.any(Array));
  expect(JSON.stringify(result)).not.toContain("private-session");
});

it("polls the existing receipt after an ambiguous invoke failure", async () => {
  const { runtime, json } = fakeRuntime((resource) => {
    if (resource === "official/prepare") return { id: "existing-run" };
    if (resource.endsWith("/invoke")) throw new Error("connection interrupted");
    return {
      status: "succeeded",
      billingStatus: "succeeded",
      deliveryState: "available",
      output: { results: [] },
    };
  });
  await invokeTokenToSeaDeepSeek(
    runtime,
    "search",
    { query: "question" },
    new AbortController().signal,
  );
  expect(
    json.mock.calls.filter((call) => call[0] === "official/prepare"),
  ).toHaveLength(1);
  expect(
    json.mock.calls.filter((call) => call[0].endsWith("/invoke")),
  ).toHaveLength(1);
  expect(json.mock.calls[2]?.[0]).toBe("official/runs/existing-run");
});

it("reuses the same request key if the prepare response is interrupted", async () => {
  let prepareCalls = 0;
  const { runtime, json } = fakeRuntime((resource) => {
    if (resource === "official/prepare") {
      prepareCalls += 1;
      if (prepareCalls === 1) throw new Error("network interrupted");
      return { id: "recovered-run" };
    }
    return {
      status: "succeeded",
      billingStatus: "succeeded",
      deliveryState: "available",
      output: { results: [] },
    };
  });
  await invokeTokenToSeaDeepSeek(
    runtime,
    "search",
    { query: "question" },
    new AbortController().signal,
  );
  const prepares = json.mock.calls.filter(
    (call) => call[0] === "official/prepare",
  );
  expect(prepares).toHaveLength(2);
  expect(prepares[0]?.[2]).toEqual(prepares[1]?.[2]);
});

it("cancels with an independent signal when the caller aborts", async () => {
  const controller = new AbortController();
  const { runtime, json } = fakeRuntime((resource) => {
    if (resource === "official/prepare") return { id: "cancel-run" };
    if (resource.endsWith("/invoke")) {
      controller.abort();
      throw new Error("aborted");
    }
    return {};
  });
  await expect(
    invokeTokenToSeaDeepSeek(
      runtime,
      "fetch",
      { url: "https://example.org" },
      controller.signal,
    ),
  ).rejects.toThrow();
  const cancel = json.mock.calls.find((call) => call[0].endsWith("/cancel"));
  expect(cancel?.[4]?.aborted).toBe(false);
});

it("defaults to TokenToSea while preserving old custom native API settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-settings-"));
  roots.push(root);
  const { runtime } = fakeRuntime();
  const service = new SearchService(root, runtime);
  expect(await service.settings()).toMatchObject({
    defaultProvider: "deepseek",
    deepseek: { mode: "tokentosea", accountConnected: true },
  });
  expect((await service.settings()).engineValues.DEEPSEEK_API_URL).toBe(
    "https://api.tokentosea.com",
  );
  await service.updateEngine({
    values: {
      FANTAY_DEEPSEEK_MODE: "custom",
      DEEPSEEK_API_URL: "https://custom.example/v1",
      DEEPSEEK_API_KEY: "private-custom-key",
    },
  });
  expect(
    (await new SearchService(root, runtime).settings()).deepseek?.mode,
  ).toBe("custom");
  expect(JSON.stringify(await service.settings())).not.toContain(
    "private-custom-key",
  );
  const stored = JSON.parse(
    await readFile(path.join(root, "search-providers.json"), "utf8"),
  );
  delete stored.engineValues.FANTAY_DEEPSEEK_MODE;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(root, "search-providers.json"),
    JSON.stringify(stored),
  );
  expect((await service.settings()).deepseek?.mode).toBe("custom");
});

it("recognizes explicit native credentials from existing configuration clients", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-config-client-"));
  roots.push(root);
  const service = new SearchService(root);
  await service.updateEngine({
    values: {
      DEEPSEEK_API_URL: "https://custom.example/v1",
      DEEPSEEK_API_KEY: "custom-key",
      DEEPSEEK_ENABLED: "true",
    },
  });
  expect((await service.settings()).deepseek?.mode).toBe("custom");
  await service.update("deepseek", {
    enabled: true,
    values: { baseUrl: "https://other.example/v1", apiKey: "other-key" },
  });
  expect((await service.settings()).engineValues.DEEPSEEK_API_URL).toBe(
    "https://other.example/v1",
  );
  expect((await service.settings()).deepseek?.mode).toBe("custom");
  await service.update("deepseek", {
    enabled: false,
    clearSecrets: ["apiKey"],
    values: {},
  });
  expect((await service.settings()).engineSecretPresence.DEEPSEEK_API_KEY).toBe(
    false,
  );
});

it("runs the full bundled engine through the account-authorized native bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-native-engine-"));
  roots.push(root);
  const { runtime, json } = fakeRuntime();
  const result = await new SearchService(root, runtime).search({
    query: "Find a source",
  });
  expect(result.sources[0]?.url).toBe("https://example.org/result");
  expect(json.mock.calls.some((call) => call[0] === "official/prepare")).toBe(
    true,
  );
}, 20_000);

it("calls a custom native endpoint with its own key independently of TokenToSea", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-custom-engine-"));
  roots.push(root);
  const calls: Array<{ url: string; authorization: string }> = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Consume the JSON input. */
    }
    calls.push({
      url: request.url ?? "",
      authorization: String(request.headers.authorization),
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        results: [
          {
            title: "Custom source",
            url: "https://example.org/custom",
            summary: "Custom result",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const { runtime, json } = fakeRuntime();
  const service = new SearchService(root, runtime);
  try {
    await service.updateEngine({
      values: {
        FANTAY_DEEPSEEK_MODE: "custom",
        DEEPSEEK_ENABLED: "true",
        DEEPSEEK_API_URL: `http://127.0.0.1:${port}/v1`,
        DEEPSEEK_API_KEY: "private-custom-key",
      },
    });
    const result = await service.search({
      query: "question",
      provider: "deepseek",
    });
    expect(result.sources[0]?.url).toBe("https://example.org/custom");
    expect(calls).toEqual([
      { url: "/v1/tools/search", authorization: "Bearer private-custom-key" },
    ]);
    expect(json.mock.calls.some((call) => call[0] === "official/prepare")).toBe(
      false,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);

it("provides an actionable login error for the default account route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-login-"));
  roots.push(root);
  const service = new SearchService(root);
  await expect(service.search({ query: "question" })).rejects.toThrow(
    "请先登录 TokenToSea",
  );
});

it("stops before preparing a paid run when the authorized budget is empty", async () => {
  const { runtime, json } = fakeRuntime();
  vi.spyOn(runtime, "authorizationBudget").mockResolvedValue(0);
  await expect(
    invokeTokenToSeaDeepSeek(
      runtime,
      "search",
      { query: "question" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ status: 402 });
  expect(json).not.toHaveBeenCalled();
});
