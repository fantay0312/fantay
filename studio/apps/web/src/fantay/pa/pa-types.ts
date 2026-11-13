// SPDX-License-Identifier: AGPL-3.0-only
// Shared contracts for the Fantay (PA) workspace. Every PA unit builds against these types.
import type {
  PaAgentInput,
  PaArtifact,
  PaAttempt,
  PaChannel,
  PaChannelInbox,
  PaChannelInput,
  PaChannelLogin,
  PaChannelOutbox,
  PaChannelPairing,
  PaChannelSnapshot,
  PaControl,
  PaControlPatch,
  PaConversation,
  PaGroup,
  PaGroupInput,
  PaMemory,
  PaMemoryInput,
  PaMessage,
  PaModelOption,
  PaOutputPage,
  PaSnapshot,
  PaTask,
  PaTaskInput,
  PersonalAgent,
  Project,
} from '@open-design/contracts';
import type { useT } from '../../i18n';

export type TFn = ReturnType<typeof useT>;

// ---- transport ----
export type PaTransport = <T>(path?: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;

// ---- UI state ----
export type PaPlace = 'conversation' | 'activity' | 'tasks' | 'memory' | 'connections';
export type PaActivityTab = 'activity' | 'goals' | 'routines';
export type PaTasksFilter = 'needs' | 'active' | 'ended' | 'deliverables';
export type PaMemoryFilter = 'all' | 'private' | 'agent' | 'group' | 'project';
export type PaInspectorTab = 'activity' | 'approvals' | 'profile';
export type PaModalState =
  | { kind: 'agent'; agentId: string | null }
  | { kind: 'group'; groupId: string | null }
  | { kind: 'memory'; memoryId: string | null; preset?: { scope: PaMemoryInput['scope']; scopeId: string | null } }
  | { kind: 'amend'; taskId: string }
  | { kind: 'task'; taskId: string; output?: string /* attemptId: open on the output view */ }
  | { kind: 'reconcile'; taskId: string }
  | { kind: 'limits' }
  | { kind: 'channel'; channelId: string | null };
export interface PaUiState {
  place: PaPlace;
  conversationId: string | null;
  inspectorOpen: boolean;
  inspectorTab: PaInspectorTab;
  inspectorWidth: number;
  /** Optional agent override inspected on the right (e.g. clicking a speaking member inside a group chat). */
  inspectorAgentId?: string | null;
  activityTab?: PaActivityTab;
  tasksFilter: PaTasksFilter | null; // null → automatic default
  memoryFilter: PaMemoryFilter;
  modal: PaModalState | null;
  rosterQuery: string;
  focusTurn: { taskId: string; nonce: number } | null;
}
export interface PaLayout {
  width: number;
  roster: 'full' | 'rail' | 'sheet';
  inspector: 'docked' | 'floating';
}

// ---- data ----
export type PaLoadState = 'loading' | 'ready' | 'offline';
export interface PaTaskEvent {
  sequence: number;
  id: string;
  kind: string;
  at: number;
  data: unknown;
}
export interface PaLocalFeishuApp {
  appId: string;
  label: string;
}
export interface PaActions {
  refresh(): Promise<void>;
  refreshModels(): Promise<void>; // GET /models
  sendTask(input: PaTaskInput): Promise<PaTask>; // POST /tasks
  createConversation(agentId: string): Promise<PaConversation>; // POST /conversations
  stopTask(taskId: string): Promise<void>; // POST /tasks/:id/cancel
  resumeTask(taskId: string): Promise<void>; // POST /tasks/:id/resume
  amendTask(taskId: string, content: string): Promise<void>; // POST /tasks/:id/amend {content, revision}
  /** POST /tasks/:id/reconcile. Without `confirmation` the daemon checks automatically; it throws 409 PA_RECOVERY_REQUIRED when it cannot. */
  reconcileTask(taskId: string, confirmation?: { note: string }): Promise<PaTask>;
  saveAgent(input: PaAgentInput, existing?: PersonalAgent): Promise<PersonalAgent>; // POST /agents | PATCH /agents/:id
  setAgentModel(agent: PersonalAgent, model: PersonalAgent['model']): Promise<PersonalAgent>; // PATCH /agents/:id
  cloneAgent(agentId: string): Promise<PersonalAgent>; // POST /agents/:id/clone
  setAgentEnabled(agent: PersonalAgent, enabled: boolean): Promise<void>;
  saveGroup(input: PaGroupInput, existing?: PaGroup): Promise<PaGroup>;
  saveMemory(input: PaMemoryInput, existing?: PaMemory): Promise<PaMemory>;
  deleteMemory(memoryId: string): Promise<void>; // DELETE /memories/:id
  resolveMemoryCandidate(id: string, revision: number, accept: boolean): Promise<void>;
  patchControl(patch: PaControlPatch): Promise<PaControl>; // PATCH /control
  createChannel(input: PaChannelInput): Promise<PaChannel>;
  updateChannel(channel: PaChannel, input: PaChannelInput): Promise<PaChannel>;
  connectFeishu(channelId: string, body: { appId: string; appSecret: string } | { localAppId: string }): Promise<void>;
  listLocalFeishuApps(): Promise<PaLocalFeishuApp[]>;
  pairChannel(channelId: string): Promise<PaChannelPairing>;
  startWeixinLogin(channelId: string): Promise<PaChannelLogin>; // POST /channels/:id/login
  pollWeixinLogin(channelId: string): Promise<PaChannelLogin>; // GET  /channels/:id/login
  submitWeixinPin(channelId: string, pin: string): Promise<PaChannelLogin>;
  connectChannel(channelId: string): Promise<void>;
  disconnectChannel(channelId: string, forget: boolean): Promise<void>;
  answerApproval(inbox: PaChannelInbox, approved: boolean): Promise<void>; // {approved, revision}
  resolveOutbox(outbox: PaChannelOutbox, action: 'query' | 'delivered' | 'retry'): Promise<void>; // {action, revision}
  taskEvents(taskId: string): Promise<PaTaskEvent[]>;
  attemptOutput(attemptId: string, q: { offset: number; limit: number; q?: string }): Promise<PaOutputPage>;
}
export interface PaData {
  snapshot: PaSnapshot | null;
  models: PaModelOption[];
  control: PaControl | null;
  channels: PaChannelSnapshot;
  load: PaLoadState;
  stale: { since: number; message: string } | null;
  pending: ReadonlySet<string>;
  actions: PaActions;
}

// ---- derived index (pa-model.buildIndex, memoised on data identity) ----
export type PaNeed =
  | { kind: 'approval'; inbox: PaChannelInbox; channel: PaChannel | null }
  | { kind: 'delivery'; outbox: PaChannelOutbox; channel: PaChannel | null }
  | { kind: 'task'; task: PaTask };
export interface PaIndex {
  agents: Map<string, PersonalAgent>;
  groups: Map<string, PaGroup>;
  groupByConversation: Map<string, PaGroup>;
  conversations: Map<string, PaConversation>;
  messages: Map<string, PaMessage>;
  messagesByConversation: Map<string, PaMessage[]>; // createdAt asc
  tasks: Map<string, PaTask>;
  tasksByConversation: Map<string, PaTask[]>; // createdAt asc
  attemptsByTask: Map<string, PaAttempt[]>; // startedAt asc
  artifactsByTask: Map<string, PaArtifact[]>;
  memories: Map<string, PaMemory>;
  memoryRefCount: Map<string, number>;
  models: Map<string, PaModelOption>; // key `${runtime}/${modelId}`
  channels: Map<string, PaChannel>;
  inbox: PaChannelInbox[];
  outbox: PaChannelOutbox[];
  fantay: PersonalAgent | null;
  directByAgent: Map<string, PaConversation[]>; // non-channel, most recent activity first
  channelConversations: PaConversation[];
  lastActivity: Map<string, number>; // conversationId → max(message, task.updatedAt, conv.updatedAt)
  needs: PaNeed[];
}

export type PaSubject = { kind: 'agent'; agent: PersonalAgent } | { kind: 'group'; group: PaGroup };

export type PaPreview =
  | { kind: 'text'; text: string; sender: 'owner' | string }
  | { kind: 'working'; agentId: string }
  | { kind: 'queued' }
  | { kind: 'needs' }
  | { kind: 'failed'; error: string }
  | { kind: 'empty' };

export interface PaTurn {
  key: string;
  task: PaTask | null;
  messages: PaMessage[];
  attempts: PaAttempt[];
  artifacts: PaArtifact[];
  startedAt: number;
}

export type PaPhase = 'respond' | 'produce' | 'review';
export type PaWorkLine =
  | { kind: 'queued'; reason: 'conversation' | 'concurrency' | 'none'; max: number | null }
  | { kind: 'step'; agentId: string; phase: PaPhase; step: number; total: number; nextAgentId: string | null; startedAt: number }
  | { kind: 'stopping'; unknown: boolean };

export type PaResumeBlock = 'revoked' | 'unconfirmed' | 'running' | 'cap';
export type PaWaitKey =
  | 'unconfirmed'
  | 'recovered'
  | 'paused'
  | 'device'
  | 'login'
  | 'budget'
  | 'review'
  | 'amended'
  | 'revoked'
  | 'memory'
  | 'other';
export type PaWaitAction =
  | 'reconcile'
  | 'resume'
  | 'resumeFantay'
  | 'startAgain'
  | 'stop'
  | 'amend'
  | 'continueReview'
  | 'modelSettings'
  | 'openAgent';
export interface PaWaitInfo {
  key: PaWaitKey;
  /** Verbatim daemon text used as body (review issues, revoked reason, other). */
  reasonText: string | null;
  actions: PaWaitAction[];
}

export type PaAgentStatusTone = 'muted' | 'warning' | 'running' | 'idle' | 'done';
export interface PaAgentStatus {
  tone: PaAgentStatusTone;
  key: string;
  vars: Record<string, string | number>;
}

// ---- composer drafts ----
export interface PaComposerDraft {
  text: string;
  localOnly?: boolean;
  completionCriterion?: string | undefined;
  sandbox?: 'local' | 'worker' | undefined;
  replyTo: string | null;
  project: boolean;
  projectName: string;
  request: { id: string; fingerprint: string } | null;
}
/** A small external store (one per workspace, stable identity), so a keystroke re-renders only the components that
 *  read a draft (`usePaDraft`, `usePaFocusNonce` in pa-context), never the whole workspace. */
export interface PaDrafts {
  /** The current draft (read from the store, so it is fresh even inside an older callback). The same object until
   *  that draft changes. */
  get(conversationId: string): PaComposerDraft;
  set(conversationId: string, patch: Partial<PaComposerDraft>): void;
  /** Change notification for useSyncExternalStore; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The focus-request counter: `nav.fillComposer` bumps it and the composer focuses on each new value. */
  focusNonce(): number;
  requestFocus(): void;
}

// ---- navigation ----
export interface PaNav {
  openConversation(conversationId: string): void;
  openAgent(agentId: string): Promise<void>; // most recent direct conversation, else creates one
  newConversation(agentId: string): Promise<void>;
  openPlace(
    place: Exclude<PaPlace, 'conversation'>,
    opts?: { tasksFilter?: PaTasksFilter; memoryFilter?: PaMemoryFilter; activityTab?: PaActivityTab },
  ): void;
  openTaskTurn(taskId: string): void;
  openModal(modal: PaModalState): void;
  closeModal(): void;
  setInspector(open: boolean, tab?: PaInspectorTab): void;
  inspectAgent(agentId: string, opts?: { toggle?: boolean; tab?: PaInspectorTab }): void;
  clearInspectorAgent(): void;
  setInspectorWidth(px: number): void;
  setTasksFilter(f: PaTasksFilter): void;
  setMemoryFilter(f: PaMemoryFilter): void;
  setRosterQuery(q: string): void;
  fillComposer(conversationId: string, draft: Partial<PaComposerDraft>): void; // opens the conversation, bumps focusNonce
  /** Opens the roster Sheet in `sheet` layout. No-op otherwise. */
  openRosterSheet(): void;
}

// ---- context ----
export interface PaContextValue {
  data: PaData;
  index: PaIndex;
  ui: PaUiState;
  nav: PaNav;
  drafts: PaDrafts;
  layout: PaLayout;
  projects: readonly Project[];
  onOpenProject: (id: string, file?: string) => unknown;
  now: number; // refreshed every 30 s for relative times
}

export type {
  PaAgentInput,
  PaArtifact,
  PaAttempt,
  PaChannel,
  PaChannelInbox,
  PaChannelInput,
  PaChannelLogin,
  PaChannelOutbox,
  PaChannelPairing,
  PaChannelSnapshot,
  PaControl,
  PaControlPatch,
  PaConversation,
  PaGroup,
  PaGroupInput,
  PaMemory,
  PaMemoryInput,
  PaMessage,
  PaModelOption,
  PaOutputPage,
  PaSnapshot,
  PaTask,
  PaTaskInput,
  PersonalAgent,
  Project,
};
