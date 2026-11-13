import type { RuntimeAgentDef } from './types.js';

/** Installation policy, checked before discovery as well as execution. */
export function runtimeDisabledReason(
  def: Pick<RuntimeAgentDef, 'id' | 'streamFormat'>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const disabled = new Set((env.OD_DISABLED_AGENTS ?? '').split(',').map(id => id.trim()).filter(Boolean));
  if (disabled.has(def.id) || (disabled.has('claude') && def.streamFormat === 'claude-stream-json')) {
    return `The ${def.id} agent is disabled by this installation's execution policy.`;
  }
  return null;
}

export function assertRuntimeEnabled(def: Pick<RuntimeAgentDef, 'id' | 'streamFormat'>): void {
  const reason = runtimeDisabledReason(def);
  if (reason) throw Object.assign(new Error(reason), {code:'AGENT_DISABLED'});
}

/** Keep the CLI selectable without starting it for automatic discovery. */
export function skipRuntimeProbe(def: Pick<RuntimeAgentDef, 'id' | 'streamFormat'>): boolean {
  const skipped = new Set((process.env.OD_SKIP_AGENT_PROBES ?? '').split(',').map(id=>id.trim()));
  return skipped.has(def.id) || (skipped.has('claude') && def.streamFormat === 'claude-stream-json');
}

export function preferredAvailableAgent<T extends {id: string; available: boolean}>(agents: T[]): T | undefined {
  const preferred = process.env.OD_PREFERRED_AGENT?.trim();
  return preferred ? agents.find(agent => agent.id === preferred && agent.available) : agents.find(agent => agent.available);
}
