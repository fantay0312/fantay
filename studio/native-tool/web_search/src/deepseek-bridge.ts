import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type DeepSeekNativeInvoker = (
  tool: "search" | "fetch",
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;

/** Each engine invocation gets a loopback-only capability; account tokens stay in the host. */
export async function createDeepSeekNativeBridge(
  invoke: DeepSeekNativeInvoker,
): Promise<{ apiUrl: string; token: string; close(): Promise<void> }> {
  return createNativeSearchBridge((route, input, signal) => {
    const tool =
      route === "/v1/tools/search"
        ? "search"
        : route === "/v1/tools/fetch"
          ? "fetch"
          : null;
    if (!tool)
      throw Object.assign(new Error("Unknown native search operation."), {
        status: 404,
      });
    return invoke(tool, input, signal);
  });
}

export async function createNativeSearchBridge(
  invoke: (
    route: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>,
): Promise<{ apiUrl: string; token: string; close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const inAccountContext = AsyncLocalStorage.snapshot();
  const active = new Set<AbortController>();
  const pending = new Set<Promise<Record<string, unknown>>>();
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(
      String(
        request.headers.authorization ??
          (request.headers["x-api-key"]
            ? `Bearer ${request.headers["x-api-key"]}`
            : ""),
      ),
    );
    const expected = Buffer.from(`Bearer ${token}`);
    response.setHeader("content-type", "application/json");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.writeHead(401).end(
        JSON.stringify({
          error: { message: "Invalid native search capability." },
        }),
      );
      return;
    }
    if (request.method !== "POST" || !request.url) {
      response.writeHead(404).end(
        JSON.stringify({
          error: { message: "Unknown native search operation." },
        }),
      );
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 1024 * 1024)
          throw Object.assign(
            new Error("Native search request is too large."),
            { status: 413 },
          );
      }
      const input: unknown = JSON.parse(body);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Object.assign(new Error("Invalid native search request."), {
          status: 400,
        });
      const work = inAccountContext(() =>
        invoke(
          request.url!,
          input as Record<string, unknown>,
          controller.signal,
        ),
      );
      pending.add(work);
      let output: Record<string, unknown>;
      try {
        output = await work;
      } finally {
        pending.delete(work);
      }
      if (!response.destroyed) response.end(JSON.stringify(output));
    } catch (error) {
      const status =
        Number((error as { status?: number }).status) ||
        (error instanceof SyntaxError ? 400 : 502);
      if (!response.destroyed)
        response.writeHead(status >= 400 && status <= 599 ? status : 502).end(
          JSON.stringify({
            error: {
              message:
                error instanceof Error
                  ? error.message
                  : "Native search failed.",
            },
          }),
        );
    } finally {
      active.delete(controller);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Native search bridge did not start.");
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    token,
    close: async () => {
      const work = [...pending];
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.allSettled(work);
    },
  };
}
