// SPDX-License-Identifier: AGPL-3.0-only
// The workspace half of the tool plugin system. The desktop host owns which plugins exist and which
// are enabled; this runtime mirrors that list and, for every enabled plugin with a client module, runs
// the module as a Cordis plugin against the workspace services (`services.ts`). Disabling a plugin
// disposes its fiber, which removes its slot entries, pages, dictionaries and listeners.
//
// One instance serves the whole workspace: the sidebar, plugin pages and the Plugins page all read it.
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis';
import { TOOL_PLUGIN_GATEWAY_PATH, type ToolPluginGatewayRequest } from '@open-design/contracts';
import {
  getOpenDesignHost,
  type OpenDesignHostBridge,
  type OpenDesignHostToolPlugin,
  type OpenDesignHostToolPluginChangeResult,
} from '@open-design/host';

import { BUILTIN_CLIENT_MODULES } from './builtin';
import { evaluateClientModule, removePluginStyles } from './module-loader';
import {
  ClientBridgeService,
  FantayClientService,
  LocaleService,
  LocaleStore,
  SidebarRightService,
  SidebarRightTabsService,
  SidebarRightTabStore,
  SlotsService,
  TOOL_PLUGIN_OWNER,
  toolPluginOwner,
  type FantayClientShell,
} from './services';
import { SlotStore } from './slots';

type ToolPluginsHost = NonNullable<OpenDesignHostBridge['toolPlugins']>;

// Cordis fiber states (`FiberState` is a const enum, so the values are spelled out here).
const FIBER_PENDING = 0;
const FIBER_FAILED = 3;

/** How a plugin's client module is doing in this window. */
export interface ToolPluginClientState {
  status: 'loading' | 'active' | 'pending' | 'failed';
  /** Diagnostic for `pending` and `failed`; not localized. */
  issue?: string;
}

export interface ToolPluginRuntimeSnapshot {
  /** False outside the desktop app and on a host without tool plugins. */
  available: boolean;
  /** The first plugin list has arrived. */
  ready: boolean;
  loadFailed: boolean;
  plugins: readonly OpenDesignHostToolPlugin[];
  clients: Readonly<Record<string, ToolPluginClientState>>;
}

interface LoadedClient {
  fiber: Fiber;
  rev: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unwrapPlugin(exported: unknown): Plugin {
  if (typeof exported !== 'function' && typeof (exported as { apply?: unknown } | null)?.apply !== 'function') {
    throw new Error('The client module exports no plugin (expected `{ apply(ctx) }`)');
  }
  return exported as Plugin;
}

export class ToolPluginRuntime {
  readonly slots = new SlotStore();
  readonly locale = new LocaleStore();
  readonly tabs = new SidebarRightTabStore();

  private host: ToolPluginsHost | null = null;
  private root: Context | null = null;
  private bridge: ClientBridgeService | null = null;
  private services: Fiber | null = null;
  private readonly loaded = new Map<string, LoadedClient>();
  private readonly owned = new Map<string, Set<Fiber>>();
  private readonly loadErrors = new Map<string, string>();
  private readonly loading = new Set<string>();
  private snapshot: ToolPluginRuntimeSnapshot = { available: false, ready: false, loadFailed: false, plugins: [], clients: {} };
  private readonly listeners = new Set<() => void>();
  private uiVersion = 0;
  private notifyScheduled = false;
  private queue: Promise<void> = Promise.resolve();
  private gatewayKey = '';

  /** Boots the runtime once. `shell` is how plugins reach the Fantay shell (navigation, commands). */
  start(shell: FantayClientShell): void {
    if (this.root) return;
    const host = getOpenDesignHost()?.toolPlugins ?? null;
    if (!host) return;
    this.host = host;
    const root = new Context();
    this.root = root;
    root.on('internal/plugin', (fiber: Fiber) => {
      const owner = toolPluginOwner(fiber.ctx);
      if (!owner) return;
      if (fiber.uid === null) this.owned.get(owner)?.delete(fiber);
      else (this.owned.get(owner) ?? this.owned.set(owner, new Set()).get(owner)!).add(fiber);
    });
    root.on('internal/status', (fiber: Fiber) => {
      if (toolPluginOwner(fiber.ctx)) this.publish();
    });

    // Fantay's own slot, then the DeepSeek Harness slots Fantay draws: the right-sidebar tab body
    // becomes a page (`PluginPage`), footer actions sit at the sidebar foot and dock entries above the
    // chat composer (`HarnessSlots`).
    this.slots.declare('fantay.sidebar.nav', { kind: 'list', scope: 'root' });
    this.slots.declare('sidebar.right.pane.tab', { kind: 'keyed', scope: 'session' });
    this.slots.declare('sidebar.right.pane.tab.title', { kind: 'keyed', scope: 'session' });
    this.slots.declare('sidebar.footer.action', { kind: 'list', scope: 'root' });
    this.slots.declare('conversation.input.dock', { kind: 'list', scope: 'session' });

    const { slots, locale, tabs } = this;
    this.services = root.plugin({
      name: 'fantay-tool-plugin-client-services',
      apply: (ctx: Context) => {
        new SlotsService(ctx, slots);
        new LocaleService(ctx, locale);
        new SidebarRightTabsService(ctx, tabs);
        new SidebarRightService(ctx, tabs, shell.openPage);
        new FantayClientService(ctx, shell);
        this.bridge = new ClientBridgeService(ctx, (pluginId, channel, payload) => {
          if (!host.invoke) return Promise.reject(new Error('This Fantay host has no plugin bridge'));
          return host.invoke(pluginId, channel, payload);
        });
      },
    });

    for (const store of [slots, tabs, locale]) store.subscribe(() => this.publish());
    host.subscribe?.((event) => {
      if (event.type === 'changed') this.apply(event.plugins);
      else this.bridge?.deliver(event.pluginId, event.channel, event.payload);
    });
    this.snapshot = { ...this.snapshot, available: true };
    this.publish();
    void this.refresh();
  }

  /** Reads the plugin list from the host again. */
  async refresh(): Promise<void> {
    if (!this.host) return;
    try {
      this.apply(await this.host.list());
    } catch {
      this.snapshot = { ...this.snapshot, loadFailed: true };
      this.publish();
    }
  }

  setEnabled(id: string, enabled: boolean): Promise<OpenDesignHostToolPluginChangeResult> {
    return this.change(host => host.setEnabled(id, enabled));
  }

  /** Asks the host to add a plugin package folder; resolves null when this host cannot install plugins. */
  install(): Promise<OpenDesignHostToolPluginChangeResult | null> {
    return this.host?.install ? this.change(host => host.install!()) : Promise.resolve(null);
  }

  uninstall(id: string): Promise<OpenDesignHostToolPluginChangeResult | null> {
    return this.host?.uninstall ? this.change(host => host.uninstall!(id)) : Promise.resolve(null);
  }

  /** Fantay's locale tag; plugin dictionaries follow it. */
  setLocale(locale: string): void {
    this.locale.setLocale(locale);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ToolPluginRuntimeSnapshot => this.snapshot;

  /** Changes whenever anything a plugin contributes to the UI changes (slots, pages, dictionaries, language). */
  getUiVersion = (): number => this.uiVersion;

  private async change(
    run: (host: ToolPluginsHost) => Promise<OpenDesignHostToolPluginChangeResult>,
  ): Promise<OpenDesignHostToolPluginChangeResult> {
    if (!this.host) throw new Error('Tool plugins need the Fantay desktop app');
    const result = await run(this.host);
    if (result.ok) this.apply(result.plugins);
    return result;
  }

  private apply(plugins: readonly OpenDesignHostToolPlugin[]): void {
    this.snapshot = { ...this.snapshot, ready: true, loadFailed: false, plugins };
    this.publish();
    this.queue = this.queue.then(() => this.reconcile()).catch((error: unknown) => {
      console.warn('[fantay tool plugins] Could not update client modules', error);
    });
  }

  /** Brings the running client modules in line with the latest plugin list. */
  private async reconcile(): Promise<void> {
    const host = this.host;
    if (!host || !this.root) return;
    await this.services?.await();
    const wanted = new Map(
      this.snapshot.plugins.filter(plugin => plugin.enabled && plugin.client && plugin.status !== 'missing').map(plugin => [plugin.id, plugin]),
    );
    for (const id of [...this.loaded.keys()]) if (!wanted.has(id)) await this.unload(id);
    for (const id of [...this.loadErrors.keys()]) if (!wanted.has(id)) this.loadErrors.delete(id);
    await this.syncGateway(host);
    for (const plugin of wanted.values()) {
      if (this.loaded.has(plugin.id) || this.loadErrors.has(plugin.id)) continue;
      this.loading.add(plugin.id);
      this.publish();
      try {
        await this.load(host, plugin);
      } catch (error) {
        console.warn('[fantay tool plugins] Could not load client module', plugin.id, error);
        this.loadErrors.set(plugin.id, errorMessage(error));
      } finally {
        this.loading.delete(plugin.id);
        this.publish();
      }
    }
  }

  private async load(host: ToolPluginsHost, plugin: OpenDesignHostToolPlugin): Promise<void> {
    let exported: unknown;
    let rev = 'builtin';
    if (plugin.source === 'installed') {
      const module = await host.clientModule?.(plugin.id);
      if (!module) throw new Error('The host could not read the client module');
      rev = module.rev;
      exported = evaluateClientModule(module);
    } else {
      const builtin = BUILTIN_CLIENT_MODULES[plugin.id];
      if (!builtin) throw new Error('This Fantay build has no client module for the plugin');
      exported = (await builtin()).default;
    }
    const fiber = this.root!.extend({ [TOOL_PLUGIN_OWNER]: plugin.id }).plugin(unwrapPlugin(exported));
    this.loaded.set(plugin.id, { fiber, rev });
    await fiber.await().catch(() => undefined);
  }

  private async unload(id: string): Promise<void> {
    const client = this.loaded.get(id);
    this.loaded.delete(id);
    try {
      await client?.fiber.dispose();
    } catch (error) {
      console.warn('[fantay tool plugins] Could not unload client module', id, error);
    }
    this.owned.delete(id);
    removePluginStyles(id);
    this.publish();
  }

  /** Tells the daemon where the host serves plugin routes, whenever that changes. */
  private async syncGateway(host: ToolPluginsHost): Promise<void> {
    try {
      const gateway: ToolPluginGatewayRequest | null | undefined = await host.gateway?.();
      if (!gateway) return;
      const key = JSON.stringify(gateway);
      if (key === this.gatewayKey) return;
      const response = await fetch(TOOL_PLUGIN_GATEWAY_PATH, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: key });
      if (response.ok) this.gatewayKey = key;
      else console.warn('[fantay tool plugins] The daemon refused the plugin gateway', response.status);
    } catch (error) {
      console.warn('[fantay tool plugins] Could not register the plugin gateway', error);
    }
  }

  private clientState(id: string): ToolPluginClientState | undefined {
    const failure = this.loadErrors.get(id);
    if (failure) return { status: 'failed', issue: failure };
    if (this.loading.has(id)) return { status: 'loading' };
    if (!this.loaded.has(id)) return undefined;
    const fibers = [...(this.owned.get(id) ?? [])];
    const failed = fibers.find(fiber => (fiber.state as number) === FIBER_FAILED);
    if (failed) return { status: 'failed', issue: errorMessage((failed as unknown as { _error: unknown })._error) };
    const missing = new Set<string>();
    for (const fiber of fibers) {
      if ((fiber.state as number) !== FIBER_PENDING) continue;
      const resolved = (fiber as unknown as { _store?: Record<string, unknown> })._store ?? {};
      for (const name of Object.keys(fiber.inject)) if (!resolved[name]) missing.add(name);
    }
    return missing.size > 0
      ? { status: 'pending', issue: `Waiting for services Fantay does not provide: ${[...missing].join(', ')}` }
      : { status: 'active' };
  }

  /** Rebuilds the client states and tells subscribers, at most once per microtask. */
  private publish(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      const clients: Record<string, ToolPluginClientState> = {};
      for (const plugin of this.snapshot.plugins) {
        const state = this.clientState(plugin.id);
        if (state) clients[plugin.id] = state;
      }
      this.snapshot = { ...this.snapshot, clients };
      this.uiVersion += 1;
      for (const listener of [...this.listeners]) listener();
    });
  }
}

export const toolPluginRuntime = new ToolPluginRuntime();
