import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paChannelInputSchema, type PaChannel, type PaChannelOutbox, type PaTask, type PaControl } from '@open-design/contracts';
import { closeDatabase, openDatabase, type SqliteDb } from '../src/db.js';
import { PersonalAgentService } from '../src/services/personal-agent-service.js';
import { PersonalAgentChannels } from '../src/services/personal-agent-channels.js';
import { InMemoryConnectorCredentialStore } from '../src/connectors/service.js';
import { PaChannelTransportError, parseChannelJson, type PaChannelTransport, type PaInboundMessage, type PaOutboundMessage } from '../src/integrations/pa-channel-transport.js';
import { normalizeFeishuMessage, PaFeishuTransport } from '../src/integrations/pa-feishu.js';
import { normalizeWeixinMessage, PaWeixinTransport, PaWeixinLoginClient, weixinOrigin } from '../src/integrations/pa-weixin.js';
import type { PaModelRuntime } from '../src/runtimes/personal-agent.js';

class Transport implements PaChannelTransport {
  idempotencyWindowMs = 0;
  received: ((message: PaInboundMessage) => Promise<void>) | undefined;
  send = vi.fn<PaChannelTransport['send']>(async message => ({ acknowledged: true, messageId: `receipt-${message.requestId}` }));
  receipt = vi.fn(async (_messageId: string, _signal: AbortSignal) => true);
  async start(receive: (message: PaInboundMessage) => Promise<void>, state: (status: 'connected') => void) { this.received = receive; state('connected'); }
  async stop() {}
}
let dir: string, db: SqliteDb, core: PersonalAgentService, channels: PersonalAgentChannels, credentials: InMemoryConnectorCredentialStore;
let transport: Transport;
const execute = vi.fn<PaModelRuntime['execute']>(async (_model, prompt) => ({ text: prompt.includes('"approved":true|false') ? JSON.stringify({ approved: true, summary: 'Verified test brief', issues: [] }) : prompt.includes('"files":[') ? JSON.stringify({ summary: 'Created test brief', files: [{ path: 'brief.md', content: '# Verified brief\n\nLocal test content.' }] }) : 'A verified channel answer', usage: { visibility: 'unknown' } }));
beforeEach(() => {
  dir = mkdtempSync(join(process.cwd(), '.tmp-pa-m3-')); db = openDatabase(dir, { dataDir: dir });
  execute.mockClear();
  core = new PersonalAgentService({ db, dataDir: dir, projectsDir: join(dir, 'projects'), runtime: { execute, models: async () => [] } });
  credentials = new InMemoryConnectorCredentialStore(); transport = new Transport();
  channels = new PersonalAgentChannels({ core, dataDir: dir, credentialStore: credentials, transportFactory: () => transport });
});
afterEach(async () => { vi.restoreAllMocks(); await channels.close(); await core.shutdown(); closeDatabase(); rmSync(dir, { recursive: true, force: true }); });
async function connected(type: 'feishu' | 'weixin' = 'feishu', extra: Partial<PaChannel> = {}) {
  const created = channels.create(paChannelInputSchema.parse({ type, name: 'Test channel', targetKind: 'group', targetId: core.snapshot().groups[0]!.id }));
  const channel = core.store.update<PaChannel>('channels', created.id, { enabled: true, credentialConfigured: true, allowedSenderIds: ['owner'], remoteChatId: 'chat', tenantId: 'tenant', ...extra });
  const privateRecord = core.store.require<PaChannel & { credentialRef: string }>('channels', created.id);
  credentials.set({ schemaVersion: 1, connectorId: privateRecord.credentialRef, accountLabel: 'Test', credentials: { token: 'TEST_ONLY_TOKEN', ownerId: 'owner', provider: type }, updatedAt: new Date().toISOString() });
  transport.idempotencyWindowMs = type === 'feishu' ? 3600000 : 0;
  channels.start(); await vi.waitFor(() => expect(channels.snapshot().channels[0]!.status).toBe('connected'));
  return channel;
}
function inbound(id = 'message-one', text = 'Please summarize this brief', extra: Partial<PaInboundMessage> = {}): PaInboundMessage {
  return { id, text, senderId: 'owner', chatId: 'chat', tenantId: 'tenant', threadId: null, createdAt: Date.now(), direct: true, mentioned: false, contextToken: 'TEST_ONLY_CONTEXT', ...extra };
}
async function finishTask() { await vi.waitFor(() => expect(core.snapshot().tasks.at(-1)?.status).toBe('completed'), { timeout: 5000 }); await channels.tick(); }

describe('PA channel admission and delivery', () => {
  it('deduplicates authenticated events and never exposes credentials in public snapshots', async () => {
    const channel = await connected();
    const message = inbound(); channels.accept(channel.id, message); channels.accept(channel.id, message);
    await finishTask(); await channels.tick();
    expect(core.snapshot().tasks).toHaveLength(1);
    expect(channels.snapshot().inbox).toHaveLength(1);
    expect(transport.send.mock.calls.length).toBeGreaterThanOrEqual(1);
    const publicJson = JSON.stringify(channels.snapshot());
    expect(publicJson).not.toContain('TEST_ONLY_TOKEN'); expect(publicJson).not.toContain('TEST_ONLY_CONTEXT');
    expect(core.snapshot().conversations.find(conversation => conversation.channelId === channel.id)).toBeTruthy();
  });
  it('ignores unauthorized senders, wrong chats, wrong tenants, stale messages and unmentioned groups', async () => {
    const channel = await connected();
    channels.accept(channel.id, inbound('other-user', 'PRIVATE EXTERNAL MESSAGE', { senderId: 'outsider' }));
    channels.accept(channel.id, inbound('other-chat', 'do work', { chatId: 'elsewhere' }));
    channels.accept(channel.id, inbound('other-tenant', 'do work', { tenantId: 'other' }));
    channels.accept(channel.id, inbound('stale', 'do work', { createdAt: Date.now() - 3600000 }));
    channels.accept(channel.id, inbound('group', 'do work', { direct: false, mentioned: false }));
    await channels.tick();
    expect(core.snapshot().tasks).toHaveLength(0); expect(execute).not.toHaveBeenCalled(); expect(transport.send).not.toHaveBeenCalled();
    expect(JSON.stringify(channels.snapshot())).not.toContain('PRIVATE EXTERNAL MESSAGE');
  });
  it('pairs exactly one sender and chat using an expiring single-use code', async () => {
    const channel = await connected('feishu', { allowedSenderIds: [], remoteChatId: null, tenantId: null });
    const pairing = channels.pairing(channel.id);
    channels.accept(channel.id, inbound('pair', pairing.code)); await channels.tick();
    expect(channels.snapshot().channels[0]).toMatchObject({ allowedSenderIds: ['owner'], remoteChatId: 'chat', tenantId: 'tenant' });
    channels.accept(channel.id, inbound('replay-pair', pairing.code, { senderId: 'outsider', chatId: 'different' }));
    expect(channels.snapshot().channels[0]!.allowedSenderIds).toEqual(['owner']);
    expect(core.snapshot().tasks).toHaveLength(0);
  });
  it('keeps private, agent and unshared group memory out of external prompts', async () => {
    core.saveMemory({ content: 'PRIVATE_MEMORY', source: 'owner', scope: 'private', scopeId: null });
    core.saveMemory({ content: 'AGENT_MEMORY', source: 'owner', scope: 'agent', scopeId: core.snapshot().agents[0]!.id });
    core.saveMemory({ content: 'GROUP_MEMORY', source: 'owner', scope: 'group', scopeId: core.snapshot().groups[0]!.id });
    const channel = await connected(); channels.accept(channel.id, inbound()); await finishTask();
    for (const call of execute.mock.calls) { expect(call[1]).not.toContain('PRIVATE_MEMORY'); expect(call[1]).not.toContain('AGENT_MEMORY'); expect(call[1]).not.toContain('GROUP_MEMORY'); }
  });
  it('waits for a scoped project approval and rejects changed goal parameters', async () => {
    const channel = await connected(); channels.accept(channel.id, inbound('project', '/project Build a local document')); await channels.tick();
    expect(core.snapshot().tasks).toHaveLength(0);
    const item = channels.snapshot().inbox[0]!; expect(item.state).toBe('approval');
    expect(channels.pendingApprovalCount()).toBe(1);
    expect(item.approvalActionable).toBe(true);
    channels.approveProject(item.id, true, item.revision); await finishTask();
    expect(channels.pendingApprovalCount()).toBe(0);
    expect(core.snapshot().tasks[0]!.authorization.approvalId).toBeTruthy();
    expect(core.snapshot().artifacts).toHaveLength(1);
    channels.accept(channel.id, inbound('modified-project', '/project Original goal')); await channels.tick();
    const next = channels.snapshot().inbox.at(-1)!;
    const mutated = core.store.update<import('@open-design/contracts').PaChannelInbox & { text: string }>('channel_inbox', next.id, { text: '/project Different goal' });
    expect(() => channels.approveProject(next.id, true, mutated.revision)).toThrow('目标已改变'); await channels.tick();
    expect(core.snapshot().tasks).toHaveLength(1);
    expect(channels.snapshot().inbox.at(-1)!.state).toBe('approval');
    core.store.update<PaChannel>('channels', channel.id, { authorizationVersion: channel.authorizationVersion + 1 });
    expect(channels.pendingApprovalCount()).toBe(0);
    expect(channels.snapshot().inbox.at(-1)?.approvalActionable).toBe(false);
  });
  it('accepts stop while an earlier outgoing reply is awaiting its receipt', async () => {
    let finishSend!: (value: { acknowledged: true; messageId: string }) => void;
    transport.send.mockImplementationOnce(() => new Promise(resolve => { finishSend = resolve; }));
    execute.mockImplementationOnce((_model, _prompt, _run, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })));
    const channel = await connected(); channels.accept(channel.id, inbound());
    await vi.waitFor(() => expect(core.snapshot().tasks[0]?.status).toBe('running'));
    const task = core.snapshot().tasks[0]!;
    channels.accept(channel.id, inbound('stop', `/stop ${task.id}`)); await channels.tick();
    expect(core.store.require<PaTask>('tasks', task.id).authorization.revoked).toBe(true);
    finishSend({ acknowledged: true, messageId: 'first-receipt' });
    await vi.waitFor(() => expect(core.store.require<PaTask>('tasks', task.id).status).toBe('cancelled'));
  });
  it('does not automatically resend unknown WeChat outcomes', async () => {
    transport.send.mockRejectedValueOnce(new PaChannelTransportError('Unknown send', 'unknown'));
    const channel = await connected('weixin'); channels.accept(channel.id, inbound('status', '/status')); await channels.tick();
    const unknown = channels.snapshot().outbox[0]!; expect(unknown.state).toBe('unknown');
    core.store.update<PaChannelOutbox>('channel_outbox', unknown.id, { nextAttemptAt: 0 });
    await channels.tick(); expect(transport.send).toHaveBeenCalledTimes(1);
    const current = channels.snapshot().outbox[0]!;
    await channels.reconcileOutbox(current.id, 'retry', current.revision); await channels.tick();
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(transport.send.mock.calls[0]![0].requestId).toBe(transport.send.mock.calls[1]![0].requestId);
  });
  it('exposes the authorization of taskless receipts and prevents resend after rebinding', async () => {
    transport.send.mockRejectedValueOnce(new PaChannelTransportError('Unknown send', 'unknown'));
    const channel = await connected('weixin');
    channels.accept(channel.id, inbound('status', '/status')); await channels.tick();
    const item = channels.snapshot().outbox[0]!;
    expect(item).toMatchObject({ taskId: null, state: 'unknown', authorizationVersion: channel.authorizationVersion });
    core.store.update<PaChannel>('channels', channel.id, { authorizationVersion: channel.authorizationVersion + 1 });
    await expect(channels.reconcileOutbox(item.id, 'retry', item.revision)).rejects.toThrow('不能重发');
    const delivered = await channels.reconcileOutbox(item.id, 'delivered', item.revision);
    expect(delivered).toMatchObject({ state: 'sent', authorizationVersion: item.authorizationVersion });
    expect(delivered).not.toHaveProperty('textHash');
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it('reuses Feishu UUID only within its documented deduplication window', async () => {
    transport.send.mockRejectedValueOnce(new PaChannelTransportError('Lost response', 'unknown'));
    const channel = await connected(); channels.accept(channel.id, inbound('status', '/status')); await channels.tick();
    const item = channels.snapshot().outbox[0]!;
    core.store.update<PaChannelOutbox>('channel_outbox', item.id, { nextAttemptAt: 0 }); await channels.tick();
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(transport.send.mock.calls[0]![0]).toEqual(transport.send.mock.calls[1]![0]);
    core.store.update<PaChannelOutbox & { firstAttemptAt: number }>('channel_outbox', item.id, { state: 'unknown', attempts: 1, nextAttemptAt: 0, firstAttemptAt: Date.now() - 3600001 });
    await channels.tick(); expect(transport.send).toHaveBeenCalledTimes(2);
  });
  it('requires a reliable receipt and rechecks state after an asynchronous delivery query', async () => {
    const channel = await connected(); channels.accept(channel.id, inbound('query', '/status')); await channels.tick();
    let item = channels.snapshot().outbox[0]!;
    item = core.store.update<PaChannelOutbox>('channel_outbox', item.id, { state: 'unknown', nextAttemptAt: Date.now() + 60000 });
    transport.receipt.mockResolvedValueOnce(false);
    await expect(channels.reconcileOutbox(item.id, 'query', item.revision)).rejects.toThrow('未查到可靠');
    expect(channels.snapshot().outbox[0]!.state).toBe('unknown');
    let finish!: (found: boolean) => void;
    transport.receipt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const query = channels.reconcileOutbox(item.id, 'query', item.revision);
    const rejected = expect(query).rejects.toThrow('查询期间');
    core.store.update<PaChannelOutbox>('channel_outbox', item.id, { error: 'newer decision' }); finish(true); await rejected;
    item = channels.snapshot().outbox[0]!;
    expect((await channels.reconcileOutbox(item.id, 'query', item.revision)).state).toBe('sent');
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-conversation stop commands and invalidates old approvals on disconnect', async () => {
    const channel = await connected(); channels.accept(channel.id, inbound('project', '/project Goal')); await channels.tick();
    const approval = channels.snapshot().inbox[0]!; await channels.disconnect(channel.id);
    expect(() => channels.approveProject(approval.id, true, approval.revision)).toThrow('改变');
    expect(core.snapshot().tasks).toHaveLength(0);
  });
  it('does not leak a previous authorization generation through status or resume after rebinding', async () => {
    let channel = await connected(); channels.accept(channel.id, inbound('old', 'OLD PRIVATE TASK GOAL')); await finishTask();
    const oldTask = core.snapshot().tasks[0]!;
    channel = channels.snapshot().channels[0]!;
    await channels.update(channel.id, { ...channel, allowedSenderIds: ['new-owner'] }, channel.revision);
    channels.accept(channel.id, inbound('new-status', '/status', { senderId: 'new-owner' })); await channels.tick();
    expect(transport.send.mock.calls.at(-1)![0].text).not.toContain('OLD PRIVATE TASK GOAL');
    const count = execute.mock.calls.length;
    channels.accept(channel.id, inbound('new-resume', `/resume ${oldTask.id}`, { senderId: 'new-owner' })); await channels.tick();
    expect(execute.mock.calls.length).toBe(count);
    expect(channels.snapshot().inbox.at(-1)!.state).toBe('failed');
  });
  it('rejects remote amendments that expand a one-time project approval', async () => {
    const channel = await connected(); channels.accept(channel.id, inbound('project-amend', '/project Approved goal')); await channels.tick();
    const item = channels.snapshot().inbox[0]!;
    channels.approveProject(item.id, true, item.revision); await finishTask();
    const task = core.snapshot().tasks[0]!;
    core.store.update<PaTask>('tasks', task.id, { status: 'waiting' });
    channels.accept(channel.id, inbound('changed', `/amend ${task.id} Different unapproved goal`)); await channels.tick();
    expect(core.store.require<PaTask>('tasks', task.id).amendments).toHaveLength(0);
    expect(channels.snapshot().inbox.at(-1)!.error).toContain('单次项目批准');
  });
  it('does not resurrect a Feishu configuration or WeChat login cancelled while transport stop is pending', async () => {
    const channel = await connected();
    let finish!: () => void;
    vi.spyOn(transport, 'stop').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const identity = vi.spyOn(PaFeishuTransport.prototype, 'identity').mockResolvedValue({ openId: 'new-bot', name: 'Test' });
    const configuring = channels.configureFeishu(channel.id, { appId: 'cli_test', appSecret: 'TEST_ONLY_SECRET' });
    const rejected = expect(configuring).rejects.toThrow('取消');
    await channels.disconnect(channel.id, true); finish(); await rejected;
    expect(identity).not.toHaveBeenCalled(); expect(channels.snapshot().channels[0]!.enabled).toBe(false);
  });
  it('retains uncertainty after rate limiting and never retries beyond the deduplication window', async () => {
    transport.send.mockRejectedValueOnce(new PaChannelTransportError('Lost response', 'unknown')).mockRejectedValueOnce(new PaChannelTransportError('Limited', 'rate_limit', 60000));
    const channel = await connected(); channels.accept(channel.id, inbound('ttl', '/status')); await channels.tick();
    const item = channels.snapshot().outbox[0]!;
    core.store.update<PaChannelOutbox & { firstAttemptAt: number }>('channel_outbox', item.id, { nextAttemptAt: 0, firstAttemptAt: Date.now() - 3550000 });
    await channels.tick(); expect(channels.snapshot().outbox[0]!.state).toBe('unknown');
    core.store.update<PaChannelOutbox & { firstAttemptAt: number }>('channel_outbox', item.id, { nextAttemptAt: 0, firstAttemptAt: Date.now() - 3600001 });
    await channels.tick(); expect(transport.send).toHaveBeenCalledTimes(2);
  });
  it('resumes an already-bound WeChat login without resetting the cursor or authorization', async () => {
    const channel = await connected('weixin');
    const record = core.store.require<PaChannel & { credentialRef: string }>('channels', channel.id);
    core.store.update<PaChannel & { accountKey: string; cursor: string }>('channels', channel.id, { accountKey: 'same-bot', remoteChatId: 'owner', cursor: 'saved-cursor' });
    credentials.set({ schemaVersion: 1, connectorId: record.credentialRef, accountLabel: 'Test', credentials: { token: 'TEST_ONLY_TOKEN', ownerId: 'owner', botId: 'same-bot', provider: 'pa-weixin' }, updatedAt: new Date().toISOString() });
    const begin = vi.spyOn(PaWeixinLoginClient.prototype, 'begin').mockResolvedValue({ qrCode: 'TEST_QR', imageContent: 'TEST_QR', origin: 'https://ilinkai.weixin.qq.com', expiresAt: Date.now() + 60000 });
    vi.spyOn(PaWeixinLoginClient.prototype, 'poll').mockResolvedValue({ status: 'binded_redirect' });
    await channels.beginWeixinLogin(channel.id);
    await vi.waitFor(() => expect(channels.snapshot().channels[0]!.verification.reloginAt).not.toBeNull());
    expect(begin).toHaveBeenCalledWith(['TEST_ONLY_TOKEN']);
    expect(core.store.require<PaChannel & { cursor: string }>('channels', channel.id)).toMatchObject({ cursor: 'saved-cursor', authorizationVersion: record.authorizationVersion });
    expect(channels.loginStatus(channel.id).status).toBe('confirmed');
    expect(credentials.get(record.credentialRef)?.credentials.token).toBe('TEST_ONLY_TOKEN');
  });
  it('does not accept an already-bound login when the matching local account is missing', async () => {
    const channel = await connected('weixin');
    vi.spyOn(PaWeixinLoginClient.prototype, 'begin').mockResolvedValue({ qrCode: 'TEST_QR', imageContent: 'TEST_QR', origin: 'https://ilinkai.weixin.qq.com', expiresAt: Date.now() + 60000 });
    vi.spyOn(PaWeixinLoginClient.prototype, 'poll').mockResolvedValue({ status: 'binded_redirect' });
    await channels.beginWeixinLogin(channel.id);
    await vi.waitFor(() => expect(channels.loginStatus(channel.id).status).toBe('failed'));
    expect(channels.snapshot().channels[0]!.verification.reloginAt).toBeNull();
    expect(channels.snapshot().channels[0]!.status).toBe('login_required');
    await channels.reconnect(channel.id);
    expect(channels.loginStatus(channel.id).status).toBe('confirmed');
    expect(channels.snapshot().channels[0]!.verification.reloginAt).toBeNull();
  });
  it('removes persisted reply context tokens when a connection is forgotten', async () => {
    const channel = await connected('weixin'); channels.accept(channel.id, inbound('context', '/status')); await channels.tick();
    const record = core.store.require<import('@open-design/contracts').PaChannelInbox & { contextRef: string }>('channel_inbox', channels.snapshot().inbox[0]!.id);
    expect(credentials.get(record.contextRef)).toBeTruthy();
    await channels.disconnect(channel.id, true); expect(credentials.get(record.contextRef)).toBeUndefined();
  });
  it('fails closed when Feishu tenant binding is missing', async () => {
    const channel = await connected('feishu', { tenantId: null });
    channels.accept(channel.id, inbound('no-tenant', 'not authorized')); await channels.tick();
    expect(core.snapshot().tasks).toHaveLength(0); expect(channels.snapshot().inbox[0]!.state).toBe('ignored');
  });
});

describe('official channel wire normalization', () => {
  it('keeps uint64 IDs exact and does not rewrite text that resembles JSON', () => {
    const value = parseChannelJson('{"message_id":18446744073709551615,"seq":9007199254740993,"text":"\\\"message_id\\\":123"}') as Record<string, unknown>;
    expect(value.message_id).toBe('18446744073709551615'); expect(value.seq).toBe('9007199254740993'); expect(value.text).toBe('"message_id":123');
  });
  it('maps Feishu thread identity and only counts a real mention of this bot', () => {
    const raw = { sender: { sender_type: 'user', sender_id: { open_id: 'owner' }, tenant_key: 'tenant' }, message: { message_id: 'msg', chat_id: 'chat', chat_type: 'group', message_type: 'text', thread_id: 'thread', create_time: String(Date.now()), content: JSON.stringify({ text: '@_user_1 build a brief' }), mentions: [{ key: '@_user_1', id: { open_id: 'bot' } }] } };
    expect(normalizeFeishuMessage(raw, 'bot')).toMatchObject({ threadId: 'thread', mentioned: true, direct: false, text: 'build a brief' });
    expect(normalizeFeishuMessage(raw, 'other-bot')?.mentioned).toBe(false);
  });
  it('rejects WeChat groups, bot echoes and untrusted credential redirect origins', () => {
    expect(normalizeWeixinMessage({ message_type: 1, message_id: '1', from_user_id: 'owner', group_id: 'group' })).toBeNull();
    expect(normalizeWeixinMessage({ message_type: 2, message_id: '1', from_user_id: 'owner' })).toBeNull();
    expect(() => weixinOrigin('https://weixin.qq.com.attacker.invalid')).toThrow(); expect(() => weixinOrigin('http://ilinkai.weixin.qq.com')).toThrow();
  });
  it('reads topic rich posts without trusting display-name mentions or media payloads', () => {
    const raw = { sender: { sender_type: 'user', sender_id: { open_id: 'owner' }, tenant_key: 'tenant' }, message: { message_id: 'topic-message', chat_id: 'group', chat_type: 'group', message_type: 'post', root_id: 'root', thread_id: 'topic', content: '', mentions: [{ key: '@_user_1', id: { open_id: 'bot' }, name: 'PA' }] } };
    const post = { title: 'Reading', content: [[{ tag: 'at', user_id: 'bot' }, { tag: 'text', text: 'Make a plan' }], [{ tag: 'a', text: 'Reference', href: 'https://example.com' }], [{ tag: 'code_block', text: 'three days' }], [{ tag: 'img', text: 'DO NOT EXECUTE', image_key: 'image' }, { tag: 'unknown', text: 'IGNORE' }]] };
    for (const content of [post, { zh_cn: post, en_us: { title: 'wrong locale', content: [] } }]) {
      raw.message.content = JSON.stringify(content);
      expect(normalizeFeishuMessage(raw, 'bot')).toMatchObject({ threadId: 'topic', mentioned: true, direct: false, text: 'Reading\nMake a plan\nReference (https://example.com)\n\nthree days' });
    }
    raw.message.mentions = [];
    raw.message.content = JSON.stringify({ content: [[{ tag: 'at', user_id: 'bot', user_name: 'PA' }, { tag: 'text', text: 'goal' }]] });
    expect(normalizeFeishuMessage(raw, 'bot')).toMatchObject({ mentioned: false, text: 'goal' });
    raw.message.content = JSON.stringify({ content: [[{ tag: 'img', text: 'not a goal' }, { tag: 'hr' }]] });
    expect(normalizeFeishuMessage(raw, 'bot')).toBeNull();
  });
  it('commits WeChat cursors after durable admission and waits for re-login on expiry', async () => {
    let cursor = '', received = 0, calls = 0;
    const checkpoint = vi.fn((next: string) => { expect(received).toBe(1); cursor = next; });
    const request = vi.fn<typeof fetch>(async () => { calls++; return new Response(calls === 1 ? '{"ret":0,"get_updates_buf":"cursor-1","msgs":[{"message_id":18446744073709551615,"message_type":1,"message_state":2,"from_user_id":"owner","create_time_ms":1,"context_token":"SYNTHETIC","item_list":[{"type":1,"text_item":{"text":"hello"}}]}]}' : '{"ret":-14}'); });
    const states: string[] = [];
    const adapter = new PaWeixinTransport({ token: 'SYNTHETIC', ownerId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com', cursor: () => cursor, checkpoint, request });
    await adapter.start(async message => { expect(message.id).toBe('18446744073709551615'); received++; }, state => states.push(state));
    await vi.waitFor(() => expect(states).toContain('login_required'));
    expect(cursor).toBe('cursor-1'); expect(request).toHaveBeenCalledTimes(2); await adapter.stop();
  });
  it('accepts Tencent protobuf success responses that omit the default ret=0 field', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"message_id":18446744073709551615}')).mockResolvedValueOnce(new Response('{}'));
    const adapter = new PaWeixinTransport({ token: 'SYNTHETIC', ownerId: 'owner', baseUrl: 'https://ilinkai.weixin.qq.com', cursor: () => '', checkpoint: () => {}, request });
    const input: PaOutboundMessage = { requestId: 'test-id', chatId: 'owner', replyTo: null, threadId: null, text: 'test', contextToken: 'SYNTHETIC_CONTEXT' };
    expect(await adapter.send(input, new AbortController().signal)).toEqual({ messageId: '18446744073709551615', acknowledged: true });
    expect(await adapter.send(input, new AbortController().signal)).toEqual({ messageId: null, acknowledged: true });
  });
});
