import { useEffect, useRef, type ReactNode } from 'react';
import type { RecoveryActionBlockReason } from '../../runtime/chat/recovery-gating';
import { useT } from '../../i18n';
import { Icon } from '../Icon';
import { ChatPane } from '../ChatPane';
import type {
  AgentInfo,
  AppConfig,
  ChatAttachment,
  ChatCommentAttachment,
  ChatMessage,
  ChatMessageFeedbackChange,
  Conversation,
  ProjectFile,
} from '../../types';
import {
  resolveEffectiveChatRuntimeAgentId,
  type ChatSessionMode,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import type { ChatSendMeta } from '../ChatComposer';
import { useConversationChat } from './useConversationChat';
import styles from './SideChatTab.module.css';

export interface ActiveConversationChatState {
  conversationId: string;
  messages: ChatMessage[];
  streaming: boolean;
  loading?: boolean;
  sendDisabled?: boolean;
  queuedItems?: Array<{
    id: string;
    prompt: string;
    attachments?: ChatAttachment[];
    commentAttachments?: ChatCommentAttachment[];
  }>;
  error: string | null;
  errorSourceAssistantId?: string | null;
  onSend: (
    prompt: string,
    attachments: ChatAttachment[],
    commentAttachments: ChatCommentAttachment[],
    meta?: ChatSendMeta,
  ) => void;
  onRetry?: (assistantMessage: ChatMessage) => void;
  recoveryActionsBlockedReason?: RecoveryActionBlockReason | null;
  retryPendingAssistantId?: string | null;
  supersededErrorAssistantIds?: readonly string[];
  onStop: () => void;
  onRemoveQueuedSend?: (id: string) => void;
  // Editing a queued send replaces its full payload (prompt + attachments +
  // comment attachments + meta), matching ChatPane's QueuedSendUpdate, not just
  // the prompt string. Structural shape kept inline so this tab stays decoupled
  // from ChatPane's private interface.
  onUpdateQueuedSend?: (
    id: string,
    update: {
      prompt: string;
      attachments: ChatAttachment[];
      commentAttachments: ChatCommentAttachment[];
      meta?: ChatSendMeta;
    },
  ) => void;
  onReorderQueuedSends?: (orderedIds: string[]) => void;
  /** B11 「引导对话」: send this queued item now, stopping the turn in flight
   *  first when there is one. One button, one handler (ruling 2026-09-08). */
  onSendQueuedNow?: (id: string) => void;
  steerBlockedReason?: string | null;
  onAssistantFeedback?: (
    assistantMessage: ChatMessage,
    change: ChatMessageFeedbackChange,
  ) => void;
}

interface Props {
  promptRequest?: { id: string; projectId: string; conversationId: string; prompt: string } | null;
  onPromptRequestSettled?: (id: string, accepted: boolean) => void;
  onActivityChange?: (active: boolean) => void;
  hideContextBanner?: boolean;
  inlineComposer?: boolean;
  composerPlaceholder?: string;
  composerFooterAccessory?: ReactNode;
  designSystemPicker?: ReactNode;
  editorAppearance?: boolean;
  externalStop?: number;
  onStateChange?: (state:{messages:ChatMessage[];streaming:boolean;error:string|null})=>void;
  skillId?: string;
  projectId: string;
  /** The conversation this side chat is bound to (the `chat:<id>` tab id). */
  conversationId: string;
  /** Live app config + agent map + locale, threaded from ProjectView so the
   *  side chat runs against the same agent selection as the primary chat. */
  config: AppConfig;
  agentsById: Map<string, AgentInfo>;
  locale: string;
  /** The caller's current workspace identity, forwarded to `streamViaDaemon`
   *  so a side-chat send carries the same `x-od-workspace-*` headers the
   *  primary chat loop sends — otherwise a team-bound project's side chat
   *  401s against the daemon's workspace mutation gate. */
  workspaceContext?: WorkspaceCollabContext | null;
  /** Project files for the composer's @-mention picker and produced-file chips. */
  projectFiles: ProjectFile[];
  projectFileNames?: Set<string>;
  /** Daemon-resolved on-disk working directory of the project — positive-proof
   *  anchor for chat file-link routing (see AssistantMessage). */
  projectResolvedDir?: string | null;
  /** Conversation list + selection callbacks, shared with the header menu so a
   *  side chat is just another conversation the user can browse/switch. */
  conversations: Conversation[];
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onRenameConversation?: (id: string, title: string) => void;
  onSessionModeChange?: (id: string, mode: ChatSessionMode) => void;
  onExecutionPermissionSaved?: (id: string, permission: Conversation['executionPermission']) => void;
  selectedAgentBaseId?: string | null;
  onNewConversation?: () => void;
  /** Live ProjectView state for the primary conversation when this tab mirrors it. */
  activeConversationChat?: ActiveConversationChatState;
  onSwitchConversationToCloud?: (conversationId: string, message: ChatMessage) => void;
  recoveryActionsBlockedReason?: RecoveryActionBlockReason | null;
  /** Forward produced-file / tool-card open requests to the workspace. */
  onRequestOpenFile?: (name: string) => void;
}

// A ChatPane mounted as a workspace tab, bound to a single (usually
// context-seeded) conversation. Keyed by `${projectId}:${conversationId}` at
// the call site so switching the bound conversation fully resets composer and
// scroll state.
export function SideChatTab({
  promptRequest,
  onPromptRequestSettled,
  onActivityChange,
  hideContextBanner = false,
  inlineComposer,
  composerPlaceholder,
  composerFooterAccessory,
  designSystemPicker,
  editorAppearance = false,
  externalStop,
  onStateChange,
  skillId,
  projectId,
  conversationId,
  config,
  agentsById,
  locale,
  workspaceContext,
  projectFiles,
  projectFileNames,
  projectResolvedDir,
  conversations,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onSessionModeChange,
  onExecutionPermissionSaved,
  selectedAgentBaseId,
  onNewConversation,
  activeConversationChat,
  onSwitchConversationToCloud,
  recoveryActionsBlockedReason = null,
  onRequestOpenFile,
}: Props) {
  const t = useT();
  const activeConversation =
    conversations.find((conversation) => conversation.id === conversationId) ?? null;
  const sessionMode = activeConversation?.sessionMode ?? 'design';
  const chat = useConversationChat(projectId, conversationId, {
    config,
    agentsById,
    locale,
    sessionMode,
    executionPermission: activeConversation?.executionPermission ?? null,
    selectedAgentBaseId: selectedAgentBaseId ?? null,
    ...(skillId ? { skillId } : {}),
    workspaceContext,
  });
  const controlledChat =
    activeConversationChat?.conversationId === conversationId
      ? activeConversationChat
      : null;
  const handledRequests = useRef(new Set<string>());
  const activeRun = (controlledChat?.messages ?? chat.messages).some(message => message.role === 'assistant' && (message.runStatus === 'queued' || message.runStatus === 'running'));
  const lastNativeSync=useRef(0);
  useEffect(()=>{if(!onStateChange)return;const timer=setTimeout(()=>{lastNativeSync.current=Date.now();onStateChange({messages:controlledChat?.messages??chat.messages,streaming:controlledChat?.streaming??chat.streaming,error:controlledChat?controlledChat.error:chat.error});},Math.max(0,200-(Date.now()-lastNativeSync.current)));return()=>clearTimeout(timer);},[onStateChange,controlledChat,chat.messages,chat.streaming,chat.error]);
  useEffect(()=>{if(externalStop)chat.onStop();},[externalStop,chat.onStop]);
  useEffect(() => {
    onActivityChange?.((controlledChat?.streaming ?? chat.streaming) || activeRun);
  }, [controlledChat?.streaming, chat.streaming, activeRun, onActivityChange]);
  useEffect(() => {
    if (!promptRequest || handledRequests.current.has(promptRequest.id)
      || promptRequest.projectId !== projectId || promptRequest.conversationId !== conversationId
      || chat.loading || chat.streaming) return;
    if (controlledChat || chat.sendDisabled || activeRun) {
      handledRequests.current.add(promptRequest.id);
      onPromptRequestSettled?.(promptRequest.id, false);
      return;
    }
    const accepted = chat.onSend(promptRequest.prompt, [], []);
    handledRequests.current.add(promptRequest.id);
    onPromptRequestSettled?.(promptRequest.id, accepted);
  }, [promptRequest, projectId, conversationId, controlledChat, chat.loading, chat.streaming, chat.sendDisabled, chat.onSend, onPromptRequestSettled, activeRun]);
  const recoveryBlock = controlledChat?.recoveryActionsBlockedReason
    ?? recoveryActionsBlockedReason
    ?? ((controlledChat?.loading ?? chat.loading)
      || (controlledChat?.sendDisabled ?? chat.sendDisabled)
      || (controlledChat?.streaming ?? chat.streaming)
      ? 'conversation-busy' : null);

  return (
    <div className={`${styles.sideChat}${editorAppearance ? ` ${styles.movieChat}` : ''}`} data-testid="side-chat-tab">
      {!hideContextBanner && <div className={styles.banner} data-testid="side-chat-context-banner">
        <span className={styles.bannerIcon} aria-hidden>
          <Icon name="comment" size={14} />
        </span>
        <span>{t('workspace.sideChatContextBanner')}</span>
      </div>}
      <div className={styles.pane}>
        <ChatPane
          inlineComposer={inlineComposer}
          composerPlaceholder={composerPlaceholder}
          composerFooterAccessory={composerFooterAccessory}
          designSystemPicker={designSystemPicker}
          headerAccessory={editorAppearance ? <button className={styles.newChat} type="button" disabled={!onNewConversation || chat.streaming} onClick={onNewConversation}>{locale.startsWith('zh') ? '新对话' : 'New chat'}</button> : undefined}
          messages={controlledChat?.messages ?? chat.messages}
          streaming={controlledChat?.streaming ?? chat.streaming}
          loading={controlledChat?.loading ?? chat.loading}
          sendDisabled={controlledChat?.sendDisabled ?? chat.sendDisabled}
          queuedItems={controlledChat?.queuedItems}
          onRemoveQueuedSend={controlledChat?.onRemoveQueuedSend}
          onUpdateQueuedSend={controlledChat?.onUpdateQueuedSend}
          onReorderQueuedSends={controlledChat?.onReorderQueuedSends}
          onSendQueuedNow={controlledChat?.onSendQueuedNow}
          steerBlockedReason={controlledChat?.steerBlockedReason ?? null}
          error={controlledChat ? controlledChat.error : chat.error}
          errorSourceAssistantId={controlledChat?.errorSourceAssistantId}
          projectId={projectId}
          sessionMode={sessionMode}
          onSessionModeChange={(mode) => onSessionModeChange?.(conversationId, mode)}
          onExecutionPermissionSaved={onExecutionPermissionSaved}
          selectedAgentBaseId={selectedAgentBaseId}
          executionPermissionWorkspaceContext={workspaceContext}
          projectFiles={projectFiles}
          projectFileNames={projectFileNames}
          projectResolvedDir={projectResolvedDir}
          onEnsureProject={async () => projectId}
          onSend={controlledChat?.onSend ?? chat.onSend}
          onRetry={controlledChat?.onRetry ?? chat.onRetry}
          recoveryActionsBlockedReason={recoveryBlock}
          retryPendingAssistantId={controlledChat?.retryPendingAssistantId}
          supersededErrorAssistantIds={controlledChat?.supersededErrorAssistantIds}
          onSwitchToAmrAndRetry={onSwitchConversationToCloud
            ? (failedAssistant) => {
                if (recoveryBlock !== null) return;
                onSwitchConversationToCloud(conversationId, failedAssistant);
              }
            : undefined}
          onStop={controlledChat?.onStop ?? chat.onStop}
          onAssistantFeedback={controlledChat?.onAssistantFeedback}
          onRequestOpenFile={onRequestOpenFile}
          conversations={conversations}
          activeConversationId={conversationId}
          // Intentionally omit `messagesConversationId`: `useConversationChat`
          // resets `messages` to [] while a conversation loads, so trusting the
          // live length here would flash a phantom "0 msg". Falling back to the
          // persisted `conversation.messageCount` keeps the list count stable.
          onSelectConversation={onSelectConversation}
          onDeleteConversation={onDeleteConversation}
          onNewConversation={onNewConversation}
          researchAvailable={config.mode === 'daemon' || Boolean(resolveEffectiveChatRuntimeAgentId(config))}
          config={config}
        />
      </div>
    </div>
  );
}
