// SPDX-License-Identifier: AGPL-3.0-only
// Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
// Fantay 工作台 HTTP surface: `/api/workbench/*` (contract: packages/contracts/src/api/workbench.ts).
//
// Every request runs inside the `/api` TokenToSea middleware (text, image and social-data calls use
// the signed-in account) and inside the `x-workbench-lang` language scope. Writes reject cross-site
// requests the same way the TokenToSea routes do. Errors use the reference envelope `{ error: string }`.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Express, Request, Response } from 'express';
import type { WorkbenchSearchMode } from '@open-design/contracts';
import { isTokenToSeaWriteOrigin } from '../http/tokentosea-origin.js';
import { FILE_MIME, MAX_UPLOAD_BYTES, UPLOAD_TYPES, WorkbenchDesk } from '../workbench/desk.js';
import { httpError, tr, withLang } from '../workbench/i18n.js';

export interface RegisterWorkbenchRoutesDeps {
  /** RUNTIME_DATA_DIR; the workbench keeps its state under `<dataDir>/workbench`. */
  dataDir: string;
  /** Bundled read-only sample media (packaged as the `workbench-assets` resource tree). */
  assetsDir: string;
  /** Fantay user skills root (USER_SKILLS_DIR) for 写作规则 → Skill export. */
  userSkillsDir: string;
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function handle(fn: Handler) {
  return async (req: Request, res: Response) => {
    try {
      const body = await fn(req, res);
      if (body !== undefined && !res.headersSent) sendJson(res, 200, body);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      sendJson(res, statusOf(error), { error: error instanceof Error && error.message ? error.message : String(error) });
    }
  };
}

function jsonBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

function queryString(req: Request, key: string): string {
  const value = req.query[key];
  return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : '';
}

async function readRaw(req: Request, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw httpError(tr('内容太大'), 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** 支持 Range，视频和音频才能正常拖动和循环。 */
async function sendFile(req: Request, res: Response, file: string): Promise<void> {
  const type = FILE_MIME[path.extname(file).toLowerCase()];
  if (!type) { sendJson(res, 404, { error: tr('不支持的文件类型') }); return; }
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    sendJson(res, 404, { error: tr('文件不存在') });
    return;
  }
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') { res.end(); return; }
    await pipeline(createReadStream(file, { start, end }), res).catch(() => undefined);
    return;
  }
  res.status(200);
  res.setHeader('Content-Length', String(size));
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(createReadStream(file), res).catch(() => undefined);
}

export function registerWorkbenchRoutes(app: Express, deps: RegisterWorkbenchRoutesDeps): WorkbenchDesk {
  const desk = new WorkbenchDesk({ root: path.join(deps.dataDir, 'workbench'), assetsDir: deps.assetsDir, userSkillsDir: deps.userSkillsDir });

  // Language scope for receipts, prompts and samples, then the write-origin guard.
  app.use('/api/workbench', (req, res, next) => {
    withLang(req.headers['x-workbench-lang'], () => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        // 所有写操作都拒绝跨站请求
        const site = req.headers['sec-fetch-site'];
        if ((site && site !== 'same-origin' && site !== 'none') || !isTokenToSeaWriteOrigin(req)) {
          sendJson(res, 403, { error: tr('拒绝跨站请求') });
          return;
        }
      }
      next();
    });
  });

  // ── reads ──
  app.get('/api/workbench/state', handle(() => desk.state()));
  app.get('/api/workbench/production', handle(req => desk.production(queryString(req, 'id'))));
  app.get('/api/workbench/settings', handle(() => desk.publicSettings()));
  app.get('/api/workbench/models', handle(async () => {
    try { return await desk.models(); } catch (error) { throw httpError(error instanceof Error ? error.message : String(error), statusOf(error) === 500 ? 502 : statusOf(error)); }
  }));
  app.get('/api/workbench/insights', handle(() => desk.insights()));
  app.get('/api/workbench/social/status', handle(() => desk.socialStatus()));
  app.get('/api/workbench/library/search', handle(req => desk.search(queryString(req, 'q'), (queryString(req, 'mode') === 'meaning' ? 'meaning' : 'text') as WorkbenchSearchMode)));
  app.get('/api/workbench/files/:name', handle(async (req, res) => {
    await desk.store.read();
    await sendFile(req, res, desk.filePath('files', String(req.params.name)));
  }));
  app.get('/api/workbench/assets/:name', handle(async (req, res) => {
    await sendFile(req, res, desk.filePath('assets', String(req.params.name)));
  }));

  // ── writes ──
  const post = (route: string, fn: (body: Record<string, unknown>, req: Request) => Promise<unknown>) =>
    app.post(`/api/workbench/${route}`, handle(req => fn(jsonBody(req), req)));

  post('ops', body => desk.ops(body));
  post('undo', () => desk.undo());
  post('chat', body => desk.chat(body));
  post('chat/clear', () => desk.clearChat());
  post('produce', body => desk.produce(body));
  post('produce/cancel', body => desk.cancelProduce(body));
  post('produce/regen', body => desk.regen(body));
  post('produce/save', body => desk.save(body));
  post('produce/reveal', body => desk.reveal(body));
  post('style/extract', body => desk.extractStyle(body));
  post('social/import', body => desk.importAccount(body));
  post('account/refresh', body => desk.refreshAccount(body));
  post('settings', body => desk.updateSettings(body));
  post('settings/test', () => desk.testImage());
  post('capture-url', body => desk.captureUrl(body));
  post('library/organize', body => desk.organize(body));
  post('library/reader', body => desk.reader(body));
  post('skills/learn', () => desk.learnSkills());
  post('skills/export', () => desk.exportSkills());
  app.post('/api/workbench/upload', handle(async (req) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw httpError(tr('内容太大'), 413);
    // Reject unsupported types before buffering the body.
    if (!UPLOAD_TYPES[type]) throw httpError(tr('不支持这种文件：{type}', { type: type || tr('未知') }), 415);
    return desk.saveUpload(type, await readRaw(req, MAX_UPLOAD_BYTES));
  }));

  app.use('/api/workbench', (req, res) => {
    sendJson(res, ['GET', 'HEAD', 'POST'].includes(req.method) ? 404 : 405, { error: tr(['GET', 'HEAD', 'POST'].includes(req.method) ? '接口不存在' : '不支持的方法') });
  });

  return desk;
}
