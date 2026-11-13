// The desktop host for Fantay tool plugins.
//
// A tool plugin is a unit the user switches on and off. Its host half is a Cordis plugin, the kernel
// DeepSeek Harness uses, so `apply(ctx, config)`, `ctx.inject`, `ctx.effect` and service registration
// behave the same here, and switching a plugin off disposes its fiber, which undoes everything it
// registered. Plugins come from two places:
// - built-in: registered from Fantay source (`BuiltinToolPlugin`);
// - installed: a package folder the user added (`tool-plugin-package.ts`), either a Fantay plugin
//   package or a DeepSeek Harness bundle. Installing copies the package into Fantay's own plugin
//   folder, next to the preferences; deleting the plugin removes that copy.
//
// Preferences hold the enabled ids and the installed folders. Running state lives in this process.
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis';
import type {
  OpenDesignHostToolPlugin,
  OpenDesignHostToolPluginChangeResult,
  OpenDesignHostToolPluginClientModule,
  OpenDesignHostToolPluginEvent,
  OpenDesignHostToolPluginGateway,
} from '@open-design/host';
import {
  readToolPluginPackage,
  type ToolPluginExpression,
  type ToolPluginPackage,
} from './tool-plugin-package.js';
import {
  BridgeService,
  DesktopService,
  ShortcutsService,
  TOOL_PLUGIN_OWNER,
  toolPluginOwner,
  WebServerService,
  type ToolPluginDesktop,
  type ToolPluginShortcutRegistry,
} from './tool-plugin-services.js';
import { ToolPluginWebServer } from './tool-plugin-web-server.js';

export const TOOL_PLUGINS_LIST_IPC = 'od:tool-plugins:list';
export const TOOL_PLUGINS_SET_ENABLED_IPC = 'od:tool-plugins:set-enabled';
export const TOOL_PLUGINS_INSTALL_IPC = 'od:tool-plugins:install';
export const TOOL_PLUGINS_UNINSTALL_IPC = 'od:tool-plugins:uninstall';
export const TOOL_PLUGINS_CLIENT_MODULE_IPC = 'od:tool-plugins:client-module';
export const TOOL_PLUGINS_GATEWAY_IPC = 'od:tool-plugins:gateway';
export const TOOL_PLUGINS_INVOKE_IPC = 'od:tool-plugins:invoke';
export const TOOL_PLUGINS_EVENT_IPC = 'od:tool-plugins:event';

// Cordis fiber states (`FiberState` is a const enum, so the values are spelled out here).
const FIBER_PENDING = 0;
const FIBER_FAILED = 3;

/** A plugin that ships with Fantay. Its name and description come from the workspace's own copy. */
export interface BuiltinToolPlugin {
  id: string;
  /** Shortcut text shown next to the switch. */
  shortcut?: string;
  /** Host half. Omit it for a plugin that only has a workspace module. */
  host?: Plugin;
  /** The workspace bundles a module for this plugin. */
  client?: boolean;
}

export interface DesktopToolPluginsOptions {
  /** File that stores the enabled ids and the installed folders. */
  preferencesPath: string;
  builtins: readonly BuiltinToolPlugin[];
  shortcuts: ToolPluginShortcutRegistry;
  desktop: ToolPluginDesktop;
  /** Asks the user for a plugin package folder; resolves null when they cancel. */
  pickPackageFolder?: () => Promise<string | null>;
  /** Receives every event meant for the workspace. */
  emit?: (event: OpenDesignHostToolPluginEvent) => void;
}

export type DesktopToolPlugins = ReturnType<typeof createDesktopToolPlugins>;

/** Quick search: a global shortcut that opens Fantay's search from any app. */
export function quickSearchPlugin(platform: NodeJS.Platform): BuiltinToolPlugin {
  const accelerator = 'CommandOrControl+Shift+Space';
  return {
    id: 'quick-search',
    shortcut: platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space',
    host: {
      name: 'quick-search',
      inject: ['shortcuts', 'desktop'],
      apply(ctx: Context) {
        ctx.shortcuts.register(accelerator, () => { ctx.desktop.runCommand('fantay.search'); });
      },
    },
  };
}

interface Preferences {
  enabled: Set<string>;
  installed: string[];
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null;
}

/** Reads the preferences file. The first version of the file was a bare list of enabled ids. */
function loadPreferences(path: string): Preferences {
  try {
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const legacy = strings(stored);
    if (legacy) return { enabled: new Set(legacy), installed: [] };
    const record = stored as { enabled?: unknown; installed?: unknown } | null;
    const enabled = strings(record?.enabled);
    const installed = strings(record?.installed);
    if (!enabled || !installed) throw new Error('Invalid tool plugin preferences');
    return { enabled: new Set(enabled), installed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[fantay tool plugins] Could not read preferences', error);
    }
    return { enabled: new Set(), installed: [] };
  }
}

function savePreferences(path: string, preferences: Preferences): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const content = { version: 2, enabled: [...preferences.enabled], installed: preferences.installed };
    writeFileSync(temporaryPath, JSON.stringify(content), { mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The plugin a host entry module exports, unwrapped the way the Harness loader unwraps it. */
function unwrapModule(namespace: unknown): Plugin {
  let exported = (namespace as { default?: unknown } | null)?.default ?? namespace;
  if ((exported as { __esModule?: unknown } | null)?.__esModule) {
    exported = (exported as { default?: unknown }).default ?? exported;
  }
  if (typeof exported !== 'function' && typeof (exported as { apply?: unknown } | null)?.apply !== 'function') {
    throw new Error('The host entry exports no plugin (expected `apply(ctx, config)`)');
  }
  return exported as Plugin;
}

const evaluateExpression = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }') as
  (ctx: Context, expression: string) => unknown;

/** Resolves the `!!js` expressions of a patch config against the entry's context. */
function interpolate(value: unknown, ctx: Context): unknown {
  if (Array.isArray(value)) return value.map(item => interpolate(item, ctx));
  if (typeof value !== 'object' || value === null) return value;
  const expression = (value as Partial<ToolPluginExpression>).__jsExpr;
  if (typeof expression === 'string') return evaluateExpression(ctx, expression);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, ctx)]));
}

interface CatalogEntry {
  id: string;
  builtin?: BuiltinToolPlugin;
  pkg?: ToolPluginPackage;
  /** Folder of an installed plugin. */
  path?: string;
  /** Why the package cannot be read. */
  problem?: string;
}

interface HostRow {
  name: string;
  plugin: Plugin;
  config: unknown;
  inject: string[];
}

export function createDesktopToolPlugins(options: DesktopToolPluginsOptions) {
  const { preferencesPath } = options;
  let preferences = loadPreferences(preferencesPath);
  /** Where installed packages are kept. Only folders inside it are ever deleted. */
  const packagesRoot = join(dirname(preferencesPath), 'desktop-tool-plugins');
  const packageFolder = (id: string): string => join(packagesRoot, id.replace('/', '+'));
  const isManagedFolder = (folder: string): boolean => {
    const inside = relative(packagesRoot, folder);
    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
  };
  const catalog = new Map<string, CatalogEntry>();
  /** The root fiber of each plugin whose host half is running. */
  const running = new Map<string, Fiber>();
  /** Every live fiber of a plugin, nested `ctx.inject` and `ctx.plugin` children included. */
  const owned = new Map<string, Set<Fiber>>();
  /** Host entries skipped at start (their module is not part of the package). */
  const skipped = new Map<string, string>();
  /** Why an enabled plugin is not running. */
  const failures = new Map<string, string>();

  const root = new Context();
  // The Harness root context carries `dshHomePath`, which bundle patches read (`!!js dshHomePath('x')`).
  // Here it resolves inside a Fantay folder next to the preferences.
  (root as unknown as Record<string, unknown>).dshHomePath = (...segments: string[]) =>
    join(dirname(preferencesPath), 'desktop-tool-plugins-data', ...segments);
  const webServer = new ToolPluginWebServer();
  let bridge: BridgeService | null = null;
  let disposed = false;

  root.on('internal/plugin', (fiber: Fiber) => {
    const owner = toolPluginOwner(fiber.ctx);
    if (!owner) return;
    if (fiber.uid === null) owned.get(owner)?.delete(fiber);
    else (owned.get(owner) ?? owned.set(owner, new Set()).get(owner)!).add(fiber);
  });
  root.on('internal/status', (fiber: Fiber) => {
    if (toolPluginOwner(fiber.ctx)) notifyChanged();
  });

  const services = root.plugin({
    name: 'fantay-tool-plugin-services',
    apply(ctx: Context) {
      new ShortcutsService(ctx, options.shortcuts);
      new DesktopService(ctx, options.desktop);
      new WebServerService(ctx, webServer);
      bridge = new BridgeService(ctx, (pluginId, channel, payload) => {
        options.emit?.({ type: 'message', pluginId, channel, payload });
      });
    },
  });

  for (const builtin of options.builtins) catalog.set(builtin.id, { id: builtin.id, builtin });
  for (const folder of preferences.installed) {
    let entry: CatalogEntry;
    try {
      const pkg = readToolPluginPackage(folder);
      entry = { id: pkg.id, pkg, path: folder };
    } catch (error) {
      // The id of a package that cannot be read is unknown, so the folder stands in for it.
      entry = { id: folder, path: folder, problem: errorMessage(error) };
    }
    if (!catalog.has(entry.id)) catalog.set(entry.id, entry);
  }

  /** Reads an installed package again, so edits to its manifest show up without a restart. */
  function refresh(entry: CatalogEntry): void {
    if (!entry.path) return;
    try {
      const pkg = readToolPluginPackage(entry.path);
      if (pkg.id !== entry.id) throw new Error(`The package in this folder is now named "${pkg.id}"`);
      entry.pkg = pkg;
      delete entry.problem;
    } catch (error) {
      entry.problem = errorMessage(error);
    }
  }

  let changeScheduled = false;
  function notifyChanged(): void {
    if (changeScheduled || disposed || !options.emit) return;
    changeScheduled = true;
    queueMicrotask(() => {
      changeScheduled = false;
      if (!disposed) options.emit?.({ type: 'changed', plugins: list() });
    });
  }

  function hasHost(entry: CatalogEntry): boolean {
    if (entry.builtin) return Boolean(entry.builtin.host);
    return entry.pkg?.rows.some(row => !row.disabled) ?? false;
  }

  /** What the live fibers of a running plugin add up to. */
  function hostState(id: string): Pick<OpenDesignHostToolPlugin, 'status' | 'issue'> {
    const fibers = [...(owned.get(id) ?? [])];
    const failed = fibers.find(fiber => (fiber.state as number) === FIBER_FAILED);
    if (failed) return { status: 'failed', issue: errorMessage((failed as unknown as { _error: unknown })._error) };
    const missing = new Set<string>();
    for (const fiber of fibers) {
      if ((fiber.state as number) !== FIBER_PENDING) continue;
      const resolved = (fiber as unknown as { _store?: Record<string, unknown> })._store ?? {};
      for (const name of Object.keys(fiber.inject)) if (!resolved[name]) missing.add(name);
    }
    if (missing.size > 0) return { status: 'pending', issue: `Waiting for services Fantay does not provide: ${[...missing].join(', ')}` };
    const note = skipped.get(id);
    return note ? { status: 'pending', issue: note } : { status: 'active' };
  }

  function describe(entry: CatalogEntry): OpenDesignHostToolPlugin {
    const { id, builtin, pkg } = entry;
    const enabled = preferences.enabled.has(id);
    let state: Pick<OpenDesignHostToolPlugin, 'status' | 'issue'>;
    if (entry.problem) state = { status: 'missing', issue: entry.problem };
    else if (!enabled) state = { status: 'inactive' };
    else if (!hasHost(entry)) state = { status: 'active' };
    else if (running.has(id)) state = hostState(id);
    else state = { status: 'failed', ...(failures.has(id) ? { issue: failures.get(id)! } : {}) };
    const shortcut = builtin?.shortcut ?? pkg?.shortcut;
    return {
      id,
      enabled,
      active: state.status === 'active' || state.status === 'pending',
      source: builtin ? 'builtin' : 'installed',
      flavor: pkg?.flavor ?? 'fantay',
      client: builtin ? Boolean(builtin.client) : Boolean(pkg?.client),
      ...state,
      ...(shortcut ? { shortcut } : {}),
      ...(pkg?.version ? { version: pkg.version } : {}),
      ...(pkg?.title ? { title: pkg.title } : {}),
      ...(pkg?.description ? { description: pkg.description } : {}),
      ...(pkg?.icon ? { icon: pkg.icon } : {}),
      ...(entry.path ? { path: entry.path } : {}),
    };
  }

  function list(): OpenDesignHostToolPlugin[] {
    return [...catalog.values()].map(describe);
  }

  /** Loads the host entries of a plugin. An installed package is read again so edits take effect. */
  async function loadRows(entry: CatalogEntry): Promise<HostRow[]> {
    if (entry.builtin) {
      return entry.builtin.host ? [{ name: entry.id, plugin: entry.builtin.host, config: undefined, inject: [] }] : [];
    }
    refresh(entry);
    if (entry.problem || !entry.pkg) throw new Error(entry.problem ?? 'The plugin package cannot be read');
    const pkg = entry.pkg;
    const rows: HostRow[] = [];
    const unresolved: string[] = [];
    for (const row of pkg.rows) {
      if (row.disabled) continue;
      if (!row.entry) {
        unresolved.push(row.name);
        continue;
      }
      const stat = statSync(row.entry);
      const namespace: unknown = await import(`${pathToFileURL(row.entry).href}?rev=${stat.mtimeMs}-${stat.size}`);
      rows.push({ name: row.id, plugin: unwrapModule(namespace), config: row.config, inject: row.inject });
    }
    if (unresolved.length > 0) skipped.set(entry.id, `Host modules Fantay does not provide: ${unresolved.join(', ')}`);
    else skipped.delete(entry.id);
    return rows;
  }

  /** Waits until the plugin's fibers, including ones its entries start themselves, stop changing. */
  async function settle(id: string, fiber: Fiber): Promise<void> {
    await fiber.await().catch(() => undefined);
    for (let round = 0; round < 5; round += 1) {
      const fibers = [...(owned.get(id) ?? [])];
      await Promise.all(fibers.map(item => item.await().catch(() => undefined)));
      if ((owned.get(id)?.size ?? 0) === fibers.length) return;
    }
  }

  /** Starts the host half. Resolves null when it runs, or the reason it could not start. */
  async function start(entry: CatalogEntry): Promise<string | null> {
    const { id } = entry;
    let rows: HostRow[];
    try {
      rows = await loadRows(entry);
      if (rows.length > 0 && !entry.builtin) await webServer.ensureListening();
    } catch (error) {
      console.warn('[fantay tool plugins] Could not load', id, error);
      return errorMessage(error);
    }
    if (rows.length === 0) return null;
    const scope = root.extend({ [TOOL_PLUGIN_OWNER]: id });
    const fiber = scope.plugin({
      name: `tool-plugin:${id}`,
      apply(ctx: Context) {
        for (const row of rows) {
          // The entry's own `inject` gates the config: its `!!js` values read those services.
          ctx.plugin({
            name: row.name,
            inject: row.inject,
            apply(rowCtx: Context) {
              rowCtx.plugin(row.plugin, interpolate(row.config, rowCtx) as never);
            },
          });
        }
      },
    });
    running.set(id, fiber);
    await settle(id, fiber);
    const state = hostState(id);
    if (state.status !== 'failed') return null;
    console.warn('[fantay tool plugins] Activation failed', id, state.issue);
    await stop(id);
    return state.issue ?? 'The plugin failed to start';
  }

  async function stop(id: string): Promise<void> {
    const fiber = running.get(id);
    running.delete(id);
    skipped.delete(id);
    if (!fiber) return;
    try {
      await fiber.dispose();
    } catch (error) {
      console.warn('[fantay tool plugins] Could not stop', id, error);
    }
    owned.delete(id);
  }

  // Changes run one at a time: each reads the state the previous one left.
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(change: () => Promise<T>): Promise<T> {
    const next = queue.then(change, change);
    queue = next.catch(() => undefined);
    return next;
  }

  const ready = exclusive(async () => {
    await services.await();
    for (const entry of [...catalog.values()]) {
      if (!preferences.enabled.has(entry.id) || entry.problem || !hasHost(entry)) continue;
      const failure = await start(entry);
      if (failure) failures.set(entry.id, failure);
    }
    notifyChanged();
  });

  function save(next: Preferences): boolean {
    try {
      savePreferences(preferencesPath, next);
      preferences = next;
      return true;
    } catch (error) {
      console.warn('[fantay tool plugins] Could not save preferences', error);
      return false;
    }
  }

  return {
    /** Resolves once the plugins enabled at launch have been started. */
    ready,
    list,

    /**
     * Enabling starts the host half first and saves only when it runs; disabling saves first and then
     * stops it. A failed start or a failed save leaves the previous state in place.
     */
    setEnabled(id: unknown, nextEnabled: unknown): Promise<OpenDesignHostToolPluginChangeResult> {
      const entry = typeof id === 'string' ? catalog.get(id) : undefined;
      if (!entry || typeof nextEnabled !== 'boolean') return Promise.reject(new Error('Invalid tool plugin change'));
      return exclusive(async () => {
        const wasEnabled = preferences.enabled.has(entry.id);
        if (nextEnabled) {
          refresh(entry);
          if (entry.problem) return { ok: false, reason: 'activation-failed', message: entry.problem };
          let started = false;
          if (!running.has(entry.id) && hasHost(entry)) {
            const failure = await start(entry);
            if (failure) return { ok: false, reason: 'activation-failed', message: failure };
            started = true;
          }
          failures.delete(entry.id);
          if (!wasEnabled && !save({ ...preferences, enabled: new Set([...preferences.enabled, entry.id]) })) {
            if (started) await stop(entry.id);
            return { ok: false, reason: 'save-failed' };
          }
        } else {
          if (wasEnabled) {
            const enabled = new Set(preferences.enabled);
            enabled.delete(entry.id);
            if (!save({ ...preferences, enabled })) return { ok: false, reason: 'save-failed' };
          }
          failures.delete(entry.id);
          await stop(entry.id);
        }
        notifyChanged();
        return { ok: true, plugins: list() };
      });
    },

    /**
     * Installs a plugin package: copies the folder into Fantay's plugin folder and lists the plugin,
     * disabled. Without `folder` the user is asked for one. Installing a package that is already
     * installed replaces its files and, when it was enabled, starts the new version.
     */
    install(folder?: string): Promise<OpenDesignHostToolPluginChangeResult> {
      return exclusive(async () => {
        const chosen = folder ?? await options.pickPackageFolder?.() ?? null;
        if (!chosen) return { ok: false, reason: 'cancelled' };
        const source = resolve(chosen);
        let pkg: ToolPluginPackage;
        try {
          pkg = readToolPluginPackage(source);
        } catch (error) {
          return { ok: false, reason: 'invalid-package', message: errorMessage(error) };
        }
        const { id } = pkg;
        const existing = catalog.get(id);
        if (existing?.builtin) return { ok: false, reason: 'duplicate', message: `"${id}" is a built-in plugin` };
        const target = packageFolder(id);
        const wasEnabled = preferences.enabled.has(id);
        if (source !== target) {
          // Copy beside the target first, so a failed copy leaves the installed version untouched.
          const staging = `${target}.${randomUUID()}.installing`;
          try {
            mkdirSync(packagesRoot, { recursive: true });
            cpSync(source, staging, {
              recursive: true,
              filter: path => basename(path) !== '.git' && basename(path) !== '.DS_Store',
            });
            await stop(id);
            rmSync(target, { recursive: true, force: true });
            renameSync(staging, target);
          } catch (error) {
            rmSync(staging, { recursive: true, force: true });
            console.warn('[fantay tool plugins] Could not copy the package', id, error);
            return { ok: false, reason: 'save-failed', message: errorMessage(error) };
          }
        }
        const installed = [...preferences.installed.filter(path => path !== existing?.path && path !== target), target];
        if (!save({ ...preferences, installed })) return { ok: false, reason: 'save-failed' };
        const entry: CatalogEntry = { id, path: target };
        catalog.set(id, entry);
        refresh(entry);
        failures.delete(id);
        if (wasEnabled && !entry.problem && hasHost(entry) && !running.has(id)) {
          const failure = await start(entry);
          if (failure) failures.set(id, failure);
        }
        notifyChanged();
        return { ok: true, plugins: list() };
      });
    },

    /** Deletes an installed plugin: stops it, forgets it, and removes its files from Fantay's plugin folder. */
    uninstall(id: unknown): Promise<OpenDesignHostToolPluginChangeResult> {
      const entry = typeof id === 'string' ? catalog.get(id) : undefined;
      if (!entry?.path) return Promise.reject(new Error('Invalid tool plugin change'));
      return exclusive(async () => {
        const enabled = new Set(preferences.enabled);
        enabled.delete(entry.id);
        if (!save({ enabled, installed: preferences.installed.filter(path => path !== entry.path) })) {
          return { ok: false, reason: 'save-failed' };
        }
        await stop(entry.id);
        failures.delete(entry.id);
        catalog.delete(entry.id);
        // A folder registered from elsewhere is someone's working copy; only Fantay's own copy is removed.
        if (entry.path && isManagedFolder(entry.path)) {
          try {
            rmSync(entry.path, { recursive: true, force: true });
          } catch (error) {
            console.warn('[fantay tool plugins] Could not delete the package folder', entry.id, error);
          }
        }
        notifyChanged();
        return { ok: true, plugins: list() };
      });
    },

    /** The workspace module of an enabled installed plugin. Built-in modules ship inside the workspace. */
    clientModule(id: unknown): OpenDesignHostToolPluginClientModule | null {
      const entry = typeof id === 'string' ? catalog.get(id) : undefined;
      const client = entry?.pkg?.client;
      if (!entry || !client || entry.problem || !preferences.enabled.has(entry.id)) return null;
      try {
        const stat = statSync(client.file);
        return {
          id: entry.id,
          moduleId: client.moduleId,
          code: readFileSync(client.file, 'utf8'),
          rev: `${stat.mtimeMs}-${stat.size}`,
        };
      } catch (error) {
        console.warn('[fantay tool plugins] Could not read client module', entry.id, error);
        return null;
      }
    },

    /** Where the daemon should forward plugin routes, once a plugin has made the server listen. */
    gateway(): OpenDesignHostToolPluginGateway | null {
      const port = webServer.port;
      return port === undefined ? null : { port, token: webServer.token, prefixes: webServer.gatewayPrefixes() };
    },

    /** Runs the handler a plugin's host half registered with `ctx.bridge.handle(channel, …)`. */
    async invoke(pluginId: unknown, channel: unknown, payload: unknown): Promise<unknown> {
      if (typeof pluginId !== 'string' || typeof channel !== 'string' || !running.has(pluginId) || !bridge) {
        throw new Error('Invalid tool plugin call');
      }
      return bridge.invoke(pluginId, channel, payload);
    },

    /** Stops every plugin and releases what the host holds. Enabled preferences stay for the next launch. */
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await queue;
      await Promise.all([...running.keys()].map(stop));
      try {
        await services.dispose();
      } catch (error) {
        console.warn('[fantay tool plugins] Could not release host services', error);
      }
      await webServer.close();
    },
  };
}
