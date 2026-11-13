import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { ChatExecutionPermission } from '@open-design/contracts';

export interface AcpPermissionOption {
  optionId?: string;
  kind?: string;
  name?: string;
}

export interface AcpTrackedToolHint {
  name?: string | undefined;
  kind?: string | undefined;
  rawInput?: Record<string, unknown> | undefined;
  locations?: Array<{ path?: string | undefined }> | undefined;
}

export type AcpPermissionOutcomeResult =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } };

const ALLOW_OPTION_KINDS = new Set(['allow_once', 'allow_always']);
const REJECT_OPTION_KINDS = new Set(['reject_once', 'reject_always']);

const SHELL_OR_EXTERNAL_KINDS = new Set([
  'execute',
  'bash',
  'shell',
  'terminal',
  'command',
  'fetch',
  'network',
  'web',
  'mcp',
  'switch_mode',
  'other',
]);

const READ_TOOL_KINDS = new Set(['read', 'search', 'think']);
const WRITE_TOOL_KINDS = new Set(['edit', 'write', 'delete', 'move']);

const SHELL_OR_EXTERNAL_NAME_RE =
  /(?:^|[_./:-])(?:bash|sh|zsh|cmd|powershell|shell|terminal|exec|execute|run_command|command|spawn|subagent|task|web_?search|web_?fetch|fetch|http|curl|browser|mcp)(?:$|[_./:-])/iu;
const READ_NAME_RE =
  /(?:^|[_./:-])(?:read|read_file|view|cat|ls|list|list_dir|glob|grep|search|find|stat|todo_read|todo_write|think)(?:$|[_./:-])/iu;
const WRITE_NAME_RE =
  /(?:^|[_./:-])(?:write|write_file|create|create_file|edit|edit_file|str_replace|replace|patch|apply_patch|multiedit|insert|rename|move|mkdir)(?:$|[_./:-])/iu;
const DELETE_NAME_RE =
  /(?:^|[_./:-])(?:delete|delete_file|rm|remove|unlink)(?:$|[_./:-])/iu;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function selectAllowPermissionOutcome(
  options: unknown,
): AcpPermissionOutcomeResult | null {
  const list = Array.isArray(options) ? (options as AcpPermissionOption[]) : [];
  const preferred =
    list.find((opt) => opt && opt.kind === 'allow_once' && typeof opt.optionId === 'string') ||
    list.find((opt) => opt && opt.kind === 'allow_always' && typeof opt.optionId === 'string') ||
    list.find(
      (opt) =>
        opt &&
        typeof opt.optionId === 'string' &&
        typeof opt.kind === 'string' &&
        ALLOW_OPTION_KINDS.has(opt.kind),
    ) ||
    list.find(
      (opt) =>
        opt &&
        typeof opt.optionId === 'string' &&
        !/reject|deny|cancel|block/iu.test(`${opt.kind ?? ''} ${opt.optionId} ${opt.name ?? ''}`),
    );
  return preferred?.optionId
    ? { outcome: { outcome: 'selected', optionId: preferred.optionId } }
    : null;
}

export function selectRejectPermissionOutcome(
  options: unknown,
): AcpPermissionOutcomeResult {
  const list = Array.isArray(options) ? (options as AcpPermissionOption[]) : [];
  const preferred =
    list.find((opt) => opt && opt.kind === 'reject_once' && typeof opt.optionId === 'string') ||
    list.find((opt) => opt && opt.kind === 'reject_always' && typeof opt.optionId === 'string') ||
    list.find(
      (opt) =>
        opt &&
        typeof opt.optionId === 'string' &&
        typeof opt.kind === 'string' &&
        REJECT_OPTION_KINDS.has(opt.kind),
    ) ||
    list.find(
      (opt) =>
        opt &&
        typeof opt.optionId === 'string' &&
        /reject|deny|disallow|forbid|no\b/iu.test(
          `${opt.kind ?? ''} ${opt.optionId} ${opt.name ?? ''}`,
        ),
    );
  if (preferred?.optionId) {
    return { outcome: { outcome: 'selected', optionId: preferred.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * Verifies that `candidatePath` resolves inside `workspaceRoot` without
 * traversing symlinks, hardlinked files, or secret dotfiles (`.git`, `.env`, `.ssh`).
 */
export function isSafeAcpWorkspacePath(
  workspaceRoot: string | null | undefined,
  candidatePath: string,
  options: { forMutation: boolean },
): boolean {
  if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    return false;
  }
  if (
    typeof candidatePath !== 'string' ||
    !candidatePath.trim() ||
    candidatePath.includes('\0') ||
    /^(?:~|file:|https?:)/iu.test(candidatePath.trim())
  ) {
    return false;
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(workspaceRoot);
  } catch {
    return false;
  }
  const resolved = path.resolve(canonicalRoot, candidatePath.trim());
  const relative = path.relative(canonicalRoot, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    (options.forMutation && relative === '')
  ) {
    return false;
  }
  const parts = relative.split(path.sep).filter(Boolean);
  if (
    parts.some((part) =>
      /^(?:\.env(?:\..*)?|\.ssh|\.git|credentials?(?:\..*)?)$/iu.test(part),
    )
  ) {
    return false;
  }

  let cursor = canonicalRoot;
  for (let i = 0; i < parts.length; i += 1) {
    cursor = path.join(cursor, parts[i]!);
    try {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) return false;
      if (options.forMutation && i === parts.length - 1 && info.isFile() && info.nlink > 1) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') break;
      return false;
    }
  }

  let existingAncestor = resolved;
  while (!existsSync(existingAncestor)) {
    const next = path.dirname(existingAncestor);
    if (next === existingAncestor) return false;
    existingAncestor = next;
  }
  try {
    const canonicalAncestor = realpathSync.native(existingAncestor);
    const ancestorRel = path.relative(canonicalRoot, canonicalAncestor);
    return (
      ancestorRel === '' ||
      (ancestorRel !== '..' &&
        !ancestorRel.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(ancestorRel))
    );
  } catch {
    return false;
  }
}

const PATH_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filepath',
  'target_file',
  'targetFile',
  'filename',
  'destination',
  'dest',
  'to',
  'from',
  'source',
  'cwd',
  'dir',
  'directory',
];

function collectCandidatePaths(
  toolCall: Record<string, unknown> | null,
  tracked: AcpTrackedToolHint | null | undefined,
): string[] {
  const paths: string[] = [];
  const push = (val: unknown) => {
    if (typeof val === 'string' && val.trim().length > 0) {
      paths.push(val.trim());
    }
  };

  for (const locList of [toolCall?.locations, tracked?.locations]) {
    if (Array.isArray(locList)) {
      for (const item of locList) {
        if (typeof item === 'string') push(item);
        else push(asRecord(item)?.path);
      }
    }
  }

  for (const raw of [asRecord(toolCall?.rawInput), asRecord(toolCall?.input), tracked?.rawInput]) {
    if (!raw) continue;
    for (const key of PATH_KEYS) {
      push(raw[key]);
    }
    if (Array.isArray(raw.paths)) {
      for (const p of raw.paths) push(p);
    }
    if (Array.isArray(raw.files)) {
      for (const f of raw.files) {
        if (typeof f === 'string') push(f);
        else push(asRecord(f)?.path ?? asRecord(f)?.file_path ?? asRecord(f)?.filePath);
      }
    }
  }

  // Content blocks with `type: 'diff'` in ACP carry `{ type: 'diff', path: '...' }`.
  if (Array.isArray(toolCall?.content)) {
    for (const block of toolCall.content) {
      const rec = asRecord(block);
      if (rec?.type === 'diff') push(rec.path);
    }
  }

  return Array.from(new Set(paths));
}

function classifyAcpToolOperation(
  params: Record<string, unknown> | null,
  toolCall: Record<string, unknown> | null,
  tracked: AcpTrackedToolHint | null | undefined,
): 'read' | 'write' | 'forbidden' | 'unknown' {
  const rawKind = String(
    toolCall?.kind ?? tracked?.kind ?? params?.kind ?? '',
  )
    .trim()
    .toLowerCase();

  const combinedName = [
    toolCall?.name,
    tracked?.name,
    toolCall?.title,
    params?.title,
    asRecord(params?.subject)?.name,
    asRecord(params?.subject)?.type,
  ]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .join(' ');

  const rawInput = asRecord(toolCall?.rawInput) ?? asRecord(toolCall?.input) ?? tracked?.rawInput ?? null;
  if (
    rawInput &&
    (typeof rawInput.command === 'string' ||
      Array.isArray(rawInput.command) ||
      typeof rawInput.cmd === 'string' ||
      typeof rawInput.url === 'string')
  ) {
    return 'forbidden';
  }

  if (SHELL_OR_EXTERNAL_NAME_RE.test(combinedName)) return 'forbidden';
  if (rawKind && SHELL_OR_EXTERNAL_KINDS.has(rawKind)) return 'forbidden';

  // Destructive deletes are rejected in restricted modes unless explicitly safe;
  // keeping `delete` rejected in read-only and workspace-write avoids accidental rm.
  if (rawKind === 'delete' || DELETE_NAME_RE.test(combinedName)) {
    return 'forbidden';
  }

  if (rawKind && WRITE_TOOL_KINDS.has(rawKind)) return 'write';
  if (WRITE_NAME_RE.test(combinedName)) return 'write';

  // Diff content block always implies file modification.
  if (
    Array.isArray(toolCall?.content) &&
    toolCall.content.some((block) => asRecord(block)?.type === 'diff')
  ) {
    return 'write';
  }

  if (rawKind && READ_TOOL_KINDS.has(rawKind)) return 'read';
  if (READ_NAME_RE.test(combinedName)) return 'read';

  return 'unknown';
}

/**
 * Evaluates an ACP `session/request_permission` call against the conversation's
 * `executionPermission` and active project `cwd`.
 */
export function evaluateAcpPermissionRequest(input: {
  params: unknown;
  executionPermission: ChatExecutionPermission | null | undefined;
  cwd: string | null | undefined;
  trackedTool?: AcpTrackedToolHint | null;
}): AcpPermissionOutcomeResult | null {
  const record = asRecord(input.params);
  const options = record?.options;
  const permission = input.executionPermission;

  // Unset or full-access preserves historical auto-allow behavior.
  if (!permission || permission === 'danger-full-access') {
    return selectAllowPermissionOutcome(options);
  }

  const toolCall = asRecord(record?.toolCall);
  const op = classifyAcpToolOperation(record, toolCall, input.trackedTool);

  if (op === 'forbidden' || op === 'unknown') {
    return selectRejectPermissionOutcome(options);
  }

  if (permission === 'read-only' && op !== 'read') {
    return selectRejectPermissionOutcome(options);
  }

  const candidatePaths = collectCandidatePaths(toolCall, input.trackedTool);
  if (op === 'write') {
    // Never approve an unscoped write when we cannot verify its target path lies inside cwd.
    if (candidatePaths.length === 0) {
      return selectRejectPermissionOutcome(options);
    }
    for (const candidate of candidatePaths) {
      if (!isSafeAcpWorkspacePath(input.cwd, candidate, { forMutation: true })) {
        return selectRejectPermissionOutcome(options);
      }
    }
    return selectAllowPermissionOutcome(options) ?? selectRejectPermissionOutcome(options);
  }

  // op === 'read': if target paths are specified, every one must reside inside cwd.
  for (const candidate of candidatePaths) {
    if (!isSafeAcpWorkspacePath(input.cwd, candidate, { forMutation: false })) {
      return selectRejectPermissionOutcome(options);
    }
  }
  return selectAllowPermissionOutcome(options) ?? selectRejectPermissionOutcome(options);
}
