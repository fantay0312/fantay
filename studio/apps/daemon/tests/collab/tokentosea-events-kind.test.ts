import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureTokenToSeaRuntime } from '../../src/integrations/tokentosea-runtime.js';
import { startTokenToSeaEventsSubscriber } from '../../src/collab/tokentosea-events.js';

afterEach(() => configureTokenToSeaRuntime(undefined));

function runtimeWith(events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>) {
  let served = false;
  configureTokenToSeaRuntime({
    identityKey: () => 'identity',
    backgroundInWorkspace: async (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
    collaboration: async () => {
      const page = { cursor: served ? events.length : 0, events: served ? [] : events.map((event) => ({ ...event, createdAt: '2026-11-09T00:00:00.000Z' })) };
      served = true;
      return page;
    },
  } as never);
}

async function collect(events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>) {
  runtimeWith(events);
  const seen: Array<Record<string, unknown>> = [];
  const subscriber = startTokenToSeaEventsSubscriber('ws-1', { onEvent: (event: unknown) => seen.push(event as Record<string, unknown>) } as never);
  await vi.waitFor(() => expect(seen.some((event) => event.type === 'team-resources-changed')).toBe(true));
  subscriber.stop();
  return seen.filter((event) => event.type === 'team-resources-changed');
}

describe('TokenToSea resource events', () => {
  it('routes a resource event to the kind the cloud names', async () => {
    const events = await collect([{ seq: 1, type: 'resource.removed', payload: { resourceId: 'plugin-1', kind: 'plugin' } }]);
    expect(events).toEqual([expect.objectContaining({ resourceKind: 'plugin', resourceStatus: 'retracted', resourceId: 'plugin-1' })]);
  });

  it('refreshes projects and every other kind when the cloud omits the kind', async () => {
    // Deployed cloud builds still emit kindless resource.removed events; a
    // retracted plugin must not be treated as a project only.
    const events = await collect([{ seq: 1, type: 'resource.removed', payload: { resourceId: 'plugin-1' } }]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ resourceKind: 'project', resourceStatus: 'retracted', resourceId: 'plugin-1' });
    expect(events[1]).toMatchObject({ resourceStatus: 'retracted', resourceId: 'plugin-1' });
    expect(events[1]).not.toHaveProperty('resourceKind');
  });
});
