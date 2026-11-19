import type { Express, Request, Response } from 'express';
import type { AmrModelsResponse, AmrWalletSnapshot } from '@open-design/contracts';
import { isTokenToSeaAgentModel, tokenToSeaCookie, tokenToSeaReasoningOptions, type TokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';
import { isLoopbackPeerAddress } from '../http/local-daemon-request.js';
import { runTokenToSeaCommand } from '../integrations/tokentosea-command.js';

/** Old response field names are preserved only for persisted client compatibility. */
export function registerTokenToSeaCloudRoutes(app: Express, runtime: TokenToSeaRuntime) {
  const fail = (res: Response, error: unknown) => res.status(
    typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : 502,
  ).json({ error: error instanceof Error ? error.message : 'TokenToSea 暂时不可用' });
  const status = async (req: Request, res: Response) => {
    const raw = tokenToSeaCookie(req), user = raw ? await runtime.identity.session(raw) : null;
    res.json({ loggedIn: Boolean(user), sessionState: user ? 'authenticated' : 'signed_out',
      loginInFlight: raw ? runtime.identity.pending(raw) : false, profile: 'tokentosea',
      user: user ? { ...user, email: user.email ?? '', image: user.picture } : null,
      configPath: '', consoleOrigin: 'https://tokentosea.com', provider: 'tokentosea',
    });
  };
  app.use('/api/tokentosea/cli', (req, res, next) => {
    if (!isLoopbackPeerAddress(req.socket.remoteAddress) || req.headers.origin || req.headers.cookie || req.headers['x-fantay-cli'] !== '1') { res.status(403).json({ error: 'Local CLI access required' }); return; }
    next();
  });
  app.get('/api/tokentosea/cli/status', async (_req, res) => { res.json(await runtime.cliStatus()); });
  app.post('/api/tokentosea/cli/login', async (_req, res) => { try { res.json({ authorizeUrl: await runtime.beginCliLogin() }); } catch (error) { fail(res, error); } });
  app.post('/api/tokentosea/cli/logout', async (_req, res) => { try { await runtime.cliLogout(); res.json({ ok: true }); } catch (error) { fail(res, error); } });
  app.post('/api/tokentosea/cli/command', async (req, res) => {
    try {
      const args = req.body?.args;
      if (!Array.isArray(args) || args.length > 500 || args.some(arg => typeof arg !== 'string' || arg.length > 65536)) { res.status(400).json({ error: 'Invalid command' }); return; }
      const workspace = typeof req.body.workspaceId === 'string' ? req.body.workspaceId : '';
      if (!workspace) { res.status(400).json({ error: 'An explicit --workspace-id is required' }); return; }
      const cancel = new AbortController();
      res.once('close', () => { if (!res.writableEnded) cancel.abort(); });
      const stdout = await runtime.backgroundInWorkspace(workspace, () => runTokenToSeaCommand(args, {
        configuredEnv: { TOKENTOSEA_WORKSPACE_ID: workspace }, signal: cancel.signal,
        ...(typeof req.body.input === 'string' ? { input: req.body.input } : {}),
      }));
      res.json({ stdout });
    } catch (error) { fail(res, error); }
  });
  app.get('/api/tokentosea/cloud/status', (req, res) => { void status(req, res).catch(error => fail(res, error)); });
  app.get(['/api/tokentosea/cloud/models', '/api/amr/models'], async (_req, res) => {
    try {
      const models = (await runtime.chatModels()).filter(isTokenToSeaAgentModel)
        .map(model => ({ id: model.id, label: model.name ?? model.model, ...(model.channelOffer && { channelOffer: model.channelOffer }), enabled: model.available !== false, reasoningOptions: tokenToSeaReasoningOptions(model) }));
      res.json({ source: 'remote', refreshing: false, models } satisfies AmrModelsResponse);
    } catch (error) { fail(res, error); }
  });
  app.get('/api/tokentosea/cloud/wallet', async (req, res) => {
    const raw = tokenToSeaCookie(req), user = raw ? await runtime.identity.session(raw) : null;
    const base = { profile: 'tokentosea', user, updatedAt: null, fetchedAt: new Date().toISOString(), stale: false };
    if (!user) { res.json({ ...base, status: 'signed_out', balanceUsd: null, source: 'unavailable' } satisfies AmrWalletSnapshot); return; }
    try {
      const wallet = await runtime.json<{ availableUsd: string }>('wallet');
      res.json({ ...base, status: 'available', balanceUsd: wallet.availableUsd, source: 'tokentosea_api' } satisfies AmrWalletSnapshot);
    } catch (error) { fail(res, error); }
  });
  app.post('/api/tokentosea/cloud/login/cancel', async (req, res) => {
    try { const raw = tokenToSeaCookie(req); if (raw && runtime.identity.pending(raw)) await runtime.identity.logout(raw); res.json({ ok: true, canceled: true }); }
    catch (error) { fail(res, error); }
  });
  // The fork has no upstream marketing inbox. Product release notes remain local.
  for (const audience of ['message-center', 'message-center-public']) {
    app.get(`/api/tokentosea/cloud/${audience}/messages`, (_req, res) => { res.json({ messages: [], nextCursor: null, unreadCount: 0 }); });
    app.post(`/api/tokentosea/cloud/${audience}/messages/:id/read`, (_req, res) => { res.json({ ok: true }); });
    app.post(`/api/tokentosea/cloud/${audience}/read-all`, (_req, res) => { res.json({ ok: true }); });
  }
  app.get('/api/tools/tokentosea/account', (_req, res) => {
    const user = runtime.current()?.user;
    res.json({ loggedIn: Boolean(user), user: user ? { name: user.name } : null, provider: 'tokentosea' });
  });
  return { close: () => runtime.close() };
}
