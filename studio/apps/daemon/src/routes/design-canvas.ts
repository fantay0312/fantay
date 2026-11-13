import type { Express } from 'express';
import type { DesignMigrationListResponse } from '@open-design/contracts';
import { CanvasStore } from '../services/design-canvas.js';
import { readDesignMigrations } from '../fantay/designs/ledger.js';
import { sendApiError } from '../http/api-errors.js';

export function registerDesignCanvasRoutes(app: Express, dataDir: string): void {
  const store = new CanvasStore(dataDir);
  // Fantay (spec 06 §7.2): ledger of legacy documents imported into projects (the documents themselves stay here).
  app.get('/api/design-canvas/migrations', async (_req, res) => {
    try { const body: DesignMigrationListResponse = { migrations: await readDesignMigrations(dataDir) }; res.set('Cache-Control', 'no-store').json(body); }
    catch { sendApiError(res, 500, 'INTERNAL_ERROR', 'design migrations could not be read'); }
  });
  app.get('/api/design-canvas/documents', async (_req, res) => {
    try { res.json({ documents: await store.list() }); }
    catch { res.status(500).json({ error: '无法读取画布文件' }); }
  });
  app.get('/api/design-canvas/documents/:id', async (req, res) => {
    try { const doc = await store.read(String(req.params.id)); if (!doc) { res.status(404).json({ error: '画布文件不存在' }); return; } res.json(doc); }
    catch { res.status(400).json({ error: '无法读取画布文件' }); }
  });
  app.put('/api/design-canvas/documents/:id', async (req, res) => {
    try { res.json(await store.save(String(req.params.id), req.body)); }
    catch (e) { const conflict = e instanceof Error && e.message === 'CONFLICT'; res.status(conflict ? 409 : 400).json({ error: conflict ? '此画布已在另一窗口更新，请重新打开或另存副本' : '无法保存，请检查文件大小和名称' }); }
  });
}
