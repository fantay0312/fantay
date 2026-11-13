import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliUpdateMethod, CliUpdateReason } from '@open-design/contracts';
import { agentCliEnvForAgent, readAppConfig } from '../app-config.js';
import { runtimeDisabledReason, skipRuntimeProbe } from './access-policy.js';
import { spawnEnvForAgent } from './env.js';
import { resolveOnPath } from './executables.js';
import { execAgentFile } from './invocation.js';
import { applyAgentLaunchEnv, resolveAgentLaunch } from './launch.js';
import { AGENT_DEFS, getAgentDef } from './registry.js';
import { normalizeCliVersion } from './cli-update-version.js';
import { runCliUpdateCommand } from './cli-update-process.js';
import { installMetaForAgent } from './metadata.js';
import { isBundledPiAgent } from './bundled-pi.js';

// Package names are an allowlist, never accepted from a request or remote feed.
const PACKAGES: Record<string, string[]> = {
  claude: ['@anthropic-ai/claude-code'], codex: ['@openai/codex'],
  opencode: ['opencode-ai'], pi: ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'],
  copilot: ['@github/copilot'], qwen: ['@qwen-code/qwen-code'],
  'deepseek-harness': ['@deepseek-ai/dsh'], codebuddy: ['@tencent-ai/codebuddy-code'],
  atomcode: ['@atomgit.com/atomcode'],
};
const BREW: Record<string, string[]> = {
  claude: ['claude-code', 'claude-code@latest'], codex: ['codex'], opencode: ['opencode'],
  pi: ['pi-coding-agent'], copilot: ['copilot-cli'], 'grok-build': ['grok-build'],
  antigravity: ['antigravity-cli'],
};

export interface CliUpdateTarget {
  agentId: string;
  version: string | null;
  selectedPath: string;
  identity: string;
  method: CliUpdateMethod;
  reason?: CliUpdateReason | undefined;
  sourceUrl?: string | undefined;
  env: NodeJS.ProcessEnv;
  command?: string;
  args?: string[];
  packageName?: string;
  native?: 'claude' | 'cursor' | 'grok' | 'agy' | 'codex' | 'opencode';
  channel?: string | undefined;
  cask?: boolean;
}

function real(file: string): string {
  try { return realpathSync(file); } catch { return file; }
}

function fileText(file: string): string {
  try { return statSync(file).size <= 64 * 1024 ? readFileSync(file, 'utf8') : ''; } catch { return ''; }
}

function jsonFile(file: string): Record<string, unknown> {
  try { return JSON.parse(fileText(file)); } catch { return {}; }
}

function executable(file: string): boolean {
  try { accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return statSync(file).isFile(); } catch { return false; }
}

/** A locally installed, static forwarding script; read its literal target, never evaluate shell. */
function installationPath(agentId: string, selected: string): string {
  if (agentId !== 'codex') return real(selected);
  const text = fileText(selected);
  const target = text.match(/^REAL_CODEX="([^"\r\n$`]+)"$/m)?.[1];
  if (target && path.isAbsolute(target) && /exec "\$REAL_CODEX"/.test(text) && executable(target)) return real(target);
  return real(selected);
}

function nativeKind(agentId: string, file: string): CliUpdateTarget['native'] | undefined {
  const slash = file.replaceAll('\\', '/');
  if (agentId === 'claude' && (slash.includes('/.local/share/claude/versions/') || slash.endsWith('/.local/bin/claude.exe'))) return 'claude';
  if (agentId === 'cursor-agent' && slash.includes('/.local/share/cursor-agent/versions/')) return 'cursor';
  if (agentId === 'grok-build' && /\/\.grok\/(bin|downloads)\//.test(slash)) return 'grok';
  if (agentId === 'antigravity' && real(path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy')) === file) return 'agy';
  if (agentId === 'codex' && slash.includes('/.codex/packages/standalone/')) return 'codex';
  if (agentId === 'opencode' && slash.includes('/.opencode/bin/')) return 'opencode';
  return undefined;
}

export function resolveCliUpdateTarget(agentId: string, selectedPath: string, env: NodeJS.ProcessEnv): CliUpdateTarget {
  const file = installationPath(agentId, selectedPath);
  const base: CliUpdateTarget = { agentId, selectedPath, version: null, identity: `manual:${selectedPath}`, method: 'manual', reason: 'unknown-install', env };
  const meta = installMetaForAgent(agentId);
  const definition = getAgentDef(agentId);
  base.sourceUrl = meta.installUrl ?? definition?.installUrl ?? meta.docsUrl ?? definition?.docsUrl;
  if (/\.app\/Contents\//.test(file)) return { ...base, reason: 'app-managed' };

  const brew = file.replaceAll('\\', '/').match(/^(.*)\/(Cellar|Caskroom)\/([^/]+)\//);
  if (brew && BREW[agentId]?.includes(brew[3]!)) {
    const command = path.join(brew[1]!, 'bin', 'brew');
    if (executable(command)) return { ...base, method: 'homebrew', reason: undefined, identity: `brew:${brew[1]}:${brew[3]}`, command,
      packageName: brew[3]!, cask: brew[2] === 'Caskroom', sourceUrl: `https://formulae.brew.sh/${brew[2] === 'Caskroom' ? 'cask' : 'formula'}/${brew[3]}` };
  }
  for (const packageName of PACKAGES[agentId] ?? []) {
    const marker = `${path.sep}node_modules${path.sep}${packageName.split('/').join(path.sep)}${path.sep}`;
    const offset = file.indexOf(marker);
    if (offset < 0) continue;
    const modulesParent = file.slice(0, offset);
    const manifest = jsonFile(path.join(modulesParent, 'node_modules', packageName, 'package.json'));
    if (manifest.name !== packageName) continue;
    // Never mutate a version manager's store or a project's node_modules through npm.
    if (/[/\\](?:\.pnpm|pnpm|\.bun|\.volta|\.yarn|yarn)[/\\]/.test(file)) return { ...base, packageName };
    const prefix = process.platform === 'win32' ? modulesParent : path.basename(modulesParent) === 'lib' ? path.dirname(modulesParent) : null;
    if (!prefix) continue;
    const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
    const ownNpm = path.join(binDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const command = executable(ownNpm) ? ownNpm : resolveOnPath(process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!command) continue;
    return { ...base, identity: `npm:${prefix}:${packageName}`, method: 'npm', reason: undefined, packageName, command,
      args: ['install', '--global', '--prefix', prefix, '--include=optional'],
      env: { ...env, PATH: `${binDir}${path.delimiter}${env.PATH ?? ''}` }, sourceUrl: `https://www.npmjs.com/package/${packageName}` };
  }
  const native = nativeKind(agentId, file);
  if (native) {
    const channel = native === 'claude'
      ? jsonFile(path.join(env.CLAUDE_CONFIG_DIR || os.homedir() + '/.claude', 'settings.json')).autoUpdatesChannel === 'stable' ? 'stable' : 'latest'
      : undefined;
    return { ...base, method: 'native', reason: undefined, identity: `native:${native}:${selectedPath}`, native, channel,
      command: selectedPath, args: [native === 'opencode' ? 'upgrade' : 'update'] };
  }
  return base;
}

export async function discoverCliUpdateTargets(runtimeDataDir: string): Promise<CliUpdateTarget[]> {
  const config = await readAppConfig(runtimeDataDir);
  const targets = await Promise.all(AGENT_DEFS.filter(def => !isBundledPiAgent(def.id)).map(async def => {
    if (runtimeDisabledReason(def) || skipRuntimeProbe(def)) return null;
    const configured = agentCliEnvForAgent(config.agentCliEnv ?? {}, def.id);
    const launch = resolveAgentLaunch(def, configured);
    if (!launch.selectedPath) return null;
    const env = applyAgentLaunchEnv(spawnEnvForAgent(def.id, process.env, configured), launch);
    const target = resolveCliUpdateTarget(def.id, launch.selectedPath, env);
    try {
      const result = await execAgentFile(launch.launchPath ?? launch.selectedPath, def.versionArgs, {
        env: { ...env, DISABLE_AUTOUPDATER: '1' }, timeout: 8_000, maxBuffer: 128 * 1024,
      });
      target.version = normalizeCliVersion(`${result.stdout}\n${result.stderr}`);
    } catch { /* An installed but unhealthy CLI remains visible; it cannot be upgraded blindly. */ }
    return target;
  }));
  return targets.filter((target): target is CliUpdateTarget => target !== null);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'FantayDesign', accept: 'application/json, text/plain;q=0.9' } });
  if (!response.ok) throw new Error(`Update source returned ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty update metadata');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 512 * 1024) throw new Error('Update metadata too large');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function latestCliVersion(target: CliUpdateTarget): Promise<string | null> {
  let raw: unknown;
  if (target.method === 'homebrew') {
    const data = JSON.parse(await fetchText(`https://formulae.brew.sh/api/${target.cask ? 'cask' : 'formula'}/${target.packageName}.json`));
    raw = target.cask ? data.version?.split(',')[0] : data.versions?.stable;
  } else if (target.native === 'claude') {
    raw = await fetchText(`https://downloads.claude.ai/claude-code-releases/${target.channel ?? 'latest'}`);
  } else if (target.native === 'grok') {
    const result = await execAgentFile(target.selectedPath, ['update', '--check', '--json'], { env: target.env, timeout: 20_000, maxBuffer: 128 * 1024 });
    const data = JSON.parse(String(result.stdout));
    if (data.error) throw new Error('Grok update check failed');
    raw = data.latestVersion;
  } else if (target.native === 'cursor') {
    // Read the vendor installer as metadata only. Never download-and-execute a shell script.
    raw = (await fetchText('https://cursor.com/install')).match(/https:\/\/downloads\.cursor\.com\/lab\/([^/\s"']+)\//)?.[1];
  } else if (target.native === 'agy') {
    const platform = `${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux'}_${process.arch === 'x64' ? 'amd64' : process.arch}`;
    raw = JSON.parse(await fetchText(`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform}.json`)).version;
  } else {
    const packageName = target.packageName ?? PACKAGES[target.agentId]?.[0];
    if (!packageName) return null;
    raw = JSON.parse(await fetchText(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`)).version;
  }
  const version = normalizeCliVersion(typeof raw === 'string' ? raw : '');
  if (!version) throw new Error('Update source returned no valid version');
  return version;
}

export async function executeCliUpdate(target: CliUpdateTarget, version: string): Promise<void> {
  if (!target.command || target.method === 'manual') throw new Error('Unsupported installation');
  const args = target.method === 'npm' ? [...(target.args ?? []), `${target.packageName}@${version}`]
    : target.method === 'homebrew' ? ['upgrade', ...(target.cask ? ['--cask'] : []), target.packageName!]
    : target.native === 'opencode' ? ['upgrade', version] : target.args!;
  await runCliUpdateCommand(target.command, args, {
    env: { ...target.env, CI: '1', NONINTERACTIVE: '1', NO_COLOR: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' },
    timeoutMs: 10 * 60_000,
  });
}
