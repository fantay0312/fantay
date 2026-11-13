import { mkdir, lstat, writeFile, rename, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tokenToSeaMediaAssets, type TokenToSeaMovieImportRequest } from '@open-design/contracts';
import type { TokenToSeaIdentity } from '@fantay/tokentosea';
import { MovieError, readMovie, saveMovie } from './store.js';
import { probeMovieVideo } from './video-sources.js';

export async function importTokenToSeaVideo(dir: string, identity: Pick<TokenToSeaIdentity, 'service'>, session: string,
  request: TokenToSeaMovieImportRequest, download: typeof fetch = fetch) {
  if (!/^[\w-]{1,100}$/.test(request.runId) || !/^asset_[a-f0-9]{64}$/.test(request.assetId)) throw new MovieError('Invalid generated video');
  const current = await readMovie(dir);
  if (!current) throw new MovieError('Create a movie first', 404);
  if (current.revision !== request.expectedRevision) throw new MovieError('The movie changed. Reload and import again.', 409);
  if (current.renders.some(r => r.status === 'running') || ['preparing', 'rendering'].includes(current.production?.status ?? '')) throw new MovieError('Wait for rendering to finish before importing', 409);
  const runResponse = await identity.service(session, `official/runs/${request.runId}`, 'GET');
  if (!runResponse.ok) throw new MovieError('This generation is unavailable to the signed-in account');
  const run = await runResponse.json() as { status?: string; output?: unknown; model?: string };
  if (run.status !== 'succeeded' || !tokenToSeaMediaAssets(run.output).includes(request.assetId)) throw new MovieError('The generated media is not ready or does not belong to this run');
  const assetResponse = await identity.service(session, `official/runs/${request.runId}/assets/${request.assetId}`, 'GET');
  if (!assetResponse.ok) throw new MovieError('Could not retrieve the generated video');
  const { url: location } = await assetResponse.json() as { url?: string };
  const url = new URL(location ?? '');
  // TokenToSea archives generated media in COS. Never send the OAuth token to the storage host.
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.endsWith('.myqcloud.com')) throw new MovieError('Unexpected generated-media storage');
  const response = await download(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new MovieError('Could not download the generated video');
  const mime = response.headers.get('content-type')?.split(';')[0] ?? '';
  const ext = ({ 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/mpeg':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/mp4':'m4a','audio/aac':'aac' } as Record<string, string>)[mime];
  if (!ext) { await response.body.cancel(); throw new MovieError('The generated asset is not a supported video'); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > 256 * 1024 * 1024) throw new MovieError('Generated video exceeds 256 MB');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const folder = path.join(dir, 'video-sources');
  await mkdir(folder, { recursive: true });
  if ((await lstat(folder)).isSymbolicLink()) throw new MovieError('Video folder must not be a symbolic link');
  const assetId = `tts-${request.assetId}`;
  const relative = `video-sources/${assetId}.${ext}`;
  const temp = path.join(folder, `${randomUUID()}.${ext}`);
  try {
    await writeFile(temp, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
    if(mime.startsWith('video/'))await probeMovieVideo(temp);
    else {
      const header=(await readFile(temp)).subarray(0,32);
      const valid=ext==='png'?header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):ext==='jpg'?header[0]===255&&header[1]===216:ext==='webp'?header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WEBP':ext==='wav'?header.toString('ascii',0,4)==='RIFF'&&header.toString('ascii',8,12)==='WAVE':ext==='m4a'?header.toString('ascii',4,8)==='ftyp':header.toString('ascii',0,3)==='ID3'||header[0]===255&&((header[1]??0)&224)===224;
      if(!valid)throw new MovieError('Generated media bytes do not match their format');
    }
    await rename(temp, path.join(dir, relative));
    const document = await saveMovie(dir, { expectedRevision: request.expectedRevision, document: {
      ...current, style: { ...current.style, assets: [
        ...(current.style.assets ?? []).filter(a => a.id !== assetId),
        { id: assetId, path: relative, label: `TokenToSea · ${run.model ?? 'Video'}` },
      ] },
    } });
    return { document, assetId };
  } finally { await rm(temp, { force: true }); }
}
