// SPDX-License-Identifier: AGPL-3.0-only
// Failure `nextStep` → UI copy and action (spec 05 §4.9). The vocabulary is the media contract's
// `MEDIA_FAILURE_NEXT_STEPS`; `error.messageKey` (sandbox, missing reference) overrides the message.
import type { GenerationCandidateError, MediaFailureNextStep } from '@open-design/contracts';

import type { Dict } from '../../i18n/types';

/** `keyof Dict` (i18n/types.ts exports no `DictKey` alias, amendment B16). */
type DictKey = keyof Dict;

export type NextStepRun =
  | 'focus-prompt'
  | 'open-model-picker'
  | 'open-media-settings'
  | 'open-account-settings'
  | 'open-about'
  | 'retry'
  | 'none';

export interface NextStepAction {
  messageKey: DictKey;
  actionKey?: DictKey;
  run: NextStepRun;
  /** Show a separate retry button next to the primary action. */
  offerRetry: boolean;
}

export const NEXT_STEP_ACTIONS: Readonly<Record<MediaFailureNextStep, NextStepAction>> = Object.freeze({
  'revise-request': {
    messageKey: 'fantay.gen.next.reviseRequest.message',
    actionKey: 'fantay.gen.next.reviseRequest.action',
    run: 'focus-prompt',
    offerRetry: true,
  },
  'switch-model': {
    messageKey: 'fantay.gen.next.switchModel.message',
    actionKey: 'fantay.gen.next.switchModel.action',
    run: 'open-model-picker',
    offerRetry: true,
  },
  'open-settings': {
    messageKey: 'fantay.gen.next.openSettings.message',
    actionKey: 'fantay.gen.next.openSettings.action',
    run: 'open-media-settings',
    offerRetry: true,
  },
  'sign-in': {
    messageKey: 'fantay.gen.next.signIn.message',
    actionKey: 'fantay.gen.next.signIn.action',
    run: 'open-account-settings',
    offerRetry: true,
  },
  'add-credit': {
    messageKey: 'fantay.gen.next.addCredit.message',
    actionKey: 'fantay.gen.next.addCredit.action',
    run: 'open-account-settings',
    offerRetry: false,
  },
  'retry-later': {
    messageKey: 'fantay.gen.next.retryLater.message',
    actionKey: 'fantay.gen.slot.retry',
    run: 'retry',
    offerRetry: false,
  },
  'update-app': {
    messageKey: 'fantay.gen.next.updateApp.message',
    actionKey: 'fantay.gen.next.updateApp.action',
    run: 'open-about',
    offerRetry: false,
  },
  unsupported: {
    messageKey: 'fantay.gen.next.unsupported.message',
    run: 'none',
    offerRetry: false,
  },
  'contact-support': {
    messageKey: 'fantay.gen.next.contactSupport.message',
    actionKey: 'fantay.gen.slot.retry',
    run: 'retry',
    offerRetry: false,
  },
});

/** Settings section a next-step action opens (spec 05 §4.9: `sign-in` / `add-credit` → execution). */
export const NEXT_STEP_SETTINGS_SECTION: Readonly<Partial<Record<NextStepRun, 'media' | 'execution' | 'about'>>> =
  Object.freeze({
    'open-media-settings': 'media',
    'open-account-settings': 'execution',
    'open-about': 'about',
  });

function isDictKey(value: string | undefined): value is DictKey {
  return typeof value === 'string' && /^fantay\.(gen|media|prompts)\./.test(value);
}

/**
 * The action for a candidate error with the message key resolved: `error.messageKey` (only keys of the
 * generation namespaces) overrides the table's message; vars come from `error.messageVars`.
 */
export function nextStepFor(error: GenerationCandidateError): NextStepAction & { messageVars?: Record<string, string> } {
  const base = NEXT_STEP_ACTIONS[error.nextStep] ?? NEXT_STEP_ACTIONS['contact-support'];
  const override = isDictKey(error.messageKey) ? error.messageKey : undefined;
  return {
    ...base,
    ...(override ? { messageKey: override } : {}),
    ...(error.messageVars ? { messageVars: { ...error.messageVars } } : {}),
  };
}
