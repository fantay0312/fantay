// SPDX-License-Identifier: AGPL-3.0-only
// Settings ▸ 账户 (spec 07 §8, amendment B8): the TokenToSea account and its models/tools in one place.
// Signed in, the account is one settings group of rows — who you are, the balance, the connection and
// sign-out — drawn here on the settings foundation. Signed out or mid-authorisation it falls back to the
// shared `TokenToSeaAccount`, which owns the OAuth sign-in flow. The catalog below is `TokenToSeaServices`
// in its `embedded` look.
import { useEffect, useId, useState } from 'react';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { openHostExternalUrl } from '@open-design/host';

import { TokenToSeaAccount } from '../../components/TokenToSeaAccount';
import { TokenToSeaServices } from '../../components/tokentosea/TokenToSeaServices';
import { useI18n } from '../../i18n';
import { TOKENTOSEA_SESSION_EVENT } from '../../lib/tokentosea-events';
import { configureTokenToSeaClient } from '../../lib/tokentosea-account';
import { AMR_CONSOLE_URL } from '../../runtime/amr-guidance';
import { Button, cn, FX, FxLegacy, Icon, Input } from '../ui';
import styles from './AccountSettingsSection.module.css';
import { useTokenToSeaSession, type TokenToSeaSession } from './use-tokentosea-session';
import { useTokenToSeaWallet } from './use-tokentosea-wallet';
import { formatDisplayBalance, useDisplayCurrency } from './display-currency';

type ReadySession = Extract<TokenToSeaSession, { phase: 'ready' }>;

export function AccountSettingsSection() {
  const { t } = useI18n();
  const accountTitleId = useId();
  const servicesTitleId = useId();
  const { session, refresh } = useTokenToSeaSession();
  const signedIn = session.phase === 'ready' && session.signedIn;

  return (
    <section
      className={cn(FX, 'settings-section', styles.root)}
      data-testid="settings-account"
      aria-label={t('fantay.account.title')}
    >
      <section className={styles.block} aria-labelledby={accountTitleId} data-testid="settings-account-tokentosea">
        <div className="section-head">
          <div>
            <h3 id={accountTitleId}>{t('fantay.account.tokentoseaTitle')}</h3>
            <p className="hint">{t('fantay.account.tokentoseaBody')}</p>
          </div>
        </div>
        {session.phase === 'loading' ? (
          <div className={cn(styles.group, styles.groupLoading)} aria-busy="true" aria-label={t('fantay.ui.loading')}>
            <span className={styles.skeletonAvatar} />
            <span className={styles.skeletonLines}><span /><span /></span>
          </div>
        ) : session.phase === 'error' ? (
          <div className={styles.group}>
            <p className={styles.error} role="alert">{t('tokentosea.services.loadFailed')}</p>
            <Button variant="ghost" size="sm" onClick={refresh}>{t('tokentosea.services.refresh')}</Button>
          </div>
        ) : signedIn ? (
          <AccountOverview key={session.user?.id} session={session as ReadySession} onChanged={refresh} />
        ) : (
          <FxLegacy>
            <TokenToSeaAccount variant="inline" onSignedIn={refresh} />
          </FxLegacy>
        )}
      </section>

      <section className={styles.block} aria-labelledby={servicesTitleId} data-testid="settings-account-services">
        <div className="section-head">
          <div>
            <h3 id={servicesTitleId}>{t('fantay.account.servicesTitle')}</h3>
            <p className="hint">{t('tokentosea.services.body')}</p>
          </div>
        </div>
        {session.phase !== 'ready' ? null : signedIn ? (
          <FxLegacy>
            <TokenToSeaServices key={session.user?.id} active variant="embedded" accountSignedIn />
          </FxLegacy>
        ) : (
          <p className={styles.signedOut} data-testid="settings-account-services-signed-out">
            {t('fantay.account.servicesSignedOut')}
          </p>
        )}
        <p className={styles.note}>{t('fantay.account.mediaLater')}</p>
      </section>
    </section>
  );
}

/** The signed-in account as one settings group: identity, balance, connection, sign-out. */
function AccountOverview({ session, onChanged }: { session: ReadySession; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const zh = locale.startsWith('zh');
  const clientInputId = useId();
  const { wallet, refresh: loadWallet } = useTokenToSeaWallet();
  const [configOpen, setConfigOpen] = useState(false);
  const [clientId, setClientId] = useState(session.clientId ?? '');
  const [busy, setBusy] = useState<'logout' | 'config' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currency = useDisplayCurrency(locale);

  const user = session.user;
  const name = user?.name || user?.email || 'TokenToSea';
  const initial = (name.trim()[0] || 'T').toUpperCase();

  useEffect(() => { setClientId(session.clientId ?? ''); }, [session.clientId]);

  const amount = wallet.state === 'ready' ? formatDisplayBalance(wallet.usd, locale, currency.quote) : null;

  const signOut = async () => {
    setBusy('logout');
    setError(null);
    const response = await fetch('/api/tokentosea/logout', { method: 'POST' }).catch(() => null);
    setBusy(null);
    if (!response?.ok) {
      setError(t('tokentosea.account.actionFailed'));
      return;
    }
    window.dispatchEvent(new Event(TOKENTOSEA_SESSION_EVENT));
    onChanged();
  };

  const saveConfig = async () => {
    setBusy('config');
    setError(null);
    try {
      await configureTokenToSeaClient(clientId);
      setConfigOpen(false);
      window.dispatchEvent(new Event(TOKENTOSEA_SESSION_EVENT));
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('tokentosea.account.actionFailed'));
    } finally {
      setBusy(null);
    }
  };

  const openConsole = () => {
    void openHostExternalUrl(AMR_CONSOLE_URL).then((opened) => {
      if (!opened.ok) window.open(AMR_CONSOLE_URL, '_blank', 'noopener,noreferrer');
    });
  };

  return (
    <div className={styles.group} data-testid="settings-account-overview">
      <div className={styles.identity}>
        <span className={styles.avatar} aria-hidden="true">{initial}</span>
        <div className={styles.identityText}>
          <span className={styles.name}>{name}</span>
          {user?.email && user.email !== name ? <span className={styles.email}>{user.email}</span> : null}
        </div>
        <span className={styles.status}>
          <span className={styles.statusDot} aria-hidden="true" />
          {zh ? '已连接' : 'Connected'}
        </span>
      </div>

      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowLabel}>{zh ? '可用余额' : 'Available balance'}</span>
          <span className={styles.rowHint}>{zh ? '调用模型和工具时按实际用量扣费。' : 'Model and tool calls are charged by usage.'}</span>
          {amount?.converted && currency.quote ? (
            <span className={styles.fxNote}>
              {zh ? '参考汇率' : 'Reference rate'} · 1 USD = {currency.quote.rate} {currency.quote.currency} ·{' '}
              <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">ExchangeRate-API</a>
            </span>
          ) : amount && currency.failed ? <span className={styles.fxNote}>{zh ? '汇率暂不可用，暂以 USD 显示。' : 'Exchange rate unavailable; showing USD.'}</span> : null}
        </div>
        <div className={styles.rowEnd}>
          {wallet.state === 'loading' ? (
            <span className={styles.amountSkeleton} aria-label={t('fantay.ui.loading')} />
          ) : wallet.state === 'ready' ? (
            <span className={styles.amount} title={`${wallet.usd} USD`} data-currency={amount?.currency} data-testid="settings-account-balance">{amount?.text}</span>
          ) : (
            <span className={styles.amountError} title={wallet.message}>{zh ? '暂时无法读取' : 'Unavailable'}</span>
          )}
          <Button
            variant="bare"
            size="icon-sm"
            aria-label={zh ? '刷新余额' : 'Refresh balance'}
            title={zh ? '刷新余额' : 'Refresh balance'}
            disabled={wallet.state === 'loading'}
            onClick={() => {
              loadWallet();
              if (wallet.state !== 'error' || currency.failed) currency.refresh();
            }}
            className={styles.refresh}
            data-loading={wallet.state === 'loading' || undefined}
          >
            <Icon icon={RefreshCw} size="sm" />
          </Button>
          <Button variant="secondary" size="sm" onClick={openConsole}>
            {zh ? '充值' : 'Top up'}
            <Icon icon={ArrowUpRight} size="sm" />
          </Button>
        </div>
      </div>

      <div className={cn(styles.row, configOpen && styles.rowOpen)}>
        <div className={styles.rowText}>
          <span className={styles.rowLabel}>{t('tokentosea.account.connectionSettings')}</span>
          <span className={styles.rowHint}>
            {zh ? '凭据只保存在本机守护进程中，不会进入浏览器或智能体。' : 'Credentials stay in the local daemon; the browser and agents never see them.'}
          </span>
        </div>
        <div className={styles.rowEnd}>
          <Button variant="ghost" size="sm" aria-expanded={configOpen} onClick={() => setConfigOpen((open) => !open)}>
            {configOpen ? (zh ? '收起' : 'Close') : (zh ? '编辑' : 'Edit')}
          </Button>
        </div>
        <div className={styles.collapse} data-open={configOpen || undefined}>
          <div className={styles.collapseInner}>
            <div className={styles.config}>
              <label htmlFor={clientInputId} className={styles.configLabel}>Client ID</label>
              <div className={styles.configForm}>
                <Input
                  id={clientInputId}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                  placeholder={t('tokentosea.account.clientIdPlaceholder')}
                  tabIndex={configOpen ? undefined : -1}
                />
                <Button
                  variant="primary"
                  size="md"
                  disabled={busy !== null || !clientId.trim() || clientId.trim() === (session.clientId ?? '')}
                  tabIndex={configOpen ? undefined : -1}
                  onClick={() => void saveConfig()}
                >
                  {t('tokentosea.account.saveConfig')}
                </Button>
              </div>
              <p className={styles.configHint}>
                {t('tokentosea.account.callbackLabel')} <code>{session.redirectUri || 'http://127.0.0.1:47654/callback'}</code>
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.rowLabel}>{t('tokentosea.account.signOut')}</span>
          <span className={styles.rowHint}>{zh ? '退出后需要重新授权，才能继续调用模型和工具。' : 'You will need to authorise again to keep using models and tools.'}</span>
        </div>
        <div className={styles.rowEnd}>
          <Button variant="ghost" size="sm" className={styles.signOut} loading={busy === 'logout'} disabled={busy !== null} onClick={() => void signOut()}>
            {t('tokentosea.account.signOut')}
          </Button>
        </div>
      </div>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
  );
}

