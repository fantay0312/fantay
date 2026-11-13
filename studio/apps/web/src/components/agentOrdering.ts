export function orderAgentsWithOpenDesignFirst<T extends { id: string }>(
  agents: readonly T[],
): T[] {
  const openDesignAgents: T[] = [];
  const otherAgents: T[] = [];
  for (const agent of agents) {
    if (agent.id === 'tokentosea') {
      openDesignAgents.push(agent);
    } else {
      otherAgents.push(agent);
    }
  }
  return [...openDesignAgents, ...otherAgents];
}
