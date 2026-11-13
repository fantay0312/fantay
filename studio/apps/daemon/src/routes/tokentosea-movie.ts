import type { Express, Request, Response } from 'express';
import type { TokenToSeaIdentity } from '@fantay/tokentosea';
import { importTokenToSeaVideo } from '../movie/tokentosea-assets.js';
import { MovieError } from '../movie/store.js';
import { importNativeSource } from '../movie/native-editor.js';
import { tokenToSeaCookie } from '../integrations/tokentosea-runtime.js';

export interface TokenToSeaMovieProjects {
  authorize(req: Request, res: Response, projectId: string): Promise<string | null>;
}
export function registerTokenToSeaMovieRoutes(app: Express, identity: TokenToSeaIdentity, projects: TokenToSeaMovieProjects) {
  app.post('/api/tokentosea/movie/import', async (req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin && origin !== 'od://app') {
        const url = new URL(origin);
        if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)
          || ![String(process.env.OD_WEB_PORT ?? '5173'), String(process.env.OD_PORT ?? '7456')].includes(url.port)) throw new MovieError('Invalid request origin', 403);
      } else if (!origin && req.headers.cookie) throw new MovieError('A browser origin is required', 403);
      const projectId = req.body?.projectId;
      if (typeof projectId !== 'string' || !/^[\w-]{1,100}$/.test(projectId)) throw new MovieError('Invalid project');
      const dir = await projects.authorize(req, res, projectId);
      if (!dir) return;
      const session = tokenToSeaCookie(req);
      if (!await identity.session(session)) throw new MovieError('Please sign in to TokenToSea', 401);
      const result=await importTokenToSeaVideo(dir, identity, session, req.body);
      let nativeImported=false;
      try{nativeImported=await importNativeSource(dir,projectId,result.assetId);}catch{}
      res.json({...result,nativeImported});
    } catch (error) {
      if (!res.headersSent) res.status(error instanceof MovieError ? error.status : 400).json({ error: error instanceof Error ? error.message : 'Could not import the generated video' });
    }
  });
}
