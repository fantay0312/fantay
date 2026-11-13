import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Generated runtime module, carried in the daemon bundle so packaged users do
// not need another CLI or an npm plugin install. No imports or provider hooks.
export const OPEN_CODE_EVENT_PLUGIN_SOURCE = String.raw`export default async function () {
  const seen = new Map();
  const messages = new Map();
  const parts = new Map();
  const emit = (part) => {
    if (messages.get(part.sessionID + ':' + part.messageID) !== 'assistant' || part.text.length <= part.sent) return;
    process.stdout.write(JSON.stringify({ type: 'od_opencode_delta', version: 1, sessionID: part.sessionID, partID: part.id, kind: part.type, offset: part.sent, delta: part.text.slice(part.sent) }) + '\n');
    part.sent = part.text.length;
  };
  return { event: async (payload) => {
    try {
      const event = payload?.event;
      const properties = event?.properties;
      if (event?.type === 'message.updated') {
        const info = properties?.info;
        if (typeof info?.sessionID !== 'string' || typeof info.id !== 'string') return;
        const role = info.role === 'assistant' && info.summary !== true && info.agent !== 'compaction' ? 'assistant' : info.role === 'user' ? 'user' : 'internal';
        messages.set(info.sessionID + ':' + info.id, role);
        if (messages.size > 1024) messages.delete(messages.keys().next().value);
        if (role === 'assistant') for (const part of parts.values()) if (part.sessionID === info.sessionID && part.messageID === info.id) emit(part);
        return;
      }
      if (event?.type === 'message.part.delta') {
        const part = parts.get(properties?.sessionID + ':' + properties?.partID);
        if (!part || properties.field !== 'text' || typeof properties.delta !== 'string' || part.text.length + properties.delta.length > 2097152) return;
        part.text += properties.delta; emit(part); return;
      }
      if (event?.type !== 'message.part.updated') return;
      const p = properties?.part;
      if ((p?.type === 'text' || p?.type === 'reasoning') && typeof p.id === 'string' && typeof p.sessionID === 'string' && typeof p.messageID === 'string') {
        const key = p.sessionID + ':' + p.id;
        const part = parts.get(key) || { id: p.id, sessionID: p.sessionID, messageID: p.messageID, type: p.type, text: '', sent: 0 };
        if (typeof p.text === 'string' && p.text.length <= 2097152 && p.text.startsWith(part.text)) part.text = p.text;
        parts.set(key, part); emit(part);
        if (typeof p.time?.end === 'number') parts.delete(key);
        if (parts.size > 1024) parts.delete(parts.keys().next().value);
        return;
      }
      if (p?.type !== 'tool' || typeof p.sessionID !== 'string' || typeof p.callID !== 'string' || typeof p.tool !== 'string') return;
      const key = p.sessionID + ':' + p.callID;
      if (p.state?.status === 'completed' || p.state?.status === 'error') { seen.delete(key); return; }
      if (p.state?.status !== 'pending' && p.state?.status !== 'running') return;
      const input = p.state.input;
      const target = ['write', 'edit', 'read'].includes(p.tool) && typeof input?.filePath === 'string' ? input.filePath : undefined;
      const signature = p.tool + ':' + (target || '');
      if (seen.get(key) === signature) return;
      process.stdout.write(JSON.stringify({ type: 'od_opencode_tool', version: 1, sessionID: p.sessionID, callID: p.callID, tool: p.tool, path: target }) + '\n');
      seen.set(key, signature);
    } catch { /* Preview delivery cannot affect tool execution. */ }
  }};
}
`;

export function supportsOpenCodeEventPlugin(version: string | undefined): boolean {
  const match = /^1\.(\d+)\.(\d+)$/u.exec(version ?? '');
  return Boolean(match && (Number(match[1]) > 17 || (Number(match[1]) === 17 && Number(match[2]) >= 18)));
}

/** OpenCode waits for its own npm setup even for an import-free file plugin. */
function applyDependencyFetchDefaults(env: NodeJS.ProcessEnv): void {
  const defaults = { npm_config_fetch_retries: '0', npm_config_fetch_timeout: '10000' };
  for (const [key, value] of Object.entries(defaults)) {
    // npm accepts uppercase names too. Preserve explicit per-agent/shell env.
    if (!Object.keys(env).some(name => name.toLowerCase() === key && env[name] !== undefined)) env[key] = value;
  }
}

/** Mutates only this child's config overlay; dataDir is the daemon's resolved root. */
export async function applyOpenCodeEventPlugin(
  env: NodeJS.ProcessEnv,
  dataDir: string,
  version: string | undefined,
  inheritedConfigContent?: string,
): Promise<boolean> {
  if (!supportsOpenCodeEventPlugin(version) || /^(1|true)$/iu.test(env.OPENCODE_PURE ?? '')) return false;
  const config: unknown = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const overlay = config as Record<string, unknown>;
  if (overlay.plugin !== undefined && !Array.isArray(overlay.plugin)) return false;
  const inherited: unknown = inheritedConfigContent ? JSON.parse(inheritedConfigContent) : {};
  const inheritedPlugins = inherited && typeof inherited === 'object' && 'plugin' in inherited && Array.isArray(inherited.plugin)
    ? inherited.plugin : [];
  const plugins = Array.isArray(overlay.plugin) ? overlay.plugin : [];
  const hash = createHash('sha256').update(OPEN_CODE_EVENT_PLUGIN_SOURCE).digest('hex').slice(0, 16);
  const dir = path.join(dataDir, 'agent-runtime', 'opencode', 'plugins');
  const file = path.join(dir, `tool-events-${hash}.mjs`);
  // Reuse verified content on subsequent turns; repair a truncated/modified
  // module before advertising it to the child.
  if (await readFile(file, 'utf8').catch(() => null) !== OPEN_CODE_EVENT_PLUGIN_SOURCE) {
    await mkdir(dir, { recursive: true });
    // Atomic replacement keeps concurrent launches from loading partial JS.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, OPEN_CODE_EVENT_PLUGIN_SOURCE, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...overlay, plugin: [...new Set([...inheritedPlugins, ...plugins, pathToFileURL(file).href])],
  });
  applyDependencyFetchDefaults(env);
  return true;
}
