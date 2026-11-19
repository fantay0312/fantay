// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — engine configuration and stored provider keys.
//
// `engine_config` (mem_meta) holds only the fields a person set; MEMORY_ENGINE_DEFAULTS fill the rest when it is
// read, so a changed default reaches everyone who never touched that field. Keys live apart in `engine_secrets`
// and are never part of the returned configuration; `hasApiKey` says whether one is available.

import {
  MEMORY_ENGINE_DEFAULTS,
  updateMemoryEngineConfigSchema,
  type MemoryEngineConfig,
  type UpdateMemoryEngineConfigRequest,
} from "@open-design/contracts";
import type { ZodTypeAny } from "zod";
import { buildProviders, envValue, resolveProviderDefaults, type MemorySecrets } from "./providers.js";
import {
  MemoryError,
  type EmbeddingProvider,
  type MemoryConfigApi,
  type MemoryLlm,
  type MemoryLocalRuntime,
  type MemoryProviders,
  type RerankProvider,
} from "./types.js";

const CONFIG_KEY = "engine_config";
const SECRETS_KEY = "engine_secrets";

type Section = "embedding" | "reranker" | "judge" | "recall";
type StoredSection<S extends Section> = Partial<Omit<MemoryEngineConfig[S], "hasApiKey">>;

/** The fields a person set. Every value passed the contract schema. */
interface StoredConfig {
  autoMemory?: MemoryEngineConfig["autoMemory"];
  embedding?: StoredSection<"embedding">;
  reranker?: StoredSection<"reranker">;
  judge?: StoredSection<"judge">;
  recall?: StoredSection<"recall">;
}

const SECTION_FIELDS: Record<Section, Record<string, ZodTypeAny>> = {
  embedding: updateMemoryEngineConfigSchema.shape.embedding.unwrap().shape,
  reranker: updateMemoryEngineConfigSchema.shape.reranker.unwrap().shape,
  judge: updateMemoryEngineConfigSchema.shape.judge.unwrap().shape,
  recall: updateMemoryEngineConfigSchema.shape.recall.unwrap().shape,
};

const URL_FIELDS = [
  ["embedding", "baseUrl"],
  ["reranker", "url"],
  ["judge", "apiUrl"],
] as const;

interface Resolved {
  config: MemoryEngineConfig;
  secrets: MemorySecrets;
}

export class MemoryConfig implements MemoryConfigApi {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private stored: StoredConfig | null = null;
  private keys: MemorySecrets | null = null;
  private resolved: Resolved | null = null;
  private built: {
    from: Resolved;
    llm: MemoryLlm | null;
    local: LocalPick;
    providers: MemoryProviders;
  } | null = null;

  constructor(
    private readonly deps: {
      getMeta(key: string): string | null;
      setMeta(key: string, value: string): void;
      env?: NodeJS.ProcessEnv;
      fetch?: typeof fetch;
    },
  ) {
    this.env = deps.env ?? process.env;
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  get(): MemoryEngineConfig {
    return cloneConfig(this.resolve().config);
  }

  update(patch: UpdateMemoryEngineConfigRequest): MemoryEngineConfig {
    const parsed = updateMemoryEngineConfigSchema.safeParse(patch);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join(".") || "config";
      throw new MemoryError("MEMORY_INVALID", `${where}: ${issue?.message ?? "invalid value"}`, 400);
    }
    const next = parsed.data;
    assertHttpUrls(next);

    const stored = readStored(mergeStored(this.loadStored(), next));
    this.deps.setMeta(CONFIG_KEY, JSON.stringify(stored));
    this.stored = stored;

    const keys = this.loadKeys();
    const nextKeys: MemorySecrets = {
      embeddingApiKey: nextKey(keys.embeddingApiKey, next.embedding?.apiKey),
      rerankerApiKey: nextKey(keys.rerankerApiKey, next.reranker?.apiKey),
      judgeApiKey: nextKey(keys.judgeApiKey, next.judge?.apiKey),
    };
    if (!sameKeys(keys, nextKeys)) this.deps.setMeta(SECRETS_KEY, JSON.stringify(nextKeys));
    this.keys = nextKeys;

    this.resolved = null;
    return this.get();
  }

  secrets(): MemorySecrets {
    return { ...this.resolve().secrets };
  }

  /**
   * The same clients are returned until the configuration, the model, or a selected local model's availability
   * changes (a download finishing makes the `local` provider appear).
   */
  providers(llm: MemoryLlm | null, local: MemoryLocalRuntime | null = null): MemoryProviders {
    const resolved = this.resolve();
    const pick = localPick(resolved.config, local);
    const built = this.built;
    if (built && built.from === resolved && built.llm === llm && sameLocalPick(built.local, pick)) {
      return built.providers;
    }
    const providers = buildProviders(resolved.config, resolved.secrets, {
      env: this.env,
      fetch: this.fetchImpl,
      llm,
      local,
    });
    this.built = { from: resolved, llm, local: pick, providers };
    return providers;
  }

  private resolve(): Resolved {
    this.resolved ??= resolveProviderDefaults(withDefaults(this.loadStored(), this.env), this.loadKeys(), this.env);
    return this.resolved;
  }

  private loadStored(): StoredConfig {
    this.stored ??= readStored(parseJson(this.deps.getMeta(CONFIG_KEY)));
    return this.stored;
  }

  private loadKeys(): MemorySecrets {
    this.keys ??= readSecrets(parseJson(this.deps.getMeta(SECRETS_KEY)));
    return this.keys;
  }
}

// ---- Local providers ---------------------------------------------------------------------------------------------

/** The local clients the configuration selects right now; part of the cache key of the built providers. */
interface LocalPick {
  runtime: MemoryLocalRuntime | null;
  embedding: EmbeddingProvider | null;
  reranker: RerankProvider | null;
}

function localPick(config: MemoryEngineConfig, runtime: MemoryLocalRuntime | null): LocalPick {
  return {
    runtime,
    embedding: runtime && config.embedding.provider === "local" ? runtime.embedding(config.embedding.dimensions) : null,
    reranker: runtime && config.reranker.provider === "local" ? runtime.reranker() : null,
  };
}

function sameLocalPick(a: LocalPick, b: LocalPick): boolean {
  return a.runtime === b.runtime && a.embedding === b.embedding && a.reranker === b.reranker;
}

// ---- Stored form -------------------------------------------------------------------------------------------------

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Keeps each stored field that still passes the contract schema; anything else falls back to its default. */
function readStored(value: unknown): StoredConfig {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  const autoMemory = updateMemoryEngineConfigSchema.shape.autoMemory.safeParse(value.autoMemory);
  if (autoMemory.success && autoMemory.data !== undefined) out.autoMemory = autoMemory.data;
  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    const valid = validFields(fields, value[section]);
    if (valid) out[section] = valid;
  }
  return out as StoredConfig;
}

function validFields(fields: Record<string, ZodTypeAny>, raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(fields)) {
    // Keys are stored apart; one found here is ignored rather than echoed back.
    if (field === "apiKey" || raw[field] === undefined) continue;
    const parsed = schema.safeParse(raw[field]);
    if (parsed.success && parsed.data !== undefined) out[field] = parsed.data;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function mergeStored(stored: StoredConfig, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!isRecord(value)) {
      next[key] = value;
      continue;
    }
    const base = next[key];
    next[key] = { ...(isRecord(base) ? base : {}), ...definedEntries(value) };
  }
  return next;
}

function definedEntries(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

/**
 * Defaults under the stored fields. A reranker URL in `OD_MEMORY_RERANKER_URL` turns the HTTP reranker on unless a
 * person chose a reranker explicitly, so a machine that sets up its reranker through the environment needs no
 * second step in the settings.
 */
function withDefaults(stored: StoredConfig, env: NodeJS.ProcessEnv): MemoryEngineConfig {
  const defaults = MEMORY_ENGINE_DEFAULTS;
  const reranker = { ...defaults.reranker, ...stored.reranker };
  if (stored.reranker?.provider === undefined && envValue(env, "OD_MEMORY_RERANKER_URL")) reranker.provider = "http";
  return {
    autoMemory: stored.autoMemory ?? defaults.autoMemory,
    embedding: { ...defaults.embedding, ...stored.embedding },
    reranker,
    judge: { ...defaults.judge, ...stored.judge },
    recall: { ...defaults.recall, ...stored.recall },
  };
}

function cloneConfig(config: MemoryEngineConfig): MemoryEngineConfig {
  return {
    autoMemory: config.autoMemory,
    embedding: { ...config.embedding },
    reranker: { ...config.reranker },
    judge: { ...config.judge },
    recall: { ...config.recall },
  };
}

// ---- Keys --------------------------------------------------------------------------------------------------------

function readSecrets(value: unknown): MemorySecrets {
  const record = isRecord(value) ? value : {};
  const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string) : "");
  return {
    embeddingApiKey: text("embeddingApiKey"),
    rerankerApiKey: text("rerankerApiKey"),
    judgeApiKey: text("judgeApiKey"),
  };
}

/** `undefined` keeps the stored key; any string replaces it, and an empty one clears it. */
function nextKey(current: string, given: string | undefined): string {
  return given === undefined ? current : given.trim();
}

function sameKeys(a: MemorySecrets, b: MemorySecrets): boolean {
  return a.embeddingApiKey === b.embeddingApiKey && a.rerankerApiKey === b.rerankerApiKey && a.judgeApiKey === b.judgeApiKey;
}

// ---- Validation --------------------------------------------------------------------------------------------------

function assertHttpUrls(patch: Record<string, unknown>): void {
  for (const [section, field] of URL_FIELDS) {
    const value = patch[section];
    const url = isRecord(value) ? value[field] : undefined;
    if (typeof url === "string" && url !== "" && !isHttpUrl(url)) {
      throw new MemoryError(
        "MEMORY_INVALID",
        `${section}.${field}: expected an http(s) URL without a user name or password`,
        400,
      );
    }
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
