import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TokenToSeaIdentity } from '../integrations/tokentosea.js';
import { registerTokenToSeaShareRoutes, type TokenToSeaShareProjects } from './tokentosea-share.js';
import { registerTokenToSeaMovieRoutes, type TokenToSeaMovieProjects } from './tokentosea-movie.js';
import { nativeRuntimeDir, nativeSnapshot, writeNativeAccountSnapshot } from '../movie/native-editor.js';
import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tokenToSeaCookie, tokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';
import { isTokenToSeaWriteOrigin } from '../http/tokentosea-origin.js';
import { DisplayCurrencyRates } from '../integrations/display-currency.js';

const COOKIE = 'fantay_identity';
function nativeDesktopRequest(req:Request):boolean {
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??''))return false;
  if(req.headers.origin==='od://app')return true;
  try{const origin=new URL(String(req.headers.origin));if(['http:','https:'].includes(origin.protocol)&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname)&&origin.host===req.headers.host)return true;}catch{}
  // Electron's custom-scheme proxy may omit Origin; external browser origins
  // remain rejected above, and this route never creates or transfers credentials.
  return (!req.headers.origin||req.headers.origin==='null')&&req.headers['x-od-client']==='desktop';
}
function session(req: Request): string {
  return tokenToSeaCookie(req);
}

export function registerTokenToSeaRoutes(app: Express, dataDir: string, projects?: TokenToSeaShareProjects, movieProjects?: TokenToSeaMovieProjects): void {
  const identity = tokenToSeaRuntime().identity;
  const currencies = new DisplayCurrencyRates();
  app.get('/api/tokentosea/currency', async (req, res) => {
    try {
      const locale = typeof req.query.locale === 'string' && req.query.locale.length <= 32 ? req.query.locale : 'en';
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await currencies.quote(locale));
    } catch { res.status(503).json({ error: 'exchange_rate_unavailable' }); }
  });
  if (projects) registerTokenToSeaShareRoutes(app, identity, projects, dataDir);
  if (movieProjects) registerTokenToSeaMovieRoutes(app, identity, movieProjects);
  const fail = (res: Response, error: unknown) => res.status(400).json({ error: error instanceof Error ? error.message : '登录服务暂时不可用' });
  app.use('/api/tokentosea', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
    if (isTokenToSeaWriteOrigin(req)) { next(); return; }
    res.status(403).json({ error: '请求来源无效' });
  });
  app.use('/api/tokentosea', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.post('/api/tokentosea/native/sync',async(req,res)=>{
    try{
      if(!nativeDesktopRequest(req)){res.status(403).json({error:'Native account sync requires the desktop session'});return;}
      const id=session(req),user=id?await identity.session(id):null;
      let availableUsd:string|undefined;
      if(user){try{const wallet=await identity.service(id,'wallet','GET');if(wallet.ok)availableUsd=(await wallet.json() as {availableUsd?:string}).availableUsd;}catch{}}
      const publicUser=user?{id:user.id,name:user.name,email:user.email,picture:user.picture}:null;
      await writeNativeAccountSnapshot(dataDir,{signedIn:Boolean(user),pending:id?identity.pending(id):false,user:publicUser,availableUsd,refreshedAt:Date.now()});
      const usage=tokenToSeaRuntime().usage.summary(user?.id??null,30);
      let bindings:Record<string,string>={};try{bindings=JSON.parse(await readFile(path.join(nativeRuntimeDir(dataDir),'projects.json'),'utf8'));}catch{}
      await nativeSnapshot(dataDir,'usage.json',{refreshedAt:Date.now(),totals:usage.totals,projects:Object.entries(bindings).flatMap(([projectPath,projectId])=>{const summary=usage.projects.find(row=>row.projectId===projectId);return summary?[{projectPath,projectId,totals:summary.totals}]:[];})});
      if(Array.isArray(req.body?.channels))await nativeSnapshot(dataDir,'channels.json',{channels:req.body.channels.slice(0,100).map((c:any)=>({id:String(c.id).slice(0,100),label:String(c.label).slice(0,100),available:c.available===true,models:Array.isArray(c.models)?c.models.slice(0,100).map((m:any)=>({id:String(m.id).slice(0,200),label:String(m.label).slice(0,200),enabled:m.enabled!==false})):[]})),selectedId:String(req.body.selectedId??''),modelId:String(req.body.modelId??'default'),theme:['system','light','dark'].includes(req.body.theme)?req.body.theme:'system'});
      res.json({ok:true});
    }catch(error){fail(res,error);}
  });
  app.post('/api/tokentosea/native/action',async(req,res)=>{
    if(!nativeDesktopRequest(req)){res.status(403).json({error:'Desktop session required'});return;}
    const root=nativeRuntimeDir(dataDir),actions:Record<string,unknown>[]=[];
    let bindings:Record<string,string>={};try{bindings=JSON.parse(await readFile(path.join(root,'projects.json'),'utf8'));}catch{}
    const queued=await readdir(path.join(root,'actions')).catch(()=>[]);
    for(const name of queued.filter(n=>/^[\w-]+\.json$/.test(n)).sort().slice(0,20)){
      const file=path.join(root,'actions',name);
      try{const a=JSON.parse(await readFile(file,'utf8'));await unlink(file);if(Date.now()-a.at>30000)continue;const projectId=typeof a.projectPath==='string'?bindings[a.projectPath]:undefined;
        if(['open-account','open-usage','open-movies','select-channel','select-model','select-execution','open-channels','set-theme'].includes(a.action)||projectId&&['open-generation','chat-send','chat-new','chat-select','chat-stop'].includes(a.action))actions.push({action:a.action,projectId,value:typeof a.value==='string'?a.value.slice(0,32000):''});
      }catch{}
    }
    res.json({actions});
  });
  app.get('/api/tokentosea/status', async (req, res) => {
    try {
      const id = session(req);
      const clientId = await identity.clientId();
      const user = id ? await identity.session(id) : null;
      if (id && user) {
        const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        res.setHeader('Set-Cookie', `fantay_session=${id}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`);
      }
      res.json({ configured: Boolean(clientId), clientId, redirectUri: identity.redirectUri, signedIn: Boolean(user), pending: id ? identity.pending(id) : false, user, ...(id && identity.error(id) ? { error: identity.error(id) } : {}) });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/tokentosea/configure', async (req, res) => {
    try {
      // Client registration is a local administrator setting, not a browser-wide preference.
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) { res.status(403).json({ error: '请由本机管理员配置 Client ID' }); return; }
      await identity.configure(String(req.body?.clientId ?? '').trim());
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/tokentosea/login', async (req, res) => {
    try {
      const id = session(req) || randomBytes(32).toString('base64url');
      tokenToSeaRuntime().revokeSession(id);
      const authorizeUrl = await identity.begin(id);
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `fantay_session=${id}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`);
      res.json({ authorizeUrl });
    } catch (error) { fail(res, error); }
  });
  app.get('/api/tokentosea/callback', async (req, res) => {
    const params = new URL(req.originalUrl, 'http://localhost').searchParams;
    try { const user = await identity.complete(params); identity.resultPage(res, true, { user }); }
    catch (error) { identity.resultPage(res, false, { error: error instanceof Error ? error.message : undefined }); }
  });
  app.post('/api/tokentosea/logout', async (req, res) => {
    try {
      const id = session(req);
      tokenToSeaRuntime().revokeSession(id);
      if (id) await identity.logout(id);
      res.setHeader('Set-Cookie', [`${COOKIE}=; Path=/api/tokentosea; HttpOnly; SameSite=Lax; Max-Age=0`, 'fantay_session=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0']);
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });
  app.all(/^\/api\/tokentosea\/service\/(.+)$/, async (req, res) => {
    try {
      const method = req.method;
      if (method !== 'GET' && method !== 'POST') { res.status(405).end(); return; }
      const projectId = req.get('x-fantay-project-id');
      if(projectId && (!movieProjects || !await movieProjects.authorize(req,res,projectId)))return;
      const upstream = await tokenToSeaRuntime().trackedService(session(req), String(req.params[0]), method, method === 'POST' ? req.body : undefined, req.query,undefined,undefined,projectId?{projectId}:undefined);
      res.status(upstream.status).set('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as never), res); else res.end();
    } catch (error) { if (!res.headersSent) fail(res, error); else res.end(); }
  });
}
