import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_PLUGIN_GATEWAY_HEADER } from '@open-design/contracts';
import type { OpenDesignHostToolPluginEvent } from '@open-design/host';
import { createDesktopToolPlugins, quickSearchPlugin, type DesktopToolPlugins } from '../../src/main/tool-plugins.js';

let scratch: string;
let preferences: string;
const managers: DesktopToolPlugins[] = [];

beforeEach(() => {
  const root = fileURLToPath(new URL('../../../../.tmp/', import.meta.url));
  mkdirSync(root, { recursive: true });
  scratch = mkdtempSync(join(root, 'tool-plugins-test-'));
  preferences = join(scratch, 'plugins.json');
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  rmSync(scratch, { recursive: true, force: true });
});

function setup(available = true) {
  const callbacks = new Map<string, () => void>();
  const shortcuts = {
    register: vi.fn((key: string, callback: () => void) => {
      if (!available || callbacks.has(key)) return false;
      callbacks.set(key, callback);
      return true;
    }),
    unregister: vi.fn((key: string) => { callbacks.delete(key); }),
  };
  const commands: string[] = [];
  const events: OpenDesignHostToolPluginEvent[] = [];
  let clipboard = 'copied text';
  const manager = createDesktopToolPlugins({
    preferencesPath: preferences,
    builtins: [quickSearchPlugin('darwin'), { id: 'toolbox', client: true }],
    shortcuts,
    desktop: {
      platform: 'darwin',
      showMainWindow: () => {},
      runCommand: (command) => { commands.push(command); return true; },
      readClipboardText: () => clipboard,
      writeClipboardText: (text) => { clipboard = text; },
    },
    emit: event => { events.push(event); },
  });
  managers.push(manager);
  return { manager, shortcuts, callbacks, commands, events, clipboard: () => clipboard };
}

function writePackage(name: string, files: Record<string, string>): string {
  const folder = join(scratch, name);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, file)), { recursive: true });
    writeFileSync(join(folder, file), content);
  }
  return folder;
}

function plugin(manager: DesktopToolPlugins, id: string) {
  return manager.list().find(item => item.id === id);
}

describe('built-in tool plugins', () => {
  it('registers only enabled plugins and restores the preference on relaunch', async () => {
    const first = setup();
    await first.manager.ready;
    expect(plugin(first.manager, 'quick-search')).toMatchObject({
      shortcut: '⌘⇧Space', enabled: false, active: false, status: 'inactive', source: 'builtin',
    });
    expect(first.shortcuts.register).not.toHaveBeenCalled();
    expect((await first.manager.setEnabled('quick-search', true)).ok).toBe(true);
    expect((await first.manager.setEnabled('quick-search', true)).ok).toBe(true);
    expect(first.shortcuts.register).toHaveBeenCalledTimes(1);
    first.callbacks.get('CommandOrControl+Shift+Space')?.();
    expect(first.commands).toEqual(['fantay.search']);
    await first.manager.dispose();
    expect(first.callbacks.size).toBe(0);

    const relaunched = setup();
    await relaunched.manager.ready;
    expect(plugin(relaunched.manager, 'quick-search')).toMatchObject({ enabled: true, active: true, status: 'active' });
    expect((await relaunched.manager.setEnabled('quick-search', false)).ok).toBe(true);
    expect(relaunched.callbacks.size).toBe(0);
    const third = setup();
    await third.manager.ready;
    expect(third.shortcuts.register).not.toHaveBeenCalled();
  });

  it('reports a shortcut conflict without saving it as enabled', async () => {
    const { manager } = setup(false);
    expect(await manager.setEnabled('quick-search', true)).toMatchObject({ ok: false, reason: 'activation-failed' });
    expect(plugin(manager, 'quick-search')).toMatchObject({ enabled: false, active: false });
    const next = setup();
    await next.manager.ready;
    expect(next.shortcuts.register).not.toHaveBeenCalled();
  });

  it('keeps the preference but reports the plugin inactive when a relaunch cannot register it', async () => {
    const first = setup();
    await first.manager.setEnabled('quick-search', true);
    await first.manager.dispose();
    const { manager } = setup(false);
    await manager.ready;
    expect(plugin(manager, 'quick-search')).toMatchObject({ enabled: true, active: false, status: 'failed' });
  });

  it('unregisters the shortcut when enabling it cannot be saved', async () => {
    const { manager, callbacks } = setup();
    mkdirSync(preferences);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await manager.setEnabled('quick-search', true)).toEqual({ ok: false, reason: 'save-failed' });
      expect(plugin(manager, 'quick-search')).toMatchObject({ enabled: false, active: false });
      expect(callbacks.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('enables a plugin that only has a workspace module without starting anything', async () => {
    const { manager, events } = setup();
    expect(plugin(manager, 'toolbox')).toMatchObject({ client: true, enabled: false });
    expect((await manager.setEnabled('toolbox', true)).ok).toBe(true);
    expect(plugin(manager, 'toolbox')).toMatchObject({ enabled: true, active: true, status: 'active' });
    await Promise.resolve();
    expect(events.some(event => event.type === 'changed')).toBe(true);
  });

  it('reads the first preferences format, a bare list of enabled ids', async () => {
    writeFileSync(preferences, JSON.stringify(['quick-search']));
    const { manager, callbacks } = setup();
    await manager.ready;
    expect(plugin(manager, 'quick-search')).toMatchObject({ enabled: true, active: true });
    expect(callbacks.size).toBe(1);
  });
});

const FANTAY_HOST = `
export const name = 'notes';
export const inject = ['shortcuts', 'desktop', 'bridge'];
export function apply(ctx, config) {
  ctx.shortcuts.register(config.shortcut, () => ctx.bridge.send('open', { from: 'shortcut' }));
  ctx.bridge.handle('clipboard', () => ctx.desktop.readClipboardText());
}
`;

function fantayPackage(name = 'fantay-notes') {
  return writePackage(name, {
    'package.json': JSON.stringify({
      name,
      version: '1.2.0',
      type: 'module',
      main: './index.js',
      exports: { '.': './index.js', './client': './client.js' },
      fantay: {
        plugin: {
          title: { zh: '便签', en: 'Notes' },
          description: 'Quick notes',
          shortcut: '⌥N',
          config: { shortcut: 'Alt+N' },
        },
      },
    }),
    'index.js': FANTAY_HOST,
    'client.js': `window.__ModuleLoader__.load({ id: '${name}', factory() { return { apply() {} }; } });`,
  });
}

describe('installed tool plugins', () => {
  it('copies a package folder in, disabled, then runs and stops its host half', async () => {
    const { manager, callbacks, events } = setup();
    const folder = fantayPackage();
    const installed = await manager.install(folder);
    expect(installed.ok).toBe(true);
    const copy = join(scratch, 'desktop-tool-plugins', 'fantay-notes');
    expect(plugin(manager, 'fantay-notes')).toMatchObject({
      source: 'installed', flavor: 'fantay', version: '1.2.0', title: { zh: '便签', en: 'Notes' },
      description: 'Quick notes', shortcut: '⌥N', client: true, enabled: false, status: 'inactive', path: copy,
    });
    expect(readFileSync(join(copy, 'index.js'), 'utf8')).toBe(FANTAY_HOST);
    expect(manager.clientModule('fantay-notes')).toBeNull();

    expect(await manager.setEnabled('fantay-notes', true)).toMatchObject({ ok: true });
    expect(plugin(manager, 'fantay-notes')).toMatchObject({ enabled: true, active: true, status: 'active' });
    expect(manager.clientModule('fantay-notes')).toMatchObject({ id: 'fantay-notes', moduleId: 'fantay-notes' });
    expect(await manager.invoke('fantay-notes', 'clipboard', undefined)).toBe('copied text');
    callbacks.get('Alt+N')?.();
    expect(events).toContainEqual({ type: 'message', pluginId: 'fantay-notes', channel: 'open', payload: { from: 'shortcut' } });

    expect((await manager.setEnabled('fantay-notes', false)).ok).toBe(true);
    expect(callbacks.has('Alt+N')).toBe(false);
    await expect(manager.invoke('fantay-notes', 'clipboard', undefined)).rejects.toThrow();
  });

  it('restores an installed plugin on relaunch, and deleting it removes Fantay\'s copy only', async () => {
    const first = setup();
    const folder = fantayPackage();
    await first.manager.install(folder);
    await first.manager.setEnabled('fantay-notes', true);
    await first.manager.dispose();

    const { manager, callbacks } = setup();
    await manager.ready;
    expect(plugin(manager, 'fantay-notes')).toMatchObject({ enabled: true, active: true });
    expect(callbacks.has('Alt+N')).toBe(true);
    expect((await manager.uninstall('fantay-notes')).ok).toBe(true);
    expect(callbacks.has('Alt+N')).toBe(false);
    expect(plugin(manager, 'fantay-notes')).toBeUndefined();
    expect(JSON.parse(readFileSync(preferences, 'utf8'))).toMatchObject({ enabled: [], installed: [] });
    expect(existsSync(join(scratch, 'desktop-tool-plugins', 'fantay-notes'))).toBe(false);
    expect(readFileSync(join(folder, 'package.json'), 'utf8')).toContain('fantay-notes');
  });

  it('replaces the files of an installed plugin and restarts it when it was enabled', async () => {
    const { manager, callbacks } = setup();
    await manager.install(fantayPackage());
    await manager.setEnabled('fantay-notes', true);
    expect(callbacks.has('Alt+N')).toBe(true);

    const next = writePackage('next-version', {
      'package.json': JSON.stringify({
        name: 'fantay-notes', version: '2.0.0', type: 'module', main: './index.js',
        fantay: { plugin: { config: { shortcut: 'Alt+M' } } },
      }),
      'index.js': FANTAY_HOST,
    });
    expect((await manager.install(next)).ok).toBe(true);
    expect(plugin(manager, 'fantay-notes')).toMatchObject({ version: '2.0.0', enabled: true, active: true, client: false });
    expect([...callbacks.keys()]).toEqual(['Alt+M']);
    expect(JSON.parse(readFileSync(preferences, 'utf8')).installed).toEqual([join(scratch, 'desktop-tool-plugins', 'fantay-notes')]);
  });

  it('leaves a folder registered from elsewhere in place when the plugin is deleted', async () => {
    const folder = fantayPackage();
    writeFileSync(preferences, JSON.stringify({ version: 2, enabled: [], installed: [folder] }));
    const { manager } = setup();
    await manager.ready;
    expect(plugin(manager, 'fantay-notes')).toMatchObject({ path: folder });
    expect((await manager.uninstall('fantay-notes')).ok).toBe(true);
    expect(plugin(manager, 'fantay-notes')).toBeUndefined();
    expect(existsSync(join(folder, 'package.json'))).toBe(true);
  });

  it('rolls back a plugin whose host entry fails to start', async () => {
    const { manager, callbacks } = setup();
    callbacks.set('Alt+N', () => {});
    await manager.install(fantayPackage());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await manager.setEnabled('fantay-notes', true)).toMatchObject({
        ok: false, reason: 'activation-failed', message: expect.stringContaining('Alt+N'),
      });
    } finally {
      warn.mockRestore();
    }
    expect(plugin(manager, 'fantay-notes')).toMatchObject({ enabled: false, active: false });
    await expect(manager.invoke('fantay-notes', 'clipboard', undefined)).rejects.toThrow();
  });

  it('rejects folders that are not plugin packages and names already in use', async () => {
    const { manager } = setup();
    const plain = writePackage('plain', { 'package.json': JSON.stringify({ name: 'plain', main: 'index.js' }), 'index.js': '' });
    expect(await manager.install(plain)).toMatchObject({ ok: false, reason: 'invalid-package' });
    expect(await manager.install(join(scratch, 'nowhere'))).toMatchObject({ ok: false, reason: 'invalid-package' });
    const builtin = writePackage('quick-search', {
      'package.json': JSON.stringify({ name: 'quick-search', fantay: { plugin: {} }, main: 'index.js' }),
      'index.js': 'export function apply() {}',
    });
    expect(await manager.install(builtin)).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(await manager.install()).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('marks a plugin whose files disappeared as missing, and lets it be deleted', async () => {
    const first = setup();
    await first.manager.install(fantayPackage());
    await first.manager.dispose();
    const copy = join(scratch, 'desktop-tool-plugins', 'fantay-notes');
    rmSync(copy, { recursive: true });
    const { manager } = setup();
    await manager.ready;
    const missing = manager.list().find(item => item.path === copy);
    expect(missing).toMatchObject({ status: 'missing', active: false });
    expect((await manager.uninstall(missing!.id)).ok).toBe(true);
    expect(manager.list().some(item => item.path === copy)).toBe(false);
  });
});

const DSH_HOST = `
export const name = 'dsh-sample';
export function apply(ctx, config = {}) {
  ctx.inject(['webServer'], (web) => {
    web.effect(() => web.webServer.register({
      kind: 'prefix',
      path: '/api/plugins/dsh-sample',
      handler: (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: req.url, greeting: config.greeting, home: config.home, header: req.headers['${TOOL_PLUGIN_GATEWAY_HEADER}'] ?? null }));
      },
    }), 'dsh-sample: routes');
  });
  ctx.inject(['tools'], () => { throw new Error('never runs'); });
}
`;

describe('DeepSeek Harness bundles', () => {
  it('starts the rows of the bundle patch and serves its webServer routes through the gateway token', async () => {
    const { manager } = setup();
    const folder = writePackage('dsh-sample', {
      'package.json': JSON.stringify({
        name: 'dsh-sample',
        version: '0.1.0',
        type: 'module',
        main: './index.js',
        exports: { '.': './index.js', './client': './client.js', './locale/*.json': './locale/*.json', './icon': './icon.svg' },
        dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar-right'] } },
      }),
      'cordis.patch.yml': [
        '- insert:',
        '    - id: sample',
        '      name: dsh-sample',
        '      config:',
        '        greeting: hello',
        "        home: !!js dshHomePath('plugins-data', 'dsh-sample')",
        '    - id: missing',
        '      name: "@deepseek-ai/dsh-client-ui-sidebar"',
      ].join('\n'),
      'index.js': DSH_HOST,
      'client.js': 'window.__ModuleLoader__.load({ id: "dsh-sample", factory() { return { apply() {} }; } });',
      'locale/zh.json': JSON.stringify({ meta: { title: '示例剧场', description: '演示' } }),
      'locale/en.json': JSON.stringify({ name: 'Sample theatre' }),
      'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    expect((await manager.install(folder)).ok).toBe(true);
    expect(plugin(manager, 'dsh-sample')).toMatchObject({
      flavor: 'dsh', title: { zh: '示例剧场', en: 'Sample theatre' }, description: { zh: '演示' },
      icon: expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    });
    expect(manager.gateway()).toBeNull();

    expect((await manager.setEnabled('dsh-sample', true)).ok).toBe(true);
    expect(plugin(manager, 'dsh-sample')).toMatchObject({
      enabled: true, active: true, status: 'pending', issue: expect.stringContaining('tools'),
    });
    const gateway = manager.gateway();
    expect(gateway).toMatchObject({ prefixes: ['/api/plugins/dsh-sample'] });
    const url = `http://127.0.0.1:${gateway!.port}/api/plugins/dsh-sample/feed?x=1`;
    expect((await fetch(url)).status).toBe(403);
    const response = await fetch(url, { headers: { [TOOL_PLUGIN_GATEWAY_HEADER]: gateway!.token } });
    expect(await response.json()).toEqual({
      url: '/api/plugins/dsh-sample/feed?x=1',
      greeting: 'hello',
      home: join(scratch, 'desktop-tool-plugins-data', 'plugins-data', 'dsh-sample'),
      header: null,
    });

    expect((await manager.setEnabled('dsh-sample', false)).ok).toBe(true);
    expect(manager.gateway()).toMatchObject({ prefixes: [] });
    expect((await fetch(url, { headers: { [TOOL_PLUGIN_GATEWAY_HEADER]: gateway!.token } })).status).toBe(404);
  });
});
