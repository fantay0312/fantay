// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node.tsx
// (ImageSlotStatus, BatchImageFailureActions, L904-930).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: all slot states of a candidate (pending/queued/running with the
// newest progress line and elapsed time, failed/interrupted through the next-step error card,
// stopped with "check result", lost with retry); no fake percentage.
import { isActiveSlot, type GenerationCandidate } from '@open-design/contracts';

import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { Button } from '../ui';
import { useCandidateProgress, useGeneration } from '../generation/hooks';
import { BOARD_CONTROL_PROPS } from '../generation/components/board-interactive';
import { GenerationErrorCard } from '../generation/components/GenerationErrorCard';
import { outputNodeNextStepTargets, runNextStepAction } from '../generation/components/next-step-runner';
import { useNow } from '../generation/components/use-now';
import { formatElapsed } from './media-display';
import styles from './SlotStatus.module.css';

type DictKey = keyof Dict;

const ACTIVE_LABEL: Record<'pending' | 'queued' | 'running', DictKey> = {
  pending: 'fantay.gen.slot.pending',
  queued: 'fantay.gen.slot.queued',
  running: 'fantay.gen.slot.running',
};

export interface SlotStatusProps {
  nodeId: string;
  candidate: GenerationCandidate;
  /** The generator that produced the node (next-step actions on the prompt or model go there). */
  generatorId?: string | undefined;
  compact?: boolean;
}

export function SlotStatus({ nodeId, candidate, generatorId, compact = false }: SlotStatusProps) {
  const t = useT();
  const generation = useGeneration();
  const progress = useCandidateProgress(candidate.id);
  const active = isActiveSlot(candidate.status);
  const now = useNow(active);
  const retry = () => {
    void generation.service.retryCandidate(nodeId, candidate.id);
  };

  if (active) {
    const status = candidate.status as 'pending' | 'queued' | 'running';
    const line = progress?.lines[progress.lines.length - 1];
    return (
      <div className={styles.root} data-status={candidate.status} data-testid="fx-media-slot" aria-busy="true">
        <span className={styles.ring} aria-hidden />
        <span className={styles.label}>{t(ACTIVE_LABEL[status])}</span>
        {candidate.startedAt ? (
          <span className={styles.meta}>{t('fantay.gen.run.elapsed', { time: formatElapsed(now - candidate.startedAt) })}</span>
        ) : null}
        {line && !compact ? <span className={styles.progress}>{line}</span> : null}
      </div>
    );
  }

  if ((candidate.status === 'failed' || candidate.status === 'interrupted') && candidate.error) {
    const targets = outputNodeNextStepTargets({
      board: generation.board,
      generatorId,
      onOpenSettings: generation.onOpenSettings,
      retry,
    });
    return (
      <div className={styles.root} data-status={candidate.status} data-tone="failed" data-testid="fx-media-slot">
        <GenerationErrorCard
          compact
          error={candidate.error}
          onRetry={retry}
          onAction={(run) => runNextStepAction(run, targets)}
          {...(candidate.status === 'interrupted' ? { messageKey: 'fantay.gen.slot.interrupted' as const } : {})}
        />
      </div>
    );
  }

  if (candidate.status === 'stopped') {
    return (
      <div className={styles.root} data-status="stopped" data-testid="fx-media-slot">
        <span className={styles.label}>{t('fantay.gen.slot.stopped')}</span>
        <Button
          size="sm"
          variant="default"
          data-testid="fx-media-slot-check"
          {...BOARD_CONTROL_PROPS}
          onClick={() => void generation.service.checkCandidate(nodeId, candidate.id)}
        >
          {t('fantay.gen.slot.checkResult')}
        </Button>
      </div>
    );
  }

  if (candidate.status === 'lost' || candidate.status === 'failed' || candidate.status === 'interrupted') {
    return (
      <div className={styles.root} data-status={candidate.status} data-testid="fx-media-slot">
        <span className={styles.label}>
          {t(candidate.status === 'interrupted' ? 'fantay.gen.slot.interrupted' : 'fantay.gen.slot.lost')}
        </span>
        <Button size="sm" variant="default" data-testid="fx-media-slot-retry" {...BOARD_CONTROL_PROPS} onClick={retry}>
          {t('fantay.gen.slot.retry')}
        </Button>
      </div>
    );
  }

  return null;
}
