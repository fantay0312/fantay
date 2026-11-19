// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Connection, background-control, approval and output-reader invariants, ported from the old PaConnections /
// PaOutputViewer tests to the Fantay workspace (Connections page, channel modal, task modal output view).
import '../helpers/radix-jsdom';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaChannel, PaChannelSnapshot, PaControl, PaOutputPage, PaSnapshot } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { paEn } from '../../../src/i18n/pa';
import { PersonalAgentWorkspace } from '../../../src/fantay/pa/PersonalAgentWorkspace';
import type { PaUiState } from '../../../src/fantay/pa/pa-types';
import { paRequest } from '../../../src/fantay/pa/pa-api';

vi.mock('../../../src/fantay/pa/pa-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/fantay/pa/pa-api')>()),
  paRequest: vi.fn(),
}));

const stamp = { createdAt: 1, updatedAt: 1, revision: 1 };
const agent = { ...stamp, id: 'a', name: 'Assistant', role: 'Help', avatar: 'fantay', enabled: true, tools: ['respond'], model: { runtime: 'claude', modelId: 'sonnet' } } as PaSnapshot['agents'][number];
let snapshot: PaSnapshot;
let control: PaControl;
let channels: PaChannelSnapshot;

function channel(type: PaChannel['type']): PaChannel {
  return {
    ...stamp, id: 'channel', name: 'Dedicated PA', type, enabled: false, targetId: 'a', targetKind: 'agent', allowProject: false,
    shareGroupMemory: false, chatMode: 'work', allowedSenderIds: [], remoteChatId: null, tenantId: null, authorizationVersion: 1, status: 'disconnected',
    credentialConfigured: false, accountLabel: null, lastReceivedAt: null, lastSentAt: null, lastError: null,
    capabilities: { direct: true, groups: type === 'feishu', threads: type === 'feishu', files: false, unsolicited: false },
    verification: { inboundAt: null, outboundAt: null, reconnectAt: null, reloginAt: null },
  } as PaChannel;
}

type Route = (path: string, method: string | undefined, body: unknown) => unknown;
let extraRoute: Route | null = null;

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* ignore */ }
  snapshot = {
    agents: [agent], groups: [], conversations: [{ ...stamp, id: 'direct', title: 'Assistant', agentId: 'a', groupId: null }],
    tasks: [], attempts: [], messages: [], artifacts: [], memories: [],
    node: { id: 'node', protocolVersion: 1, location: 'local', available: true, heartbeatAt: 1, capabilities: ['text'] },
  } as PaSnapshot;
  control = { ...stamp, id: 'control', backgroundEnabled: true, paused: false, suspended: false, maxConcurrent: 2, defaultMaxAttempts: 6, defaultTimeoutMs: 300000, waitingExpiryMs: 86400000, activeCount: 0, pendingCount: 0, lastResumeAt: null };
  channels = { channels: [], inbox: [], outbox: [] };
  extraRoute = null;
  vi.mocked(paRequest).mockReset().mockImplementation(async (path = '', method, body) => {
    const extra = extraRoute?.(path, method, body);
    if (extra !== undefined) return extra as never;
    if (path === '') return snapshot as never;
    if (path === '/models' || path === '/channels/local-feishu-apps') return [] as never;
    if (path === '/activity') return { running: 0, waiting: 0 } as never;
    if (path === '/control') { if (method === 'PATCH') control = { ...control, ...(body as object) }; return control as never; }
    if (path === '/channels' && method === 'POST') return { ...channel('feishu'), ...(body as object) } as never;
    if (path === '/channels') return channels as never;
    return {} as never;
  });
});
afterEach(cleanup);

const mount = (ui: Partial<PaUiState>) =>
  render(
    <I18nProvider initial="en">
      <PersonalAgentWorkspace active onOpenProject={vi.fn()} initialState={ui} />
    </I18nProvider>,
  );

describe('Fantay connections and background controls', () => {
  it('pauses and resumes Fantay and changes the explicit close-window setting', async () => {
    mount({ place: 'connections' });
    const page = await screen.findByTestId('pa-connections');
    fireEvent.click(await within(page).findByRole('button', { name: paEn['pa.pauseAll'] }));
    await within(page).findByRole('button', { name: paEn['pa.resumeAll'] });
    fireEvent.click(within(page).getByRole('switch', { name: paEn['pa.background'] }));
    await waitFor(() => expect(paRequest).toHaveBeenCalledWith('/control', 'PATCH', { backgroundEnabled: false }));
  });

  it('creates connections without granting project or shared-memory permissions by default', async () => {
    mount({ place: 'connections' });
    fireEvent.click(await screen.findByRole('button', { name: paEn['pa.addChannel'] }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: paEn['pa.name'] }), { target: { value: 'Dedicated bot' } });
    fireEvent.click(within(dialog).getByRole('button', { name: paEn['pa.save'] }));
    await waitFor(() =>
      expect(paRequest).toHaveBeenCalledWith('/channels', 'POST', expect.objectContaining({
        name: 'Dedicated bot', enabled: false, allowProject: false, shareGroupMemory: false, allowedSenderIds: [],
      })),
    );
  });

  it('uses a password field and clears the secret after successful setup', async () => {
    channels.channels = [channel('feishu')];
    mount({ place: 'connections' });
    fireEvent.click(await screen.findByRole('button', { name: /Dedicated PA/ }));
    const dialog = await screen.findByRole('dialog');
    const secret = within(dialog).getByLabelText(paEn['pa.appSecret']) as HTMLInputElement;
    expect(secret.type).toBe('password');
    fireEvent.change(within(dialog).getByLabelText(paEn['pa.appId']), { target: { value: 'cli_test' } });
    fireEvent.change(secret, { target: { value: 'SYNTHETIC_SECRET' } });
    fireEvent.click(within(dialog).getByRole('button', { name: paEn['pa.connectFeishu'] }));
    await waitFor(() => expect(paRequest).toHaveBeenCalledWith('/channels/channel/feishu', 'POST', expect.objectContaining({ appId: 'cli_test' })));
    await waitFor(() => expect(secret.value).toBe(''));
    expect(screen.queryByText('SYNTHETIC_SECRET')).toBeNull();
  });

  it('offers all eight platforms in the channel picker', async () => {
    mount({ place: 'connections' });
    fireEvent.click(await screen.findByRole('button', { name: paEn['pa.addChannel'] }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(within(dialog).getByRole('combobox', { name: paEn['pa.platform'] }), { key: 'ArrowDown' });
    for (const platform of [paEn['pa.feishu'], paEn['pa.weixin'], 'DingTalk', 'WeCom', 'QQ', 'Telegram', 'Discord', 'Slack']) {
      expect(await screen.findByRole('option', { name: platform })).toBeTruthy();
    }
  });

  it('starts Feishu authorization and renders the QR through the local endpoint', async () => {
    channels.channels = [channel('feishu')];
    extraRoute = (path, method) => {
      if (path !== '/channels/channel/feishu-registration') return undefined;
      return method === 'POST' ? {
        status: 'waiting', expiresAt: 123, authorizationUrl: 'https://open.feishu.cn/page/launcher?user_code=SYNTHETIC',
        botUrl: null, error: null,
      } : null;
    };
    mount({ place: 'connections' });
    fireEvent.click(await screen.findByRole('button', { name: /Dedicated PA/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: paEn['pa.channel.createFeishu'] }));
    const qr = await within(dialog).findByAltText(paEn['pa.channel.feishuQrAlt']);
    expect(qr.getAttribute('src')).toBe('/api/pa/channels/channel/feishu-registration/qr.png?v=123');
    expect(within(dialog).getByRole('button', { name: paEn['pa.channel.authorizeFeishu'] })).toBeTruthy();
  });

  it('shows write-only platform fields for a Slack connection', async () => {
    channels.channels = [channel('slack')];
    mount({ place: 'connections' });
    fireEvent.click(await screen.findByRole('button', { name: /Dedicated PA/ }));
    const dialog = await screen.findByRole('dialog');
    const appToken = within(dialog).getByLabelText('App-Level Token') as HTMLInputElement;
    const botToken = within(dialog).getByLabelText('Bot Token') as HTMLInputElement;
    expect(appToken.type).toBe('password');
    expect(botToken.type).toBe('password');
    fireEvent.change(appToken, { target: { value: 'xapp-test' } });
    fireEvent.change(botToken, { target: { value: 'xoxb-test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: paEn['pa.connect'] }));
    await waitFor(() => expect(paRequest).toHaveBeenCalledWith('/channels/channel/im', 'POST', { appToken: 'xapp-test', botToken: 'xoxb-test' }));
    await waitFor(() => expect(appToken.value).toBe(''));
  });

  it('renders only a local QR-image endpoint, never a provider token in an image URL', async () => {
    channels.channels = [channel('weixin')];
    extraRoute = (path) =>
      path === '/channels/channel/login'
        ? { channelId: 'channel', status: 'waiting', expiresAt: Date.now() + 60000, qrImagePath: '/api/pa/channels/channel/qr.png?v=1', message: 'Scan with WeChat' }
        : undefined;
    mount({ place: 'connections' });
    fireEvent.click(await screen.findByRole('button', { name: /Dedicated PA/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: paEn['pa.scanWechat'] }));
    const image = await within(dialog).findByAltText(paEn['pa.qrAlt']);
    expect(image.getAttribute('src')).toBe('/api/pa/channels/channel/qr.png?v=1');
  });

  it('binds one-time project approval to the displayed inbox revision', async () => {
    channels.channels = [channel('feishu')];
    channels.inbox = [{ ...stamp, id: 'inbox', channelId: 'channel', providerMessageId: 'message', senderId: 'owner', chatId: 'chat', threadId: null, receivedAt: 1, taskId: null, state: 'approval', error: null, preview: '/project Specific local report', approvalId: 'approval' }] as PaChannelSnapshot['inbox'];
    mount({ place: 'tasks', tasksFilter: 'needs' });
    const page = await screen.findByTestId('pa-tasks-page');
    fireEvent.click(await within(page).findByRole('button', { name: 'Approve once' }));
    await waitFor(() => expect(paRequest).toHaveBeenCalledWith('/channels/inbox/inbox/approve', 'POST', { approved: true, revision: 1 }));
  });
});

describe('Fantay full-output reader', () => {
  it('does not show a late response from another attempt', async () => {
    const attempt = (id: string, startedAt: number) => ({
      ...stamp, id, taskId: 't', runId: `run-${id}`, nodeId: 'node', protocolVersion: 1, agentSnapshot: agent, phase: 'respond',
      status: 'completed', taskRevision: 1, startedAt, endedAt: startedAt + 1000, output: '', error: null,
      usage: { visibility: 'unknown' },
    });
    snapshot.tasks = [{ ...stamp, id: 't', requestId: 'r', conversationId: 'direct', goal: 'Summarise', kind: 'discussion', projectName: '', projectId: null, projectConversationId: null, status: 'completed', waitingReason: null, error: null, participantIds: ['a'], nextParticipant: 1, budget: { maxAttempts: 6, timeoutMs: 300000 }, authorization: { localProject: false, externalWrites: false, version: 1, revoked: false }, amendments: [], evidence: [] }] as unknown as PaSnapshot['tasks'];
    snapshot.attempts = [attempt('old', 10), attempt('new', 20)] as unknown as PaSnapshot['attempts'];
    let finishOld!: (value: PaOutputPage) => void;
    extraRoute = (path) => {
      if (path.startsWith('/attempts/old/')) return new Promise((resolve) => { finishOld = resolve as typeof finishOld; });
      if (path.startsWith('/attempts/new/')) return { attemptId: 'new', offset: 0, nextOffset: null, totalChars: 10, text: 'NEW OUTPUT', matches: [] };
      return undefined;
    };
    mount({ modal: { kind: 'task', taskId: 't', output: 'old' } });
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Back to task/ }));
    const fullOutput = await within(dialog).findAllByRole('button', { name: /Full output/ });
    fireEvent.click(fullOutput[fullOutput.length - 1]!);
    await within(dialog).findByText('NEW OUTPUT');
    await act(async () => finishOld({ attemptId: 'old', offset: 0, nextOffset: null, totalChars: 10, text: 'OLD OUTPUT', matches: [] }));
    expect(screen.queryByText('OLD OUTPUT')).toBeNull();
  });
});
