import { usePageNavigationReady } from '../observability/navigation-timing';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AppConfig } from '../types';
import { useAnalytics } from '../analytics/provider';
import {
  trackIntegrationsConnectorsTabClick,
  trackPageView,
  trackSettingsConnectorAuthResult,
} from '../analytics/events';
import { ConnectorSection } from './SettingsDialog';
import { FantayMcpConnector } from './FantayMcpConnector';
import { McpClientSection } from './McpClientSection';
import { SkillsSection } from './SkillsSection';
import { UseEverywhereGuidePanel } from './UseEverywhereModal';
import { useT } from '../i18n';

export type IntegrationTab = 'mcp' | 'connectors' | 'skills' | 'use-everywhere';

interface Props {
  config: AppConfig;
  /** The 插件 page's switch owns the tab; this view renders the surface it picked. */
  tab?: IntegrationTab;
  onTabChange?: (tab: IntegrationTab) => void;
  composioConfigLoading?: boolean;
  onConfigPersist: (config: AppConfig) => Promise<void> | void;
  onPersistComposioKey: (composio: AppConfig['composio']) => Promise<void> | void;
  onSkillsRefresh?: () => Promise<void> | void;
  onSkillsChanged?: (affectedSkillId?: string) => void;
}

export function IntegrationsView({
  config,
  tab: activeTab = 'mcp',
  onTabChange,
  composioConfigLoading = false,
  onConfigPersist,
  onPersistComposioKey,
  onSkillsRefresh,
  onSkillsChanged,
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  const integrationsPageViewFiredRef = useRef(false);
  useEffect(() => {
    if (integrationsPageViewFiredRef.current) return;
    integrationsPageViewFiredRef.current = true;
    trackPageView(analytics.track, { page_name: 'integrations' });
  }, [analytics.track]);
  usePageNavigationReady({ page: 'integrations', visible: true, ready: activeTab === 'use-everywhere' || (activeTab === 'connectors' && !composioConfigLoading) });
  const [localConfig, setLocalConfig] = useState<AppConfig>(config);
  const localConfigRef = useRef(localConfig);

  useEffect(() => {
    setLocalConfig((current) => {
      const pendingComposioKey = current.composio?.apiKey ?? '';
      const reconciled = pendingComposioKey.trim()
        ? {
            ...config,
            composio: {
              ...(config.composio ?? {}),
              apiKey: pendingComposioKey,
            },
          }
        : config;
      localConfigRef.current = reconciled;
      return reconciled;
    });
  }, [config]);

  const updateLocalDraft = useCallback<Dispatch<SetStateAction<AppConfig>>>((nextConfig) => {
    const base = localConfigRef.current;
    const resolved =
      typeof nextConfig === 'function'
        ? (nextConfig as (current: AppConfig) => AppConfig)(base)
        : nextConfig;
    localConfigRef.current = resolved;
    setLocalConfig(resolved);
  }, []);

  const updateLocalConfig = useCallback<Dispatch<SetStateAction<AppConfig>>>(
    (nextConfig) => {
      const base = localConfigRef.current;
      const resolved =
        typeof nextConfig === 'function'
          ? (nextConfig as (current: AppConfig) => AppConfig)(base)
          : nextConfig;
      localConfigRef.current = resolved;
      setLocalConfig(resolved);
      void onConfigPersist(resolved);
    },
    [onConfigPersist],
  );

  const liveDaemonUrl =
    typeof window !== 'undefined' ? window.location.origin : undefined;

  return (
    <section className="integrations-view" aria-label={t('integrations.areasAria')}>
      <div className="integrations-view__panel">
        {activeTab === 'mcp' ? <McpClientSection navigationPage="integrations" /> : null}

        {activeTab === 'connectors' ? <FantayMcpConnector /> : null}
        {activeTab === 'connectors' ? (
          <ConnectorSection
            cfg={localConfig}
            setCfg={updateLocalDraft}
            composioConfigLoading={composioConfigLoading}
            onPersistComposioKey={onPersistComposioKey}
            onConnectorsTabClick={(element) =>
              trackIntegrationsConnectorsTabClick(analytics.track, {
                page_name: 'integrations',
                area: 'connectors_tab',
                element,
              })
            }
            onConnectorAuthResult={({ connectorId, action, result, errorCode }) =>
              trackSettingsConnectorAuthResult(analytics.track, {
                page_name: 'settings',
                area: 'connectors',
                connector_id: connectorId,
                action,
                result,
                ...(errorCode ? { error_code: errorCode } : {}),
              })
            }
          />
        ) : null}

        {activeTab === 'skills' ? (
          <SkillsSection
            cfg={localConfig}
            setCfg={updateLocalConfig}
            onSkillsRefresh={onSkillsRefresh}
            onSkillsChanged={onSkillsChanged}
          />
        ) : null}

        {activeTab === 'use-everywhere' ? (
          <div className="integrations-view__use-everywhere">
            <UseEverywhereGuidePanel
              onOpenSettings={() => onTabChange?.('mcp')}
              {...(liveDaemonUrl ? { daemonUrl: liveDaemonUrl } : {})}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
