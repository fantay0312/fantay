import * as Lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';
import { channelRecord as obj, channelText as str, PA_ATTACHMENT_BYTES, PaChannelTransportError, type PaChannelTransport, type PaInboundMessage, type PaMediaAdmission, type PaOutboundMessage, type PaSendReceipt } from './pa-channel-transport.js';

const quietLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
export type PaFeishuBrand = 'feishu' | 'lark';

interface FeishuDataFrame { headers: Array<{ key: string; value: string }>; payload: Uint8Array }
interface FeishuSdkFrameHandler {
  handleEventData(frame: FeishuDataFrame): Promise<void>;
  dataCache: {
    mergeData(input: { message_id: string; trace_id: string; sum: number; seq: number; data: Uint8Array }): Record<string, unknown> | undefined;
  };
  sendMessage(frame: FeishuDataFrame): void;
}

/** The pinned SDK's dispatcher handles card actions, but its socket dispatches only event frames. */
export function attachPaFeishuCardFrames(client: Lark.WSClient, dispatcher: Lark.EventDispatcher): void {
  const socket = client as unknown as FeishuSdkFrameHandler;
  const handleEvent = socket.handleEventData.bind(socket);
  socket.handleEventData = async frame => {
    const headers = Object.fromEntries(frame.headers.map(header => [header.key, header.value]));
    if (headers.type !== 'card') return handleEvent(frame);
    const { message_id, trace_id } = headers;
    const sum = Number(headers.sum ?? 1), seq = Number(headers.seq ?? 0);
    if (!message_id || !Number.isInteger(sum) || sum < 1 || sum > 64 || frame.payload.byteLength > 1024 * 1024) return;
    const started = Date.now();
    let ack: { code: number; data?: string };
    try {
      const merged = socket.dataCache.mergeData({ message_id, trace_id: trace_id ?? '', sum, seq, data: frame.payload });
      if (!merged) return;
      const result = await dispatcher.invoke(merged, { needCheck: false });
      ack = { code: 200, ...(result ? { data: Buffer.from(JSON.stringify(result)).toString('base64') } : {}) };
    } catch { ack = { code: 500 }; }
    socket.sendMessage({
      ...frame, headers: [...frame.headers.filter(header => header.key !== 'biz_rt'), { key: 'biz_rt', value: String(Date.now() - started) }],
      payload: new TextEncoder().encode(JSON.stringify(ack)),
    });
  };
}

interface PaFeishuAppCredentials {
  client_id: string;
  client_secret: string;
  user_info?: { tenant_brand?: PaFeishuBrand };
}

export function registerPaFeishuApp(name: string, signal: AbortSignal, onQRCodeReady: (info: { url: string; expireIn: number }) => void): Promise<PaFeishuAppCredentials> {
  return Lark.registerApp({
    source: 'fantay', signal, onQRCodeReady, createOnly: true, appPreset: { name },
    addons: {
      preset: false,
      scopes: { tenant: ['im:message.p2p_msg:readonly', 'im:message.group_at_msg:readonly', 'im:message:send_as_bot', 'im:resource'] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
      callbacks: { items: ['card.action.trigger'] },
    },
  });
}

/** Rich posts are used by Feishu topic chats. Never fetch embedded resources. */
function postText(content: Record<string, unknown>, mentions: Record<string, unknown>[], botOpenId: string): string {
  const post = Array.isArray(content.content) ? content : ['zh_cn', 'en_us', 'ja_jp'].map(locale => obj(content[locale])).find(value => Array.isArray(value.content));
  if (!post || !Array.isArray(post.content)) return '';
  const lines = [str(post.title)];
  for (const paragraph of post.content) {
    if (!Array.isArray(paragraph)) continue;
    lines.push(paragraph.map(value => {
      const node = obj(value);
      switch (node.tag) {
        case 'text': return str(node.text);
        case 'a': return str(node.text) + (str(node.href) ? ` (${str(node.href)})` : '');
        case 'code_block': return `\n${str(node.text)}\n`;
        case 'at': {
          const id = str(node.user_id);
          const mention = mentions.find(item => str(item.key) === id || str(obj(item.id).open_id) === id);
          if (mention && str(obj(mention.id).open_id) === botOpenId) return '';
          return mention ? `@${str(mention.name) || id}` : '';
        }
        // Media, dividers and unknown nodes cannot become an executable goal.
        default: return '';
      }
    }).join(''));
  }
  return lines.join('\n').trim();
}

export function normalizeFeishuMessage(raw: unknown, botOpenId: string): PaInboundMessage | null {
  const root = obj(raw), event = obj(root.event ?? root), sender = obj(event.sender), message = obj(event.message);
  if (sender.sender_type !== 'user' || !['text', 'post', 'image', 'file', 'audio'].includes(str(message.message_type))) return null;
  const senderId = str(obj(sender.sender_id).open_id), id = str(message.message_id), chatId = str(message.chat_id);
  if (!senderId || !id || !chatId || senderId === botOpenId) return null;
  const mentions = Array.isArray(message.mentions) ? message.mentions.map(obj) : [];
  let text = '';
  try {
    const content = obj(JSON.parse(str(message.content)));
    text = message.message_type === 'post' ? postText(content, mentions, botOpenId) : str(content.text);
  } catch { return null; }
  const mentioned = mentions.some(mention => str(obj(mention.id).open_id) === botOpenId);
  for (const mention of mentions) if (str(obj(mention.id).open_id) === botOpenId && str(mention.key)) text = text.replaceAll(str(mention.key), '').trim();
  const media = ['image', 'file', 'audio'].includes(str(message.message_type));
  if (!text.trim() && !media) return null;
  const createdAt = Number(message.create_time);
  return { id, senderId, chatId, tenantId: str(sender.tenant_key) || str(obj(root.header).tenant_key) || null,
    threadId: str(message.thread_id) || str(message.root_id) || null, text,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(), direct: message.chat_type === 'p2p', mentioned, ...(media ? { unsupported: true } : {}) };
}

export class PaFeishuTransport implements PaChannelTransport {
  readonly idempotencyWindowMs = 3600000;
  private client: Lark.Client;
  private ws: Lark.WSClient | null = null;
  private stopped = false;
  constructor(private config: { appId: string; appSecret: string; brand?: PaFeishuBrand; admitMedia?: PaMediaAdmission }) {
    this.client = new Lark.Client({ ...config, appType: Lark.AppType.SelfBuild, domain: this.domain, logger: quietLogger });
  }
  private get domain() { return this.config.brand === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu; }
  async identity(): Promise<{ openId: string; name: string }> {
    const response = obj(await this.client.request({ url: '/open-apis/bot/v3/info', method: 'GET', timeout: 12000 }));
    const bot = obj(response.bot);
    if (response.code !== 0 || !str(bot.open_id)) throw new PaChannelTransportError('无法确认飞书机器人身份，请检查应用凭据、机器人能力与发布状态', 'login');
    return { openId: str(bot.open_id), name: str(bot.app_name) || '飞书机器人' };
  }
  async start(onMessage: (message: PaInboundMessage) => Promise<void>, onState: (state: 'connecting' | 'connected' | 'login_required' | 'error', message?: string) => void): Promise<void> {
    this.stopped = false;
    onState('connecting');
    const identity = await this.identity();
    if (this.stopped) return;
    this.ws = new Lark.WSClient({ ...this.config, domain: this.domain, logger: quietLogger, source: 'FantayDesign-PA', handshakeTimeoutMs: 15000, wsConfig: { pingTimeout: 60 },
      onReady: () => { if (!this.stopped) onState('connected'); },
      onReconnected: () => { if (!this.stopped) onState('connected'); },
      onReconnecting: () => { if (!this.stopped) onState('connecting', '飞书连接中断，正在重连'); },
      onError: () => { if (!this.stopped) onState('error', '飞书长连接未建立，请检查事件订阅与应用权限'); },
    });
    const eventDispatcher = new Lark.EventDispatcher({ logger: quietLogger }).register({
      'im.message.receive_v1': async data => {
        if (this.stopped) return;
        const message = normalizeFeishuMessage(data, identity.openId);
        if (!message) return;
        if (message.unsupported && this.config.admitMedia?.(message)) await this.attach(data, message);
        if (!this.stopped) await onMessage(message);
      },
      'card.action.trigger': async (data: unknown) => {
        const event = obj(data);
        const action = Lark.normalizeCardAction(data as Parameters<typeof Lark.normalizeCardAction>[0]);
        const value = str(obj(action?.action.value).v);
        const tenantId = str(event.tenant_key) || str(obj(event.header).tenant_key) || str(obj(event.operator).tenant_key);
        if (this.stopped || !action || !value || !tenantId) return;
        await onMessage({
          id: `action:${action.messageId}:${value}`, senderId: action.operator.openId, chatId: action.chatId,
          tenantId, threadId: null, text: '', createdAt: Date.now(), direct: true, mentioned: true,
          action: value, actionMessageId: action.messageId,
        });
      },
    });
    attachPaFeishuCardFrames(this.ws, eventDispatcher);
    await this.ws.start({ eventDispatcher });
  }
  private async attach(data: unknown, message: PaInboundMessage): Promise<void> {
    try {
      const root = obj(data), raw = obj(obj(root.event ?? root).message), content = obj(JSON.parse(str(raw.content)));
      const type = raw.message_type === 'image' ? 'image' : 'file';
      const key = str(type === 'image' ? content.image_key : content.file_key);
      if (!key) return;
      const stream = await this.client.request<Readable>({
        url: `/open-apis/im/v1/messages/${encodeURIComponent(message.id)}/resources/${encodeURIComponent(key)}`,
        params: { type }, method: 'GET', responseType: 'stream', timeout: 10000, signal: AbortSignal.timeout(10000),
      });
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (this.stopped || total > PA_ATTACHMENT_BYTES) return;
        chunks.push(bytes);
      }
      message.attachments = [{
        data: Buffer.concat(chunks), ...(str(content.file_name) ? { name: str(content.file_name) } : {}),
        ...(raw.message_type === 'audio' ? { audio: true } : {}),
      }];
      message.unsupported = false;
    } catch { /* The text fallback explains that the attachment could not be read. */ }
  }
  async stop(): Promise<void> { this.stopped = true; this.ws?.close({ force: true }); this.ws = null; }
  private validateResponse(response: Record<string, unknown>): void {
    if (response.code === 0) return;
    const code = Number(response.code);
    if ([99991661, 99991663, 99991664, 99991668, 99991672].includes(code)) throw new PaChannelTransportError('飞书登录或应用授权已失效，请重新连接', 'login');
    if ([99991400, 99991401, 99991403, 230020].includes(code)) throw new PaChannelTransportError('飞书调用频率受限，等待后重试', 'rate_limit', 30000);
    throw new PaChannelTransportError(`飞书拒绝请求（错误码 ${Number.isFinite(code) ? code : 'unknown'}），请检查机器人权限与可见范围`, 'rejected');
  }
  async send(message: PaOutboundMessage, signal: AbortSignal): Promise<PaSendReceipt> {
    const reply = Boolean(message.threadId && message.replyTo);
    const url = reply ? `/open-apis/im/v1/messages/${encodeURIComponent(message.replyTo!)}/reply` : '/open-apis/im/v1/messages';
    try {
      const response = obj(await this.client.request({ url, method: 'POST', timeout: 15000, signal,
        ...(reply ? {} : { params: { receive_id_type: 'chat_id' } }),
        data: { msg_type: message.buttons?.length ? 'interactive' : 'text',
          content: message.buttons?.length ? this.card(message.text, message.buttons) : JSON.stringify({ text: message.text }), uuid: message.requestId,
          ...(reply ? { reply_in_thread: true } : { receive_id: message.chatId }) },
      }));
      this.validateResponse(response);
      const messageId = str(obj(response.data).message_id);
      if (!messageId) throw new PaChannelTransportError('飞书已接收请求但未返回消息标识，结果待核对', 'unknown');
      return { messageId, acknowledged: true };
    } catch (error) { if (error instanceof PaChannelTransportError) throw error; throw new PaChannelTransportError('飞书发送未取得可靠回执，结果待核对', 'unknown'); }
  }
  private card(text: string, buttons: NonNullable<PaOutboundMessage['buttons']>): string {
    return JSON.stringify({ schema: '2.0', config: { update_multi: true }, body: { elements: [
      { tag: 'markdown', content: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') },
      ...buttons.map(button => ({
        tag: 'button', type: 'default', text: { tag: 'plain_text', content: button.label.slice(0, 40) },
        behaviors: [{ type: 'callback', value: { v: button.data } }],
      })),
    ] } });
  }
  async clearButtons(_chatId: string, _direct: boolean, messageId: string, text: string): Promise<void> {
    const response = obj(await this.client.request({
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, method: 'PATCH', timeout: 10000,
      data: { content: this.card(text, []) },
    }));
    this.validateResponse(response);
  }
  async receipt(messageId: string, signal: AbortSignal): Promise<boolean> {
    const response = obj(await this.client.request({ url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, method: 'GET', timeout: 10000, signal }));
    this.validateResponse(response);
    const items = obj(response.data).items;
    return Array.isArray(items) && items.some(item => str(obj(item).message_id) === messageId);
  }
}
