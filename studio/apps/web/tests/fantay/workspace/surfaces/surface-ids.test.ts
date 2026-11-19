import { ARTIFACT_FOCUS_TOOLS } from '@open-design/contracts';
import { describe, expect, it } from 'vitest';

import { WORKSPACE_SURFACE_IDS } from '../../../../src/fantay/workspace/surfaces/surface-types';

describe('workspace surface ids', () => {
  // The web keeps its own list so the surface types stay free of the contract package's build; this
  // is what stops the two from drifting. A tool the agent may name and the panel cannot show (or the
  // reverse) would be dropped without a trace by `intentFromAgentFocus`.
  it('are exactly the tools an <od-focus/> marker may name, in the same order', () => {
    expect([...WORKSPACE_SURFACE_IDS]).toEqual([...ARTIFACT_FOCUS_TOOLS]);
  });
});
