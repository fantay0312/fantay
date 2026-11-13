// SPDX-License-Identifier: AGPL-3.0-only
// Slot store for tool plugins. A slot is a named place in the Fantay UI; a plugin registers a React
// component into it, and Fantay renders whatever is registered. The model follows the DeepSeek Harness
// slot registry, so a Harness client plugin registers here unchanged:
// - a slot has to be declared before anything registers into it;
// - `single` holds one entry, `keyed` entries are picked by `key`, `list` and `hoc` entries carry an
//   `id` and are ordered by `priority` then `order`, `chain` entries carry a `select` function;
// - an entry may declare child slots (`children`), which exist for as long as the entry does.
import type { ComponentType } from 'react';

export type SlotKind = 'single' | 'keyed' | 'list' | 'hoc' | 'chain';

export interface SlotSpec {
  kind: SlotKind;
  scope?: string;
}

export interface SlotOptions {
  name: string;
  key?: string;
  id?: string;
  order?: number;
  priority?: number;
  label?: string | (() => string);
  children?: Record<string, SlotSpec>;
  [option: string]: unknown;
}

export interface SlotEntry {
  uid: number;
  name: string;
  options: SlotOptions;
  // Slot props differ per slot; each outlet decides what it passes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  /** The plugin that registered the entry; absent for Fantay's own entries. */
  owner?: string;
}

interface SlotWatcher {
  declared(): void;
  collapsed(): void;
}

function compareEntries(left: SlotEntry, right: SlotEntry): number {
  return (left.options.priority ?? 0) - (right.options.priority ?? 0)
    || (left.options.order ?? 0) - (right.options.order ?? 0)
    || left.uid - right.uid;
}

export class SlotStore {
  private readonly specs = new Map<string, SlotSpec>();
  private readonly entries = new Map<string, SlotEntry[]>();
  private readonly watchers = new Map<string, Set<SlotWatcher>>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private nextUid = 1;

  /** Declares a slot and returns the function that takes the declaration back. */
  declare(name: string, spec: SlotSpec): () => void {
    if (this.specs.has(name)) throw new Error(`slot "${name}" is already declared`);
    this.specs.set(name, spec);
    this.changed();
    for (const watcher of [...(this.watchers.get(name) ?? [])]) watcher.declared();
    return () => {
      if (this.specs.get(name) !== spec) return;
      for (const watcher of [...(this.watchers.get(name) ?? [])]) watcher.collapsed();
      this.specs.delete(name);
      this.changed();
    };
  }

  spec(name: string): SlotSpec | undefined {
    return this.specs.get(name);
  }

  /** Calls `declared` whenever the slot comes to exist and `collapsed` when its declaration goes away. */
  watch(name: string, watcher: SlotWatcher): () => void {
    const watchers = this.watchers.get(name) ?? new Set<SlotWatcher>();
    watchers.add(watcher);
    this.watchers.set(name, watchers);
    return () => {
      watchers.delete(watcher);
      if (watchers.size === 0) this.watchers.delete(name);
    };
  }

  /** Adds an entry and returns its remover. Throws when the slot is undeclared or the options do not fit its kind. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  add(options: SlotOptions, component: ComponentType<any>, owner?: string): () => void {
    const name = options?.name;
    const spec = typeof name === 'string' ? this.specs.get(name) : undefined;
    if (!spec) throw new Error(`slot "${String(name)}" is not declared`);
    if (spec.kind === 'keyed' && typeof options.key !== 'string') throw new Error(`slot "${name}" needs a key`);
    if ((spec.kind === 'list' || spec.kind === 'hoc') && typeof options.id !== 'string') throw new Error(`slot "${name}" needs an id`);
    if (spec.kind === 'chain' && typeof options.select !== 'function') throw new Error(`slot "${name}" needs a select function`);
    const current = this.entries.get(name) ?? [];
    if (spec.kind === 'single' && current.some(entry => (entry.options.priority ?? 0) === (options.priority ?? 0))) {
      throw new Error(`slot "${name}" already has an entry`);
    }
    const entry: SlotEntry = { uid: this.nextUid++, name, options, component, ...(owner ? { owner } : {}) };
    const undeclare: (() => void)[] = [];
    try {
      for (const [child, childSpec] of Object.entries(options.children ?? {})) undeclare.push(this.declare(child, childSpec));
    } catch (error) {
      for (const undo of undeclare) undo();
      throw error;
    }
    this.entries.set(name, [...current, entry].sort(compareEntries));
    this.changed();
    return () => {
      const list = this.entries.get(name);
      if (!list?.includes(entry)) return;
      for (const undo of undeclare.reverse()) undo();
      const next = list.filter(item => item !== entry);
      if (next.length > 0) this.entries.set(name, next);
      else this.entries.delete(name);
      this.changed();
    };
  }

  /** The slot's entries in render order. The array is stable until the slot changes. */
  entriesOfSlot(name: string): readonly SlotEntry[] {
    return this.entries.get(name) ?? EMPTY;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

const EMPTY: readonly SlotEntry[] = Object.freeze([]);
