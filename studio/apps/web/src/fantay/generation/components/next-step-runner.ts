// SPDX-License-Identifier: AGPL-3.0-only
// Runs a failure's next-step action (spec 05 §4.9): settings deep links, focusing the prompt or the
// model picker of the generator, or a retry. On an output node the generator-side steps select the
// generator that produced it and ask its panel to focus the right control.
import type { GenerationBoardPort } from '../board-adapter';
import { NEXT_STEP_SETTINGS_SECTION, type NextStepRun } from '../next-step';
import { requestGeneratorPanelFocus } from './generator-ui-store';

export interface NextStepTargets {
  onOpenSettings(section: 'media' | 'execution' | 'about'): void;
  focusPrompt?: () => void;
  openModelPicker?: () => void;
  retry?: () => void;
}

export function runNextStepAction(run: NextStepRun, targets: NextStepTargets): void {
  const section = NEXT_STEP_SETTINGS_SECTION[run];
  if (section) {
    targets.onOpenSettings(section);
    return;
  }
  if (run === 'focus-prompt') targets.focusPrompt?.();
  else if (run === 'open-model-picker') targets.openModelPicker?.();
  else if (run === 'retry') targets.retry?.();
}

/** Targets for an output node: prompt / model steps go to the generator `generatorId` (when it still exists). */
export function outputNodeNextStepTargets(input: {
  board: GenerationBoardPort;
  generatorId: string | undefined;
  onOpenSettings: NextStepTargets['onOpenSettings'];
  retry?: () => void;
}): NextStepTargets {
  const openGenerator = (target: 'prompt' | 'model') => {
    const id = input.generatorId;
    if (!id || input.board.getNode(id)?.kind !== 'generator') return;
    input.board.select([id]);
    input.board.focus(id);
    requestGeneratorPanelFocus(id, target);
  };
  return {
    onOpenSettings: input.onOpenSettings,
    focusPrompt: () => openGenerator('prompt'),
    openModelPicker: () => openGenerator('model'),
    ...(input.retry ? { retry: input.retry } : {}),
  };
}
