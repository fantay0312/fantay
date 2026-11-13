// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../src/i18n';
import { MovieChannelSwitcher } from '../../../src/components/movie/MovieChannelSwitcher';
import type { AgentInfo, AppConfig } from '../../../src/types';
beforeEach(()=>{
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:24,y:24,width:240,height:32,top:24,right:264,bottom:56,left:24,toJSON:()=>({})});
  vi.spyOn(document.documentElement,'clientWidth','get').mockReturnValue(1024);
  vi.spyOn(document.documentElement,'clientHeight','get').mockReturnValue(768);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
const config = { mode: 'daemon', agentId: 'tokentosea', agentModels: { tokentosea: { model: 'fixture' } } } as unknown as AppConfig;
function show(reasoningOptions: NonNullable<AgentInfo['models']>[number]['reasoningOptions']) {
  const onConfigChange = vi.fn();
  const agents = [{ id: 'tokentosea', name: 'TokenToSea', available: true, models: [{ id: 'fixture', label: 'Fixture', reasoningOptions }] }] as AgentInfo[];
  render(<I18nProvider initial="zh-CN"><MovieChannelSwitcher config={config} agents={agents} onConfigChange={onConfigChange} onOpenSettings={()=>{}}/></I18nProvider>);
  return onConfigChange;
}
it('shows a fixed-thinking badge instead of silently hiding the sole default option', () => {
  show([{ id: 'default', label: '自动思考（不可调节）', default: true, reasoningControlKind: 'fixed' }]);
  expect((screen.getByRole('button', { name: '思考设置 · 自动思考' }) as HTMLButtonElement).disabled).toBe(true);
});
it('makes a relay-only on mode explicit instead of pretending it has an adjustable switch', () => {
  show([{ id: 'on', label: '仅开启思考（当前通道限制）', default: true, reasoningControlKind: 'fixed' }]);
  expect((screen.getByRole('button', { name: '思考设置 · 仅开启思考' }) as HTMLButtonElement).disabled).toBe(true);
});
it('selects token budgets and between-tools modes as named choices without a quality slider', async () => {
  const onConfigChange = show([{ id: 'off', label: '关闭', default: true, reasoningControlKind: 'toggle' }, { id: 'low', label: '预算 1,024 token', reasoningControlKind: 'budget', reasoningBudgetTokens: 1024 }, { id: 'between_tools_high', label: '仅工具间思考 · 高', reasoningControlKind: 'mode' }]);
  fireEvent.keyDown(screen.getByRole('button', { name: '思考设置 · 关闭' }), { key: 'ArrowDown' });
  const budget = await screen.findByRole('menuitemradio', { name: '预算 1,024 token' });
  expect(await screen.findByRole('menuitemradio', { name: '仅工具间思考 · 高' })).toBeTruthy();
  expect(screen.queryByRole('slider')).toBeNull();
  fireEvent.click(budget);
  expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ agentModels: { tokentosea: { model: 'fixture', reasoning: 'low' } } }));
});
it('uses the RunControl slider panel for TokenToSea effort ladders instead of the plain list menu', () => {
  const reasoningOptions = [
    { id: 'low', label: '低', reasoningControlKind: 'effort' as const },
    { id: 'medium', label: '中', default: true, reasoningControlKind: 'effort' as const },
    { id: 'high', label: '高', reasoningControlKind: 'effort' as const },
    { id: 'xhigh', label: '超高', reasoningControlKind: 'effort' as const },
    { id: 'max', label: '最高', reasoningControlKind: 'effort' as const },
  ];
  const savedHigh = { mode: 'daemon', agentId: 'tokentosea', agentModels: { tokentosea: { model: 'supplier:tokentide/aws/claude-opus-5-5', reasoning: 'high' } } } as unknown as AppConfig;
  const agents = [{ id: 'tokentosea', name: 'TokenToSea', available: true, models: [{ id: 'supplier:tokentide/aws/claude-opus-5-5', label: 'TokenTide · Claude Opus 5.5', reasoningOptions }] }] as AgentInfo[];
  const onConfigChange = vi.fn();
  render(<I18nProvider initial="zh-CN"><MovieChannelSwitcher config={savedHigh} agents={agents} onConfigChange={onConfigChange} onOpenSettings={() => {}} /></I18nProvider>);

  const chip = screen.getByRole('button', { name: '推理强度 · 高 · 速度 · 标准' });
  fireEvent.click(chip);

  const slider = screen.getByRole('slider', { name: '推理强度' }) as HTMLInputElement;
  expect(slider.value).toBe('2');
  expect(slider.max).toBe('4');
  expect(screen.getByText('推荐')).toBeTruthy();
  expect(screen.getByText('更深的推理，适合复杂问题')).toBeTruthy();
  expect(screen.getByRole('button', { name: '切换模型 · TokenTide · Claude Opus 5.5' })).toBeTruthy();

  fireEvent.change(slider, { target: { value: '4' } });
  expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({
    agentModels: { tokentosea: { model: 'supplier:tokentide/aws/claude-opus-5-5', reasoning: 'max' } },
  }));
});
it('keeps the RunControl slider for Claude Sonnet 5.5 while offering between-tools scope pills', () => {
  const reasoningOptions = [
    { id: 'low', label: '低', reasoningControlKind: 'effort' as const },
    { id: 'medium', label: '中', reasoningControlKind: 'effort' as const },
    { id: 'high', label: '高', default: true, reasoningControlKind: 'effort' as const },
    { id: 'xhigh', label: '超高', reasoningControlKind: 'effort' as const },
    { id: 'max', label: '最高', reasoningControlKind: 'effort' as const },
    { id: 'between_tools_low', label: '仅工具间思考 · 低', reasoningControlKind: 'mode' as const },
    { id: 'between_tools_medium', label: '仅工具间思考 · 中', reasoningControlKind: 'mode' as const },
    { id: 'between_tools_high', label: '仅工具间思考 · 高', reasoningControlKind: 'mode' as const },
  ];
  const onConfigChange = show(reasoningOptions);
  fireEvent.click(screen.getByRole('button', { name: '推理强度 · 高 · 速度 · 标准' }));
  expect(screen.getByRole('slider', { name: '推理强度' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '仅工具间' }));
  expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({
    agentModels: { tokentosea: { model: 'fixture', reasoning: 'between_tools_high' } },
  }));
});
it('accelerates particle flow monotonically as thinking effort increases and pauses when off', () => {
  const reasoningOptions = [
    { id: 'off', label: '关闭', reasoningControlKind: 'toggle' as const },
    { id: 'low', label: '低', reasoningControlKind: 'effort' as const },
    { id: 'medium', label: '中', default: true, reasoningControlKind: 'effort' as const },
    { id: 'high', label: '高', reasoningControlKind: 'effort' as const },
    { id: 'xhigh', label: '极高', reasoningControlKind: 'effort' as const },
    { id: 'max', label: '最高', reasoningControlKind: 'effort' as const },
    { id: 'ultra', label: 'Ultra', reasoningControlKind: 'effort' as const },
  ];
  const agents = [{ id: 'codex', name: 'Codex', available: true, models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', reasoningOptions }] }] as AgentInfo[];
  const periodFor = (reasoning: string): number => {
    cleanup();
    const cfg = { mode: 'daemon', agentId: 'codex', agentModels: { codex: { model: 'gpt-6-astra', reasoning } } } as unknown as AppConfig;
    render(<I18nProvider initial="zh-CN"><MovieChannelSwitcher config={cfg} agents={agents} onConfigChange={() => {}} onOpenSettings={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: /推理强度/ }));
    const slider = document.querySelector('[data-effort-level]') as HTMLElement;
    return Number.parseFloat(slider.style.getPropertyValue('--effort-flow-duration'));
  };

  expect(periodFor('off')).toBe(0);
  const low = periodFor('low');
  const medium = periodFor('medium');
  const high = periodFor('high');
  const xhigh = periodFor('xhigh');
  const max = periodFor('max');
  const ultra = periodFor('ultra');
  expect(low).toBeGreaterThan(medium);
  expect(medium).toBeGreaterThan(high);
  expect(high).toBeGreaterThan(xhigh);
  expect(xhigh).toBeGreaterThan(max);
  expect(max).toBeGreaterThan(ultra);
  expect(ultra).toBeGreaterThan(0);
});
