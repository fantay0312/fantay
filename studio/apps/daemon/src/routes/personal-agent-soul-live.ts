import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { PaSoulLiveResponse } from "@open-design/contracts";
import type { PersonalAgentService } from "../services/personal-agent-service.js";

/** GET /api/pa/soul/live: the visible text so far of the running chat attempt of a conversation. Polled while a turn
 *  runs, so it never answers 404: an unknown conversation or no running attempt is `{ live: null }`. Registered from
 *  registerPersonalAgentRoutes, after the loopback and origin gate and the enterprise allowlist. */
export function registerPersonalAgentSoulLiveRoutes(app: Express, deps: {
  service: PersonalAgentService;
  handle: (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => (req: Request, res: Response) => Promise<void>;
}): void {
  const { service, handle } = deps;
  const query = z.object({
    conversationId: z.string().min(1).max(100),
    attempt: z.string().max(100).optional(),
    seq: z.string().regex(/^(?:0|[1-9]\d{0,15})$/).transform(Number).refine(Number.isSafeInteger).optional(),
  });

  app.get("/api/pa/soul/live", handle((req): PaSoulLiveResponse => {
    const input = query.parse(req.query);
    const known = input.attempt !== undefined && input.seq !== undefined ? { attemptId: input.attempt, seq: input.seq } : undefined;
    return { live: service.soulLive.read(input.conversationId, known) };
  }));
}
