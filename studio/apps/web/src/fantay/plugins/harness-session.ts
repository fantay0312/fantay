// SPDX-License-Identifier: AGPL-3.0-only
// The DeepSeek Harness session props, answered from Fantay's conversations.
//
// A Harness slot component learns about the agent through hooks the host passes as props:
// `useSessionStatus`, `useSessions`, `useSession` and the `sessionId` it is bound to. In Fantay a
// Harness "session" is a conversation of the open project, read from the chat-to-shell bridge
// (`shell/project-bridge.ts`): a conversation is `running` while its agent run is in flight. The value
// shapes follow the Harness contracts (`SessionStatus`, `SessionListState`, `SessionSnapshot`), so a
// plugin written against them reads real state here. With no project open there are no sessions.
import type { Conversation } from '../../types';
import { hasConversationActivity } from '../../utils/conversationActivity';
import { useActiveProjectSession, type FantayProjectSession } from '../shell/project-bridge';
import { conversationStatusTone, isConversationUnread } from '../shell/sidebar/sidebar-model';

/** Harness `SessionStatus`: what the UI knows about one session right now. */
export interface HarnessSessionStatus {
  readonly running: boolean | undefined;
  /** Fantay raises its own question forms inside the chat, so nothing is ever pending here. */
  readonly pendingInteraction: undefined;
  readonly completionUnread: boolean;
}

/** Harness `SessionSummary`: one row of the session list. */
export interface HarnessSessionSummary {
  readonly agentAvailable: boolean;
  readonly sessionId: string;
  readonly updatedAt: number;
  readonly running: boolean;
  readonly blank: boolean;
}

/** Harness `SessionListState`. */
export interface HarnessSessionListState {
  readonly ids: readonly string[];
  readonly byId: Readonly<Record<string, HarnessSessionSummary>>;
  readonly phase: 'pending' | 'ready';
  readonly projectionsBySession: Readonly<Record<string, never>>;
}

/** Harness `SessionSnapshot`: lifecycle and control state of the bound session. */
export interface HarnessSessionSnapshot {
  readonly sessionId: string;
  readonly pendingSubmissions: readonly never[];
  readonly running: boolean;
  readonly subagent: null;
  readonly removed: boolean;
  readonly openState: 'cold' | 'open';
  readonly openError: null;
  readonly hasMore: boolean;
  readonly historyWasPartial: boolean;
  readonly loadingOlder: boolean;
  readonly historyLoadStatus: 'idle';
  readonly promptError: null;
  readonly blank: boolean;
  readonly lastAgentError: null;
  readonly promptAttempted: boolean;
  readonly awaitingFirstTurn: boolean;
}

/** Harness `InputState` of an untouched composer. Fantay does not share its composer draft with plugins. */
export const HARNESS_EMPTY_INPUT = Object.freeze({
  draft: '',
  attachmentIds: Object.freeze([]),
  draftRev: 0,
  phase: 'plain',
  occurrences: Object.freeze([]),
  queue: Object.freeze([]),
});

/** A Harness selector hook: the whole snapshot, or what `selector` picks from it. */
export type HarnessSelectorHook<T> = <R = T>(selector?: (snapshot: T) => R) => R;

interface HarnessModel {
  status: ReadonlyMap<string, HarnessSessionStatus>;
  list: HarnessSessionListState;
  snapshots: ReadonlyMap<string, HarnessSessionSnapshot>;
}

const NO_SESSIONS: HarnessModel = {
  status: new Map(),
  list: { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} },
  snapshots: new Map(),
};

function snapshotOf(sessionId: string, conversation: Conversation | null, running: boolean, blank: boolean): HarnessSessionSnapshot {
  return {
    sessionId,
    pendingSubmissions: [],
    running,
    subagent: null,
    removed: false,
    openState: conversation ? 'open' : 'cold',
    openError: null,
    hasMore: false,
    historyWasPartial: false,
    loadingOlder: false,
    historyLoadStatus: 'idle',
    promptError: null,
    blank,
    lastAgentError: null,
    promptAttempted: !blank,
    awaitingFirstTurn: false,
  };
}

// One model per published bridge session, so every hook hands back the same snapshot objects until
// the conversations actually change.
const models = new WeakMap<FantayProjectSession, HarnessModel>();

function modelOf(session: FantayProjectSession | null): HarnessModel {
  if (!session) return NO_SESSIONS;
  const cached = models.get(session);
  if (cached) return cached;
  const runningIds = new Set(session.runningConversationIds);
  const status = new Map<string, HarnessSessionStatus>();
  const snapshots = new Map<string, HarnessSessionSnapshot>();
  const byId: Record<string, HarnessSessionSummary> = {};
  const conversations = [...session.conversations].sort((left, right) => right.updatedAt - left.updatedAt);
  for (const conversation of conversations) {
    const { id } = conversation;
    const running = conversationStatusTone(conversation, runningIds) === 'running';
    const blank = !hasConversationActivity(conversation, runningIds);
    status.set(id, { running, pendingInteraction: undefined, completionUnread: !running && isConversationUnread(conversation) });
    snapshots.set(id, snapshotOf(id, conversation, running, blank));
    byId[id] = { agentAvailable: running, sessionId: id, updatedAt: conversation.updatedAt, running, blank };
  }
  const model: HarnessModel = {
    status,
    snapshots,
    list: { ids: conversations.map(conversation => conversation.id), byId, phase: 'ready', projectionsBySession: {} },
  };
  models.set(session, model);
  return model;
}

/** Harness `useSessionStatus`: status by session id. */
export const useHarnessSessionStatus: HarnessSelectorHook<ReadonlyMap<string, HarnessSessionStatus>> = (selector) => {
  const { status } = modelOf(useActiveProjectSession());
  return (selector ? selector(status) : status) as never;
};

/** Harness `useSessions`: the session list of the open project. */
export const useHarnessSessions: HarnessSelectorHook<HarnessSessionListState> = (selector) => {
  const { list } = modelOf(useActiveProjectSession());
  return (selector ? selector(list) : list) as never;
};

const sessionHooks = new Map<string, HarnessSelectorHook<HarnessSessionSnapshot>>();
const coldSnapshots = new Map<string, HarnessSessionSnapshot>();

/** Harness `useSession` bound to one session id. The hook identity is stable per id, as a hook's has to be. */
function sessionHook(sessionId: string): HarnessSelectorHook<HarnessSessionSnapshot> {
  let hook = sessionHooks.get(sessionId);
  if (!hook) {
    hook = (selector) => {
      const model = modelOf(useActiveProjectSession());
      let snapshot = model.snapshots.get(sessionId) ?? coldSnapshots.get(sessionId);
      if (!snapshot) {
        snapshot = snapshotOf(sessionId, null, false, true);
        coldSnapshots.set(sessionId, snapshot);
      }
      return (selector ? selector(snapshot) : snapshot) as never;
    };
    sessionHooks.set(sessionId, hook);
  }
  return hook;
}

/**
 * Harness `useSession` where no session is bound: every read is `undefined`. It still subscribes, so
 * a component keeps the same hook order when a session is bound to it later.
 */
const useNoSession = (() => {
  useActiveProjectSession();
  return undefined;
}) as unknown as HarnessSelectorHook<HarnessSessionSnapshot>;

/** The standard props every Harness slot component receives. */
export const HARNESS_ROOT_PROPS = Object.freeze({
  useSessions: useHarnessSessions,
  useSessionStatus: useHarnessSessionStatus,
});

/** Root props plus the ones bound to `sessionId`; with no session the id and its snapshot are absent. */
export function harnessSessionProps(sessionId: string | null | undefined) {
  return {
    ...HARNESS_ROOT_PROPS,
    sessionId: sessionId ?? undefined,
    useSession: sessionId ? sessionHook(sessionId) : useNoSession,
  };
}

/** The Harness snapshot of one conversation, read during render (the owner prop `session` of composer entries). */
export function useHarnessSessionSnapshot(sessionId: string | null | undefined): HarnessSessionSnapshot | undefined {
  const model = modelOf(useActiveProjectSession());
  return sessionId ? model.snapshots.get(sessionId) : undefined;
}
