import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type {
  AiUsageActivityDay, AiUsageBucket, AiUsageContext, AiUsageDimension, AiUsageMetric, AiUsageRecord, AiUsageSummary, AiUsageTotals,
} from '@open-design/contracts';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function usdMicros(value: unknown): number | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(6) : value;
  if (typeof text !== 'string' || !/^\d{1,9}(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}
const usd = (micros: number | null): string | null => micros === null ? null : (micros / 1_000_000).toFixed(6);
interface Stored extends AiUsageContext { accountId: string; requestKey: string; provider: string; model: string; kind: string; status: string; externalRunId?: string; inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null; charged: number | null; refunded: number | null; reported: number | null; reserved: number | null; createdAt: number; updatedAt: number }
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PENDING_STATUSES = new Set(['prepared','reserved','queued','running','processing','pending','needs_review']);
const FAILED_STATUSES = new Set(['failed','expired']);
/** The activity series covers 53 weeks: today plus the 370 days before it. */
export const USAGE_ACTIVITY_DAYS = 371;
/** A custom range may span at most this many calendar days. */
export const USAGE_MAX_RANGE_DAYS = 366;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isUsageDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`);
const shiftDay = (day: string, amount: number) => new Date(dayStart(day) + amount * DAY_MS).toISOString().slice(0, 10);
const daySpan = (from: string, to: string) => Math.round((dayStart(to) - dayStart(from)) / DAY_MS) + 1;

/** Local calendar day and hour of an instant in a time zone. */
function localClock(timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23' });
  return (at: number) => {
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(new Date(at))) parts[part.type] = part.value;
    const hour = Number(parts.hour) % 24;
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour };
  };
}

/** The inclusive local date range a summary covers. `from`/`to` win; otherwise the last `days` days ending today. */
export function resolveUsageRange(timeZone: string, input: { days?: number; from?: string | undefined; to?: string | undefined }, now = Date.now()) {
  const today = localClock(timeZone)(now).day;
  if (input.from && input.to) return { from: input.from, to: input.to, days: daySpan(input.from, input.to), today };
  const days = Math.max(1, Math.round(input.days ?? 30));
  return { from: shiftDay(today, -(days - 1)), to: today, days, today };
}
/** The earliest instant that can fall on `day` in any time zone (UTC+14). */
export const usageDayLowerBound = (day: string) => dayStart(day) - 15 * HOUR_MS;

export interface AiUsageSummaryOptions {
  /** Inclusive local start day, `YYYY-MM-DD`; needs `to`. */
  from?: string;
  /** Inclusive local end day, `YYYY-MM-DD`; needs `from`. */
  to?: string;
  /** Only requests from this provider. */
  provider?: string;
  /** How many of the newest requests to list (default 100). */
  limit?: number;
  /** Also return the 53-week activity series. */
  activity?: boolean;
  now?: number;
}

const emptyTotals = (): AiUsageTotals => ({ requests:0,inputTokens:0,outputTokens:0,cachedTokens:0,chargedUsd:'0.000000',refundedUsd:'0.000000',reportedUsd:'0.000000',reservedUsd:'0.000000',pending:0,unknown:0,failed:0,withTokens:0 });

function totals(items: Stored[]): AiUsageTotals {
  const out = emptyTotals();
  let charged = 0, refunded = 0, reported = 0, reserved = 0;
  for (const row of items) {
    out.requests++;
    out.inputTokens += row.inputTokens ?? 0;
    out.outputTokens += row.outputTokens ?? 0;
    out.cachedTokens += row.cachedTokens ?? 0;
    if (row.inputTokens !== null || row.outputTokens !== null) out.withTokens++;
    charged += row.charged ?? 0;
    refunded += row.refunded ?? 0;
    reported += row.reported ?? 0;
    if (PENDING_STATUSES.has(row.status)) {
      reserved += row.reserved ?? 0;
      out.pending++;
    }
    if (FAILED_STATUSES.has(row.status)) out.failed++;
    if (row.charged === null && row.reported === null || row.status === 'needs_review') out.unknown++;
  }
  return { ...out, chargedUsd: usd(charged)!, refundedUsd: usd(refunded)!, reportedUsd: usd(reported)!, reservedUsd: usd(reserved)! };
}

/** Requests, reported tokens (input + output) and known cost (charged + reported) in exact microdollars. */
class MetricTally {
  requests = 0;
  tokens = 0;
  cost = 0;
  unknown = 0;
  add(row: Stored) {
    this.requests++;
    this.tokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
    this.cost += (row.charged ?? 0) + (row.reported ?? 0);
    if (row.charged === null && row.reported === null || row.status === 'needs_review') this.unknown++;
  }
  metric(): AiUsageMetric {
    return { requests: this.requests, tokens: this.tokens, costUsd: usd(this.cost)! };
  }
}

class BucketTally extends MetricTally {
  failed = 0;
  charged = 0;
  reported = 0;
  readonly groups: Record<AiUsageDimension, Map<string, MetricTally>> = { model: new Map(), provider: new Map(), project: new Map() };
  override add(row: Stored) {
    super.add(row);
    if (FAILED_STATUSES.has(row.status)) this.failed++;
    this.charged += row.charged ?? 0;
    this.reported += row.reported ?? 0;
    const keys: Record<AiUsageDimension, string> = { model: row.model, provider: row.provider, project: row.projectId ?? '' };
    for (const dimension of ['model', 'provider', 'project'] as const) {
      const groups = this.groups[dimension];
      let tally = groups.get(keys[dimension]);
      if (!tally) groups.set(keys[dimension], tally = new MetricTally());
      tally.add(row);
    }
  }
  bucket(start: string): AiUsageBucket {
    const groups = (dimension: AiUsageDimension) =>
      Object.fromEntries([...this.groups[dimension]].map(([key, tally]) => [key, tally.metric()]));
    return {
      start, ...this.metric(), failed: this.failed, unknown: this.unknown, chargedUsd: usd(this.charged)!, reportedUsd: usd(this.reported)!,
      groups: { model: groups('model'), provider: groups('provider'), project: groups('project') },
    };
  }
}
export class AiUsageStore {
  private readonly db: Database.Database;
  private readonly stmtGet: Database.Statement;
  private readonly stmtKeyForExternal: Database.Statement;
  private readonly stmtSave: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtPending: Database.Statement;
  private readonly stmtMaxUpdated: Database.Statement;
  private readonly stmtProjectIds: Database.Statement;
  private readonly stmtScoped: Database.Statement;

  constructor(dataDir: string) {
    const directory = path.join(dataDir,'usage'); mkdirSync(directory,{recursive:true,mode:0o700});
    const file = path.join(directory,'requests.sqlite'); this.db = new Database(file); chmodSync(file,0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS requests (account_id TEXT NOT NULL, request_key TEXT NOT NULL, external_id TEXT, kind TEXT NOT NULL, project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account_id,request_key)); CREATE UNIQUE INDEX IF NOT EXISTS receipt_identity ON requests(account_id,kind,external_id) WHERE external_id IS NOT NULL; CREATE INDEX IF NOT EXISTS usage_project ON requests(project_id,created_at); CREATE INDEX IF NOT EXISTS usage_account_created ON requests(account_id,created_at DESC);');
    this.stmtGet = this.db.prepare('SELECT data FROM requests WHERE account_id=? AND request_key=?');
    this.stmtKeyForExternal = this.db.prepare('SELECT request_key AS key FROM requests WHERE account_id=? AND kind=? AND external_id=?');
    this.stmtSave = this.db.prepare('INSERT INTO requests VALUES (@accountId,@requestKey,@externalRunId,@kind,@projectId,@createdAt,@updatedAt,@data) ON CONFLICT(account_id,request_key) DO UPDATE SET external_id=excluded.external_id,project_id=excluded.project_id,updated_at=excluded.updated_at,data=excluded.data');
    this.stmtDelete = this.db.prepare('DELETE FROM requests WHERE account_id=? AND request_key=?');
    this.stmtPending = this.db.prepare('SELECT data FROM requests WHERE account_id=? AND external_id IS NOT NULL AND created_at>=? ORDER BY updated_at ASC LIMIT 100');
    this.stmtMaxUpdated = this.db.prepare('SELECT MAX(updated_at) AS at FROM requests WHERE account_id=?');
    this.stmtProjectIds = this.db.prepare('SELECT DISTINCT project_id AS id FROM requests WHERE account_id IN (?,?) AND project_id IS NOT NULL');
    this.stmtScoped = this.db.prepare('SELECT data FROM requests WHERE account_id IN (?,?) AND created_at>=? AND created_at<? ORDER BY created_at DESC');
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  begin(accountId: string, requestKey: string, model: string, kind: string, context: AiUsageContext = {}, provider = 'tokentosea', at = Date.now()): string {
    if (this.get(accountId,requestKey)) return requestKey;
    this.save({ accountId,requestKey,provider,model,kind,status:'pending',...context,inputTokens:null,outputTokens:null,cachedTokens:null,charged:null,refunded:null,reported:null,reserved:null,createdAt:at,updatedAt:at });
    return requestKey;
  }
  private get(accountId: string, key: string): Stored | null {
    const row = this.stmtGet.get(accountId,key) as {data:string}|undefined;
    return row ? JSON.parse(row.data) as Stored : null;
  }
  keyForExternal(accountId: string, kind: string, id: string): string | null {
    return (this.stmtKeyForExternal.get(accountId,kind,id) as {key:string}|undefined)?.key ?? null;
  }
  private save(row: Stored) {
    this.stmtSave.run({ ...row,externalRunId:row.externalRunId??null,projectId:row.projectId??null,data:JSON.stringify(row) });
  }
  observe(accountId: string, key: string, payload: unknown, externalRunId?: string) {
    let row = this.get(accountId,key); if (!row) return;
    const value = object(payload), receipt = object(value.tokentosea), usage = object(value.usage ?? receipt.usage ?? value.usageMetadata ?? value.usage_metadata);
    if(typeof value.model==='string')row.model=value.model;
    const id = row.accountId==='local'?undefined:externalRunId ?? (typeof receipt.runId === 'string' ? receipt.runId : typeof value.id === 'string' && row.kind !== 'chat' ? value.id : undefined);
    if (id) {
      const previous = this.keyForExternal(accountId,row.kind,id);
      if (previous && previous !== key) {
        const original = this.get(accountId,previous); if (!original) return;
        this.stmtDelete.run(accountId,key); row = original;
      }
      row.externalRunId = id;
    }
    const amount = usdMicros(receipt.chargedUsd ?? value.chargedUsd);
    const refund = usdMicros(receipt.refundedUsd ?? value.refundedUsd);
    const reserve = usdMicros(receipt.reservedUsd ?? value.reservedUsd);
    if (amount !== null) row.charged = amount;
    if (refund !== null) row.refunded = refund;
    if (reserve !== null) row.reserved = reserve;
    row.inputTokens = count(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.promptTokenCount) ?? row.inputTokens;
    row.outputTokens = count(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.candidatesTokenCount) ?? row.outputTokens;
    row.cachedTokens = count(usage.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cachedContentTokenCount ?? object(usage.prompt_tokens_details).cached_tokens) ?? row.cachedTokens;
    if(row.accountId==='local')row.reported=usdMicros(value.costUsd)??row.reported;
    const status = typeof value.status === 'string' ? value.status : undefined;
    if (status && ['prepared','reserved','queued','running','processing','succeeded','completed','failed','canceled','cancelled','needs_review','expired'].includes(status)) row.status = status;
    else if (amount !== null && row.kind === 'chat') row.status = 'succeeded';
    row.updatedAt = Date.now(); this.save(row);
  }
  finish(accountId: string, key: string, failed = false) {
    const row = this.get(accountId,key); if (!row) return;
    if (row.status === 'pending') row.status = failed ? 'failed' : 'unknown';
    row.updatedAt = Date.now(); this.save(row);
  }
  recordLocal(input: { key: string; provider: string; model: string; context: AiUsageContext; usage: Json; reportedUsd?: unknown; status?: string; at: number }) {
    const existing = this.get('local',input.key);
    const row: Stored = existing ?? {
      accountId:'local',requestKey:input.key,provider:input.provider,model:input.model,kind:'cli',status:'pending',
      ...input.context,inputTokens:null,outputTokens:null,cachedTokens:null,charged:null,refunded:null,reported:null,reserved:null,
      createdAt:input.at,updatedAt:input.at,
    };
    const nextInput = count(input.usage.input_tokens ?? input.usage.prompt_tokens ?? input.usage.inputTokens) ?? row.inputTokens;
    const nextOutput = count(input.usage.output_tokens ?? input.usage.completion_tokens ?? input.usage.outputTokens) ?? row.outputTokens;
    const nextCached = count(input.usage.cache_read_input_tokens ?? input.usage.cached_tokens) ?? row.cachedTokens;
    const nextReported = usdMicros(input.reportedUsd) ?? row.reported;
    const nextStatus = input.status ?? 'completed';
    if (
      existing &&
      existing.inputTokens === nextInput &&
      existing.outputTokens === nextOutput &&
      existing.cachedTokens === nextCached &&
      existing.reported === nextReported &&
      existing.status === nextStatus
    ) {
      return;
    }
    row.inputTokens = nextInput;
    row.outputTokens = nextOutput;
    row.cachedTokens = nextCached;
    row.reported = nextReported;
    row.status = nextStatus;
    row.updatedAt = Date.now();
    this.save(row);
  }
  pending(accountId: string): Array<{ requestKey: string; kind: string; externalRunId: string }> {
    return (this.stmtPending.all(accountId,Date.now()-90*86_400_000) as {data:string}[]).map(r=>JSON.parse(r.data) as Stored)
      .map(r=>({requestKey:r.requestKey,kind:r.kind,externalRunId:r.externalRunId!}));
  }
  markReconciled(accountId:string,key:string) {
    const row=this.get(accountId,key);if(!row)return;
    const latest=this.stmtMaxUpdated.get(accountId) as {at:number|null};
    row.updatedAt=Math.max(Date.now(),(latest.at??0)+1);this.save(row);
  }
  projectIds(accountId:string|null):string[] {
    return (this.stmtProjectIds.all(accountId??'local','local') as {id:string}[]).map(row=>row.id);
  }
  /**
   * One read model for the dashboard and `od usage`. Rows are bucketed by their local calendar day in `timeZone`;
   * a cost that was never reported stays out of every sum (and is counted in `unknown`), it is never estimated.
   */
  summary(
    accountId: string | null,
    days = 30,
    projectId?: string,
    allowedProjects?: Set<string>,
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    options: AiUsageSummaryOptions = {},
  ): AiUsageSummary {
    const now = options.now ?? Date.now();
    const range = resolveUsageRange(timeZone, { days, from: options.from, to: options.to }, now);
    const { from, to } = range;
    const bucket: AiUsageSummary['bucket'] = from === to ? 'hour' : 'day';
    const activityFrom = shiftDay(range.today, -(USAGE_ACTIVITY_DAYS - 1));
    const lower = Math.min(usageDayLowerBound(from), options.activity ? usageDayLowerBound(activityFrom) : Infinity);
    const upper = Math.max(dayStart(to) + DAY_MS + 13 * HOUR_MS, options.activity ? now + DAY_MS : 0);
    const clock = localClock(timeZone);
    const scoped = (this.stmtScoped
      .all(accountId ?? 'local', 'local', lower, upper) as { data: string }[])
      .map(row => JSON.parse(row.data) as Stored)
      .filter(row => (!projectId || row.projectId === projectId) && (!row.projectId || !allowedProjects || allowedProjects.has(row.projectId)))
      .map(row => ({ row, ...clock(row.createdAt) }));
    const provider = options.provider || null;
    const filtered = provider ? scoped.filter(item => item.row.provider === provider) : scoped;
    const within = (day: string) => day >= from && day <= to;
    const inRange = filtered.filter(item => within(item.day));
    const rows = inRange.map(item => item.row);

    const group = (items: Stored[], key: (row: Stored) => string) => {
      const groups = new Map<string, Stored[]>();
      for (const row of items) {
        const id = key(row);
        const list = groups.get(id);
        if (list) list.push(row); else groups.set(id, [row]);
      }
      return [...groups];
    };
    const byTokens = <T extends { totals: AiUsageTotals }>(a: T, b: T) =>
      b.totals.inputTokens + b.totals.outputTokens - (a.totals.inputTokens + a.totals.outputTokens) || b.totals.requests - a.totals.requests;

    const available = new Map<string, number>();
    for (const item of scoped) if (within(item.day)) available.set(item.row.provider, (available.get(item.row.provider) ?? 0) + 1);

    const buckets = new Map<string, BucketTally>();
    const dailyRows = new Map<string, Stored[]>();
    const hours = Array.from({ length: 24 }, () => new MetricTally());
    for (const item of inRange) {
      const key = bucket === 'hour' ? `${item.day}T${String(item.hour).padStart(2, '0')}` : item.day;
      let tally = buckets.get(key);
      if (!tally) buckets.set(key, tally = new BucketTally());
      tally.add(item.row);
      hours[item.hour]!.add(item.row);
      const dayItems = dailyRows.get(item.day);
      if (dayItems) dayItems.push(item.row); else dailyRows.set(item.day, [item.row]);
    }

    let activity: AiUsageSummary['activity'];
    if (options.activity) {
      const activeDays = new Map<string, MetricTally>();
      for (const item of filtered) {
        if (item.day < activityFrom || item.day > range.today) continue;
        let tally = activeDays.get(item.day);
        if (!tally) activeDays.set(item.day, tally = new MetricTally());
        tally.add(item.row);
      }
      activity = {
        from: activityFrom,
        to: range.today,
        days: [...activeDays].sort(([a], [b]) => a.localeCompare(b)).map(([day, tally]): AiUsageActivityDay => ({ day, ...tally.metric(), unknown: tally.unknown })),
      };
    }

    return {
      days: range.days, from, to, bucket, timeZone, provider,
      account: accountId ? 'signed-in' : 'local',
      coverageSince: rows.length ? Math.min(...rows.map(row => row.createdAt)) : null,
      totals: totals(rows),
      daily: [...dailyRows].map(([day, items]) => ({ day, totals: totals(items) })).sort((a, b) => a.day.localeCompare(b.day)),
      models: group(rows, row => JSON.stringify([row.provider, row.model])).map(([, items]) => ({ provider: items[0]!.provider, model: items[0]!.model, totals: totals(items) })).sort(byTokens),
      projects: group(rows, row => row.projectId ?? '').map(([id, items]) => ({ projectId: id || null, totals: totals(items) })).sort(byTokens),
      providers: group(rows, row => row.provider).map(([id, items]) => ({ provider: id, totals: totals(items) })).sort(byTokens),
      availableProviders: [...available].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, requests]) => ({ provider: id, requests })),
      series: [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([start, tally]) => tally.bucket(start)),
      hours: hours.map(tally => tally.metric()),
      recent: rows.slice(0, Math.max(0, Math.min(1000, options.limit ?? 100)))
        .map(({ accountId: _account, charged, refunded, reported, reserved, ...row }) => ({ ...row, chargedUsd: usd(charged), refundedUsd: usd(refunded), reportedUsd: usd(reported), reservedUsd: usd(reserved) })),
      ...(activity ? { activity } : {}),
    };
  }
}

/** Bounded side observer; byte-for-byte delivery is owned by the caller. */
export class UsageReceiptObserver {
  private readonly decoder = new TextDecoder(); private pending=''; private raw='';
  constructor(private readonly streaming: boolean, private readonly observe: (payload: unknown)=>void) {}
  push(bytes: Uint8Array) {
    const text = this.decoder.decode(bytes,{stream:true});
    if(!this.streaming){if(this.raw.length+text.length<=16*1024*1024)this.raw+=text;return;}
    this.pending+=text;
    const lines=this.pending.split('\n'); this.pending=lines.pop()??'';
    for(const line of lines)if(line.startsWith('data:'))this.parse(line.slice(5).trim());
    if(this.pending.length>1024*1024)this.pending='';
  }
  private parse(text:string){if(!text||text==='[DONE]')return;try{this.observe(JSON.parse(text));}catch{}}
  finish(){const tail=this.decoder.decode();if(this.streaming){this.pending+=tail;if(this.pending.startsWith('data:'))this.parse(this.pending.slice(5).trim());}else this.parse(this.raw+tail);}
}
