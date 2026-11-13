import { TOKENTOSEA_AGENT_ID, createBundledPiAgentDef } from '../bundled-pi.js';
import { isTokenToSeaAgentModel, tokenToSeaRuntime, tokenToSeaReasoningOptions } from '../../integrations/tokentosea-runtime.js';
import type { RuntimeAgentDef } from '../types.js';

/**
 * TokenToSea models through the bundled pi, which talks only to the daemon's
 * lease-guarded inference proxy (`/api/tokentosea/agent/...`).
 */
export const tokenToSeaAgentDef: RuntimeAgentDef = createBundledPiAgentDef({
  id: TOKENTOSEA_AGENT_ID,
  name: 'TokenToSea',
  fetchModels: async () => (await tokenToSeaRuntime().chatModels())
    .filter(isTokenToSeaAgentModel)
    .map(model => ({ id: model.id, label: model.name ?? model.model, reasoningOptions: tokenToSeaReasoningOptions(model) })),
  fallbackModels: [],
  supportsCustomModel: false,
});
