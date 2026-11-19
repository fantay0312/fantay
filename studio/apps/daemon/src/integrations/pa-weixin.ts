import { createDecipheriv, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { channelRecord as obj, channelText as str, readChannelJson, readPaAttachment, PaChannelTransportError, type PaChannelTransport, type PaInboundMessage, type PaInboundAttachment, type PaMediaAdmission, type PaOutboundMessage, type PaSendReceipt } from './pa-channel-transport.js';

// Protocol evidence: Tencent/openclaw-weixin @ 4746de126700699b6563f9b482f32f8d072892a7.
// Dedicated direct-chat protocol only; no ordinary friends/group-history access.
const DEFAULT_ORIGIN = 'https://ilinkai.weixin.qq.com';
const VERSION = '3.0.0-beta-0+fantaydesign';
const APP_HEADERS = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(3 << 16) };
export function weixinOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) throw new PaChannelTransportError('微信返回了不受信任的服务地址', 'rejected');
  return url.origin;
}
function headers(token?: string): Record<string, string> {
  return { ...APP_HEADERS, 'Content-Type': 'application/json', ...(token ? { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${token}`, 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') } : {}) };
}
function check(data: Record<string, unknown>): void {
  if (data.ret === -14 || data.errcode === -14) throw new PaChannelTransportError('微信登录已过期，请重新扫码连接', 'login');
  if (data.ret !== undefined && data.ret !== 0 || data.errcode !== undefined && data.errcode !== 0) throw new PaChannelTransportError(`微信拒绝请求（错误码 ${Number(data.errcode ?? data.ret)}）`, 'rejected');
}
export function normalizeWeixinMessage(raw: unknown): PaInboundMessage | null {
  const value = obj(raw);
  if (value.message_type !== 1 || value.group_id) return null;
  const id = str(value.message_id), senderId = str(value.from_user_id);
  if (!id || !senderId) return null;
  const items = Array.isArray(value.item_list) ? value.item_list.map(obj) : [];
  const text = items.map(item => item.type === 1 ? str(obj(item.text_item).text) :
    item.type === 3 ? str(obj(item.voice_item).text) : '').filter(Boolean).join('\n');
  const createdAt = Number(value.create_time_ms);
  return { id, senderId, chatId: senderId, tenantId: null, threadId: null, text,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(), direct: true, mentioned: false,
    ...(str(value.context_token) ? { contextToken: str(value.context_token) } : {}), unsupported: !text.trim() };
}
export interface WeixinLoginSession { qrCode: string; imageContent: string; origin: string; expiresAt: number; verifyCode?: string }
export interface WeixinLoginResult { status: string; botToken?: string; botId?: string; ownerId?: string; baseUrl?: string }
export class PaWeixinLoginClient {
  constructor(private request: typeof fetch = fetch) {}
  async begin(localTokens: string[] = []): Promise<WeixinLoginSession> {
    const response = await this.request(`${DEFAULT_ORIGIN}/ilink/bot/get_bot_qrcode?bot_type=3`, { method: 'POST', headers: headers(), body: JSON.stringify({ local_token_list: localTokens.filter(token => token.trim()).slice(0, 10) }), signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new PaChannelTransportError(`微信二维码服务暂不可用（${response.status}）`, 'rejected');
    const data = obj(await readChannelJson(response)); check(data);
    if (!str(data.qrcode) || !str(data.qrcode_img_content)) throw new PaChannelTransportError('微信没有返回有效的绑定二维码', 'rejected');
    return { qrCode: str(data.qrcode), imageContent: str(data.qrcode_img_content), origin: DEFAULT_ORIGIN, expiresAt: Date.now() + 5 * 60000 };
  }
  async poll(session: WeixinLoginSession, signal: AbortSignal): Promise<WeixinLoginResult> {
    const url = new URL('/ilink/bot/get_qrcode_status', weixinOrigin(session.origin));
    url.searchParams.set('qrcode', session.qrCode);
    if (session.verifyCode) url.searchParams.set('verify_code', session.verifyCode);
    const response = await this.request(url, { headers: APP_HEADERS, signal: AbortSignal.any([signal, AbortSignal.timeout(40000)]), redirect: 'error' });
    if (!response.ok) throw new PaChannelTransportError('微信扫码状态暂不可用，请重试', 'unknown');
    const data = obj(await readChannelJson(response)); check(data);
    const status = str(data.status);
    if (status === 'scaned_but_redirect') {
      session.origin = weixinOrigin(`https://${str(data.redirect_host)}`);
      return { status: 'waiting' };
    }
    if (status === 'confirmed') {
      if (!str(data.bot_token) || !str(data.ilink_bot_id) || !str(data.ilink_user_id)) throw new PaChannelTransportError('微信登录缺少账号或所有者信息，请重新绑定', 'login');
      return { status, botToken: str(data.bot_token), botId: str(data.ilink_bot_id), ownerId: str(data.ilink_user_id), baseUrl: weixinOrigin(str(data.baseurl) || DEFAULT_ORIGIN) };
    }
    if (status === 'scaned') delete session.verifyCode;
    return { status };
  }
}

export class PaWeixinTransport implements PaChannelTransport {
  readonly idempotencyWindowMs = 0; // client_id is not documented as a server-side deduplication guarantee.
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  constructor(private config: { token: string; baseUrl: string; ownerId: string; cursor: () => string; checkpoint: (cursor: string) => void; request?: typeof fetch; admitMedia?: PaMediaAdmission }) { weixinOrigin(config.baseUrl); }
  async start(onMessage: (message: PaInboundMessage) => Promise<void>, onState: (state: 'connecting' | 'connected' | 'login_required' | 'error', message?: string) => void): Promise<void> {
    if (this.abort) return;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    onState('connecting');
    this.loop = (async () => {
      let failures = 0, timeoutMs = 35000;
      while (!signal.aborted) {
        try {
          const response = await (this.config.request ?? fetch)(`${weixinOrigin(this.config.baseUrl)}/ilink/bot/getupdates`, { method: 'POST', headers: headers(this.config.token),
            body: JSON.stringify({ get_updates_buf: this.config.cursor(), base_info: { channel_version: VERSION, bot_agent: 'FantayDesign' } }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 5000)]), redirect: 'error' });
          if (!response.ok) throw new PaChannelTransportError('微信消息连接暂不可用', 'unknown');
          const data = obj(await readChannelJson(response)); check(data);
          if (signal.aborted) break;
          const messages = Array.isArray(data.msgs) ? data.msgs : [];
          for (const raw of messages) {
            const message = normalizeWeixinMessage(raw);
            if (!message) continue;
            if (this.config.admitMedia?.(message)) {
              const attachments = await this.attachments(raw, signal);
              if (attachments.length) { message.attachments = attachments; message.unsupported = false; }
            }
            if (!signal.aborted) await onMessage(message);
          }
          // Advance only after every incoming event is durably accepted/ignored.
          if (typeof data.get_updates_buf === 'string') this.config.checkpoint(data.get_updates_buf);
          if (typeof data.longpolling_timeout_ms === 'number') timeoutMs = Math.max(1000, Math.min(55000, data.longpolling_timeout_ms));
          failures = 0; onState('connected');
          if (!messages.length) await delay(250, undefined, { signal });
        } catch (error) {
          if (signal.aborted) break;
          if (error instanceof PaChannelTransportError && error.kind === 'login') { onState('login_required', error.message); break; }
          failures += 1; onState('connecting', '微信连接中断，等待网络恢复');
          try { await delay(failures >= 3 ? 30000 : 2000, undefined, { signal }); } catch { break; }
        }
      }
    })();
  }
  async stop(): Promise<void> { this.abort?.abort(); await this.loop; this.abort = null; this.loop = null; }
  private async attachments(raw: unknown, signal: AbortSignal): Promise<PaInboundAttachment[]> {
    const items = obj(raw).item_list;
    const attachments: PaInboundAttachment[] = [];
    if (!Array.isArray(items)) return attachments;
    for (const item of items.map(obj).filter(item => item.type === 2 || item.type === 4 ||
      item.type === 3 && !str(obj(item.voice_item).text).trim()).slice(0, 3)) {
      const payload = obj(item.type === 2 ? item.image_item : item.type === 3 ? item.voice_item : item.file_item), media = obj(payload.media);
      const parameter = str(media.encrypt_query_param);
      if (!str(media.full_url) && !parameter) continue;
      try {
        const url = new URL(str(media.full_url) || 'https://novac2c.cdn.weixin.qq.com/c2c/download');
        if (!str(media.full_url)) url.searchParams.set('encrypted_query_param', parameter);
        if (url.username || url.password || url.port || url.protocol !== 'https:' || !url.hostname.endsWith('.cdn.weixin.qq.com')) continue;
        const response = await (this.config.request ?? fetch)(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
        const encrypted = await readPaAttachment(response);
        const encoded = Buffer.from(str(media.aes_key), 'base64');
        const hex = str(payload.aeskey) || encoded.toString('utf8');
        const key = /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex') : encoded.length === 16 ? encoded : null;
        if (item.type !== 2 && !key) continue;
        const decipher = key ? createDecipheriv('aes-128-ecb', key, null) : null;
        const data = decipher ? Buffer.concat([decipher.update(encrypted), decipher.final()]) : encrypted;
        const name = str(payload.file_name);
        const pcm = item.type === 3 && payload.encode_type === 1 && payload.bits_per_sample === 16 ? Number(payload.sample_rate) : null;
        attachments.push({ data, ...(name ? { name } : {}), ...(item.type === 3 ? { audio: true } : {}),
          ...(pcm !== null && Number.isInteger(pcm) ? { pcmSampleRate: pcm } : {}) });
      } catch { /* Unavailable media is handled by the channel's text fallback. */ }
    }
    return attachments;
  }
  async send(message: PaOutboundMessage, signal: AbortSignal): Promise<PaSendReceipt> {
    if (message.chatId !== this.config.ownerId || !message.contextToken) throw new PaChannelTransportError('微信回复缺少已绑定所有者的有效会话上下文，请先从微信发送消息', 'rejected');
    try {
      const response = await (this.config.request ?? fetch)(`${weixinOrigin(this.config.baseUrl)}/ilink/bot/sendmessage`, { method: 'POST', headers: headers(this.config.token), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error', body: JSON.stringify({
        msg: { from_user_id: '', to_user_id: message.chatId, client_id: message.requestId, message_type: 2, message_state: 2, context_token: message.contextToken, item_list: [{ type: 1, text_item: { text: message.text } }] },
        base_info: { channel_version: VERSION, bot_agent: 'FantayDesign' },
      }) });
      if (!response.ok) throw new PaChannelTransportError('微信发送未取得可靠回执，结果待核对', 'unknown');
      const raw = await readChannelJson(response);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PaChannelTransportError('微信没有返回有效回执对象，结果待核对', 'unknown');
      const data = obj(raw); check(data);
      // Tencent's protobuf JSON omits the default ret=0. Its official sender
      // accepts an HTTP-success JSON object unless a nonzero error is present.
      return { messageId: str(data.message_id) || null, acknowledged: true };
    } catch (error) { if (error instanceof PaChannelTransportError) throw error; throw new PaChannelTransportError('微信发送未取得可靠回执，结果待核对；不会自动重发', 'unknown'); }
  }
}
