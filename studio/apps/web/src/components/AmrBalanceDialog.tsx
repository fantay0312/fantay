import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dialog } from '@open-design/components';
import { canReachWorkspaceBillingEntrance, type WorkspaceCollabContext } from '@open-design/contracts';
import { useT } from '../i18n';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import { AMR_RECHARGE_URL } from '../runtime/amr-guidance';
import {
  amrBalanceGateScopeForWorkspaceContext,
  hasAmrFundingRecovered,
  type AmrBalanceGateScope,
} from '../runtime/amr-balance-gate';
import { AmrLoginPill } from './AmrLoginPill';
import { Icon } from './Icon';
import styles from './AmrBalanceDialog.module.css';

/** How often the post-recharge funding watch polls. Overlapping ticks are
 * skipped so a stalled preflight cannot stack HTTP or Vela work. */
export const WALLET_WATCH_INTERVAL_MS = 5_000;
/** Give up watching after this long; the dialog stays, resume goes manual. */
export const WALLET_WATCH_TIMEOUT_MS = 10 * 60_000;

interface Props {
  /** Backend funding rejection, or a pre-send sign-in block. */
  reason: 'insufficient' | 'signed_out';
  modelId?: string | null;
  fundingScope?: AmrBalanceGateScope;
  surface: 'home' | 'chat';
  workspaceContext?: WorkspaceCollabContext | null;
  metricsConsent: boolean;
  installationId: string | null | undefined;
  /** Dismissal only ("not now" / Esc); does not retry a failed run. */
  onClose: () => void;
  /** The blocking condition just cleared (sign-in completed, or the wallet
   *  watch saw the recharge land) — the caller resumes the parked task. */
  onResolved: () => void;
}

// Sign-in and TokenToSea wallet recovery can resume the parked send.
export function AmrBalanceDialog({
  reason,
  modelId,
  fundingScope,
  surface,
  workspaceContext: workspaceContextOverride,
  metricsConsent,
  installationId,
  onClose,
  onResolved,
}: Props) {
  const t = useT();
  const signedOut = reason === 'signed_out';
  const signInEntrySource =
    surface === 'home'
      ? ('home_balance_gate_sign_in' as const)
      : ('chat_balance_gate_sign_in' as const);
  // Armed by the wallet CTA click (the user's "I'm going to recharge"
  // signal): poll the wallet until the balance clears the hard line, then
  // resume the parked task via onResolved. Bounded so an abandoned recharge
  // doesn't poll forever; guarded against double-fires.
  const [watchingWallet, setWatchingWallet] = useState(false);
  const { context: ambientWorkspaceContext, loading: ambientWorkspaceLoading } = useWorkspaceContext();
  const workspaceContext = workspaceContextOverride === undefined ? ambientWorkspaceContext : workspaceContextOverride;
  const canRecharge = (workspaceContextOverride !== undefined || !ambientWorkspaceLoading)
    && (!workspaceContext || canReachWorkspaceBillingEntrance(workspaceContext));
  const resolvedRef = useRef(false);
  const resolveOnce = () => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    onResolved();
  };
  useEffect(() => {
    if (!watchingWallet) return;
    let cancelled = false;
    let inFlight = false;
    const startedAt = Date.now();
    const stopWatching = () => {
      if (cancelled) return;
      setWatchingWallet(false);
    };
    const tick = async () => {
      if (cancelled || inFlight) return;
      if (Date.now() - startedAt > WALLET_WATCH_TIMEOUT_MS) {
        stopWatching();
        return;
      }
      inFlight = true;
      try {
        const recovered = await hasAmrFundingRecovered(fundingScope ?? amrBalanceGateScopeForWorkspaceContext(workspaceContext), modelId);
        if (cancelled) return;
        if (recovered) {
          resolveOnce();
          return;
        }
        if (Date.now() - startedAt > WALLET_WATCH_TIMEOUT_MS) {
          stopWatching();
        }
      } finally {
        inFlight = false;
      }
    };
    const interval = setInterval(() => void tick(), WALLET_WATCH_INTERVAL_MS);
    const timeout = setTimeout(stopWatching, WALLET_WATCH_TIMEOUT_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(timeout);
    };
    // resolveOnce is stable via ref; onResolved changes don't re-arm the watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchingWallet, workspaceContext?.workspaceId, workspaceContext?.workspaceMemberId, fundingScope?.workspaceId, fundingScope?.workspaceMemberId, modelId]);
  const openRecharge = () => {
    window.open(AMR_RECHARGE_URL, '_blank', 'noopener,noreferrer');
    setWatchingWallet(true);
  };
  const dialog = (
    <Dialog
      role="alertdialog"
      ariaLabel={signedOut ? t('chat.amrBalanceGate.signedOutTitle') : t('chat.amrBalanceGate.title')}
      onClose={onClose}
      closeOnEscape
      className={styles.panel}
      data-testid="amr-balance-dialog"
    >
      <button
        type="button"
        className={styles.closeButton}
        onClick={onClose}
        aria-label={t('common.close')}
      >
        <Icon name="close" size={14} />
      </button>
      <div className={styles.banner}>
        <img
          className={styles.bannerImage}
          src="/upgrade/cloud-signin-aurora.jpg"
          alt=""
          width={1680}
          height={720}
          decoding="async"
          draggable={false}
        />
      </div>
      <h2 className={styles.title}>
        {signedOut ? t('chat.amrBalanceGate.signedOutTitle') : t('chat.amrBalanceGate.title')}
      </h2>
      <p className={styles.message}>
        {/* Product copy S04 / S06 (OPEND-2849): the insufficient variant no
            longer quotes the balance — the finalized sentence has no amount. */}
        {signedOut
          ? t('chat.amrBalanceGate.signedOutMessage')
          : t('chat.amrBalanceGate.message')}
      </p>
      {/* Dismissal first in DOM so it lands on the left of the row and focus
          order matches the reading order; the CTA follows on the right. */}
      <div className={styles.actions}>
        <Button variant="ghost" className={styles.later} onClick={onClose}>
          {t('chat.amrBalanceGate.laterCta')}
        </Button>
        {signedOut ? (
          <AmrLoginPill
            className={styles.signInPill}
            signInLabel={t('chat.amrBalanceGate.signInCta')}
            amrEntrySourceDetail={signInEntrySource}
            metricsConsent={metricsConsent}
            installationId={installationId}
            showActivationDetails
            hideSignedOutStatus
            revealPendingCancelAction
            onStatusChange={(loginStatus) => {
              // Signed in — the gate's reason is gone; resume the parked task.
              if (loginStatus?.loggedIn === true) resolveOnce();
            }}
          />
        ) : canRecharge ? (
          <Button
            variant="primary"
            className={styles.cta}
            onClick={openRecharge}
            data-testid="amr-balance-dialog-recharge"
          >
            {t('chat.amrError.rechargeCta')}
          </Button>
        ) : null}
      </div>
      {watchingWallet ? (
        <p className={styles.watchingHint} data-testid="amr-balance-dialog-watching">
          {t('chat.amrBalanceGate.watchingWallet')}
        </p>
      ) : null}
    </Dialog>
  );
  if (typeof document === 'undefined') return dialog;
  return createPortal(dialog, document.body);
}
