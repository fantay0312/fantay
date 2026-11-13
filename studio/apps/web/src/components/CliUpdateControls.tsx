import { useCallback, useEffect, useRef, useState } from 'react';
import type { CliUpdateInfo, CliUpdatesSnapshot } from '@open-design/contracts';
import { Button } from '@open-design/components';
import { useI18n } from '../i18n';
import { requestCliUpdates } from '../providers/cli-updates';
import { openExternalUrl } from '../providers/registry';
import { Icon } from './Icon';
import styles from './CliUpdateControls.module.css';

const EMPTY: CliUpdatesSnapshot = { checking: false, lastCheckedAt: null, items: [] };
const isUpdating = (item: CliUpdateInfo) => item.state === 'queued' || item.state === 'updating';

export function useCliUpdates(active: boolean, onCompleted?: () => unknown) {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef(new Set<string>());
  const completedCallback = useRef(onCompleted);
  completedCallback.current = onCompleted;
  const working = snapshot.checking || snapshot.items.some(isUpdating);

  const perform = useCallback(async (action: 'check' | 'update', agentIds?: string[], force = true) => {
    setRequesting(true); setError(null);
    try { setSnapshot(await requestCliUpdates(action, { agentIds, force })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'request-failed'); }
    finally { setRequesting(false); }
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setRequesting(true);
    requestCliUpdates('check', { force: false, signal: controller.signal }).then(setSnapshot).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'request-failed');
    }).finally(() => { if (!controller.signal.aborted) setRequesting(false); });
    return () => controller.abort();
  }, [active]);

  useEffect(() => {
    if (!active || !working) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await requestCliUpdates('status', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setError(null);
        setSnapshot(next);
        if (next.checking || next.items.some(isUpdating)) timer = setTimeout(poll, 1_000);
      } catch {
        if (!controller.signal.aborted) { setError('request-failed'); timer = setTimeout(poll, 2_000); }
      }
    };
    timer = setTimeout(poll, 750);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, working]);

  useEffect(() => {
    let changed = false;
    for (const item of snapshot.items) {
      const key = `${item.agentId}:${item.installedVersion}`;
      if (item.state === 'updated' && !completed.current.has(key)) { completed.current.add(key); changed = true; }
    }
    if (changed) void completedCallback.current?.();
  }, [snapshot]);

  return { snapshot, error, busy: requesting || working, check: () => perform('check'), update: (ids: string[]) => perform('update', ids) };
}

export type CliUpdatesController = ReturnType<typeof useCliUpdates>;

export function CliUpdateToolbar({ controller }: { controller: CliUpdatesController }) {
  const { t, locale } = useI18n();
  const { snapshot, busy } = controller;
  const error = controller.error ?? snapshot.error;
  const updatable = snapshot.items.filter(item => item.state === 'available' && item.canUpdate).map(item => item.agentId);
  return <div className={styles.toolbar}>
    <span className={styles.lastChecked} role={error ? 'alert' : 'status'}>
      {error ? t(error === 'busy' ? 'settings.cliUpdate.busy' : 'settings.cliUpdate.failed')
        : snapshot.lastCheckedAt ? t('settings.cliUpdate.lastCheck', { time: new Date(snapshot.lastCheckedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) }) : null}
    </span>
    {updatable.length > 0 && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void controller.update(updatable)}>
      <Icon name="arrow-up" size={14} />{t('settings.cliUpdate.all', { count: updatable.length })}
    </Button>}
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void controller.check()} data-testid="settings-cli-check-updates">
      <Icon name={snapshot.checking ? 'spinner' : 'refresh'} size={14} className={snapshot.checking ? 'icon-spin' : undefined} />
      {t(snapshot.checking ? 'settings.cliUpdate.checking' : 'settings.cliUpdate.check')}
    </Button>
  </div>;
}

export function CliUpdateControl({ agentId, controller }: { agentId: string; controller: CliUpdatesController }) {
  const { t } = useI18n();
  const item = controller.snapshot.items.find(entry => entry.agentId === agentId);
  if (!item) return null;
  const updating = isUpdating(item);
  const available = item.state === 'available' || (item.state === 'error' && item.reason !== 'check-failed' && !!item.latestVersion);
  const manual = !item.canUpdate;
  const message = item.reason === 'app-managed' ? t('settings.cliUpdate.appManaged')
    : item.state === 'error' ? t(item.reason === 'busy' ? 'settings.cliUpdate.busy' : item.reason === 'verification-failed' ? 'settings.cliUpdate.unverified' : 'settings.cliUpdate.failed')
    : item.state === 'updated' ? t('settings.cliUpdate.updated', { version: item.installedVersion ?? '' })
    : item.state === 'current' ? t('settings.cliUpdate.current')
    : item.state === 'queued' ? t('settings.cliUpdate.queued')
    : item.state === 'updating' ? t(item.phase === 'verifying' ? 'settings.cliUpdate.verifying' : 'settings.cliUpdate.updating')
    : available ? t('settings.cliUpdate.available', { version: item.latestVersion ?? '' })
    : manual ? t('settings.cliUpdate.manual') : t('settings.cliUpdate.unknown');
  return <div className={styles.control} data-testid={`settings-cli-update-${agentId}`}>
    <span className={styles.status} role={item.state === 'error' ? 'alert' : 'status'} title={item.sourceUrl}>
      {updating && <Icon name="spinner" size={12} className="icon-spin" />}
      {message}
    </span>
    {available && !manual && <Button size="sm" variant="secondary" disabled={controller.busy} onClick={() => void controller.update([agentId])}>
      <Icon name="arrow-up" size={13} />{t(item.state === 'error' ? 'settings.cliUpdate.retry' : 'settings.cliUpdate.update')}
    </Button>}
    {manual && item.sourceUrl && <Button size="sm" variant="ghost" onClick={() => void openExternalUrl(item.sourceUrl!)}>
      {t('settings.cliUpdate.openOfficial')}<Icon name="external-link" size={12} />
    </Button>}
  </div>;
}
