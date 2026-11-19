import { parseArgs } from 'node:util';
import { resolveDaemonUrl } from '../daemon-url.js';
import type { AiUsageSummary } from '@open-design/contracts';

const HELP = `Usage: od usage [options]

Reads the same /api/usage summary the AI 用量 page shows.

  --days 7|30|90          the last N calendar days ending today (default 30)
  --from YYYY-MM-DD       inclusive start day; use with --to instead of --days (at most 366 days)
  --to YYYY-MM-DD         inclusive end day
  --time-zone <zone>      IANA zone to count days and hours in (default: this machine's)
  --project <id>          one project
  --provider <id>         one provider / agent (e.g. claude, codex, tokentosea)
  --session <id>          one native session (requires --provider)
  --scope fantay|device   Fantay only (default) or supported agents on this device
  --limit <0-1000>        how many recent requests to include (default 100)
  --activity              include the 53-week daily activity series
  --json                  print the raw summary as JSON
  --daemon-url <url>      daemon to query`;

export async function runUsageCli(args:string[]):Promise<void>{
  const {values}=parseArgs({args,options:{
    project:{type:'string'},
    days:{type:'string'},
    from:{type:'string'},
    to:{type:'string'},
    'time-zone':{type:'string'},
    provider:{type:'string'},
    session:{type:'string'},
    scope:{type:'string'},
    limit:{type:'string'},
    activity:{type:'boolean'},
    json:{type:'boolean'},
    help:{type:'boolean'},
    'daemon-url':{type:'string'},
  }});
  if(values.help){console.log(HELP);return;}
  try {
    const base=await resolveDaemonUrl({...values['daemon-url']?{flagUrl:values['daemon-url']}:{}});
    const query=new URLSearchParams({timeZone:values['time-zone']??Intl.DateTimeFormat().resolvedOptions().timeZone});
    if(values.from!==undefined||values.to!==undefined){
      if(values.from!==undefined)query.set('from',values.from);
      if(values.to!==undefined)query.set('to',values.to);
    }else query.set('days',values.days??'30');
    if(values.project)query.set('projectId',values.project);
    if(values.provider)query.set('provider',values.provider);
    if(values.session)query.set('sessionId',values.session);
    if(values.scope)query.set('scope',values.scope);
    if(values.limit!==undefined)query.set('limit',values.limit);
    if(values.activity)query.set('activity','1');
    const response=await fetch(`${base}/api/usage?${query}`,{headers:{'X-Fantay-CLI':'1',...process.env.OD_API_TOKEN?{Authorization:`Bearer ${process.env.OD_API_TOKEN}`}:{}}});
    const result=await response.json() as AiUsageSummary&{error?:string};
    if(!response.ok)throw new Error(result.error??`Usage request failed (${response.status})`);
    if(values.json){console.log(JSON.stringify(result));return;}
    const t=result.totals;
    const lines=[
      `Scope: ${result.scope ?? 'fantay'}`,
      `Sessions: ${result.sessions?.length ?? 0}${result.sessionId ? `; selected ${result.sessionId}` : ''}`,
      `Range: ${result.from} → ${result.to} (${result.timeZone})${result.provider?`; provider ${result.provider}`:''}`,
      `Requests: ${t.requests}; failed: ${t.failed ?? 0}; pending: ${t.pending}`,
      ...(t.sessionRecords ? [`Session summaries: ${t.sessionRecords}; per-request timestamps unavailable for these records`] : []),
      `Input / output / cache-read tokens: ${t.inputTokens} / ${t.outputTokens} / ${t.cachedTokens}`,
      `TokenToSea charged / refunded: $${t.chargedUsd} / $${t.refundedUsd}`,
      `Other providers reported: $${t.reportedUsd}; cost unavailable: ${t.unknown}`,
      `Estimated token value: $${t.estimatedUsd ?? '0.000000'} (${t.estimatedRequests ?? 0} requests; not charged)`,
    ];
    if(result.localScan)lines.push('Local agents:',...result.localScan.sources.map(source=>`  ${source.provider}: ${source.status}; ${source.files} files, ${source.records} records${source.issues?.length ? `; ${source.issues.join(', ')}` : ''}`));
    const top=(result.models??[]).slice(0,5);
    if(top.length)lines.push('Top models:',...top.map(m=>`  ${m.model} (${m.provider}): ${m.totals.requests} requests, ${m.totals.inputTokens+m.totals.outputTokens} tokens`));
    if(result.sessions?.length)lines.push('Recent sessions:',...result.sessions.slice(0,10).map(s=>`  ${s.sessionId} (${s.provider}): ${s.totals.requests} requests, ${s.totals.inputTokens+s.totals.outputTokens} tokens; reported $${s.totals.reportedUsd}; estimated $${s.totals.estimatedUsd ?? '0.000000'}`));
    console.log(lines.join('\n'));
  }catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
