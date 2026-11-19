import type { Express, RequestHandler } from 'express';
import { sideDialogueRequest } from '@open-design/contracts';
import type { AuthorizeProjectRequest } from '../collab/project-request-authority.js';
import { parseSideDialogueReply } from '../prompts/side-dialogue.js';
import { runSideDialogue } from '../runtimes/side-dialogue.js';
import { boundSideConversation, type SqliteDb } from '../db.js';
import { optionalTokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';

export function registerSideDialogue(app: Express, deps: {
  db: SqliteDb; dataDir: string; daemonOrigin(): string; authorizeProjectRequest: AuthorizeProjectRequest; requireLocalDaemonRequest: RequestHandler;
}) {
  const binding: RequestHandler = async (req, res) => {
    const { id, cid } = req.params;
    if (typeof id !== 'string' || typeof cid !== 'string') return res.status(400).json({ error: '无效的会话标识。' });
    const create = req.method === 'POST';
    if (!await deps.authorizeProjectRequest(req, res, id, create ? { mode: 'write', capability: 'writeFiles' } : { mode: 'read' })) return;
    const owner = JSON.stringify([optionalTokenToSeaRuntime()?.current()?.user?.id ?? 'local',
      req.get('x-od-workspace-id') ?? null, req.get('x-od-workspace-member-id') ?? null]);
    const conversation = boundSideConversation(deps.db, id, cid, owner, create);
    if (!conversation && create) return res.status(404).json({ error: '主会话不可用。' });
    return res.json({ conversation });
  };
  const path = '/api/projects/:id/conversations/:cid/side-dialogue';
  app.get(path, deps.requireLocalDaemonRequest, binding);
  app.post(path, deps.requireLocalDaemonRequest, binding);
  app.post('/api/side-dialogue', deps.requireLocalDaemonRequest, async (req, res) => {
    const parsed = sideDialogueRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '对话请求无效或过长。' });
    const input = parsed.data;
    if ((input.main || input.mode !== 'chat') && !input.projectId) return res.status(400).json({ error: '尚未绑定主会话。' });
    if (input.projectId && !await deps.authorizeProjectRequest(req, res, input.projectId, { mode: 'read' })) return;
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
      const text = await runSideDialogue(input, deps.dataDir, deps.daemonOrigin(), signal);
      if (!controller.signal.aborted) res.json(parseSideDialogueReply(input.mode, text));
    } catch (error) {
      if (!controller.signal.aborted) res.status(502).json({ error: error instanceof Error ? error.message : '模型暂时不可用。' });
    } finally { res.off('close', disconnect); }
  });
}
