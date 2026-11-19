import { buildTokenToSeaPiProvider } from '../runtimes/bundled-pi.js';
import { tokenToSeaNativeProtocol } from './tokentosea-claude.js';
import { tokenToSeaAgentOutputLimit, tokenToSeaInterleavedReasoning, type TokenToSeaRuntime } from './tokentosea-runtime.js';

export function tokenToSeaLeaseProvider(
  lease: Awaited<ReturnType<TokenToSeaRuntime['createInferenceLease']>>, daemonOrigin: string,
) {
  return buildTokenToSeaPiProvider({
    daemonOrigin, token: lease.token, protocol: tokenToSeaNativeProtocol(lease.model),
    modelId: lease.model.id, modelName: lease.model.name ?? lease.model.model,
    reasoningEffort: lease.reasoningEffort,
    maxOutputTokens: tokenToSeaAgentOutputLimit(lease.model, lease.reasoningEffort),
    interleavedReasoning: tokenToSeaInterleavedReasoning(lease.model),
    ...(typeof lease.model.contextWindow === 'number' && lease.model.contextWindow > 0 ? { contextWindow: lease.model.contextWindow } : {}),
  });
}
