import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  engineCommands,
  engineConfigurationFields,
  engineValues,
  executeEngine,
  webSearch,
} from "../src/index.js";
import type { SearchServiceConfig } from "@open-design/contracts/api/search-service";

const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "fantay-search-"));
  directories.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("complete bundled search engine", () => {
  it("keeps the complete search, research, provider and diagnostic catalog", () => {
    const names = engineCommands().map((command) => command.id);
    expect(names).toEqual(
      expect.arrayContaining([
        "search",
        "research",
        "deep",
        "route",
        "fetch",
        "map",
        "context7-docs",
        "anysearch-batch",
        "sciverse-relations",
        "diagnose",
        "model/list",
        "regression",
      ]),
    );
    expect(engineConfigurationFields().map((field) => field.key)).toContain(
      "TYPESAFE_API_KEY",
    );
    expect(engineConfigurationFields().length).toBeGreaterThan(60);
  });

  it("maps provider settings and keeps engine overrides", () => {
    const values = engineValues({
      version: 1,
      defaultProvider: "openai-compatible",
      providers: {
        "openai-compatible": {
          enabled: true,
          values: {
            baseUrl: "https://relay.example/v1",
            model: "custom-model",
            apiKey: "synthetic-key",
            apiMode: "responses",
          },
        },
      },
      engineValues: { SMART_SEARCH_JEV_MAX_ROUNDS: "7" },
    });
    expect(values.OPENAI_COMPATIBLE_API_URL).toBe("https://relay.example/v1");
    expect(values.OPENAI_COMPATIBLE_MODEL).toBe("custom-model");
    expect(values.SMART_SEARCH_JEV_MAX_ROUNDS).toBe("7");
    expect(values.XAI_ENABLED).toBe("false");
  });

  it("executes the bundled runtime mock smoke without a global CLI", async () => {
    const configDir = await directory();
    const result = await executeEngine(
      "smoke",
      ["--mock"],
      { version: 1, defaultProvider: null, providers: {} },
      { configDir },
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe("healthy");
  }, 20_000);

  it("runs an actual worker against a configurable Responses endpoint", async () => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      if (req.url?.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "custom-model" }] }));
        return;
      }
      requests.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "Verified source information.",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://example.org/source",
                      title: "Source",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const config: SearchServiceConfig = {
      version: 1,
      defaultProvider: "openai-compatible",
      providers: {},
      engineValues: {
        OPENAI_COMPATIBLE_ENABLED: "true",
        OPENAI_COMPATIBLE_API_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_COMPATIBLE_API_KEY: "private-synthetic-key",
        OPENAI_COMPATIBLE_API_MODE: "responses",
        OPENAI_COMPATIBLE_MODEL: "custom-model",
        OPENAI_COMPATIBLE_TOOLS: "web_search,x_search",
      },
    };
    try {
      const result = await webSearch(
        { query: "Find the source", provider: "openai-compatible" },
        config,
        { configDir: await directory() },
      );
      expect(result.sources[0]?.url).toBe("https://example.org/source");
      expect(requests[0]?.model).toBe("custom-model");
      expect(requests[0]?.tools).toEqual([
        { type: "web_search" },
        { type: "x_search" },
      ]);
      expect(JSON.stringify(result)).not.toContain("private-synthetic-key");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
