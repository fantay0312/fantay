import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { OpenDesignHostMovieExport, OpenDesignHostMovieDestination } from '@open-design/host';

type Destination = { path: string; format: 'mp4' | 'mov'; saved: boolean; writing: boolean; expires: number };
export interface MovieExportDeps {
  choose(input: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }>; properties: ['dontAddToRecent'] }): Promise<{ canceled: boolean; filePath?: string }>;
  discoverDaemonBaseUrl(): Promise<string>;
  openPath(file: string): Promise<string>;
  reveal(file: string): void;
  fetch?: typeof fetch;
}
const failure = (error: unknown): OpenDesignHostMovieDestination => ({ ok: false, reason: error instanceof Error ? error.message : String(error) });

/** Destination handles bind native user selection to a completed, authorized project render. */
export function createMovieExport(deps: MovieExportDeps): OpenDesignHostMovieExport {
  const destinations = new Map<string, Destination>();
  const request = deps.fetch ?? fetch;
  const find = (id: string) => {
    const destination = destinations.get(id);
    if (!destination || destination.expires < Date.now()) throw new Error('Export location expired. Choose the location again.');
    return destination;
  };
  return {
    async chooseDestination(input) {
      try {
        if (!input || !['mp4', 'mov'].includes(input.format) || typeof input.filename !== 'string') throw new Error('Invalid export filename');
        const name = input.filename.trim().replace(/[\x00-\x1f<>:"/\\|?*]/g, '-').slice(0, 160).replace(/\.(mp4|mov)$/i, '') || 'Untitled';
        const choice = await deps.choose({ title: '导出视频 / Export video', defaultPath: `${name}.${input.format}`, filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }], properties: ['dontAddToRecent'] });
        if (choice.canceled || !choice.filePath) return { ok: false, cancelled: true, reason: '' };
        if (path.extname(choice.filePath).toLowerCase() !== `.${input.format}`) throw new Error(`Choose a .${input.format} file`);
        for (const [id, entry] of destinations) if (entry.expires < Date.now()) destinations.delete(id);
        const id = randomUUID();
        destinations.set(id, { path: choice.filePath, format: input.format, saved: false, writing: false, expires: Date.now() + 24 * 60 * 60 * 1000 });
        return { ok: true, id, path: choice.filePath };
      } catch (error) { return failure(error); }
    },
    async save(input) {
      let temporary: string | undefined;
      let destination: Destination | undefined;
      try {
        if (!input || !/^[\w-]{1,100}$/.test(input.projectId) || !/^[\w-]{1,100}$/.test(input.renderId)) throw new Error('Invalid video export');
        destination = find(input.destinationId);
        if (destination.writing) throw new Error('This export is already being saved');
        if (destination.saved) return { ok: true, id: input.destinationId, path: destination.path };
        destination.writing = true;
        const base = await deps.discoverDaemonBaseUrl();
        const query = new URLSearchParams();
        if (input.workspaceContext) {
          query.set('workspaceId', input.workspaceContext.workspaceId);
          query.set('workspaceMemberId', input.workspaceContext.workspaceMemberId);
        }
        const project = `/api/projects/${encodeURIComponent(input.projectId)}`;
        const suffix = query.size ? `?${query}` : '';
        let render: { id: string; status: string; file?: string; error?: string } | undefined;
        const deadline = Date.now() + 30 * 60_000;
        do {
          const response = await request(new URL(`${project}/movie${suffix}`, base), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`Cannot read the video project (${response.status})`);
          const body = await response.json() as { document?: { renders?: Array<{ id: string; status: string; file?: string; error?: string }> } };
          render = body.document?.renders?.find(item => item.id === input.renderId);
          if (!render) throw new Error('Export version was not found');
          if (render.status === 'failed') throw new Error(render.error || 'Video rendering failed');
          if (render.status === 'done') break;
          if (Date.now() >= deadline) throw new Error('Export timed out. The project copy is preserved; try exporting again.');
          await new Promise(resolve => setTimeout(resolve, 1000));
        } while (true);
        if (!render?.file || !/^movie-[\w-]+\.(mp4|mov)$/.test(render.file) || path.extname(render.file) !== `.${destination.format}`) throw new Error('The completed video does not match the selected export format');
        const media = await request(new URL(`${project}/raw/${encodeURIComponent(render.file)}${suffix}`, base), { redirect: 'error', signal: AbortSignal.timeout(10 * 60_000) });
        if (!media.ok || !media.body) throw new Error(`Cannot read the exported video (${media.status})`);
        temporary = path.join(path.dirname(destination.path), `.${path.basename(destination.path)}.${randomUUID()}.tmp`);
        await pipeline(Readable.fromWeb(media.body as never), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if ((await stat(temporary)).size === 0) throw new Error('The exported video is empty');
        await rename(temporary, destination.path);
        temporary = undefined;
        destination.saved = true;
        return { ok: true, id: input.destinationId, path: destination.path };
      } catch (error) { return failure(error); }
      finally {
        if (destination) destination.writing = false;
        if (temporary) await rm(temporary, { force: true }).catch(() => {});
      }
    },
    async open(input) {
      try {
        const destination = find(input.destinationId);
        if (!destination.saved) throw new Error('Export has not finished');
        if (input.reveal) deps.reveal(destination.path);
        else { const error = await deps.openPath(destination.path); if (error) throw new Error(error); }
        return { ok: true };
      } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    },
  };
}
