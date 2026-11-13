// SPDX-License-Identifier: AGPL-3.0-only
// React bindings for the tool plugin runtime: hooks that follow the plugin list and the pages plugins
// contribute, the outlet that draws a slot, and the boundary that keeps a broken plugin component from
// taking the workspace down with it.
import { Component, useEffect, useMemo, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react';

import { useI18n } from '../../i18n';
import { navigate } from '../../router';
import { runFantayCommand, type FantayCommandId } from '../shell/commands';
import { pluginNavItems, type PluginNavItem } from './nav';
import { toolPluginRuntime, type ToolPluginRuntimeSnapshot } from './runtime';
import type { SlotEntry } from './slots';

const SERVER_SNAPSHOT: ToolPluginRuntimeSnapshot = { available: false, ready: false, loadFailed: false, plugins: [], clients: {} };

/** Boots the plugin runtime for this window and keeps its language in step with Fantay's. Mount once, in the shell. */
export function useToolPluginRuntimeBoot(): void {
  const { locale } = useI18n();
  useEffect(() => {
    toolPluginRuntime.start({
      openPage: (pluginId, pageId) => navigate({ kind: 'tool', pluginId, pageId }),
      runCommand: command => runFantayCommand(command as FantayCommandId),
    });
  }, []);
  useEffect(() => {
    toolPluginRuntime.setLocale(locale);
  }, [locale]);
}

/** The plugin list and each plugin's client state. */
export function useToolPlugins(): ToolPluginRuntimeSnapshot {
  return useSyncExternalStore(toolPluginRuntime.subscribe, toolPluginRuntime.getSnapshot, () => SERVER_SNAPSHOT);
}

/** Re-renders the caller whenever a plugin's UI contribution changes; returns a counter to key memos on. */
export function usePluginUiVersion(): number {
  return useSyncExternalStore(toolPluginRuntime.subscribe, toolPluginRuntime.getUiVersion, () => 0);
}

/** The pages plugins add to the sidebar, in order. */
export function usePluginNavItems(): PluginNavItem[] {
  const version = usePluginUiVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => pluginNavItems(toolPluginRuntime), [version]);
}

/** The entries of a slot, in render order. */
export function useSlotEntries(name: string): readonly SlotEntry[] {
  usePluginUiVersion();
  return toolPluginRuntime.slots.entriesOfSlot(name);
}

interface PluginBoundaryProps {
  /** Shown in place of the component after it throws. */
  fallback?: ReactNode;
  /** Remounts the boundary when it changes, which clears a previous failure. */
  resetKey?: string | number;
  children: ReactNode;
}

/** Contains a plugin component: a throw inside it leaves the rest of the workspace running. */
export class PluginBoundary extends Component<PluginBoundaryProps, { failedKey: string | number | undefined; failed: boolean }> {
  override state = { failedKey: undefined as string | number | undefined, failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: PluginBoundaryProps,
    state: { failedKey: string | number | undefined; failed: boolean },
  ): { failedKey: string | number | undefined; failed: boolean } | null {
    return state.failedKey === props.resetKey ? null : { failedKey: props.resetKey, failed: false };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn('[fantay tool plugins] A plugin component failed', error, info.componentStack);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback ?? null : this.props.children;
  }
}

export interface PluginSlotProps {
  /** A `list` slot name. */
  name: string;
  /** Props every entry receives. */
  props?: Record<string, unknown>;
}

/** Draws every entry of a `list` slot, each inside its own boundary. */
export function PluginSlot({ name, props }: PluginSlotProps) {
  const entries = useSlotEntries(name);
  return (
    <>
      {entries.map((entry) => {
        const Entry = entry.component;
        return (
          <PluginBoundary key={entry.uid}>
            <Entry {...props} />
          </PluginBoundary>
        );
      })}
    </>
  );
}
