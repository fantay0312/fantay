import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { paTaskInputSchema, paOutboxAuthorizationMatches, type PaChannel, type PaChannelInput, type PaChannelInbox, type PaChannelOutbox, type PaChannelSnapshot, type PaChannelLogin, type PaChannelPairing, type PaProjectApproval, type PaTask, type PaAttempt, type PaEntity } from '@open-design/contracts';
import { FileConnectorCredentialStore, type ConnectorCredentialStore } from '../connectors/service.js';
import { PaError, type PaStore } from '../storage/personal-agent-store.js';
import type { PersonalAgentService } from './personal-agent-service.js';
import { summarizePaOutput } from './personal-agent-output.js';
import { PaFeishuTransport } from '../integrations/pa-feishu.js';
import { PaWeixinLoginClient, PaWeixinTransport, type WeixinLoginSession } from '../integrations/pa-weixin.js';
import { PaChannelTransportError, channelRecord as obj, channelText as str, type PaChannelTransport, type PaInboundMessage, type PaOutboundMessage } from '../integrations/pa-channel-transport.js';
import { redactPaCredentials } from './personal-agent-gateway.js';

interface ChannelRecord extends PaChannel { credentialRef: string; cursor: string; accountKey: string | null; contextRefs?: string[] }
interface InboxRecord extends PaChannelInbox { text: string; authorizationVersion: number; direct: boolean; contextRef: string | null; unsupported: boolean; taskInput?: import('@open-design/contracts').PaTaskInput }
interface OutboxRecord extends PaChannelOutbox { text: string; firstAttemptAt: number | null; textHash: string; uncertainSince?: number | null; memoryRefs?: PaAttempt['memoryRefs'] }
interface PairingRecord extends PaEntity { channelId: string; codeHash: string; expiresAt: number; consumed: boolean }
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
}

/** The channel adapter only admits events and records receipts; PA owns all model execution. */
export class PersonalAgentChannels {
  private readonly store: PaStore;
  private readonly credentials: ConnectorCredentialStore;
  private readonly loginClient: PaWeixinLoginClient;
  private transports = new Map<string, PaChannelTransport>();
  private epochs = new Map<string, number>();
  private logins = new Map<string, { abort: AbortController; session: WeixinLoginSession; public: PaChannelLogin; epoch: number }>();
  private outgoing = new Map<string, AbortController>();
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
    for (const channel of this.store.list<ChannelRecord>('channels')) if (channel.enabled && channel.credentialConfigured) void this.connect(channel.id).catch(() => {});
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
  private publicChannel(channel: ChannelRecord): PaChannel { const { credentialRef: _credentials, cursor: _cursor, accountKey: _account, contextRefs: _contexts, ...value } = channel; return value; }
  private publicOutbox({ text: _text, firstAttemptAt: _first, textHash: _hash, uncertainSince: _uncertain, memoryRefs: _memoryRefs, ...value }: OutboxRecord): PaChannelOutbox {
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
    return { channels: this.store.list<ChannelRecord>('channels').map(channel => this.publicChannel(channel)),
      inbox: [...actionable.filter(row => !recentIds.has(row.id)), ...recent].map(({ text: _text, taskInput: _input, authorizationVersion: _auth, direct: _direct, contextRef: _context, unsupported: _unsupported, ...value }) =>
        value.state === 'approval' ? { ...value, approvalActionable: actionableIds.has(value.id) } : value),
      outbox: this.store.list<OutboxRecord>('channel_outbox').slice(-100).map(row => this.publicOutbox(row)) };
  }
  create(input: PaChannelInput): PaChannel {
    this.store.require(input.targetKind === 'agent' ? 'agents' : 'groups', input.targetId);
    const id = randomUUID();
    const channel = this.store.create<ChannelRecord>('channels', { ...input, enabled: false, authorizationVersion: 1, status: 'disconnected', credentialConfigured: false,
      credentialRef: `pa-channel:${id}`, cursor: '', accountKey: null, accountLabel: null, lastReceivedAt: null, lastSentAt: null, lastError: null,
      capabilities: { direct: true, groups: input.type === 'feishu', threads: input.type === 'feishu', files: false, unsolicited: false },
      verification: { inboundAt: null, outboundAt: null, reconnectAt: null, reloginAt: null } }, id);
    return this.publicChannel(channel);
  }
  async update(id: string, input: PaChannelInput, revision: number): Promise<PaChannel> {
    const current = this.record(id);
    if (current.type !== input.type) throw new PaError('不能更换已有连接的平台，请新建连接');
    this.store.require(input.targetKind === 'agent' ? 'agents' : 'groups', input.targetId);
    if (input.enabled && current.type === 'feishu' && current.accountKey) this.assertExclusiveFeishu(id, current.accountKey);
    if (current.type === 'weixin' && current.accountKey) {
      const credentials = this.credentials.get(current.credentialRef)?.credentials;
      if (input.allowedSenderIds.length !== 1 || input.allowedSenderIds[0] !== credentials?.ownerId || input.remoteChatId !== credentials?.ownerId) throw new PaError('个人微信仅允许扫码绑定的所有者单聊');
    }
    const next = this.store.update<ChannelRecord>('channels', id, { ...input, authorizationVersion: current.authorizationVersion + 1 }, revision);
    this.options.core.revokeChannel(id);
    this.cancelPendingOutbox(id);
    if (next.enabled && next.credentialConfigured) await this.connect(id); else await this.stopTransport(id);
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
  private assertExclusiveFeishu(id: string, appId: string): void {
    if (this.store.list<ChannelRecord>('channels').some(channel => channel.id !== id && channel.type === 'feishu' && channel.enabled && channel.accountKey === appId)) throw new PaError('同一飞书应用只能启用一个 PA 连接，以免长连接分流消息；请先停用重复连接');
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
  async configureFeishu(id: string, input: { appId?: string; appSecret?: string; localAppId?: string }): Promise<PaChannel> {
    const channel = this.record(id);
    if (channel.type !== 'feishu') throw new PaError('此连接不是飞书');
    const source = input.localAppId ? this.readLocalFeishuApps().find(item => item.appId === input.localAppId) : input;
    const appId = str(source?.appId), appSecret = str(source?.appSecret);
    if (!/^cli_[a-zA-Z0-9]+$/.test(appId) || !appSecret || appSecret.length > 500) throw new PaError('请输入有效的飞书应用 ID 和 Secret');
    this.assertExclusiveFeishu(id, appId);
    const epoch = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, epoch);
    await this.stopTransport(id, epoch);
    if (this.epochs.get(id) !== epoch || this.record(id).authorizationVersion !== channel.authorizationVersion || this.closing) throw new PaError('连接操作已取消', 409);
    const identity = await new PaFeishuTransport({ appId, appSecret }).identity();
    if (this.epochs.get(id) !== epoch || this.record(id).authorizationVersion !== channel.authorizationVersion || this.closing) throw new PaError('连接配置已改变，请重新操作', 409);
    this.assertExclusiveFeishu(id, appId);
    this.options.core.revokeChannel(id); this.cancelPendingOutbox(id);
    this.purgeContexts(id);
    this.storeCredentials(channel, { provider: 'pa-feishu', appId, appSecret, botId: identity.openId });
    this.store.update<ChannelRecord>('channels', id, { enabled: true, credentialConfigured: true, accountLabel: identity.name, accountKey: appId, cursor: '', authorizationVersion: channel.authorizationVersion + 1,
      ...(channel.accountKey && channel.accountKey !== appId ? { allowedSenderIds: [], remoteChatId: null, tenantId: null } : {}) });
    await this.connect(id);
    return this.publicChannel(this.record(id));
  }
  async beginWeixinLogin(id: string): Promise<PaChannelLogin> {
    const channel = this.record(id);
    if (channel.type !== 'weixin') throw new PaError('此连接不是个人微信');
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
    if (channel.type !== 'feishu' || !channel.enabled || !channel.credentialConfigured) throw new PaError('请先连接飞书机器人');
    const code = randomBytes(12).toString('hex'), expiresAt = Date.now() + 10 * 60000;
    const current = this.store.get<PairingRecord>('channel_pairings', id);
    const fields = { channelId: id, codeHash: hash(code), expiresAt, consumed: false };
    if (current) this.store.update<PairingRecord>('channel_pairings', id, fields); else this.store.create<PairingRecord>('channel_pairings', fields, id);
    return { channelId: id, code: `绑定 ${code}`, expiresAt };
  }
  async connect(id: string): Promise<void> {
    const epoch = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, epoch);
    const old = this.transports.get(id); this.transports.delete(id); await old?.stop();
    if (this.epochs.get(id) !== epoch || this.closing) return;
    const channel = this.record(id), credentials = this.credentials.get(channel.credentialRef)?.credentials;
    if (!channel.enabled || !credentials) { this.state(id, credentials ? 'disconnected' : 'login_required'); return; }
    if (channel.type === 'feishu' && channel.accountKey) {
      try { this.assertExclusiveFeishu(id, channel.accountKey); } catch (error) { this.state(id, 'error', error instanceof Error ? error.message : '存在重复飞书连接'); return; }
    }
    const journal = { cursor: () => this.record(id).cursor, checkpoint: (cursor: string) => { if (this.epochs.get(id) === epoch && this.record(id).cursor !== cursor) this.store.update<ChannelRecord>('channels', id, { cursor }); } };
    const transport = this.options.transportFactory?.(this.publicChannel(channel), credentials, journal) ?? (channel.type === 'feishu'
      ? new PaFeishuTransport({ appId: str(credentials.appId), appSecret: str(credentials.appSecret) })
      : new PaWeixinTransport({ token: str(credentials.token), baseUrl: str(credentials.baseUrl), ownerId: str(credentials.ownerId), ...journal }));
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
    if (!channel.credentialConfigured) throw new PaError('请先配置账号');
    if (channel.type === 'feishu' && channel.accountKey) this.assertExclusiveFeishu(id, channel.accountKey);
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
    this.store.update<ChannelRecord>('channels', id, { enabled: false, authorizationVersion: channel.authorizationVersion + 1, ...(forget ? { credentialConfigured: false, cursor: '', accountKey: null, accountLabel: null, allowedSenderIds: [], remoteChatId: null, tenantId: null } : {}) });
    const epoch = (this.epochs.get(id) ?? 0) + 1; this.epochs.set(id, epoch);
    this.options.core.revokeChannel(id); this.cancelPendingOutbox(id); await this.stopTransport(id, epoch);
    if (forget && this.epochs.get(id) === epoch) { this.credentials.delete(channel.credentialRef); this.purgeContexts(id); }
    return this.publicChannel(this.record(id));
  }
  private cancelPendingOutbox(id: string): void {
    for (const item of this.store.list<OutboxRecord>('channel_outbox')) if (item.channelId === id && ['pending', 'failed'].includes(item.state)) this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'cancelled', error: '渠道授权或账号已改变，旧回复不再投递' });
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
    const inboxId = hash(`${id}:${channel.accountKey}:${message.senderId}:${message.id}`);
    if (this.store.has('channel_inbox', inboxId)) return;
    if (!message.direct && (channel.type !== 'feishu' || !message.mentioned)) return;
    let paired = false;
    const match = /^(?:绑定|bind)\s+([a-f0-9]{24})$/i.exec(message.text.trim());
    const pairing = this.store.get<PairingRecord>('channel_pairings', id);
    if (match && pairing && message.tenantId && Date.now() - message.createdAt <= MAX_EVENT_AGE && !pairing.consumed && pairing.expiresAt > Date.now() && timingSafeEqual(Buffer.from(hash(match[1]!.toLowerCase())), Buffer.from(pairing.codeHash))) {
      channel = this.store.transaction(() => {
        this.store.update<PairingRecord>('channel_pairings', id, { consumed: true });
        return this.store.update<ChannelRecord>('channels', id, { allowedSenderIds: [message.senderId], remoteChatId: message.chatId, tenantId: message.tenantId, authorizationVersion: channel.authorizationVersion + 1 });
      });
      paired = true;
      this.options.core.revokeChannel(id);
      this.cancelPendingOutbox(id);
    }
    const authorized = channel.allowedSenderIds.includes(message.senderId) && channel.remoteChatId === message.chatId && (channel.type !== 'feishu' || Boolean(channel.tenantId) && channel.tenantId === message.tenantId);
    const stale = Date.now() - message.createdAt > MAX_EVENT_AGE || message.createdAt > Date.now() + 60000;
    if (!authorized || stale) {
      this.store.create<InboxRecord>('channel_inbox', { channelId: id, providerMessageId: message.id, senderId: message.senderId, chatId: message.chatId, threadId: message.threadId, receivedAt: Date.now(), taskId: null, state: 'ignored', error: authorized ? '消息已过期，未执行' : '发送者或会话未授权', preview: '', text: '', authorizationVersion: channel.authorizationVersion, direct: message.direct, contextRef: null, unsupported: false }, inboxId);
      return;
    }
    const contextRef = message.contextToken ? `pa-context:${id}:${hash(message.senderId).slice(0, 24)}` : null;
    if (contextRef && !channel.contextRefs?.includes(contextRef)) channel = this.store.update<ChannelRecord>('channels', id, { contextRefs: [...(channel.contextRefs ?? []), contextRef] });
    if (contextRef) this.credentials.set({ schemaVersion: 1, connectorId: contextRef, accountLabel: channel.name, credentials: { provider: 'pa-context', contextToken: message.contextToken, accountKey: channel.accountKey }, updatedAt: new Date().toISOString() });
    const text = paired ? '绑定确认' : message.text;
    const item = this.store.transaction(() => {
      const incoming = this.store.create<InboxRecord>('channel_inbox', { channelId: id, providerMessageId: message.id, senderId: message.senderId, chatId: message.chatId, threadId: message.threadId, receivedAt: Date.now(), taskId: null, state: paired ? 'accepted' : 'pending', error: null, preview: text.slice(0, 600), text: text.slice(0, 32001), authorizationVersion: channel.authorizationVersion, direct: message.direct, contextRef, unsupported: message.unsupported === true }, inboxId);
      this.store.update<ChannelRecord>('channels', id, { lastReceivedAt: Date.now(), verification: { ...channel.verification, inboundAt: Date.now() } });
      this.store.event(null, 'channel.received', { channelId: id, inboxId, providerMessageId: message.id });
      return incoming;
    });
    if (paired) this.enqueueReply(item, 'paired', '已绑定 Fantay。只有此已授权身份与会话可以发起工作。发送 /help 查看用法。');
    this.scheduleTick();
  }
  private enqueueReply(inbox: InboxRecord, suffix: string, text: string, taskId: string | null = inbox.taskId, memoryRefs?: PaAttempt['memoryRefs']): void {
    const id = hash(`${inbox.id}:${suffix}`);
    if (this.store.has('channel_outbox', id)) return;
    const channel = this.record(inbox.channelId);
    if (!channel.enabled || channel.authorizationVersion !== inbox.authorizationVersion) return;
    const redacted = redactPaCredentials(text);
    const bounded = redacted.length > MAX_REPLY ? `${redacted.slice(0, MAX_REPLY - (TAIL.length + 2))}\n\n${TAIL}` : redacted;
    this.store.create<OutboxRecord>('channel_outbox', { channelId: channel.id, taskId, inboxId: inbox.id, requestId: randomUUID(), state: 'pending', providerMessageId: null, attempts: 0, nextAttemptAt: Date.now(), error: null, sentAt: null,
      preview: bounded, text: bounded, authorizationVersion: channel.authorizationVersion, firstAttemptAt: null, textHash: hash(bounded),
      ...(memoryRefs ? { memoryRefs } : {}) }, id);
  }
  private processInbox(item: InboxRecord): void {
    const channel = this.record(item.channelId);
    if (!channel.enabled || channel.authorizationVersion !== item.authorizationVersion) { this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'ignored', error: '渠道授权已改变，旧消息未执行' }); return; }
    const conversation = this.options.core.channelConversation(channel, `${item.chatId}:${item.threadId ?? 'main'}`);
    const text = item.text.trim();
    const tasks = this.store.list<PaTask>('tasks').filter(task =>
      task.conversationId === conversation.id && task.dataClass !== 'local_only' &&
      (task.principal?.kind !== 'channel' || task.principal.subjectId === item.senderId));
    if (item.unsupported || !text || text.length > 32000) { this.enqueueReply(item, 'unsupported', item.unsupported ? '此 PA 渠道目前支持文字消息，请用文字描述目标；文件、语音和图片尚未开放。' : '消息为空或过长，请分段发送。'); this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted' }); return; }
    if (/^\/(help|帮助)$/i.test(text)) {
      this.enqueueReply(item, 'help', '直接发送文字即可发起工作。\n/status 查看本会话任务\n/stop [任务ID] 停止当前任务\n/resume 任务ID 恢复可继续的任务\n/amend 任务ID 新要求\n/project 项目目标（需要本地项目授权或桌面批准）\n私人记忆默认不会进入外部渠道。');
      this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted' }); return;
    }
    if (/^\/status\b/i.test(text)) {
      this.enqueueReply(item, 'status', tasks.slice(-5).map(task => `${task.id}\n${task.goal.slice(0, 120)}\n${task.status}${task.waitingReason ? `：${task.waitingReason}` : ''}`).join('\n\n') || '此会话还没有任务。');
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
    const goal = project ? text.replace(/^\/project\s+/i, '') : text;
    const requestId = `channel:${item.id}`;
    const input = item.taskInput ?? paTaskInputSchema.parse({ requestId, conversationId: conversation.id, goal, kind: project ? 'project' : 'discussion', budget: this.options.core.defaultTaskBudget() });
    if (input.goal !== goal || input.conversationId !== conversation.id) throw new PaError('原始请求或会话授权已改变，请重新发起');
    if (!item.taskInput) this.store.update<InboxRecord>('channel_inbox', item.id, { taskInput: input });
    let approval = this.store.list<PaProjectApproval>('approvals').find(value => value.inboxId === item.id);
    if (project && !channel.allowProject && approval?.state !== 'approved') {
      if (!approval) approval = this.store.create<PaProjectApproval>('approvals', { channelId: channel.id, inboxId: item.id, requestId, goalHash: hash(goal), parametersHash: hash(JSON.stringify(input)), authorizationVersion: channel.authorizationVersion, state: 'pending', expiresAt: Date.now() + 86400000, taskId: null });
      this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'approval', approvalId: approval.id });
      this.enqueueReply(item, 'approval', '已记录项目请求，等待桌面 PA 中批准本次创建。不会在未授权时创建项目。'); return;
    }
    const task = this.options.core.submit(input, approval?.state === 'approved' ? approval.id : undefined, undefined, {
      kind: 'channel', id: channel.id, accountId: channel.accountKey ?? channel.id,
      subjectId: item.senderId, threadId: conversation.externalThreadId!, authorizationVersion: channel.authorizationVersion,
    });
    if (approval) this.store.update<PaProjectApproval>('approvals', approval.id, { taskId: task.id });
    const accepted = this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'accepted', taskId: task.id, error: null });
    this.enqueueReply(accepted, 'accepted', `已记录任务：${task.id}\n${goal.slice(0, 180)}\n完成或需要你处理时会在这里回复。`);
  }
  approveProject(inboxId: string, approved: boolean, revision: number): void {
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
    if (!approved) this.enqueueReply(inbox, 'approval-rejected', '本次项目创建未获批准，未创建项目。');
    void this.tick();
  }
  private notifyTask(inbox: InboxRecord): void {
    if (!inbox.taskId) return;
    const task = this.store.get<PaTask>('tasks', inbox.taskId);
    if (!task || task.dataClass === 'local_only' || !FINAL_STATES.has(task.status)) return;
    const attemptCount = this.store.countTaskAttempts(task.id);
    const suffix = `state:${hash(`${task.status}:${task.nextParticipant}:${attemptCount}:${task.waitingReason ?? ''}`).slice(0, 24)}`;
    if (this.store.has('channel_outbox', hash(`${inbox.id}:${suffix}`))) return;
    const attempts = this.store.listTaskAttempts<PaAttempt>(task.id);
    const last = attempts.filter(attempt => attempt.status === 'completed' && attempt.phase !== 'review').at(-1);
    let result = last?.output ?? '';
    try { const parsed = obj(JSON.parse(result.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))); if (typeof parsed.summary === 'string') result = parsed.summary; } catch { /* ordinary text */ }
    const state = { completed: '已完成', waiting: '等待处理', failed: '未完成', cancelled: '已停止' }[task.status as 'completed'];
    const text = [`任务${state}：${task.id}`, task.goal.slice(0, 140), task.status === 'completed' ? summarizePaOutput(result, 1800) : task.waitingReason ?? task.error ?? '已停止后续执行，已有成果保留。',
      ...(task.projectId ? [`Fantay 项目：${task.projectName}（${task.projectId}）`] : []), ...(task.evidence.length ? [`验证：${summarizePaOutput(task.evidence.slice(-2).join('；'), 700)}`] : [])].join('\n\n');
    const refs = attempts.filter(attempt => attempt.status === 'completed').flatMap(attempt => attempt.memoryRefs ?? []);
    this.enqueueReply(inbox, suffix, text, task.id, refs);
  }
  async tick(): Promise<void> {
    if (this.closing || this.options.acceptsNewWork?.() === false) return;
    for (const item of this.store.listActionableChannelInbox<InboxRecord>()) {
      let current = item;
      if (item.state === 'pending') {
        try { this.processInbox(item); }
        catch (error) { const message = error instanceof PaError ? error.message : '任务暂时无法受理，请在桌面检查连接与模型设置'; this.store.update<InboxRecord>('channel_inbox', item.id, { state: 'failed', error: message }); this.enqueueReply(item, 'rejected', message); }
        current = this.store.require<InboxRecord>('channel_inbox', item.id);
      }
      if (current.state === 'accepted' && current.taskId) this.notifyTask(current);
    }
    if (this.processing) return;
    const actionableOutbox = this.store.listActionableChannelOutbox<OutboxRecord>();
    if (actionableOutbox.length === 0) return;
    this.processing = true;
    try {
      for (const item of actionableOutbox) {
        if (this.closing) break;
        if (item.state === 'pending' && item.nextAttemptAt <= Date.now()) await this.trackedDelivery(item);
        else if (item.state === 'unknown') {
          const transport = this.transports.get(item.channelId);
          if (transport?.idempotencyWindowMs && item.firstAttemptAt && Date.now() - item.firstAttemptAt < transport.idempotencyWindowMs - 30000 && item.attempts < 3 && item.nextAttemptAt <= Date.now()) await this.trackedDelivery(item);
        }
      }
    } finally { this.processing = false; }
  }

  hasActiveWork(): boolean {
    return this.processing || this.inFlight.size > 0 || this.logins.size > 0;
  }
  private async trackedDelivery(item: OutboxRecord): Promise<void> {
    const work = this.deliver(item); this.inFlight.add(work);
    try { await work; } finally { this.inFlight.delete(work); }
  }
  private async deliver(item: OutboxRecord): Promise<void> {
    if (this.store.get<OutboxRecord>('channel_outbox', item.id)?.revision !== item.revision) return;
    const channel = this.record(item.channelId), inbox = this.store.require<InboxRecord>('channel_inbox', item.inboxId), transport = this.transports.get(channel.id);
    if (!channel.enabled || channel.authorizationVersion !== item.authorizationVersion || !channel.allowedSenderIds.includes(inbox.senderId) || channel.remoteChatId !== inbox.chatId) { if (item.state === 'pending') this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'cancelled', error: '回复目标授权已改变' }); return; }
    if (!this.options.core.memoryRefsCurrent(item.memoryRefs)) {
      if (item.state === 'pending') this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'cancelled', error: '回复引用的记忆已改变' });
      return;
    }
    if (!transport || channel.status !== 'connected') return;
    const previouslyUnknown = item.state === 'unknown' || Boolean(item.uncertainSince);
    if (previouslyUnknown && (!transport.idempotencyWindowMs || !item.firstAttemptAt || Date.now() - item.firstAttemptAt >= transport.idempotencyWindowMs - 30000)) {
      if (item.state !== 'unknown') this.store.update<OutboxRecord>('channel_outbox', item.id, { state: 'unknown', error: '此前发送结果未知，已停止超过平台去重窗口的自动重试' });
      return;
    }
    const secret = inbox.contextRef ? this.credentials.get(inbox.contextRef)?.credentials : undefined;
    const outbound: PaOutboundMessage = { requestId: item.requestId, chatId: inbox.chatId, threadId: inbox.threadId, replyTo: inbox.providerMessageId, text: item.text,
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
      const transport = this.transports.get(channel.id);
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
    for (const login of this.logins.values()) login.abort.abort();
    for (const abort of this.outgoing.values()) abort.abort();
    const transports = [...this.transports.values()]; this.transports.clear();
    await Promise.allSettled(transports.map(transport => transport.stop()));
    await Promise.allSettled([...this.inFlight]);
  }
}
