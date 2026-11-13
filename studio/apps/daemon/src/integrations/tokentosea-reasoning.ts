import type { TokenToSeaModel } from './tokentosea-runtime.js';
import type { AgentModelOption } from '@open-design/contracts';
import { tokenToSeaClaudeThinking, tokenToSeaClaudeIdentityConflict, tokenToSeaUsesClaudeMessages } from './tokentosea-claude.js';

export type TokenToSeaReasoningEffort = 'default' | 'off' | 'on' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'between_tools_low' | 'between_tools_medium' | 'between_tools_high';
type Protocol = 'legacy' | 'deepseek' | 'effort' | 'thinking' | 'minimax-adaptive' | 'glm' | 'qwen' | 'qwen-budget' | 'qwen-effort' | 'doubao' | 'fixed' | 'claude-adaptive' | 'claude-manual';
interface Capability { protocol: Protocol; efforts: TokenToSeaReasoningEffort[]; default: TokenToSeaReasoningEffort; outputField: 'max_tokens' | 'max_completion_tokens'; }
const efforts = new Set<TokenToSeaReasoningEffort>(['default', 'off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const capability = (protocol: Protocol, values: TokenToSeaReasoningEffort[], selected: TokenToSeaReasoningEffort, outputField: 'max_tokens' | 'max_completion_tokens' = 'max_tokens'): Capability => ({ protocol, efforts: values, default: selected, outputField });
const fixed = (outputField?: 'max_completion_tokens') => capability('fixed', ['default'], 'default', outputField);
const chatExamples = (model: TokenToSeaModel) => model.examples?.filter(example => example.path === '/v1/chat/completions') ?? [];
const upstreamName = (model: TokenToSeaModel) => String(model.upstreamModel ?? model.model).split('/').at(-1)!.replace(/^official:/, '').toLowerCase();
// 2026-11-05 live controls: the model's disabled/none request still returned public reasoning.
// Restrict these routes, not the underlying model families or their working official endpoints.
const relayOffUnavailable = new Set([
  'lingzhigongfang/cn-stable/deepseek-v4-flash-0731', 'lingzhigongfang/cn-stable/deepseek-v4-pro-0813',
  'lingzhigongfang/cn-stable/deepseek-v4.1-flash', 'lingzhigongfang/cn-stable/deepseek-v4.1-flash-1017',
  'suanlizhixuan/cn/deepseek-v4-flash-0731', 'suanlizhixuan/cn/deepseek-v4-pro-0813',
  'lingzhigongfang/cn-stable/mimo-v2.5', 'lingzhigongfang/cn-stable/mimo-v2.5-pro',
  'lingzhigongfang/cn-stable/mimo-v2.6-flash', 'lingzhigongfang/cn-stable/mimo-v2.6-pro',
  'suanlizhixuan/cn/mimo-v2.6-flash', 'yuansuanpu/c1/mimo-v2.5-pro', 'yuansuanpu/c1/mimo-v2.6-pro',
  'lingzhigongfang/cn-stable/glm-5.2',
  'suanlizhixuan/gpt/gpt-5.6-terra',
]);

/** Reviewed Chat Completions controls; endpoint examples supplement, rather than replace, family limits.
 * Sources: api-docs.deepseek.com/guides/thinking_mode; platform.kimi.com/docs/guide/use-thinking-models;
 * platform.minimax.cn/docs/guides/text-generation; docs.bigmodel.cn/cn/guide/capabilities/thinking;
 * help.aliyun.com/zh/model-studio/deep-thinking; ai.google.dev/gemini-api/docs/openai.
 * Native supplier aliases retain upstreamModel. Unknown converters never inherit Claude Messages controls.
 */
function reviewedCapability(model: TokenToSeaModel): Capability | null {
  if (model.modality && model.modality !== 'chat') return null;
  if (tokenToSeaClaudeIdentityConflict(model)) return null;
  const declared = Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts.filter((value): value is TokenToSeaReasoningEffort => efforts.has(value as TokenToSeaReasoningEffort)) : undefined;
  if (model.executionKind !== 'official') {
    if (!declared?.length) return null;
    return capability('legacy', declared, declared.includes(model.reasoning?.default as TokenToSeaReasoningEffort) ? model.reasoning!.default as TokenToSeaReasoningEffort : declared[0]!);
  }
  const name = upstreamName(model), provider = model.provider?.toLowerCase(), examples = chatExamples(model);
  const claude = tokenToSeaClaudeThinking(model);
  if (claude) return capability(claude.mode === 'adaptive' ? 'claude-adaptive' : 'claude-manual', claude.efforts, claude.default);
  if (provider === 'deepseek' && /^(deepseek-flash|deepseek-v4(?:\.1)?-(?:pro|flash))(?:-|$)/.test(name)) {
    return capability('deepseek', ['off', 'low', 'high', 'max'], 'high');
  }
  if (provider === 'kimi') {
    if (/^kimi-k3(?:\.1-pro)?(?:-|$)/.test(name)) return capability('effort', ['low', 'high', 'max'], 'max', 'max_completion_tokens');
    if (/^kimi-k2\.6(?:-|$)/.test(name)) return capability('thinking', ['off', 'on'], 'on', 'max_completion_tokens');
    if (/^kimi-k2\.7-code(?:-|$)/.test(name)) return fixed();
  }
  if (provider === 'minimax') {
    if (/^minimax-m3\.1-flash(?:-|$)/.test(name)) return capability('effort', ['low', 'medium', 'high', 'xhigh', 'max'], 'max');
    if (name === 'minimax-m3') return capability('minimax-adaptive', ['off', 'on'], 'on', 'max_completion_tokens');
    if (/^minimax-m2\.(5|7)(?:-|$)/.test(name)) return fixed();
  }
  if (provider === 'zhipu') {
    if (/^glm-5\.3(?:-|$)/.test(name)) return capability('glm', ['low', 'high', 'max'], 'max');
    if (/^glm-5\.2(?:-|$)/.test(name)) return capability('glm', ['off', 'high', 'max'], 'max');
    if (/^glm-(?:4\.(?:5|6v?|7)|5(?:\.1|v)?)(?:-|$)/.test(name)) return capability('thinking', ['off', 'on'], 'on');
    if (/^glm-4\.1v-thinking-/.test(name)) return fixed();
  }
  if (provider === 'qwen') {
    if (/^qwen3\.8-(?:max(?:-0902)?|flash|27b|omni-flash|2\.4t-a95b)$/.test(name)) return capability('qwen-effort', name === 'qwen3.8-2.4t-a95b' ? ['low', 'medium', 'xhigh'] : ['off', 'low', 'medium', 'xhigh'], 'xhigh', /^qwen3\.8-(?:max|flash|omni)/.test(name) ? 'max_completion_tokens' : undefined);
    if (/^qwen3\.7-max-(?:preview|2026-05-17)$/.test(name)) return capability('qwen-budget', ['default', 'low', 'medium', 'high'], 'default', 'max_completion_tokens');
    if (/^qwen3-coder-flash(?:-|$)/.test(name) && examples.some(example => example.body.enable_thinking === false)) return capability('qwen', ['off'], 'off', 'max_completion_tokens');
    const hybrid = /^qwen3\.[5-7]-(?:plus|flash|(?:397|122|35|27)b)(?:-|$)/.test(name) || /^qwen3\.7-max(?:-|$)/.test(name)
      || /^qwen-flash(?:-20\d\d-\d\d-\d\d)?$/.test(name)
      || /^qwen-plus(?:-latest|-2025-(?:04-28|07-14|12-01))?$/.test(name);
    if (hybrid) return capability('qwen-budget', ['off', 'on', 'low', 'medium', 'high'], name.startsWith('qwen3.') ? 'on' : 'off', /^qwen3\.[5-7]-(?:plus|flash)|^qwen3\.7-max/.test(name) ? 'max_completion_tokens' : undefined);
    if (name === 'qwen3-vl-plus') return capability('qwen-budget', ['off', 'on', 'low', 'medium', 'high'], 'off');
    if (name === 'qwen3-omni-flash') return capability('qwen', ['off', 'on'], 'off');
  }
  if (provider === 'doubao') {
    if (/^doubao-seed-(?:evolving|2-[01]-|character-260628)/.test(name)) return capability('doubao', ['off', 'low', 'medium', 'high'], /^doubao-seed-(?:2-0-|character-260628)/.test(name) ? 'medium' : 'high', 'max_completion_tokens');
  }
  if (provider === 'google' && name === 'gemini-3.8-flash') return capability('effort', ['low', 'medium', 'high'], 'medium');
  if (provider === 'openai') {
    // This supplier's Chat-only account accepts tool calls only with reasoning disabled.
    if (model.model === 'lingzhigongfang/global/gpt-6-sol') return capability('effort', ['off'], 'off', 'max_completion_tokens');
    if (name === 'gpt-5.5') return capability('effort', ['off', 'low', 'medium', 'high', 'xhigh'], 'medium', 'max_completion_tokens');
    if (/^gpt-(?:5\.6-(?:luna|sol|terra)|6-(?:luna|sol)|6\.1-terra)$/.test(name)) return capability('effort', ['off', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium', 'max_completion_tokens');
    if (name === 'gpt-6-astra') return capability('effort', ['default', 'low', 'medium', 'high', 'xhigh', 'max'], 'default', 'max_completion_tokens');
    if (name === 'gpt-6.1-sol') return capability('effort', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium', 'max_completion_tokens');
  }
  if (provider === 'stepfun') {
    if (name === 'step-3.5-flash-2603') return capability('effort', ['default', 'low', 'high'], 'default');
    if (name === 'step-3.7-flash' || name === 'step-5-preview') return capability('effort', ['default', 'low', 'medium', 'high'], 'default');
  }
  if (provider === 'xai' && name === 'grok-4.5') return capability('effort', ['low', 'medium', 'high'], 'high', 'max_completion_tokens');
  if (provider === 'xiaomi' && /^mimo-v2\.(?:5(?:-pro)?|6-(?:flash|pro))$/.test(name)) return capability('thinking', ['off', 'on'], 'on', 'max_completion_tokens');
  // Generated catalogue examples do not establish an effort enum or its default.
  if (declared?.length) return capability('effort', declared, declared.includes(model.reasoning?.default as TokenToSeaReasoningEffort) ? model.reasoning!.default as TokenToSeaReasoningEffort : declared[0]!);
  return null;
}

export function tokenToSeaReasoningCapability(model: TokenToSeaModel): Capability | null {
  const descriptor = reviewedCapability(model);
  const withoutOff = relayOffUnavailable.has(model.model);
  // The 16K preset was refused by this dated endpoint even with its declared combined ceiling.
  const withoutHighBudget = model.model === 'qwen-plus-2025-04-28' && descriptor?.protocol === 'qwen-budget';
  if (!descriptor || !withoutOff && !withoutHighBudget) return descriptor;
  const values: TokenToSeaReasoningEffort[] = descriptor.efforts.filter(value => (!withoutOff || value !== 'off') && (!withoutHighBudget || value !== 'high'));
  return values.length ? { ...descriptor, efforts: values, default: values.includes(descriptor.default) ? descriptor.default : values[0]! } : null;
}

const manualBudget = (model: TokenToSeaModel, selected: string, limit = model.maxOutputTokens ?? 4096): number =>
  Math.min(selected === 'low' ? 1024 : selected === 'medium' ? 4096 : 16384, limit - 1);

export function tokenToSeaReasoningOptions(model: TokenToSeaModel): Array<AgentModelOption & { id: TokenToSeaReasoningEffort }> {
  const descriptor = tokenToSeaReasoningCapability(model);
  if (!descriptor) return [];
  const onlyOn = relayOffUnavailable.has(model.model) && descriptor.efforts.length === 1 && descriptor.efforts[0] === 'on';
  const labels: Record<TokenToSeaReasoningEffort, string> = { default: descriptor.protocol === 'fixed' ? '自动思考（不可调节）' : '自动', off: '关闭', on: '开启', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', between_tools_low: '仅工具间思考 · 低', between_tools_medium: '仅工具间思考 · 中', between_tools_high: '仅工具间思考 · 高' };
  return descriptor.efforts.flatMap(id => {
    const budget = (descriptor.protocol === 'claude-manual' && id !== 'off' || descriptor.protocol === 'qwen-budget' && ['low', 'medium', 'high'].includes(id)) ? manualBudget(model, id) : undefined;
    if (budget !== undefined && budget < 1024) return [];
    const reasoningControlKind: AgentModelOption['reasoningControlKind'] = descriptor.protocol === 'fixed' || onlyOn ? 'fixed' : id === 'default' ? 'automatic' : budget !== undefined && !tokenToSeaClaudeThinking(model)?.manualEffort ? 'budget' : id.startsWith('between_tools_') ? 'mode' : ['off', 'on'].includes(id) ? 'toggle' : 'effort';
    const label = onlyOn ? '仅开启思考（当前通道限制）' : reasoningControlKind === 'budget' ? `预算 ${budget!.toLocaleString('en-US')} token` : labels[id];
    return [{ id, label, reasoningControlKind, ...(budget !== undefined ? { reasoningBudgetTokens: budget } : {}), ...(id === descriptor.default ? { default: true } : {}) }];
  });
}

export function resolveTokenToSeaReasoning(model: TokenToSeaModel, requested?: string | null): TokenToSeaReasoningEffort {
  const descriptor = tokenToSeaReasoningCapability(model);
  if (!descriptor) return 'off';
  if (!requested || requested === 'default') return descriptor.default;
  let normalized = requested === 'none' ? 'off' : requested;
  if (descriptor.protocol === 'deepseek') normalized = ({ minimal: 'low', medium: 'high', xhigh: 'high', ultra: 'max' } as Record<string, string>)[normalized] ?? normalized;
  if (descriptor.protocol === 'glm' && upstreamName(model).startsWith('glm-5.2')) normalized = ({ minimal: 'off', low: 'high', medium: 'high', xhigh: 'max' } as Record<string, string>)[normalized] ?? normalized;
  if (descriptor.protocol === 'doubao') normalized = ({ minimal: 'off', xhigh: 'high', max: 'high', on: descriptor.default } as Record<string, string>)[normalized] ?? normalized;
  if (descriptor.protocol === 'qwen-effort') normalized = ({ minimal: 'low', high: 'xhigh', max: 'xhigh', on: 'xhigh' } as Record<string, string>)[normalized] ?? normalized;
  if (model.provider === 'xai' && normalized === 'xhigh') normalized = 'high';
  return descriptor.efforts.find(value => value === normalized) ?? descriptor.default;
}

/** The local lease owns controls. Drop stale/forged fields before projecting the selected model's protocol. */
export function applyTokenToSeaReasoning(model: TokenToSeaModel, selected: TokenToSeaReasoningEffort, body: Record<string, unknown>): void {
  delete body.max_completion_tokens; delete body.max_output_tokens;
  for (const key of ['thinking', 'reasoning_effort', 'enable_thinking', 'thinking_budget', 'reasoning']) delete body[key];
  for (const container of ['extra_body', 'output_config']) {
    const value = body[container];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const cleaned = { ...value as Record<string, unknown> };
      for (const key of ['thinking', 'reasoning_effort', 'enable_thinking', 'thinking_budget', 'reasoning', 'effort']) delete cleaned[key];
      if (container === 'extra_body' && cleaned.google && typeof cleaned.google === 'object' && !Array.isArray(cleaned.google)) {
        const google = { ...cleaned.google as Record<string, unknown> }; delete google.thinking_config;
        if (Object.keys(google).length) cleaned.google = google; else delete cleaned.google;
      }
      if (Object.keys(cleaned).length) body[container] = cleaned; else delete body[container];
    }
  }
  if (chatExamples(model).some(example => Array.isArray(example.body.modalities) && example.body.modalities.includes('text'))) {
    body.modalities = ['text']; delete body.audio;
  }
  const name = upstreamName(model);
  if (model.provider === 'kimi' && /^kimi-k3\.1(?:-|$)/.test(name) || model.provider === 'minimax' && /^minimax-m3\.1-flash(?:-|$)/.test(name)) delete body.parallel_tool_calls;
  if (model.provider === 'minimax' && /^minimax-m3\.1-flash(?:-|$)/.test(name) && body.tool_choice !== undefined) body.tool_choice = 'auto';
  const descriptor = tokenToSeaReasoningCapability(model);
  selected = resolveTokenToSeaReasoning(model, selected);
  // The verified route owns its ceiling field. A generic legacy family default must not undo it.
  const outputField = tokenToSeaUsesClaudeMessages(model) ? 'max_tokens'
    : model.outputLimitField === 'max_completion_tokens' ? 'max_completion_tokens'
      : descriptor?.outputField ?? (chatExamples(model).some(example => typeof example.body.max_completion_tokens === 'number') ? 'max_completion_tokens' : undefined);
  if (outputField === 'max_completion_tokens' && typeof body.max_tokens === 'number') { body[outputField] = body.max_tokens; delete body.max_tokens; }
  if (model.provider === 'openai' && /^gpt-6(?:\.|-)/.test(name) && selected !== 'off') for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs']) delete body[key];
  if (!descriptor) return;
  if (selected === 'default' || descriptor.protocol === 'fixed') return;
  if (descriptor.protocol === 'claude-adaptive') {
    body.thinking = selected === 'off' ? { type: 'disabled' } : selected.startsWith('between_tools_') ? { type: 'between_tools' } : { type: 'adaptive', display: 'summarized' };
    if (selected !== 'off') body.output_config = { ...body.output_config as Record<string, unknown> | undefined, effort: selected.replace('between_tools_', '') };
    for (const key of ['temperature', 'top_p', 'top_k']) delete body[key];
    return;
  }
  if (descriptor.protocol === 'claude-manual') {
    if (selected === 'off') { body.thinking = { type: 'disabled' }; return; }
    const limit = typeof body.max_tokens === 'number' ? body.max_tokens : model.maxOutputTokens ?? 4096;
    if (limit <= 1024) throw new Error('Claude 开启思考时，输出上限需要大于 1024 个 token');
    body.thinking = { type: 'enabled', budget_tokens: manualBudget(model, selected, limit), display: 'summarized' };
    if (tokenToSeaClaudeThinking(model)?.manualEffort) body.output_config = { ...body.output_config as Record<string, unknown> | undefined, effort: selected };
    for (const key of ['temperature', 'top_p', 'top_k']) delete body[key];
    return;
  }
  if (descriptor.protocol === 'deepseek' || descriptor.protocol === 'glm') {
    body.thinking = { type: selected === 'off' ? 'disabled' : 'enabled' };
    if (selected !== 'off') body.reasoning_effort = selected;
  } else if (descriptor.protocol === 'thinking') body.thinking = { type: selected === 'off' ? 'disabled' : 'enabled' };
  else if (descriptor.protocol === 'minimax-adaptive') body.thinking = { type: selected === 'off' ? 'disabled' : 'adaptive' };
  else if (descriptor.protocol === 'qwen') body.enable_thinking = selected !== 'off';
  else if (descriptor.protocol === 'qwen-budget') {
    if (descriptor.efforts.includes('off')) body.enable_thinking = selected !== 'off';
    if (['low', 'medium', 'high'].includes(selected)) body.thinking_budget = manualBudget(model, selected, typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : model.maxOutputTokens ?? 4096);
  }
  else if (descriptor.protocol === 'qwen-effort') {
    if (upstreamName(model) !== 'qwen3.8-2.4t-a95b') body.enable_thinking = selected !== 'off';
    if (selected !== 'off') body.reasoning_effort = selected;
  }
  else if (descriptor.protocol === 'doubao') {
    body.thinking = { type: selected === 'off' ? 'disabled' : 'enabled' };
    body.reasoning_effort = selected === 'off' ? 'minimal' : selected;
  } else body.reasoning_effort = selected === 'off' && model.provider === 'openai' ? 'none' : selected;
  if (model.provider === 'xiaomi' && selected === 'on') { body.temperature = 1; body.top_p = 0.95; }
}

export const tokenToSeaInterleavedReasoning = (model: TokenToSeaModel): boolean =>
  (['deepseek', 'kimi', 'zhipu', 'qwen', 'xiaomi'].includes(model.provider ?? '') || model.provider === 'minimax' && /^minimax-m3\.1-flash(?:-|$)/.test(upstreamName(model))) && tokenToSeaReasoningCapability(model) !== null;
