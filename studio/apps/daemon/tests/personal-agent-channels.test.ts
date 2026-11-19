import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paChannelInputSchema, type PaChannel, type PaChannelInput, type PaChannelOutbox, type PaTask, type PaControl } from '@open-design/contracts';
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
async function connected(type: PaChannel['type'] = 'feishu', extra: Partial<PaChannel> = {}, route: Partial<PaChannelInput> = {}) {
  const created = channels.create(paChannelInputSchema.parse({ type, name: 'Test channel', targetKind: 'group', targetId: core.snapshot().groups[0]!.id, ...route }));
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

describe('Feishu bot registration', () => {
  const verificationUrl = 'https://open.feishu.cn/page/launcher?user_code=SYNTHETIC';
  const registered = { client_id: 'cli_registered1', client_secret: 'SYNTHETIC_FEISHU_APP_SECRET', user_info: { tenant_brand: 'lark' as const } };

  function setup(registerFeishu: NonNullable<ConstructorParameters<typeof PersonalAgentChannels>[0]['registerFeishu']>) {
    const transportFactory = vi.fn(() => transport);
    channels = new PersonalAgentChannels({ core, dataDir: dir, credentialStore: credentials, registerFeishu, transportFactory });
    const channel = channels.create(paChannelInputSchema.parse({
      type: 'feishu', name: 'Launch assistant', targetKind: 'agent', targetId: core.snapshot().agents[0]!.id,
    }));
    return { channel, transportFactory };
  }

  it('shows the authorization link and local QR, saves credentials once and starts the existing transport', async () => {
    let approve!: (value: typeof registered) => void;
    const register = vi.fn<NonNullable<ConstructorParameters<typeof PersonalAgentChannels>[0]['registerFeishu']>>(
      async (_name, _signal, ready) => {
        ready({ url: verificationUrl, expireIn: 300 });
        return new Promise(resolve => { approve = resolve; });
      },
    );
    const { channel, transportFactory } = setup(register);
    expect(channels.beginFeishuRegistration(channel.id)).toMatchObject({ status: 'waiting', authorizationUrl: verificationUrl });
    expect(channels.beginFeishuRegistration(channel.id).status).toBe('waiting');
    expect(register).toHaveBeenCalledTimes(1);
    expect((await channels.feishuRegistrationQr(channel.id)).subarray(1, 4).toString()).toBe('PNG');
    approve(registered);
    await vi.waitFor(() => expect(channels.snapshot().channels[0]?.status).toBe('connected'));
    const result = channels.feishuRegistration(channel.id);
    expect(result).toMatchObject({ status: 'confirmed', authorizationUrl: null, botUrl: 'https://applink.larksuite.com/client/bot/open?appId=cli_registered1' });
    expect(transportFactory.mock.calls).toHaveLength(1);
    expect(credentials.get(`pa-channel:${channel.id}`)?.credentials).toMatchObject({ brand: 'lark', appId: registered.client_id, appSecret: registered.client_secret });
    expect(JSON.stringify([result, channels.snapshot()])).not.toContain(registered.client_secret);
    expect(channels.snapshot().channels[0]?.allowedSenderIds).toEqual([]);
    await expect(channels.feishuRegistrationQr(channel.id)).rejects.toMatchObject({ status: 410 });
    expect(() => channels.beginFeishuRegistration(channel.id)).toThrow();
  });

  it('fences cancellation and discards a late authorization result', async () => {
    let approve!: (value: typeof registered) => void;
    let registrationSignal!: AbortSignal;
    const { channel, transportFactory } = setup(async (_name, signal, ready) => {
      registrationSignal = signal;
      ready({ url: verificationUrl, expireIn: 300 });
      return new Promise(resolve => { approve = resolve; });
    });
    channels.beginFeishuRegistration(channel.id);
    channels.cancelFeishuRegistration(channel.id);
    approve(registered);
    await Promise.resolve();
    expect(registrationSignal.aborted).toBe(true);
    expect(channels.feishuRegistration(channel.id)).toMatchObject({ status: 'cancelled', authorizationUrl: null });
    expect(transportFactory).not.toHaveBeenCalled();
    expect(credentials.get(`pa-channel:${channel.id}`)).toBeFalsy();
  });
});

describe('PA channel admission and delivery', () => {
  it('transcribes an admitted raw audio attachment once before dispatching the original turn', async () => {
    const transcribeAudio = vi.fn(async () => ({ text: '请准备新品发布清单' }));
    channels = new PersonalAgentChannels({ core, dataDir: dir, credentialStore: credentials, transportFactory: () => transport, transcribeAudio });
    const channel = await connected('telegram');
    const attachment = { audio: true as const, data: Buffer.from('OggS synthetic audio') };
    channels.accept(channel.id, inbound('untrusted-audio', '', { senderId: 'outsider', attachments: [attachment] }));
    const authorized = inbound('authorized-audio', '', { attachments: [attachment] });
    channels.accept(channel.id, authorized);
    channels.accept(channel.id, authorized);
    await finishTask();
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toContain('请准备新品发布清单');
    expect(core.snapshot().tasks).toHaveLength(1);
    expect(JSON.stringify(core.store.list('channel_attachments'))).not.toContain(Buffer.from(attachment.data).toString('base64'));
  });

  it('relays a view card summary and resumes the same task after one desktop submission', async () => {
    const channel = await connected('telegram');
    const view = { type: 'form', id: 'details', fields: [{ id: 'audience', label: 'Audience' }] };
    execute.mockResolvedValueOnce({ text: JSON.stringify({ channelView: { title: 'Campaign brief', view } }), usage: { visibility: 'unknown' } });
    channels.accept(channel.id, inbound('view-card', 'Prepare the campaign brief'));
    await vi.waitFor(() => expect(core.snapshot().tasks.at(-1)?.pendingView?.title).toBe('Campaign brief'));
    await channels.tick();
    expect(transport.send.mock.calls.some(([message]) => message.text.includes('Campaign brief') && message.text.includes('填写视图卡片'))).toBe(true);
    const task = core.snapshot().tasks.at(-1)!;
    const input = { kind: 'view', attemptId: task.pendingView!.attemptId, action: 'details', values: { fields: { audience: 'New subscribers' } } } as const;
    core.answerTaskCard(task.id, input);
    expect(() => core.answerTaskCard(task.id, input)).toThrow(/已经处理/);
    await finishTask();
    expect(core.snapshot().tasks).toHaveLength(1);
    expect(execute.mock.calls.at(-1)?.[1]).toContain('New subscribers');
    expect(core.snapshot().messages.find(message => message.id === input.attemptId)?.viewAnswer).toEqual({
      action: 'details', values: { fields: { audience: 'New subscribers' } },
    });
  });

  it.each(['dingtalk', 'wecom', 'qq', 'telegram', 'discord', 'slack'] as const)('pairs a %s bot and handles private work with the shared channel lifecycle', async type => {
    const channel = await connected(type, { allowedSenderIds: [], remoteChatId: null, tenantId: null });
    const pairing = channels.pairing(channel.id);
    channels.accept(channel.id, inbound('new-pair', pairing.code, { tenantId: null }));
    await channels.tick();
    channels.accept(channel.id, inbound('new-task', 'Summarize the brief', { tenantId: null }));
    await finishTask();
    expect(channels.snapshot().channels[0]).toMatchObject({ type, allowedSenderIds: ['owner'], remoteChatId: 'chat', status: 'connected' });
    expect(transport.send.mock.calls.some(([message]) => message.text.includes('A verified channel answer'))).toBe(true);
  });

  it('routes a second chat to a different target over the same bot, and revokes it with the parent', async () => {
    const [ownerAgent, groupAgent] = core.snapshot().agents;
    const main = await connected('telegram', {}, { targetKind: 'agent', targetId: ownerAgent!.id });
    const binding = channels.createBinding(main.id, paChannelInputSchema.parse({
      type: 'telegram', name: 'Second chat', targetKind: 'agent', targetId: groupAgent!.id,
    }));
    const pairing = channels.pairing(binding.id);
    const group = { direct: false, mentioned: true, chatId: 'group', tenantId: null };
    channels.accept(main.id, inbound('group-pair', pairing.code, group));
    await channels.tick();
    channels.accept(main.id, inbound('work-group', 'Compare these choices', group));
    await finishTask();
    expect(core.snapshot().tasks.at(-1)).toMatchObject({ channelId: binding.id, participantIds: [groupAgent!.id] });
    expect(transport.send.mock.calls.some(([message]) => message.chatId === 'group' && message.direct === false)).toBe(true);
    expect(channels.snapshot().channels.find(channel => channel.id === main.id)?.remoteChatId).toBe('chat');
    await channels.disconnect(main.id, true);
    expect(channels.snapshot().channels.find(channel => channel.id === binding.id)).toMatchObject({ enabled: false, remoteChatId: null });
  });

  it('answers the latest question by number and resumes the same task', async () => {
    const agent = core.snapshot().agents[0]!;
    const channel = await connected('telegram', {}, { targetKind: 'agent', targetId: agent.id });
    execute.mockResolvedValueOnce({ text: '{"channelQuestion":{"prompt":"Which audience?","options":["New users","Experts"]}}', usage: { visibility: 'unknown' } });
    channels.accept(channel.id, inbound('ask', 'Draft a short guide', { tenantId: null }));
    await vi.waitFor(() => expect(core.snapshot().tasks.at(-1)?.channelQuestion?.prompt).toBe('Which audience?'));
    await channels.tick();
    expect(transport.send.mock.calls.some(([message]) => message.text.includes('2. Experts') && message.buttons?.[1]?.label === 'Experts')).toBe(true);
    channels.accept(channel.id, inbound('answer', '2', { tenantId: null }));
    await finishTask();
    expect(core.snapshot().tasks).toHaveLength(1);
    expect(core.snapshot().tasks[0]?.channelQuestion).toBeUndefined();
    expect(execute.mock.calls.at(-1)?.[1]).toContain('Experts');
  });

  it('checks the originating card message before accepting an in-channel project approval', async () => {
    const channel = await connected('telegram', {}, { allowRemoteApproval: true });
    channels.accept(channel.id, inbound('project-card', '/project Create a verified brief', { tenantId: null }));
    await channels.tick();
    const card = transport.send.mock.calls.map(([message]) => message).find(message => message.buttons?.length)!;
    const click = { tenantId: null, action: card.buttons![0]!.data, actionMessageId: `receipt-${card.requestId}` };
    channels.accept(channel.id, inbound('bad-click', '', { ...click, actionMessageId: 'wrong-card' }));
    await channels.tick();
    expect(core.snapshot().tasks).toHaveLength(0);
    channels.accept(channel.id, inbound('good-click', '', click));
    await finishTask();
    expect(core.snapshot().tasks).toHaveLength(1);
    expect(core.snapshot().tasks[0]?.kind).toBe('project');
  });

  it('presents images and text attachments to the model only for an admitted sender', async () => {
    const channel = await connected('telegram');
    const attachments = [{ name: 'brief.txt', data: Buffer.from('WITNESS_DOCUMENT') },
      { data: Buffer.from('89504e470d0a1a0a0000', 'hex') }];
    channels.accept(channel.id, inbound('wrong-sender-media', '', { attachments, senderId: 'outsider' }));
    await channels.tick();
    expect(execute).not.toHaveBeenCalled();
    channels.accept(channel.id, inbound('media', '', { attachments }));
    await finishTask();
    expect(execute.mock.calls[0]?.[1]).toContain('WITNESS_DOCUMENT');
    expect(execute.mock.calls[0]?.[4]?.images?.[0]?.mediaType).toBe('image/png');
    expect(JSON.stringify(channels.snapshot())).not.toContain('WITNESS_DOCUMENT');
  });

  it('creates a persistent team from a paired Feishu direct chat and sends it follow-up work', async () => {
    const coordinator = core.snapshot().agents[0]!;
    const groupsBefore = core.snapshot().groups.length;
    const channel = await connected('feishu', {}, { targetKind: 'agent', targetId: coordinator.id, allowTeam: true });
    execute.mockResolvedValueOnce({
      text: JSON.stringify({ name: 'Launch studio', members: [{ name: 'Writer', role: 'Draft the copy' }, { name: 'Designer', role: 'Create the visual direction' }] }),
      usage: { visibility: 'unknown' },
    });
    const request = inbound('create-team', '/team Build a team with a writer and designer for the launch');
    channels.accept(channel.id, request);
    channels.accept(channel.id, request);
    await finishTask();
    const snapshot = core.snapshot();
    const team = snapshot.groups.find(group => group.name === 'Launch studio')!;
    expect(snapshot.groups).toHaveLength(groupsBefore + 1);
    expect(snapshot.tasks[0]).toMatchObject({ kind: 'team', participantIds: [coordinator.id] });
    expect(team).toMatchObject({ mode: 'collaboration', moderatorId: coordinator.id });
    expect(team.memberIds).toHaveLength(3);
    expect(snapshot.agents.find(agent => agent.name === 'Writer')).toMatchObject({ model: coordinator.model, tools: ['respond'] });
    expect(transport.send.mock.calls.some(([message]) => message.text.includes('/team-run Launch studio |'))).toBe(true);

    channels.accept(channel.id, inbound('use-team', '/team-run Launch studio | Draft a tagline'));
    await channels.tick();
    await finishTask();
    const work = core.snapshot().tasks.at(-1)!;
    expect(work).toMatchObject({ kind: 'discussion', goal: 'Draft a tagline', participantIds: team.memberIds });
    expect(core.snapshot().conversations.find(item => item.id === work.conversationId)).toMatchObject({ groupId: team.id, channelId: channel.id, allowProject: false, allowSharedMemory: false });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('requires explicit Feishu team permission and a paired direct chat, and rejects untrusted plan fields', async () => {
    const coordinator = core.snapshot().agents[0]!;
    let channel = await connected('feishu', {}, { targetKind: 'agent', targetId: coordinator.id });
    channels.accept(channel.id, inbound('opt-out', '/team Build a team'));
    await channels.tick();
    expect(execute).not.toHaveBeenCalled();
    channel = await channels.update(channel.id, { ...channel, allowTeam: true }, channels.snapshot().channels[0]!.revision);
    channels.accept(channel.id, inbound('group-team', '/team Build a team', { direct: false, mentioned: true }));
    channels.accept(channel.id, inbound('unauthorized-team', '/team Build a team', { senderId: 'outsider' }));
    await channels.tick();
    expect(execute).not.toHaveBeenCalled();

    const count = core.snapshot().agents.length;
    execute.mockResolvedValueOnce({ text: '{"name":"Bad team","members":[{"name":"Writer","role":"Draft copy","tools":["create_project"]}]}', usage: { visibility: 'unknown' } });
    channels.accept(channel.id, inbound('bad-plan', '/team Build a team'));
    await vi.waitFor(() => expect(core.snapshot().tasks.at(-1)?.status).toBe('failed'));
    expect(core.snapshot().agents).toHaveLength(count);
    expect(core.snapshot().groups.some(group => group.name === 'Bad team')).toBe(false);
  });

  it('keeps a suspended model from creating a team after channel permission is revoked', async () => {
    const coordinator = core.snapshot().agents[0]!;
    const channel = await connected('feishu', {}, { targetKind: 'agent', targetId: coordinator.id, allowTeam: true });
    let finishModel!: (value: Awaited<ReturnType<PaModelRuntime['execute']>>) => void;
    execute.mockImplementationOnce(async () => new Promise(resolve => { finishModel = resolve; }));
    channels.accept(channel.id, inbound('revoked-team', '/team Build a team'));
    await vi.waitFor(() => expect(finishModel).toBeTypeOf('function'));
    await channels.update(channel.id, { ...channel, allowTeam: false }, channels.snapshot().channels[0]!.revision);
    finishModel({ text: '{"name":"Revoked team","members":[{"name":"Writer","role":"Draft copy"}]}', usage: { visibility: 'unknown' } });
    await vi.waitFor(() => expect(core.snapshot().tasks.at(-1)?.status).toBe('cancelled'));
    expect(core.snapshot().groups.some(group => group.name === 'Revoked team')).toBe(false);
  });

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
  it('answers a channel in chat mode with the character reply itself, once per turn, without private memory', async () => {
    const agent = core.createAgent({ name: '小月', role: '陪伴聊天的朋友', avatar: '', enabled: true, tools: ['respond'], model: { runtime: 'claude', modelId: 'sonnet' } });
    core.soul.saveCharacter(agent.id, { description: '住在窗边工作室，说话轻声慢气。' });
    core.saveMemory({ content: 'PRIVATE_MEMORY', source: 'owner', scope: 'private', scopeId: null });
    core.saveMemory({ content: 'AGENT_MEMORY', source: 'owner', scope: 'agent', scopeId: agent.id });
    const channel = await connected('feishu', {}, { targetKind: 'agent', targetId: agent.id, chatMode: 'companion' });
    const sent = () => transport.send.mock.calls.map(call => call[0].text);
    // Finished chat turns leave the snapshot, so they are read from the store.
    const chatTasks = () => core.store.list<PaTask>('tasks').filter(task => task.kind === 'chat');
    const model = execute.getMockImplementation()!;

    // Two messages before the turn starts are one turn and one reply: no receipt, no task id, no footer.
    await core.setControl({ paused: true });
    execute.mockImplementation(async () => ({ text: '你回来啦。\n<turn_meta>\nmood: 开心\nremember: fact | 用户今天很累\n</turn_meta>', usage: { visibility: 'unknown' } }));
    channels.accept(channel.id, inbound('chat-1', '今天有点累'));
    channels.accept(channel.id, inbound('chat-2', '想和你说说话'));
    await channels.tick();
    expect(chatTasks()).toHaveLength(1);
    expect(sent()).toEqual([]);
    await core.setControl({ paused: false });
    await vi.waitFor(() => expect(chatTasks()[0]?.status).toBe('completed'), { timeout: 5000 });
    await channels.tick(); await channels.tick();
    expect(sent()).toEqual(['你回来啦。']);
    for (const call of execute.mock.calls) { expect(call[1]).not.toContain('PRIVATE_MEMORY'); expect(call[1]).not.toContain('AGENT_MEMORY'); }
    expect(core.store.list('memory_candidates')).toHaveLength(0);
    const conversation = core.snapshot().conversations.find(item => item.channelId === channel.id)!;
    expect(core.soul.modeOf(conversation)).toBe('companion');

    // /task still runs a work task with its receipt; a reply that did not finish is reported as the app's.
    execute.mockImplementation(model);
    channels.accept(channel.id, inbound('task-1', '/task Please summarize this brief'));
    await channels.tick();
    expect(core.store.list<PaTask>('tasks').at(-1)).toMatchObject({ kind: 'discussion', goal: 'Please summarize this brief' });
    expect(sent().at(-1)).toContain('已记录任务');
    execute.mockImplementation(async () => { throw new Error('model offline'); });
    channels.accept(channel.id, inbound('chat-3', '你还在吗'));
    await channels.tick();
    await vi.waitFor(() => expect(chatTasks().at(-1)?.status).toBe('failed'), { timeout: 5000 });
    await channels.tick(); await channels.tick();
    expect(sent().at(-1)).toBe('Fantay：这条消息没有收到回复，请再发一次。');
    execute.mockImplementation(model);
  });
  it('keeps a channel in work mode when its target has no character card, whatever the switch says', async () => {
    const channel = await connected('feishu', {}, { chatMode: 'companion' });
    channels.accept(channel.id, inbound()); await finishTask();
    expect(core.snapshot().tasks.at(-1)?.kind).toBe('discussion');
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
