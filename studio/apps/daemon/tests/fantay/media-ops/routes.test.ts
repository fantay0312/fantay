import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { registerMediaOpRoutes } from '../../../src/fantay/media-ops/routes.js';
import type { RegisterMediaOpRoutesDeps } from '../../../src/fantay/media-ops/routes.js';

let server: Server | undefined;
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); });
it('checks project write authority before resolving or processing a file', async () => {
  const app = express(); app.use(express.json());
  const resolve = vi.fn();
  const authorize = vi.fn<RegisterMediaOpRoutesDeps['authorizeProjectRequest']>(async (_req, res, _id, options) => {
    expect(options).toEqual({ mode:'write',capability:'writeFiles' });
    res.status(403).json({error:{code:'FORBIDDEN'}}); return false;
  });
  const deps = {
    db:{}, paths:{PROJECTS_DIR:'/unused'}, projectStore:{getProject:()=>({id:'p',metadata:{}})},
    projectFiles:{resolveProjectFilePath:resolve}, authorizeProjectRequest:authorize,
    http:{sendApiError:(res: express.Response,status: number,code: string,message: string)=>res.status(status).json({error:{code,message}})},
  } as unknown as RegisterMediaOpRoutesDeps;
  registerMediaOpRoutes(app,deps);
  server=createServer(app); await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const response=await fetch('http://127.0.0.1:'+ (server.address() as {port:number}).port+'/api/projects/p/media/ops',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({op:'scale',input:'input.png',params:{factor:2}}),
  });
  expect(response.status).toBe(403); expect(authorize).toHaveBeenCalledOnce(); expect(resolve).not.toHaveBeenCalled();
});
