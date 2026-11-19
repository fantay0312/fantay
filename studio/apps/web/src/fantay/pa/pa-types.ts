// SPDX-License-Identifier: AGPL-3.0-only
// Shared contracts for the Fantay (PA) workspace. Every PA unit builds against these types.
import type {
  PaAgentInput,
  PaArtifact,
  PaAttempt,
  PaCardEmbeddedAsset,
  PaChannel,
  PaChannelInbox,
  PaChannelInput,
  PaChannelLogin,
  PaChannelOutbox,
  PaChannelPairing,
  PaChannelSnapshot,
  PaCharacterPatch,
  PaCharacterView,
  PaChatSettingsPatch,
  PaChatView,
  PaControl,
  PaControlPatch,
  PaConversation,
  PaEmotion,
  PaFeishuRegistration,
  PaGroup,
  PaGroupInput,
  PaLorebook,
  PaLorebookInput,
  PaLorebookPatch,
  PaLorebookSummary,
  PaMemory,
  PaMemoryCandidate,
  PaMemoryInput,
  PaMessage,
  PaMessageSoul,
  PaModel,
  PaModelOption,
  PaNeedsReviewItem,
  PaOutputPage,
  PaPersona,
  PaPersonaInput,
  PaPersonaPatch,
  PaSnapshot,
  PaSoulLiveResponse,
  PaSoulLiveText,
  PaSoulSnapshot,
  PaSoulTrace,
  PaSoulTraceLore,
  PaSpeechItem,
  PaSpeechModel,
  PaSpeechPreview,
  PaSpeechPreviewInput,
  PaSpeechStatus,
  PaSpeechVoices,
  PaSprites,
  PaStateOp,
  PaStylePreset,
  PaStylePresetInput,
  PaStylePresetPatch,
  PaTask,
  PaTaskCardAnswer,
  PaTaskInput,
  PaVoice,
  PersonalAgent,
  Project,
} from '@open-design/contracts';
import type { useT } from '../../i18n';

export type TFn = ReturnType<typeof useT>;

// ---- transport ----
export type PaTransport = <T>(path?: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;

// ---- UI state ----
export type PaPlace = 'conversation' | 'activity' | 'tasks' | 'memory' | 'connections' | 'library';
export type PaActivityTab = 'activity' | 'goals' | 'routines';
export type PaTasksFilter = 'needs' | 'active' | 'ended' | 'deliverables';
export type PaMemoryFilter = 'all' | 'private' | 'agent' | 'group' | 'project';
export type PaLibraryTab = 'characters' | 'lorebooks' | 'personas' | 'presets';
export type PaRosterFilter = 'all' | 'chat' | 'work';
/** `soul` is the companion tab TA, `scene` is 此刻. */
export type PaInspectorTab = 'activity' | 'approvals' | 'profile' | 'soul' | 'scene' | 'memory';
export type PaProfileSection =
  | 'basic'
  | 'persona'
  | 'greeting'
  | 'examples'
  | 'lore'
  | 'style'
  | 'look'
  | 'sprites'
  | 'play'
  | 'work'
  | 'advanced';
export type PaModalState =
  | { kind: 'agent'; agentId: string | null; section?: PaProfileSection; template?: string }
  | { kind: 'group'; groupId: string | null }
  | {
      kind: 'memory';
      memoryId: string | null;
      preset?: {
        scope?: PaMemoryInput['scope'];
        scopeId?: string | null;
        agentId?: string | null;
        projectId?: string | null;
        groupId?: string | null;
        content?: string;
        kind?: PaMemoryInput['kind'];
        source?: string;
        sourceMessageId?: string;
      };
    }
  | { kind: 'amend'; taskId: string }
  | { kind: 'task'; taskId: string; output?: string /* attemptId: open on the output view */ }
  | { kind: 'reconcile'; taskId: string }
  | { kind: 'limits' }
  | { kind: 'channel'; channelId: string | null; connectionId?: string }
  /** `agentId`: import onto that existing character (用角色卡覆盖…). */
  | { kind: 'cardImport'; file?: File; agentId?: string }
  | { kind: 'lorebook'; lorebookId: string | null; entryId?: string; bindAgentId?: string }
  | { kind: 'persona'; personaId: string | null }
  | { kind: 'preset'; presetId: string | null }
  | { kind: 'appearance'; conversationId: string }
  | { kind: 'chatSettings'; conversationId: string }
  /** `messageId: null` previews the next turn. */
  | { kind: 'context'; conversationId: string; messageId: string | null };
export interface PaUiState {
  place: PaPlace;
  conversationId: string | null;
  /** Work mode. In the context value this is already resolved for the open conversation's mode. */
  inspectorOpen: boolean;
  /** The remembered open state for companion conversations. */
  inspectorOpenCompanion: boolean;
  inspectorTab: PaInspectorTab;
  inspectorWidth: number;
  /** Optional agent override inspected on the right (e.g. clicking a speaking member inside a group chat). */
  inspectorAgentId?: string | null;
  activityTab?: PaActivityTab;
  tasksFilter: PaTasksFilter | null; // null → automatic default
  memoryFilter: PaMemoryFilter;
  modal: PaModalState | null;
  rosterQuery: string;
  rosterFilter: PaRosterFilter;
  libraryTab: PaLibraryTab;
  libraryQuery: string;
  libraryTag: string | null;
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
  answerTaskCard(taskId: string, input: PaTaskCardAnswer): Promise<PaTask>;
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
  createChannelBinding(connectionId: string, input: PaChannelInput): Promise<PaChannel>;
  updateChannel(channel: PaChannel, input: PaChannelInput): Promise<PaChannel>;
  connectFeishu(channelId: string, body: { appId: string; appSecret: string; brand?: 'feishu' | 'lark' } | { localAppId: string }): Promise<void>;
  connectIm(channelId: string, fields: Record<string, string>): Promise<void>;
  startFeishuRegistration(channelId: string): Promise<PaFeishuRegistration>;
  readFeishuRegistration(channelId: string, signal?: AbortSignal): Promise<PaFeishuRegistration | null>;
  cancelFeishuRegistration(channelId: string): Promise<PaFeishuRegistration | null>;
  listLocalFeishuApps(): Promise<PaLocalFeishuApp[]>;
  pairChannel(channelId: string): Promise<PaChannelPairing>;
  startWeixinLogin(channelId: string): Promise<PaChannelLogin>; // POST /channels/:id/login
  pollWeixinLogin(channelId: string): Promise<PaChannelLogin>; // GET  /channels/:id/login
  submitWeixinPin(channelId: string, pin: string): Promise<PaChannelLogin>;
  connectChannel(channelId: string): Promise<void>;
  disconnectChannel(channelId: string, forget: boolean): Promise<void>;
  removeChannel(channelId: string): Promise<void>;
  answerApproval(inbox: PaChannelInbox, approved: boolean): Promise<void>; // {approved, revision}
  resolveOutbox(outbox: PaChannelOutbox, action: 'query' | 'delivered' | 'retry'): Promise<void>; // {action, revision}
  taskEvents(taskId: string): Promise<PaTaskEvent[]>;
  attemptOutput(attemptId: string, q: { offset: number; limit: number; q?: string }): Promise<PaOutputPage>;

  // ---- soul (routes under /api/pa/soul; pending keys from paPendingKey.soul*) ----
  /** POST /tasks with kind 'chat'. `requestId` is the composer's idempotent id. Kicks the poll. */
  sendChat(input: { conversationId: string; text: string; requestId: string; targetAgentIds?: string[]; replyTo?: string }): Promise<PaTask>;
  /** PUT /soul/characters/:agentId (revision from the soul snapshot when the card exists). */
  saveCharacter(agentId: string, patch: PaCharacterPatch): Promise<PaCharacterView>;
  removeCharacter(agentId: string, forgetMemories: boolean): Promise<void>;
  /** POST /soul/characters/import; `agentId` imports onto that existing agent and overwrites its card when it has one
   *  (`revision` is that card's revision, checked by the daemon when sent). */
  importCard(body: {
    card: unknown;
    fileName?: string;
    portrait?: { mime: string; data: string };
    model?: PaModel;
    agentId?: string;
    revision?: number;
    /** Stage 2: sprite asset ids by emotion (CHARX images saved through uploadAsset first). */
    sprites?: Partial<Record<PaEmotion, string>>;
  }): Promise<{
    agent: PersonalAgent;
    conversation: PaConversation;
    report: { needsReview: PaNeedsReviewItem[]; preservedKeys: string[] };
  }>;
  /** GET /soul/characters/:agentId/export (no re-read). */
  exportCard(agentId: string, includeQuarantined: boolean): Promise<Record<string, unknown>>;
  installStarter(id: string): Promise<{ conversation: PaConversation }>;
  /** POST /enterprise/org/sync: pulls the member directory and the library from the organization server now (admins). */
  syncOrg(): Promise<unknown>;
  /** GET /soul/lorebooks/:id (no pending key, no re-read). */
  loadLorebook(id: string): Promise<PaLorebook>;
  /** POST /soul/lorebooks, or PATCH /soul/lorebooks/:id with `existing`. */
  saveLorebook(input: PaLorebookInput | PaLorebookPatch, existing?: { id: string; revision: number }): Promise<PaLorebookSummary>;
  removeLorebook(book: { id: string; revision: number }): Promise<void>;
  importWorld(body: { world: unknown; name?: string; fileName?: string; agentId?: string }): Promise<{ lorebook: PaLorebookSummary; report: PaNeedsReviewItem[] }>;
  /** GET /soul/lorebooks/:id/export (no pending key, no re-read). */
  exportWorld(id: string): Promise<Record<string, unknown>>;
  /** POST /soul/lorebooks/test (no pending key, no re-read). `messages` newest first. */
  testLorebook(body: { lorebook?: PaLorebookInput; lorebookId?: string; messages: string[]; index?: number }): Promise<{ trace: PaSoulTraceLore[]; used: number; limit: number }>;
  savePersona(input: PaPersonaInput | PaPersonaPatch, existing?: PaPersona): Promise<PaPersona>;
  removePersona(persona: PaPersona): Promise<void>;
  savePreset(input: PaStylePresetInput | PaStylePresetPatch, existing?: PaStylePreset): Promise<PaStylePreset>;
  removePreset(preset: PaStylePreset): Promise<void>;
  /** PUT /soul/chats/:conversationId (revision from the soul snapshot when it is above 0). */
  saveChat(conversationId: string, patch: PaChatSettingsPatch): Promise<PaChatView>;
  applyStateOps(conversationId: string, ops: PaStateOp[]): Promise<PaChatView>;
  /** POST /soul/assets (no re-read). */
  uploadAsset(body: { mime: string; data: string }): Promise<{ id: string }>;
  editMessage(message: PaMessage, patch: { content?: string; hidden?: boolean }): Promise<PaMessage>;
  deleteMessage(message: PaMessage, forget: boolean): Promise<void>;
  selectVariant(rootId: string, choice: { messageId: string } | { greetingIndex: number }): Promise<void>;
  revealDraw(messageId: string): Promise<void>;
  /** Kicks the poll. */
  regenerate(conversationId: string, messageId: string): Promise<PaTask>;
  /** Kicks the poll. */
  continueChat(conversationId: string, options?: { agentId?: string; directive?: 'continue' | 'reachout' }): Promise<PaTask>;
  /** Kicks the poll. */
  roll(conversationId: string, body: { notation: string; label?: string; dc?: number; respond?: boolean }): Promise<void>;
  /** Kicks the poll. */
  draw(conversationId: string, body: { deckId: string; respond?: boolean }): Promise<void>;
  /** Kicks the poll. */
  eventAction(conversationId: string, action: 'draw' | 'accept' | 'skip' | 'stop', respond?: boolean): Promise<void>;
  branch(conversationId: string, messageId: string): Promise<PaConversation>;
  /** GET /soul/trace/:messageId (no pending key, no re-read). */
  loadTrace(messageId: string): Promise<PaSoulTrace | null>;
  /** POST /soul/chat/preview (no re-read). */
  previewTurn(conversationId: string, draft?: string, agentId?: string): Promise<PaSoulTrace>;

  // ---- soul, stage 2: live text and voice replies ----
  /** GET /soul/live (no pending key, no re-read). */
  readLive(conversationId: string, known?: { attemptId: string; seq: number }, signal?: AbortSignal): Promise<PaSoulLiveResponse>;
  /** GET /soul/speech/status (no pending key, no re-read). */
  speechStatus(): Promise<PaSpeechStatus>;
  /** GET /soul/speech/voices?model= (no pending key, no re-read). */
  speechVoices(model: string): Promise<PaSpeechVoices>;
  /** GET /soul/speech?conversationId= (no pending key, no re-read). */
  listSpeech(conversationId: string): Promise<PaSpeechItem[]>;
  /** POST /soul/speech under paPendingKey.soulSpeech(messageId); no snapshot re-read. */
  speak(messageId: string): Promise<PaSpeechItem>;
  /** POST /soul/speech/preview: a voice sample for the editor (no pending key, no re-read). */
  previewSpeech(input: PaSpeechPreviewInput): Promise<PaSpeechPreview>;
}
export interface PaData {
  snapshot: PaSnapshot | null;
  /** The paired soul snapshot; applied in the same tick as the main snapshot. Null until first read. In enterprise
   *  mode it holds the shared library and only the reading member's personas and chat settings. */
  soul: PaSoulSnapshot | null;
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
  workTasks: Map<string, PaTask>; // kind !== 'chat': the choke point for every work surface
  characters: Map<string, PaCharacterView>; // by agent id
  lorebooks: Map<string, PaLorebookSummary>;
  personas: Map<string, PaPersona>;
  defaultPersona: PaPersona | null;
  presets: Map<string, PaStylePreset>; // built-in (prompt locale of the UI) + user presets
  chats: Map<string, PaChatView>; // by conversation id; absent = defaults
  candidatesByMessage: Map<string, PaMemoryCandidate[]>; // pending candidates by sourceMessageId
  /** Enterprise mode: conversations belong to one member each, and the library is shared. */
  enterprise: boolean;
  /** May create and edit agents, group chats, characters, world books and style presets. Always true outside
   *  enterprise mode; there it is the admin's (or a member granted the library) and everyone else only reads. */
  canManageLibrary: boolean;
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
    opts?: { tasksFilter?: PaTasksFilter; memoryFilter?: PaMemoryFilter; activityTab?: PaActivityTab; libraryTab?: PaLibraryTab },
  ): void;
  setRosterFilter(f: PaRosterFilter): void;
  setLibrary(patch: { tab?: PaLibraryTab; query?: string; tag?: string | null }): void;
  /** Installs the starter when needed, then opens its conversation. */
  openStarter(id: string): Promise<void>;
  openTaskTurn(taskId: string): void;
  openModal(modal: PaModalState): void;
  closeModal(): void;
  /** Writes `inspectorOpenCompanion` while the open conversation is a companion chat, else `inspectorOpen`. */
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
  PaCardEmbeddedAsset,
  PaChannel,
  PaChannelInbox,
  PaChannelInput,
  PaChannelLogin,
  PaChannelOutbox,
  PaChannelPairing,
  PaChannelSnapshot,
  PaCharacterPatch,
  PaCharacterView,
  PaChatSettingsPatch,
  PaChatView,
  PaControl,
  PaControlPatch,
  PaConversation,
  PaEmotion,
  PaGroup,
  PaGroupInput,
  PaLorebook,
  PaLorebookInput,
  PaLorebookPatch,
  PaLorebookSummary,
  PaMemory,
  PaMemoryCandidate,
  PaMemoryInput,
  PaMessage,
  PaMessageSoul,
  PaModel,
  PaModelOption,
  PaNeedsReviewItem,
  PaOutputPage,
  PaPersona,
  PaPersonaInput,
  PaPersonaPatch,
  PaSnapshot,
  PaSoulLiveResponse,
  PaSoulLiveText,
  PaSoulSnapshot,
  PaSoulTrace,
  PaSoulTraceLore,
  PaSpeechItem,
  PaSpeechModel,
  PaSpeechPreview,
  PaSpeechPreviewInput,
  PaSpeechStatus,
  PaSpeechVoices,
  PaSprites,
  PaStateOp,
  PaStylePreset,
  PaStylePresetInput,
  PaStylePresetPatch,
  PaTask,
  PaTaskInput,
  PaVoice,
  PersonalAgent,
  Project,
};
