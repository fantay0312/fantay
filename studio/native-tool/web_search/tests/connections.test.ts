import { expect, it } from "vitest";
import { connectionMode, withDeepSeekDefaults } from "../src/index.js";
import type { SearchServiceConfig } from "@open-design/contracts/api/search-service";

const empty = (): SearchServiceConfig => ({
  version: 1,
  defaultProvider: null,
  providers: {},
});
it("adds account defaults to an empty old config while preserving explicit disable", () => {
  expect(
    withDeepSeekDefaults(empty(), true).engineValues?.DEEPSEEK_ENABLED,
  ).toBe("true");
  expect(
    withDeepSeekDefaults(
      { ...empty(), engineValues: { DEEPSEEK_ENABLED: "false" } },
      true,
    ).engineValues?.DEEPSEEK_ENABLED,
  ).toBe("false");
});
it("preserves standalone custom DeepSeek endpoints during migration", () => {
  for (const key of ["DEEPSEEK_SEARCH_API_URL", "DEEPSEEK_FETCH_API_URL"]) {
    const config = withDeepSeekDefaults(
      { ...empty(), engineValues: { [key]: "https://custom.example/tool" } },
      true,
    );
    expect(config.engineValues?.FANTAY_DEEPSEEK_MODE).toBe("custom");
  }
});
it("defaults new providers to automatic and preserves legacy custom credentials", () => {
  expect(connectionMode("exa", empty())).toBe("auto");
  expect(
    connectionMode("exa", {
      ...empty(),
      engineValues: { EXA_API_KEY: "custom-key" },
    }),
  ).toBe("custom");
  expect(
    connectionMode("exa", {
      ...empty(),
      engineValues: { EXA_API_KEY: "custom-key", FANTAY_EXA_MODE: "auto" },
    }),
  ).toBe("auto");
});
