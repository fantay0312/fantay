// Services the desktop host provides to tool plugins. A plugin's host entry is a Cordis plugin
// (`apply(ctx, config)`), the same contract as DeepSeek Harness, and reaches these through `inject`:
//
//   export const inject = ['shortcuts', 'desktop'];
//   export function apply(ctx) {
//     ctx.shortcuts.register('CommandOrControl+Shift+T', () => ctx.desktop.showMainWindow());
//   }
//
// Every registration made through a service belongs to the calling plugin: Cordis hands a service
// method the caller's context as `this.ctx`, so the registration is an effect of that plugin and is
// undone when the plugin is switched off.
import { Service, type Context } from '@deepseek-ai/cordis';
import { ToolPluginWebServer, type ToolPluginWebRoute } from './tool-plugin-web-server.js';

/** Context key that names the plugin a fiber belongs to. */
export const TOOL_PLUGIN_OWNER: unique symbol = Symbol.for('fantay.toolPlugin.owner');

export function toolPluginOwner(ctx: Context): string | undefined {
  const owner = (ctx as unknown as Record<symbol, unknown>)[TOOL_PLUGIN_OWNER];
  return typeof owner === 'string' ? owner : undefined;
}

export interface ToolPluginShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** What the desktop shell lets a plugin do; implemented in `runtime.ts` over Electron. */
export interface ToolPluginDesktop {
  platform: NodeJS.Platform;
  /** Brings the Fantay workspace window to the front. */
  showMainWindow(): void;
  /** Runs a Fantay command (`fantay.search`, `fantay.newChat` …) in the front workspace window. */
  runCommand(command: string): boolean;
  readClipboardText(): string;
  writeClipboardText(text: string): void;
}

type BridgeHandler = (payload: unknown) => unknown;

declare module '@deepseek-ai/cordis' {
  interface Context {
    shortcuts: ShortcutsService;
    desktop: DesktopService;
    bridge: BridgeService;
    webServer: WebServerService;
  }
}

/** Global keyboard shortcuts. A shortcut another app holds makes `register` throw. */
export class ShortcutsService extends Service {
  constructor(ctx: Context, private readonly registry: ToolPluginShortcutRegistry) {
    super(ctx, 'shortcuts');
  }

  register(accelerator: string, handler: () => void): () => void {
    const registry = this.registry;
    return this.ctx.effect(() => {
      if (!registry.register(accelerator, handler)) throw new Error(`Shortcut ${accelerator} is not available`);
      return () => registry.unregister(accelerator);
    }, `shortcuts.register(${accelerator})`);
  }
}

/** The Fantay window, its commands and the clipboard. */
export class DesktopService extends Service {
  constructor(ctx: Context, private readonly shell: ToolPluginDesktop) {
    super(ctx, 'desktop');
  }

  get platform(): NodeJS.Platform {
    return this.shell.platform;
  }

  showMainWindow(): void {
    this.shell.showMainWindow();
  }

  runCommand(command: string): boolean {
    return this.shell.runCommand(command);
  }

  readClipboardText(): string {
    return this.shell.readClipboardText();
  }

  writeClipboardText(text: string): void {
    this.shell.writeClipboardText(text);
  }
}

/**
 * Messages between a plugin's host half and its workspace half. `handle` answers
 * `ctx.bridge.invoke(channel, payload)` from the workspace; `send` reaches `ctx.bridge.on(channel, …)` there.
 */
export class BridgeService extends Service {
  private readonly handlers = new Map<string, Map<string, BridgeHandler>>();

  constructor(ctx: Context, private readonly deliver: (pluginId: string, channel: string, payload: unknown) => void) {
    super(ctx, 'bridge');
  }

  handle(channel: string, handler: BridgeHandler): () => void {
    const owner = toolPluginOwner(this.ctx);
    if (!owner) throw new Error('bridge.handle must be called by a tool plugin');
    const handlers = this.handlers;
    return this.ctx.effect(() => {
      const channels = handlers.get(owner) ?? new Map<string, BridgeHandler>();
      if (channels.has(channel)) throw new Error(`bridge channel already handled: ${channel}`);
      channels.set(channel, handler);
      handlers.set(owner, channels);
      return () => {
        channels.delete(channel);
        if (channels.size === 0) handlers.delete(owner);
      };
    }, `bridge.handle(${channel})`);
  }

  send(channel: string, payload?: unknown): void {
    const owner = toolPluginOwner(this.ctx);
    if (!owner) throw new Error('bridge.send must be called by a tool plugin');
    this.deliver(owner, channel, payload);
  }

  /** Called by the host for a workspace `invoke`; rejects when the plugin has no handler for `channel`. */
  async invoke(pluginId: string, channel: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(pluginId)?.get(channel);
    if (!handler) throw new Error(`No handler for ${pluginId}:${channel}`);
    return handler(payload);
  }
}

/** DeepSeek Harness `webServer`: plugin HTTP routes (see `tool-plugin-web-server.ts`). */
export class WebServerService extends Service {
  readonly host = '127.0.0.1';
  readonly protocol = 'http:';

  constructor(ctx: Context, private readonly server: ToolPluginWebServer) {
    super(ctx, 'webServer');
  }

  get port(): number | undefined {
    return this.server.port;
  }

  /** The loopback origin. Requests need the gateway token, so only the plugin's own host code can use it. */
  getOrigin(): string {
    const port = this.server.port;
    if (port === undefined) throw new Error('webServer is not listening yet');
    return `http://127.0.0.1:${port}`;
  }

  register(route: ToolPluginWebRoute): () => void {
    const server = this.server;
    return this.ctx.effect(() => server.register(route), `webServer.register(${route?.path})`);
  }

  registerUpgrade(): never {
    throw new Error('webServer.registerUpgrade is not available in Fantay');
  }

  registerFallback(): never {
    throw new Error('webServer.registerFallback is not available in Fantay');
  }
}
