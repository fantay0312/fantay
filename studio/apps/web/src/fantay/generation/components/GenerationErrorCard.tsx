// SPDX-License-Identifier: AGPL-3.0-only
// Failure card of a generation candidate or run (spec 05 §5.7, §4.9): the next-step message, its
// primary action, an optional retry, and the raw error under a collapsible "error details" with copy.
import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { GenerationCandidateError } from '@open-design/contracts';

import { useT } from '../../../i18n';
import type { Dict } from '../../../i18n/types';
import { Button, Disclosure } from '../../ui';
import { nextStepFor, type NextStepRun } from '../next-step';
import { BOARD_CONTROL_PROPS } from './board-interactive';
import styles from './GenerationErrorCard.module.css';

type DictKey = keyof Dict;

export interface GenerationErrorCardProps {
  error: GenerationCandidateError;
  compact?: boolean;
  /** Retry of the failed work (shown when the next step offers it, and as the action of retry steps). */
  onRetry?: () => void;
  onAction(run: NextStepRun): void;
  /** Message override when the error carries no `messageKey` (e.g. `fantay.gen.slot.interrupted`). */
  messageKey?: DictKey;
}

function detailsText(error: GenerationCandidateError): string {
  return [error.message, error.code ? `code: ${error.code}` : '', typeof error.status === 'number' ? `status: ${error.status}` : '']
    .filter(Boolean)
    .join('\n');
}

export function GenerationErrorCard({ error, compact = false, onRetry, onAction, messageKey }: GenerationErrorCardProps) {
  const t = useT();
  const action = nextStepFor(error);
  const resolvedMessageKey = error.messageKey ? action.messageKey : (messageKey ?? action.messageKey);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const runAction = () => {
    if (action.run === 'retry') {
      if (onRetry) onRetry();
      else onAction('retry');
      return;
    }
    onAction(action.run);
  };

  const copyDetails = () => {
    const text = detailsText(error);
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  const showAction = action.run !== 'none' && action.actionKey !== undefined;
  const showRetry = action.offerRetry && Boolean(onRetry);

  return (
    <div className={styles.card} data-compact={compact ? '' : undefined} data-testid="fx-gen-error" data-next-step={error.nextStep}>
      <p className={styles.message}>
        <TriangleAlert size={14} strokeWidth={1.5} aria-hidden />
        <span>{t(resolvedMessageKey, action.messageVars)}</span>
      </p>
      {showAction || showRetry ? (
        <div className={styles.actions}>
          {showAction && action.actionKey ? (
            <Button
              size="sm"
              variant="default"
              data-testid="fx-gen-error-action"
              data-next-step={error.nextStep}
              {...BOARD_CONTROL_PROPS}
              onClick={runAction}
            >
              {t(action.actionKey)}
            </Button>
          ) : null}
          {showRetry ? (
            <Button size="sm" variant="ghost" data-testid="fx-gen-error-retry" {...BOARD_CONTROL_PROPS} onClick={() => onRetry?.()}>
              {t('fantay.gen.slot.retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Disclosure label={t('fantay.gen.error.details')} triggerClassName="text-current" {...BOARD_CONTROL_PROPS}>
        <pre className={styles.details}>{detailsText(error)}</pre>
        <div className={styles.detailsFooter}>
          <Button size="sm" variant="bare" {...BOARD_CONTROL_PROPS} onClick={copyDetails}>
            {copied ? t('fantay.gen.error.copied') : t('fantay.gen.error.copy')}
          </Button>
        </div>
      </Disclosure>
    </div>
  );
}
