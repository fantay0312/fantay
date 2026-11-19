import type { Express, RequestHandler, Request } from "express";
import { z } from "zod";
import {
  SEARCH_PROVIDER_IDS,
  NativeWebSearchInputSchema,
  SearchProviderUpdateSchema,
} from "@open-design/contracts/api/search-service";
import { WebSearchError } from "@fantay/native-web-search";
import type { SearchService } from "../research/search-service.js";
import { proxyDispatcherRequestInit } from "../connectionTest.js";

export interface RegisterSearchServiceRoutesDeps {
  searchService: SearchService;
  requireLocalDaemonRequest: RequestHandler;
}

const providerSchema = z.enum(SEARCH_PROVIDER_IDS);

export function registerSearchServiceRoutes(
  app: Express,
  { searchService, requireLocalDaemonRequest }: RegisterSearchServiceRoutesDeps,
): void {
  const handle =
    (
      operation: (
        req: Request,
        signal: AbortSignal,
      ) => unknown | Promise<unknown>,
    ): RequestHandler =>
    async (req, res) => {
      const controller = new AbortController();
      const close = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", close);
      try {
        res.json(await operation(req, controller.signal));
      } catch (error) {
        const known = error instanceof WebSearchError;
        const invalid =
          error instanceof z.ZodError || error instanceof TypeError;
        res
          .status(
            known
              ? Math.max(400, Math.min(error.status, 599))
              : invalid
                ? 400
                : 500,
          )
          .json({
            error: {
              code: known
                ? error.code
                : invalid
                  ? "INVALID_REQUEST"
                  : "SEARCH_FAILED",
              message: known
                ? error.message
                : invalid
                  ? "搜索请求参数无效。"
                  : "搜索服务暂时无法完成请求。",
            },
          });
      } finally {
        res.off("close", close);
      }
    };

  app.get(
    "/api/search/providers",
    requireLocalDaemonRequest,
    handle(() => searchService.settings()),
  );
  app.get(
    "/api/search/catalog",
    requireLocalDaemonRequest,
    handle(() => searchService.catalog()),
  );
  app.put(
    "/api/search/config",
    requireLocalDaemonRequest,
    handle((req) =>
      searchService.updateEngine(
        z
          .object({
            values: z.record(z.string()),
            clearSecrets: z.array(z.string()).optional(),
            defaultProvider: providerSchema.nullable().optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/search/execute",
    requireLocalDaemonRequest,
    handle((req, signal) => {
      const input = z
        .object({
          command: z.string(),
          arguments: z.array(z.string()).max(256).default([]),
        })
        .parse(req.body);
      return searchService.execute(input.command, input.arguments, { signal });
    }),
  );
  app.put(
    "/api/search/providers/:provider",
    requireLocalDaemonRequest,
    handle((req) =>
      searchService.update(
        providerSchema.parse(req.params.provider),
        SearchProviderUpdateSchema.parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/search/providers/:provider/models",
    requireLocalDaemonRequest,
    handle(async (req, signal) => {
      const values = z.record(z.string()).parse(req.body?.values ?? {});
      const proxy = proxyDispatcherRequestInit(process.env);
      try {
        return await searchService.models(
          providerSchema.parse(req.params.provider),
          values,
          { signal, ...proxy.requestInit },
        );
      } finally {
        await proxy.close();
      }
    }),
  );
  app.post(
    "/api/search/search",
    requireLocalDaemonRequest,
    handle(async (req, signal) => {
      const input = NativeWebSearchInputSchema.parse(req.body);
      const proxy = proxyDispatcherRequestInit(process.env);
      try {
        return await searchService.search(input, {
          signal,
          ...proxy.requestInit,
        });
      } finally {
        await proxy.close();
      }
    }),
  );
  app.post(
    "/api/search/fetch",
    requireLocalDaemonRequest,
    handle(async (req, signal) => {
      const input = z
        .object({ url: z.string().url(), provider: providerSchema.optional() })
        .parse(req.body);
      const proxy = proxyDispatcherRequestInit(process.env);
      try {
        return await searchService.fetch(input.url, input.provider, {
          signal,
          ...proxy.requestInit,
        });
      } finally {
        await proxy.close();
      }
    }),
  );
}
