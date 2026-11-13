import type { TokenToSeaModel } from './tokentosea-runtime.js';

// 2026-11-05 live audit: these older Opus aliases return an Opus 5.5-only thinking restriction.
// Do not certify or offer them as the labelled model until the supplier identity is reverified.
const unverifiedClaudeIdentities = new Set(['tokentide/aws/claude-opus-4-6', 'tokentide/aws/claude-opus-4-7', 'tokentide/aws/claude-opus-4-8', 'tokentide/aws/claude-opus-5']);
export const tokenToSeaClaudeIdentityConflict = (model: TokenToSeaModel): boolean =>
  model.provider === 'anthropic' && unverifiedClaudeIdentities.has(model.model);

export function tokenToSeaUsesClaudeMessages(model: TokenToSeaModel): boolean {
  if (model.provider !== 'anthropic' || model.executionKind !== 'official' || model.modality !== 'chat') return false;
  const path = '/v1/messages';
  const modes = model.verifiedModes as Record<string, { sse?: boolean }> | undefined;
  const inputs = model.verifiedInputs as Record<string, { sse?: string[] }> | undefined;
  if (modes?.[path]?.sse === false || Array.isArray(inputs?.[path]?.sse) && !inputs[path]!.sse!.includes('text')) return false;
  return model.examples?.some(example => example.path === path && example.mode === 'sse') === true;
}

/** Claude effort is a Messages API control. Chat-only vendor converters need their own verified mapping. */
export function tokenToSeaClaudeThinking(model: TokenToSeaModel): {
  mode: 'adaptive' | 'manual';
  efforts: Array<'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'between_tools_low' | 'between_tools_medium' | 'between_tools_high'>;
  default: 'off' | 'medium' | 'high';
  manualEffort?: boolean;
} | null {
  if (!tokenToSeaUsesClaudeMessages(model) || tokenToSeaClaudeIdentityConflict(model)) return null;
  const name = String(model.upstreamModel ?? model.model).split('/').at(-1)!.toLowerCase();
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?(?:-|$)/.exec(name);
  if (!match) return null;
  const family = match[1], major = Number(match[2]), minor = Number(match[3] ?? 0);
  if (major === 4 && minor === 5 && (family === 'haiku' || family === 'opus')) {
    return { mode: 'manual', efforts: ['off', 'low', 'medium', 'high'], default: 'off', manualEffort: family === 'opus' };
  }
  if (major === 4 && minor === 6 && (family === 'opus' || family === 'sonnet')) return { mode: 'adaptive', efforts: ['off', 'low', 'medium', 'high', 'max'], default: 'off' };
  if (major === 4 && (minor === 7 || minor === 8) && family === 'opus') return { mode: 'adaptive', efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'off' };
  if (major === 5 && minor === 0 && (family === 'opus' || family === 'sonnet')) return { mode: 'adaptive', efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' };
  if (major === 5 && minor === 5 && family === 'opus') return { mode: 'adaptive', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' };
  if (major === 5 && minor === 5 && family === 'sonnet') return { mode: 'adaptive', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'between_tools_low', 'between_tools_medium', 'between_tools_high'], default: 'high' };
  // https://platform.claude.com/docs/en/build-with-claude/effort
  if (major === 5 && minor === 5 && family === 'haiku') return { mode: 'adaptive', efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' };
  if (major === 5 && (minor === 0 || minor === 1) && family === 'fable') return { mode: 'adaptive', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' };
  return null;
}

export const tokenToSeaNativeProtocol = (model: TokenToSeaModel): 'anthropic' | 'openai' => tokenToSeaUsesClaudeMessages(model) ? 'anthropic' : 'openai';
export const tokenToSeaNativePath = (model: TokenToSeaModel): '/v1/messages' | '/v1/chat/completions' => tokenToSeaUsesClaudeMessages(model) ? '/v1/messages' : '/v1/chat/completions';
