// SPDX-License-Identifier: AGPL-3.0-only
// The page of a tool plugin, at /tools/<pluginId>/<pageId>. It draws the component the plugin
// registered for that page in the shell's main column. A DeepSeek Harness tab body gets the props the
// Harness right sidebar would hand it.
import type { ReactNode } from 'react';

import { useT } from '../../i18n';
import { usePageNavigationReady } from '../../observability/navigation-timing';
import { navigate } from '../../router';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { cn } from '../ui/cn';
import { Spinner } from '../ui/spinner';
import { harnessSessionProps } from './harness-session';
import { harnessSurfaceClass } from './HarnessSlots';
import type { PluginNavItem } from './nav';
import { PluginBoundary, usePluginNavItems, usePluginUiVersion, useToolPlugins } from './react';
import { toolPluginRuntime } from './runtime';

const NEVER_ABORTED = new AbortController().signal;
// A plugin page stands on its own, outside any conversation, so no session is bound to it.
const PAGE_SESSION_PROPS = harnessSessionProps(undefined);
const tabInfoHooks = new Map<string, () => unknown>();

/** The `useTabInfo` hook of one Harness tab kind. The identity is stable, as a hook's has to be. */
function tabInfoHook(item: PluginNavItem): () => unknown {
  const { kind, id } = item.tab!.definition;
  let hook = tabInfoHooks.get(kind);
  if (!hook) {
    const address = `sidebar://${kind}`;
    hook = function useTabInfo() {
      const revision = usePluginUiVersion();
      return {
        sidebar: { expanded: true, fullscreen: true },
        panel: { id: 'fantay', isFloating: false },
        tab: {
          id,
          kind,
          address,
          visible: true,
          navigation: { address, params: toolPluginRuntime.tabs.paramsOf(kind), revision },
          signal: NEVER_ABORTED,
          actions: {
            bindCommands: () => () => {},
            openResource: () => {},
            openTab: () => {},
            close: () => navigate({ kind: 'home', view: 'home' }),
          },
        },
      };
    };
    tabInfoHooks.set(kind, hook);
  }
  return hook;
}

function PageBody({ item }: { item: PluginNavItem }) {
  const Body = item.component;
  if (!item.tab) return <Body pluginId={item.pluginId} pageId={item.pageId} />;
  return <Body {...PAGE_SESSION_PROPS} useTabInfo={tabInfoHook(item)} />;
}

export function PluginPage({ pluginId, pageId }: { pluginId: string; pageId: string }) {
  const t = useT();
  const { available, ready, plugins, clients } = useToolPlugins();
  const item = usePluginNavItems().find(candidate => candidate.pluginId === pluginId && candidate.pageId === pageId);
  const plugin = plugins.find(candidate => candidate.id === pluginId);
  const client = clients[pluginId];
  // Until the list arrives, and while an enabled plugin's module is still on its way, the page is loading rather than missing.
  const loading = !item && available
    && (!ready || client?.status === 'loading' || Boolean(plugin?.enabled && plugin.client && !client));
  usePageNavigationReady({ page: 'tool', visible: true, ready: !loading, scopeKey: `${pluginId}/${pageId}` });

  if (item) {
    return (
      <div
        className={cn('fx flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-paper text-ink', item.tab && harnessSurfaceClass)}
        data-testid="tool-plugin-page"
        data-plugin={pluginId}
      >
        <PluginBoundary
          resetKey={`${pluginId}/${pageId}`}
          fallback={<PageNotice title={t('toolPlugins.pageError')} />}
        >
          <PageBody item={item} />
        </PluginBoundary>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="fx flex h-full items-center justify-center bg-paper">
        <Spinner size="md" label={t('common.loading')} />
      </div>
    );
  }
  return (
    <PageNotice
      title={t('toolPlugins.pageUnavailable')}
      action={(
        <Button variant="secondary" size="md" onClick={() => navigate({ kind: 'home', view: 'plugins' })}>
          {t('entry.navPlugins')}
        </Button>
      )}
    />
  );
}

function PageNotice({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="fx flex h-full items-center justify-center bg-paper p-6" data-testid="tool-plugin-page-notice">
      <EmptyState variant="dashed" title={title} action={action} />
    </div>
  );
}
