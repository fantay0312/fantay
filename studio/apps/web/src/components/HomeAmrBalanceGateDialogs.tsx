import type { AmrBalanceGateScope } from '../runtime/amr-balance-gate';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { AmrBalanceDialog } from './AmrBalanceDialog';
import { AmrOwnerTopUpDialog } from './chat/AmrOwnerTopUpDialog';

/**
 * A Home gate for confirmed insufficient funding or sign-out. The dialog resolves the promise the submit handler is awaiting:
 * 'retry' (sign-in completed / recharge landed) re-runs the gate and continues
 * the very same create-and-run; 'dismiss' hands the composer back to the user.
 */
export interface HomeAmrBalanceGateBlock {
  reason: 'insufficient' | 'signed_out';
  modelId?: string | null;
  fundingScope?: AmrBalanceGateScope;
  workspaceContext?: WorkspaceCollabContext | null;
  dialog: 'recharge' | 'ask_owner';
  resolve: (decision: 'retry' | 'dismiss') => void;
}

interface Props {
  block: HomeAmrBalanceGateBlock | null;
  metricsConsent: boolean;
  installationId: string | null | undefined;
}

/**
 * App owns this dialog both before navigation (a cached insufficient hint)
 * and behind the pending project frame (the asynchronous sign-in gate).
 * Dismissing a cached hint keeps the Home draft; dismissing a sign-in block
 * rolls the optimistic hand-off back to Home.
 */
export function HomeAmrBalanceGateDialogs({ block, metricsConsent, installationId }: Props) {
  if (!block) return null;
  if (block.dialog === 'ask_owner') {
    return <AmrOwnerTopUpDialog onClose={() => block.resolve('dismiss')} />;
  }
  return (
    <AmrBalanceDialog
      reason={block.reason}
      modelId={block.modelId}
      fundingScope={block.fundingScope}
      workspaceContext={block.workspaceContext}
      surface="home"
      metricsConsent={metricsConsent}
      installationId={installationId}
      onClose={() => block.resolve('dismiss')}
      onResolved={() => block.resolve('retry')}
    />
  );
}
