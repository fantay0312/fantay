// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The workspace half of the tool plugin system: client modules load when the host reports a plugin
// enabled, contribute pages through slots, and take everything back when the plugin is disabled.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OpenDesignHostBridge,
  OpenDesignHostToolPlugin,
  OpenDesignHostToolPluginEvent,
} from '@open-design/host';

import { pluginNavItems } from '../../../src/fantay/plugins/nav';
import { ToolPluginRuntime } from '../../../src/fantay/plugins/runtime';

type ToolPluginsHost = NonNullable<OpenDesignHostBridge['toolPlugins']>;

const host = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@open-design/host', async (original) => ({
  ...(await original<typeof import('@open-design/host')>()),
  getOpenDesignHost: () => (host.current ? { toolPlugins: host.current } : null),
}));

const FANTAY_CLIENT = `
window.__ModuleLoader__.load({
  id: 'fantay-notes',
  factory(require) {
    const React = require('react');
    const style = document.createElement('style');
    style.textContent = '.notes{}';
    document.head.appendChild(style);
    const Page = () => React.createElement('div', null, 'notes page');
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register('notes', { zh: { title: '便签' }, en: { title: 'Notes' } });
        const t = ctx.locale.bind('notes');
        ctx.slots.register({ name: 'fantay.sidebar.nav', id: 'notes', order: 5, label: () => t('title') }, Page);
      },
    };
  },
});`;

// The shape of a DeepSeek Harness client bundle: a right-sidebar tab type plus slot injections.
const HARNESS_CLIENT = `
window.__ModuleLoader__.load({
  id: 'dsh-sample',
  factory(require) {
    const React = require('react');
    const Body = () => React.createElement('div', null, 'theatre');
    window.__harnessCtx = null;
    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        window.__harnessCtx = ctx;
        ctx.effect(() => ctx.locale.register('sample', 'zh', { 'tab.title': '示例剧场' }), 'sample: zh');
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: 'dsh-sample', kind: 'sample-drama', multiple: false, title: () => '示例剧场',
          guide: [{ id: 'sample', order: 30, title: () => '示例剧场', description: () => '演示' }],
        }), 'sample: tab type');
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-sample' }, Body));
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'sample', order: 10 }, Body));
        ctx.slots.inject('settings.plugins.tab', () => { throw new Error('this slot does not exist in Fantay'); });
      },
    };
  },
});`;

function plugin(id: string, overrides: Partial<OpenDesignHostToolPlugin> = {}): OpenDesignHostToolPlugin {
  return { id, enabled: true, active: true, status: 'active', source: 'installed', flavor: 'fantay', client: true, ...overrides };
}

function setup(plugins: OpenDesignHostToolPlugin[], modules: Record<string, string>) {
  let listener: ((event: OpenDesignHostToolPluginEvent) => void) | null = null;
  const state = { plugins };
  const fake: ToolPluginsHost = {
    list: async () => state.plugins,
    setEnabled: async (id, enabled) => {
      state.plugins = state.plugins.map(item => (item.id === id ? { ...item, enabled, active: enabled } : item));
      return { ok: true, plugins: state.plugins };
    },
    clientModule: async id => (modules[id] ? { id, moduleId: id, code: modules[id]!, rev: '1' } : null),
    gateway: async () => ({ port: 4100, token: 'a-gateway-token-of-enough-length', prefixes: ['/api/plugins/dsh-sample'] }),
    invoke: async (pluginId, channel, payload) => ({ pluginId, channel, payload }),
    subscribe: (next) => {
      listener = next;
      return () => { listener = null; };
    },
  };
  host.current = fake;
  const runtime = new ToolPluginRuntime();
  const shell = { openPage: vi.fn(), runCommand: vi.fn(() => true) };
  runtime.start(shell);
  return { runtime, shell, emit: (event: OpenDesignHostToolPluginEvent) => listener?.(event) };
}

/** Lets the runtime's queued work (list, gateway, module load, fiber start) run to completion. */
async function settled(runtime: ToolPluginRuntime, done: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!done()) throw new Error(`not settled: ${JSON.stringify(runtime.getSnapshot())}`);
  });
}

describe('tool plugin runtime', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
    document.head.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    host.current = null;
  });

  it('stays unavailable without a desktop host', () => {
    host.current = null;
    const runtime = new ToolPluginRuntime();
    runtime.start({ openPage: vi.fn(), runCommand: vi.fn(() => false) });
    expect(runtime.getSnapshot()).toMatchObject({ available: false, ready: false });
  });

  it('loads an enabled plugin, shows its page, and removes it when the plugin is disabled', async () => {
    const { runtime } = setup([plugin('fantay-notes')], { 'fantay-notes': FANTAY_CLIENT });
    await settled(runtime, () => runtime.getSnapshot().clients['fantay-notes']?.status === 'active');
    expect(pluginNavItems(runtime)).toMatchObject([{ pluginId: 'fantay-notes', pageId: 'notes', title: 'Notes', order: 5 }]);
    expect(document.head.querySelector('style[data-plugin="fantay-notes"]')).not.toBeNull();

    runtime.setLocale('zh-CN');
    expect(pluginNavItems(runtime)[0]?.title).toBe('便签');

    await runtime.setEnabled('fantay-notes', false);
    await settled(runtime, () => pluginNavItems(runtime).length === 0);
    expect(runtime.getSnapshot().clients['fantay-notes']).toBeUndefined();
    expect(document.head.querySelector('style[data-plugin]')).toBeNull();
    expect(runtime.locale.translate('notes', 'title')).toBe('title');
  });

  it('runs a DeepSeek Harness client bundle and shows its right-sidebar tab as a page', async () => {
    const { runtime, shell } = setup([plugin('dsh-sample', { flavor: 'dsh' })], { 'dsh-sample': HARNESS_CLIENT });
    await settled(runtime, () => runtime.getSnapshot().clients['dsh-sample']?.status === 'active');
    expect(pluginNavItems(runtime)).toMatchObject([{ pluginId: 'dsh-sample', pageId: 'dsh-sample', title: '示例剧场', order: 30 }]);
    expect(runtime.slots.entriesOfSlot('sidebar.footer.action')).toHaveLength(1);

    const ctx = (window as unknown as { __harnessCtx: { sidebarRight: { openTab(kind: string, options?: unknown): void } } }).__harnessCtx;
    ctx.sidebarRight.openTab('sample-drama', { params: { episode: 3 } });
    expect(shell.openPage).toHaveBeenCalledWith('dsh-sample', 'dsh-sample');
    expect(runtime.tabs.paramsOf('sample-drama')).toEqual({ episode: 3 });

    expect(fetchMock).toHaveBeenCalledWith('/api/tool-plugin-gateway', expect.objectContaining({ method: 'PUT' }));
  });

  it('follows changes the host announces', async () => {
    const { runtime, emit } = setup([plugin('fantay-notes', { enabled: false, active: false, status: 'inactive' })], { 'fantay-notes': FANTAY_CLIENT });
    await settled(runtime, () => runtime.getSnapshot().ready);
    expect(pluginNavItems(runtime)).toHaveLength(0);
    emit({ type: 'changed', plugins: [plugin('fantay-notes')] });
    await settled(runtime, () => pluginNavItems(runtime).length === 1);
  });

  it('reports a module that needs a service Fantay lacks, and one that fails to load', async () => {
    const waiting = `window.__ModuleLoader__.load({ id: 'needs-sessions', factory() { return { inject: ['sessions'], apply() {} }; } });`;
    const broken = `window.__ModuleLoader__.load({ id: 'broken', factory(require) { require('zod'); } });`;
    const { runtime } = setup([plugin('needs-sessions'), plugin('broken')], { 'needs-sessions': waiting, broken });
    await settled(runtime, () => runtime.getSnapshot().clients.broken?.status === 'failed'
      && runtime.getSnapshot().clients['needs-sessions']?.status === 'pending');
    expect(runtime.getSnapshot().clients['needs-sessions']?.issue).toContain('sessions');
    expect(runtime.getSnapshot().clients.broken?.issue).toContain('zod');
  });
});
