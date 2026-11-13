import { BYOK_AGENT_ID, createBundledPiAgentDef } from '../bundled-pi.js';
import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

/**
 * Bring-your-own-key chat through the bundled pi, configured per run from the
 * user's provider settings. Requests that still name the legacy id
 * `byok-opencode` resolve here (see `getAgentDef`).
 */
export const byokAgentDef: RuntimeAgentDef = createBundledPiAgentDef({
  id: BYOK_AGENT_ID,
  name: 'BYOK',
  fallbackModels: [DEFAULT_MODEL_OPTION],
  supportsCustomModel: true,
});
