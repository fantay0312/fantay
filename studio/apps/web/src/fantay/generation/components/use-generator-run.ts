// SPDX-License-Identifier: AGPL-3.0-only
// Run/Stop wiring shared by the generator node face and its panel (spec 05 §5.7, §4.6): the button
// state, the disabled reason, and `service.run` with the resolved model; a refused run is explained in
// a toast (the reasons map to the run-disabled copy).
import { useCallback } from 'react';

import { useT } from '../../../i18n';
import type { Dict } from '../../../i18n/types';
import type { RunBlockedReason } from '../generation-service';
import { useGeneration, useGeneratorView, type GeneratorView } from '../hooks';
import type { RunButtonState } from './RunButton';

type DictKey = keyof Dict;

export const RUN_BLOCKED_KEYS: Record<RunBlockedReason, DictKey | null> = {
  'read-only': 'board.mode.reason.readOnly',
  'imported-folder': 'fantay.gen.run.disabledImported',
  'no-model': 'fantay.gen.run.disabledNoModel',
  'model-unavailable': 'fantay.gen.refs.unsupported',
  'empty-prompt': 'fantay.gen.run.disabledNoPrompt',
  'needs-reference': 'fantay.gen.refs.needed',
  'already-running': 'fantay.gen.run.preparing',
};

export function useGeneratorRun(generatorId: string, options: { beforeRun?: () => void } = {}) {
  return useGeneratorControls(generatorId, useGeneratorView(generatorId), options);
}

/** Run/Stop over a view the caller already holds: the view compiles the prompt, so one surface reads it once. */
export function useGeneratorControls(generatorId: string, view: GeneratorView, options: { beforeRun?: () => void } = {}) {
  const t = useT();
  const generation = useGeneration();
  const reasonKey: DictKey | null = view.runDisabledReason ?? (view.model ? null : 'fantay.gen.run.disabledNoModel');
  const state: RunButtonState = view.runState.active ? 'running' : view.preparing ? 'preparing' : 'idle';
  const { beforeRun } = options;
  const { service, notify, setLastActiveGenerator } = generation;
  const model = view.model;

  const run = useCallback(async () => {
    beforeRun?.();
    if (!model) return;
    setLastActiveGenerator(generatorId);
    const outcome = await service.run(generatorId, model);
    if (outcome.started) return;
    const key = RUN_BLOCKED_KEYS[outcome.reason];
    if (key) notify({ tone: 'error', message: t(key) });
  }, [beforeRun, generatorId, model, notify, service, setLastActiveGenerator, t]);

  const stop = useCallback(() => service.stop(generatorId), [generatorId, service]);

  return {
    view,
    state,
    reasonKey,
    disabledReason: reasonKey ? t(reasonKey) : null,
    count: view.data?.params.count ?? 1,
    run,
    stop,
  };
}
