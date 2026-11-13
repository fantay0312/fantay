import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CanvasDocument, CanvasDocumentSummary } from '@open-design/contracts';

export class CanvasStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataDir: string) {}
  private file(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid document ID');
    return path.join(this.dataDir, 'design-canvas', `${id}.json`);
  }
  async list(): Promise<CanvasDocumentSummary[]> {
    const root = path.dirname(this.file('_'));
    let files: string[];
    try { files = await readdir(root); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const docs = await Promise.all(files.filter(file => /^[\w-]+\.json$/.test(file)).map(file => this.read(file.slice(0, -5))));
    return docs.filter((doc): doc is CanvasDocument => doc !== null).map(({ data: _data, ...doc }) => doc).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async read(id: string): Promise<CanvasDocument | null> {
    try { return JSON.parse(await readFile(this.file(id), 'utf8')) as CanvasDocument; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  save(id: string, input: { name: string; format: 'fig' | 'op'; data: string; expected: string | null }): Promise<CanvasDocument> {
    const operation = this.queue.then(async () => {
      const file = this.file(id);
      const previous = await this.read(id);
      if ((previous?.sha256 ?? null) !== input.expected) throw new Error('CONFLICT');
      if (!input.name.trim() || input.name.length > 180 || !['fig', 'op'].includes(input.format)) throw new Error('Invalid document metadata');
      if (input.data.length > 40 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error('Invalid document data');
      const bytes = Buffer.from(input.data, 'base64');
      if (bytes.length === 0 || bytes.length > 30 * 1024 * 1024) throw new Error('Document must be between 1 byte and 30 MiB');
      const doc: CanvasDocument = { id, name: input.name.trim(), format: input.format, data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), updatedAt: new Date().toISOString() };
      await mkdir(path.dirname(file), { recursive: true });
      if (previous) {
        const history = path.join(path.dirname(file), 'history', id);
        await mkdir(history, { recursive: true });
        await writeFile(path.join(history, `${previous.sha256}.json`), JSON.stringify(previous), { flag: 'wx' }).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; });
      }
      await writeFile(`${file}.tmp`, JSON.stringify(doc));
      await rename(`${file}.tmp`, file);
      return doc;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
