import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { createDeepSeekNativeBridge } from "../src/deepseek-bridge.js";

it("requires a private capability and retains the creating account context", async () => {
  const accounts = new AsyncLocalStorage<string>();
  const invoke = vi.fn(async () => ({
    account: accounts.getStore(),
    results: [],
  }));
  const bridge = await accounts.run("account-a", () =>
    createDeepSeekNativeBridge(invoke),
  );
  try {
    const rejected = await fetch(`${bridge.apiUrl}/v1/tools/search`, {
      method: "POST",
      body: "{}",
    });
    expect(rejected.status).toBe(401);
    expect(invoke).not.toHaveBeenCalled();
    const accepted = await accounts.run("account-b", () =>
      fetch(`${bridge.apiUrl}/v1/tools/search`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ query: "question" }),
      }),
    );
    expect(await accepted.json()).toMatchObject({ account: "account-a" });
  } finally {
    await bridge.close();
  }
});
