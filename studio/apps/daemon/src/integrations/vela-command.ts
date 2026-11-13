import { runTokenToSeaCommand } from './tokentosea-command.js';
import { execFile } from 'node:child_process';
import { recordDiagnosticFailure } from '../services/diagnostics-evidence.js';
import { isAbortedOperationError } from './aborted-error.js';

import {
  collectProcessTreePids,
  createCommandInvocation,
  listProcessSnapshots,
  stopProcesses,
} from '@open-design/platform';

import {
  agentCliEnvForAgent,
  readAppConfigSync,
} from '../app-config.js';
import { spawnEnvForAgent } from '../runtimes/env.js';
import {
  applyAgentLaunchEnv,
  resolveAgentLaunch,
} from '../runtimes/launch.js';
import { getAgentDef } from '../runtimes/registry.js';

/** Flags whose values carry user identity or user content (OPEND-3520). */
const REDACTED_VELA_ARG_FLAGS = new Set([
  '--display-name',
  '--name',
  '--email',
  '--activity-json',
  '--metadata-json',
]);
const REDACTED_VELA_ARG = '[REDACTED]';

/**
 * Node's exec error repeats the full command line in `message`, `cmd`, and
 * `stack`, and callers log those verbatim. Replace the values of identity /
 * user-content flags there before the error leaves the runner. Only the
 * `<flag> <value>` occurrences are rewritten, so stderr (which carries the
 * `API request failed with status NNN` classification signal) is untouched.
 */
export function redactVelaCommandError(error: unknown, args: readonly string[]): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const pairs: Array<{ flag: string; value: string }> = [];
  for (let index = 0; index < args.length; index += 1) {
    // Callers are typed, but redaction must never turn a command failure
    // into a different crash, so tolerate non-string argv entries.
    const arg: unknown = args[index];
    if (typeof arg !== 'string') continue;
    const equals = arg.indexOf('=');
    const next: unknown = args[index + 1];
    if (REDACTED_VELA_ARG_FLAGS.has(arg) && typeof next === 'string') {
      pairs.push({ flag: arg, value: next });
      index += 1;
    } else if (equals > 0 && REDACTED_VELA_ARG_FLAGS.has(arg.slice(0, equals))) {
      pairs.push({ flag: arg.slice(0, equals), value: arg.slice(equals + 1) });
    }
  }
  if (pairs.length === 0) return error;
  const redact = (text: string): string => {
    let out = text;
    for (const { flag, value } of pairs) {
      if (!value) continue;
      for (const separator of [' ', '=']) {
        for (const quote of ['', '"', "'"]) {
          out = out.split(`${flag}${separator}${quote}${value}${quote}`)
            .join(`${flag}${separator}${quote}${REDACTED_VELA_ARG}${quote}`);
        }
      }
    }
    return out;
  };
  const target = error as { message?: unknown; cmd?: unknown; stack?: unknown };
  for (const key of ['message', 'cmd', 'stack'] as const) {
    try {
      if (typeof target[key] === 'string') target[key] = redact(target[key] as string);
    } catch {
      // A frozen error must not turn a command failure into a different one.
    }
  }
  return error;
}

/**
 * A failed Vela command still carries meaning on stdout.
 *
 * `vela image gen --json` prints the complete task object — including its
 * structured `error` block — and only then exits non-zero. Rejecting with the
 * bare exec error therefore threw away the one thing that distinguishes a
 * content-safety rejection from a provider outage, leaving every caller with
 * nothing but "Command failed with exit code 1".
 *
 * The stdout is attached to the rejection rather than resolved, so the command
 * still fails and no caller can mistake a failure for success; readers that
 * want the structured detail opt in through `velaCommandStdout`.
 */
function withCommandStdout(error: unknown, stdout: string): unknown {
  if (!stdout || typeof error !== 'object' || error === null) return error;
  try {
    (error as { stdout?: string }).stdout = stdout;
  } catch {
    // A frozen or exotic error object must not turn a command failure into a
    // different, more confusing failure.
  }
  return error;
}

function withCommandStderr(error: unknown, stderr: string): unknown {
  if (!stderr || typeof error !== 'object' || error === null) return error;
  try {
    (error as { stderr?: string }).stderr = stderr;
  } catch {
    // See withCommandStdout: diagnostics must never replace the real failure.
  }
  return error;
}

/**
 * Read the stdout captured by `withCommandStdout` off a rejected Vela command.
 * Returns an empty string when the failure carried none (a crash before any
 * output, or a non-object rejection).
 */
export function velaCommandStdout(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === 'string' ? stdout : '';
}

/** Read the exact stderr produced by a rejected Vela command. */
export function velaCommandStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr : '';
}

export interface VelaCommandOptions {
  env?: NodeJS.ProcessEnv;
  configuredEnv?: Record<string, string>;
  maxBuffer?: number;
  /**
   * Terminate the child process tree when it exceeds this wall-clock budget.
   * Rejection happens only after termination is confirmed, so callers cannot
   * release a materialization lock while the old process may still be writing.
   */
  timeoutMs?: number;
  /** Optional caller cancellation with the same confirmed-termination rule. */
  signal?: AbortSignal;
  /** Grace for each of SIGTERM and SIGKILL confirmation. Defaults to 500ms. */
  terminationGraceMs?: number;
  /**
   * Observe buffered stderr after the child exits. The stdout return contract
   * stays unchanged; observer failures never affect command completion.
   */
  onStderr?: (stderr: string) => void;
  /** Optional bytes written to the child stdin before it is closed. */
  input?: string | Buffer;
}

type VelaTerminationReason = 'abort' | 'timeout';

const DEFAULT_TERMINATION_GRACE_MS = 500;

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function commandTerminationError(
  reason: VelaTerminationReason,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Error {
  if (reason === 'abort') {
    const error = new Error('vela command aborted', {
      cause: signal?.reason,
    });
    error.name = 'AbortError';
    Object.assign(error, { code: 'ABORT_ERR' });
    return error;
  }
  const error = new Error(`vela command timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  Object.assign(error, { code: 'ETIMEDOUT' });
  return error;
}

function logCommandTermination(
  phase: 'completed' | 'failed' | 'scheduled' | 'unconfirmed',
  detail: {
    reason: VelaTerminationReason;
    timeoutMs?: number | undefined;
    childPid?: number | undefined;
    forcedPids?: number[] | undefined;
    remainingPids?: number[] | undefined;
    error?: unknown;
  },
): void {
  const fields = [
    `phase=${phase}`,
    `reason=${detail.reason}`,
    `timeoutMs=${detail.timeoutMs ?? 'none'}`,
    `childPid=${detail.childPid ?? 'unknown'}`,
    `forced=${detail.forcedPids?.length ?? 0}`,
    `remaining=${detail.remainingPids?.length ?? 0}`,
  ];
  if (detail.error != null) {
    fields.push(
      `error=${detail.error instanceof Error ? detail.error.name : 'unknown'}`,
    );
  }
  console.warn(`[od] vela_command_termination ${fields.join(' ')}`);
}

export function velaWorkspaceCommandOptions(
  workspaceId: string | null | undefined,
): VelaCommandOptions {
  const requestedWorkspaceId = workspaceId?.trim();
  return {
    configuredEnv: {
      VELA_INVOCATION_SOURCE: 'open-design',
      ...(requestedWorkspaceId
        ? { VELA_WORKSPACE_ID: requestedWorkspaceId }
        : {}),
    },
  };
}

function configuredAmrEnv(
  env: NodeJS.ProcessEnv,
  explicit: Record<string, string> = {},
): Record<string, string> {
  let stored: Record<string, string> = {};
  const dataDir = env.OD_DATA_DIR?.trim();
  if (dataDir) {
    try {
      stored = agentCliEnvForAgent(readAppConfigSync(dataDir).agentCliEnv, 'amr');
    } catch {
      // An unreadable app config must not hide a valid inherited or packaged
      // Vela installation; the command will use the normal resolver fallback.
    }
  }
  const inheritedVelaBin = env.VELA_BIN?.trim();
  return {
    ...(inheritedVelaBin ? { VELA_BIN: inheritedVelaBin } : {}),
    // Settings-backed agent CLI configuration follows the same precedence as
    // login and AMR launches: it overrides the inherited shell environment.
    ...stored,
    ...explicit,
  };
}

/**
 * Run the same resolved Vela binary and environment used by OpenDesign login
 * and AMR agent launches. Resource/team/collab adapters must use this instead
 * of spawning a PATH-only `vela` process, otherwise a packaged login can
 * succeed while the collaboration command uses a different or missing CLI.
 */
export function runVelaCommand(
  args: string[],
  options: VelaCommandOptions = {},
): Promise<string> {
  return runTokenToSeaCommand(args, options);
}

// Re-exported so the vela-facing name stays available to callers that already
// think in terms of vela commands; the implementation carries no dependencies.
export { isAbortedOperationError as isAbortedVelaCommandError };
