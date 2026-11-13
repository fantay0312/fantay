import type { Express, RequestHandler } from 'express';
import { CliUpdateError, type CliUpdateService } from '../services/cli-updates.js';

export interface RegisterCliUpdateRoutesDeps {
  cliUpdates: CliUpdateService;
  requireLocalDaemonRequest: RequestHandler;
}

export function registerCliUpdateRoutes(app: Express, { cliUpdates, requireLocalDaemonRequest }: RegisterCliUpdateRoutesDeps): void {
  app.get('/api/agents/updates', requireLocalDaemonRequest, (_req, res) => res.json(cliUpdates.snapshot()));
  app.post('/api/agents/updates/check', requireLocalDaemonRequest, (req, res) => {
    res.status(202).json(cliUpdates.check(req.body?.force === true));
  });
  app.post('/api/agents/updates', requireLocalDaemonRequest, (req, res) => {
    const ids = req.body?.agentIds;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'agentIds must be an array of installed CLI IDs.' } }); return;
    }
    try { res.status(202).json(cliUpdates.update(ids)); }
    catch (error) {
      const known = error instanceof CliUpdateError;
      res.status(known && error.code === 'BAD_REQUEST' ? 400 : 409).json({ error: {
        code: known ? error.code : 'NOT_AVAILABLE', message: known ? error.message : 'CLI update could not start.',
      } });
    }
  });
}
