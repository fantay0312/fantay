import { AsyncLocalStorage } from 'node:async_hooks';
import { PA_IM_PLATFORMS, type PaImPlatform } from '@open-design/contracts';
import dingtalk from './vendor/ds-bot-im/platforms/dingtalk.js';
import discord from './vendor/ds-bot-im/platforms/discord.js';
import qq from './vendor/ds-bot-im/platforms/qq.js';
import slack from './vendor/ds-bot-im/platforms/slack.js';
import telegram from './vendor/ds-bot-im/platforms/telegram.js';
import wecom from './vendor/ds-bot-im/platforms/wecom.js';
import { PaChannelTransportError, readPaAttachment, type PaChannelTransport, type PaInboundMessage, type PaInboundAttachment, type PaMediaAdmission, type PaOutboundMessage } from './pa-channel-transport.js';

type Chat = { key: string; kind: 'direct' | 'group'; title: string };
type Sender = { id: string; name: string };
type Status = { state: 'connecting' | 'ready' | 'retrying' | 'error'; account?: { id: string; name: string } };
type ImMessage = {
  chat: Chat; sender: Sender; text: string; mentioned: boolean; messageId: string | number;
  attachmentCount?: number; threadId?: string;
  images?: Array<{ data: string }>; files?: Array<{ name: string; data?: Uint8Array; audio?: boolean }>;
  createdAt?: number;
};
type ImAction = { chat: Chat; sender: Sender; data: string; messageId: string | number };
type TransportEnv = {
  fetch: typeof fetch; WebSocket: typeof WebSocket;
  admitMedia: (chatId: string, senderId: string, direct: boolean, mentioned: boolean) => boolean;
  readAttachment: typeof readPaAttachment;
};
interface AdapterHandle {
  send(chat: Chat, message: { text: string; buttons?: PaOutboundMessage['buttons']; replyTo?: string | null; threadId?: string | null }): Promise<{ messageId?: string | number }>;
  edit?(chat: Chat, messageId: string, message: { text: string; buttons: [] }): Promise<void>;
  typing?(chat: Chat): Promise<void>;
  stop(): void;
}
interface Adapter {
  check(fields: Record<string, string>, env: TransportEnv): Promise<{ account: { id: string; name: string } }>;
  connect(fields: Record<string, string>, env: TransportEnv, handlers: {
    onMessage(message: ImMessage): Promise<void>;
    onAction(action: ImAction): Promise<void>;
    onStatus(status: Status): void;
  }): AdapterHandle;
}

const adapters = { dingtalk, discord, qq, slack, telegram, wecom } as unknown as Record<PaImPlatform, Adapter>;
const hosts: Record<PaImPlatform, string[]> = {
  dingtalk: ['dingtalk.com', 'dingtalkapps.com'],
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net'],
  qq: ['qq.com', 'sgameglobal.com'],
  slack: ['slack.com', 'slack-edge.com', 'slack-msgs.com'],
  telegram: ['api.telegram.org'],
  wecom: ['weixin.qq.com', 'qpic.cn'],
};

function validateUrl(type: PaImPlatform, raw: string | URL, protocol: 'https:' | 'wss:'): URL {
  const url = new URL(raw);
  if (url.protocol !== protocol || url.username || url.password || url.port ||
    !hosts[type].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)))
    throw new PaChannelTransportError('渠道返回了无效的服务地址', 'rejected');
  return url;
}

export function readPaImCredentials(type: PaImPlatform, input: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const field of PA_IM_PLATFORMS[type].fields) {
    const value = input[field.key];
    if (typeof value !== 'string' || !/^[A-Za-z0-9_:.=+\/-]{1,500}$/.test(value.trim()))
      throw new PaChannelTransportError(`请输入有效的 ${field.label}`, 'login');
    output[field.key] = value.trim();
  }
  return output;
}

export class PaImTransport implements PaChannelTransport {
  readonly idempotencyWindowMs = 0;
  private readonly lifecycle = new AbortController();
  private readonly requestSignal = new AsyncLocalStorage<AbortSignal>();
  private handle: AdapterHandle | undefined;
  private readonly env: TransportEnv;

  constructor(private readonly type: PaImPlatform, private readonly fields: Record<string, string>, admitMedia?: PaMediaAdmission) {
    this.env = {
      fetch: async (input, init) => {
        const raw = typeof input === 'string' || input instanceof URL ? input : input.url;
        const signals = [this.lifecycle.signal, this.requestSignal.getStore(), init?.signal].filter((signal): signal is AbortSignal => !!signal);
        if (!init?.signal) signals.push(AbortSignal.timeout(30000));
        return fetch(validateUrl(type, raw, 'https:'), { ...init, signal: AbortSignal.any(signals), redirect: 'error' });
      },
      WebSocket: class extends WebSocket {
        constructor(url: string | URL, protocols?: ConstructorParameters<typeof WebSocket>[1]) {
          super(validateUrl(type, url, 'wss:'), protocols);
        }
      },
      admitMedia: (chatId, senderId, direct, mentioned) => Boolean(admitMedia?.({ chatId, senderId, direct, mentioned, tenantId: null })),
      readAttachment: readPaAttachment,
    };
  }
  async identity(): Promise<{ id: string; name: string }> {
    try {
      const { account } = await adapters[this.type].check(this.fields, this.env);
      if (!account?.id) throw new Error('missing account');
      return account;
    } catch { throw new PaChannelTransportError('无法验证机器人凭据，请检查平台设置与网络', 'login'); }
  }
  async start(onMessage: (message: PaInboundMessage) => Promise<void>, onState: Parameters<PaChannelTransport['start']>[1]): Promise<void> {
    this.handle = adapters[this.type].connect(this.fields, this.env, {
      onStatus: ({ state }) => {
        if (this.lifecycle.signal.aborted) return;
        if (state === 'ready') onState('connected');
        else if (state === 'error') onState('error', '机器人连接失败，请检查凭据、平台权限与网络');
        else onState('connecting');
      },
      onMessage: async ({ chat, sender, messageId, text, mentioned, threadId, attachmentCount, images, files, createdAt }) => {
        if (this.lifecycle.signal.aborted || !sender.id || !chat.key || messageId == null || !String(messageId) ||
          (!text.trim() && !attachmentCount)) return;
        const attachments: PaInboundAttachment[] = [
          ...(images ?? []).map(image => ({ data: Buffer.from(image.data, 'base64') })),
          ...(files ?? []).flatMap(file => file.data ? [{ name: file.name, data: file.data, ...(file.audio ? { audio: true as const } : {}) }] : []),
        ];
        await onMessage({
          id: String(messageId), senderId: sender.id, chatId: chat.key, text,
          tenantId: null, threadId: threadId || null, direct: chat.kind === 'direct', mentioned,
          createdAt: Number.isFinite(createdAt) && createdAt! > 0 ? createdAt! : Date.now(),
          unsupported: Boolean(attachmentCount && !attachments.length && !text.trim()),
          ...(attachments.length ? { attachments } : {}),
        });
      },
      onAction: async ({ chat, sender, data, messageId }) => {
        if (this.lifecycle.signal.aborted || !sender.id || !chat.key || !data || !String(messageId ?? '')) return;
        await onMessage({
          id: `action:${messageId}:${data}`, senderId: sender.id, chatId: chat.key, text: '',
          tenantId: null, threadId: null, direct: chat.kind === 'direct', mentioned: true,
          createdAt: Date.now(), action: data, actionMessageId: String(messageId),
        });
      },
    });
  }
  async stop(): Promise<void> {
    this.lifecycle.abort();
    this.handle?.stop();
    this.handle = undefined;
  }
  private chat(chatId: string, direct?: boolean): Chat {
    return { key: chatId, kind: direct === false ? 'group' : 'direct', title: '' };
  }
  async send(message: PaOutboundMessage, signal: AbortSignal) {
    if (!this.handle || this.lifecycle.signal.aborted || signal.aborted) throw new PaChannelTransportError('机器人当前未连接', 'unknown');
    try {
      const receipt = await this.requestSignal.run(signal, () => this.handle!.send(this.chat(message.chatId, message.direct), message));
      return { messageId: receipt.messageId ? String(receipt.messageId) : null, acknowledged: true as const };
    } catch {
      // A provider adapter may have delivered earlier chunks. Keep the receipt
      // uncertain rather than retrying the entire reply and duplicating those.
      throw new PaChannelTransportError('消息发送未取得完整回执', 'unknown');
    }
  }
  async typing(chatId: string, direct?: boolean): Promise<void> {
    await this.handle?.typing?.(this.chat(chatId, direct));
  }
  async clearButtons(chatId: string, direct: boolean, messageId: string, text: string): Promise<void> {
    await this.handle?.edit?.(this.chat(chatId, direct), messageId, { text, buttons: [] });
  }
}
