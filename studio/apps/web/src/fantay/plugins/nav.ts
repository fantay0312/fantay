// SPDX-License-Identifier: AGPL-3.0-only
// The pages tool plugins add to the Fantay sidebar. Two kinds of contribution become a page:
// - a `fantay.sidebar.nav` slot entry: the entry's component is the page;
// - a DeepSeek Harness right-sidebar tab type: its `sidebar.right.pane.tab` body is the page.
import type { ComponentType } from 'react';

import type { ToolPluginRuntime } from './runtime';
import type { SidebarRightTab } from './services';
import type { SlotEntry } from './slots';

export interface PluginNavItem {
  pluginId: string;
  pageId: string;
  order: number;
  title: string;
  /** A component that draws the sidebar glyph; it receives `size`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?: ComponentType<any>;
  /** The page body. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  /** Set when the page is a Harness tab; the body then gets the tab props. */
  tab?: SidebarRightTab;
}

function text(value: unknown): string | undefined {
  try {
    const resolved: unknown = typeof value === 'function' ? (value as () => unknown)() : value;
    return typeof resolved === 'string' && resolved ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isComponent(value: unknown): value is ComponentType<unknown> {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value);
}

function fromEntry(entry: SlotEntry): PluginNavItem | null {
  const pageId = entry.options.id;
  if (!entry.owner || typeof pageId !== 'string') return null;
  return {
    pluginId: entry.owner,
    pageId,
    order: entry.options.order ?? 0,
    title: text(entry.options.label) ?? pageId,
    component: entry.component,
    ...(isComponent(entry.options.icon) ? { icon: entry.options.icon } : {}),
  };
}

function fromTab(tab: SidebarRightTab, bodies: readonly SlotEntry[]): PluginNavItem | null {
  const { definition, owner } = tab;
  const body = bodies.find(entry => entry.options.key === definition.id);
  if (!owner || !body) return null;
  const guide = definition.guide?.[0];
  return {
    pluginId: owner,
    pageId: definition.id,
    order: guide?.order ?? 0,
    title: text(guide?.title) ?? text(() => definition.title('')) ?? definition.id,
    component: body.component,
    tab,
    ...(isComponent(guide?.icon) ? { icon: guide.icon } : {}),
  };
}

/** Every plugin page, in sidebar order. */
export function pluginNavItems(runtime: ToolPluginRuntime): PluginNavItem[] {
  const bodies = runtime.slots.entriesOfSlot('sidebar.right.pane.tab');
  const items = [
    ...runtime.slots.entriesOfSlot('fantay.sidebar.nav').map(fromEntry),
    ...runtime.tabs.entries().map(tab => fromTab(tab, bodies)),
  ].filter((item): item is PluginNavItem => item !== null);
  return items.sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
}
