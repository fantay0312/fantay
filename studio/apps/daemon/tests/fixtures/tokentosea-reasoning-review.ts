/** Independent review of the public catalogue, checked against primary model docs on 2026-11-05.
 * Never infer an enum from generated request examples. Supplier routing still needs live acceptance.
 */
import type { TokenToSeaModel } from '../../src/integrations/tokentosea-runtime.js';
import { readFileSync } from 'node:fs';
const offEvidence = JSON.parse(readFileSync(new URL('./tokentosea-relay-off-evidence-20261105.json', import.meta.url), 'utf8')) as Array<{ model: string }>;

export const sources = {
  claude: 'https://platform.claude.com/docs/en/build-with-claude/effort#effort-levels',
  claudeModes: 'https://platform.claude.com/docs/en/build-with-claude/thinking#configuring-thinking',
  claudeBudget: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking#budget-rules-and-tuning',
  deepseek: 'https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/',
  kimi: 'https://platform.kimi.com/docs/guide/use-reasoning-effort',
  kimiModes: 'https://platform.kimi.com/docs/guide/use-thinking-models',
  minimax: 'https://platform.minimax.cn/docs/api-reference/text-chat-openai',
  glm: 'https://docs.bigmodel.cn/cn/guide/capabilities/thinking',
  doubao: 'https://ark.volcengine.com/region:cn-beijing/docs/deep-thinking.md',
  qwen: 'https://help.aliyun.com/zh/model-studio/deep-thinking',
  qwenParams: 'https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions',
  gemini: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash',
  openaiTools: 'https://developers.openai.com/api/docs/guides/migrate-to-responses',
  step: 'https://platform.stepfun.com/docs/zh/api-reference/chat/chat-completion-create.md',
  grok: 'https://docs.x.ai/developers/model-capabilities/text/reasoning',
  mimo: 'https://mimo.mi.com/docs/en-US/api/chat/openai-api',
  mimoRetired: 'https://mimo.mi.com/docs/zh-CN/updates/deprecate',
} as const;
type Wire = 'effort' | 'openai' | 'thinking-effort' | 'thinking' | 'minimax' | 'doubao' | 'qwen-effort' | 'qwen-budget' | 'qwen-toggle' | 'claude' | 'claude-budget' | 'claude-budget-effort' | 'fixed' | 'none';
export interface Review {
  options: string[] | null;
  default: string | null;
  wire: Wire;
  sourceUrls: string[];
  note?: string;
  uncertainty?: string;
  nativeOptions?: string[];
}
const profiles = new Map<string, Review>();
function add(provider: string, names: string, options: string, selected: string, wire: Wire, urls: string[], note?: string) {
  const review: Review = { options: options ? options.split(' ') : [], default: selected || null, wire, sourceUrls: urls, ...(note ? { note } : {}) };
  for (const name of names.split(' ')) profiles.set(`${provider}|${name.toLowerCase()}`, review);
}
add('deepseek', 'deepseek-flash deepseek-v4-flash deepseek-v4-pro deepseek-v4-pro-0813 deepseek-v4.1-flash deepseek-v4.1-flash-1017', 'off low high max', 'high', 'thinking-effort', [sources.deepseek], 'Dated/supplier aliases require route identity verification; spelling aliases are not separate grades.');
add('kimi', 'kimi-k3 kimi-k3.1-pro', 'low high max', 'max', 'effort', [sources.kimi]);
add('kimi', 'kimi-k2.6', 'off on', 'on', 'thinking', [sources.kimiModes]);
add('kimi', 'kimi-k2.7-code kimi-k2.7-code-highspeed', 'default', 'default', 'fixed', [sources.kimiModes]);
add('minimax', 'MiniMax-M3.1-Flash', 'low medium high xhigh max', 'max', 'effort', [sources.minimax]);
add('minimax', 'MiniMax-M3', 'off on', 'on', 'minimax', [sources.minimax], 'Chat uses adaptive/disabled; Messages and Responses have different defaults.');
add('minimax', 'MiniMax-M2.5 MiniMax-M2.5-highspeed MiniMax-M2.7 MiniMax-M2.7-highspeed', 'default', 'default', 'fixed', [sources.minimax], 'Always thinking; disabled/effort may be accepted but ignored.');
add('zhipu', 'glm-5.3 glm-5.3-flash glm-5.3-flashx', 'low high max', 'max', 'thinking-effort', [sources.glm]);
add('zhipu', 'glm-5.2', 'off high max', 'max', 'thinking-effort', [sources.glm]);
add('zhipu', 'glm-5.1 glm-5 glm-5-turbo glm-5v-turbo glm-4.7 glm-4.7-flash glm-4.7-flashx glm-4.6 glm-4.6v glm-4.6v-flashx glm-4.5 glm-4.5-air glm-4.5-airx', 'off on', 'on', 'thinking', [sources.glm]);
add('zhipu', 'glm-4.1v-thinking-flash glm-4.1v-thinking-flashx', 'default', 'default', 'fixed', [sources.glm], 'Built-in reasoning; no documented effort or off control.');
add('zhipu', 'glm-4-flash-250414 glm-4-flashx-250414 glm-4-long glm-4-plus glm-4v-flash glm-4-voice', '', '', 'none', [sources.glm], 'No documented reasoning control.');
add('doubao', 'doubao-seed-evolving doubao-seed-2-1-lite-260915 doubao-seed-2-1-pro-260628 doubao-seed-2-1-pro-260915 doubao-seed-2-1-turbo-260628', 'off low medium high', 'high', 'doubao', [sources.doubao]);
add('doubao', 'doubao-seed-2-0-code-preview-260215 doubao-seed-2-0-lite-260428 doubao-seed-2-0-mini-260428 doubao-seed-character-260628', 'off low medium high', 'medium', 'doubao', [sources.doubao]);
add('doubao', 'doubao-seed-character-251128 doubao-seed-translation-250915', '', '', 'none', [sources.doubao], 'No thinking grades; translation is a specialized operation.');
add('qwen', 'qwen3.8-max qwen3.8-max-0902 qwen3.8-flash qwen3.8-27b qwen3.8-omni-flash', 'off low medium xhigh', 'xhigh', 'qwen-effort', [sources.qwen, sources.qwenParams]);
add('qwen', 'qwen3.8-2.4t-a95b', 'low medium xhigh', 'xhigh', 'qwen-effort', [sources.qwen, 'https://help.aliyun.com/zh/model-studio/qwen3-8-2-4t-a95b'], 'Do not derive numeric budgets from generic grade mappings: model/generic maximum budget docs conflict.');
add('qwen', 'qwen3.7-max-preview qwen3.7-max-2026-05-17', 'default low medium high', 'default', 'qwen-budget', [sources.qwen, sources.qwenParams], 'Thinking only. Low/medium/high are labelled token-budget presets, not native effort grades.');
add('qwen', 'qwen3.7-max qwen3.7-max-2026-05-20 qwen3.7-max-2026-06-08 qwen3.7-plus qwen3.7-plus-2026-05-26 qwen3.7-flash qwen3.7-flash-2026-07-15 qwen3.6-plus qwen3.6-plus-2026-04-02 qwen3.6-flash qwen3.6-flash-2026-04-16 qwen3.6-35b-a3b qwen3.6-27b qwen3.5-plus qwen3.5-plus-2026-02-15 qwen3.5-plus-2026-04-20 qwen3.5-flash qwen3.5-flash-2026-02-23 qwen3.5-397b-a17b qwen3.5-122b-a10b qwen3.5-27b qwen3.5-35b-a3b', 'off on low medium high', 'on', 'qwen-budget', [sources.qwen, sources.qwenParams], 'Toggle plus bounded token-budget presets; no native low/medium/high effort enum.');
add('qwen', 'qwen-plus qwen-plus-latest qwen-plus-2025-04-28 qwen-plus-2025-07-14 qwen-plus-2025-12-01 qwen-flash qwen-flash-2025-07-28 qwen3-vl-plus', 'off on low medium high', 'off', 'qwen-budget', [sources.qwen, sources.qwenParams]);
add('qwen', 'qwen3-omni-flash', 'off on', 'off', 'qwen-toggle', [sources.qwen, 'https://help.aliyun.com/zh/model-studio/qwen-omni'], 'Thinking requires text-only output; no documented effort/budget.');
add('qwen', 'qwen3-coder-flash qwen3-coder-flash-2025-07-28', 'off', 'off', 'qwen-toggle', [sources.qwenParams], 'Supplier call repair verified disabled-thinking only; official exact control contract remains unresolved.');
add('qwen', 'qwen-mt-plus qwen-mt-flash qwen-mt-lite qwen-long qwen-max qwen-plus-character qwen-flash-character qwen-plus-2025-01-25', '', '', 'none', [sources.qwenParams], 'Dedicated model documentation does not advertise thinking controls.');
add('google', 'gemini-3.8-flash', 'low medium high', 'medium', 'effort', [sources.gemini, 'https://ai.google.dev/gemini-api/docs/openai#thinking'], 'minimal/off are invalid for this model.');
for (const [name, options, selected] of [
  ['gpt-5.5', 'off low medium high xhigh', 'medium'],
  ['gpt-5.6-luna', 'off low medium high xhigh max', 'medium'], ['gpt-5.6-sol', 'off low medium high xhigh max', 'medium'], ['gpt-5.6-terra', 'off low medium high xhigh max', 'medium'],
  ['gpt-6-luna', 'off low medium high xhigh max', 'medium'], ['gpt-6-sol', 'off low medium high xhigh max', 'medium'],
  ['gpt-6-astra', 'default low medium high xhigh max', 'default'], ['gpt-6.1-sol', 'low medium high xhigh max', 'medium'], ['gpt-6.1-terra', 'off low medium high xhigh max', 'medium'],
] as const) add('openai', name, options, selected, 'openai', [`https://developers.openai.com/api/docs/models/${name}`, sources.openaiTools], 'Official tool+reasoning support requires Responses for these models/grades. Current supplier Chat adapters need separate live proof. Astra has no confirmed model-specific default: omit effort under Auto.');
add('stepfun', 'step-3.5-flash-2603', 'default low high', 'default', 'effort', [sources.step, 'https://platform.stepfun.com/docs/zh/guides/models/step-3.5-flash.md'], 'Default not published; Auto omits effort.');
add('stepfun', 'step-3.7-flash step-5-preview', 'default low medium high', 'default', 'effort', [sources.step], 'Medium is recommended, not a proven server default; Auto omits effort.');
add('xai', 'grok-4.5', 'low medium high', 'high', 'effort', [sources.grok], 'xhigh is an alias of high, not a distinct grade.');
add('xiaomi', 'mimo-v2.6-flash mimo-v2.6-pro', 'off on', 'on', 'thinking', [sources.mimo]);
for (const [names, options, selected] of [
  ['claude-haiku-4-5-20251001', 'off low medium high', 'off'],
  ['claude-opus-4-5', 'off low medium high', 'off'],
  ['claude-opus-4-6 claude-sonnet-4-6', 'off low medium high max', 'off'],
  ['claude-opus-4-7 claude-opus-4-8', 'off low medium high xhigh max', 'off'],
  ['claude-opus-5 claude-sonnet-5', 'off low medium high xhigh max', 'high'],
  ['claude-opus-5-5', 'low medium high xhigh max', 'medium'],
  ['claude-fable-5 claude-fable-5-1 claude-fable-5.1', 'low medium high xhigh max', 'high'],
  ['claude-sonnet-5-5', 'low medium high xhigh max between_tools_low between_tools_medium between_tools_high', 'high'],
] as const) add('anthropic', names, options, selected, names.includes('haiku') ? 'claude-budget' : names === 'claude-opus-4-5' ? 'claude-budget-effort' : 'claude', [sources.claude, sources.claudeModes, sources.claudeBudget], 'Off is a thinking mode, not an effort. Budget presets are not native grades. Only verified Messages SSE routes receive native controls; summaries are public model output, not raw chain of thought.');

function nativeReview(model: TokenToSeaModel): Review {
  if (model.modality !== 'chat') return { options: [], default: null, wire: 'none', sourceUrls: [], note: 'Non-chat model; excluded from the LLM reasoning picker.' };
  const name = String(model.upstreamModel ?? model.model).split('/').at(-1)!.replace(/^official:/, '').toLowerCase();
  const known = profiles.get(`${model.provider}|${name}`);
  if (!known) {
    const prior = model.provider === 'xiaomi' && /^mimo-v2\.5/.test(name);
    return { options: prior ? ['off', 'on'] : null, default: prior ? 'on' : null, wire: prior ? 'thinking' : 'none', sourceUrls: prior ? [sources.mimo, sources.mimoRetired] : [], uncertainty: prior ? 'Official MiMo 2.5 retired on 2026-10-21; supplier weights/routing unverified.' : 'Exact model or snapshot control contract not verified; unknown is not unsupported.' };
  }
  if (model.provider === 'anthropic' && !model.examples?.some(e => e.path === '/v1/messages' && e.mode === 'sse')) return { ...known, wire: 'none', nativeOptions: known.options!, options: [], default: null, uncertainty: 'Chat-only converter has no verified native Messages control mapping.' };
  if (['tokentide/aws/claude-opus-4-6', 'tokentide/aws/claude-opus-4-7', 'tokentide/aws/claude-opus-4-8', 'tokentide/aws/claude-opus-5'].includes(model.model)) return { ...known, wire: 'none', nativeOptions: known.options!, options: [], default: null, uncertainty: 'Live channel returns an Opus 5.5-only thinking restriction for this older labelled Opus; identity is unverified and quarantined from agent selection.' };
  if (model.model === 'lingzhigongfang/global/gpt-6-sol') return { ...known, nativeOptions: known.options!, options: ['off'], default: 'off', uncertainty: 'Live channel restriction: this supplier account rejects reasoning with tools; only none passed.' };
  if (model.provider === 'qwen' && /^qwen3-coder-flash/.test(name)) return { ...known, uncertainty: 'No official exact control contract; channel verified disabled-thinking only.' };
  return known;
}

export function reviewModel(model: TokenToSeaModel): Review {
  const reviewed = nativeReview(model);
  if (model.model === 'qwen-plus-2025-04-28' && reviewed.options) return { ...reviewed, nativeOptions: reviewed.options, options: reviewed.options.filter(value => value !== 'high'), note: `${reviewed.note ?? ''} The 16K budget preset was rejected in two projected requests and is withheld.`.trim() };
  if (!offEvidence.some(row => row.model === model.model) || !reviewed.options) return reviewed;
  const values = reviewed.options.filter(value => value !== 'off');
  return { ...reviewed, nativeOptions: reviewed.nativeOptions ?? reviewed.options, options: values,
    default: reviewed.default && values.includes(reviewed.default) ? reviewed.default : values[0] ?? null,
    note: `${reviewed.note ?? ''} Live relay restriction: disabled still returned public reasoning; off is not offered.`.trim() };
}

/** Expected public request controls, independent of the production capability resolver. */
export function expectedControls(review: Review, selected: string, limit: number, thinkingOnly = false): Record<string, unknown> {
  if (selected === 'default' || review.wire === 'none' || review.wire === 'fixed') return {};
  if (review.wire === 'claude') return selected === 'off' ? { thinking: { type: 'disabled' } } : { thinking: selected.startsWith('between_tools_') ? { type: 'between_tools' } : { type: 'adaptive', display: 'summarized' }, output_config: { effort: selected.replace('between_tools_', '') } };
  if (review.wire === 'claude-budget' || review.wire === 'claude-budget-effort') return selected === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled', budget_tokens: Math.min(selected === 'low' ? 1024 : selected === 'medium' ? 4096 : 16384, limit - 1), display: 'summarized' }, ...(review.wire === 'claude-budget-effort' ? { output_config: { effort: selected } } : {}) };
  if (review.wire === 'qwen-budget') return { ...(!thinkingOnly ? { enable_thinking: selected !== 'off' } : {}), ...(['low', 'medium', 'high'].includes(selected) ? { thinking_budget: Math.min(selected === 'low' ? 1024 : selected === 'medium' ? 4096 : 16384, limit - 1) } : {}) };
  if (review.wire === 'qwen-toggle') return { enable_thinking: selected !== 'off' };
  if (review.wire === 'qwen-effort') return { ...(!thinkingOnly ? { enable_thinking: selected !== 'off' } : {}), ...(selected === 'off' ? {} : { reasoning_effort: selected }) };
  if (review.wire === 'doubao') return { thinking: { type: selected === 'off' ? 'disabled' : 'enabled' }, reasoning_effort: selected === 'off' ? 'minimal' : selected };
  if (review.wire === 'thinking-effort') return { thinking: { type: selected === 'off' ? 'disabled' : 'enabled' }, ...(selected !== 'off' ? { reasoning_effort: selected } : {}) };
  if (review.wire === 'thinking' || review.wire === 'minimax') return { thinking: { type: selected === 'off' ? 'disabled' : review.wire === 'minimax' ? 'adaptive' : 'enabled' } };
  return { reasoning_effort: review.wire === 'openai' && selected === 'off' ? 'none' : selected };
}
