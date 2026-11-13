import type { AgentInfo, AppConfig } from '../types';

const HIDDEN_LOCAL_CLI_AGENT_IDS = new Set(['byok', 'byok-opencode']);

export function isVisibleLocalCliAgent(agent: Pick<AgentInfo, 'id'>): boolean {
  return !HIDDEN_LOCAL_CLI_AGENT_IDS.has(agent.id);
}

/**
 * Whether a detected CLI is switched on in Settings ▸ 本机 CLI. Detecting a CLI no longer offers it in the
 * pickers; the owner turns each one on. The selected CLI always counts as on, so the one in use never drops out
 * of its own picker, and a config that never chose (`enabledAgents` absent) starts with only that one.
 */
export function isAgentEnabled(config: Pick<AppConfig, 'agentId' | 'enabledAgents'>, agentId: string): boolean {
  return agentId === config.agentId || (config.enabledAgents?.includes(agentId) ?? false);
}

/** The enabled list with `agentId` switched on or off; seeds from the selected CLI the first time. */
export function withAgentEnabled(
  config: Pick<AppConfig, 'agentId' | 'enabledAgents'>,
  agentId: string,
  enabled: boolean,
): string[] {
  const current = new Set(config.enabledAgents ?? (config.agentId ? [config.agentId] : []));
  if (enabled) current.add(agentId);
  else current.delete(agentId);
  return [...current];
}

/**
 * How many detected agents the picker will actually present as usable.
 *
 * Counting the raw detection list instead would include agents that are
 * deliberately hidden from the UI, so a rescan could announce more CLIs than
 * the list beneath it ever renders — "3 available" above a list of two.
 */
export function availableVisibleAgentCount(agents: AgentInfo[]): number {
  return agents.filter((agent) => isVisibleLocalCliAgent(agent) && agent.available)
    .length;
}

export function deepSeekHarnessNeedsSetup(agent: AgentInfo): boolean {
  return (
    agent.id === 'deepseek-harness' &&
    !agent.available &&
    Boolean(agent.path) &&
    Boolean(
      agent.diagnostics?.some(
        (diagnostic) => diagnostic.reason === 'runtime-profile-incompatible',
      ),
    )
  );
}
