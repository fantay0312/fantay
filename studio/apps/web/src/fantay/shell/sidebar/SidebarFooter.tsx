// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's account dock (spec 02 §11.3 with amendments B6, B8 and plans R9/R18):
// - the one persistent `#workspace-chrome-account-actions` host — upstream's EntryTopRightCluster resolves it
//   once in a layout effect and portals the updater into it, so FantayShell renders this
//   dock unconditionally and in the same tree position in every sidebar mode (expanded, rail, overlay);
// - the identity row: the account face opens the account menu and the settings gear opens Settings.
//   The menu reads top to bottom: who is signed in; the wallet balance (a button → Settings ▸ 账户,
//   where top-up lives) beside the light/dark switch, one matched pair with no label; then 个人资料 →
//   Settings ▸ 账户, 设置, and 退出 TokenToSea 登录.
//   Diagnostics export lives in Settings ▸ 隐私, not here.
// TokenToSeaAccount is not rendered here (B8): the account section in Settings owns it.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { ChevronRight, LogIn, LogOut, RotateCw, Settings, UserRound, X, type LucideIcon } from 'lucide-react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { openHostExternalUrl } from '@open-design/host';

import type { SettingsSection } from '../../../components/SettingsDialog';
import { WORKSPACE_CHROME_ACCOUNT_ACTIONS_ID } from '../../../components/workspaceChromeActions';
import { useI18n, useT } from '../../../i18n';
import { formatDisplayBalance, useDisplayCurrency } from '../../account/display-currency';
import { TOKENTOSEA_SESSION_CHANGED_EVENT, useTokenToSeaSession } from '../../account/use-tokentosea-session';
import { useTokenToSeaWallet } from '../../account/use-tokentosea-wallet';
import { ThemeSegmented } from '../../theme/ThemeSegmented';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Dot } from '../../ui/dot';
import { IconButton } from '../../ui/icon-button';
import { FeatureIcon } from '../../ui/feature-icon';
import { Icon } from '../../ui/icons';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { skeletonVariants } from '../../ui/skeleton';
import type { FantaySidebarMode } from '../geometry';
import styles from './Sidebar.module.css';

export interface SidebarFooterProps {
  mode: FantaySidebarMode;
  collapsed: boolean;
  workspaceContext: WorkspaceCollabContext | null;
  onOpenSettings(section?: SettingsSection): void;
}

export function SidebarFooter({ mode, collapsed, workspaceContext, onOpenSettings }: SidebarFooterProps) {
  const t = useT();
  const identityRef = useRef<HTMLDivElement>(null);
  return (
    <>
      {/* Upstream markup lands here; not under `.fx`, and marked legacy so the scoped preflight never applies. */}
      <div
        id={WORKSPACE_CHROME_ACCOUNT_ACTIONS_ID}
        data-fx-legacy=""
        className={styles.accountActionsHost}
        data-testid="fantay-sidebar-account-actions"
      />
      <div ref={identityRef} className={cn('fx', styles.identity)}>
        <SidebarAccountMenu
          mode={mode}
          collapsed={collapsed}
          workspaceContext={workspaceContext}
          identityRef={identityRef}
          onOpenSettings={onOpenSettings}
        />
        <IconButton
          size={collapsed && mode === 'docked' ? 'md' : 'sm'}
          aria-label={t('entry.accountSettings')}
          tooltipSide={collapsed && mode === 'docked' ? 'right' : 'top'}
          data-testid="fantay-sidebar-settings"
          className="flex-none"
          onClick={() => onOpenSettings()}
        >
          <FeatureIcon name="settings" size={20} />
        </IconButton>
      </div>
    </>
  );
}

interface SidebarAccountMenuProps {
  mode: FantaySidebarMode;
  collapsed: boolean;
  workspaceContext: WorkspaceCollabContext | null;
  /** The whole identity row (account face + settings gear): the expanded sidebar's menu takes its width. */
  identityRef: RefObject<HTMLDivElement>;
  onOpenSettings(section?: SettingsSection): void;
}

function AccountFace({ name, signedIn }: { name: string; signedIn: boolean }) {
  if (!signedIn) {
    return (
      <span className="grid size-6 flex-none place-items-center rounded-full bg-paper-deep text-ink-soft" aria-hidden>
        <Icon icon={UserRound} size={14} />
      </span>
    );
  }
  return <Avatar name={name} size={24} tone="ink" aria-hidden />;
}

function SidebarAccountMenu({
  mode,
  collapsed,
  workspaceContext,
  identityRef,
  onOpenSettings,
}: SidebarAccountMenuProps) {
  const { t, locale } = useI18n();
  const isZh = locale.startsWith('zh');
  const isZhTw = locale === 'zh-TW';
  const [open, setOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const { session, refresh } = useTokenToSeaSession();
  const tokentoseaSignedIn = session.phase === 'ready' && session.signedIn;
  const tokentoseaPending = session.phase === 'ready' && session.pending === true;
  const tokentoseaConfigured = session.phase === 'ready' ? session.configured !== false : true;
  const tokentoseaUser = session.phase === 'ready' ? session.user : undefined;
  const signedIn = Boolean(workspaceContext) || tokentoseaSignedIn;
  const waiting = !signedIn && Boolean(authUrl || tokentoseaPending);
  const fallbackAccountName = isZhTw ? 'TokenToSea 帳戶' : isZh ? 'TokenToSea 账户' : 'TokenToSea account';
  const signInLabel = isZhTw ? '登入 / 註冊' : isZh ? '登录 / 注册' : 'Sign in / Sign up';
  const waitingLabel = isZhTw ? '等待授權…' : isZh ? '等待授权…' : t('tokentosea.account.waiting');
  const name =
    workspaceContext?.displayName?.trim() ||
    tokentoseaUser?.name?.trim() ||
    tokentoseaUser?.email?.trim() ||
    fallbackAccountName;
  const subtitle = tokentoseaSignedIn
    ? tokentoseaUser?.email?.trim() || (isZh ? '已连接 TokenToSea' : 'Connected to TokenToSea')
    : workspaceContext
      ? isZh
        ? '已连接工作区'
        : 'Workspace connected'
      : waitingLabel;
  useEffect(() => {
    if (!signedIn) return;
    setAuthUrl(null);
  }, [signedIn]);

  useEffect(() => {
    if (!waiting || signedIn) return;
    const timer = window.setInterval(() => {
      refresh();
    }, 1800);
    return () => window.clearInterval(timer);
  }, [waiting, signedIn, refresh]);

  const docked = mode === 'docked';
  const rail = docked && collapsed;
  // In the expanded sidebar the menu is anchored to the identity row and shares its edges, so it never
  // spills past the sidebar; the rail and the overlay bar have no row that wide, and keep a fixed width.
  const rowAnchored = docked && !rail;

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  const openExternalAuth = async (url: string) => {
    const opened = await openHostExternalUrl(url);
    if (!opened.ok && typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleSignIn = async () => {
    if (!tokentoseaConfigured) {
      onOpenSettings('account');
      return;
    }
    setSigningIn(true);
    try {
      const res = await fetch('/api/tokentosea/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).catch(() => null);
      const data = res
        ? ((await res.json().catch(() => null)) as { authorizeUrl?: string } | null)
        : null;
      if (!res?.ok || !data?.authorizeUrl) {
        onOpenSettings('account');
        return;
      }
      setAuthUrl(data.authorizeUrl);
      await openExternalAuth(data.authorizeUrl);
    } finally {
      setSigningIn(false);
    }
  };

  const handleCancelWaiting = () => {
    setAuthUrl(null);
    setOpen(false);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await fetch('/api/tokentosea/logout', { method: 'POST', credentials: 'same-origin' });
      window.dispatchEvent(new CustomEvent(TOKENTOSEA_SESSION_CHANGED_EVENT));
      refresh();
      setOpen(false);
    } finally {
      setSigningOut(false);
    }
  };

  if (!signedIn && !waiting) {
    return (
      <Button
        variant="default"
        size="md"
        loading={signingIn}
        aria-label={signInLabel}
        data-testid="fantay-sidebar-account"
        data-account-state="signed-out"
        className={cn(
          'min-w-0 gap-2 rounded-row text-body font-medium text-ink focus-visible:-outline-offset-2',
          rail ? 'size-8 justify-center px-0' : docked ? 'flex-1 justify-start px-2.5' : 'justify-start px-2.5',
        )}
        onClick={() => void handleSignIn()}
      >
        <Icon icon={LogIn} size={15} className="text-ink-soft" />
        <span className={cn(styles.accountName, 'min-w-0 truncate')}>{signInLabel}</span>
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {rowAnchored ? <PopoverAnchor virtualRef={identityRef} /> : null}
      <PopoverTrigger asChild>
        {signedIn ? (
          <Button
            variant="bare"
            size="md"
            aria-label={`${name} · ${t('fantayShell.account.menu')}`}
            data-testid="fantay-sidebar-account"
            data-account-state="signed-in"
            className={cn(
              'min-w-0 gap-2 rounded-row text-body font-normal text-ink focus-visible:-outline-offset-2',
              rail ? 'size-8 justify-center px-0' : 'justify-start px-1.5',
              rowAnchored && 'mr-auto shrink',
            )}
          >
            <AccountFace name={name} signedIn />
            <span className={cn(styles.accountName, 'min-w-0 truncate')}>{name}</span>
            {!rail ? <Dot tone="done" /> : null}
          </Button>
        ) : (
          <Button
            variant="default"
            size="md"
            aria-label={waitingLabel}
            data-testid="fantay-sidebar-account"
            data-account-state="pending"
            className={cn(
              'min-w-0 gap-2 rounded-row text-body font-medium text-ink focus-visible:-outline-offset-2',
              rail ? 'size-8 justify-center px-0' : docked ? 'flex-1 justify-start px-2.5' : 'justify-start px-2.5',
            )}
          >
            <Icon icon={LogIn} size={15} className="text-ink-soft" />
            <span className={cn(styles.accountName, 'min-w-0 truncate')}>{waitingLabel}</span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        width={rowAnchored ? 'auto' : 248}
        side={docked ? (rail ? 'right' : 'top') : 'bottom'}
        align={docked ? 'start' : 'end'}
        aria-label={t('fantayShell.account.menu')}
        data-testid="fantay-sidebar-account-menu"
        className={cn('p-1.5', rowAnchored && 'w-(--radix-popover-trigger-width)')}
      >
        {signedIn ? (
          <>
            <div className="flex items-center gap-2 px-1.5 pt-1.5 pb-2.5">
              <Avatar name={name} size={28} tone="ink" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-medium text-ink">{name}</span>
                {subtitle !== name ? <span className="truncate text-caption text-ink-faint">{subtitle}</span> : null}
              </div>
            </div>
            <div className={styles.accountHero}>
              {tokentoseaSignedIn ? <AccountBalance onOpen={() => run(() => onOpenSettings('account'))} /> : null}
              <ThemeSegmented size="xs" />
            </div>
            <div className="mt-2 flex flex-col">
              <AccountMenuAction
                icon={UserRound}
                testId="fantay-sidebar-account-profile"
                onClick={() => run(() => onOpenSettings('account'))}
              >
                {t('fantayShell.account.profile')}
              </AccountMenuAction>
              <AccountMenuAction icon={Settings} testId="fantay-sidebar-account-settings" onClick={() => run(() => onOpenSettings())}>
                {t('entry.accountSettings')}
              </AccountMenuAction>
              {tokentoseaSignedIn && !workspaceContext ? (
                <AccountMenuAction
                  icon={LogOut}
                  testId="fantay-sidebar-account-logout"
                  loading={signingOut}
                  onClick={() => void handleSignOut()}
                >
                  {t('fantayShell.account.signOut')}
                </AccountMenuAction>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-0.5 px-3 py-2">
              <span className="truncate text-body font-medium text-ink">{waitingLabel}</span>
              <span className="truncate text-caption text-ink-faint">
                {isZh ? '请在浏览器中完成 TokenToSea 登录或注册' : 'Complete sign-in or sign-up in your browser'}
              </span>
            </div>
            <div className="mx-1 my-1 h-px bg-line-soft" aria-hidden />
            <AccountMenuAction
              icon={RotateCw}
              testId="fantay-sidebar-account-reopen"
              loading={signingIn}
              onClick={() =>
                run(() => {
                  if (authUrl) void openExternalAuth(authUrl);
                  else void handleSignIn();
                })
              }
            >
              {t('tokentosea.account.reopen')}
            </AccountMenuAction>
            <AccountMenuAction
              icon={UserRound}
              testId="fantay-sidebar-account-services"
              onClick={() => run(() => onOpenSettings('account'))}
            >
              {t('fantayShell.account.services')}
            </AccountMenuAction>
            <AccountMenuAction icon={X} testId="fantay-sidebar-account-cancel" onClick={handleCancelWaiting}>
              {t('tokentosea.account.cancel')}
            </AccountMenuAction>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The wallet balance in the display currency of the interface language (CNY for 简体中文, JPY for
 *  日本語, …; USD while no exchange rate is available). It is mounted only while the menu is open,
 *  so every opening reads a fresh balance, and it waits for the rate before showing a number so the
 *  amount never flashes in one currency and settles in another. The whole tile is one button that
 *  opens Settings ▸ 账户 (balance details, refresh, top-up). */
function AccountBalance({ onOpen }: { onOpen(): void }) {
  const { t, locale } = useI18n();
  const { wallet } = useTokenToSeaWallet();
  const currency = useDisplayCurrency(locale);
  const rateSettled = currency.quote !== null || currency.failed;
  const amount = wallet.state === 'ready' && rateSettled ? formatDisplayBalance(wallet.usd, locale, currency.quote) : null;
  return (
    <Button
      variant="bare"
      data-testid="fantay-sidebar-account-balance"
      data-state={wallet.state}
      className={cn(styles.accountBalance, 'focus-visible:-outline-offset-2')}
      onClick={onOpen}
    >
      <span className={styles.accountBalanceLabel}>
        {t('fantayShell.account.balance')}
        <Icon icon={ChevronRight} size={12} />
      </span>
      {wallet.state === 'error' ? (
        <span className={styles.accountBalanceAmount} data-unavailable="" title={t('fantayShell.account.balanceUnavailable')}>
          —
        </span>
      ) : wallet.state === 'ready' && amount ? (
        <span
          className={styles.accountBalanceAmount}
          data-long={amount.text.length > 9 ? '' : undefined}
          data-currency={amount.currency}
          title={`${wallet.usd} USD`}
        >
          {amount.text}
        </span>
      ) : (
        <span className={cn(skeletonVariants(), styles.accountBalanceSkeleton)} aria-hidden />
      )}
    </Button>
  );
}

function AccountMenuAction({
  icon,
  testId,
  loading,
  onClick,
  children,
}: {
  icon: LucideIcon;
  testId: string;
  loading?: boolean;
  onClick(): void;
  children: string;
}) {
  return (
    <Button
      variant="bare"
      size="md"
      block
      loading={loading}
      data-testid={testId}
      className="justify-start gap-2 px-1.5 font-normal text-ink focus-visible:-outline-offset-2"
      onClick={onClick}
    >
      {/* The icon sits in a slot as wide as the header avatar, so icons centre under the avatar and
          labels start on the same edge as the account name. */}
      <span className="grid w-7 flex-none place-items-center">
        <Icon icon={icon} size={16} className="text-ink-soft" />
      </span>
      {children}
    </Button>
  );
}
