import { describe, expect, it } from 'vitest';

import type { ProjectMetadata } from '../src/api/projects.js';
import { BOARD_VARIANT_FILES_DIRECTIVE } from '../src/prompts/board-variants.js';
import {
  assertOdNextPlanningBuildOnlyV2,
  composeOdNextStrategyRequestPromptV2,
  composeOdNextStrategyStableRequestContextV2,
  type OdNextStrategyRequestRecipeV2,
} from '../src/prompts/od-next-strategy.js';
import { composeSystemPrompt } from '../src/prompts/system.js';

const HEADING = '## Board variants (host contract)';
const OD_NEXT_BLOCK = '<od-next-context kind="instruction" name="board-variant-files">';

const metadata = (kind: ProjectMetadata['kind']): ProjectMetadata => ({ kind }) as ProjectMetadata;

const recipe: OdNextStrategyRequestRecipeV2 = {
  recipe: 'od-next-plan-build-v2',
  strategyId: 'od-next-strategy',
  strategyVersion: '2.0.0',
  snapshotId: 'snapshot-board-variants',
  packageHash: 'a'.repeat(64),
  taskProfileDigest: 'b'.repeat(64),
  taskProfileVersion: '2.0.0',
  taskType: 'prototype',
  executionProfile: 'filesystem',
  coreStrategy: '# Core\n\nKeep route and execution facts locked.',
  generalOrchestration: '# Orchestration\n\nPrepare a Design Spec and Full Plan, then Build.',
  taskSkill: '# Prototype\n\nProduce the declared editable prototype.',
  activeStages: [
    { name: 'discovery', atoms: [{ name: 'discovery-question-form' }] },
    { name: 'plan', atoms: [{ name: 'direction-picker' }, { name: 'todo-write' }] },
    { name: 'generate', atoms: [{ name: 'file-write' }, { name: 'live-artifact' }] },
  ],
};

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('BOARD_VARIANT_FILES_DIRECTIVE', () => {
  it('is the single host-contract text and stays clear of the OD Next guard', () => {
    expect(BOARD_VARIANT_FILES_DIRECTIVE.startsWith(HEADING)).toBe(true);
    expect(BOARD_VARIANT_FILES_DIRECTIVE).toContain('`<name>.variant-<label>.<ext>`');
    expect(BOARD_VARIANT_FILES_DIRECTIVE).toContain('Do not create variant files when only one result was requested.');
    expect(() => assertOdNextPlanningBuildOnlyV2(BOARD_VARIANT_FILES_DIRECTIVE, 'board-variant-files')).not.toThrow();
    expect(BOARD_VARIANT_FILES_DIRECTIVE).not.toMatch(/apps\/|planner\.ts|verification|checklist|critique|judge|evidence/i);
  });
});

describe('legacy / API-BYOK composer (packages/contracts composeSystemPrompt)', () => {
  it('pins the directive after the comment-identity directive for prototype runs', () => {
    for (const prompt of [
      composeSystemPrompt({ metadata: metadata('prototype') }),
      composeSystemPrompt({}),
      composeSystemPrompt({ metadata: metadata('deck') }),
      composeSystemPrompt({ metadata: metadata('prototype'), streamFormat: 'plain' }),
      composeSystemPrompt({ metadata: metadata('prototype'), sessionMode: 'plan' }),
    ]) {
      expect(occurrences(prompt, HEADING)).toBe(1);
      expect(prompt.indexOf(HEADING)).toBeGreaterThan(prompt.indexOf('data-od-comment-id'));
      expect(prompt.trimEnd().endsWith('Do not create variant files when only one result was requested.')).toBe(true);
    }
  });

  it('leaves the directive out of ask mode and media surfaces', () => {
    expect(composeSystemPrompt({ metadata: metadata('prototype'), sessionMode: 'chat' })).not.toContain(HEADING);
    for (const kind of ['image', 'video', 'audio'] as const) {
      expect(composeSystemPrompt({ metadata: metadata(kind) })).not.toContain(HEADING);
    }
    expect(composeSystemPrompt({ skillMode: 'video' })).not.toContain(HEADING);
  });
});

describe('OD Next composer', () => {
  it('emits the board-variant-files instruction for prototype runs', () => {
    for (const text of [
      composeOdNextStrategyStableRequestContextV2({ metadata: metadata('prototype') }),
      composeOdNextStrategyStableRequestContextV2({}),
      composeOdNextStrategyRequestPromptV2(recipe, { metadata: metadata('prototype'), sessionMode: 'design' }),
      composeSystemPrompt({ odNextStrategyRecipe: recipe, metadata: metadata('prototype') }),
    ]) {
      expect(occurrences(text, OD_NEXT_BLOCK)).toBe(1);
      expect(text).toContain(`${OD_NEXT_BLOCK}\n${HEADING}`);
    }
  });

  it('leaves it out of ask mode and image/video/audio projects', () => {
    expect(composeOdNextStrategyStableRequestContextV2({ sessionMode: 'chat' })).not.toContain(OD_NEXT_BLOCK);
    for (const kind of ['image', 'video', 'audio'] as const) {
      expect(composeOdNextStrategyStableRequestContextV2({ metadata: metadata(kind) })).not.toContain(OD_NEXT_BLOCK);
      expect(composeOdNextStrategyRequestPromptV2(recipe, { metadata: metadata(kind) })).not.toContain(HEADING);
    }
    expect(composeSystemPrompt({ odNextStrategyRecipe: recipe, metadata: metadata('prototype'), sessionMode: 'chat' })).not.toContain(OD_NEXT_BLOCK);
  });
});
