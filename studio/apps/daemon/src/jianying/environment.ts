import { execFile } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { JianyingEnvironment } from '@open-design/contracts';
import { jianyingFfprobe } from './ffprobe.js';

const exec = promisify(execFile);
const appInfoCache = new Map<string, { sig: string; value: { version: string; build: string; bundleId: string } | null }>();
const ffprobeCache = new Map<string, Promise<boolean>>();
export interface EnvironmentOptions { platform?: NodeJS.Platform; arch?: string; home?: string; env?: NodeJS.ProcessEnv; readApp?: (file: string) => Promise<{ version: string; build: string; bundleId: string } | null>; running?: () => Promise<boolean>; hasFfprobe?: () => Promise<boolean> }
async function exists(file: string): Promise<boolean> { try { await access(file); return true; } catch { return false; } }
async function probeFfprobeOnce(binary: string, platform: NodeJS.Platform): Promise<boolean> {
  const hit = ffprobeCache.get(`${platform}:${binary}`);
  if (hit) return hit;
  const work = (async () => {
    try { return Boolean((await exec(binary, ['-version'], { timeout: 5000 })).stdout); }
    catch { return platform === 'darwin' ? (await exists('/opt/homebrew/bin/ffprobe') || await exists('/usr/local/bin/ffprobe')) : false; }
  })();
  ffprobeCache.set(`${platform}:${binary}`, work);
  work.then(ok => { if (!ok && ffprobeCache.get(`${platform}:${binary}`) === work) ffprobeCache.delete(`${platform}:${binary}`); });
  return work;
}
export function draftRoot(platform: string, home: string, env: NodeJS.ProcessEnv): string {
  return env.FANTAY_JIANYING_DRAFTS_ROOT?.trim() || (platform === 'win32' ? path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft') : path.join(home, 'Movies', 'JianyingPro', 'User Data', 'Projects', 'com.lveditor.draft'));
}
export async function inspectJianyingEnvironment(options: EnvironmentOptions = {}): Promise<JianyingEnvironment> {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch, home = options.home ?? os.homedir(), env = options.env ?? process.env;
  const candidates: string[] = [];
  if (env.FANTAY_JIANYING_APP?.trim()) candidates.push(env.FANTAY_JIANYING_APP.trim());
  if (platform === 'darwin') for (const base of ['/Applications', path.join(home, 'Applications')]) for (const name of ['VideoFusion-macOS.app', 'JianyingPro.app', '剪映专业版.app', 'Jianying Pro.app']) candidates.push(path.join(base, name));
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    const base = path.win32.join(local, 'JianyingPro', 'Apps');
    candidates.push(path.win32.join(base, 'JianyingPro.exe'));
    try { for (const item of (await readdir(base)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) if (/^\d+\.\d+/.test(item)) candidates.push(path.win32.join(base, item, 'JianyingPro.exe')); } catch { /* Not installed in the default directory. */ }
    for (const baseDir of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) candidates.push(path.win32.join(baseDir!, 'JianyingPro', 'JianyingPro.exe'));
  }
  const readApp = options.readApp ?? (async (file: string) => {
    try {
      if (platform === 'darwin') {
        const plist = path.join(file, 'Contents', 'Info.plist');
        const info = await stat(plist).catch(() => null);
        if (!info) return null;
        const sig = `${info.size}:${info.mtimeMs}`;
        const cached = appInfoCache.get(plist);
        if (cached?.sig === sig) return cached.value;
        const field = async (key: string) => (await exec('/usr/bin/plutil', ['-extract', key, 'raw', plist], { timeout: 5000 })).stdout.trim();
        const [version, build, bundleId] = await Promise.all([field('CFBundleShortVersionString'), field('CFBundleVersion'), field('CFBundleIdentifier')]);
        const value = bundleId === 'com.lemon.lvpro' ? { version, build, bundleId } : null;
        appInfoCache.set(plist, { sig, value });
        return value;
      }
      if (platform === 'win32') {
        const info = await stat(file).catch(() => null);
        if (!info) return null;
        const sig = `${info.size}:${info.mtimeMs}`;
        const cached = appInfoCache.get(file);
        if (cached?.sig === sig) return cached.value;
        const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:FANTAY_JIANYING_PROBE).VersionInfo.FileVersion'], { env: { ...env, FANTAY_JIANYING_PROBE: file }, timeout: 5000 });
        const version = stdout.trim();
        const value = version ? { version, build: version, bundleId: 'JianyingPro.exe' } : null;
        appInfoCache.set(file, { sig, value });
        return value;
      }
    } catch { /* Continue discovery without launching or updating the client. */ }
    return null;
  });
  let application: JianyingEnvironment['application'] = { installed: false, path: null, version: null, build: null, bundleId: null, running: false };
  for (const candidate of candidates) {
    const info = await readApp(candidate);
    if (info) { application = { installed: true, path: candidate, ...info, running: false }; break; }
  }
  if (application.installed) {
    try {
      application.running = options.running ? await options.running() : platform === 'darwin' ? (await exec('/bin/ps', ['-axo', 'comm='], { timeout: 5000 })).stdout.split('\n').some(p => p.trim().endsWith('/Contents/MacOS/VideoFusion-macOS')) : platform === 'win32' ? /JianyingPro\.exe/i.test((await exec('tasklist.exe', ['/FI', 'IMAGENAME eq JianyingPro.exe', '/FO', 'CSV', '/NH'], { timeout: 5000 })).stdout) : false;
    } catch { application.running = true; }
  }
  const normalized = application.version?.match(/^\d+\.\d+\.\d+/)?.[0];
  const verified = platform === 'darwin' && arch === 'arm64' && normalized === '11.6.0' && application.build === '11.6.0';
  const known = normalized === '11.6.0' || normalized === '11.7.0' || (platform === 'win32' && /^(11\.5\.0\.14471|11\.6\.0\.14552)$/.test(application.version ?? ''));
  const ffprobe = options.hasFfprobe ? await options.hasFfprobe().catch(() => false) : await probeFfprobeOnce(jianyingFfprobe(), platform);
  const messages: string[] = [];
  if (!application.installed) messages.push('Jianying was not found. Drafts can still be generated locally; client compatibility is unverified.');
  else if (!verified) messages.push('This client version has not completed a Fantay desktop round trip. Plaintext editing is available; encrypted editing is disabled.');
  if (!ffprobe) messages.push('ffprobe is required to probe video and audio files.');
  const nativeReason = verified ? null : 'Encrypted editing currently requires verified Jianying 11.6.0 on macOS Apple Silicon.';
  return { platform, application, compatibility: verified ? 'verified' : !application.installed ? 'not-installed' : known ? 'known' : 'unverified', profile: known ? `jianying-${normalized ?? application.version}` : null,
    capabilities: { create: true, editPlaintext: true, editEncrypted: verified, install: platform === 'darwin' || platform === 'win32', automaticUpdate: false },
    native: { available: verified, prepared: false, reason: nativeReason }, ffprobe, draftsRoot: draftRoot(platform, home, env), messages };
}
