import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasStore } from '../../src/services/design-canvas.js';

describe('canvas document persistence', () => {
  it('round-trips bytes, preserves prior revisions and rejects concurrent overwrites', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fantay-canvas-'));
    try {
      const store = new CanvasStore(dir);
      const input = { name: '设计稿', format: 'fig' as const, data: Buffer.from('first file').toString('base64'), expected: null };
      const first = await store.save('design-1', input);
      expect(await new CanvasStore(dir).read('design-1')).toEqual(first);
      const outcomes = await Promise.allSettled([store.save('design-1', { ...input, data: Buffer.from('second file').toString('base64'), expected: first.sha256 }), store.save('design-1', { ...input, data: Buffer.from('stale file').toString('base64'), expected: first.sha256 })]);
      expect(outcomes.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
      expect((outcomes[1] as PromiseRejectedResult).reason.message).toBe('CONFLICT');
      expect(await readdir(path.join(dir, 'design-canvas/history/design-1'))).toEqual([`${first.sha256}.json`]);
      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty('data');
      await expect(store.read('../escape')).rejects.toThrow('Invalid document ID');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
