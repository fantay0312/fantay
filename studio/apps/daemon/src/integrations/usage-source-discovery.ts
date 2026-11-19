import { readdir, stat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSON5 from 'json5';
import type { LocalUsageSource } from './usage-local-agents.js';

const exists = async (file: string) => stat(file).then(() => true).catch(() => false);
const directories = async (root: string) => (await readdir(root,{withFileTypes:true}).catch(()=>[])).filter(d=>d.isDirectory()||d.isSymbolicLink()).slice(0,500).map(d=>path.join(root,d.name));

/** Bounded, metadata-only discovery. Credentials are never read to discover another profile. */
export async function discoverUsageSources(base: LocalUsageSource[], home = os.homedir(), env: NodeJS.ProcessEnv = process.env): Promise<LocalUsageSource[]> {
  const absolute = (v: unknown): string | undefined => typeof v==='string' && path.isAbsolute(v) ? v : undefined;
  const expanded = (v:unknown):string|undefined => typeof v==='string' ? absolute(v.startsWith('~/')?path.join(home,v.slice(2)):v) : undefined;
  const data = absolute(env.XDG_DATA_HOME) ?? path.join(home,'.local','share');
  const config = absolute(env.XDG_CONFIG_HOME) ?? path.join(home,'.config');
  const systemConfig = process.platform==='darwin'?path.join(home,'Library','Application Support'):process.platform==='win32'?(absolute(env.APPDATA)??config):config;
  const sources=base.map(s=>({...s,roots:[...s.roots]}));
  const add=(provider:string,format:string,roots:Array<string|undefined>,detectOnly=false)=>sources.push({provider,format,roots:roots.filter((r):r is string=>!!r),...(detectOnly?{detectOnly:true}:{})});
  const ccPath=path.join(home,'.cc-switch','settings.json');
  let cc:Record<string,unknown>={};
  try {cc=JSON.parse(await readFile(ccPath,'utf8')) as Record<string,unknown>;} catch{}
  for(const [provider,key,child] of [['claude','claudeConfigDir','projects'],['codex','codexConfigDir','sessions'],['gemini','geminiConfigDir','tmp']] as const){
    const root=absolute(cc[key]); if(!root)continue;
    sources.find(s=>s.provider===provider)?.roots.push(path.join(root,child));
    if(provider==='codex')sources.find(s=>s.provider===provider)?.roots.push(path.join(root,'archived_sessions'));
  }
  for(const provider of ['claude','codex'] as const){
    const main=absolute(env[provider==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME'])??path.join(home,`.${provider}`);
    const homes=new Set([main]);
    for(const parent of new Set([home,path.dirname(main)]))for(const candidate of await directories(parent)){
      if(!path.basename(candidate).replace(/^\./,'').toLowerCase().startsWith(provider))continue;
      const isHome=async(root:string)=>exists(path.join(root,provider==='claude'?'projects':'sessions')).then(async found=>found||provider==='codex'&&await exists(path.join(root,'auth.json')));
      if(await isHome(candidate))homes.add(candidate);
      else for(const nested of await directories(candidate))if(await isHome(nested))homes.add(nested);
    }
    if(provider==='claude')for(const account of await directories(path.join(config,'magpie','claude-accounts')))if(await exists(path.join(account,'projects')))homes.add(account);
    const source=sources.find(s=>s.provider===provider)!;
    for(const root of homes)source.roots.push(...(provider==='claude'?[path.join(root,'projects')]:[path.join(root,'sessions'),path.join(root,'archived_sessions')]));
  }
  if(absolute(env.GEMINI_CLI_HOME))sources.find(s=>s.provider==='gemini')?.roots.push(path.join(env.GEMINI_CLI_HOME!,'.gemini','tmp'));
  if(env.OPENCODE_DB && env.OPENCODE_DB!==':memory:')sources.find(s=>s.provider==='opencode')?.roots.push(path.resolve(data,'opencode',env.OPENCODE_DB));
  add('grok','grok',[path.join(absolute(cc.grokConfigDir)??path.join(home,'.grok'),'sessions'),path.join(absolute(cc.grokConfigDir)??path.join(home,'.grok'),'archived_sessions')]);
  const pi=expanded(env.PI_CODING_AGENT_DIR)??path.join(home,'.pi','agent');
  const piSessions=[expanded(env.PI_CODING_AGENT_SESSION_DIR),path.join(pi,'sessions')];
  try{const settings=JSON5.parse(await readFile(path.join(pi,'settings.json'),'utf8'));piSessions.push(expanded(settings.sessionDir));}catch{}
  add('pi','pi',piSessions);
  const ompConfig=expanded(env.PI_CONFIG_DIR)??path.join(home,env.PI_CONFIG_DIR??'.omp');
  const ompRoots=[path.join(ompConfig,'agent','sessions'),path.join(data,'omp','sessions')];
  for(const profile of await directories(path.join(ompConfig,'profiles')))ompRoots.push(path.join(profile,'agent','sessions'));
  for(const profile of await directories(path.join(data,'omp','profiles')))ompRoots.push(path.join(profile,'sessions'));
  add('omp','omp',ompRoots);
  add('mcode','mcode',[path.join(expanded(env.MINIMAX_DATA_DIR)??expanded(env.MAVIS_DATA_DIR)??path.join(home,'.minimax'),'v2','sqlite','runtime-state.sqlite')]);
  add('deepseek-harness','dsh',[path.join(expanded(env.DSH_HOME)??path.join(home,'.dsh'),'sessions')]);
  add('kimi','kimi',[path.join(expanded(env.KIMI_CODE_HOME)??path.join(home,'.kimi-code'),'sessions')]);
  add('copilot','copilot',[path.join(expanded(env.COPILOT_HOME)??path.join(home,'.copilot'),'session-state')]);
  add('workbuddy','workbuddy',[path.join(expanded(env.WORKBUDDY_CONFIG_DIR)??path.join(home,'.workbuddy'),'projects')]);
  add('codebuddy','workbuddy',[path.join(expanded(env.CODEBUDDY_CONFIG_DIR)??path.join(home,'.codebuddy'),'projects')]);
  add('workbuddy-ai','workbuddy',[path.join(home,'.workbuddy-ai','projects')]);
  const agy=[path.join(home,'.gemini','antigravity-cli','brain')];
  for(const provider of await directories(path.join(home,'.cc-switch','agy')))agy.push(path.join(provider,'antigravity-cli','brain'));
  add('antigravity','agy',agy);
  add('antigravity-ide','antigravity-db',[path.join(home,'.gemini','antigravity','conversations')]);
  add('antigravity-insiders','antigravity-db',[path.join(home,'.gemini','antigravity-insiders','conversations')]);
  const devin=expanded(env.DEVIN_SESSIONS_DIR)?path.join(env.DEVIN_SESSIONS_DIR!,'cli'):path.join(data,'devin','cli');
  add('devin','devin',[path.join(devin,'sessions.db'),path.join(devin,'sessions')]);
  add('zcode','zcode',[path.join(home,'.zcode','cli','db','db.sqlite')]);
  add('qoder','claude',[path.join(expanded(env.QODER_CONFIG_DIR)??path.join(home,'.qoder'),'projects')]);
  add('qoder-cn','claude',[path.join(expanded(env.QODERCN_CONFIG_DIR)??path.join(home,'.qoder-cn'),'projects')]);
  add('cindy','pi',[path.join(systemConfig,'Cindy','pi-agent-home','sessions')]);
  add('cindy-global','pi',[path.join(systemConfig,'CindyGlobal','pi-agent-home','sessions')]);
  const raft:string[]=[];
  for(const agent of await directories(path.join(expanded(env.SLOCK_HOME)??path.join(home,'.slock'),'agents')))raft.push(path.join(agent,'.pi-sessions'),path.join(agent,'.builtin-sessions'));
  add('raft','pi',raft);
  add('cline','cline',[expanded(env.CLINE_SESSION_DATA_DIR)??(expanded(env.CLINE_DATA_DIR)?path.join(env.CLINE_DATA_DIR!,'sessions'):path.join(expanded(env.CLINE_DIR)??path.join(home,'.cline'),'data','sessions'))]);
  add('droid','droid',[path.join(expanded(env.FACTORY_HOME_OVERRIDE)??home,'.factory','sessions')]);
  const hermes=expanded(env.HERMES_HOME)??(process.platform==='win32'?path.join(absolute(env.LOCALAPPDATA)??systemConfig,'hermes'):path.join(home,'.hermes'));
  const hermesDb=[path.join(hermes,'state.db')];for(const profile of await directories(path.join(hermes,'profiles')))hermesDb.push(path.join(profile,'state.db'));
  add('hermes','hermes',hermesDb);
  add('alma','alma',[path.join(systemConfig,'alma','chat_threads.db')]);
  add('cursor-agent','detect',[expanded(env.CURSOR_CONFIG_DIR)??(absolute(env.XDG_CONFIG_HOME)?path.join(config,'cursor'):path.join(home,'.cursor')),path.join(systemConfig,'Cursor')],true);
  for(const source of sources){
    const roots=new Set<string>();
    for(const root of source.roots)roots.add(await realpath(root).catch(()=>root));
    source.roots=[...roots];
  }
  return sources;
}
