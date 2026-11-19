import { BYOK_AGENT_ID, isByokAgentId, type SideDialogueReply, type SideDialogueRequest, type WorkspaceCollabContext } from '@open-design/contracts';
import { workspaceProjectHeaders } from '../../collab/workspace-identity';
import { byokProviderFromConfig } from '../../components/byok/preflight';
import { channelKey, currentChannelSnapshot, nativeChannelOptions, publicChannelId, savedMovieChannels, selectMovieChannel } from '../../components/movie/MovieChannelSwitcher';
import type { AgentInfo, AgentModelChoice, AppConfig, ChatAttachment, ChatCommentAttachment } from '../../types';
import type { ChatSendMeta } from '../../components/ChatComposer';
import type { ProviderModelsCache } from '../../components/providerModelsCache';

export type DialogueTarget = { projectId: string; conversationId: string; title: string; running: boolean; readOnly: boolean };
export type DialogueLine = { role: 'user' | 'assistant'; content: string; id?: string; createdAt?: number; relayReceipt?: boolean };
export interface DialoguePayload {
  attachments: ChatAttachment[];
  commentAttachments: ChatCommentAttachment[];
  meta?: ChatSendMeta;
}
export type DialogueDraft = { id: string; text: string; payload?: DialoguePayload };
export type DialogueTurn = DialoguePayload & { id: string; prompt: string; preview?: boolean; confirmId?: string };
export const CONFIRM_RELAY = /^(确认(?:发送)?|確認(?:發送)?|可以发了|发给主会话|發給主會話|confirm(?: send)?|send to main chat)[。.!！]?$/i;
export type DialogueModel = { channel: string; model: string; reasoning?: string; serviceTier?: string };
export interface DialogueSession {
  lines: DialogueLine[];
  input: string;
  draft?: DialogueDraft;
  model?: DialogueModel;
  clarification?: { preview: boolean; payload: DialoguePayload };
  queued?: DialogueTurn[];
  turnOptions?: Record<string, ChatSendMeta>;
}

export function readDialogue(key: string): DialogueSession {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null') as DialogueSession | null;
    if (saved && Array.isArray(saved.lines) && typeof saved.input === 'string') {
      return { lines: saved.lines.filter(line => (line?.role === 'user' || line?.role === 'assistant') && typeof line.content === 'string'),
        input: saved.input, ...(typeof saved.draft?.id === 'string' && typeof saved.draft.text === 'string' && { draft: saved.draft }),
        ...(typeof saved.model?.channel === 'string' && typeof saved.model.model === 'string' && { model: saved.model }),
        ...(saved.clarification?.payload && { clarification: saved.clarification }),
        ...(saved.turnOptions && typeof saved.turnOptions === 'object' && { turnOptions: saved.turnOptions }),
        ...(Array.isArray(saved.queued) && { queued: saved.queued.filter(item => item && typeof item.id === 'string' && typeof item.prompt === 'string' && Array.isArray(item.attachments) && Array.isArray(item.commentAttachments)) }) };
    }
  } catch { /* A fresh conversation is available when local storage is unavailable. */ }
  return { lines: [], input: '' };
}

export function selectedDialogueModel(config: AppConfig, agents: AgentInfo[], cache: ProviderModelsCache): DialogueModel {
  const { selectedId, modelId } = nativeChannelOptions(config, agents, cache);
  const choice = config.mode === 'daemon' && config.agentId ? config.agentModels?.[config.agentId] : undefined;
  return { channel: selectedId, model: modelId || config.model, reasoning: choice?.reasoning, serviceTier: choice?.serviceTier };
}

// Persist only selection identifiers. Resolve the credentials against current Settings for each turn.
export function dialogueConfig(base: AppConfig, saved?: DialogueModel): AppConfig {
  if (!saved) return base;
  if (saved.channel.startsWith('agent:')) {
    const agentId = saved.channel.slice(6);
    const choice: AgentModelChoice = { model: saved.model, reasoning: saved.reasoning, serviceTier: saved.serviceTier };
    return { ...base, mode: 'daemon', agentId, agentModels: { ...base.agentModels, [agentId]: choice } };
  }
  const target = savedMovieChannels(base).find(channel => publicChannelId(channel.key) === saved.channel);
  if (!target) return { ...base, mode: 'api', apiKey: '', model: '', baseUrl: '' };
  return { ...selectMovieChannel(base, target), model: saved.model };
}

export function dialogueIntent(text: string): SideDialogueRequest['mode'] {
  const command = text.trim();
  if (/^(?:请|請|麻烦|麻煩|帮我|幫我|再|继续|繼續|补充|補充|\s)*(?:(?:[发發][給给]|转达给?|轉達給?|转发给|轉發給)主[会會][话話]|跟主[会會][话話][说說])(?:\s*[。.!！]?|\s*[:,：，]\s*[\s\S]+)$/u.test(command)
      || /^(?:please\s+)?(?:send|relay) to (?:the )?main (?:chat|conversation)(?: again)?(?:[.!]?|\s*[:,]\s*[\s\S]+)$/i.test(command)) return 'relay';
  if (/^(?:请|帮我|请帮我)?(?:跟[进進](?:一下)?(?:主[会會][话話])?|看看(?:主会话)?进[度展]|查(?:一下)?进度|check (?:the )?progress|follow up)[？?。.!！\s]*$/i.test(command)
    || /(?:主[会會][话話]|(?:(?:那|这|這)一?|第[零一二三四五六七八九十\d]+)[轮輪]).*(?:[进進][度展]|卡在|卡哪|做到哪|[为為]什么还|怎么还|咋还|还没|還沒)/u.test(command)) return 'progress';
  return 'chat';
}

export function requiresDialogueReview(text: string): boolean {
  return /部[署屬]|上[线線]|[发發][布佈]|推[送代码碼]|提[交審]|删|刪|清空|清理|覆盖|覆[蓋盖]|付[费費款]|支付|付款|花[钱錢]|[发發]送.*(?:客[户戶]|[邮郵]件)|先.{0,6}(?:看|确认|確認)|\b(?:deploy\w*|publish\w*|releas\w*|push\w*|commit\w*|delet\w*|remov\w*|overwrit\w*|drop|truncate|reset|pay|purchase|spend|email)\b/i.test(text);
}

export async function requestDialogue(args: {
  config: AppConfig; agents: AgentInfo[]; cache: ProviderModelsCache;
  locale: string; mode: SideDialogueRequest['mode']; lines: readonly DialogueLine[];
  target: DialogueTarget | null; main?: SideDialogueRequest['main']; workspaceContext?: WorkspaceCollabContext | null;
  signal: AbortSignal;
}): Promise<SideDialogueReply> {
  const { config, target, main } = args;
  const byok = config.mode === 'api' || isByokAgentId(config.agentId);
  const provider = byok ? byokProviderFromConfig(config) : undefined;
  const { channels, selectedId, modelId } = nativeChannelOptions(config, args.agents, args.cache);
  const channelId = byok && config.apiProtocol ? publicChannelId(channelKey(config.apiProtocol, currentChannelSnapshot(config))) : selectedId;
  if (!channels.some(channel => channel.id === channelId) || (!byok && (!config.agentId || !modelId)) || (byok && !provider)) {
    throw new Error(args.locale.startsWith('zh') ? '请先选择可用的模型和渠道。' : 'Choose an available model and channel first.');
  }
  const choice = config.agentId ? config.agentModels?.[config.agentId] : null;
  const body: SideDialogueRequest = {
    mode: args.mode, locale: args.locale, agent: byok ? BYOK_AGENT_ID : config.agentId!, model: byok ? config.model : modelId,
    ...(!byok && { reasoning: choice?.reasoning, serviceTier: choice?.serviceTier }), ...(provider && { byok: provider }),
    ...(target && { projectId: target.projectId }), ...(main && { main }),
    history: args.lines.slice(-20).map(line => ({ role: line.role, content: line.content.slice(-16000) })),
  };
  const response = await fetch('/api/side-dialogue', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(args.workspaceContext && workspaceProjectHeaders(args.workspaceContext)) },
    body: JSON.stringify(body), signal: args.signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : data?.error?.message ?? `HTTP ${response.status}`);
  return data as SideDialogueReply;
}
