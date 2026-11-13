// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { ReasoningSelect } from '../../src/components/ReasoningSelect';
afterEach(cleanup);
it('uses one shared select, localizes known efforts and preserves unknown provider options', () => {
  const onChange = vi.fn();
  render(<I18nProvider initial="zh-CN"><ReasoningSelect value="high" onChange={onChange}
    options={[{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }, { id: 'adaptive', label: 'Adaptive' }]} /></I18nProvider>);
  const select = screen.getByRole('combobox', { name: '推理强度' });
  fireEvent.click(select);
  expect(screen.getByRole('option', { name: '高' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Adaptive' })).toBeTruthy();
  fireEvent.click(screen.getByRole('option', { name: '低' }));
  expect(onChange).toHaveBeenCalledWith('low');
});
it('preserves budget, fixed-thinking and mode labels instead of calling them effort grades', () => {
  render(<I18nProvider initial="zh-CN"><ReasoningSelect value="low" onChange={()=>{}}
    options={[{id:'low',label:'预算 1,024 token',reasoningControlKind:'budget',reasoningBudgetTokens:1024},{id:'between_tools_high',label:'仅工具间思考 · 高',reasoningControlKind:'mode'},{id:'default',label:'自动思考（不可调节）',reasoningControlKind:'fixed'}]}/></I18nProvider>);
  fireEvent.click(screen.getByRole('combobox'));
  expect(screen.getByRole('option',{name:'预算 1,024 token'})).toBeTruthy();
  expect(screen.getByRole('option',{name:'仅工具间思考 · 高'})).toBeTruthy();
  expect(screen.getByRole('option',{name:'自动思考（不可调节）'})).toBeTruthy();
});
