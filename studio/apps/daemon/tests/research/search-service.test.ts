import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { SearchService } from "../../src/research/search-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("persists full engine settings while keeping credentials masked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-service-test-"));
  roots.push(root);
  const service = new SearchService(root);
  await service.updateEngine({
    values: {
      XAI_API_KEY: "private-test-key",
      XAI_API_URL: "https://relay.example/v1",
      XAI_MODEL: "my-model",
      XAI_ENABLED: "true",
      SMART_SEARCH_JEV_MAX_ROUNDS: "6",
    },
    defaultProvider: "xai-responses",
  });
  const reloaded = new SearchService(root);
  expect((await reloaded.settings()).engineValues.XAI_MODEL).toBe("my-model");
  expect(
    (await reloaded.settings()).engineValues.SMART_SEARCH_JEV_MAX_ROUNDS,
  ).toBe("6");
  expect(JSON.stringify(await reloaded.settings())).not.toContain(
    "private-test-key",
  );
  expect((await reloaded.settings()).engineSecretPresence.XAI_API_KEY).toBe(
    true,
  );
  await reloaded.updateEngine({
    values: { XAI_API_KEY: "", XAI_MODEL: "changed-model" },
  });
  expect(
    JSON.parse(await readFile(path.join(root, "search-providers.json"), "utf8"))
      .engineValues.XAI_API_KEY,
  ).toBe("private-test-key");
  if (process.platform !== "win32")
    expect(
      (await stat(path.join(root, "search-providers.json"))).mode & 0o777,
    ).toBe(0o600);
  await reloaded.updateEngine({ values: {}, clearSecrets: ["XAI_API_KEY"] });
  expect((await reloaded.settings()).engineSecretPresence.XAI_API_KEY).toBe(
    false,
  );
});

it("rejects unknown configuration fields before changing the file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "search-service-test-"));
  roots.push(root);
  const service = new SearchService(root);
  await service.updateEngine({ values: { XAI_MODEL: "existing-model" } });
  const before = await readFile(
    path.join(root, "search-providers.json"),
    "utf8",
  );
  expect(() =>
    service.updateEngine({ values: { UNKNOWN_SETTING: "value" } }),
  ).toThrow();
  expect(await readFile(path.join(root, "search-providers.json"), "utf8")).toBe(
    before,
  );
});
