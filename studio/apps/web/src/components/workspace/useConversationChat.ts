import { useCallback, useEffect, useRef, useState } from 'react';
import { reportChatRunFeedback, streamViaDaemon } from '../../providers/daemon';
import type { ChatSendMeta } from '../ChatComposer';
import type { ByokMediaDefaults, MediaExecutionPolicy } from '@open-design/contracts';
import { listMessages, saveMessage, selectChatMessageBranch } from '../../state/projects';
import { messageVersionRequest } from '../../runtime/chat/message-version-request';
import type { MessageVersionActions } from '../chat/MessageVersions';
import { workspaceProjectHeaders } from '../../collab/workspace-identity';
import type { ChatMessageFeedbackChange } from '../../types';
import {
  appendErrorStatusEvent,
  runFailureFieldsFromError,
  stderrTailFromError,
} from '../../runtime/chat-events';
import { agentModelDisplayName } from '../../utils/agentLabels';
import { randomUUID } from '../../utils/uuid';
import { effectiveAgentModelChoice } from '../agentModelSelection';
import {
  createBufferedTextUpdates,
  chatAttachmentsFromPreviewCommentImages,
  mergeChatAttachments,
  finalizeActiveAssistantMessagesOnStop,
  resolveRetryTarget,
  resolveSucceededRunStatus,
} from '../ProjectView';
import {
  BEDROCK_BYOK_UNSUPPORTED_MESSAGE,
  byokPreflightBlockReason,
  byokProviderFromConfig,
  isSupportedByokChatProtocol,
} from '../byok/preflight';
import type {
  AgentEvent,
  AgentInfo,
  AppConfig,
  ChatAttachment,
  ChatCommentAttachment,
  ChatMessage,
} from '../../types';
import type {
  ChatExecutionPermission,
  ChatSessionMode,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import {
  BYOK_AGENT_ID,
  isByokAgentId,
  supportsConfigExecutionPermission,
} from '@open-design/contracts';

// ---------------------------------------------------------------------------
// useConversationChat — drives a secondary ChatPane bound to a single
// conversation (the Side Chat workspace tab).
//
// ProjectView owns the primary conversation's send/stream loop. That loop is
// deeply entangled with queueing, plugin snapshots, live-artifact parsing,
// design-system auditing, notifications, and route sync — extracting it wholesale
// would gut ProjectView. Instead this hook reuses the SAME daemon primitive the
// primary loop runs on (`streamViaDaemon`) plus the SAME persistence helpers
// (`listMessages` / `saveMessage`), so a side chat behaves like the main chat
// ("chat 和我们已有的 chat 对齐即可"): create a run against the conversation, stream
// deltas into the live assistant message, push tool/status events, persist, and
// finalize on done / error / stop. It deliberately omits the primary loop's
// extras (no live-artifact viewer wiring, no queueing) because a side chat is a
// lightweight scratch conversation.
// ---------------------------------------------------------------------------

function isTerminalRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function isActiveRunStatus(status: ChatMessage['runStatus']): boolean {
  return status === 'queued' || status === 'running';
}

export interface ConversationChatContext {
  enabled?: boolean;
  sideDialogueInstructions?: string;
  additionalMessages?: ChatMessage[];
  savedTurnMeta?: (clientRequestId: string) => ChatSendMeta | undefined;
  designSystemId?: string | null;
  byokMediaDefaults?: ByokMediaDefaults;
  mediaExecution?: MediaExecutionPolicy;
  /** Optional utility skill for an embedded, domain-specific workbench. */
  skillId?: string;
  /** Live app config — selects daemon-vs-api mode and the active agent. */
  config: AppConfig;
  /** Agent metadata map (id → AgentInfo), used to resolve model labels. */
  agentsById: Map<string, AgentInfo>;
  /** UI locale forwarded to the daemon so prompts compose in-language. */
  locale: string;
  sessionMode: ChatSessionMode;
  executionPermission?: ChatExecutionPermission | null;
  selectedAgentBaseId?: string | null;
  /**
   * The caller's current workspace identity, forwarded to `streamViaDaemon`
   * so POST /api/runs carries the same `x-od-workspace-*` headers the
   * primary ProjectView chat loop sends. Without this a side-chat send
   * against a team-bound project would 401 against the daemon's workspace
   * mutation gate even for a fully authorized member. Null/omitted for
   * signed-out / personal usage.
   */
  workspaceContext?: WorkspaceCollabContext | null;
}

export interface UseConversationChatResult {
  versionActions: MessageVersionActions;
  onFeedback: (message: ChatMessage, change: ChatMessageFeedbackChange) => void;
  showProjectMessage: (message: ChatMessage) => void;
  messages: ChatMessage[];
  streaming: boolean;
  error: string | null;
  /** True until the initial message load resolves. */
  loading: boolean;
  /** A failed authoritative transcript read must never be treated as empty history. */
  sendDisabled: boolean;
  onSend: (
    prompt: string,
    attachments: ChatAttachment[],
    commentAttachments: ChatCommentAttachment[],
    meta?: ChatSendMeta,
  ) => boolean;
  onRetry: (assistantMessage: ChatMessage) => void;
  onStop: () => void;
}

export function useConversationChat(
  projectId: string,
  conversationId: string,
  ctx: ConversationChatContext,
): UseConversationChatResult {
  const { config, agentsById, locale } = ctx;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<MessageVersionActions['editor']>(null);
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const branchLock = useRef(false);
  const messageScopeKey = `${projectId}\u0000${conversationId}`;
  const [messagesReadyScopeKey, setMessagesReadyScopeKey] = useState<string | null>(null);

  // Keep the latest config/agent map in refs so the stable `onSend` callback
  // always reads the current agent selection without re-subscribing the SSE.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
  const messagesReadyScopeKeyRef = useRef<string | null>(null);

  // Keep terminal callbacks tied to their request even after its live
  // controller is released. A subsequent request or scope retires this owner.
  const requestOwnerRef = useRef<AbortController | null>(null);
  const currentScopeRef = useRef(messageScopeKey);
  currentScopeRef.current = messageScopeKey;
  const abortRef = useRef<AbortController | null>(null);
  const uncommittedVersion = useRef<ChatMessage[] | null>(null);
  const cancelRef = useRef<AbortController | null>(null);
  // Coalesces streamed deltas into ~one React update per animation frame
  // (same primitive the primary chat loop uses) so a side chat doesn't rebuild
  // the whole messages array on every SSE token.
  const textBufferRef = useRef<ReturnType<typeof createBufferedTextUpdates> | null>(null);

  // Load the conversation's persisted messages on mount / conversation switch.
  useEffect(() => {
    let cancelled = false;
    setStreaming(false);
    setLoading(true);
    setMessages([]);
    setError(null);
    setMessagesReadyScopeKey(null);
    messagesReadyScopeKeyRef.current = null;
    if (ctx.enabled === false) { setLoading(false); return; }
    void (async () => {
      try {
        const list = await listMessages(
          projectId,
          conversationId,
          ctx.workspaceContext,
        );
        if (cancelled) return;
        setMessages(list);
        setMessagesReadyScopeKey(messageScopeKey);
        messagesReadyScopeKeyRef.current = messageScopeKey;
        setLoading(false);
      } catch (loadError) {
        if (cancelled) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'Could not load messages for this conversation.',
        );
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Navigation retires only the browser subscription, not the daemon run.
      // Release admission before another scope loads, and reject old callbacks.
      requestOwnerRef.current = null;
      uncommittedVersion.current = null;
      abortRef.current?.abort();
      abortRef.current = null;
      cancelRef.current = null;
      textBufferRef.current?.cancel();
      textBufferRef.current = null;
    };
  }, [projectId, conversationId, ctx.enabled, ctx.workspaceContext, messageScopeKey]);

  // A reopened workbench does not own the original stream. Keep its persisted
  // run visible and current without starting a replacement generation.
  const recoveringRun = !streaming && messages.some(message => message.role === 'assistant' && isActiveRunStatus(message.runStatus));
  useEffect(() => {
    if (!recoveringRun) return;
    let canceled = false;
    let pending = false;
    const timer = setInterval(() => {
      if (pending || abortRef.current) return;
      pending = true;
      void listMessages(projectId, conversationId, ctxRef.current.workspaceContext).then(list => {
        if (!canceled && !abortRef.current && currentScopeRef.current === messageScopeKey) setMessages(list);
      }).catch(() => {}).finally(() => {pending = false;});
    }, 2500);
    return () => {canceled = true; clearInterval(timer);};
  }, [recoveringRun, projectId, conversationId, messageScopeKey]);

  const persist = useCallback(
    (message: ChatMessage) => {
      void saveMessage(projectId, conversationId, message, {
        workspaceContext: ctxRef.current.workspaceContext,
      });
    },
    [projectId, conversationId],
  );

  const updateAssistant = useCallback(
    (assistantId: string, updater: (prev: ChatMessage) => ChatMessage) => {
      setMessages((curr) => curr.map((m) => (m.id === assistantId ? updater(m) : m)));
    },
    [],
  );

  const runSend = useCallback(
    (
      prompt: string,
      attachments: ChatAttachment[],
      commentAttachments: ChatCommentAttachment[],
      retryOfAssistantId?: string,
      meta?: ChatSendMeta,
      version?: NonNullable<ReturnType<typeof messageVersionRequest>>,
    ) => {
      const {
        config: cfg,
        agentsById: agents,
        locale: loc,
        sessionMode,
        executionPermission,
        selectedAgentBaseId,
        skillId,
        workspaceContext,
      } = ctxRef.current;
      if (messagesReadyScopeKeyRef.current !== messageScopeKey) return false;
      // This controller is installed synchronously before dispatch, so two
      // activations in one React turn cannot admit two replacement requests.
      if (abortRef.current || branchLock.current) return false;
      if (messagesRef.current.some(message => message.role === 'assistant' && isActiveRunStatus(message.runStatus))) return false;
      const apiMode = cfg.mode === 'api';
      if (apiMode && !isSupportedByokChatProtocol(cfg.apiProtocol)) {
        setError(BEDROCK_BYOK_UNSUPPORTED_MESSAGE);
        return false;
      }
      const resolvedBaseAgentId =
        selectedAgentBaseId
        ?? (cfg.mode === 'daemon' && cfg.agentId ? agents.get(cfg.agentId)?.baseAgentId ?? null : null);
      if (executionPermission && !supportsConfigExecutionPermission(cfg, resolvedBaseAgentId)) {
        return false;
      }
      const isByokRun = apiMode || (cfg.mode === 'daemon' && isByokAgentId(cfg.agentId));
      const byokProvider = isByokRun ? byokProviderFromConfig(cfg) : undefined;
      if (isByokRun && (!byokProvider || byokPreflightBlockReason(cfg))) {
        setError(loc.startsWith('zh') ? '请先在渠道设置中补全地址、密钥和支持工具调用的模型。' : 'Complete this channel’s endpoint, key and tool-capable model in settings.');
        return false;
      }
      if (!isByokRun && !cfg.agentId) {
        setError('Pick a local agent first (top bar).');
        return false;
      }
      const runtimeAgentId = isByokRun ? BYOK_AGENT_ID : cfg.agentId!;

      const transcript = ctxRef.current.additionalMessages?.length
        ? [...messagesRef.current, ...ctxRef.current.additionalMessages].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
        : messagesRef.current;
      const retryTarget = retryOfAssistantId
        ? resolveRetryTarget(transcript, retryOfAssistantId)
        : null;
      if (retryOfAssistantId && !retryTarget) return false;
      const priorRequest = version?.question.clientRequestId ?? retryTarget?.userMsg.clientRequestId;
      if (priorRequest) meta = { ...ctxRef.current.savedTurnMeta?.(priorRequest), ...meta, clientRequestId: randomUUID() };
      const runAttachments = mergeChatAttachments(attachments, ...commentAttachments.map(a => chatAttachmentsFromPreviewCommentImages(a.imageAttachments)));

      const startedAt = Date.now();
      const selectedAgent = agents.get(runtimeAgentId) ?? null;
      const choice = isByokRun ? undefined : effectiveAgentModelChoice(selectedAgent, cfg.agentModels?.[runtimeAgentId]);
      const assistantAgentName = isByokRun
        ? `${cfg.apiProtocol} · ${byokProvider?.model ?? cfg.model}`
        : agentModelDisplayName(
            runtimeAgentId,
            selectedAgent?.name,
            choice?.model,
          );

      const reusedQuestion = version?.branch.action === 'regenerate' ? version.question : retryTarget?.userMsg;
      const userMsg: ChatMessage = reusedQuestion ?? {
            id: randomUUID(),
            role: 'user',
            content: prompt,
            createdAt: startedAt,
            sessionMode: meta?.sessionMode ?? sessionMode,
            ...(meta?.clientRequestId && { clientRequestId: meta.clientRequestId }),
            ...(meta?.context && { runContext: meta.context }),
            ...(meta?.appliedPluginSnapshot && { appliedPluginSnapshot: meta.appliedPluginSnapshot }),
            ...(runAttachments.length > 0 ? { attachments: runAttachments } : {}),
            ...(commentAttachments.length > 0 ? { commentAttachments } : {}),
          };
      // A retry is a new attempt. The previous failure remains an immutable
      // diagnostic record in both the transcript and persistence.
      const assistantId = randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        agentId: runtimeAgentId,
        agentName: assistantAgentName,
        events: [],
        createdAt: startedAt,
        runStatus: 'running',
        startedAt,
      };

      const branchPrefix = version ? messagesRef.current.slice(0, version.questionIndex) : undefined;
      const history = [...(branchPrefix ?? retryTarget?.priorMessages ?? transcript), userMsg];
      // Provider context repeats the original request without its failed
      // output. The visible transcript retains that failed attempt unchanged.
      const nextMessages = retryTarget
        ? [...messagesRef.current, assistantMsg]
        : [...(branchPrefix ?? messagesRef.current), userMsg, assistantMsg];
      const previousMessages = messagesRef.current;
      uncommittedVersion.current = version ? previousMessages : null;
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setStreaming(true);
      setError(null);
      if (!retryTarget && !version) persist(userMsg);

      const controller = new AbortController();
      const cancelController = new AbortController();
      abortRef.current = controller;
      cancelRef.current = cancelController;
      requestOwnerRef.current = controller;
      const ownsScope = () => requestOwnerRef.current === controller
        && currentScopeRef.current === messageScopeKey
        && ctxRef.current.workspaceContext === workspaceContext;
      const acceptsCallback = () => ownsScope() && !controller.signal.aborted;
      let admitted = false;
      const refreshBranch = () => {
        if (!version) return;
        void listMessages(projectId, conversationId, workspaceContext).then(list => {
          if (ownsScope()) setMessages(list);
        }).catch(() => {});
      };
      const updateOwnedAssistant = (updater: (previous: ChatMessage) => ChatMessage) => {
        if (!ownsScope()) return;
        updateAssistant(assistantId, (previous) => ownsScope() ? updater(previous) : previous);
      };

      // Frame-batch this run's text deltas. flush() applies any pending content
      // before cancel() tears down, so a terminal status that races onDone
      // can't drop the tail of the answer.
      textBufferRef.current?.cancel();
      const textBuffer = createBufferedTextUpdates({
        updateMessage: updateOwnedAssistant,
        // Side chat persists at done/error (+ onRunCreated), not mid-stream.
        persistSoon: () => {},
      });
      textBufferRef.current = textBuffer;

      const clearRefs = () => {
        if (!ownsScope()) return;
        if (abortRef.current === controller) abortRef.current = null;
        if (cancelRef.current === cancelController) cancelRef.current = null;
        textBuffer.flush();
        textBuffer.cancel();
        if (textBufferRef.current === textBuffer) textBufferRef.current = null;
        setStreaming(false);
      };

      const handlers = {
        onDelta: (delta: string) => {
          if (!acceptsCallback()) return;
          textBuffer.appendContent(delta);
        },
        onAgentEvent: (ev: AgentEvent) => {
          if (!acceptsCallback()) return;
          textBuffer.appendEvent(ev);
        },
        onDone: () => {
          if (!acceptsCallback()) return;
          textBuffer.flush();
          const endedAt = Date.now();
          setMessages((curr) => {
            if (!ownsScope()) return curr;
            const next = curr.map((m) =>
              m.id === assistantId
                ? { ...m, endedAt, runStatus: resolveSucceededRunStatus(m.runStatus) }
                : m,
            );
            const finalized = next.find((m) => m.id === assistantId);
            if (finalized) persist(finalized);
            return next;
          });
          clearRefs();
          refreshBranch();
        },
        onError: (err: Error) => {
          if (!acceptsCallback()) return;
          if (version && !admitted) {
            uncommittedVersion.current = null;
            setMessages(previousMessages);
            setError(err.message);
            clearRefs();
            refreshBranch();
            return;
          }
          textBuffer.flush();
          const endedAt = Date.now();
          const code = (err as Error & { code?: string }).code;
          const resumable = (err as Error & { resumable?: boolean }).resumable === true;
          const failure = runFailureFieldsFromError(err);
          setError(err.message);
          setMessages((curr) => {
            if (!ownsScope()) return curr;
            const next = curr.map((m) => {
              if (m.id !== assistantId) return m;
              const withError = appendErrorStatusEvent(
                m,
                err.message,
                code,
                failure,
                stderrTailFromError(err),
              );
              return {
                ...withError,
                endedAt,
                runStatus: 'failed' as const,
                resumable,
              };
            });
            const finalized = next.find((m) => m.id === assistantId);
            if (finalized) persist(finalized);
            return next;
          });
          clearRefs();
        },
      };

      void streamViaDaemon({
        agentId: runtimeAgentId,
        sideDialogueInstructions: ctxRef.current.sideDialogueInstructions,
        history,
        signal: controller.signal,
        cancelSignal: cancelController.signal,
        handlers,
        projectId,
        conversationId,
        userMessageId: userMsg.id,
        assistantMessageId: assistantId,
        ...(version && { messageBranch: version.branch }),
        clientRequestId: meta?.clientRequestId ?? randomUUID(),
        skillId: skillId ?? null,
        skillIds: meta?.skillIds ?? (skillId ? [skillId] : []),
        context: meta?.context ?? userMsg.runContext,
        research: meta?.research,
        appliedPluginSnapshotId: meta?.appliedPluginSnapshotId ?? userMsg.appliedPluginSnapshot?.snapshotId,
        pluginId: userMsg.appliedPluginSnapshot?.pluginId,
        pluginInputs: userMsg.appliedPluginSnapshot?.inputs,
        designSystemId: ctxRef.current.designSystemId === undefined ? cfg.designSystemId ?? null : ctxRef.current.designSystemId,
        mediaExecution: ctxRef.current.mediaExecution,
        ...(isByokRun && { byokMediaDefaults: ctxRef.current.byokMediaDefaults }),
        workspaceContext,
        attachments: (userMsg.attachments ?? []).map((a) => a.path),
        commentAttachments: userMsg.commentAttachments ?? [],
        model: isByokRun ? byokProvider?.model ?? cfg.model : choice?.model ?? null,
        ...(byokProvider ? { byokProvider } : {}),
        reasoning: choice?.reasoning ?? null,
        serviceTier: choice?.serviceTier ?? null,
        locale: loc,
        sessionMode: meta?.sessionMode ?? userMsg.sessionMode ?? sessionMode,
        onRunCreated: (runId) => {
          if (!acceptsCallback()) return;
          admitted = true;
          if (version) { uncommittedVersion.current = null; setEditor(null); }
          updateOwnedAssistant((prev) => ({
            ...prev,
            runId,
            runStatus: 'queued',
          }));
          setMessages((curr) => {
            if (!ownsScope()) return curr;
            const pinned = curr.find((m) => m.id === assistantId);
            if (pinned) persist(pinned);
            return curr;
          });
        },
        onRunStatus: (runStatus) => {
          if (!acceptsCallback()) return;
          updateOwnedAssistant((prev) => ({
            ...prev,
            runStatus,
            endedAt: isTerminalRunStatus(runStatus) ? prev.endedAt ?? Date.now() : prev.endedAt,
          }));
          if (isTerminalRunStatus(runStatus)) clearRefs();
        },
        onRunEventId: (lastRunEventId) => {
          if (!acceptsCallback()) return;
          updateOwnedAssistant((prev) => ({ ...prev, lastRunEventId }));
        },
      });
      return true;
    },
    [projectId, conversationId, messageScopeKey, persist, updateAssistant],
  );

  const onSend = useCallback(
    (prompt: string, attachments: ChatAttachment[], commentAttachments: ChatCommentAttachment[], meta?: ChatSendMeta) => {
      return runSend(prompt, attachments, commentAttachments, undefined, meta);
    },
    [runSend],
  );

  const onRetry = useCallback(
    (assistantMessage: ChatMessage) => {
      runSend('', [], [], assistantMessage.id);
    },
    [runSend],
  );

  const onStop = useCallback(() => {
    if (!cancelRef.current && !abortRef.current) {
      const active = messagesRef.current.filter(m => m.runId && isActiveRunStatus(m.runStatus));
      const scope = ctxRef.current.workspaceContext;
      void Promise.all(active.map(async m => {
        const result = await fetch(`/api/runs/${encodeURIComponent(m.runId!)}/cancel`, {
          method: 'POST', headers: scope ? workspaceProjectHeaders(scope) : {},
        });
        if (!result.ok) throw new Error(`HTTP ${result.status}`);
      })).then(async () => {
        if (!active.length || currentScopeRef.current !== messageScopeKey) return;
        const list = await listMessages(projectId, conversationId, scope);
        if (currentScopeRef.current === messageScopeKey && !abortRef.current) setMessages(list);
      }).catch(err => { if (currentScopeRef.current === messageScopeKey) setError(String(err)); });
      return;
    }
    const stoppedAt = Date.now();
    // Abort the cancel signal first so the daemon stops the run (POST cancel),
    // then drop the browser-side SSE subscription.
    cancelRef.current?.abort();
    cancelRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    textBufferRef.current?.flush();
    textBufferRef.current?.cancel();
    textBufferRef.current = null;
    setStreaming(false);
    if (uncommittedVersion.current) {
      // POST may still be in flight. Only an admitted branch owns a new row.
      setMessages(uncommittedVersion.current);
      uncommittedVersion.current = null;
      return;
    }
    setMessages((curr) => {
      const { messages: next, finalized } = finalizeActiveAssistantMessagesOnStop(curr, stoppedAt);
      for (const message of finalized) persist(message);
      return next;
    });
  }, [persist, messageScopeKey, projectId, conversationId]);

  const branchSend = async (id: string, text?: string) => {
    const version = messageVersionRequest(messagesRef.current, id, text);
    if (!version) return false;
    const q = version.question;
    return runSend(version.text, q.attachments ?? [], q.commentAttachments ?? [], undefined, {
      sessionMode: q.sessionMode, context: q.runContext, appliedPluginSnapshot: q.appliedPluginSnapshot,
      skillIds: q.runContext?.skillIds,
    }, version);
  };
  const versionActions: MessageVersionActions = {
    disabled: loading || streaming || recoveringRun || switchingBranch, editor, edit: branchSend,
    regenerate: id => branchSend(id), setEditor: (id, draft = '') => setEditor(id ? { messageId: id, draft } : null),
    supports: id => messagesRef.current.some(m => m.id === id),
    select: async id => {
      const leaf = messagesRef.current.at(-1)?.id;
      if (!leaf || branchLock.current || abortRef.current || recoveringRun) return;
      branchLock.current = true;
      setSwitchingBranch(true);
      try {
        const scope = ctxRef.current.workspaceContext;
        await selectChatMessageBranch(projectId, conversationId, id, leaf, scope);
        const list = await listMessages(projectId, conversationId, scope);
        if (currentScopeRef.current === messageScopeKey) { setMessages(list); setEditor(null); }
      } catch (err) { if (currentScopeRef.current === messageScopeKey) setError(String(err)); }
      finally { branchLock.current = false; setSwitchingBranch(false); }
    },
  };
  const onFeedback = (message: ChatMessage, change: ChatMessageFeedbackChange) => {
    const existing = messagesRef.current.find(m => m.id === message.id);
    if (!existing) return;
    const now = Date.now();
    const feedback = change ? { ...change, createdAt: existing.feedback?.rating === change.rating ? existing.feedback.createdAt : now, updatedAt: now } : undefined;
    const updated = { ...existing, feedback };
    setMessages(rows => rows.map(m => m.id === message.id ? updated : m));
    persist(updated);
    if (change && existing.runId) void reportChatRunFeedback({ runId: existing.runId, rating: change.rating,
      reasonCodes: change.reasonCodes ?? [], hasCustomReason: !!change.customReason, customReason: change.customReason ?? '' }, ctxRef.current.workspaceContext);
  };

  return {
    versionActions, onFeedback,
    showProjectMessage: message => setMessages(rows => rows.some(m => m.id === message.id)
      ? rows.map(m => m.id === message.id ? message : m) : [...rows, message]),
    messages,
    streaming,
    error,
    loading,
    sendDisabled: messagesReadyScopeKey !== messageScopeKey || switchingBranch,
    onSend,
    onRetry,
    onStop,
  };
}
