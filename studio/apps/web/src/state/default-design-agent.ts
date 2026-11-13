/** A missing local choice must not silently opt the user into an upstream cloud account. */
export function defaultDesignAgent<T extends { id: string; available: boolean }>(agents: readonly T[]): T | undefined {
  return agents.find(agent => agent.available && ['deepseek', 'dsh'].includes(agent.id))
    ?? agents.find(agent => agent.available && agent.id !== 'tokentosea');
}
