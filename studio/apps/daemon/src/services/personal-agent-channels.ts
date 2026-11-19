import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { isPaImPlatform, paTaskInputSchema, paOutboxAuthorizationMatches, type PaChannel, type PaChannelInput, type PaChannelInbox, type PaChannelOutbox, type PaChannelSnapshot, type PaChannelLogin, type PaChannelPairing, type PaFeishuRegistration, type PaProjectApproval, type PaTask, type PaAttempt, type PaEntity } from '@open-design/contracts';
import { FileConnectorCredentialStore, type ConnectorCredentialStore } from '../connectors/service.js';
import { PaError, type PaStore } from '../storage/personal-agent-store.js';
import type { PersonalAgentService } from './personal-agent-service.js';
import { summarizePaOutput } from './personal-agent-output.js';
import { PaFeishuTransport, registerPaFeishuApp } from '../integrations/pa-feishu.js';
import { PaImTransport, readPaImCredentials } from '../integrations/pa-im.js';
import { PaWeixinLoginClient, PaWeixinTransport, type WeixinLoginSession } from '../integrations/pa-weixin.js';
import { PaChannelTransportError, channelRecord as obj, channelText as str, type PaChannelTransport, type PaInboundMessage, type PaMediaAdmission, type PaOutboundMessage } from '../integrations/pa-channel-transport.js';
import { redactPaCredentials } from './personal-agent-gateway.js';
import { preparePaChannelAttachments, resolvePaChannelAttachments, type PaChannelAttachments } from './pa/channel-attachments.js';
import { transcribePaAudioFile } from './personal-agent-voice.js';

interface ChannelRecord extends PaChannel {
  credentialRef: string; cursor: string; accountKey: string | null; contextRefs?: string[];
  relaySince?: number; remoteDirect?: boolean; archivedAt?: number;
}
interface InboxRecord extends PaChannelInbox {
  text: string; authorizationVersion: number; direct: boolean; contextRef: string | null; unsupported: boolean;
  taskInput?: import('@open-design/contracts').PaTaskInput; action?: string; actionMessageId?: string;
}
interface OutboxRecord extends PaChannelOutbox {
  text: string; firstAttemptAt: number | null; textHash: string; uncertainSince?: number | null; memoryRefs?: PaAttempt['memoryRefs'];
  buttons?: PaOutboundMessage['buttons'];
  cardSettled?: boolean;
}
interface PairingRecord extends PaEntity { channelId: string; codeHash: string; expiresAt: number; consumed: boolean; authorizationVersion?: number }
interface FeishuRegistrationSession { abort: AbortController; value: PaFeishuRegistration; authorizationVersion: number }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const FINAL_STATES = new Set(['completed', 'waiting', 'failed', 'cancelled']);
const MAX_EVENT_AGE = 30 * 60000;
const MAX_REPLY = 3200;
const TAIL = '完整结果已保存在 Fantay，请打开对应任务查看。';

export interface PaChannelServiceOptions {
  core: PersonalAgentService; dataDir: string; credentialStore?: ConnectorCredentialStore;
  acceptsNewWork?: () => boolean;
  transportFactory?: (channel: PaChannel, credentials: Record<string, unknown>, journal: { cursor: () => string; checkpoint: (cursor: string) => void }) => PaChannelTransport;
  weixinLogin?: PaWeixinLoginClient;
  registerFeishu?: typeof registerPaFeishuApp;
  transcribeAudio?: typeof transcribePaAudioFile;
}

/** The channel adapter only admits events and records receipts; PA owns all model execution. */
export class PersonalAgentChannels {
  private readonly store: PaStore;
  private readonly credentials: ConnectorCredentialStore;
  private readonly loginClient: PaWeixinLoginClient;
  private transports = new Map<string, PaChannelTransport>();
  private epochs = new Map<string, number>();
  private logins = new Map<string, { abort: AbortController; session: WeixinLoginSession; public: PaChannelLogin; epoch: number }>();
  private feishuRegistrations = new Map<string, FeishuRegistrationSession>();
  private outgoing = new Map<string, AbortController>();
  private mediaJob: { channelId: string; abort: AbortController } | undefined;
  private lastTyping = new Map<string, number>();
  private processing = false;
  private inFlight = new Set<Promise<void>>();
  private closing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private tickScheduled = false;
  constructor(private options: PaChannelServiceOptions) {
    this.store = options.core.store;
    this.credentials = options.credentialStore ?? new FileConnectorCredentialStore(options.dataDir);
    this.loginClient = options.weixinLogin ?? new PaWeixinLoginClient();
    for (const item of this.store.list<OutboxRecord>('channel_outbox')) if (item.state === 'sending') this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'unknown', uncertainSince: item.uncertainSince ?? item.firstAttemptAt ?? Date.now(), error: '后台曾退出，发送结果待核对' });
    for (const channel of this.store.list<ChannelRecord>('channels')) if (!channel.credentialConfigured && !channel.enabled && channel.contextRefs?.length) this.purgeContexts(channel.id);
  }
  start(): void {
    if (this.timer) return;
    this.closing = false;
    this.unsubscribe = this.store.subscribe((taskId, kind) => { if (taskId && kind.startsWith('task.')) this.scheduleTick(); });
    this.timer = setInterval(() => void this.tick(), 2000); this.timer.unref();
    for (const channel of this.store.list<ChannelRecord>('channels')) if (!channel.connectionId && channel.enabled && channel.credentialConfigured) void this.connect(channel.id).catch(() => {});
    void this.tick();
  }
  private scheduleTick(): void {
    if (this.tickScheduled || this.closing) return;
    this.tickScheduled = true;
    queueMicrotask(() => {
      this.tickScheduled = false;
      if (this.store.db.open) void this.tick();
    });
  }
  private record(id: string): ChannelRecord { return this.store.require<ChannelRecord>('channels', id); }
  private publicChannel(channel: ChannelRecord): PaChannel {
    const { credentialRef: _credentials, cursor: _cursor, accountKey: _account, contextRefs: _contexts, relaySince: _relay, remoteDirect: _direct, archivedAt: _archived, ...value } = channel;
    if (!channel.connectionId) return value;
    const connection = this.record(channel.connectionId);
    return {
      ...value, credentialConfigured: connection.credentialConfigured, accountLabel: connection.accountLabel,
      status: channel.enabled ? connection.status : 'disconnected',
      lastError: channel.enabled ? connection.lastError : null,
    };
  }
  private bindings(connectionId: string): ChannelRecord[] {
    return this.store.list<ChannelRecord>('channels').filter(channel => !channel.archivedAt && channel.connectionId === connectionId);
  }
  createBinding(connectionId: string, input: PaChannelInput): PaChannel {
    const connection = this.record(connectionId);
    if (connection.connectionId || connection.type === 'weixin' || !connection.enabled || !connection.credentialConfigured)
      throw new PaError('请先启用一个支持多会话的机器人连接');
    return this.store.transaction(() => {
      const channel = this.create({
        ...input, type: connection.type, allowedSenderIds: [], remoteChatId: null, tenantId: null,
      });
      return this.publicChannel(this.store.update<ChannelRecord>('channels', channel.id, {
        enabled: true, connectionId, accountKey: connection.accountKey, credentialConfigured: true,
      }));
    });
  }
  private deactivateBindings(connectionId: string, forget: boolean): void {
    for (const child of this.bindings(connectionId)) {
      this.store.update<ChannelRecord>('channels', child.id, {
        enabled: false, authorizationVersion: child.authorizationVersion + 1,
        ...(forget ? { accountKey: null, allowedSenderIds: [], remoteChatId: null, tenantId: null } : {}),
      });
      this.options.core.revokeChannel(child.id);
      this.cancelPendingOutbox(child.id);
      this.outgoing.get(child.id)?.abort();
      this.cancelMedia(child.id);
    }
  }
  private publicOutbox({ text: _text, firstAttemptAt: _first, textHash: _hash, uncertainSince: _uncertain, memoryRefs: _memoryRefs, buttons: _buttons, cardSettled: _card, ...value }: OutboxRecord): PaChannelOutbox {
    return value;
  }
  private actionableApproval(inbox: InboxRecord, now: number): boolean {
    if (inbox.state !== 'approval' || !inbox.approvalId) return false;
    const approval = this.store.get<PaProjectApproval>('approvals', inbox.approvalId);
    const channel = this.store.get<ChannelRecord>('channels', inbox.channelId);
    return approval?.state === 'pending' && approval.inboxId === inbox.id && approval.channelId === inbox.channelId &&
      !!channel?.enabled && channel.authorizationVersion === approval.authorizationVersion && approval.expiresAt > now;
  }
  pendingApprovalCount(): number {
    const now = Date.now();
    return this.store.list<InboxRecord>('channel_inbox').filter(inbox => this.actionableApproval(inbox, now)).length;
  }
  snapshot(): PaChannelSnapshot {
    const now = Date.now();
    const inbox = this.store.list<InboxRecord>('channel_inbox');
    const actionable = inbox.filter(row => this.actionableApproval(row, now));
    const actionableIds = new Set(actionable.map(row => row.id));
    const recent = inbox.slice(-100);
    const recentIds = new Set(recent.map(row => row.id));
    return { channels: this.store.list<ChannelRecord>('channels').filter(channel => !channel.archivedAt).map(channel => this.publicChannel(channel)),
      inbox: [...actionable.filter(row => !recentIds.has(row.id)), ...recent].map(({ text: _text, taskInput: _input, authorizationVersion: _auth, direct: _direct, contextRef: _context, unsupported: _unsupported, action: _action, actionMessageId: _message, ...value }) =>
        value.state === 'approval' ? { ...value, approvalActionable: actionableIds.has(value.id) } : value),
      outbox: this.store.list<OutboxRecord>('channel_outbox').slice(-100).map(row => this.publicOutbox(row)) };
  }
  create(input: PaChannelInput): PaChannel {
    this.store.require(input.targetKind === 'agent' ? 'agents' : 'groups', input.targetId);
    const id = randomUUID();
    const channel = this.store.create<ChannelRecord>('channels', { ...input, enabled: false, authorizationVersion: 1, status: 'disconnected', credentialConfigured: false,
      credentialRef: `pa-channel:${id}`, cursor: '', accountKey: null, accountLabel: null, lastReceivedAt: null, lastSentAt: null, lastError: null,
      capabilities: { direct: true, groups: input.type !== 'weixin', threads: ['feishu', 'telegram', 'slack'].includes(input.type),
        files: ['feishu', 'weixin', 'telegram', 'discord', 'slack', 'wecom'].includes(input.type),
        unsolicited: input.type !== 'weixin' && input.type !== 'qq' },
      verification: { inboundAt: null, outboundAt: null, reconnectAt: null, reloginAt: null } }, id);
    return this.publicChannel(channel);
  }
  async update(id: string, input: PaChannelInput, revision: number): Promise<PaChannel> {
    const current = this.record(id);
    if (current.archivedAt) throw new PaError('此连接已移除', 404);
    if (current.type !== input.type) throw new PaError('不能更换已有连接的平台，请新建连接');
    this.store.require(input.targetKind === 'agent' ? 'agents' : 'groups', input.targetId);
    if (input.enabled && !current.connectionId && current.type !== 'weixin' && current.accountKey) this.assertExclusiveBot(current.type, id, current.accountKey);
    const connection = current.connectionId ? this.record(current.connectionId) : null;
    if (input.enabled && connection && (!connection.enabled || !connection.credentialConfigured))
      throw new PaError('请先启用机器人连接');
    if (current.type === 'weixin' && current.accountKey) {
      const credentials = this.credentials.get(current.credentialRef)?.credentials;
      if (input.allowedSenderIds.length !== 1 || input.allowedSenderIds[0] !== credentials?.ownerId || input.remoteChatId !== credentials?.ownerId) throw new PaError('个人微信仅允许扫码绑定的所有者单聊');
    }
    const previousChat = input.shareUpdates && !current.shareUpdates && current.remoteDirect === undefined
      ? this.store.list<InboxRecord>('channel_inbox').reverse().find(inbox => inbox.channelId === id && inbox.chatId === input.remoteChatId && inbox.state === 'accepted') : undefined;
    const next = this.store.update<ChannelRecord>('channels', id, { ...input,
      ...(connection ? { accountKey: connection.accountKey } : {}),
      ...(input.shareUpdates && !current.shareUpdates ? { relaySince: Date.now() } : {}),
      ...(previousChat ? { remoteDirect: previousChat.direct } : {}),
      authorizationVersion: current.authorizationVersion + 1,
    }, revision);
    this.cancelFeishuRegistration(id);
    this.options.core.revokeChannel(id);
    this.cancelMedia(id);
    this.cancelPendingOutbox(id);
    if (next.enabled && next.credentialConfigured) await this.connect(id); else {
      this.deactivateBindings(id, false);
      await this.stopTransport(id);
    }
    return this.publicChannel(this.record(id));
  }
  private state(id: string, status: PaChannel['status'], error: string | null = null): void {
    const current = this.record(id);
    if (current.status === status && current.lastError === error) return;
    this.store.update<ChannelRecord>('channels', id, { status, lastError: error,
      verification: status === 'connected' && current.status !== 'connected' ? { ...current.verification, reconnectAt: Date.now() } : current.verification });
  }
  private storeCredentials(channel: ChannelRecord, credentials: Record<string, unknown>): void {
    this.credentials.set({ schemaVersion: 1, connectorId: channel.credentialRef, accountLabel: channel.name, credentials, updatedAt: new Date().toISOString() });
  }
  private assertExclusiveBot(type: PaChannel['type'], id: string, accountKey: string): void {
    if (this.store.list<ChannelRecord>('channels').some(channel => channel.id !== id && !channel.connectionId && channel.type === type && channel.enabled && channel.accountKey === accountKey))
      throw new PaError('同一机器人只能启用一个 PA 连接，请先停用重复连接');
  }
  localFeishuApps(): Array<{ appId: string; label: string }> { return this.readLocalFeishuApps().map(item => ({ appId: str(item.appId), label: str(item.brand) || str(item.appId) })); }
  private readLocalFeishuApps(): Array<Record<string, unknown>> {
    try {
      // External CLI configuration is an explicitly selected integration input,
      // not a daemon-owned data root. Secrets never leave this service.
      const config = obj(JSON.parse(readFileSync(path.join(homedir(), '.lark-cli', 'config.json'), 'utf8')));
      const apps = Array.isArray(config.apps) ? config.apps : Object.values(obj(config.apps));
      return apps.map(obj).filter(item => str(item.appId) && str(item.appSecret));
    } catch { return []; }
  }
  async configureFeishu(id: string, input: { appId?: string; appSecret?: string; localAppId?: string; brand?: 'feishu' | 'lark' }): Promise<PaChannel> {
    const channel = this.record(id);
    if (channel.type !== 'feishu' || channel.connectionId || channel.archivedAt) throw new PaError('请从主连接配置飞书机器人');
    const source = input.localAppId ? this.readLocalFeishuApps().find(item => item.appId === input.localAppId) : input;
    const appId = str(source?.appId), appSecret = str(source?.appSecret);
    if (!/^cli_[a-zA-Z0-9]+$/.test(appId) || !appSecret || appSecret.length > 500) throw new PaError('请输入有效的飞书应用 ID 和 Secret');
    this.assertExclusiveBot(channel.type, id, appId);
    this.cancelFeishuRegistration(id);
    const localLark = input.localAppId && source && 'brand' in source && source.brand === 'lark';
    const sameLarkAccount = channel.accountKey === appId && this.credentials.get(channel.credentialRef)?.credentials.brand === 'lark';
    const brand = !input.localAppId && input.brand === 'feishu' ? 'feishu' : localLark || sameLarkAccount || input.brand === 'lark' ? 'lark' : 'feishu';
    const epoch = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, epoch);
    await this.stopTransport(id, epoch);
    if (this.epochs.get(id) !== epoch || this.record(id).authorizationVersion !== channel.authorizationVersion || this.closing) throw new PaError('连接操作已取消', 409);
    const identity = await new PaFeishuTransport({ appId, appSecret, brand }).identity();
    if (this.epochs.get(id) !== epoch || this.record(id).authorizationVersion !== channel.authorizationVersion || this.closing) throw new PaError('连接配置已改变，请重新操作', 409);
    this.assertExclusiveBot(channel.type, id, appId);
    this.options.core.revokeChannel(id); this.cancelPendingOutbox(id);
    if (channel.accountKey && channel.accountKey !== appId) this.deactivateBindings(id, true);
    this.purgeContexts(id);
    this.storeCredentials(channel, { provider: 'pa-feishu', appId, appSecret, brand });
    this.store.update<ChannelRecord>('channels', id, { enabled: true, credentialConfigured: true, accountLabel: identity.name, accountKey: appId, cursor: '', authorizationVersion: channel.authorizationVersion + 1,
      ...(channel.accountKey && channel.accountKey !== appId ? { allowedSenderIds: [], remoteChatId: null, tenantId: null } : {}) });
    await this.connect(id);
    return this.publicChannel(this.record(id));
  }
  async configureIm(id: string, input: Record<string, unknown>): Promise<PaChannel> {
    const channel = this.record(id);
    if (!isPaImPlatform(channel.type) || channel.connectionId || channel.archivedAt) throw new PaError('请从主连接配置机器人');
    const fields = readPaImCredentials(channel.type, input);
    const identity = await new PaImTransport(channel.type, fields).identity();
    const latest = this.record(id);
    if (this.closing || latest.authorizationVersion !== channel.authorizationVersion) throw new PaError('连接配置已改变，请重新操作', 409);
    this.assertExclusiveBot(channel.type, id, identity.id);
    this.storeCredentials(latest, { ...fields, provider: `pa-${channel.type}` });
    this.store.update<ChannelRecord>('channels', id, {
      enabled: true, credentialConfigured: true, accountLabel: identity.name, accountKey: identity.id, cursor: '',
      authorizationVersion: latest.authorizationVersion + 1,
      ...(latest.accountKey === identity.id ? {} : { allowedSenderIds: [], remoteChatId: null, tenantId: null }),
    });
    this.options.core.revokeChannel(id);
    if (latest.accountKey && latest.accountKey !== identity.id) this.deactivateBindings(id, true);
    this.cancelPendingOutbox(id);
    await this.connect(id);
    return this.publicChannel(this.record(id));
  }
  beginFeishuRegistration(id: string): PaFeishuRegistration {
    const channel = this.record(id);
    if (channel.type !== 'feishu' || channel.connectionId || channel.archivedAt || this.closing) throw new PaError('此连接无法创建飞书机器人', 409);
    if (channel.credentialConfigured) throw new PaError('此连接已配置机器人，请为新机器人新建连接', 409);
    const existing = this.feishuRegistrations.get(id);
    if (existing && ['starting', 'waiting'].includes(existing.value.status)) return existing.value;
    const session: FeishuRegistrationSession = {
      abort: new AbortController(), authorizationVersion: channel.authorizationVersion,
      value: { status: 'starting', expiresAt: 0, authorizationUrl: null, botUrl: null, error: null },
    };
    this.feishuRegistrations.set(id, session);
    void this.registerFeishuApp(id, channel.name, session);
    return session.value;
  }
  feishuRegistration(id: string): PaFeishuRegistration | null {
    const channel = this.record(id);
    return channel.type === 'feishu' ? this.feishuRegistrations.get(id)?.value ?? null : null;
  }
  async feishuRegistrationQr(id: string): Promise<Buffer> {
    const registration = this.feishuRegistration(id);
    if (!registration?.authorizationUrl || registration.expiresAt <= Date.now()) throw new PaError('飞书授权码已失效', 410);
    return QRCode.toBuffer(registration.authorizationUrl, { type: 'png', width: 300, margin: 2, errorCorrectionLevel: 'M' });
  }
  cancelFeishuRegistration(id: string): void {
    const session = this.feishuRegistrations.get(id);
    if (!session || !['starting', 'waiting'].includes(session.value.status)) return;
    session.value = { ...session.value, status: 'cancelled', authorizationUrl: null };
    session.abort.abort();
  }
  private async registerFeishuApp(id: string, name: string, session: FeishuRegistrationSession): Promise<void> {
    const signal = session.abort.signal;
    const readyTimeout = setTimeout(() => {
      if (signal.aborted) return;
      session.value = { ...session.value, status: 'failed', error: 'registration' };
      session.abort.abort();
    }, 30000);
    readyTimeout.unref();
    try {
      const register = this.options.registerFeishu ?? registerPaFeishuApp;
      const result = await register(name, signal, info => {
        signal.throwIfAborted();
        const link = new URL(info.url);
        if (!['https://open.feishu.cn', 'https://open.larksuite.com', 'https://accounts.feishu.cn', 'https://accounts.larksuite.com'].includes(link.origin) || link.username || link.password)
          throw new PaError('飞书授权链接格式不正确');
        clearTimeout(readyTimeout);
        session.value = { ...session.value, status: 'waiting', authorizationUrl: link.href, expiresAt: Date.now() + info.expireIn * 1000 };
      });
      if (signal.aborted || this.closing || this.feishuRegistrations.get(id) !== session) return;
      const channel = this.record(id);
      if (channel.authorizationVersion !== session.authorizationVersion || channel.credentialConfigured) {
        this.cancelFeishuRegistration(id);
        return;
      }
      const { client_id: appId, client_secret: appSecret } = result;
      if (!/^cli_[a-zA-Z0-9]+$/.test(appId) || !appSecret || appSecret.length > 500) throw new PaError('飞书返回的应用凭据格式不正确');
      this.assertExclusiveBot(channel.type, id, appId);
      const brand = result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu';
      const previousCredentials = this.credentials.get(channel.credentialRef);
      this.storeCredentials(channel, { provider: 'pa-feishu', appId, appSecret, brand });
      try {
        this.store.update<ChannelRecord>('channels', id, {
          enabled: true, credentialConfigured: true, status: 'connecting', accountKey: appId, accountLabel: channel.name,
          allowedSenderIds: [], remoteChatId: null, tenantId: null, lastError: null, authorizationVersion: channel.authorizationVersion + 1,
        });
      } catch (error) {
        if (previousCredentials) this.credentials.set(previousCredentials);
        else this.credentials.delete(channel.credentialRef);
        throw error;
      }
      const botUrl = new URL('/client/bot/open', brand === 'lark' ? 'https://applink.larksuite.com' : 'https://applink.feishu.cn');
      botUrl.searchParams.set('appId', appId);
      session.value = { ...session.value, status: 'confirmed', authorizationUrl: null, botUrl: botUrl.href };
      await this.connect(id);
    } catch (error) {
      if (signal.aborted) return;
      const code = obj(error).code;
      session.value = session.value.status === 'confirmed' ? { ...session.value, error: 'connection' } : {
        ...session.value, status: code === 'expired_token' ? 'expired' : 'failed', authorizationUrl: null,
        error: code === 'access_denied' ? 'denied' : code === 'expired_token' ? null : 'registration',
      };
    } finally { clearTimeout(readyTimeout); }
  }
  async beginWeixinLogin(id: string): Promise<PaChannelLogin> {
    const channel = this.record(id);
    if (channel.type !== 'weixin' || channel.archivedAt) throw new PaError('此连接无法进行微信登录');
    const epoch = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, epoch);
    await this.stopTransport(id, epoch);
    if (this.epochs.get(id) !== epoch || this.closing) throw new PaError('登录已取消', 409);
    const oldToken = str(this.credentials.get(channel.credentialRef)?.credentials.token);
    const session = await this.loginClient.begin(oldToken ? [oldToken] : []);
    if (this.epochs.get(id) !== epoch || this.closing) throw new PaError('登录已取消', 409);
    const login = { abort: new AbortController(), session, epoch, public: { channelId: id, status: 'waiting' as PaChannelLogin['status'], expiresAt: session.expiresAt, qrImagePath: `/api/pa/channels/${id}/qr.png?v=${Date.now()}`, message: '请用自己的微信扫描二维码，并在手机确认连接' } };
    this.logins.set(id, login);
    this.state(id, 'login_required');
    void this.pollLogin(id, login);
    return login.public;
  }
  loginStatus(id: string): PaChannelLogin {
    const channel = this.record(id), login = this.logins.get(id);
    if (login && !(login.public.status === 'confirmed' && channel.status === 'login_required')) return login.public;
    const confirmed = channel.credentialConfigured && channel.status !== 'login_required';
    return { channelId: id, status: confirmed ? 'confirmed' : 'expired', expiresAt: 0, qrImagePath: null, message: confirmed ? '已绑定微信账号' : '请重新获取二维码' };
  }
  async loginQr(id: string): Promise<Buffer> {
    const login = this.logins.get(id);
    if (!login || login.session.expiresAt < Date.now() || ['confirmed', 'expired', 'failed'].includes(login.public.status)) throw new PaError('二维码已失效，请重新登录', 410);
    return QRCode.toBuffer(login.session.imageContent, { type: 'png', width: 300, margin: 2, errorCorrectionLevel: 'M' });
  }
  verifyLogin(id: string, pin: string): PaChannelLogin {
    const login = this.logins.get(id);
    if (!login || login.public.status !== 'verify_code' || !/^\d{4,10}$/.test(pin)) throw new PaError('请输入手机显示的有效验证码');
    login.session.verifyCode = pin;
    return login.public;
  }
  private async pollLogin(id: string, login: { abort: AbortController; session: WeixinLoginSession; public: PaChannelLogin; epoch: number }): Promise<void> {
    try {
      while (!login.abort.signal.aborted && Date.now() < login.session.expiresAt && this.epochs.get(id) === login.epoch) {
        let result;
        try { result = await this.loginClient.poll(login.session, login.abort.signal); }
        catch (error) { if (login.abort.signal.aborted) return; if (error instanceof Error && error.name === 'TimeoutError') continue; throw error; }
        if (login.abort.signal.aborted || this.epochs.get(id) !== login.epoch) return;
        if (result.status === 'binded_redirect') {
          // Tencent returns this only for a bot matched by local_token_list:
          // the existing local credentials remain valid; no replacement is issued.
          const channel = this.record(id), credentials = this.credentials.get(channel.credentialRef)?.credentials;
          if (!channel.credentialConfigured || !str(credentials?.token) || !channel.accountKey || credentials?.botId !== channel.accountKey || credentials?.ownerId !== channel.remoteChatId || !channel.allowedSenderIds.includes(str(credentials?.ownerId))) throw new PaChannelTransportError('平台确认已绑定，但本机缺少匹配的登录信息，请重新绑定', 'login');
          this.store.update<ChannelRecord>('channels', id, { enabled: true, verification: { ...channel.verification, reloginAt: Date.now() } });
          login.public = { ...login.public, status: 'confirmed', qrImagePath: null, message: '微信已确认本机绑定，正在恢复原会话' };
          delete login.session.verifyCode; login.session.imageContent = ''; login.session.qrCode = '';
          await this.connect(id); return;
        }
        if (result.status === 'confirmed') {
          const channel = this.record(id);
          const oldCredentials = this.credentials.get(channel.credentialRef)?.credentials;
          const sameAccount = channel.accountKey === result.botId && oldCredentials?.ownerId === result.ownerId;
          if (!sameAccount) { this.options.core.revokeChannel(id); this.cancelPendingOutbox(id); this.purgeContexts(id); }
          this.storeCredentials(channel, { provider: 'pa-weixin', token: result.botToken!, baseUrl: result.baseUrl!, ownerId: result.ownerId!, botId: result.botId! });
          this.store.update<ChannelRecord>('channels', id, { enabled: true, credentialConfigured: true, accountLabel: result.botId!, accountKey: result.botId!, allowedSenderIds: [result.ownerId!], remoteChatId: result.ownerId!, tenantId: null, cursor: sameAccount ? channel.cursor : '', authorizationVersion: sameAccount ? channel.authorizationVersion : channel.authorizationVersion + 1,
            verification: { ...channel.verification, reloginAt: channel.credentialConfigured ? Date.now() : channel.verification.reloginAt } });
          login.public = { ...login.public, status: 'confirmed', qrImagePath: null, message: '微信已绑定；请在微信专用会话发送一条消息开始验证' };
          delete login.session.verifyCode; login.session.imageContent = ''; login.session.qrCode = '';
          await this.connect(id); return;
        }
        if (['expired', 'verify_code_blocked'].includes(result.status)) { login.public = { ...login.public, status: 'expired', qrImagePath: null, message: '二维码或验证码已失效，请重新获取' }; return; }
        login.public = { ...login.public, status: result.status.includes('need_verifycode') ? 'verify_code' : result.status === 'scaned' ? 'scanned' : 'waiting', message: result.status.includes('need_verifycode') ? '请在此输入手机显示的验证码' : result.status === 'scaned' ? '已扫描，请在手机确认' : '等待微信扫码确认' };
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!login.abort.signal.aborted) login.public = { ...login.public, status: 'expired', qrImagePath: null, message: '二维码已过期，请重新获取' };
    } catch (error) {
      login.public = { ...login.public, status: 'failed', qrImagePath: null, message: error instanceof PaChannelTransportError ? error.message : '微信登录暂不可用，请重新获取二维码' };
    }
  }
  pairing(id: string): PaChannelPairing {
    const channel = this.record(id);
    const connection = channel.connectionId ? this.record(channel.connectionId) : channel;
    if (channel.type === 'weixin' || !channel.enabled || !connection.enabled || !connection.credentialConfigured) throw new PaError('请先连接机器人');
    const code = randomBytes(12).toString('hex'), expiresAt = Date.now() + 10 * 60000;
    const current = this.store.get<PairingRecord>('channel_pairings', id);
    const fields = { channelId: id, codeHash: hash(code), expiresAt, consumed: false, authorizationVersion: channel.authorizationVersion };
    if (current) this.store.update<PairingRecord>('channel_pairings', id, fields); else this.store.create<PairingRecord>('channel_pairings', fields, id);
    return { channelId: id, code: `绑定 ${code}`, expiresAt };
  }
  async connect(id: string): Promise<void> {
    if (this.record(id).connectionId) return;
    const epoch = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, epoch);
    const old = this.transports.get(id); this.transports.delete(id); await old?.stop();
    if (this.epochs.get(id) !== epoch || this.closing) return;
    const channel = this.record(id), credentials = this.credentials.get(channel.credentialRef)?.credentials;
    if (!channel.enabled || !credentials) { this.state(id, credentials ? 'disconnected' : 'login_required'); return; }
    if (channel.type !== 'weixin' && channel.accountKey) {
      try { this.assertExclusiveBot(channel.type, id, channel.accountKey); } catch (error) { this.state(id, 'error', error instanceof Error ? error.message : '存在重复机器人连接'); return; }
    }
    const journal = { cursor: () => this.record(id).cursor, checkpoint: (cursor: string) => { if (this.epochs.get(id) === epoch && this.record(id).cursor !== cursor) this.store.update<ChannelRecord>('channels', id, { cursor }); } };
    const admitMedia: PaMediaAdmission = message => {
      if (this.epochs.get(id) !== epoch || this.closing || !message.direct && !message.mentioned) return false;
      const parent = this.record(id);
      return parent.enabled && [parent, ...this.bindings(id)].some(candidate =>
        candidate.enabled && candidate.accountKey === parent.accountKey &&
        candidate.remoteChatId === message.chatId && candidate.allowedSenderIds.includes(message.senderId) &&
        (candidate.type !== 'feishu' || Boolean(candidate.tenantId) && candidate.tenantId === message.tenantId));
    };
    const transport = this.options.transportFactory?.(this.publicChannel(channel), credentials, journal) ?? (channel.type === 'feishu'
      ? new PaFeishuTransport({ appId: str(credentials.appId), appSecret: str(credentials.appSecret), brand: credentials.brand === 'lark' ? 'lark' : 'feishu', admitMedia })
      : channel.type === 'weixin' ? new PaWeixinTransport({ token: str(credentials.token), baseUrl: str(credentials.baseUrl), ownerId: str(credentials.ownerId), ...journal, admitMedia })
        : new PaImTransport(channel.type, readPaImCredentials(channel.type, credentials), admitMedia));
    this.transports.set(id, transport);
    try {
      await transport.start(async message => {
        if (this.epochs.get(id) !== epoch || this.closing) throw new PaError('连接正在切换，请重新投递', 503);
        this.accept(id, message);
      }, (state, message) => { if (this.epochs.get(id) === epoch && !this.closing) this.state(id, state, message ?? null); });
      if (this.epochs.get(id) !== epoch || this.closing) await transport.stop();
    } catch (error) { if (this.epochs.get(id) === epoch) this.state(id, error instanceof PaChannelTransportError && error.kind === 'login' ? 'login_required' : 'error', error instanceof PaChannelTransportError ? error.message : '渠道连接失败，请检查配置与网络'); }
  }
  async reconnect(id: string): Promise<void> {
    const channel = this.record(id);
    if (channel.archivedAt) throw new PaError('此连接已移除', 404);
    if (channel.connectionId) {
      const parent = this.record(channel.connectionId);
      if (!parent.enabled || !parent.credentialConfigured) throw new PaError('请先启用机器人连接');
      if (!channel.enabled) this.store.update<ChannelRecord>('channels', id, {
        enabled: true, accountKey: parent.accountKey, authorizationVersion: channel.authorizationVersion + 1,
      });
      return;
    }
    if (!channel.credentialConfigured) throw new PaError('请先配置账号');
    if (channel.type !== 'weixin' && channel.accountKey) this.assertExclusiveBot(channel.type, id, channel.accountKey);
    this.logins.get(id)?.abort.abort();
    this.logins.delete(id); // Reusing saved credentials dismisses any stale QR flow.
    if (!channel.enabled) this.store.update<ChannelRecord>('channels', id, { enabled: true, authorizationVersion: channel.authorizationVersion + 1 });
    await this.connect(id);
  }
  private async stopTransport(id: string, expectedEpoch?: number): Promise<void> {
    const epoch = expectedEpoch ?? (this.epochs.get(id) ?? 0) + 1;
    if (expectedEpoch !== undefined && this.epochs.get(id) !== expectedEpoch) return;
    this.epochs.set(id, epoch);
    const login = this.logins.get(id);
    if (login) { login.abort.abort(); login.public = { ...login.public, status: 'expired', qrImagePath: null, message: '登录已取消，请重新获取二维码' }; }
    const transport = this.transports.get(id); this.transports.delete(id);
    this.outgoing.get(id)?.abort();
    await transport?.stop();
    if (this.epochs.get(id) === epoch) this.state(id, 'disconnected');
  }
  async disconnect(id: string, forget = false): Promise<PaChannel> {
    const channel = this.record(id);
    this.cancelMedia(id);
    this.deactivateBindings(id, forget);
    this.cancelFeishuRegistration(id);
    this.feishuRegistrations.delete(id);
    this.store.update<ChannelRecord>('channels', id, { enabled: false, authorizationVersion: channel.authorizationVersion + 1, ...(forget ? { credentialConfigured: false, cursor: '', accountKey: null, accountLabel: null, allowedSenderIds: [], remoteChatId: null, tenantId: null } : {}) });
    const epoch = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, epoch);
    this.options.core.revokeChannel(id); this.cancelPendingOutbox(id); await this.stopTransport(id, epoch);
    if (forget && this.epochs.get(id) === epoch) { this.credentials.delete(channel.credentialRef); this.purgeContexts(id); }
    return this.publicChannel(this.record(id));
  }
  async remove(id: string): Promise<void> {
    const channel = this.record(id);
    if (channel.archivedAt) return;
    const bindings = this.bindings(id);
    const disconnecting = this.disconnect(id, true);
    const archivedAt = Date.now();
    this.store.transaction(() => {
      this.store.update<ChannelRecord>('channels', id, { archivedAt });
      for (const binding of bindings) this.store.update<ChannelRecord>('channels', binding.id, { archivedAt });
    });
    await disconnecting;
  }
  private cancelPendingOutbox(id: string): void {
    for (const item of this.store.list<OutboxRecord>('channel_outbox')) if (item.channelId === id && ['pending', 'failed'].includes(item.state)) this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'cancelled', error: '渠道授权或账号已改变，旧回复不再投递' });
  }
  private cancelMedia(id: string): void {
    if (this.mediaJob?.channelId === id) this.mediaJob.abort.abort();
  }
  private purgeContexts(id: string): void {
    const channel = this.record(id);
    const refs = new Set([...(channel.contextRefs ?? []), ...this.store.list<InboxRecord>('channel_inbox').filter(item => item.channelId === id).flatMap(item => item.contextRef ? [item.contextRef] : [])]);
    for (const ref of refs) this.credentials.delete(ref);
    if (channel.contextRefs?.length) this.store.update<ChannelRecord>('channels', id, { contextRefs: [] });
  }
  accept(id: string, message: PaInboundMessage): void {
    let channel = this.record(id);
    if (!channel.enabled) return;
    if (!message.direct && (channel.type === 'weixin' || !message.mentioned)) return;
    const match = /^(?:绑定|bind)\s+([a-f0-9]{24})$/i.exec(message.text.trim());
    if (!channel.connectionId && channel.type !== 'weixin') {
      const candidates = [channel, ...this.bindings(id)].filter(candidate => candidate.accountKey === channel.accountKey);
      const existing = candidates.find(candidate => candidate.remoteChatId === message.chatId && (channel.type !== 'feishu' || candidate.tenantId === message.tenantId));
      const codeHash = match ? hash(match[1]!.toLowerCase()) : null;
      const requested = codeHash ? candidates.find(candidate => candidate.enabled &&
        this.store.get<PairingRecord>('channel_pairings', candidate.id)?.codeHash === codeHash) : null;
      if (requested && existing && requested.id !== existing.id) return;
      channel = requested ?? existing ?? channel;
      id = channel.id;
      if (!channel.enabled) return;
    }
    const inboxId = hash(`${id}:${channel.accountKey}:${message.senderId}:${message.id}`);
    if (this.store.has('channel_inbox', inboxId)) return;
    let paired = false;
    const pairing = this.store.get<PairingRecord>('channel_pairings', id);
    const stale = Date.now() - message.createdAt > MAX_EVENT_AGE || message.createdAt > Date.now() + 60000;
    if (match && pairing && channel.type !== 'weixin' && (channel.type !== 'feishu' || message.tenantId) &&
      !stale && !pairing.consumed && pairing.authorizationVersion === channel.authorizationVersion && pairing.expiresAt > Date.now() &&
      timingSafeEqual(Buffer.from(hash(match[1]!.toLowerCase())), Buffer.from(pairing.codeHash))) {
      channel = this.store.transaction(() => {
        this.store.update<PairingRecord>('channel_pairings', id, { consumed: true });
        return this.store.update<ChannelRecord>('channels', id, {
          allowedSenderIds: [message.senderId], remoteChatId: message.chatId, tenantId: message.tenantId,
          remoteDirect: message.direct, relaySince: Date.now(), authorizationVersion: channel.authorizationVersion + 1,
        });
      });
      paired = true;
      this.options.core.revokeChannel(id);
      this.cancelPendingOutbox(id);
    }
    const authorized = channel.allowedSenderIds.includes(message.senderId) && channel.remoteChatId === message.chatId && (channel.type !== 'feishu' || Boolean(channel.tenantId) && channel.tenantId === message.tenantId);
    if (!authorized || stale) {
      this.store.create<InboxRecord>('channel_inbox', { channelId: id, providerMessageId: message.id, senderId: message.senderId, chatId: message.chatId, threadId: message.threadId, receivedAt: Date.now(), taskId: null, state: 'ignored', error: authorized ? '消息已过期，未执行' : '发送者或会话未授权', preview: '', text: '', authorizationVersion: channel.authorizationVersion, direct: message.direct, contextRef: null, unsupported: false }, inboxId);
      return;
    }
    const contextRef = message.contextToken ? `pa-context:${id}:${hash(message.senderId).slice(0, 24)}` : null;
    if (contextRef && !channel.contextRefs?.includes(contextRef)) channel = this.store.update<ChannelRecord>('channels', id, { contextRefs: [...(channel.contextRefs ?? []), contextRef] });
    if (contextRef) this.credentials.set({ schemaVersion: 1, connectorId: contextRef, accountLabel: channel.name, credentials: { provider: 'pa-context', contextToken: message.contextToken, accountKey: channel.accountKey }, updatedAt: new Date().toISOString() });
    const attachments = !paired && message.attachments?.length ? preparePaChannelAttachments(message.attachments) : null;
    const hasAttachments = Boolean(attachments?.text || attachments?.images.length || attachments?.pending?.length);
    const text = paired ? '绑定确认' : message.text.trim() || (hasAttachments ? '请分析这条消息附带的资料。' : '');
    const item = this.store.transaction(() => {
      const incoming = this.store.create<InboxRecord>('channel_inbox', { channelId: id, providerMessageId: message.id, senderId: message.senderId, chatId: message.chatId, threadId: message.threadId, receivedAt: Date.now(), taskId: null, state: paired ? 'accepted' : 'pending', error: null, preview: text.slice(0, 600), text: text.slice(0, 32001), authorizationVersion: channel.authorizationVersion, direct: message.direct, contextRef, unsupported: message.unsupported === true || Boolean(message.attachments?.length && !message.text.trim() && !hasAttachments),
        ...(message.action ? { action: message.action, actionMessageId: message.actionMessageId ?? '' } : {}),
      }, inboxId);
      this.store.update<ChannelRecord>('channels', id, { lastReceivedAt: Date.now(), verification: { ...channel.verification, inboundAt: Date.now() } });
      this.store.event(null, 'channel.received', { channelId: id, inboxId, providerMessageId: message.id });
      if (attachments && hasAttachments) this.store.create<PaChannelAttachments>('channel_attachments', { channelId: id, ...attachments }, inboxId);
      return incoming;
    });
    if (paired) this.enqueueReply(item, 'paired', '已绑定 Fantay。只有此已授权身份与会话可以发起工作。发送 /help 查看用法。');
    this.scheduleTick();
  }
  /** `key`, when given, replaces the per-inbound-message identity of the reply: a chat turn that merged several inbound
   *  messages answers once. */
  private enqueueReply(inbox: InboxRecord, suffix: string, text: string, taskId: string | null = inbox.taskId, memoryRefs?: PaAttempt['memoryRefs'], key?: string, buttons?: PaOutboundMessage['buttons']): void {
    const id = hash(key ?? `${inbox.id}:${suffix}`);
    if (this.store.has('channel_outbox', id)) return;
    const channel = this.record(inbox.channelId);
    if (!channel.enabled || channel.authorizationVersion !== inbox.authorizationVersion) return;
    const redacted = redactPaCredentials(text);
    const bounded = redacted.length > MAX_REPLY ? `${redacted.slice(0, MAX_REPLY - (TAIL.length + 2))}\n\n${TAIL}` : redacted;
    this.store.create<OutboxRecord>('channel_outbox', { channelId: channel.id, taskId, inboxId: inbox.id, requestId: randomUUID(), state: 'pending', providerMessageId: null, attempts: 0, nextAttemptAt: Date.now(), error: null, sentAt: null,
      preview: bounded, text: bounded, authorizationVersion: channel.authorizationVersion, firstAttemptAt: null, textHash: hash(bounded),
      ...(memoryRefs ? { memoryRefs } : {}), ...(buttons ? { buttons } : {}) }, id);
  }
  private answerInChannel(item: InboxRecord, channel: ChannelRecord): boolean {
    const action = item.action ? /^p:([0-9a-f-]{36}):([12])$/.exec(item.action) : null;
    const number = /^[12]$/.test(item.text.trim()) ? item.text.trim() : null;
    const questionAction = item.action ? /^q:([0-9a-f-]{36}):([1-5])$/.exec(item.action) : null;
    const selection = questionAction?.[2] ?? (/^[1-5](?:\s+[1-5]){0,4}$/.test(item.text.trim()) ? item.text.trim() : null);
    if (selection && (!item.action || questionAction) && this.answerChannelQuestion(item, channel, selection, questionAction?.[1])) return true;
    if (!item.action && !number) return false;
    if (!channel.allowRemoteApproval || !item.direct) return Boolean(item.action) && this.ignoreAction(item);
    const original = this.store.list<InboxRecord>('channel_inbox').reverse().find(inbox => {
      if (inbox.channelId !== item.channelId || inbox.chatId !== item.chatId || inbox.senderId !== item.senderId ||
        !inbox.direct || !this.actionableApproval(inbox, Date.now())) return false;
      if (!item.action) return inbox.threadId === item.threadId;
      return inbox.approvalId === action?.[1] && this.store.get<OutboxRecord>('channel_outbox', hash(`${inbox.id}:approval`))?.providerMessageId === item.actionMessageId;
    });
    if (!original) return Boolean(item.action) && this.ignoreAction(item);
    const approved = (action?.[2] ?? number) === '1';
    this.store.transaction(() => {
      this.approveProject(original.id, approved, original.revision, false);
      this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted', preview: approved ? '批准本次项目' : '拒绝本次项目' });
    });
    return true;
  }
  private ignoreAction(item: InboxRecord): true {
    this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'ignored', error: '卡片已处理、过期或不可用于当前会话' });
    return true;
  }
  private answerChannelQuestion(item: InboxRecord, channel: ChannelRecord, selection: string, taskId?: string): boolean {
    const open = this.store.list<PaTask>('tasks').filter(task => task.status === 'waiting' && task.channelQuestion &&
      task.channelId === channel.id && task.channelAuthorizationVersion === channel.authorizationVersion &&
      task.principal?.kind === 'channel' && task.principal.subjectId === item.senderId &&
      (!taskId || task.id === taskId)).sort((a, b) => b.channelQuestion!.askedAt - a.channelQuestion!.askedAt);
    for (const task of open) {
      const question = task.channelQuestion!;
      const original = this.store.listActionableChannelInbox<InboxRecord>().find(inbox =>
        inbox.taskId === task.id && inbox.senderId === item.senderId && inbox.chatId === item.chatId);
      if (!original) continue;
      const card = this.store.get<OutboxRecord>('channel_outbox', hash(`${original.id}:question:${question.attemptId}`));
      if (item.action ? !card?.providerMessageId || card.providerMessageId !== item.actionMessageId : original.threadId !== item.threadId) continue;
      if (!item.action && channel.allowRemoteApproval && item.direct &&
        this.store.list<InboxRecord>('channel_inbox').some(inbox => inbox.channelId === item.channelId && inbox.chatId === item.chatId &&
          inbox.senderId === item.senderId && inbox.threadId === item.threadId && this.actionableApproval(inbox, Date.now()) &&
          inbox.receivedAt > question.askedAt)) return false;
      const choices = [...new Set(selection.split(/\s+/).map(Number))];
      if (choices.some(option => !question.options[option - 1]) || !question.multiple && choices.length !== 1)
        throw new PaError('请按问题下方的选项编号回复');
      this.store.transaction(() => {
        this.options.core.answerTaskCard(task.id, { kind: 'question', attemptId: question.attemptId, choices });
        this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted', preview: '已回答任务问题' });
        this.enqueueReply(item, 'answer', '已记录选择，任务继续执行。');
      });
      return true;
    }
    return false;
  }
  private processInbox(item: InboxRecord): void {
    const channel = this.record(item.channelId);
    if (!channel.enabled || channel.authorizationVersion !== item.authorizationVersion) { this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'ignored', error: '渠道授权已改变，旧消息未执行' }); return; }
    const text = item.text.trim();
    if (this.answerInChannel(item, channel)) return;
    const canManageTeam = channel.type === 'feishu' && channel.allowTeam === true && channel.targetKind === 'agent' && item.direct;
    const teamCommand = /^\/(team-run|team)(?:\s+([\s\S]+))?$/i.exec(text);
    const remoteKey = `${item.chatId}:${item.threadId ?? 'main'}`;
    const origin = {
      kind: 'channel' as const, id: channel.id, accountId: channel.accountKey ?? channel.id,
      subjectId: item.senderId, threadId: remoteKey, authorizationVersion: channel.authorizationVersion,
    };
    if (teamCommand && !canManageTeam) throw new PaError('请在 Fantay 连接中开启「管理智能体团队」，再用已配对的飞书私聊发送这条指令', 403, 'PA_CAPABILITY_DENIED');
    const teamRun = teamCommand?.[1]?.toLowerCase() === 'team-run';
    const teamArgs = teamCommand?.[2]?.trim() ?? '';
    const teamRunArgs = teamRun ? /^([^|｜]+)[|｜]([\s\S]+)$/u.exec(teamArgs) : null;
    if (teamRun && (!teamRunArgs?.[1]?.trim() || !teamRunArgs[2]?.trim()))
      throw new PaError('发送 /team-run 团队名 | 你的任务');
    if (teamCommand && !teamArgs) throw new PaError('发送 /team 一句话描述你要组建的团队');
    const team = teamRunArgs ? this.options.core.feishuTeam(teamRunArgs[1]!, origin) : undefined;
    const conversation = this.options.core.channelConversation(channel, remoteKey, team);
    const tasks = this.store.list<PaTask>('tasks').filter(task =>
      (task.conversationId === conversation.id || canManageTeam && task.channelId === channel.id &&
        task.channelAuthorizationVersion === channel.authorizationVersion && task.principal?.kind === 'channel' && task.principal.threadId === remoteKey) &&
      task.dataClass !== 'local_only' &&
      (task.principal?.kind !== 'channel' || task.principal.subjectId === item.senderId));
    if (item.unsupported || !text || text.length > 32000) { this.enqueueReply(item, 'unsupported', item.unsupported ? '未能读取这条消息中的附件，可发送常见图片、文本文件或文字说明。' : '消息为空或过长，请分段发送。'); this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted' }); return; }
    // 聊天模式 (the channel's chatMode with a target whose characters all have a card): a plain message is a chat turn.
    const companion = this.options.core.soul.modeOf(conversation) === 'companion';
    if (/^\/(start|help|帮助)$/i.test(text)) {
      const teamHelp = canManageTeam ? '\n/team 团队目标（自动建立成员与协作群）\n/team-run 团队名 | 任务目标（请团队协作）' : '';
      const commands = `/status 查看本会话任务\n/stop [任务ID] 停止当前任务\n/resume 任务ID 恢复可继续的任务\n/amend 任务ID 新要求\n/project 项目目标（需要本地项目授权或桌面批准）${teamHelp}\n私人记忆默认不会进入外部渠道。`;
      this.enqueueReply(item, 'help', companion
        ? `直接发送文字就是聊天，回复来自 AI 扮演的角色。\n/task 目标 作为任务执行，完成后回传结果\n${commands}`
        : `直接发送文字即可发起工作。\n${commands}`);
      this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted' }); return;
    }
    if (/^\/status\b/i.test(text)) {
      this.enqueueReply(item, 'status', tasks.filter(task => task.kind !== 'chat').slice(-5).map(task => `${task.id}\n${task.goal.slice(0, 120)}\n${task.status}${task.waitingReason ? `：${task.waitingReason}` : ''}`).join('\n\n') || '此会话还没有任务。');
      this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted' }); return;
    }
    const command = /^\/(stop|resume|amend)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i.exec(text);
    if (command) {
      const task = command[2] ? tasks.find(task => task.id === command[2]) : [...tasks].reverse().find(task => !['completed', 'cancelled', 'failed'].includes(task.status));
      if (!task) throw new PaError('没有找到属于此会话的目标任务');
      if (command[1]!.toLowerCase() === 'amend' && task.authorization.approvalId && !channel.allowProject) throw new PaError('此任务使用单次项目批准；新目标请在桌面追加确认，或重新发起 /project 请求', 403, 'PA_APPROVAL_REQUIRED');
      this.store.transaction(() => {
        if (command[1]!.toLowerCase() === 'stop') this.options.core.cancel(task.id);
        else if (command[1]!.toLowerCase() === 'resume') this.options.core.resume(task.id);
        else if (command[3]?.trim()) this.options.core.amend(task.id, command[3].trim(), task.revision);
        else throw new PaError('请在任务 ID 后追加新的要求');
        this.enqueueReply(item, 'command', `已受理 ${command[1]}：${task.id}。实际状态会在本会话回传。`, task.id);
        this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted', taskId: task.id });
      }); return;
    }
    const project = /^\/project\s+/i.test(text);
    // `/task 目标` is a work task in either mode; in 聊天模式 it is how a message stops being chat.
    const asTask = !project && /^\/task\s+/i.test(text);
    const goal = teamCommand ? teamRunArgs?.[2]?.trim() ?? teamArgs : project || asTask ? text.replace(/^\/(?:project|task)\s+/i, '') : text;
    const requestId = `channel:${item.id}`;
    const kind = teamCommand ? teamRun ? 'discussion' : 'team' : project ? 'project' :
      companion && !asTask && !this.store.has('channel_attachments', item.id) ? 'chat' : 'discussion';
    const budget = this.options.core.defaultTaskBudget();
    if (team) budget.maxAttempts = Math.max(budget.maxAttempts, team.memberIds.length);
    const input = item.taskInput ?? paTaskInputSchema.parse({ requestId, conversationId: conversation.id, goal, kind, budget });
    if (input.goal !== goal || input.conversationId !== conversation.id) throw new PaError('原始请求或会话授权已改变，请重新发起');
    if (!item.taskInput) this.store.update<InboxRecord>('channel_inbox', item.id, { taskInput: input });
    let approval = this.store.list<PaProjectApproval>('approvals').find(value => value.inboxId === item.id);
    if (project && !channel.allowProject && approval?.state !== 'approved') {
      if (!approval) approval = this.store.create<PaProjectApproval>('approvals', { channelId: channel.id, inboxId: item.id, requestId, goalHash: hash(goal), parametersHash: hash(JSON.stringify(input)), authorizationVersion: channel.authorizationVersion, state: 'pending', expiresAt: Date.now() + 86400000, taskId: null });
      this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'approval', approvalId: approval.id });
      if (channel.allowRemoteApproval && item.direct) {
        const buttons = [{ label: '允许一次', data: `p:${approval.id}:1` }, { label: '拒绝', data: `p:${approval.id}:2` }];
        this.enqueueReply(item, 'approval', `允许创建以下 Fantay 项目？\n${summarizePaOutput(goal, 450)}\n回复 1 允许一次，回复 2 拒绝。也可在 Fantay 桌面处理。`, null, undefined, undefined, buttons);
      } else this.enqueueReply(item, 'approval', '已记录项目请求，等待桌面 PA 中批准本次创建。');
      return;
    }
    const task = this.options.core.submit(input, approval?.state === 'approved' ? approval.id : undefined, undefined, origin);
    if (approval) this.store.update<PaProjectApproval>('approvals', approval.id, { taskId: task.id });
    const accepted = this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted', taskId: task.id, error: null });
    // A chat turn answers with the reply itself; a receipt in between would read as the character speaking.
    if (task.kind !== 'chat') this.enqueueReply(accepted, 'accepted', `已记录任务：${task.id}\n${goal.slice(0, 180)}\n完成或需要你处理时会在这里回复。`);
  }
  approveProject(inboxId: string, approved: boolean, revision: number, process = true): void {
    const inbox = this.store.require<InboxRecord>('channel_inbox', inboxId);
    if (inbox.revision !== revision || inbox.state !== 'approval' || !inbox.approvalId) throw new PaError('待批准请求已改变，请刷新后重试', 409);
    const channel = this.record(inbox.channelId), approval = this.store.require<PaProjectApproval>('approvals', inbox.approvalId);
    if (!this.actionableApproval(inbox, Date.now())) throw new PaError('本次批准的账号、权限或有效期已改变，请从渠道重新发起');
    const goal = inbox.text.trim().replace(/^\/project\s+/i, '');
    if (hash(goal) !== approval.goalHash) throw new PaError('待批准目标已改变，请重新发起', 409);
    const conversation = this.options.core.channelConversation(channel, `${inbox.chatId}:${inbox.threadId ?? 'main'}`);
    const input = inbox.taskInput ?? paTaskInputSchema.parse({ requestId: approval.requestId, conversationId: conversation.id, goal, kind: 'project', budget: this.options.core.defaultTaskBudget() });
    if (approval.parametersHash && approval.parametersHash !== hash(JSON.stringify(input))) throw new PaError('待批准参数已改变，请重新发起', 409);
    if (!inbox.taskInput) this.store.update<InboxRecord>('channel_inbox', inbox.id, { taskInput: input });
    if (!approval.parametersHash) this.store.update<PaProjectApproval>('approvals', approval.id, { parametersHash: hash(JSON.stringify(input)) });
    this.store.update<PaProjectApproval>('approvals', approval.id, { state: approved ? 'approved' : 'rejected' });
    this.store.update<InboxRecord>('channel_inbox', inbox.id, { state: approved ? 'pending' : 'ignored', error: approved ? null : '用户拒绝了本次项目创建' });
    const card = this.store.get<OutboxRecord>('channel_outbox', hash(`${inbox.id}:approval`));
    if (card?.buttons && card.providerMessageId && card.state === 'sent') {
      const transport = this.transports.get(channel.connectionId ?? channel.id);
      void transport?.clearButtons?.(inbox.chatId, inbox.direct, card.providerMessageId, approved ? '已批准本次创建' : '已拒绝本次创建').catch(() => {});
    } else if (card?.buttons && card.state === 'pending') {
      this.store.update<OutboxRecord>('channel_outbox', card.id, { state: 'cancelled', error: '请求已处理' });
    }
    if (!approved) this.enqueueReply(inbox, 'approval-rejected', '本次项目创建未获批准，未创建项目。');
    if (process) void this.tick(); else this.scheduleTick();
  }
  private notifyTask(inbox: InboxRecord): void {
    if (!inbox.taskId) return;
    const task = this.store.get<PaTask>('tasks', inbox.taskId);
    if (!task || task.dataClass === 'local_only') return;
    const channel = this.record(inbox.channelId);
    if (channel.authorizationVersion === inbox.authorizationVersion && task.status !== 'running' && task.status !== 'verifying')
      this.settleQuestions(inbox, task, channel);
    if (task.status === 'running' || task.status === 'verifying') {
      const transport = this.transports.get(channel.connectionId ?? channel.id);
      if (transport?.typing && channel.enabled && channel.authorizationVersion === inbox.authorizationVersion &&
        Date.now() - (this.lastTyping.get(inbox.id) ?? 0) > 4500) {
        this.lastTyping.set(inbox.id, Date.now());
        void transport.typing(inbox.chatId, inbox.direct).catch(() => {});
      }
    } else this.lastTyping.delete(inbox.id);
    if (!FINAL_STATES.has(task.status)) return;
    if (task.kind === 'chat') { this.notifyChat(inbox, task); return; }
    if (task.status === 'waiting' && task.channelQuestion) {
      const question = task.channelQuestion;
      const choices = question.options.map((choice, index) => `${index + 1}. ${choice}`);
      const buttons = question.multiple ? undefined : question.options.map((label, index) => ({ label, data: `q:${task.id}:${index + 1}` }));
      const hint = question.multiple ? '回复选项编号，多选用空格分隔。' : '回复一个选项编号。';
      this.enqueueReply(inbox, `question:${question.attemptId}`, [question.prompt, ...choices, hint].join('\n'), task.id,
        this.store.get<PaAttempt>('attempts', question.attemptId)?.memoryRefs, undefined, buttons);
      return;
    }
    if (task.status === 'waiting' && task.pendingView) {
      const view = task.pendingView;
      this.enqueueReply(inbox, `view:${view.attemptId}`, [view.title, view.summary, '请回到 Fantay 打开对应对话，填写视图卡片后继续。'].filter(Boolean).join('\n'),
        task.id, this.store.get<PaAttempt>('attempts', view.attemptId)?.memoryRefs);
      return;
    }
    const attemptCount = this.store.countTaskAttempts(task.id);
    const suffix = `state:${hash(`${task.status}:${task.nextParticipant}:${attemptCount}:${task.waitingReason ?? ''}`).slice(0, 24)}`;
    if (this.store.has('channel_outbox', hash(`${inbox.id}:${suffix}`))) return;
    const attempts = this.store.listTaskAttempts<PaAttempt>(task.id);
    const last = attempts.filter(attempt => attempt.status === 'completed' && attempt.phase !== 'review').at(-1);
    const lastMessage = last ? this.store.get<import('@open-design/contracts').PaMessage>('messages', last.id) : null;
    let result = (task.kind === 'team' || lastMessage?.viewCard ? lastMessage?.content : last?.output) ?? '';
    try { const parsed = obj(JSON.parse(result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))); if (typeof parsed.summary === 'string') result = parsed.summary; } catch { /* ordinary text */ }
    const conversation = this.store.get<import('@open-design/contracts').PaConversation>('conversations', task.conversationId);
    if (task.status === 'completed' && task.kind === 'discussion' && conversation?.groupId && task.participantIds.length > 1) {
      const replies = attempts.filter(attempt => attempt.status === 'completed' && attempt.phase === 'respond' &&
        !attempt.output.trim().startsWith('{"channelQuestion"'));
      for (const attempt of replies) {
        const message = this.store.get<import('@open-design/contracts').PaMessage>('messages', attempt.id);
        const body = message?.content.trim();
        if (body && !message?.viewCard?.interactive) this.enqueueReply(inbox, `member:${attempt.id}`, `${attempt.agentSnapshot.name}\n${body}`, task.id, attempt.memoryRefs);
      }
      result = '';
    }
    const state = { completed: '已完成', waiting: '等待处理', failed: '未完成', cancelled: '已停止' }[task.status as 'completed'];
    const text = [`任务${state}：${task.id}`, task.goal.slice(0, 140), task.status === 'completed' ? summarizePaOutput(result, 1800) : task.waitingReason ?? task.error ?? '已停止后续执行，已有成果保留。',
      ...(task.projectId ? [`Fantay 项目：${task.projectName}（${task.projectId}）`] : []), ...(task.evidence.length ? [`验证：${summarizePaOutput(task.evidence.slice(-2).join('；'), 700)}`] : [])].join('\n\n');
    const refs = attempts.filter(attempt => attempt.status === 'completed').flatMap(attempt => attempt.memoryRefs ?? []);
    this.enqueueReply(inbox, suffix, text, task.id, refs);
  }
  private settleQuestions(inbox: InboxRecord, task: PaTask, channel: ChannelRecord): void {
    for (const attempt of this.store.listTaskAttempts<PaAttempt>(task.id)) {
      if (task.status === 'waiting' && task.channelQuestion?.attemptId === attempt.id) continue;
      const card = this.store.get<OutboxRecord>('channel_outbox', hash(`${inbox.id}:question:${attempt.id}`));
      if (!card || card.cardSettled) continue;
      if (card.state === 'pending') {
        this.store.update<OutboxRecord>('channel_outbox', card.id, { state: 'cancelled', cardSettled: true, error: '卡片已处理' });
      } else if (card.state === 'sent' && card.providerMessageId && card.buttons) {
        const transport = this.transports.get(channel.connectionId ?? channel.id);
        if (!transport || !channel.enabled) continue;
        this.store.update<OutboxRecord>('channel_outbox', card.id, { cardSettled: true });
        void transport.clearButtons?.(inbox.chatId, inbox.direct, card.providerMessageId, '卡片已处理').catch(() => {});
      }
    }
  }
  /** A finished chat turn sends the character's reply as it is: no task header and no task id. Keyed by the task, so
   *  a turn that merged several inbound messages answers once. A turn that did not finish says so as the app (never as
   *  the character declining); one the owner stopped says nothing more. */
  private notifyChat(inbox: InboxRecord, task: PaTask): void {
    const key = (part: string) => `chat:${task.id}:${part}`;
    if (task.status === 'cancelled') return;
    if (task.status !== 'completed') {
      this.enqueueReply(inbox, 'unanswered', 'Fantay：这条消息没有收到回复，请再发一次。', task.id, undefined, key('unanswered'));
      return;
    }
    const reply = this.options.core.soul.channelReply(task);
    if (!reply) return;
    const refs = this.store.listTaskAttempts<PaAttempt>(task.id).filter(attempt => attempt.status === 'completed').flatMap(attempt => attempt.memoryRefs ?? []);
    this.enqueueReply(inbox, 'reply', reply.text, task.id, refs, key('reply'));
    if (reply.care) this.enqueueReply(inbox, 'care', reply.care, task.id, undefined, key('care'));
  }
  async tick(): Promise<void> {
    if (this.closing || this.options.acceptsNewWork?.() === false) return;
    for (const item of this.store.listActionableChannelInbox<InboxRecord>()) {
      let current = item;
      if (item.state === 'pending') {
        const attachments = this.store.get<PaChannelAttachments>('channel_attachments', item.id);
        if (attachments?.pending?.length) {
          const channel = this.record(item.channelId);
          if (!channel.enabled || channel.authorizationVersion !== item.authorizationVersion) {
            this.store.update<PaChannelAttachments>('channel_attachments', item.id, { pending: undefined });
          } else {
            if (!this.mediaJob) this.startInboundMedia(item, attachments);
            continue;
          }
        }
        try { this.processInbox(item); }
        catch (error) { const message = error instanceof PaError ? error.message : '任务暂时无法受理，请在桌面检查连接与模型设置'; this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'failed', error: message }); this.enqueueReply(item, 'rejected', message); }
        current = this.store.require<InboxRecord>('channel_inbox', item.id);
      }
      if (current.state === 'accepted' && current.taskId) this.notifyTask(current);
    }
    this.relayDesktopUpdates();
    if (this.processing) return;
    const actionableOutbox = this.store.listActionableChannelOutbox<OutboxRecord>();
    if (actionableOutbox.length === 0) return;
    this.processing = true;
    try {
      for (const item of actionableOutbox) {
        if (this.closing) break;
        if (item.state === 'pending' && item.nextAttemptAt <= Date.now()) await this.trackedDelivery(item);
        else if (item.state === 'unknown') {
          const channel = this.record(item.channelId);
          const transport = this.transports.get(channel.connectionId ?? channel.id);
          if (transport?.idempotencyWindowMs && item.firstAttemptAt && Date.now() - item.firstAttemptAt < transport.idempotencyWindowMs - 30000 && item.attempts < 3 && item.nextAttemptAt <= Date.now()) await this.trackedDelivery(item);
        }
      }
    } finally { this.processing = false; }
  }
  private startInboundMedia(item: InboxRecord, attachments: PaChannelAttachments): void {
    const job = { channelId: item.channelId, abort: new AbortController() };
    this.mediaJob = job;
    const work = this.finishInboundMedia(item, attachments, job.abort.signal).finally(() => {
      this.mediaJob = undefined;
      this.inFlight.delete(work);
      this.scheduleTick();
    });
    this.inFlight.add(work);
  }
  private async finishInboundMedia(item: InboxRecord, attachments: PaChannelAttachments, signal: AbortSignal): Promise<void> {
    const transcribe = this.options.transcribeAudio ?? transcribePaAudioFile;
    const result = await resolvePaChannelAttachments(attachments, signal,
      (bytes, audioSignal, rate) => transcribe(this.options.dataDir, bytes, audioSignal, rate))
      .catch(() => ({ text: attachments.text, voice: '', images: attachments.images, failures: attachments.pending?.map(part => part.name) ?? [] }));
    if (this.closing || signal.aborted) return;
    const channel = this.record(item.channelId);
    const current = this.store.require<InboxRecord>('channel_inbox', item.id);
    if (!channel.enabled || channel.authorizationVersion !== item.authorizationVersion || current.state !== 'pending') return;
    const emptyGoal = '请分析这条消息附带的资料。';
    const text = result.voice
      ? [item.text === emptyGoal ? '' : item.text, '语音消息转写', result.voice].filter(Boolean).join('\n').slice(0, 32000)
      : item.text;
    this.store.transaction(() => {
      this.store.update<PaChannelAttachments>('channel_attachments', item.id, { text: result.text, images: result.images, pending: undefined });
      this.store.update<InboxRecord>('channel_inbox', item.id, {
        text, preview: text.slice(0, 600),
        unsupported: !result.voice && !result.text && !result.images.length && text === emptyGoal,
      });
      if (result.failures.length && (result.voice || result.text || result.images.length || text !== emptyGoal)) {
        this.enqueueReply(item, 'media-skipped', `部分附件未读到可用内容\n${result.failures.join('\n')}`);
      }
    });
  }
  private relayDesktopUpdates(): void {
    const channels = this.store.list<ChannelRecord>('channels').filter(channel =>
      channel.enabled && channel.shareUpdates && channel.type !== 'weixin' && channel.type !== 'qq' &&
      channel.remoteChatId && channel.allowedSenderIds.length === 1 && channel.remoteDirect !== undefined && channel.relaySince);
    if (!channels.length) return;
    const earliest = Math.max(Date.now() - 86400000, Math.min(...channels.map(channel => channel.relaySince!)));
    for (const task of this.store.list<PaTask>('tasks')) {
      const waitingView = task.status === 'waiting' ? task.pendingView : undefined;
      if (task.status !== 'completed' && !waitingView || task.updatedAt < earliest || task.channelId || task.dataClass === 'local_only' ||
        task.principal && !['owner', 'routine'].includes(task.principal.kind)) continue;
      const conversation = this.store.get<import('@open-design/contracts').PaConversation>('conversations', task.conversationId);
      if (!conversation || conversation.channelId) continue;
      for (const channel of channels) {
        if (task.createdAt < channel.relaySince! || (channel.targetKind === 'agent' ? conversation.agentId : conversation.groupId) !== channel.targetId) continue;
        const id = hash(`relay:${channel.id}:${task.id}${waitingView ? ':' + waitingView.attemptId : ''}`);
        if (this.store.has('channel_inbox', id)) continue;
        const attempts = this.store.listTaskAttempts<PaAttempt>(task.id).filter(attempt => attempt.status === 'completed');
        // Local-only and memory-derived work remains in Fantay. The desktop
        // switch only relays plain replies and scheduled summaries.
        if (attempts.some(attempt => attempt.memoryRefs?.length)) continue;
        const messages = this.store.listConversationMessages<import('@open-design/contracts').PaMessage>(task.conversationId)
          .filter(message => message.taskId === task.id && message.senderId !== 'owner' && message.content.trim() &&
            (waitingView ? message.attemptId === waitingView.attemptId : !message.viewCard?.interactive));
        if (!messages.length) continue;
        this.store.transaction(() => {
          const inbox = this.store.create<InboxRecord>('channel_inbox', {
            channelId: channel.id, providerMessageId: '', senderId: channel.allowedSenderIds[0]!, chatId: channel.remoteChatId!,
            threadId: null, receivedAt: Date.now(), taskId: null, state: 'accepted', error: null, preview: '',
            text: '', authorizationVersion: channel.authorizationVersion, direct: channel.remoteDirect!, contextRef: null, unsupported: false,
          }, id);
          for (const message of messages) {
            const agent = this.store.get<import('@open-design/contracts').PersonalAgent>('agents', message.senderId);
            const hint = waitingView ? '\n请回到 Fantay 打开对应对话，填写视图卡片后继续。' : '';
            this.enqueueReply(inbox, message.id, `${agent?.name ?? 'Fantay'}\n${message.content}${hint}`, task.id);
          }
        });
      }
    }
  }

  hasActiveWork(): boolean {
    return this.processing || this.inFlight.size > 0 || this.logins.size > 0 ||
      [...this.feishuRegistrations.values()].some(session => session.value.status === 'starting' || session.value.status === 'waiting');
  }
  private async trackedDelivery(item: OutboxRecord): Promise<void> {
    const work = this.deliver(item); this.inFlight.add(work);
    try { await work; } finally { this.inFlight.delete(work); }
  }
  private async deliver(item: OutboxRecord): Promise<void> {
    if (this.store.get<OutboxRecord>('channel_outbox', item.id)?.revision !== item.revision) return;
    const channel = this.record(item.channelId), inbox = this.store.require<InboxRecord>('channel_inbox', item.inboxId);
    const connection = channel.connectionId ? this.record(channel.connectionId) : channel;
    const transport = this.transports.get(connection.id);
    if (!channel.enabled || channel.authorizationVersion !== item.authorizationVersion || !channel.allowedSenderIds.includes(inbox.senderId) || channel.remoteChatId !== inbox.chatId) { if (item.state === 'pending') this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'cancelled', error: '回复目标授权已改变' }); return; }
    if (!this.options.core.memoryRefsCurrent(item.memoryRefs)) {
      if (item.state === 'pending') this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'cancelled', error: '回复引用的记忆已改变' });
      return;
    }
    if (!transport || !connection.enabled || connection.status !== 'connected') return;
    const previouslyUnknown = item.state === 'unknown' || Boolean(item.uncertainSince);
    if (previouslyUnknown && (!transport.idempotencyWindowMs || !item.firstAttemptAt || Date.now() - item.firstAttemptAt >= transport.idempotencyWindowMs - 30000)) {
      if (item.state !== 'unknown') this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'unknown', error: '此前发送结果未知，已停止超过平台去重窗口的自动重试' });
      return;
    }
    const secret = inbox.contextRef ? this.credentials.get(inbox.contextRef)?.credentials : undefined;
    const outbound: PaOutboundMessage = { requestId: item.requestId, chatId: inbox.chatId, threadId: inbox.threadId, replyTo: inbox.providerMessageId || null, text: item.text, direct: inbox.direct,
      ...(item.buttons ? { buttons: item.buttons } : {}),
      ...(secret && secret.accountKey === channel.accountKey && str(secret.contextToken) ? { contextToken: str(secret.contextToken) } : {}) };
    const attempt = this.store.transaction(() => {
      const next = this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'sending', attempts: item.attempts + 1, firstAttemptAt: item.firstAttemptAt ?? Date.now(), error: null });
      this.store.audit(item.taskId, 'channel.send_intent', { channelId: channel.id, outboxId: item.id, requestId: item.requestId, textHash: item.textHash, authorizationVersion: channel.authorizationVersion }, `${item.id}:send:${next.attempts}`);
      return next;
    });
    const abort = new AbortController(); this.outgoing.set(channel.id, abort);
    try {
      const receipt = await transport.send(outbound, AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]));
      this.store.transaction(() => {
        this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'sent', providerMessageId: receipt.messageId, sentAt: Date.now(), error: null });
        const latest = this.record(channel.id);
        if (latest.authorizationVersion === item.authorizationVersion) this.store.update<ChannelRecord>('channels', channel.id, { lastSentAt: Date.now(), verification: { ...latest.verification, outboundAt: Date.now() } });
        this.store.audit(item.taskId, 'channel.send_receipt', { outboxId: item.id, messageId: receipt.messageId }, `${item.id}:receipt:${attempt.attempts}`);
      });
    } catch (error) {
      const transportError = error instanceof PaChannelTransportError ? error : new PaChannelTransportError('发送结果待核对', 'unknown');
      const uncertain = previouslyUnknown || transportError.kind === 'unknown';
      const retry = !uncertain && transportError.kind === 'rate_limit' && attempt.attempts < 3;
      this.store.update<OutboxRecord>('channel_outbox', item.id, { state: uncertain ? 'unknown' : retry ? 'pending' : 'failed', uncertainSince: uncertain ? item.uncertainSince ?? item.firstAttemptAt ?? Date.now() : null, nextAttemptAt: Date.now() + Math.max(30000, transportError.retryAfterMs), error: `${transportError.message}${previouslyUnknown && transportError.kind !== 'unknown' ? '；此前发送仍可能已送达，需继续核对' : ''}` });
      if (transportError.kind === 'login') this.state(channel.id, 'login_required', transportError.message);
      this.store.event(item.taskId, 'channel.send_unconfirmed', { outboxId: item.id, kind: transportError.kind });
    } finally { if (this.outgoing.get(channel.id) === abort) this.outgoing.delete(channel.id); }
  }
  async reconcileOutbox(id: string, action: 'query' | 'delivered' | 'retry', revision: number): Promise<PaChannelOutbox> {
    const item = this.store.require<OutboxRecord>('channel_outbox', id), channel = this.record(item.channelId);
    if (item.revision !== revision || !['unknown', 'failed'].includes(item.state)) throw new PaError('发送记录已更新，请刷新后重试', 409);
    if (action === 'query') {
      if (!paOutboxAuthorizationMatches(item, channel)) throw new PaError('此消息属于旧账号或旧授权，请在原会话人工核对');
      const transport = this.transports.get(channel.connectionId ?? channel.id);
      if (!item.providerMessageId || !transport?.receipt) throw new PaError('平台没有可查询的消息回执；请先在目标会话人工核对，不能推断已送达');
      if (!await transport.receipt(item.providerMessageId, AbortSignal.timeout(10000))) throw new PaError('未查到可靠送达证据，仍保留待核对状态');
      const current = this.store.require<OutboxRecord>('channel_outbox', id);
      if (current.revision !== revision || this.record(channel.id).authorizationVersion !== item.authorizationVersion) throw new PaError('查询期间发送记录或授权已更新，请刷新后重试', 409);
    }
    if (action === 'retry' && (!channel.enabled || !paOutboxAuthorizationMatches(item, channel))) throw new PaError('账号或授权已改变，不能重发旧操作');
    this.store.event(item.taskId, `channel.manual_${action}`, { outboxId: id, requestId: item.requestId, textHash: item.textHash, authorizationVersion: item.authorizationVersion });
    const next = this.store.update<OutboxRecord>('channel_outbox', id, action === 'retry' ? { state: 'pending', uncertainSince: null, firstAttemptAt: null, nextAttemptAt: Date.now(), error: null } : { state: 'sent', sentAt: Date.now(), error: null });
    void this.tick(); return this.publicOutbox(next);
  }
  async close(): Promise<void> {
    this.closing = true; clearInterval(this.timer); this.timer = undefined; this.unsubscribe?.();
    this.mediaJob?.abort.abort();
    for (const login of this.logins.values()) login.abort.abort();
    for (const id of this.feishuRegistrations.keys()) this.cancelFeishuRegistration(id);
    for (const abort of this.outgoing.values()) abort.abort();
    const transports = [...this.transports.values()]; this.transports.clear();
    await Promise.allSettled(transports.map(transport => transport.stop()));
    await Promise.allSettled([...this.inFlight]);
  }
}
