import { tokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';
import type { HubEventsSubscriber, HubEventsSubscriberOptions, HubWorkspaceEvent } from './hub-events-subscriber.js';

/** Persistent TokenToSea event cursors; every poll rechecks the member at the server. */
export function startTokenToSeaEventsSubscriber(workspaceId: string, options: HubEventsSubscriberOptions): HubEventsSubscriber {
  let stopped = false, connected = false, running = false, wasConnected = false, revoked = false, cursor = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const capabilities = ['workspace-directory-events-v1', 'workspace-member-events-v1'];
  const runtime = tokenToSeaRuntime();
  async function tick() {
    if (stopped || running || revoked) return;
    running = true;
    controller = new AbortController();
    try {
      await runtime.backgroundInWorkspace(workspaceId, async () => {
        const identityKey = runtime.identityKey();
        const page = await runtime.collaboration<{ cursor: number; events: Array<{ seq: number; type: string; payload: Record<string, unknown>; createdAt: string }> }>({ operation: 'events.list', workspaceId, after: cursor }, controller!.signal);
        if (stopped) return;
        if (!connected) {
          connected = true;
          options.onStateChange?.('connected', { identityKey });
          options.onConnect?.({ reconnect: wasConnected, workspaceId, identityKey, capabilities });
          if (wasConnected) options.onReconnect?.({ identityKey });
          wasConnected = true;
        }
        for (const event of page.events) {
          const common = { workspaceId, eventId: `tts:${workspaceId}:${event.seq}`, seq: event.seq, at: event.createdAt,
            ...(typeof event.payload.projectId === 'string' ? { projectId: event.payload.projectId } : {}),
            ...(typeof event.payload.resourceId === 'string' ? { resourceId: event.payload.resourceId } : {}),
            ...(typeof event.payload.version === 'number' ? { version: event.payload.version } : {}),
          };
          const notify = (type: HubWorkspaceEvent['type']) => options.onEvent({ ...common, type }, { identityKey });
          if (event.type === 'projects.changed') { notify('team-projects-changed'); notify('project-metadata-changed'); }
          if (event.type === 'comments.changed') notify('comment-changed');
          if (event.type === 'presence.changed') notify('presence-changed');
          if (event.type === 'resource.updated' || event.type === 'resource.removed') {
            notify('project-content-changed');
            const resourceStatus = event.type === 'resource.updated' ? 'shared' : 'retracted';
            const kind = typeof event.payload.kind === 'string' && event.payload.kind ? event.payload.kind : null;
            if (kind) options.onEvent({ ...common, type: 'team-resources-changed', resourceKind: kind, resourceStatus }, { identityKey });
            else {
              // Cloud builds that omit the kind: the resource may be a project
              // or a design system/plugin/skill, so refresh projects and every
              // other kind instead of guessing one.
              options.onEvent({ ...common, type: 'team-resources-changed', resourceKind: 'project', resourceStatus }, { identityKey });
              options.onEvent({ ...common, type: 'team-resources-changed', resourceStatus }, { identityKey });
            }
          }
          if (event.type === 'members.changed') { notify('workspace-members-changed'); options.onDirectoryEvent?.({ type: 'workspace-directory-changed', workspaceId, change: 'membership-updated', at: event.createdAt }, { identityKey }); }
          if (event.type === 'workspace.created') options.onDirectoryEvent?.({ type: 'workspace-directory-changed', workspaceId, change: 'created', at: event.createdAt }, { identityKey });
          cursor = event.seq;
        }
        cursor = Math.max(cursor, page.cursor);
      });
    } catch (error) {
      if (!stopped && connected) options.onStateChange?.('disconnected', {});
      connected = false;
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403) { revoked = true; options.onAccessRevoked?.({ workspaceId, reason: 'TokenToSea membership revoked' }); }
      else if (!stopped) options.onError?.(error);
    } finally {
      running = false;
      if (!stopped && !revoked) { timer = setTimeout(() => { void tick(); }, connected ? 2000 : 10_000); timer.unref(); }
    }
  }
  void tick();
  return {
    stop() { stopped = true; controller?.abort(); if (timer) clearTimeout(timer); if (connected) options.onStateChange?.('disconnected', {}); connected = false; },
    connected: () => connected,
    refreshEndpoint() { revoked = false; if (timer) clearTimeout(timer); void tick(); },
  };
}
