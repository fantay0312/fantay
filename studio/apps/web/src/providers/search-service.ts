import type {
  SearchEngineCommand,
  SearchEngineConfigField,
  SearchProviderId,
  SearchServiceSettings,
} from "@open-design/contracts/api/search-service";

async function searchRequest<T>(
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/search/${path}`, {
    method: body === undefined ? "GET" : method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    ...(signal ? { signal } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error?.message || data.error || `HTTP ${response.status}`,
    );
  return data as T;
}

export const fetchSearchSettings = (signal?: AbortSignal) =>
  searchRequest<SearchServiceSettings>("providers", undefined, "GET", signal);
export const fetchSearchCatalog = (signal?: AbortSignal) =>
  searchRequest<{
    commands: SearchEngineCommand[];
    fields: SearchEngineConfigField[];
  }>("catalog", undefined, "GET", signal);
export const saveSearchSettings = (body: {
  values: Record<string, string>;
  clearSecrets: string[];
  defaultProvider: SearchProviderId | null;
}) => searchRequest<SearchServiceSettings>("config", body, "PUT");
export const fetchSearchModels = (
  provider: SearchProviderId,
  values: Record<string, string>,
  signal?: AbortSignal,
) =>
  searchRequest<{ models: string[] }>(
    `providers/${provider}/models`,
    { values },
    "POST",
    signal,
  );
export const runSearchCommand = (
  command: string,
  args: string[],
  signal?: AbortSignal,
) =>
  searchRequest<Record<string, unknown>>(
    "execute",
    { command, arguments: args },
    "POST",
    signal,
  );
