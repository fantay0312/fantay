import { describe, expect, it } from 'vitest';
import { BOARD_VARIANT_FILES_DIRECTIVE } from '@open-design/contracts';

import { composeSystemPrompt, type ComposeInput } from '../../src/prompts/system.js';

const HEADING = '## Board variants (host contract)';
const COMMENT_IDENTITY_MARKER = 'Only when editing HTML that already contains data-od-comment-id';

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('board variant files directive — legacy daemon composer', () => {
  it.each(['classic', 'slim'] as const)('is pinned once after the comment-identity rule for %s prototype runs', (promptCoreVariant) => {
    for (const input of [
      { promptCoreVariant, metadata: { kind: 'prototype' }, executionProfile: 'filesystem' },
      { promptCoreVariant, skillMode: 'prototype', executionProfile: 'filesystem' },
      { promptCoreVariant, metadata: { kind: 'deck' }, executionProfile: 'filesystem' },
      { promptCoreVariant, metadata: { kind: 'prototype' }, sessionMode: 'plan', executionProfile: 'filesystem' },
      { promptCoreVariant, metadata: { kind: 'prototype' }, streamFormat: 'plain' },
    ] as ComposeInput[]) {
      const prompt = composeSystemPrompt(input);
      expect(occurrences(prompt, HEADING)).toBe(1);
      expect(prompt).toContain(BOARD_VARIANT_FILES_DIRECTIVE);
      expect(prompt.indexOf(HEADING)).toBeGreaterThan(prompt.indexOf(COMMENT_IDENTITY_MARKER));
      // The role-marker guard stays the last section.
      const guard = Math.max(
        prompt.lastIndexOf('## CRITICAL: Never fabricate conversation turns'),
        prompt.lastIndexOf('## Critical Constraint: Never Fabricate Conversation Turns'),
      );
      expect(guard).toBeGreaterThan(prompt.indexOf(HEADING));
    }
  });

  it.each(['classic', 'slim'] as const)('is left out of ask mode and media surfaces (%s)', (promptCoreVariant) => {
    expect(composeSystemPrompt({ promptCoreVariant, metadata: { kind: 'prototype' }, sessionMode: 'chat' } as ComposeInput)).not.toContain(HEADING);
    for (const kind of ['image', 'video', 'audio'] as const) {
      expect(composeSystemPrompt({ promptCoreVariant, metadata: { kind }, executionProfile: 'filesystem' } as ComposeInput)).not.toContain(HEADING);
    }
    expect(composeSystemPrompt({ promptCoreVariant, skillMode: 'video', executionProfile: 'filesystem' } as ComposeInput)).not.toContain(HEADING);
  });
});
