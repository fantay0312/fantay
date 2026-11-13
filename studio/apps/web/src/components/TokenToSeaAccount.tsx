import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { TokenToSeaStatus } from '@open-design/contracts';
import { openHostExternalUrl } from '@open-design/host';
import { ArrowRight, KeyRound, LoaderCircle, LogIn, LogOut, Settings, TriangleAlert, User } from 'lucide-react';
import { Button, Icon, Input } from '../fantay/ui';
import { useI18n } from '../i18n';
import { TOKENTOSEA_SESSION_EVENT } from '../lib/tokentosea-events';
import { configureTokenToSeaClient } from '../lib/tokentosea-account';
import { usePageNavigationReady } from '../observability/navigation-timing';
import { useStartupReady } from '../observability/startup-ready';
import styles from './TokenToSeaAccount.module.css';

function notifySessionChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(TOKENTOSEA_SESSION_EVENT));
  }
}

function WelcomeReadiness({ visible, ready }: { visible: boolean; ready: boolean }) {
  useStartupReady({ visible, interactive: ready });
  usePageNavigationReady({ page: 'onboarding', visible, ready });
  return null;
}

export function TokenToSeaAccount({
  variant = 'rail',
  gateConfigReady = false,
  onOpenSettings,
  onSignedIn,
}: {
  /** `gate`: the full-width sign-in block of the welcome page. There `onSignedIn` means "enter the
   *  workspace": it fires on its own only when a sign-in started from this block completes; an account
   *  that was already signed in gets an explicit continue button instead. */
  variant?: 'rail' | 'inline' | 'gate';
  gateConfigReady?: boolean;
  onOpenSettings?: () => void;
  onSignedIn?: () => void;
}) {
  const { t, locale } = useI18n();
  const isZh = locale.startsWith('zh');
  const [status, setStatus] = useState<TokenToSeaStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const variantRef = useRef(variant);
  variantRef.current = variant;
  const loginStartedRef = useRef(false);
  const statusRequestRef = useRef(0);
  const [clientId, setClientId] = useState('');
  const [configureOpen, setConfigureOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;
  const menuId = useId();
  const signedIn = Boolean(status?.signedIn);
  const waiting = Boolean(authUrl || status?.pending);
  const showDetails = variant === 'inline' || open;

  const refresh = useCallback(async () => {
    const request = ++statusRequestRef.current;
    try {
      const res = await fetch('/api/tokentosea/status');
      if (!res.ok) return null;
      const data = (await res.json()) as TokenToSeaStatus;
      if (!data || typeof data.signedIn !== 'boolean' || request !== statusRequestRef.current) return null;
      setStatus(data);
      setClientId((prev) => prev || data.clientId || '');
      if (data.signedIn) {
        setAuthUrl(null);
        setError(null);
        notifySessionChanged();
        if (variantRef.current !== 'gate' || loginStartedRef.current) {
          loginStartedRef.current = false;
          onSignedInRef.current?.();
        }
      } else if (!data.pending && data.error) {
        // A consumed/expired authorization flow is terminal. pending:false
        // alone is not terminal: exchanging the authorization code also clears it.
        loginStartedRef.current = false;
        setAuthUrl(null);
        setError(data.error);
      }
      return data;
    } catch {
      // Network and decoding failures must not escape a polling callback.
      return null;
    } finally {
      if (request === statusRequestRef.current) setChecked(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => { statusRequestRef.current += 1; };
  }, [refresh]);

  useEffect(() => {
    if (!waiting || signedIn) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 1800);
    return () => window.clearInterval(timer);
  }, [waiting, signedIn, refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const saveConfig = async () => {
    setBusy(true);
    setError(null);
    try {
      await configureTokenToSeaClient(clientId);
      await refresh();
      setConfigureOpen(false);
      notifySessionChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('tokentosea.account.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const startLogin = async () => {
    statusRequestRef.current += 1;
    setBusy(true);
    setError(null);
    const res = await fetch('/api/tokentosea/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(clientId.trim() ? { clientId } : {}),
    }).catch(() => null);
    setBusy(false);
    const data = res
      ? ((await res.json().catch(() => null)) as { authorizeUrl?: string; error?: string } | null)
      : null;
    if (!res?.ok || !data?.authorizeUrl) {
      setError(data?.error ?? t('tokentosea.account.actionFailed'));
      if (variantRef.current !== 'gate') {
        setConfigureOpen(true);
        setOpen(true);
      }
      return;
    }
    loginStartedRef.current = true;
    setAuthUrl(data.authorizeUrl);
    setOpen(true);
    const opened = await openHostExternalUrl(data.authorizeUrl);
    if (!opened.ok) window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
  };

  const logout = async () => {
    statusRequestRef.current += 1;
    setBusy(true);
    await fetch('/api/tokentosea/logout', { method: 'POST' }).catch(() => null);
    setBusy(false);
    setAuthUrl(null);
    setOpen(false);
    await refresh();
    notifySessionChanged();
  };

  const cancelPendingLogin = () => {
    statusRequestRef.current += 1;
    loginStartedRef.current = false;
    setAuthUrl(null);
    setError(null);
    setOpen(false);
    setStatus((current: TokenToSeaStatus | null) =>
      current ? { ...current, pending: false } : current,
    );
  };

  const name = status?.user?.name || status?.user?.email || status?.user?.id || 'TokenToSea';
  const initial = (name.trim()[0] || 'T').toUpperCase();
  const signedInSubLabel = isZh ? 'TokenToSea 已登录' : 'TokenToSea signed in';
  const waitingShortLabel = isZh ? '等待授权…' : t('tokentosea.account.waiting');
  const menuHintLabel = isZh
    ? '创作文件保存在本机，分享通过 TokenToSea 发布。'
    : 'Files stay on your device; shares are published via TokenToSea.';

  const configCardNode = (
    <div className={styles.configCard}>
      <div className={styles.configHeader}>
        <span className={styles.configTitle}>{t('tokentosea.account.connectionSettings')}</span>
        <p className={styles.configHint}>
          {t('tokentosea.account.callbackLabel')}{' '}
          <code>{status?.redirectUri || 'http://127.0.0.1:47654/api/tokentosea/callback'}</code>
        </p>
      </div>
      <div className={styles.configFormRow}>
        <div className={styles.configInputWrap}>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={t('tokentosea.account.clientIdPlaceholder')}
          />
        </div>
        <Button
          size="md"
          variant="primary"
          disabled={busy || !clientId.trim()}
          onClick={() => void saveConfig()}
        >
          {t('tokentosea.account.saveConfig')}
        </Button>
      </div>
    </div>
  );

  if (variant === 'gate') {
    const checking = !checked && !status;
    const state = signedIn ? 'signed-in' : waiting ? 'waiting' : checking ? 'checking' : 'signed-out';
    const primaryLabel = signedIn
      ? (isZh ? '进入工作台' : 'Enter workspace')
      : waiting
        ? (isZh ? '等待浏览器中完成登录…' : 'Finish signing in in your browser…')
        : checking
          ? (isZh ? '正在检查登录状态…' : 'Checking sign-in…')
          : t('tokentosea.account.signIn');
    const onPrimary = () => {
      if (signedIn) {
        onSignedInRef.current?.();
        return;
      }
      void startLogin();
    };

    return (
      <div
        ref={rootRef}
        className={`fx ${styles.gateRoot}`}
        data-variant="gate"
        data-state={state}
        data-testid="tokentosea-account"
      >
        <WelcomeReadiness visible={gateConfigReady} ready={gateConfigReady && !!status && !busy && (!waiting || signedIn)} />
        {signedIn ? (
          <div className={styles.gateIdentity}>
            <span className={styles.gateAvatar} aria-hidden="true">
              {initial}
            </span>
            <span className={styles.gateIdentityCopy}>
              <span className={styles.gateIdentityName}>{name}</span>
              <span className={styles.gateIdentityMeta}>
                {status?.user?.email || signedInSubLabel}
              </span>
            </span>
            <button
              type="button"
              className={styles.gateTextButton}
              disabled={busy}
              onClick={() => void logout()}
            >
              {t('tokentosea.account.signOut')}
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className={styles.gatePrimary}
          disabled={busy || checking || (waiting && !signedIn)}
          aria-busy={(waiting && !signedIn) || checking || undefined}
          onClick={onPrimary}
        >
          {signedIn ? null : (
            <span className={styles.gatePrimaryMark} aria-hidden="true">
              <img src="/agent-icons/tokentosea.svg" alt="" width={20} height={20} draggable={false} />
            </span>
          )}
          <span className={styles.gatePrimaryLabel}>{primaryLabel}</span>
          <span className={styles.gatePrimaryTail} aria-hidden="true">
            {(waiting && !signedIn) || checking ? (
              <LoaderCircle className={styles.gateSpinner} size={18} strokeWidth={2} />
            ) : (
              <ArrowRight className={styles.gatePrimaryArrow} size={18} strokeWidth={2} />
            )}
          </span>
        </button>

        <p className={styles.gateHint} aria-live="polite">
          {waiting && !signedIn ? (
            <>
              <span>{isZh ? '浏览器没有打开？' : "Browser didn't open?"}</span>
              {authUrl ? (
                <>
                  <a className={styles.gateLink} href={authUrl} target="_blank" rel="noreferrer">
                    {isZh ? '重新打开登录页' : 'Open the sign-in page again'}
                  </a>
                  <span aria-hidden="true">·</span>
                </>
              ) : null}
              <button type="button" className={styles.gateLink} onClick={cancelPendingLogin}>
                {t('common.cancel')}
              </button>
            </>
          ) : signedIn ? (
            isZh ? '已使用 TokenToSea 账号登录。' : 'Signed in with your TokenToSea account.'
          ) : (
            isZh
              ? '将在浏览器中打开 TokenToSea，登录或注册后自动进入工作台。'
              : 'TokenToSea opens in your browser. Sign in or create an account and you go straight in.'
          )}
        </p>

        {error ? (
          <p className={styles.gateError} role="alert">
            <TriangleAlert size={15} strokeWidth={2} aria-hidden />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    );
  }

  if (variant === 'inline') {
    const statusTone = signedIn
      ? 'connected'
      : waiting
        ? 'pending'
        : status?.configured === false
          ? 'warning'
          : 'neutral';
    const statusText = signedIn
      ? signedInSubLabel
      : waiting
        ? waitingShortLabel
        : status?.configured === false
          ? t('tokentosea.account.connectionSettings')
          : t('tokentosea.account.connectRail');
    const inlineHeadline = signedIn ? name : 'TokenToSea';
    const inlineSubline = signedIn
      ? status?.user?.email || menuHintLabel
      : waiting
        ? t('tokentosea.account.waiting')
        : status?.configured === false
          ? t('tokentosea.account.clientIdNeeded')
          : menuHintLabel;

    return (
      <div
        ref={rootRef}
        className={`fx ${styles.inlineRoot}`}
        data-variant="inline"
        data-testid="tokentosea-account"
      >
        <div className={styles.inlineCard}>
          <div className={styles.inlineIdentity}>
            <span className={styles.inlineAvatar} data-tone={statusTone} aria-hidden="true">
              {signedIn ? initial : <Icon icon={waiting ? KeyRound : LogIn} size="md" />}
            </span>
            <div className={styles.inlineCopy}>
              <div className={styles.inlineTitleRow}>
                <span className={styles.inlineTitle}>{inlineHeadline}</span>
                <span className={styles.inlineBadge} data-tone={statusTone}>
                  {statusText}
                </span>
              </div>
              <span className={styles.inlineSubtitle}>{inlineSubline}</span>
            </div>
          </div>

          <div className={styles.inlineActions}>
            {signedIn ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setConfigureOpen((v) => !v)}>
                  <Icon icon={KeyRound} size="sm" />
                  {t('tokentosea.account.connectionSettings')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void logout()}>
                  <Icon icon={LogOut} size="sm" />
                  {t('tokentosea.account.signOut')}
                </Button>
              </>
            ) : waiting ? (
              <>
                <Button size="sm" variant="default" disabled>
                  {waitingShortLabel}
                </Button>
                {authUrl ? (
                  <a
                    className={styles.inlineActionLink}
                    href={authUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t('tokentosea.account.reopen')}
                  </a>
                ) : null}
                <Button size="sm" variant="ghost" onClick={cancelPendingLogin}>
                  {t('tokentosea.account.cancel')}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => setConfigureOpen((v) => !v)}>
                  <Icon icon={KeyRound} size="sm" />
                  {t('tokentosea.account.connectionSettings')}
                </Button>
                <Button
                  size="md"
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    void (status?.configured === false ? setConfigureOpen(true) : startLogin())
                  }
                >
                  <Icon icon={LogIn} size="sm" />
                  {t('tokentosea.account.signIn')}
                </Button>
              </>
            )}
          </div>
        </div>

        {(configureOpen || status?.configured === false) && configCardNode}

        {error && (
          <p className={styles.errorBanner} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-variant={variant}
      data-testid="tokentosea-account"
    >
      {signedIn ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            className="entry-nav-rail__account-btn"
            aria-label={isZh ? `${name}，TokenToSea 账号` : `${name}, TokenToSea account`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="entry-nav-rail__account-avatar" aria-hidden="true">
              {initial}
            </span>
            <span className="entry-nav-rail__account-text">
              <span className="entry-nav-rail__account-name">{name}</span>
              <span className="entry-nav-rail__account-sub">{signedInSubLabel}</span>
            </span>
          </button>
          {open && (
            <div
              id={menuId}
              className={`entry-nav-rail__account-menu ${styles.menu}`}
              role="menu"
              aria-label={isZh ? 'TokenToSea 账号菜单' : 'TokenToSea account menu'}
            >
              <div className="entry-nav-rail__account-menu-head">
                <div className="entry-nav-rail__account-menu-identity">
                  <span className="entry-nav-rail__account-avatar" aria-hidden="true">
                    {initial}
                  </span>
                  <div className="entry-nav-rail__account-menu-identity-text">
                    <div className="entry-nav-rail__account-menu-name">{name}</div>
                    {status?.user?.email && (
                      <div className="entry-nav-rail__account-menu-email">{status.user.email}</div>
                    )}
                  </div>
                </div>
                <p className={styles.menuHint}>{menuHintLabel}</p>
              </div>
              <div className="entry-nav-rail__account-menu-list">
                {onOpenSettings && (
                  <button
                    type="button"
                    className="entry-nav-rail__account-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onOpenSettings();
                    }}
                  >
                    <Icon icon={Settings} size="md" />
                    <span>{t('settings.kicker')}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="entry-nav-rail__account-menu-item"
                  role="menuitem"
                  onClick={() => setConfigureOpen((v) => !v)}
                >
                  <Icon icon={KeyRound} size="md" />
                  <span>{t('tokentosea.account.connectionSettings')}</span>
                </button>
                <button
                  type="button"
                  className="entry-nav-rail__account-menu-item entry-nav-rail__account-menu-item--danger"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void logout()}
                >
                  <Icon icon={LogOut} size="md" />
                  <span>{t('tokentosea.account.signOut')}</span>
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className={`entry-nav-rail__btn entry-nav-rail__signin ${styles.signInBtn}`}
          disabled={busy}
          onClick={() =>
            void (waiting
              ? setOpen((v) => !v)
              : status?.configured === false
                ? (setConfigureOpen(true), setOpen(true))
                : startLogin())
          }
        >
          <Icon icon={waiting ? User : LogIn} size="md" />
          <span className="entry-nav-rail__label">
            {waiting ? waitingShortLabel : t('tokentosea.account.signIn')}
          </span>
        </button>
      )}
      {showDetails && (waiting || configureOpen || (!status?.configured && open) || error) && (
        <div className={styles.details}>
          {waiting && (
            <div className={styles.railPendingRow}>
              {authUrl && (
                <a className={styles.link} href={authUrl} target="_blank" rel="noreferrer">
                  {t('tokentosea.account.reopen')}
                </a>
              )}
              <Button size="sm" variant="ghost" onClick={cancelPendingLogin}>
                {t('common.cancel')}
              </Button>
            </div>
          )}
          {(configureOpen || (!status?.configured && open)) && (
            <>
              <p className={styles.hint}>
                {t('tokentosea.account.callbackLabel')}{' '}
                <code>
                  {status?.redirectUri || 'http://127.0.0.1:47654/api/tokentosea/callback'}
                </code>
              </p>
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={t('tokentosea.account.clientIdPlaceholder')}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={busy || !clientId.trim()}
                onClick={() => void saveConfig()}
              >
                {t('tokentosea.account.saveConfig')}
              </Button>
            </>
          )}
          {error && <p className={styles.error}>{error}</p>}
        </div>
      )}
    </div>
  );
}
