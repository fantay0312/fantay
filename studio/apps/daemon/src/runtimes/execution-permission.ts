import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ChatExecutionPermission } from '@open-design/contracts';

/**
 * Authoritative host-level execution-permission prompt boundary injected into
 * the composed prompt when a conversation restricts execution permissions.
 *
 * Runtime CLI flags / ACP permission rejection / OS sandboxes remain the hard
 * enforcement boundary; this directive aligns the model's tool selection so it
 * does not waste turns probing disabled shell/write/external tools.
 */
export function formatExecutionPermissionPromptDirective(
  permission: ChatExecutionPermission | null | undefined,
  cwd: string | null | undefined,
): string {
  const workspaceLabel =
    typeof cwd === 'string' && cwd.trim().length > 0
      ? ` (\`${cwd.trim()}\`)`
      : '';
  if (permission === 'read-only') {
    return [
      '## Execution Permission Policy (`read-only`)',
      `- This conversation is locked to **read-only** execution${workspaceLabel}.`,
      '- You MUST NOT create, edit, overwrite, rename, or delete any files, stage `<artifact>` file writes, invoke mutating MCP/external tools, or execute shell commands.',
      '- Inspect existing workspace files and answer in chat only.',
    ].join('\n');
  }
  if (permission === 'workspace-write') {
    return [
      '## Execution Permission Policy (`workspace-write`)',
      `- This conversation allows reading and modifying regular non-secret files strictly inside the active project workspace${workspaceLabel}.`,
      '- You MUST NOT execute shell/terminal commands, spawn external processes, call external MCP tools, or read/write paths outside the workspace.',
    ].join('\n');
  }
  return '';
}

/**
 * OpenCode / MiMo / Kilo config overlay (`OPENCODE_CONFIG_CONTENT`,
 * `MIMOCODE_CONFIG_CONTENT`, `KILO_CONFIG_CONTENT`) implementing the three
 * execution permission levels.
 */
export function buildOpenCodeExecutionPermissionConfig(
  permission: ChatExecutionPermission | null | undefined,
): Record<string, unknown> | undefined {
  if (!permission) return undefined;
  if (permission === 'danger-full-access') {
    return {
      permission: {
        '*': 'allow',
        external_directory: 'allow',
      },
    };
  }
  const allowEdit = permission === 'workspace-write' ? 'allow' : 'deny';
  return {
    permission: {
      '*': 'deny',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      ls: 'allow',
      list: 'allow',
      lsp: 'allow',
      todowrite: 'allow',
      todoread: 'allow',
      skill: 'allow',
      edit: allowEdit,
      write: allowEdit,
      patch: allowEdit,
      multiedit: allowEdit,
      bash: 'deny',
      task: 'deny',
      webfetch: 'deny',
      websearch: 'deny',
      codesearch: 'deny',
      external_directory: 'deny',
      question: 'deny',
      doom_loop: 'deny',
    },
  };
}

const STANDALONE_PI_WORKSPACE_GUARD_SOURCE = String.raw`import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function resolveSafeWorkspaceWritePath(cwd, file) {
  if (typeof file !== 'string' || !file || /^(?:@|~|file:)/u.test(file) || file.includes('\0')) {
    return null;
  }
  const root = await realpath(cwd);
  const destination = path.resolve(root, file);
  if (/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/u.test(destination)) return null;
  const relative = path.relative(root, destination);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    (process.platform === 'win32' && relative.includes(':'))
  ) {
    return null;
  }
  if (
    relative
      .split(path.sep)
      .some((part) => /^(?:\.env(?:\..*)?|\.ssh|\.git|credentials?(?:\..*)?)$/iu.test(part))
  ) {
    return null;
  }
  let candidate = destination;
  let isTarget = true;
  while (candidate !== root) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) return null;
      if (isTarget ? !info.isFile() || info.nlink !== 1 : !info.isDirectory()) return null;
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
    }
    candidate = path.dirname(candidate);
    isTarget = false;
  }
  return destination;
}

export default function fantayStandalonePiWorkspaceGuard(pi) {
  const cwd = process.cwd();

  pi.registerTool({
    name: 'fantay_workspace_write',
    label: 'Workspace Write',
    description: 'Write UTF-8 text to a regular file inside the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or in-workspace file path.' },
        content: { type: 'string', description: 'Full UTF-8 file contents to write.' },
      },
      required: ['path', 'content'],
    },
    async execute(_toolCallId, input) {
      const destination = await resolveSafeWorkspaceWritePath(cwd, input?.path);
      if (!destination) {
        throw new Error('Writes are limited to regular non-secret files inside this workspace.');
      }
      if (typeof input?.content !== 'string') {
        throw new Error('content must be a string.');
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, input.content, 'utf8');
      return {
        content: [{ type: 'text', text: 'Wrote ' + path.relative(cwd, destination) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: 'fantay_workspace_edit',
    label: 'Workspace Edit',
    description: 'Replace an exact text snippet inside an existing regular file in the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or in-workspace file path.' },
        oldText: { type: 'string', description: 'Exact existing text to replace.' },
        newText: { type: 'string', description: 'Replacement text.' },
      },
      required: ['path', 'oldText', 'newText'],
    },
    async execute(_toolCallId, input) {
      const destination = await resolveSafeWorkspaceWritePath(cwd, input?.path);
      if (!destination) {
        throw new Error('Edits are limited to regular non-secret files inside this workspace.');
      }
      const oldText = typeof input?.oldText === 'string' ? input.oldText : null;
      const newText = typeof input?.newText === 'string' ? input.newText : null;
      if (oldText === null || oldText.length === 0 || newText === null) {
        throw new Error('oldText (non-empty) and newText are required.');
      }
      const existing = await readFile(destination, 'utf8');
      if (!existing.includes(oldText)) {
        throw new Error('oldText was not found in ' + path.relative(cwd, destination));
      }
      const updated = existing.replace(oldText, () => newText);
      await writeFile(destination, updated, 'utf8');
      return {
        content: [{ type: 'text', text: 'Edited ' + path.relative(cwd, destination) }],
        details: {},
      };
    },
  });
}
`;

/**
 * Stages a package-free Pi extension for standalone user-installed `pi` in
 * `workspace-write` mode so built-in `write`/`edit`/`bash` can be omitted via
 * `--tools` without importing a specific pi-coding-agent package namespace.
 */
export async function ensureStandalonePiWorkspaceGuardExtension(
  runtimeDataDir: string,
): Promise<string> {
  const dir = path.join(runtimeDataDir, 'agent-runtime', 'pi');
  const file = path.join(dir, 'standalone-workspace-guard-v1.mjs');
  await mkdir(dir, { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, STANDALONE_PI_WORKSPACE_GUARD_SOURCE, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  return file;
}

function escapeGlobLiteral(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/([*?[\]{}()!])/g, '\\$1').replace(/\/+$/, '');
}

/**
 * Builds Amp's `settings.json` payload enforcing `read-only` or
 * `workspace-write` via `amp.permissions` (evaluated first-match-wins).
 */
export function buildAmpExecutionPermissionSettings(
  permission: 'read-only' | 'workspace-write',
  cwd: string | null | undefined,
): Record<string, unknown> {
  const normalizedCwd =
    typeof cwd === 'string' && cwd.trim().length > 0
      ? escapeGlobLiteral(path.resolve(cwd.trim()))
      : null;

  const readPathPattern = normalizedCwd ? `${normalizedCwd}/**` : '*';
  const rules: Array<Record<string, unknown>> = [
    // Always block shell, subagent, external MCP, and network tools in restricted modes.
    { tool: 'Bash', action: 'reject' },
    { tool: 'Task', action: 'reject' },
    { tool: 'mcp__*', action: 'reject' },
    { tool: 'read_web_page', action: 'reject' },
    { tool: 'web_search', action: 'reject' },
  ];

  if (permission === 'workspace-write' && normalizedCwd) {
    // Block sensitive dotfiles even inside workspace before allowing workspace edits.
    rules.push(
      { tool: 'edit_file', matches: { path: [`${normalizedCwd}/.git/**`, `${normalizedCwd}/.env*`] }, action: 'reject' },
      { tool: 'create_file', matches: { path: [`${normalizedCwd}/.git/**`, `${normalizedCwd}/.env*`] }, action: 'reject' },
      { tool: 'edit_file', matches: { path: `${normalizedCwd}/**` }, action: 'allow' },
      { tool: 'create_file', matches: { path: `${normalizedCwd}/**` }, action: 'allow' },
    );
  }

  // Reject any file mutation not matched above.
  rules.push(
    { tool: 'edit_file', action: 'reject' },
    { tool: 'create_file', action: 'reject' },
    { tool: 'delete_file', action: 'reject' },
    { tool: 'undo_edit', action: 'reject' },
    // Allow read/search inspection inside workspace.
    { tool: 'Read', matches: { path: readPathPattern }, action: 'allow' },
    { tool: 'glob', action: 'allow' },
    { tool: 'Grep', action: 'allow' },
    { tool: 'finder', action: 'allow' },
    { tool: 'todo_write', action: 'allow' },
    { tool: 'todo_read', action: 'allow' },
    // Default deny everything else so headless Amp never falls back to interactive ask.
    { tool: '*', action: 'reject' },
  );

  return {
    'amp.dangerouslyAllowAll': false,
    'amp.permissions': rules,
  };
}

export async function prepareAmpPermissionSettingsFile(input: {
  runtimeDataDir: string;
  runId: string;
  permission: 'read-only' | 'workspace-write';
  cwd: string | null | undefined;
}): Promise<{ settingsFilePath: string; cleanup: () => Promise<void> }> {
  const safeRunId = input.runId.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || randomUUID();
  const dir = path.join(input.runtimeDataDir, 'agent-runtime', 'amp', 'runs');
  await mkdir(dir, { recursive: true });
  const settingsFilePath = path.join(dir, `amp-settings-${safeRunId}-${randomUUID().slice(0, 8)}.json`);
  const content = JSON.stringify(
    buildAmpExecutionPermissionSettings(input.permission, input.cwd),
    null,
    2,
  );
  await writeFile(settingsFilePath, content, { mode: 0o600 });
  return {
    settingsFilePath,
    cleanup: async () => {
      await rm(settingsFilePath, { force: true });
    },
  };
}
