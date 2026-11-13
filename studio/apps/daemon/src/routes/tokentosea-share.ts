import type { Express, Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { TokenToSeaIdentity } from '@fantay/tokentosea';
import { buildDeployFilePlan } from '../deploy.js';
import { validateProjectPath } from '../projects.js';
import { CanvasStore } from '../services/design-canvas.js';
import { tokenToSeaCookie } from '../integrations/tokentosea-runtime.js';
import { isTokenToSeaWriteOrigin } from '../http/tokentosea-origin.js';

export interface TokenToSeaShareProjects {
  resolve(projectId: string, fileName: string): Promise<{ directory: string; metadata: unknown; sourceFileId: string; title: string }>;
}
const cookieSession = tokenToSeaCookie;
const safeId = (value: unknown) => typeof value === 'string' && /^[\w-]{1,100}$/.test(value) ? value : '';
/** Whether the reader's own TokenToSea account holds any publication of this
 * project, active or stopped (document keys `project:<id>:<sourceFileId>`).
 * A signed-out reader proves nothing and answers false; transport failures throw. */
export async function tokenToSeaProjectHasPublication(identity: Pick<TokenToSeaIdentity, 'session' | 'share'>, req: Pick<Request, 'headers'>, projectId: string): Promise<boolean> {
  const cookie = cookieSession(req), id = safeId(projectId);
  if (!cookie || !id || !await identity.session(cookie)) return false;
  const response = await identity.share(cookie, 'shares', 'GET', undefined, AbortSignal.timeout(5_000));
  if (!response.ok) return false;
  const data = await response.json() as { shares?: unknown };
  return Array.isArray(data.shares) && data.shares.some(share => typeof share?.documentKey === 'string' && share.documentKey.startsWith(`project:${id}:`));
}
export function registerTokenToSeaShareRoutes(app: Express, identity: TokenToSeaIdentity, projects: TokenToSeaShareProjects, dataDir: string): void {
  const canvasStore = new CanvasStore(dataDir);
  const fail = (res: Response, error: unknown) => res.status(400).json({ error: error instanceof Error ? error.message : '分享服务暂时不可用' });
  // An upstream body that is not JSON (e.g. a proxy's HTML 502) becomes a readable error
  // instead of a raw SyntaxError.
  async function upstreamJson(response: globalThis.Response): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsed = await response.json().catch(() => undefined) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { status: response.status, body: parsed as Record<string, unknown> };
    return response.ok
      ? { status: 502, body: { error: '分享服务返回了无效内容' } }
      : { status: response.status, body: { error: '分享服务暂时不可用' } };
  }
  async function proxy(req: Request, res: Response, resource: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown) {
    const response = await identity.share(cookieSession(req), resource, method, body);
    const result = await upstreamJson(response);
    res.status(result.status).json(result.body);
  }
  async function description(req: Request) {
    const canvasId = safeId(req.query.canvasId ?? req.body?.canvasId);
    if (canvasId) {
      const canvas = await canvasStore.read(canvasId);
      if (!canvas) throw new Error('请先保存设计画布');
      if (req.method === 'POST' && req.body?.canvasSha !== canvas.sha256) throw new Error('画布已更新，请重新打开分享');
      return { directory: '', metadata: null, sourceFileId: canvasId, title: canvas.name, projectId: canvasId, fileName: 'index.html', documentKey: `canvas:${canvasId}`, canvas: true };
    }
    const projectId = safeId(req.query.projectId ?? req.body?.projectId);
    const fileName = validateProjectPath(String(req.query.fileName ?? req.body?.fileName ?? ''));
    if (!projectId || !fileName) throw new Error('请先选择要分享的作品');
    const project = await projects.resolve(projectId, fileName);
    return { ...project, projectId, fileName, documentKey: `project:${projectId}:${project.sourceFileId}`, canvas: false };
  }
  app.use('/api/tokentosea/shares', (req, res, next) => { if (req.method !== 'GET' && !isTokenToSeaWriteOrigin(req)) { res.status(403).json({ error: '请求来源无效' }); return; } next(); });
  app.get('/api/tokentosea/shares', async (req, res) => {
    try {
      const user = await identity.session(cookieSession(req));
      if (!user) { res.json({ user: null, publication: null }); return; }
      const document = await description(req), response = await identity.share(cookieSession(req), 'shares', 'GET');
      const result = await upstreamJson(response);
      if (!response.ok || result.status !== response.status) { res.status(result.status).json(result.body); return; }
      const shares = (result.body as { shares?: Array<{ documentKey: string }> }).shares;
      if (!Array.isArray(shares)) { res.status(502).json({ error: '分享服务返回了无效内容' }); return; }
      res.json({ user, publication: shares.find(p => p.documentKey === document.documentKey) ?? null });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/tokentosea/shares/publish', async (req, res) => {
    try {
      if (!await identity.session(cookieSession(req))) { res.status(401).json({ error: '请先使用 TokenToSea 登录' }); return; }
      const document = await description(req);
      if (document.canvas && (typeof req.body?.html !== 'string' || !req.body.html.trim() || Buffer.byteLength(req.body.html) > 20 * 1024 * 1024)) throw new Error('分享画布内容无效或过大');
      const plan = document.canvas ? { files: [{ file: 'index.html', data: Buffer.from(req.body.html) }], indexConflict: null } : await buildDeployFilePlan(path.dirname(document.directory), path.basename(document.directory), document.fileName, { metadata: document.metadata, hookScriptUrl: '', assetUrlPolicy: 'share-relative' });
      if (plan.indexConflict) { res.status(409).json({ error: '入口文件与 index.html 冲突，请重命名后分享' }); return; }
      if (plan.files.reduce((sum, f) => sum + Buffer.byteLength(f.data), 0) > 20 * 1024 * 1024) { res.status(413).json({ error: '每次分享最多 20 MB' }); return; }
      const files = plan.files.map(file => { const bytes = Buffer.from(file.data); return { path: file.file, contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }; });
      await proxy(req, res, 'shares', 'POST', { documentKey: document.documentKey, title: document.title, files, requestKey: safeId(req.body?.requestKey) || randomUUID(), ...(typeof req.body?.revision === 'number' ? { expectedRevision: req.body.revision } : {}) });
    } catch (error) { fail(res, error); }
  });
  app.post('/api/tokentosea/shares/:id/state', async (req, res) => { try { const id = safeId(req.params.id); if (!id) throw new Error('无效分享'); await proxy(req, res, `shares/${id}/state`, 'POST', { status: req.body?.status, revision: req.body?.revision }); } catch (error) { fail(res, error); } });
  app.get('/api/tokentosea/shares/:id/comments', async (req, res) => { try { const id = safeId(req.params.id); if (!id) throw new Error('无效分享'); await proxy(req, res, `shares/${id}/comments`, 'GET'); } catch (error) { fail(res, error); } });
  app.post('/api/tokentosea/shares/:id/comments', async (req, res) => { try { const id = safeId(req.params.id); if (!id) throw new Error('无效分享'); await proxy(req, res, `shares/${id}/comments`, 'POST', { text: req.body?.text, target: req.body?.target, version: req.body?.version, requestKey: safeId(req.body?.requestKey) || randomUUID() }); } catch (error) { fail(res, error); } });
  app.patch('/api/tokentosea/shares/comments/:id', async (req, res) => { try { const id = safeId(req.params.id); if (!id) throw new Error('无效评论'); await proxy(req, res, `comments/${id}`, 'PATCH', { status: req.body?.status }); } catch (error) { fail(res, error); } });
}
