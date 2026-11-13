import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { JianyingEnvironment, JianyingInspection, JianyingValidation } from '@open-design/contracts';
import { jianyingFfprobe } from './ffprobe.js';

const exec = promisify(execFile);
export class JianyingError extends Error {
  constructor(message: string, public code = 'JIANYING_ERROR', public status = 400) { super(message); }
}
export interface EngineResponse { inspection: JianyingInspection; validation: JianyingValidation; result?: { draftPath?: string; registryBackup?: string } }
export interface EngineOptions { resourceDir: string; dataDir: string }
const building = new Map<string, Promise<string>>();
const fileShaCache = new Map<string, Promise<string>>();
const sha = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex');
async function fileSha(file: string) {
  const info = await stat(file);
  const sig = `${file}\0${info.size}:${info.mtimeMs}:${info.ino}`;
  const hit = fileShaCache.get(sig);
  if (hit) return hit;
  const work = (async () => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  })();
  if (fileShaCache.size >= 64) {
    const oldest = fileShaCache.keys().next().value;
    if (oldest !== undefined) fileShaCache.delete(oldest);
  }
  fileShaCache.set(sig, work);
  work.catch(() => { if (fileShaCache.get(sig) === work) fileShaCache.delete(sig); });
  return work;
}
async function nativeIdentity(options: EngineOptions, environment: JianyingEnvironment) {
  if (!environment.native.available || !environment.application.path) throw new JianyingError(environment.native.reason ?? 'Unsupported native runtime', 'UNSUPPORTED_NATIVE', 409);
  const frameworks = path.join(environment.application.path, 'Contents', 'Frameworks'), library = path.join(frameworks, 'libvideoeditor.dylib'), source = path.join(options.resourceDir, 'native', 'codec.cpp');
  const [librarySha256, sourceSha256] = await Promise.all([fileSha(library), fileSha(source)]);
  const dir = path.join(options.dataDir, 'codecs', `${librarySha256.slice(0, 20)}-${sourceSha256.slice(0, 16)}`), binary = path.join(dir, 'codec');
  return { frameworks, library, source, librarySha256, sourceSha256, dir, binary };
}
async function cachedCodec(identity: Awaited<ReturnType<typeof nativeIdentity>>): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(path.join(identity.dir, 'runtime.json'), 'utf8')) as { librarySha256: string; binarySha256: string; sourceSha256: string };
    return manifest.librarySha256 === identity.librarySha256 && manifest.sourceSha256 === identity.sourceSha256 && await fileSha(identity.binary) === manifest.binarySha256;
  } catch { return false; }
}
export async function nativeCodecPrepared(options: EngineOptions, environment: JianyingEnvironment): Promise<boolean> {
  if (!environment.native.available) return false;
  return cachedCodec(await nativeIdentity(options, environment));
}

/** All generated codec binaries live under the daemon's injected data root. */
export async function ensureNativeCodec(options: EngineOptions, environment: JianyingEnvironment): Promise<string> {
  const identity = await nativeIdentity(options, environment);
  const { frameworks, library, source, librarySha256, sourceSha256, dir, binary } = identity;
  const running = building.get(dir);
  if (running) return running;
  const job = (async () => {
    if (await cachedCodec(identity)) return binary;
    await mkdir(dir, { recursive: true });
    const output = path.join(dir, `codec-${randomUUID()}`);
    try {
      await exec('/usr/bin/xcrun', ['clang++', '-std=c++17', '-O2', source, '-L' + frameworks, '-lvideoeditor', '-Wl,-rpath,' + frameworks, '-o', output], { timeout: 60_000, maxBuffer: 1024 * 1024 });
      if (await fileSha(library) !== librarySha256) throw new JianyingError('Jianying changed while preparing its adapter; detect the version again', 'NATIVE_CHANGED', 409);
      const { rename } = await import('node:fs/promises');
      await rename(output, binary);
      await writeFile(path.join(dir, 'runtime.json'), JSON.stringify({ version: environment.application.version, build: environment.application.build, librarySha256, sourceSha256, binarySha256: sha(await readFile(binary)) }));
      return binary;
    } catch (error) {
      const { rm } = await import('node:fs/promises'); await rm(output, { force: true });
      if (error instanceof JianyingError) throw error;
      throw new JianyingError('Could not prepare the local Jianying adapter. Install Xcode Command Line Tools to read encrypted drafts; Jianying itself was not changed.', 'CODEC_BUILD_FAILED', 503);
    }
  })();
  building.set(dir, job);
  try { return await job; } finally { building.delete(dir); }
}

/** Media copying and native-library initialization never block the daemon event loop. */
export async function runJianyingEngine(options: EngineOptions, request: Record<string, unknown>): Promise<EngineResponse> {
  const worker = path.join(options.resourceDir, 'worker.ts');
  await stat(worker);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', worker], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FANTAY_JIANYING_FFPROBE: jianyingFfprobe() }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', done = false;
    const finish = (error?: Error, value?: EngineResponse) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => { child.kill(); finish(new JianyingError('Jianying draft operation timed out', 'JIANYING_TIMEOUT', 504)); }, 180_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) { child.kill(); finish(new JianyingError('Draft result exceeds the supported size', 'RESULT_TOO_LARGE')); } });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 16_384) stderr += chunk; });
    child.on('error', error => finish(error));
    child.on('close', () => {
      try {
        const result = JSON.parse(stdout) as EngineResponse & { ok: boolean; error?: { code?: string; message?: string } };
        if (!result.ok) finish(new JianyingError(result.error?.message ?? 'Draft operation failed', result.error?.code ?? 'JIANYING_FAILED', 409));
        else finish(undefined, result);
      } catch { finish(new JianyingError(`Draft worker failed: ${stderr.slice(0, 500)}`, 'WORKER_FAILED', 500)); }
    });
    child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') finish(error); });
    child.stdin.end(JSON.stringify(request));
  });
}
