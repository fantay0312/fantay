// SPDX-License-Identifier: AGPL-3.0-only
// Status line of a generator's latest run (spec 05 §5.7): "generating done/total", the elapsed time,
// the newest progress line of an active candidate, "reconnecting" while the wait scheduler reports
// network trouble, and after the run the partial/total failure with "retry failed". No fake
// percentage. The live region stays mounted so screen readers hear the changes.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { generatorRunState, isActiveSlot } from '@open-design/contracts';

import { useT } from '../../../i18n';
import { Button } from '../../ui';
import type { GenerationService } from '../generation-service';
import { useBoardGraph, useGeneration } from '../hooks';
import { BOARD_CONTROL_PROPS } from './board-interactive';
import { useNow } from './use-now';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Newest progress line among `candidateIds` (service memory; not persisted). */
function useProgressSubscription(service: GenerationService): (listener: () => void) => () => void {
  return useCallback((listener: () => void) => service.subscribeProgress(listener), [service]);
}

function useLatestProgressLine(service: GenerationService, candidateIds: readonly string[]): string | null {
  const key = candidateIds.join('\u0000');
  const subscribe = useProgressSubscription(service);
  return useSyncExternalStore(
    subscribe,
    () => {
      let newest: { line: string; at: number } | null = null;
      for (const id of key ? key.split('\u0000') : []) {
        const progress = service.progressOf(id);
        const line = progress?.lines[progress.lines.length - 1];
        if (line && (!newest || progress.updatedAt > newest.at)) newest = { line, at: progress.updatedAt };
      }
      return newest?.line ?? null;
    },
    () => null,
  );
}

/** True while the scheduler reports network trouble for an active candidate (cleared by its next snapshot). */
function useReconnecting(service: GenerationService, candidateIds: readonly string[], active: boolean): boolean {
  const key = candidateIds.join('\u0000');
  const subscribe = useProgressSubscription(service);
  const reconnecting = useSyncExternalStore(
    subscribe,
    () => (key ? key.split('\u0000') : []).some((id) => service.progressOf(id)?.reconnecting === true),
    () => false,
  );
  return active && reconnecting;
}

export interface RunStatusProps {
  generatorId: string;
  compact?: boolean;
}

export function RunStatus({ generatorId, compact = false }: RunStatusProps) {
  const t = useT();
  const { service } = useGeneration();
  const graph = useBoardGraph();
  const runState = useMemo(() => generatorRunState(graph, generatorId), [graph, generatorId]);
  const subscribeProgress = useProgressSubscription(service);
  const preparing = useSyncExternalStore(
    subscribeProgress,
    () => service.isPreparing(generatorId),
    () => false,
  );
  const activeIds = useMemo(() => {
    if (!runState.outputNodeId || !runState.runId) return [] as string[];
    const output = graph.nodes.find((node) => node.id === runState.outputNodeId);
    return (output?.media?.generation?.candidates ?? [])
      .filter((candidate) => candidate.runId === runState.runId && isActiveSlot(candidate.status))
      .map((candidate) => candidate.id);
  }, [graph, runState.outputNodeId, runState.runId]);
  const line = useLatestProgressLine(service, activeIds);
  const reconnecting = useReconnecting(service, activeIds, runState.active);
  const now = useNow(runState.active);

  const failed = runState.counts.failed + runState.counts.interrupted + runState.counts.lost;
  const done = runState.counts.done;
  let content: ReactNode = null;
  if (preparing && !runState.active) {
    content = <span className="text-ink-faint">{t('fantay.gen.refs.preparing')}</span>;
  } else if (runState.active) {
    content = (
      <>
        <span className="font-medium text-ink">{t('fantay.gen.run.running', { done, total: runState.total })}</span>
        {runState.startedAt ? (
          // A timer inside the polite region: readable, but its per-second ticks are not announced.
          <span role="timer" aria-live="off" className="tabular-nums text-ink-faint">
            {t('fantay.gen.run.elapsed', { time: formatElapsed(now - runState.startedAt) })}
          </span>
        ) : null}
        {reconnecting ? <span className="text-warning-ink">{t('fantay.gen.run.reconnecting')}</span> : null}
        {line && !compact ? <span className="min-w-0 basis-full truncate text-ink-faint">{line}</span> : null}
      </>
    );
  } else if (!compact && runState.total > 0 && !runState.outputMissing && failed > 0) {
    content = (
      <>
        <span className="text-accent-ink">
          {done === 0 ? t('fantay.gen.run.allFailed') : t('fantay.gen.run.partialFailed', { failed, done })}
        </span>
        <Button
          size="sm"
          variant="ghost"
          data-testid="fx-gen-retry-failed"
          {...BOARD_CONTROL_PROPS}
          onClick={() => void service.retryFailed(generatorId)}
        >
          {t('fantay.gen.run.retryFailed')}
        </Button>
      </>
    );
  }

  return (
    <div
      aria-live="polite"
      data-testid="fx-gen-run-status"
      data-active={runState.active ? '' : undefined}
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-label"
    >
      {content}
    </div>
  );
}
