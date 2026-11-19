import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, CornerUpRight, Radio } from 'lucide-react';
import { FANTAY_SIDE_CHAT_INSTRUCTIONS, resolveEffectiveChatRuntimeAgentId, type SideDialogueSnapshot, type WorkspaceCollabContext } from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { ChatPane, type ChatPaneProps } from '../../components/ChatPane';
import type { ChatSendMeta, ChatSendOutcome } from '../../components/ChatComposer';
import { MovieChannelSwitcher } from '../../components/movie/MovieChannelSwitcher';
import type { ProviderModelsCache } from '../../components/providerModelsCache';
import { useConversationChat } from '../../components/workspace/useConversationChat';
import { mediaExecutionPolicyForProjectMetadata } from '../../media/execution-policy';
import { workspaceProjectHeaders } from '../../collab/workspace-identity';
import { evictConversationsRead, patchConversation } from '../../state/projects';
import type { AgentInfo, AppConfig, ChatAttachment, ChatCommentAttachment, ChatMessage, Conversation } from '../../types';
import { randomUUID } from '../../utils/uuid';
import { composerDraftKeyFor } from '../../utils/conversationActivity';
import { WORKSPACE_DIALOGUE_TAB } from '../workspace/workspace-roots';
import { CONFIRM_RELAY, dialogueConfig, dialogueIntent, readDialogue, requestDialogue, requiresDialogueReview, selectedDialogueModel,
  type DialogueDraft, type DialogueLine, type DialoguePayload, type DialogueSession, type DialogueTarget, type DialogueTurn } from './side-dialogue';
import styles from './SideDialoguePanel.module.css';

export type SideDialogueProjectProps = Pick<ChatPaneProps,
  | 'projectKindForTracking' | 'projectFiles' | 'activeProjectFileName' | 'hasActiveDesignSystem'
  | 'activeDesignSystem' | 'projectFileNames' | 'projectResolvedDir' | 'skills'
  | 'onEnsureProject' | 'onRequestOpenFile' | 'onRequestPluginDetails' | 'onRequestDesignSystemDetails'
  | 'onRequestPluginFolderAgentAction' | 'activePluginActionPaths' | 'hiddenPluginActionPaths' | 'onArtifactShare'
  | 'onArtifactDownload' | 'onOpenSettings' | 'onOpenMcpSettings' | 'onBrowsePlugins'
  | 'onOpenConnectors' | 'petConfig' | 'onAdoptPet' | 'onTogglePet'
  | 'onOpenPetSettings' | 'byokImageModel' | 'onChangeByokImageModel' | 'byokVideoModel'
  | 'onChangeByokVideoModel' | 'byokSpeechModel' | 'onChangeByokSpeechModel' | 'byokSpeechVoice'
  | 'onChangeByokSpeechVoice' | 'projectMetadata' | 'onProjectMetadataChange' | 'activeWorkspaceContext'
  | 'workspaceContexts' | 'currentSkillId' | 'onProjectSkillChange' | 'activePluginSnapshot'
  | 'currentDesignSystemId' | 'onActiveDesignSystemChange' | 'onShowToast' | 'designSystemPicker'
> & { onRequestPluginFolderAgentAction?: (
  ...args: [...Parameters<NonNullable<ChatPaneProps['onRequestPluginFolderAgentAction']>>, { id: string; show(message: ChatMessage): void }]
) => ReturnType<NonNullable<ChatPaneProps['onRequestPluginFolderAgentAction']>> };

interface Props {
  storageKey: string;
  visible: boolean;
  target: DialogueTarget | null;
  config: AppConfig;
  agents: AgentInfo[];
  projectChat: SideDialogueProjectProps;
  workspaceContext?: WorkspaceCollabContext | null;
  onSettings(): void;
  onFork?(message: ChatMessage, source: { id: string; messages: ChatMessage[]; mode: NonNullable<Conversation['sessionMode']> }): void;
  onBound?(parentId: string): void;
  readMain(projectId: string, conversationId: string): { main: SideDialogueSnapshot; workspaceContext: WorkspaceCollabContext | null } | null;
  relay(projectId: string, conversationId: string, text: string, requestId: string, payload: DialoguePayload): Promise<boolean>;
}

export function SideDialoguePanel(props: Props) {
  const { locale } = useI18n();
  const { target, workspaceContext, storageKey, visible } = props;
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const project = target?.projectId;
  const parent = target?.conversationId;
  const canBind = !!project && !!parent;
  const readOnly = !!target?.readOnly;
  const onBound = useRef(props.onBound);
  onBound.current = props.onBound;

  useEffect(() => {
    if (!canBind || !project || !parent) return;
    const abort = new AbortController();
    setError('');
    void (async () => {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/conversations/${encodeURIComponent(parent)}/side-dialogue`, {
        method: readOnly ? 'GET' : 'POST', headers: workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}, signal: abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { conversation: side } = await res.json() as { conversation: Conversation | null };
      if (readOnly && !side) return;
      if (!side?.id || side.projectId !== project || side.id === parent) throw new Error('Invalid side conversation');
      if (abort.signal.aborted) return;
      evictConversationsRead(project, workspaceContext);
      onBound.current?.(parent);
      // Older versions kept plain text beside the transcript. Preserve the new composer's own draft on reopen.
      const legacy = readDialogue(storageKey);
      if (legacy.input) {
        try {
          const key = composerDraftKeyFor(project, side.id);
          if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy.input);
          localStorage.setItem(storageKey, JSON.stringify({ ...legacy, input: '' }));
        } catch { /* Storage may be unavailable. */ }
      }
      setConversation(side);
    })().catch(cause => { if (!abort.signal.aborted) setError(String(cause)); });
    return () => abort.abort();
  }, [canBind, readOnly, project, parent, workspaceContext, storageKey, attempt]);

  if (!target || (!readOnly && !conversation)) return <section hidden={!visible} className={styles.panel} aria-busy={!error}>
    <div className={styles.loading} role={error ? 'alert' : 'status'}>
      {error ? <>{error} <button type="button" onClick={() => setAttempt(n => n + 1)}>{locale.startsWith('zh') ? '重新加载' : 'Retry'}</button></>
        : locale.startsWith('zh') ? '正在打开侧边聊天…' : 'Opening side chat…'}
    </div>
  </section>;
  return <DialogueConversation {...props} conversation={canBind ? conversation : null} onConversationChange={setConversation}/>;
}

const EMPTY_PAYLOAD: DialoguePayload = { attachments: [], commentAttachments: [] };

function line(role: DialogueLine['role'], content: string): DialogueLine {
  return { id: randomUUID(), createdAt: Date.now(), role, content };
}

function combinePayload(previous: DialoguePayload | undefined, next: DialoguePayload): DialoguePayload {
  if (!previous) return next;
  return {
    attachments: [...new Map([...previous.attachments, ...next.attachments].map(a => [a.path, a])).values()],
    commentAttachments: [...new Map([...previous.commentAttachments, ...next.commentAttachments].map(a => [a.id, a])).values()],
    meta: { ...previous.meta, ...next.meta },
  };
}

function DialogueConversation({ storageKey, visible, target, config, agents, projectChat, workspaceContext, onSettings, onFork, readMain, relay,
  conversation, onConversationChange }: Props & { conversation: Conversation | null; onConversationChange(c: Conversation): void }) {
  const { locale, t } = useI18n();
  const zh = locale.startsWith('zh');
  const L = (cn: string, en: string) => zh ? cn : en;
  const [session, setSession] = useState(() => readDialogue(storageKey));
  const state = useRef(session);
  const mounted = useRef(false);
  const update = (change: (s: DialogueSession) => DialogueSession) => {
    const next = change(state.current);
    state.current = next;
    if (mounted.current) setSession(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep the running conversation usable. */ }
  };
  const [cache, setCache] = useState<ProviderModelsCache>({});
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const blockedQueue = useRef<string | null>(null);
  const host = useRef({ readMain, relay });
  host.current = { readMain, relay };
  const localConfig = useMemo(() => dialogueConfig(config, session.model), [config, session.model]);
  const agentsById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const notes = useMemo<ChatMessage[]>(() => session.lines.map((item, index) => ({
    ...item, id: item.id ?? 'side-note-' + index,
  })), [session.lines]);
  const chat = useConversationChat(target?.projectId ?? '', conversation?.id ?? '', {
    enabled: !!conversation, config: localConfig, agentsById, locale, workspaceContext,
    sessionMode: conversation?.sessionMode ?? 'chat', executionPermission: conversation?.executionPermission,
    skillId: projectChat.currentSkillId ?? undefined, designSystemId: projectChat.currentDesignSystemId,
    sideDialogueInstructions: FANTAY_SIDE_CHAT_INSTRUCTIONS, additionalMessages: notes,
    savedTurnMeta: id => state.current.turnOptions?.[id],
    mediaExecution: mediaExecutionPolicyForProjectMetadata(projectChat.projectMetadata),
    byokMediaDefaults: {
      imageModel: projectChat.byokImageModel || localConfig.byokImageModel, videoModel: projectChat.byokVideoModel || localConfig.byokVideoModel,
      speechModel: projectChat.byokSpeechModel || localConfig.byokSpeechModel, speechVoice: projectChat.byokSpeechVoice || localConfig.byokSpeechVoice,
    },
  });
  const transcript = useMemo(() => [...chat.messages, ...notes].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)), [chat.messages, notes]);
  const running = chat.streaming || chat.messages.some(m => m.role === 'assistant' && (m.runStatus === 'running' || m.runStatus === 'queued'));
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); };
  }, []);

  async function deliver(draft: DialogueDraft) {
    if (!target || target.readOnly || !await host.current.relay(target.projectId, target.conversationId, draft.text, draft.id, draft.payload ?? EMPTY_PAYLOAD)) {
      throw new Error(L('主会话尚未接收，转达稿已保留。', 'The main chat could not accept the request. Your draft is saved.'));
    }
    update(s => ({ ...s, draft: undefined, clarification: undefined, lines: [...s.lines,
      { ...line('assistant', L('主会话已接收', 'Accepted by the main chat') + '「' + target.title + '」\n\n' + draft.text), relayReceipt: true }] }));
  }

  async function runTurn(turn: DialogueTurn, action?: 'progress' | 'confirm'): Promise<boolean> {
    if (request.current) return false;
    const { prompt, attachments, commentAttachments, meta } = turn;
    const saved = state.current;
    const intent = dialogueIntent(prompt);
    const confirm = action === 'confirm' || (turn.confirmId !== undefined && turn.confirmId === saved.draft?.id);
    if (turn.confirmId && !confirm) return true; // That reviewed draft was already handled or replaced.
    const mode = action === 'progress' || intent === 'progress' ? 'progress' : turn.preview || saved.clarification || intent === 'relay' ? 'relay' : 'chat';
    setError('');
    if (!confirm && mode === 'chat') {
      if (!conversation || target?.readOnly) return false;
      const accepted = chat.onSend(prompt, attachments, commentAttachments, { ...meta, clientRequestId: turn.id });
      if (accepted && meta) update(s => ({ ...s, turnOptions: { ...s.turnOptions, [turn.id]: meta } }));
      return accepted;
    }
    const controller = new AbortController();
    request.current = controller;
    setPreparing(true);
    try {
      if (confirm && saved.draft) { await deliver(saved.draft); return true; }
      const source = mode !== 'chat' && target ? host.current.readMain(target.projectId, target.conversationId) : null;
      if (mode !== 'chat' && !source) throw new Error(L('请等待当前主会话加载完成。', 'Wait for the current main conversation to load.'));
      const preview = turn.preview || saved.clarification?.preview;
      const lastReceipt = saved.lines.filter(item => item.relayReceipt).at(-1)?.createdAt ?? 0;
      const lastQuestion = transcript.filter(m => (m.createdAt ?? 0) > lastReceipt && m.role === 'user').at(-1);
      const refersToDiscussion = mode === 'relay' && !attachments.length && !commentAttachments.length
        && (turn.preview || !/[:：]/.test(prompt));
      const previousPayload = saved.clarification?.payload ?? (refersToDiscussion && lastQuestion ? {
        attachments: lastQuestion.attachments ?? [], commentAttachments: lastQuestion.commentAttachments ?? [],
        meta: { context: lastQuestion.runContext, appliedPluginSnapshot: lastQuestion.appliedPluginSnapshot },
      } : undefined);
      const payload = combinePayload(previousPayload, { attachments, commentAttachments, meta });
      const filenames = payload.attachments.map(a => a.name || a.path);
      const content = filenames.length ? prompt + '\n' + L('附带文件', 'Attached files') + ' · ' + filenames.join('、') : prompt;
      const user = line('user', content);
      const context = transcript.map(m => ({ role: m.role, content: m.content || m.events?.flatMap(e => e.kind === 'text' ? [e.text] : []).join('') || '' })).filter(m => m.content.trim());
      if (saved.draft) context.push({ role: 'assistant', content: L('待审阅草稿', 'Draft for review') + '\n' + saved.draft.text });
      const args = { config: localConfig, agents, cache, locale, mode, lines: [...context, user], target,
        workspaceContext: source ? source.workspaceContext : workspaceContext, signal: controller.signal } as const;
      let reply = await requestDialogue({ ...args, ...(source && { main: source.main }) });
      if (controller.signal.aborted) return false;
      if (reply.kind === 'read_main' && target) {
        const latest = host.current.readMain(target.projectId, target.conversationId);
        if (latest) reply = await requestDialogue({ ...args, main: latest.main, workspaceContext: latest.workspaceContext });
      }
      if (controller.signal.aborted) return false;
      if (reply.kind === 'draft') {
        const draft = { id: turn.id, text: reply.text, payload };
        update(s => ({ ...s, draft, clarification: undefined, lines: [...s.lines, user] }));
        const instructions = refersToDiscussion || saved.clarification
          ? transcript.filter(m => m.role === 'user' && (m.createdAt ?? 0) > lastReceipt).slice(-3).map(m => m.content) : [];
        if (!preview && !reply.review && !target?.readOnly && !requiresDialogueReview([content, draft.text, ...instructions].join('\n'))) {
          try { await deliver(draft); }
          catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
        }
      } else {
        const text = reply.kind === 'reply' ? reply.text : L('目前没有可读的主会话记录。', 'No main conversation history is available.');
        update(s => ({ ...s, ...(mode === 'relay' && { draft: undefined, clarification: { preview: !!preview, payload } }),
          lines: [...s.lines, user, line('assistant', text)] }));
      }
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      request.current = null;
      if (mounted.current) setPreparing(false);
    }
  }

  const send = async (prompt: string, attachments: ChatAttachment[], commentAttachments: ChatCommentAttachment[], meta?: ChatSendMeta, preview = false): Promise<ChatSendOutcome> => {
    if (target?.readOnly) return 'restore-draft';
    const confirmId = !preview && CONFIRM_RELAY.test(prompt.trim()) ? state.current.draft?.id : undefined;
    const turn: DialogueTurn = { id: meta?.clientRequestId ?? randomUUID(), prompt, attachments, commentAttachments, meta, preview, confirmId };
    if (running || preparing || request.current || meta?.queueOnly || state.current.queued?.length) {
      update(s => ({ ...s, queued: [...(s.queued ?? []), turn] }));
      return;
    }
    if (!await runTurn(turn)) return 'restore-draft';
  };
  const drain = useRef(runTurn);
  drain.current = runTurn;
  const claim = useRef<string | null>(null);
  const next = session.queued?.[0];
  useEffect(() => {
    if (!next || running || preparing || target?.readOnly || chat.loading || (conversation && chat.sendDisabled) || claim.current || blockedQueue.current === next.id) return;
    claim.current = next.id;
    void drain.current(next).then(ok => {
      if (ok) update(s => ({ ...s, queued: s.queued?.filter(item => item.id !== next.id) }));
      else blockedQueue.current = next.id;
    }).finally(() => { claim.current = null; });
  }, [next, session.queued, running, preparing, target?.readOnly, chat.loading, chat.sendDisabled, conversation]);
  const stop = () => { if (request.current) request.current.abort(); else chat.onStop(); };
  const mainBusy = preparing || running;
  const actionTurn = (prompt: string): DialogueTurn => ({ ...EMPTY_PAYLOAD, id: randomUUID(), prompt });

  return <section id="fantay-side-dialogue" className={styles.panel} hidden={!visible} aria-label={t('workspace.dialogue.title')}>
    <ChatPane {...projectChat} inlineComposer boundSidePane surfaceVisible={visible}
      activeWorkspaceContext={projectChat.activeWorkspaceContext?.tabId === WORKSPACE_DIALOGUE_TAB ? null : projectChat.activeWorkspaceContext}
      onRequestPluginFolderAgentAction={conversation && !target?.readOnly && !mainBusy
        ? (path, action) => projectChat.onRequestPluginFolderAgentAction?.(path, action, { id: conversation.id, show: chat.showProjectMessage }) : undefined}
      projectId={target?.projectId ?? null} config={localConfig} messages={transcript} streaming={mainBusy} loading={!!conversation && chat.loading}
      viewerOnly={target?.readOnly} sendDisabled={target?.readOnly || (!!conversation && chat.sendDisabled)} error={error || chat.error} onSend={send} onStop={stop}
      conversations={conversation ? [conversation] : []} activeConversationId={conversation?.id ?? null}
      onSelectConversation={() => {}} onDeleteConversation={() => {}} sessionMode={conversation?.sessionMode ?? 'chat'}
      selectedAgentBaseId={localConfig.agentId ? agentsById.get(localConfig.agentId)?.baseAgentId : null}
      executionPermissionWorkspaceContext={workspaceContext}
      onExecutionPermissionSaved={conversation ? (_, permission) => onConversationChange({ ...conversation, executionPermission: permission }) : undefined}
      onSessionModeChange={async mode => {
        if (!target || !conversation) return;
        const updated = await patchConversation(target.projectId, conversation.id, { sessionMode: mode }, workspaceContext);
        if (updated && mounted.current) onConversationChange(updated);
      }}
      onRetry={target?.readOnly ? undefined : chat.onRetry} onResendUserMessage={m => void send(m.content, m.attachments ?? [], m.commentAttachments ?? [], { context: m.runContext })}
      onForkFromMessage={conversation && onFork && !target?.readOnly ? message => {
        if (chat.versionActions.supports?.(message.id)) onFork(message, { id: conversation.id, messages: chat.messages, mode: conversation.sessionMode ?? 'chat' });
      } : undefined}
      messageVersionActions={conversation && !target?.readOnly ? { ...chat.versionActions, disabled: chat.versionActions.disabled || preparing } : undefined}
      onAssistantFeedback={conversation && !target?.readOnly ? chat.onFeedback : undefined}
      onSubmitQuestionForm={async (prompt, attachments = [], context) => await send(prompt, attachments, [], { context }) !== 'restore-draft'}
      researchAvailable={!!conversation && (localConfig.mode === 'daemon' || !!resolveEffectiveChatRuntimeAgentId(localConfig))}
      byokApiProtocol={localConfig.apiProtocol}
      queuedItems={session.queued} onRemoveQueuedSend={id => update(s => ({ ...s, queued: s.queued?.filter(item => item.id !== id) }))}
      onUpdateQueuedSend={(id, changes) => { blockedQueue.current = null; update(s => ({ ...s, queued: s.queued?.map(item => item.id === id ? { ...item, ...changes } : item) })); }}
      onReorderQueuedSends={ids => update(s => ({ ...s, queued: ids.flatMap(id => s.queued?.filter(item => item.id === id) ?? []) }))}
      onSendQueuedNow={id => {
        blockedQueue.current = null;
        update(s => ({ ...s, queued: [...(s.queued ?? []).filter(item => item.id === id), ...(s.queued ?? []).filter(item => item.id !== id)] }));
        if (mainBusy) stop();
      }}
      composerPlaceholder={L('和 Fantay 聊聊…', 'Message Fantay…')}
      composerFooterAccessory={<MovieChannelSwitcher config={localConfig} agents={agents} providerModelsCache={cache}
        onProviderModelsCacheChange={setCache} onConfigChange={value => update(s => ({ ...s, model: selectedDialogueModel(value, agents, cache) }))} onOpenSettings={onSettings}/>}
      composerActions={submit => <>
        {session.draft && <section className={styles.review}>
          <label htmlFor="fantay-dialogue-draft">{L('待转达', 'Relay draft')} · {target?.title}</label>
          <textarea id="fantay-dialogue-draft" value={session.draft.text} disabled={mainBusy} onChange={e => {
            const text = e.target.value;
            update(s => s.draft ? { ...s, draft: { ...s.draft, text } } : s);
          }}/>
          <div><button type="button" disabled={mainBusy} onClick={() => update(s => ({ ...s, draft: undefined }))}>{L('取消', 'Cancel')}</button>
            <button type="button" disabled={mainBusy || !session.draft.text.trim() || target?.readOnly}
              onClick={() => void runTurn(actionTurn(''), 'confirm')}><Check size={14}/>{L('确认发送', 'Confirm send')}</button></div>
        </section>}
        {target && <div className={styles.actions}>
          <button type="button" disabled={mainBusy} title={target.title} onClick={() => void runTurn(actionTurn(L('跟进一下主会话。', 'Check progress in the main conversation.')), 'progress')}><Radio size={14}/>{L('跟进进展', 'Check progress')}</button>
          <button type="button" disabled={mainBusy || target.readOnly} onClick={() => submit(L('整理刚才讨论的需求。', 'Prepare our request for the main chat.'), (p,a,c,m) => send(p,a,c,m,true))}><CornerUpRight size={14}/>{L('整理转达', 'Draft relay')}</button>
          {session.clarification && <button type="button" onClick={() => update(s => ({ ...s, clarification: undefined }))}>{L('取消转达', 'Cancel relay')}</button>}
          {target.running && <small>{L('主会话运行中', 'Main chat running')}</small>}
        </div>}
      </>}/>
  </section>;
}
