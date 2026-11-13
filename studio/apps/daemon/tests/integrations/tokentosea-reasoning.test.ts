import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyTokenToSeaReasoning, resolveTokenToSeaReasoning, tokenToSeaReasoningOptions, tokenToSeaInterleavedReasoning } from '../../src/integrations/tokentosea-reasoning.js';
import type { TokenToSeaModel } from '../../src/integrations/tokentosea-runtime.js';
import { isTokenToSeaAgentModel } from '../../src/integrations/tokentosea-runtime.js';
const native = (provider: string, model: string, body: Record<string, unknown> = {}): TokenToSeaModel => ({ id: `supplier:fixture/global/${model}`, model: `fixture/global/${model}`, upstreamModel: model, provider, executionKind: 'official', modality: 'chat', priceVersion: '1', maxOutputTokens: 32768, examples: [{ path: '/v1/chat/completions', mode: 'sse', body }] });
const ids = (model: TokenToSeaModel) => tokenToSeaReasoningOptions(model).map(option => option.id);
describe('TokenToSea native reasoning protocols', () => {
  it('withholds only the dated Qwen 16K preset that the live endpoint refused', () => {
    expect(ids({ ...native('qwen', 'qwen-plus-2025-04-28'), model: 'qwen-plus-2025-04-28' })).toEqual(['off', 'on', 'low', 'medium']);
    expect(ids(native('qwen', 'qwen-plus-latest'))).toContain('high');
  });
  it.each([['qwen', 'qwen3.8-flash'], ['xiaomi', 'mimo-v2.6-pro']])('preserves %s reasoning_content through tool rounds', (provider, name) => {
    expect(tokenToSeaInterleavedReasoning(native(provider!, name!))).toBe(true);
  });
  it('withholds a relay off mode that remained thinking in live controls, preserving working official off', () => {
    const relay = { ...native('deepseek', 'deepseek-v4-pro-0813'), model: 'lingzhigongfang/cn-stable/deepseek-v4-pro-0813' };
    expect(ids(relay)).toEqual(['low', 'high', 'max']); expect(resolveTokenToSeaReasoning(relay, 'off')).toBe('high');
    expect(ids(native('deepseek', 'deepseek-v4-pro'))).toContain('off');
    const mimo = { ...native('xiaomi', 'mimo-v2.6-flash'), model: 'lingzhigongfang/cn-stable/mimo-v2.6-flash' };
    expect(tokenToSeaReasoningOptions(mimo)).toEqual([{ id: 'on', label: '仅开启思考（当前通道限制）', reasoningControlKind: 'fixed', default: true }]);
  });
  it.each([
    ['zhipu', 'autoglm-phone'], ['zhipu', 'glm-4v-flash'], ['zhipu', 'glm-4.1v-thinking-flash'], ['zhipu', 'glm-4.1v-thinking-flashx'],
    ['stepfun', 'step-audio-2'], ['stepfun', 'step-audio-2-mini'], ['stepfun', 'stepaudio-2.5-chat'], ['stepfun', 'step-audio-r1.5'],
  ])('requires a dedicated agent adapter for %s/%s', (provider, name) => {
    expect(isTokenToSeaAgentModel({ ...native(provider!, name!), billingMode: 'token', verifiedEndpoints: ['/v1/chat/completions'] })).toBe(false);
  });
  it('retains the audio-capable language model with a verified standard text/tool stream', () => {
    expect(isTokenToSeaAgentModel({ ...native('stepfun', 'stepaudio-3-chat-preview', { modalities: ['text'] }), billingMode: 'token', verifiedEndpoints: ['/v1/chat/completions'] })).toBe(true);
  });
  it('does not offer a Claude Chat converter before its native thinking/tool mapping is verified', () => {
    expect(isTokenToSeaAgentModel({ ...native('anthropic', 'claude-sonnet-5'), billingMode: 'token', verifiedEndpoints: ['/v1/chat/completions'] })).toBe(false);
  });
  it('honors the verified combined route ceiling for a legacy Qwen model while retaining its budget', () => {
    const model = { ...native('qwen', 'qwen-plus'), outputLimitField: 'max_completion_tokens' };
    const body: Record<string, unknown> = { max_tokens: 8192 };
    applyTokenToSeaReasoning(model, 'medium', body);
    expect(body).toEqual({ max_completion_tokens: 8192, enable_thinking: true, thinking_budget: 4096 });
  });
  it('keeps native Messages max_tokens even if a catalogue carries a Chat ceiling field', () => {
    const model = { ...native('anthropic', 'claude-opus-5-5'), outputLimitField: 'max_completion_tokens', examples: [{ path: '/v1/messages', mode: 'sse', body: {} }] };
    const body: Record<string, unknown> = { max_tokens: 8192 };
    applyTokenToSeaReasoning(model, 'low', body);
    expect(body).toEqual({ max_tokens: 8192, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } });
  });
  it.each(['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5'])('quarantines only the live-conflicting TokenTide identity for %s', name => {
    const model = { ...native('anthropic', name), billingMode: 'token', model: `tokentide/aws/${name}`, examples: [{ path: '/v1/messages', mode: 'sse', body: {} }] };
    expect(ids(model)).toEqual([]); expect(isTokenToSeaAgentModel(model)).toBe(false);
    const verified = { ...model, model: `suanlizhixuan/claude/${name}` };
    expect(ids(verified)).toContain('off'); expect(isTokenToSeaAgentModel(verified)).toBe(true);
  });
  it('withholds GPT Terra off only on the relay that returned public reasoning for none', () => {
    const model = { ...native('openai', 'gpt-5.6-terra'), model: 'suanlizhixuan/gpt/gpt-5.6-terra' };
    expect(ids(model)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveTokenToSeaReasoning(model, 'off')).toBe('medium');
    const body: Record<string, unknown> = { max_tokens: 2048, reasoning_effort: 'none' };
    applyTokenToSeaReasoning(model, resolveTokenToSeaReasoning(model, 'off'), body);
    expect(body.reasoning_effort).toBe('medium');
    expect(ids(native('openai', 'gpt-5.6-terra'))).toContain('off');
  });
  it('honors the catalog combined ceiling for omni models without inventing thinking controls', () => {
    const model = { ...native('qwen', 'future-omni-model', { modalities: ['text'] }), outputLimitField: 'max_completion_tokens' };
    const body: Record<string, unknown> = { max_tokens: 512 };
    applyTokenToSeaReasoning(model, 'off', body);
    expect(body).toEqual({ max_completion_tokens: 512, modalities: ['text'] });
    expect(ids(model)).toEqual([]);
  });
  it.each(['qwen3-coder-flash', 'qwen3-coder-flash-2025-07-28'])('keeps the verified disabled-thinking budget for %s', name => {
    const model = native('qwen', name, { enable_thinking: false });
    expect(ids(model)).toEqual(['off']);
    const body: Record<string, unknown> = { max_tokens: 512 };
    applyTokenToSeaReasoning(model, 'off', body);
    expect(body).toEqual({ max_completion_tokens: 512, enable_thinking: false });
  });
  it('uses the live-verified no-reasoning tool mode only for the constrained supplier account', () => {
    const model = { ...native('openai', 'gpt-6-sol'), model: 'lingzhigongfang/global/gpt-6-sol' };
    expect(ids(model)).toEqual(['off']); expect(resolveTokenToSeaReasoning(model, 'high')).toBe('off');
    const body: Record<string, unknown> = { max_tokens: 512 };
    applyTokenToSeaReasoning(model, 'off', body);
    expect(body).toEqual({ max_completion_tokens: 512, reasoning_effort: 'none' });
    expect(ids({ ...model, model: 'tokentide/gpt/gpt-6-sol' })).toContain('high');
  });
  it('keeps the verified output field and drops unsupported parallel controls for Kimi K3.1', () => {
    const model = native('kimi', 'kimi-k3.1-pro', { max_completion_tokens: 512, reasoning_effort: 'low' });
    const body: Record<string, unknown> = { max_tokens: 512, parallel_tool_calls: false };
    applyTokenToSeaReasoning(model, 'low', body);
    expect(body).toEqual({ max_completion_tokens: 512, reasoning_effort: 'low' });
    expect(tokenToSeaInterleavedReasoning(model)).toBe(true);
  });
  it('preserves MiniMax M3.1 reasoning between tool rounds and uses its supported automatic tool mode', () => {
    const model = native('minimax', 'MiniMax-M3.1-Flash');
    const body: Record<string, unknown> = { max_tokens: 512, parallel_tool_calls: false, tool_choice: 'required' };
    applyTokenToSeaReasoning(model, 'low', body);
    expect(body).toEqual({ max_tokens: 512, reasoning_effort: 'low', tool_choice: 'auto' });
    expect(tokenToSeaInterleavedReasoning(model)).toBe(true);
  });
  it('recognizes dated supplier aliases and binds DeepSeek controls without global medium aliases', () => {
    const model = native('deepseek', 'deepseek-v4.1-flash-1017');
    expect(ids(model)).toEqual(['off', 'low', 'high', 'max']);
    expect(resolveTokenToSeaReasoning(model, 'medium')).toBe('high');
    const wire = { max_tokens: 4096, thinking: { type: 'disabled' }, reasoning_effort: 'max', enable_thinking: false, extra_body: { thinking_budget: 99999, keep: true } } as Record<string, unknown>;
    applyTokenToSeaReasoning(model, 'low', wire);
    expect(wire).toEqual({ max_tokens: 4096, thinking: { type: 'enabled' }, reasoning_effort: 'low', extra_body: { keep: true } });
  });
  it('retains MiniMax medium/xhigh and never advertises unsupported off', () => {
    const model = native('minimax', 'MiniMax-M3.1-Flash');
    expect(ids(model)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveTokenToSeaReasoning(model, 'medium')).toBe('medium');
    expect(resolveTokenToSeaReasoning(model, 'off')).toBe('max');
    const wire: Record<string, unknown> = {}; applyTokenToSeaReasoning(model, 'medium', wire);
    expect(wire).toEqual({ reasoning_effort: 'medium' });
  });
  it.each(['kimi-k3', 'supplier/group/kimi-k3'])('uses the verified Kimi K3 output field for %s', name => {
    const wire: Record<string, unknown> = { max_tokens: 2048 };
    applyTokenToSeaReasoning(native('kimi', name), 'low', wire);
    expect(wire).toEqual({ max_completion_tokens: 2048, reasoning_effort: 'low' });
  });
  it.each(['qwen3.7-max-preview', 'qwen3.7-max-2026-05-17'])('keeps automatic thinking without inventing effort for %s', name => {
    const wire: Record<string, unknown> = { max_tokens: 2048 };
    applyTokenToSeaReasoning(native('qwen', name, { enable_thinking: true }), 'default', wire);
    expect(wire).toEqual({ max_completion_tokens: 2048 });
  });
  it('keeps Kimi K3 effort, K2.6 toggle and K2.7 fixed thinking distinct', () => {
    const k3 = native('kimi', 'kimi-k3'), k26 = native('kimi', 'kimi-k2.6'), k27 = native('kimi', 'kimi-k2.7-code-highspeed');
    expect(ids(k3)).toEqual(['low', 'high', 'max']); expect(resolveTokenToSeaReasoning(k3, 'off')).toBe('max');
    expect(ids(k26)).toEqual(['off', 'on']); expect(ids(k27)).toEqual(['default']);
    const on: Record<string, unknown> = {}, fixed: Record<string, unknown> = { thinking: { type: 'disabled' }, reasoning_effort: 'off' };
    applyTokenToSeaReasoning(k26, 'on', on); applyTokenToSeaReasoning(k27, 'default', fixed);
    expect(on).toEqual({ thinking: { type: 'enabled' } }); expect(fixed).toEqual({});
  });
  it('does not disable GLM 5.3, while GLM 5.2 retains its supported off/high/max choices', () => {
    const model = native('zhipu', 'glm-5.3-flashx');
    expect(ids(model)).toEqual(['low', 'high', 'max']); expect(resolveTokenToSeaReasoning(model, 'off')).toBe('max');
    expect(ids(native('zhipu', 'glm-5.2'))).toEqual(['off', 'high', 'max']);
    const wire: Record<string, unknown> = {}; applyTokenToSeaReasoning(model, 'low', wire);
    expect(wire).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  });
  it('uses Qwen toggles and a combined output ceiling, except for thinking-only versions', () => {
    const model = native('qwen', 'qwen3.8-flash', { enable_thinking: false });
    expect(ids(model)).toEqual(['off', 'low', 'medium', 'xhigh']);
    expect(ids(native('qwen', 'qwen3.7-max-preview', { enable_thinking: true }))).toEqual(['default', 'low', 'medium', 'high']);
    expect(ids(native('qwen', 'qwen3-coder-flash', { enable_thinking: false }))).toEqual(['off']);
    const wire: Record<string, unknown> = { max_tokens: 8192, max_completion_tokens: 999999, reasoning_effort: 'high' };
    applyTokenToSeaReasoning(model, 'on', wire);
    expect(wire).toEqual({ max_completion_tokens: 8192, enable_thinking: true, reasoning_effort: 'xhigh' });
  });
  it('offers Doubao effective grades without duplicating provider spelling aliases', () => {
    expect(ids(native('doubao', 'doubao-seed-2-1-pro-260915', { thinking: { type: 'disabled' } }))).toEqual(['off', 'low', 'medium', 'high']);
    const model = native('doubao', 'doubao-seed-evolving');
    expect(ids(model)).toEqual(['off', 'low', 'medium', 'high']);
    const wire: Record<string, unknown> = { max_tokens: 4096 }; applyTokenToSeaReasoning(model, 'xhigh', wire);
    expect(wire).toEqual({ max_completion_tokens: 4096, thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });
  it('uses documented Step grades and leaves its undocumented default to the provider', () => {
    const model = native('stepfun', 'step-3.7-flash', { reasoning_effort: 'low' });
    expect(ids(model)).toEqual(['default', 'low', 'medium', 'high']); expect(resolveTokenToSeaReasoning(model, 'high')).toBe('high');
    const wire: Record<string, unknown> = { reasoning_effort: 'high', thinking: { type: 'enabled' } };
    applyTokenToSeaReasoning(model, 'default', wire); expect(wire).toEqual({});
  });
  it('does not infer Claude Messages controls for an unverified Chat converter or non-chat models', () => {
    expect(ids(native('anthropic', 'claude-fable-5'))).toEqual([]);
    expect(ids({ ...native('deepseek', 'deepseek-flash'), modality: 'video' })).toEqual([]);
  });
  it('uses the native adaptive-thinking controls for Haiku 5.5', () => {
    const model = { ...native('anthropic', 'claude-haiku-5-5'), examples: [{ path: '/v1/messages', mode: 'sse', body: {} }] };
    expect(ids(model)).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveTokenToSeaReasoning(model)).toBe('medium');
    const wire: Record<string, unknown> = { temperature: 0.4 };
    applyTokenToSeaReasoning(model, 'max', wire);
    expect(wire).toEqual({ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'max' } });
    applyTokenToSeaReasoning(model, 'off', wire);
    expect(wire).toEqual({ thinking: { type: 'disabled' } });
  });
  it('uses native Claude effort per model without treating old manual budgets as adaptive', () => {
    const claude = (name: string) => ({ ...native('anthropic', name), verifiedEndpoints: ['/v1/messages'], examples: [{ path: '/v1/messages', mode: 'sse', body: {} }] });
    const modern = claude('claude-opus-5-5');
    expect(ids(modern)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveTokenToSeaReasoning(modern, 'off')).toBe('medium');
    expect(ids(claude('claude-opus-4-6'))).toEqual(['off', 'low', 'medium', 'high', 'max']);
    expect(ids(claude('claude-haiku-4-5-20251001'))).toEqual(['off', 'low', 'medium', 'high']);
    const wire: Record<string, unknown> = { max_tokens: 8192, temperature: 0.3, thinking: { type: 'disabled' }, output_config: { effort: 'max' } };
    applyTokenToSeaReasoning(modern, 'low', wire);
    expect(wire).toEqual({ max_tokens: 8192, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'low' } });
    const manual: Record<string, unknown> = { max_tokens: 8192 };
    applyTokenToSeaReasoning(claude('claude-opus-4-5'), 'high', manual);
    expect(manual).toEqual({ max_tokens: 8192, thinking: { type: 'enabled', budget_tokens: 8191, display: 'summarized' }, output_config: { effort: 'high' } });
  });
  it('keeps multimodal language models in text output mode without invoking speech generation', () => {
    const model = native('stepfun', 'stepaudio-3-chat-preview', { modalities: ['text'] });
    const wire: Record<string, unknown> = { modalities: ['audio'], audio: { voice: 'fake' }, max_tokens: 1024, max_output_tokens: 99999 };
    applyTokenToSeaReasoning(model, 'default', wire);
    expect(wire).toEqual({ modalities: ['text'], max_tokens: 1024 });
  });
  it('enforces structural reasoning invariants across the captured catalogue without leaking forged controls', () => {
    const catalog = JSON.parse(readFileSync(new URL('../fixtures/tokentosea-reasoning-catalog-20261105.json', import.meta.url), 'utf8')) as { models: Array<TokenToSeaModel & { selectable: boolean }> };
    expect(new Set(catalog.models.map(model => model.id)).size).toBe(catalog.models.length);
    for (const model of catalog.models) {
      const options = tokenToSeaReasoningOptions(model);
      if (model.modality !== 'chat') { expect(options).toEqual([]); continue; }
      if (options.length) expect(options.filter(option => option.default)).toHaveLength(1);
      for (const option of options) {
        const body: Record<string, unknown> = {
          max_tokens: model.maxOutputTokens ?? 4096,
          thinking: { type: 'forged' },
          reasoning_effort: 'forged',
          enable_thinking: 'forged',
          thinking_budget: -1,
          reasoning: { effort: 'forged' },
          extra_body: { google: { thinking_config: { thinking_level: 'forged' } }, thinking: { type: 'forged' } },
          output_config: { effort: 'forged' },
        };
        applyTokenToSeaReasoning(model, option.id, body);
        expect(body).not.toHaveProperty('extra_body');
        expect(JSON.stringify(body)).not.toContain('forged');
        expect(['max_tokens', 'max_completion_tokens', 'max_output_tokens'].filter(field => field in body)).toHaveLength(1);
        if (option.reasoningControlKind === 'budget') {
          expect(option.reasoningBudgetTokens).toBeGreaterThanOrEqual(1024);
          expect(body).not.toHaveProperty('reasoning_effort');
        }
      }
    }
  });
});
