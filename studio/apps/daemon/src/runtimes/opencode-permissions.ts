import { agentCapabilities } from './capabilities.js';
import type { RuntimeAgentDef } from './types.js';

export const OPENCODE_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';
export const OPENCODE_WORKSPACE_DIR_FLAG = '--dir';
export const OPENCODE_THINKING_FLAG = '--thinking';

/**
 * Probe metadata shared by every `opencode run` runtime. The name predates the
 * thinking flag; it now carries every optional `run` flag read from `--help`.
 *
 * `versionProbeTimeoutMs` is the cold-start budget for the 143MB single-file
 * binary: its first spawn after boot/update routinely exceeds the 3s default,
 * and a timed-out probe silently disabled the live-delta plugin (and with it
 * all streamed reasoning). Detection applies the same budget to `run --help`,
 * the first spawn of a launch.
 */
export const OPENCODE_PERMISSION_CAPABILITY = {
  helpArgs: ['run', '--help'],
  capabilityFlags: {
    [OPENCODE_SKIP_PERMISSIONS_FLAG]: 'skipPermissions',
    [OPENCODE_THINKING_FLAG]: 'thinking',
  },
  versionProbeTimeoutMs: 15_000,
} satisfies Pick<RuntimeAgentDef, 'helpArgs' | 'capabilityFlags' | 'versionProbeTimeoutMs'>;

export function appendOpenCodePermissionBypass(args: string[], agentId: string): void {
  if (agentCapabilities.get(agentId)?.skipPermissions) {
    args.push(OPENCODE_SKIP_PERMISSIONS_FLAG);
  }
}

/**
 * Ask `opencode run --format json` to emit completed `reasoning` parts.
 *
 * OpenCode's JSON writer drops every reasoning part unless `--thinking` is set
 * (`thinking ?? false` outside `--mini`, verified in 1.18.18). The live-delta
 * plugin streams reasoning on its own, but whenever it is inactive (unknown
 * version, `--pure`, older CLI) the turn showed no thinking at all. With the
 * flag, completed parts always arrive and `OpenCodeTextEvents.complete()`
 * appends only the suffix the plugin has not streamed, so both sources
 * together never repeat text.
 *
 * The flag is sent only once the CLI's `--help` advertises it, so an older
 * user-installed build never sees an unknown flag.
 */
export function appendOpenCodeThinking(args: string[], agentId: string): void {
  if (agentCapabilities.get(agentId)?.thinking === true) {
    args.push(OPENCODE_THINKING_FLAG);
  }
}

/**
 * Pin OpenCode's workspace to the resolved project directory.
 *
 * OpenCode does not treat its process cwd as the project: it walks up to the
 * nearest enclosing git root and adopts THAT as the worktree (verified with
 * `opencode debug scrap`, whose every registered project is a git root). A
 * managed project directory is not a git repository, and a development install
 * keeps the daemon data directory under the repository root — so OpenCode walks
 * past the project and adopts the whole Open Design checkout.
 *
 * The consequences are all silent: the agent names the repository root as its
 * workspace and writes the deliverable there, the project directory stays
 * empty, `snapshotProjectArtifactsAsync(cwd)` sees nothing, and the Run reports
 * `no_artifact`. `permission.external_directory` cannot catch it either — once
 * the repository is the worktree, writing inside it is an in-project write.
 *
 * Sent unconditionally, matching the earlier BYOK OpenCode definition that
 * carried this workaround. Gating it on the `--help` capability probe would
 * turn a missing flag back into the silent data-loss bug; an OpenCode build
 * without `--dir` should fail loudly at spawn instead.
 */
export function appendOpenCodeWorkspaceDir(
  args: string[],
  cwd: string | null | undefined,
): void {
  if (typeof cwd !== 'string' || cwd.length === 0) return;
  args.push(OPENCODE_WORKSPACE_DIR_FLAG, cwd);
}
