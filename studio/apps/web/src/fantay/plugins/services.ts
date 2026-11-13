// SPDX-License-Identifier: AGPL-3.0-only
// Services the workspace provides to a tool plugin's client module. A client module is a Cordis plugin,
// like its host half, and reaches these through `inject`:
//
//   return {
//     inject: ['slots', 'locale'],
//     apply(ctx) {
//       ctx.slots.register({ name: 'fantay.sidebar.nav', id: 'notes', label: () => '便签' }, NotesPage);
//     },
//   };
//
// `slots`, `locale`, `sidebarRightTabs` and `sidebarRight` carry the DeepSeek Harness client API so a
// Harness plugin's client bundle runs as it is. Every registration belongs to the calling plugin
// (`this.ctx` inside a service method is the caller's context) and is undone when the plugin is disabled.
import { Service, type Context } from '@deepseek-ai/cordis';
import type { ComponentType } from 'react';

import { pluginLanguage, pluginLanguageChain } from './plugin-text';
import { SlotStore, type SlotOptions, type SlotSpec } from './slots';

/** Context key that names the plugin a fiber belongs to. */
export const TOOL_PLUGIN_OWNER: unique symbol = Symbol.for('fantay.toolPlugin.owner');

export function toolPluginOwner(ctx: Context): string | undefined {
  const owner = (ctx as unknown as Record<symbol, unknown>)[TOOL_PLUGIN_OWNER];
  return typeof owner === 'string' ? owner : undefined;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotsService;
    locale: LocaleService;
    sidebarRightTabs: SidebarRightTabsService;
    sidebarRight: SidebarRightService;
    bridge: ClientBridgeService;
    fantay: FantayClientService;
  }
}

type Disposer = () => void;
type EffectResult = Disposer | Iterable<Disposer> | void;

/** Slot registration (`SlotStore`) on behalf of the calling plugin. */
export class SlotsService extends Service {
  constructor(ctx: Context, readonly store: SlotStore) {
    super(ctx, 'slots');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(options: SlotOptions, component: ComponentType<any>): Disposer {
    const { store } = this;
    const owner = toolPluginOwner(this.ctx);
    return this.ctx.effect(() => store.add(options, component, owner), `slots.register(${options?.name})`);
  }

  /**
   * Runs `callback` while the slot `name` is declared: at once when it already is, otherwise when its
   * declaration appears, and again after it went away and came back. What the callback returns is
   * disposed when the declaration goes away.
   */
  inject(name: string, callback: () => EffectResult): Disposer {
    const { store } = this;
    const ctx = this.ctx;
    return ctx.effect(() => {
      let active: Disposer | null = null;
      const run = (): void => {
        if (!active) active = ctx.effect(() => callback() as Disposer, `slots.inject(${name})`);
      };
      const collapse = (): void => {
        const dispose = active;
        active = null;
        dispose?.();
      };
      const unwatch = store.watch(name, { declared: run, collapsed: collapse });
      if (store.spec(name)) run();
      return () => {
        unwatch();
        collapse();
      };
    }, `slots.watch(${name})`);
  }

  declare(name: string, spec: SlotSpec): Disposer {
    const { store } = this;
    return this.ctx.effect(() => store.declare(name, spec), `slots.declare(${name})`);
  }

  spec(name: string): SlotSpec | undefined {
    return this.store.spec(name);
  }

  entriesOfSlot(name: string) {
    return this.store.entriesOfSlot(name);
  }

  subscribe(listener: () => void): Disposer {
    return this.store.subscribe(listener);
  }

  getVersion(): number {
    return this.store.getVersion();
  }
}

export type LocaleDict = Record<string, string>;

export interface LocaleSnapshot {
  /** The plugin language in use (`zh`, `en` …). */
  active: string;
  locales: string[];
  revision: number;
}

/** Plugin dictionaries, per namespace and language. The active language follows Fantay's own locale. */
export class LocaleStore {
  private readonly dicts = new Map<string, Map<string, LocaleDict>>();
  private readonly listeners = new Set<() => void>();
  private locale = 'en';
  private snapshot: LocaleSnapshot = { active: 'en', locales: [], revision: 0 };

  add(namespace: string, language: string, dict: LocaleDict): Disposer {
    const languages = this.dicts.get(namespace) ?? new Map<string, LocaleDict>();
    if (languages.has(language)) throw new Error(`locale "${namespace}" already has a "${language}" dictionary`);
    languages.set(language, dict);
    this.dicts.set(namespace, languages);
    this.changed();
    return () => {
      if (languages.get(language) !== dict) return;
      languages.delete(language);
      if (languages.size === 0) this.dicts.delete(namespace);
      this.changed();
    };
  }

  /** Fantay's locale tag changed. */
  setLocale(locale: string): void {
    if (locale === this.locale) return;
    this.locale = locale;
    this.changed();
  }

  translate(namespace: string, key: string, params?: Record<string, unknown>): string {
    const languages = pluginLanguageChain(this.locale);
    for (const scope of [namespace, 'common']) {
      const dicts = this.dicts.get(scope);
      if (!dicts) continue;
      for (const language of languages) {
        const template = dicts.get(language)?.[key];
        if (template === undefined) continue;
        return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : template;
      }
    }
    return key;
  }

  getSnapshot = (): LocaleSnapshot => this.snapshot;

  subscribe = (listener: () => void): Disposer => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private changed(): void {
    const locales = new Set<string>();
    for (const languages of this.dicts.values()) for (const language of languages.keys()) locales.add(language);
    this.snapshot = { active: pluginLanguage(this.locale), locales: [...locales], revision: this.snapshot.revision + 1 };
    for (const listener of [...this.listeners]) listener();
  }
}

export class LocaleService extends Service {
  constructor(ctx: Context, readonly store: LocaleStore) {
    super(ctx, 'locale');
  }

  /** `register(ns, { zh, en })` or `register(ns, 'zh', dict)`. */
  register(namespace: string, dicts: Record<string, LocaleDict>): Disposer;
  register(namespace: string, language: string, dict: LocaleDict): Disposer;
  register(namespace: string, second: string | Record<string, LocaleDict>, dict?: LocaleDict): Disposer {
    const { store } = this;
    const entries: [string, LocaleDict][] = typeof second === 'string' ? [[second, dict ?? {}]] : Object.entries(second);
    return this.ctx.effect(function* () {
      for (const [language, entry] of entries) yield store.add(namespace, language, entry);
    }, `locale.register(${namespace})`);
  }

  /** A translate function for one namespace: `t(key, { name })`. Read it during render to follow the language. */
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string {
    const { store } = this;
    return (key, params) => store.translate(namespace, key, params);
  }

  getLocale(): string {
    return this.store.getSnapshot().active;
  }

  getSnapshot(): LocaleSnapshot {
    return this.store.getSnapshot();
  }

  subscribe(listener: () => void): Disposer {
    return this.store.subscribe(listener);
  }
}

/** A Harness right-sidebar tab type. Fantay shows each type as a page reached from the sidebar. */
export interface SidebarRightTabDefinition {
  id: string;
  kind: string;
  multiple?: boolean;
  title(address: string): string;
  guide?: readonly {
    id: string;
    order: number;
    title(): string;
    description?(): string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    icon?: ComponentType<any>;
  }[];
  [option: string]: unknown;
}

export interface SidebarRightTab {
  definition: SidebarRightTabDefinition;
  owner?: string;
}

export class SidebarRightTabStore {
  private tabs: readonly SidebarRightTab[] = [];
  private readonly params = new Map<string, unknown>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  add(definition: SidebarRightTabDefinition, owner?: string): Disposer {
    if (!definition || typeof definition.id !== 'string' || typeof definition.kind !== 'string') {
      throw new TypeError('sidebarRightTabs.register needs an id and a kind');
    }
    if (this.tabs.some(tab => tab.definition.id === definition.id || tab.definition.kind === definition.kind)) {
      throw new Error(`sidebar tab "${definition.id}" is already registered`);
    }
    const tab: SidebarRightTab = { definition, ...(owner ? { owner } : {}) };
    this.tabs = [...this.tabs, tab];
    this.changed();
    return () => {
      this.tabs = this.tabs.filter(item => item !== tab);
      this.params.delete(definition.kind);
      this.changed();
    };
  }

  entries(): readonly SidebarRightTab[] {
    return this.tabs;
  }

  byKind(kind: string): SidebarRightTab | undefined {
    return this.tabs.find(tab => tab.definition.kind === kind);
  }

  /** The `params` of the latest `openTab` for a kind. */
  paramsOf(kind: string): unknown {
    return this.params.get(kind);
  }

  setParams(kind: string, params: unknown): void {
    this.params.set(kind, params);
    this.changed();
  }

  subscribe = (listener: () => void): Disposer => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export class SidebarRightTabsService extends Service {
  constructor(ctx: Context, readonly store: SidebarRightTabStore) {
    super(ctx, 'sidebarRightTabs');
  }

  register(definition: SidebarRightTabDefinition): Disposer {
    const { store } = this;
    const owner = toolPluginOwner(this.ctx);
    return this.ctx.effect(() => store.add(definition, owner), `sidebarRightTabs.register(${definition?.id})`);
  }

  entries(): SidebarRightTabDefinition[] {
    return this.store.entries().map(tab => tab.definition);
  }

  get(kind: string): SidebarRightTabDefinition | undefined {
    return this.store.byKind(kind)?.definition;
  }

  subscribe(listener: () => void): Disposer {
    return this.store.subscribe(listener);
  }
}

/** Opens a plugin page: `(pluginId, pageId)`. Supplied by the workspace shell. */
export type OpenPluginPage = (pluginId: string, pageId: string) => void;

/** The Harness right sidebar. In Fantay a tab is a page, so `openTab` navigates to it. */
export class SidebarRightService extends Service {
  readonly mounted = true;

  constructor(ctx: Context, private readonly tabs: SidebarRightTabStore, private readonly openPage: OpenPluginPage) {
    super(ctx, 'sidebarRight');
  }

  openTab(kind: string, options?: { params?: unknown }): void {
    const tab = this.tabs.byKind(kind);
    if (!tab?.owner) throw new Error(`sidebarRight: no tab type "${kind}"`);
    if (options && 'params' in options) this.tabs.setParams(kind, options.params);
    this.openPage(tab.owner, tab.definition.id);
  }

  isExpanded(): boolean {
    return true;
  }

  // The Harness sidebar can be resized, hidden and split; a Fantay page has none of that.
  close(): void {}
  hide(): void {}
  focus(): void {}
  toggleExpanded(): void {}
}

type BridgeListener = (payload: unknown) => void;

/** Messages between a plugin's workspace half and its host half (`ctx.bridge` in the host entry). */
export class ClientBridgeService extends Service {
  private readonly listeners = new Map<string, Map<string, Set<BridgeListener>>>();

  constructor(ctx: Context, private readonly call: (pluginId: string, channel: string, payload: unknown) => Promise<unknown>) {
    super(ctx, 'bridge');
  }

  /** Calls the handler the host half registered with `ctx.bridge.handle(channel, …)`. */
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    const owner = toolPluginOwner(this.ctx);
    if (!owner) return Promise.reject(new Error('bridge.invoke must be called by a tool plugin'));
    return this.call(owner, channel, payload);
  }

  /** Listens for `ctx.bridge.send(channel, payload)` from the host half. */
  on(channel: string, listener: BridgeListener): Disposer {
    const owner = toolPluginOwner(this.ctx);
    if (!owner) throw new Error('bridge.on must be called by a tool plugin');
    const { listeners } = this;
    return this.ctx.effect(() => {
      const channels = listeners.get(owner) ?? new Map<string, Set<BridgeListener>>();
      const set = channels.get(channel) ?? new Set<BridgeListener>();
      set.add(listener);
      channels.set(channel, set);
      listeners.set(owner, channels);
      return () => { set.delete(listener); };
    }, `bridge.on(${channel})`);
  }

  /** Called by the runtime for a message from a plugin's host half. */
  deliver(pluginId: string, channel: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(pluginId)?.get(channel) ?? [])]) listener(payload);
  }
}

export interface FantayClientShell {
  openPage: OpenPluginPage;
  /** Runs a Fantay command (`fantay.search`, `fantay.newChat` …); false when nothing handled it. */
  runCommand(command: string): boolean;
}

/** Fantay's own surface for client modules. */
export class FantayClientService extends Service {
  constructor(ctx: Context, private readonly shell: FantayClientShell) {
    super(ctx, 'fantay');
  }

  /** Opens one of the calling plugin's pages (a `fantay.sidebar.nav` entry id). */
  openPage(pageId: string): void {
    const owner = toolPluginOwner(this.ctx);
    if (!owner) throw new Error('fantay.openPage must be called by a tool plugin');
    this.shell.openPage(owner, pageId);
  }

  runCommand(command: string): boolean {
    return this.shell.runCommand(command);
  }
}
