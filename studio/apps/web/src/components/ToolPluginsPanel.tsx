import { useId, useState } from 'react';
import { Plus, Puzzle, Search, Wrench, type LucideIcon } from 'lucide-react';
import type { OpenDesignHostToolPlugin, OpenDesignHostToolPluginChangeResult } from '@open-design/host';

import { resolvePluginText } from '../fantay/plugins/plugin-text';
import { useToolPlugins } from '../fantay/plugins/react';
import { toolPluginRuntime, type ToolPluginClientState } from '../fantay/plugins/runtime';
import { Button } from '../fantay/ui/button';
import { ConfirmDialog } from '../fantay/ui/dialog';
import { Switch } from '../fantay/ui/switch';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/types';
import { usePageNavigationReady } from '../observability/navigation-timing';
import styles from './ToolPluginsPanel.module.css';

type MessageKey = keyof Dict & `toolPlugins.${string}`;

/** A sentence for the user, and the host's untranslated diagnostic when there is one. */
interface Issue {
  message: MessageKey;
  detail?: string;
}

/** Name, description and icon of the plugins that ship with Fantay; installed plugins bring their own. */
const BUILTIN: Record<string, { name: MessageKey; description: MessageKey; icon: LucideIcon }> = {
  'quick-search': { name: 'toolPlugins.searchName', description: 'toolPlugins.searchDescription', icon: Search },
  toolbox: { name: 'toolPlugins.toolboxName', description: 'toolPlugins.toolboxDescription', icon: Wrench },
};

function changeIssue(plugin: OpenDesignHostToolPlugin | undefined, result: OpenDesignHostToolPluginChangeResult): Issue | null {
  if (result.ok || result.reason === 'cancelled') return null;
  const detail = result.message ? { detail: result.message } : {};
  switch (result.reason) {
    case 'activation-failed':
      // Quick search has one way to fail, and its message says what to do about it.
      return plugin?.id === 'quick-search' ? { message: 'toolPlugins.activationError' } : { message: 'toolPlugins.startError', ...detail };
    case 'invalid-package':
      return { message: 'toolPlugins.invalidPackage', ...detail };
    case 'duplicate':
      return { message: 'toolPlugins.duplicate', ...detail };
    default:
      return { message: 'toolPlugins.saveError' };
  }
}

/** What is wrong with an enabled plugin right now, host half first. */
function standingIssue(plugin: OpenDesignHostToolPlugin, client: ToolPluginClientState | undefined): Issue | null {
  const detail = plugin.issue ? { detail: plugin.issue } : {};
  if (plugin.status === 'missing') return { message: 'toolPlugins.missing', ...detail };
  if (!plugin.enabled) return null;
  if (plugin.status === 'failed' || (plugin.status === undefined && !plugin.active)) {
    return plugin.id === 'quick-search' ? { message: 'toolPlugins.activationError' } : { message: 'toolPlugins.startError', ...detail };
  }
  if (client?.status === 'failed') return { message: 'toolPlugins.startError', ...(client.issue ? { detail: client.issue } : {}) };
  if (plugin.status === 'pending') return { message: 'toolPlugins.pendingServices', ...detail };
  if (client?.status === 'pending') return { message: 'toolPlugins.pendingServices', ...(client.issue ? { detail: client.issue } : {}) };
  return null;
}

/** The name a plugin goes by in the list: Fantay's own copy for built-ins, the package's for the rest. */
function pluginName(plugin: OpenDesignHostToolPlugin, t: (key: MessageKey) => string, locale: string): string {
  const builtin = plugin.source === 'installed' ? undefined : BUILTIN[plugin.id];
  return builtin ? t(builtin.name) : resolvePluginText(plugin.title, locale) ?? plugin.id;
}

function ToolPluginRow({ plugin, client, pending, error, onChange, onDelete }: {
  plugin: OpenDesignHostToolPlugin;
  client: ToolPluginClientState | undefined;
  pending: boolean;
  error: Issue | null;
  onChange: (enabled: boolean) => void;
  /** Present for installed plugins; built-in ones can only be switched off. */
  onDelete: (() => void) | null;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const builtin = plugin.source === 'installed' ? undefined : BUILTIN[plugin.id];
  const Icon = builtin?.icon ?? Puzzle;
  const name = pluginName(plugin, t, locale);
  const description = builtin ? t(builtin.description) : resolvePluginText(plugin.description, locale);
  const issue = error ?? standingIssue(plugin, client);
  const describedBy = [description && `${id}-description`, issue && `${id}-issue`].filter(Boolean).join(' ') || undefined;
  return (
    <li className={styles.row} data-testid="tool-plugin-row" data-plugin={plugin.id}>
      <span className={styles.icon} aria-hidden="true">
        {plugin.icon ? <img src={plugin.icon} alt="" /> : <Icon size={18} />}
      </span>
      <div className={styles.copy}>
        <div className={styles.heading}>
          <label id={`${id}-name`} htmlFor={id}>{name}</label>
          {plugin.source === 'builtin' ? <span className={styles.tag}>{t('toolPlugins.builtin')}</span> : null}
          {plugin.flavor === 'dsh' ? <span className={styles.tag}>DeepSeek Harness</span> : null}
          {plugin.version ? <span className={styles.tag}>v{plugin.version}</span> : null}
        </div>
        {description ? <p id={`${id}-description`}>{description}</p> : null}
        {issue ? (
          <div id={`${id}-issue`} role="status">
            <p className={styles.issue}>{t(issue.message)}</p>
            {issue.detail ? <p className={styles.detail}>{issue.detail}</p> : null}
          </div>
        ) : null}
      </div>
      <div className={styles.controls}>
        {plugin.shortcut ? <kbd>{plugin.shortcut}</kbd> : null}
        {onDelete ? (
          <Button variant="bare" size="sm" disabled={pending} onClick={onDelete} data-testid="tool-plugin-delete">
            {t('common.delete')}
          </Button>
        ) : null}
        <Switch
          id={id}
          aria-labelledby={`${id}-name`}
          aria-describedby={describedBy}
          checked={plugin.enabled}
          disabled={pending || plugin.status === 'missing'}
          onCheckedChange={onChange}
        />
      </div>
    </li>
  );
}

export function ToolPluginsPanel() {
  const { t, locale } = useI18n();
  const { available, ready, loadFailed, plugins, clients } = useToolPlugins();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ id: string | null; issue: Issue } | null>(null);
  /** The plugin waiting for the user to confirm its deletion. */
  const [deleting, setDeleting] = useState<OpenDesignHostToolPlugin | null>(null);

  usePageNavigationReady({ page: 'plugins', visible: true, ready: !available || ready, failure: loadFailed });

  /** Runs one change at a time and shows what went wrong next to `id` (null: next to the add row). */
  async function change(id: string | null, run: () => Promise<OpenDesignHostToolPluginChangeResult | null>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await run();
      const issue = result ? changeIssue(plugins.find(plugin => plugin.id === id), result) : null;
      if (issue) setError({ id, issue });
    } catch {
      setError({ id, issue: { message: 'toolPlugins.saveError' } });
    } finally {
      setPending(false);
    }
  }

  if (!available) return <p className={styles.status}>{t('toolPlugins.desktopOnly')}</p>;
  if (loadFailed && !ready) return (
    <div className={styles.status} role="status">
      <span>{t('toolPlugins.loadError')}</span>
      <button type="button" className="plugin-marketplace__manage" onClick={() => { void toolPluginRuntime.refresh(); }}>
        {t('settings.updateRetry')}
      </button>
    </div>
  );
  if (!ready) return <p className={styles.status} role="status">{t('common.loading')}</p>;

  const canInstall = plugins.some(plugin => plugin.source !== undefined);
  return (
    <div data-testid="tool-plugins-panel">
      <ul className={styles.list} aria-label={t('toolPlugins.tab')}>
        {plugins.map(plugin => (
          <ToolPluginRow
            key={plugin.id}
            plugin={plugin}
            client={clients[plugin.id]}
            pending={pending}
            error={error?.id === plugin.id ? error.issue : null}
            onChange={(enabled) => { void change(plugin.id, () => toolPluginRuntime.setEnabled(plugin.id, enabled)); }}
            onDelete={plugin.source === 'installed' ? () => setDeleting(plugin) : null}
          />
        ))}
      </ul>
      {canInstall ? (
        <>
          <button
            type="button"
            className={styles.add}
            disabled={pending}
            data-testid="tool-plugin-install"
            onClick={() => { void change(null, () => toolPluginRuntime.install()); }}
          >
            <Plus size={15} aria-hidden="true" />
            {t('toolPlugins.install')}
          </button>
          {error?.id === null ? (
            <div role="status">
              <p className={styles.addError}>{t(error.issue.message)}</p>
              {error.issue.detail ? <p className={styles.addError}>{error.issue.detail}</p> : null}
            </div>
          ) : null}
        </>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={deleting ? t('toolPlugins.deleteTitle', { name: pluginName(deleting, t, locale) }) : ''}
        description={t('toolPlugins.deleteBody')}
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={() => {
          const target = deleting;
          if (target) void change(target.id, () => toolPluginRuntime.uninstall(target.id));
        }}
      />
    </div>
  );
}
