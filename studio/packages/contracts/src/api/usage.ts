export interface AiUsageContext { projectId?: string; workspaceId?: string; conversationId?: string; localRunId?: string; mediaTaskId?: string }
export type AiUsageScope = 'fantay' | 'device';
export interface AiUsageLocalSource {
  provider: string;
  status: 'ready' | 'not-found' | 'partial' | 'error' | 'unsupported';
  files: number;
  records: number;
  /** Machine-readable reasons. No private filesystem paths or log content. */
  issues?: Array<'scan-limit' | 'file-limit' | 'invalid-record' | 'history-overlap' | 'permission' | 'unsupported-format' | 'incomplete-usage'>;
  pricingSource?: 'local-model-catalog';
  homes?: number;
}
export interface AiUsageLocalScan {
  scannedAt: number;
  sources: AiUsageLocalSource[];
  /** Public rate catalog; estimates are token value, not subscription charges. */
  pricing: { source: string; fetchedAt: number | null };
}
export interface AiUsageRecord extends AiUsageContext {
  origin?: 'fantay' | 'external';
  sessionId?: string;
  granularity?: 'request' | 'session';
  requestCount?: number;
  estimatedUsd?: string | null;
  projectName?: string;
  requestKey: string; provider: string; model: string; kind: string; status: string;
  externalRunId?: string; inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null;
  chargedUsd: string | null; refundedUsd: string | null; reportedUsd: string | null;
  reservedUsd: string | null; createdAt: number; updatedAt: number;
}
export interface AiUsageTotals {
  sessionRecords?: number;
  estimatedUsd?: string;
  estimatedRequests?: number;
  requests: number; inputTokens: number; outputTokens: number; cachedTokens: number;
  chargedUsd: string; refundedUsd: string; reportedUsd: string; reservedUsd: string;
  pending: number; unknown: number;
  /** Requests whose final status is `failed` or `expired`. Cancelled requests are not failures. */
  failed: number;
  /** Requests that reported at least one input or output token count. */
  withTokens: number;
}

/** A compact figure used by chart buckets and the activity series. `tokens` is input + output as reported;
 *  `costUsd` is TokenToSea charged plus provider-reported cost, so a request without a known cost adds nothing. */
export interface AiUsageMetric { requests: number; tokens: number; costUsd: string }

/** How the chart splits a bucket: by model name, by provider (agent / channel) or by project (`''` = no project). */
export type AiUsageDimension = 'model' | 'provider' | 'project';

export interface AiUsageBucket extends AiUsageMetric {
  /** The bucket's local start in the summary time zone: `YYYY-MM-DD` for days, `YYYY-MM-DDTHH` for hours. */
  start: string;
  failed: number;
  /** Requests in the bucket whose cost was never provided; `costUsd` leaves them out instead of counting zero. */
  unknown: number;
  chargedUsd: string;
  reportedUsd: string;
  groups: Record<AiUsageDimension, Record<string, AiUsageMetric>>;
}

export interface AiUsageActivityDay extends AiUsageMetric {
  day: string;
  /** Requests that day whose cost was never provided. */
  unknown: number;
}

/** A native session's usage within the requested date range, independent of the recent-request limit. */
export interface AiUsageSession {
  sessionId: string;
  provider: string;
  models: string[];
  firstUsedAt: number;
  lastUsedAt: number;
  totals: AiUsageTotals;
}

export interface AiUsageSummary {
  scope?: AiUsageScope;
  sessionId?: string | null;
  sessions?: AiUsageSession[];
  localScan?: AiUsageLocalScan;
  /** Number of calendar days in the range, `from` and `to` included. */
  days: number;
  /** Inclusive local date range (`YYYY-MM-DD`) in `timeZone`. */
  from: string;
  to: string;
  /** `hour` when the range is a single day, otherwise `day`. */
  bucket: 'hour' | 'day';
  timeZone: string;
  /** The provider filter applied to every figure below, or null for all providers. */
  provider: string | null;
  coverageSince: number | null; account: 'signed-in' | 'local'; totals: AiUsageTotals;
  daily: Array<{ day: string; totals: AiUsageTotals }>;
  models: Array<{ model: string; provider: string; totals: AiUsageTotals }>;
  projects: Array<{ projectId: string | null; projectName?:string; totals: AiUsageTotals }>;
  providers: Array<{ provider: string; totals: AiUsageTotals }>;
  /** Providers with requests in the range before the provider filter applies, most requests first. */
  availableProviders: Array<{ provider: string; requests: number }>;
  /** Only buckets with requests; the caller lays out the empty ones from `from`, `to` and `bucket`. */
  series: AiUsageBucket[];
  /** Requests and tokens by local hour of day (0–23) across the range. */
  hours: AiUsageMetric[];
  /** The newest requests in the range, at most `limit` (default 100). */
  recent: AiUsageRecord[];
  /** Present when requested with `activity=1`: the active days of the last 371 days ending today. */
  activity?: { from: string; to: string; days: AiUsageActivityDay[] };
}
