import type { Express, Request, Response, RequestHandler } from 'express';
import type { TokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';
import {
  USAGE_ACTIVITY_DAYS, USAGE_MAX_RANGE_DAYS, isUsageDay, resolveUsageRange, usageDayLowerBound,
} from '../integrations/usage-store.js';

export interface RegisterUsageRoutesDeps {
  runtime: TokenToSeaRuntime;
  requireLocalDaemonRequest: RequestHandler;
  authorizeProject(req:Request,res:Response,id:string):Promise<boolean>;
  canReadProject(req:Request,id:string):Promise<boolean>;
  syncLocal(since:number,projectId?:string):void;
  projectName?(id:string):string|undefined;
}

const DAY_MS = 86_400_000;
const text = (value: unknown) => typeof value === 'string' ? value : undefined;

/**
 * GET /api/usage
 *   days=7|30|90            the last N calendar days ending today (default 30)
 *   from=YYYY-MM-DD&to=…     an inclusive local range instead of `days` (at most 366 days)
 *   timeZone=<IANA zone>     the zone days and hours are counted in
 *   projectId=<id>           one project (must be readable)
 *   provider=<id>            one provider / agent
 *   limit=0…1000             how many recent requests to list (default 100)
 *   activity=1               also return the 53-week daily activity series
 */
export function registerUsageRoutes(app:Express,deps:RegisterUsageRoutesDeps){
  app.get('/api/usage',deps.requireLocalDaemonRequest,async(req,res)=>{
    const projectId = text(req.query.projectId);
    const timeZone = text(req.query.timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { new Intl.DateTimeFormat('en-CA', { timeZone }).format(); } catch { res.status(400).json({ error: 'Invalid time zone' }); return; }
    if (req.query.projectId !== undefined && !projectId) { res.status(400).json({ error: 'Choose a valid project' }); return; }

    const from = text(req.query.from), to = text(req.query.to);
    const custom = req.query.from !== undefined || req.query.to !== undefined;
    const days = Number(req.query.days ?? 30);
    if (custom) {
      if (!isUsageDay(from) || !isUsageDay(to) || from > to) { res.status(400).json({ error: 'Use from and to as YYYY-MM-DD, from not after to' }); return; }
      if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > USAGE_MAX_RANGE_DAYS) { res.status(400).json({ error: `A range covers at most ${USAGE_MAX_RANGE_DAYS} days` }); return; }
    } else if (![7, 30, 90].includes(days)) { res.status(400).json({ error: 'Choose 7, 30 or 90 days, or a from/to range' }); return; }

    const provider = text(req.query.provider);
    if (req.query.provider !== undefined && (!provider || provider.length > 200)) { res.status(400).json({ error: 'Choose a valid provider' }); return; }
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) { res.status(400).json({ error: 'limit must be an integer from 0 to 1000' }); return; }
    const activity = req.query.activity === '1' || req.query.activity === 'true';

    if (projectId && !await deps.authorizeProject(req, res, projectId)) return;
    try {
      const range = resolveUsageRange(timeZone, custom ? { from, to } : { days });
      const since = Math.min(
        usageDayLowerBound(range.from),
        activity ? Date.now() - (USAGE_ACTIVITY_DAYS + 1) * DAY_MS : Infinity,
      );
      deps.syncLocal(since, projectId);
      const respond = async () => {
        const user = deps.runtime.current()?.user;
        if (user) void deps.runtime.reconcileUsage().catch(() => undefined);
        res.setHeader('Cache-Control', 'no-store');
        const allowed = new Set<string>();
        for (const id of deps.runtime.usage.projectIds(user?.id ?? null)) if (await deps.canReadProject(req, id)) allowed.add(id);
        const summary = deps.runtime.usage.summary(user?.id ?? null, range.days, projectId, allowed, timeZone, {
          from: range.from, to: range.to, ...(provider ? { provider } : {}), limit, activity,
        });
        const projectNames = new Map<string, string | undefined>();
        const resolveName = (id: string) => {
          if (projectNames.has(id)) return projectNames.get(id);
          const resolved = deps.projectName?.(id);
          projectNames.set(id, resolved);
          return resolved;
        };
        for (const row of [...summary.projects, ...summary.recent]) {
          const name = row.projectId ? resolveName(row.projectId) : undefined;
          if (name) row.projectName = name;
        }
        res.json(summary);
      };
      if (req.get('X-Fantay-CLI') === '1' && !deps.runtime.current()?.user) {
        try { await deps.runtime.backgroundInWorkspace('', respond); } catch { await respond(); }
      } else await respond();
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : 'Usage is unavailable' }); }
  });
}
