import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import * as zlib from 'node:zlib';
import type { Transform } from 'node:stream';
import Database from 'better-sqlite3';
import type { AiUsageLocalScan, AiUsageLocalSource } from '@open-design/contracts';
import type { NativeUsage } from './usage-local-parsers.js';
import { localUsageParser, localUsageDocument } from './usage-agent-parsers.js';
import { readLocalUsageDatabase } from './usage-agent-databases.js';
import { discoverUsageSources } from './usage-source-discovery.js';
import { museUsagePrices } from './usage-muse.js';
import { estimateUsageUsd, UsagePricing, USAGE_PRICE_SOURCE, type UsagePriceSnapshot } from './usage-pricing.js';
import type { AiUsageStore } from './usage-store.js';

export interface LocalUsageSource { provider: string; roots: string[]; format?: string; detectOnly?: boolean }
interface CachedFile { stamp: string; rows: NativeUsage[]; issues: Set<NonNullable<AiUsageLocalSource['issues']>[number]> }
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SCAN_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
// Node 24 exposes Zstd; some transitive Node type versions still omit it.
const createZstdDecompress = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;

export function localUsageSources(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): LocalUsageSource[] {
  const codex = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, '.codex');
  const claude = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude');
  const data = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return [
    { provider: 'codex', roots: [path.join(codex, 'sessions'), path.join(codex, 'archived_sessions')] },
    { provider: 'claude', roots: [path.join(claude, 'projects')] },
    { provider: 'gemini', roots: [path.join(home, '.gemini', 'tmp')] },
    { provider: 'muse', roots: [path.join(data, 'muse', 'sessions')] },
    { provider: 'opencode', roots: [path.join(data, 'opencode', 'storage', 'message'), path.join(data, 'opencode', 'opencode.db')] },
  ];
}

/** Known Fantay sessions are excluded from native imports, including older sessions retained in status events. */
export function fantayUsageSessions(db: Database.Database): Set<string> {
  const out = new Set<string>();
  const exists = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (exists('agent_sessions')) {
    for (const r of db.prepare('SELECT agent_id AS provider, session_id AS session FROM agent_sessions').all() as { provider: string; session: string }[]) out.add(`${r.provider}:${r.session}`);
  }
  if (!exists('messages')) return out;
  const queries = ["SELECT agent_id AS provider, events_json AS events FROM messages"];
  if (exists('message_event_batches')) queries.push('SELECT m.agent_id AS provider, b.events_json AS events FROM message_event_batches b JOIN messages m ON m.id=b.message_id');
  for (const source of queries) {
    const sql = `SELECT DISTINCT logs.provider, COALESCE(json_extract(j.value,'$.data.sessionId'),json_extract(j.value,'$.sessionId')) AS session FROM (${source}) logs, json_each(CASE WHEN json_valid(logs.events) THEN logs.events ELSE '[]' END) j WHERE j.type='object' AND COALESCE(json_extract(j.value,'$.data.type'),json_extract(j.value,'$.type'))='status' AND session IS NOT NULL`;
    for (const r of db.prepare(sql).all() as { provider: string; session: string }[]) out.add(`${r.provider}:${r.session}`);
  }
  return out;
}

/** Reads external logs only on device-scope requests. The cache contains usage metadata, never conversation text. */
export class LocalAgentUsage {
  private files = new Map<string, CachedFile>();
  private agyModels = new Map<string,{stamp:string;models:Map<number,string>}>();
  private inFlight: Promise<AiUsageLocalScan> | null = null;
  private last: { since: number; result: AiUsageLocalScan; provider: string | undefined } | null = null;
  private readonly pricing: UsagePricing;

  constructor(private readonly store: AiUsageStore, dataDir: string, private readonly sources?: LocalUsageSource[], private readonly prices?: () => Promise<UsagePriceSnapshot | null>) {
    this.pricing = new UsagePricing(dataDir);
  }

  async sync(since: number, provider?: string): Promise<AiUsageLocalScan> {
    if (this.inFlight) { await this.inFlight; return this.sync(since, provider); }
    if (this.last && (!this.last.provider || this.last.provider === provider) && this.last.since <= since && Date.now() - this.last.result.scannedAt < 25_000) return this.last.result;
    this.inFlight = this.scan(since, provider);
    try {
      const result = await this.inFlight;
      this.last = { since, result, provider };
      return result;
    } finally { this.inFlight = null; }
  }

  private async scan(since: number, provider?: string): Promise<AiUsageLocalScan> {
    const snapshot = await (this.prices?.() ?? this.pricing.get());
    const results: AiUsageLocalSource[] = [];
    const visited = new Set<string>();
    for (const source of this.sources ?? await discoverUsageSources(localUsageSources())) {
      if (provider && source.provider !== provider) continue;
      let bytes = 0, entries = 0;
      const status: AiUsageLocalSource = { provider: source.provider, status: 'not-found', files: 0, records: 0 };
      const format = source.format ?? source.provider;
      const sourcePrices = format === 'muse' ? await museUsagePrices(source.roots) : snapshot;
      if (format === 'muse') status.pricingSource = 'local-model-catalog';
      const issues = new Set<NonNullable<AiUsageLocalSource['issues']>[number]>();
      const partial = (reason: NonNullable<AiUsageLocalSource['issues']>[number]) => { issues.add(reason); status.status = 'partial'; };
      results.push(status);
      const rows = new Map<string, NativeUsage>();
      const accept = (row: NativeUsage | null) => {
        if (!row || !Number.isFinite(row.at) || row.at < since) return;
        const previous = rows.get(row.key);
        const preferred = row.provider === 'muse' && row.model === 'unknown' && previous && previous.model !== 'unknown' ? previous : row;
        rows.set(row.key, previous ? { ...preferred, input: Math.max(previous.input, row.input), output: Math.max(previous.output, row.output), cacheRead: Math.max(previous.cacheRead, row.cacheRead), cacheWrite: Math.max(previous.cacheWrite, row.cacheWrite) } : row);
      };
      const visit = async (file: string, depth = 0): Promise<void> => {
        if (++entries > MAX_ENTRIES || depth > 12) { partial('scan-limit'); return; }
        try {
          const stat = await lstat(file);
          if (stat.isSymbolicLink()) { if (depth === 0) await visit(await realpath(file), 1); return; }
          const canonical = await realpath(file);
          if (visited.has(canonical)) return;
          visited.add(canonical);
          if (status.status === 'not-found') status.status = 'ready';
          if (source.detectOnly) { status.status = 'unsupported'; issues.add('unsupported-format'); return; }
          if (stat.isDirectory()) {
            if(path.basename(file)==='subagent-artifacts')return;
            for (const child of (await readdir(file)).sort().reverse()) {
              if (format === 'muse' && child.startsWith('.')) continue;
              if (entries >= MAX_ENTRIES || bytes >= MAX_SCAN_BYTES) { partial('scan-limit'); break; }
              await visit(path.join(file, child), depth + 1);
            }
            return;
          }
          if (!stat.isFile()) return;
          if (format === 'muse' && path.basename(file) !== 'session.jsonl') return;
          const database = /\.(?:db|sqlite|vscdb)$/.test(file);
          const jsonl = /\.jsonl(?:\.zst|\.zstd)?$/.test(file);
          if (!database && !(format === 'codex' || format === 'claude' ? jsonl : file.endsWith('.json') || jsonl)) return;
          if (format === 'gemini' && !(path.basename(file).startsWith('session-') && path.basename(path.dirname(file)) === 'chats')) return;
          if (format === 'gemini' && file.endsWith('.json') && await lstat(`${file}l`).then(s=>s.isFile()).catch(()=>false)) return;
          if(format==='cline'&&!file.endsWith('.messages.json')||format==='droid'&&!file.endsWith('.settings.json'))return;
          if(format==='agy'&&path.basename(file)!=='transcript_full.jsonl'||format==='kimi'&&path.basename(file)!=='wire.jsonl')return;
          if(format==='grok'&&path.basename(file)!=='updates.jsonl'||format==='copilot'&&path.basename(file)!=='events.jsonl')return;
          if(format==='dsh'&&!/^session\.[^.]+\.jsonl(?:\.zst|\.zstd)?$/.test(path.basename(file)))return;
          if(format==='devin'&&!database&&path.basename(file)!=='log.jsonl')return;
          if (!database && stat.mtimeMs < since) return;
          status.files++;
          if (database) {
            try {
              for (const row of readLocalUsageDatabase(file,format,since,()=>partial('scan-limit'))) accept({...row,provider:source.provider});
            } catch { partial('unsupported-format'); }
            return;
          }
          if (stat.size > MAX_FILE_BYTES) { partial('file-limit'); return; }
          if (bytes + stat.size > MAX_SCAN_BYTES) { partial('scan-limit'); return; }
          const stamp = `${stat.mtimeMs}:${stat.size}`;
          let cached = this.files.get(canonical);
          if (!cached || cached.stamp !== stamp) {
            bytes += stat.size;
            cached = { stamp, rows: [], issues: new Set() };
            if (jsonl) {
              const parser = localUsageParser(format, path.basename(file).replace(/\.jsonl(?:\.zst|\.zstd)?$/, ''), reason => { cached!.issues.add(reason ?? 'history-overlap'); }, file, stat.mtimeMs);
              const stream = createReadStream(file, { end: Math.max(0, stat.size - 1) });
              const compressed = /\.zst(?:d)?$/.test(file);
              if (compressed && !createZstdDecompress) { stream.destroy(); partial('unsupported-format'); return; }
              const input = compressed ? stream.pipe(createZstdDecompress!()) : stream;
              if(input!==stream)stream.on('error',error=>input.destroy(error));
              const lines = createInterface({ input, crlfDelay: Infinity });
              let expanded = 0;
              try {
                for await (const line of lines) {
                  expanded += line.length;
                  if (expanded > MAX_FILE_BYTES) { cached.issues.add('file-limit'); break; }
                  if (!line.trim()) continue;
                  if (format === 'codex' && !/"type"\s*:\s*"(?:session_meta|turn_context|token_usage_record|event_msg)"/.test(line.slice(0,512))) continue;
                  if (line.length > 4 * 1024 * 1024) { cached.issues.add('file-limit'); continue; }
                  try { for(const parsed of parser.parse(JSON.parse(line))) cached.rows.push({...parsed,provider:source.provider}); } catch { cached.issues.add('invalid-record'); }
                }
              } catch { cached.issues.add('invalid-record'); }
              finally { lines.close(); input.destroy(); stream.destroy(); }
              for(const tail of parser.finish()) cached.rows.push({...tail,provider:source.provider});
            } else {
              try {
                const value: unknown = JSON.parse(await readFile(file, 'utf8'));
                if(format==='cline'&&value&&typeof value==='object'){
                  try{const manifest=JSON.parse(await readFile(file.replace(/\.messages\.json$/,'.json'),'utf8'));Object.assign(value,{__forkCutoff:manifest?.metadata?.fork?.forkedAt});}catch{}
                }
                cached.rows = localUsageDocument(format,value,path.basename(file),()=>cached!.issues.add('unsupported-format'),file,stat.mtimeMs).map(row=>({...row,provider:source.provider}));
              } catch { cached.issues.add('invalid-record'); }
            }
            this.files.set(canonical, cached);
          }
          for(const issue of cached.issues) partial(issue);
          let agyModels:Map<number,string>|undefined;
          if(format==='agy'&&cached.rows.some(row=>row.model==='unknown')){
            const sessionRoot=path.dirname(path.dirname(path.dirname(file)));
            const database=path.join(path.dirname(path.dirname(sessionRoot)),'conversations',`${path.basename(sessionRoot)}.db`);
            try{
              const dbStat=await lstat(database),wal=await lstat(`${database}-wal`).catch(()=>null),stamp=`${dbStat.mtimeMs}:${dbStat.size}:${wal?.mtimeMs}:${wal?.size}`;
              let saved=this.agyModels.get(database);
              if(!saved||saved.stamp!==stamp){saved={stamp,models:new Map(readLocalUsageDatabase(database,'antigravity-db',0,()=>{}).filter(r=>r.sourceStep!==undefined).map(r=>[r.sourceStep!,r.model]))};this.agyModels.set(database,saved);}
              agyModels=saved.models;
            }catch{/* The historical model is optional; never use the currently selected model. */}
          }
          for (const row of cached.rows) accept(row.model==='unknown'&&row.sourceStep!==undefined&&agyModels?.has(row.sourceStep)?{...row,model:agyModels.get(row.sourceStep)!}:row);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { status.status = 'error'; issues.add('permission'); }
        }
      };
      for (const root of source.roots) await visit(root);
      this.store.transaction(() => {
        for (const row of rows.values()) this.store.recordLocal({
          key: `external:${row.provider}:${row.key}`, provider: row.provider, model: row.model, origin: 'external', sessionId: row.sessionId,
          context: {}, at: row.at, usage: { input_tokens: row.input, output_tokens: row.output, cache_read_input_tokens: row.cacheRead, cache_creation_input_tokens: row.cacheWrite },
          reportedUsd: row.reportedUsd, estimatedUsd: row.reportedUsd === undefined ? estimateUsageUsd(sourcePrices, row) : undefined,
          ...(row.status ? {status:row.status} : {}),
          ...(row.granularity ? {granularity:row.granularity} : {}),
          ...(row.requestCount === undefined ? {} : {requestCount:row.requestCount}),
        });
      });
      status.records = rows.size;
      status.issues = [...issues];
    }
    // Bound long-running memory usage to files that still exist in these sources.
    if (!provider) for (const key of this.files.keys()) if (!visited.has(key)) this.files.delete(key);
    return { scannedAt: Date.now(), sources: results, pricing: { source: USAGE_PRICE_SOURCE, fetchedAt: snapshot?.fetchedAt ?? null } };
  }
}
