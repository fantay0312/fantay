import type { Express, Request, Response } from 'express';
import { paChannelInputSchema } from '@open-design/contracts';
import type { PersonalAgentChannels } from '../services/personal-agent-channels.js';
import { PaError } from '../storage/personal-agent-store.js';
import { PaChannelTransportError } from '../integrations/pa-channel-transport.js';

/** Registered after the /api/pa local-origin gate. */
export function registerPersonalAgentChannelRoutes(app: Express, channels: PersonalAgentChannels): void {
  const handle = (fn: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    try { res.setHeader('Cache-Control', 'no-store'); res.json(await fn(req)); }
    catch (error) { const validation = error instanceof Error && error.name === 'ZodError'; res.status(error instanceof PaError ? error.status : validation ? 400 : 503).json({ error: { code: error instanceof PaError ? error.code : 'PA_CHANNEL_ERROR', message: error instanceof PaError || error instanceof PaChannelTransportError ? error.message : validation ? '连接配置格式不正确' : '渠道暂不可用，请检查网络与配置' } }); }
  };
  const revision = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new PaError('需要有效的配置版本'); return value; };
  app.get('/api/pa/channels', handle(() => channels.snapshot()));
  app.get('/api/pa/channels/local-feishu-apps', handle(() => channels.localFeishuApps()));
  app.post('/api/pa/channels', handle(req => channels.create(paChannelInputSchema.parse(req.body))));
  app.patch('/api/pa/channels/:id', handle(req => channels.update(String(req.params.id), paChannelInputSchema.parse(req.body), revision(req.body?.revision))));
  app.post('/api/pa/channels/:id/feishu', handle(req => channels.configureFeishu(String(req.params.id), req.body ?? {})));
  app.post('/api/pa/channels/:id/connect', handle(async req => { await channels.reconnect(String(req.params.id)); return channels.snapshot(); }));
  app.post('/api/pa/channels/:id/disconnect', handle(req => channels.disconnect(String(req.params.id), req.body?.forget === true)));
  app.post('/api/pa/channels/:id/pair', handle(req => channels.pairing(String(req.params.id))));
  app.post('/api/pa/channels/:id/login', handle(req => channels.beginWeixinLogin(String(req.params.id))));
  app.get('/api/pa/channels/:id/login', handle(req => channels.loginStatus(String(req.params.id))));
  app.post('/api/pa/channels/:id/login/pin', handle(req => channels.verifyLogin(String(req.params.id), typeof req.body?.pin === 'string' ? req.body.pin : '')));
  app.get('/api/pa/channels/:id/qr.png', async (req, res) => {
    try { const image = await channels.loginQr(String(req.params.id)); res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' }); res.send(image); }
    catch { res.status(410).end(); }
  });
  app.post('/api/pa/channels/inbox/:id/approve', handle(req => {
    if (typeof req.body?.approved !== 'boolean') throw new PaError('需要明确的批准或拒绝决定');
    channels.approveProject(String(req.params.id), req.body.approved, revision(req.body.revision)); return { ok: true };
  }));
  app.post('/api/pa/channels/outbox/:id/resolve', handle(req => {
    if (!['query', 'delivered', 'retry'].includes(req.body?.action)) throw new PaError('请选择查询、已核实送达或已核实未送达后重试');
    return channels.reconcileOutbox(String(req.params.id), req.body.action, revision(req.body.revision));
  }));
}
