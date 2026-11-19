// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import type { PaFeishuRegistration as Registration } from '@open-design/contracts';
import { useT } from '../../i18n';
import { openExternalUrl } from '../../providers/registry';
import { Button, Callout } from '../ui';
import { paErrorText } from './PaAgentModal';
import { usePa } from './pa-context';
import styles from './PaModals.module.css';

export function PaFeishuRegistration({ channelId, configured }: { channelId: string; configured: boolean }) {
  const t = useT();
  const { data: { actions } } = usePa();
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [busy, setBusy] = useState<'start' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = registration?.status;
  const waiting = status === 'starting' || status === 'waiting';

  useEffect(() => {
    if (busy || status && !waiting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const next = await actions.readFeishuRegistration(channelId, controller.signal);
        if (!controller.signal.aborted) setRegistration(next);
      } catch {
        if (!controller.signal.aborted && waiting) timer = setTimeout(() => void check(), 2000);
        return;
      }
      if (!controller.signal.aborted && waiting) timer = setTimeout(() => void check(), 1200);
    };
    timer = setTimeout(() => void check(), waiting ? 1200 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [actions, busy, channelId, status, waiting]);

  async function change(action: 'start' | 'cancel') {
    setBusy(action);
    setError(null);
    try {
      setRegistration(await (action === 'start' ? actions.startFeishuRegistration(channelId) : actions.cancelFeishuRegistration(channelId)));
    } catch (caught) {
      setError(paErrorText(caught, t));
    } finally { setBusy(null); }
  }

  if (configured && status !== 'confirmed') return null;
  const url = registration?.authorizationUrl;
  const botUrl = registration?.botUrl;
  const failure = registration?.error;
  return (
    <>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <div className={styles.rowLabel}>{t('pa.channel.newFeishuTitle')}</div>
          <div className={styles.rowHint} role="status">
            {status === 'confirmed' ? t('pa.channel.newFeishuDone')
              : status === 'starting' ? t('pa.channel.newFeishuStarting')
                : t('pa.channel.newFeishuHint')}
          </div>
        </div>
        <div className={styles.rowControl}>
          {botUrl ? <Button size="sm" onClick={() => void openExternalUrl(botUrl)}>{t('pa.channel.openFeishuBot')}</Button>
            : waiting ? <Button size="sm" loading={busy === 'cancel'} onClick={() => void change('cancel')}>{t('pa.cancel')}</Button>
              : <Button size="sm" loading={busy === 'start'} onClick={() => void change('start')}>{t('pa.channel.createFeishu')}</Button>}
        </div>
      </div>
      {waiting && url ? (
        <div className={styles.qrRow}>
          <div className={styles.qr}>
            <img
              src={`/api/pa/channels/${encodeURIComponent(channelId)}/feishu-registration/qr.png?v=${registration?.expiresAt}`}
              width={240} height={240} alt={t('pa.channel.feishuQrAlt')}
            />
          </div>
          <div className={styles.qrSide}>
            <Button size="sm" onClick={() => void openExternalUrl(url)}>{t('pa.channel.authorizeFeishu')}</Button>
          </div>
        </div>
      ) : null}
      {error || failure || status === 'expired' ? (
        <div className={styles.groupPad}>
          <Callout tone="neutral">{error ?? (failure === 'connection' ? t('pa.channel.newFeishuConnection')
            : failure === 'denied' ? t('pa.channel.newFeishuDenied')
              : status === 'expired' ? t('pa.channel.newFeishuExpired') : t('pa.channel.newFeishuFailed'))}</Callout>
        </div>
      ) : null}
    </>
  );
}
