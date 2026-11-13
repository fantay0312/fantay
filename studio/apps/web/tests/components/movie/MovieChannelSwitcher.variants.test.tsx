// @vitest-environment jsdom
// Folded CLI models (Cursor Agent, Antigravity, Grok Build) and Codex's flag tiers: one family per model,
// effort as the slider and speed behind the panel's speed button (标准 always, then only the tiers the model
// lists), and a concrete id saved before the fold read back as that family. The model menu has no speed rows.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../src/i18n';
import {
  MovieChannelSwitcher,
  agentRunControls,
  nativeChannelOptions,
  selectChannelModel,
  withAgentRunChoice,
} from '../../../src/components/movie/MovieChannelSwitcher';
import type { AgentInfo, AppConfig } from '../../../src/types';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 24, y: 24, width: 240, height: 32, top: 24, right: 264, bottom: 56, left: 24, toJSON: () => ({}) });
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
  vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Antigravity lists `Gemini 4 Argon (High) / (Medium) / (Low)`, and only High ships a fast id.
const agents = [{
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  available: true,
  models: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    {
      id: 'gemini-4-argon',
      label: 'Gemini 4 Argon',
      reasoningOptions: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High', default: true }],
      serviceTierOptions: [{ id: 'fast', label: 'Fast' }],
      variants: [
        { id: 'gemini-4-argon-low', reasoning: 'low' },
        { id: 'gemini-4-argon-medium', reasoning: 'medium' },
        { id: 'gemini-4-argon-high', reasoning: 'high' },
        { id: 'gemini-4-argon-high-fast', reasoning: 'high', serviceTier: 'fast' },
      ],
    },
  ],
}] as AgentInfo[];
const saved = (model: string) => ({ mode: 'daemon', agentId: 'antigravity', agentModels: { antigravity: { model } } }) as unknown as AppConfig;

function show(config: AppConfig, list: AgentInfo[] = agents) {
  const onConfigChange = vi.fn();
  render(<I18nProvider initial="zh-CN"><MovieChannelSwitcher config={config} agents={list} onConfigChange={onConfigChange} onOpenSettings={() => {}} /></I18nProvider>);
  return onConfigChange;
}
function openMenu() {
  fireEvent.keyDown(screen.getByRole('button', { name: 'Antigravity · Gemini 4 Argon' }), { key: 'ArrowDown' });
}
const chipGlyph = (chip: HTMLElement) => chip.querySelector('svg[data-speed]')?.getAttribute('data-speed') ?? null;
/** Opens the run panel from its chip, then the speed menu from the panel's speed button. */
function openSpeedMenu(chip: HTMLElement, speedButton: string) {
  fireEvent.click(chip);
  fireEvent.keyDown(screen.getByRole('button', { name: speedButton }), { key: 'ArrowDown' });
  return screen.getAllByRole('menuitemradio');
}
const rowName = (row: HTMLElement) => row.querySelector('span > span')?.textContent;

describe('folded model families in the composer', () => {
  it('reads a saved concrete id as its family, effort and speed tier', () => {
    const config = saved('gemini-4-argon-high-fast');
    expect(nativeChannelOptions(config, agents).modelId).toBe('gemini-4-argon');
    expect(agentRunControls(config, agents, 'gemini-4-argon')).toMatchObject({
      saved: 'high', recommended: 'high', tier: 'fast', availableTiers: ['fast'], tierEfforts: { fast: ['high'] },
    });
    const low = agentRunControls(saved('gemini-4-argon-low'), agents, 'gemini-4-argon');
    expect(low).toMatchObject({ saved: 'low', tier: null, availableTiers: [] });
  });

  it('writes the family form and drops a tier the new effort cannot run', () => {
    const config = saved('gemini-4-argon-high-fast');
    expect(withAgentRunChoice(config, 'antigravity', { reasoning: 'low' }, agents, 'gemini-4-argon').agentModels?.antigravity)
      .toEqual({ model: 'gemini-4-argon', reasoning: 'low' });
    expect(withAgentRunChoice(config, 'antigravity', { reasoning: 'high' }, agents, 'gemini-4-argon').agentModels?.antigravity)
      .toEqual({ model: 'gemini-4-argon', reasoning: 'high', serviceTier: 'fast' });
    expect(withAgentRunChoice(saved('gemini-4-argon-low'), 'antigravity', { serviceTier: 'fast' }, agents, 'gemini-4-argon').agentModels?.antigravity)
      .toEqual({ model: 'gemini-4-argon', reasoning: 'low' });
    expect(selectChannelModel(config, agents, 'agent:antigravity', 'claude-sonnet-5').agentModels?.antigravity)
      .toEqual({ model: 'claude-sonnet-5', reasoning: 'high' });
  });

  it('shows the family with its effort and one bolt in the chip, without rewriting the saved id', () => {
    const onConfigChange = show(saved('gemini-4-argon-high-fast'));
    const chip = screen.getByRole('button', { name: '推理强度 · 高 · 速度 · 快速' });
    expect(chipGlyph(chip)).toBe('fast');
    expect(chip.textContent).toBe('高');
    expect(onConfigChange).not.toHaveBeenCalled();

    const rows = openSpeedMenu(chip, '速度 · 快速');
    expect(rows.map(rowName)).toEqual(['标准', '快速']);
    expect(rows[1]!.getAttribute('aria-checked')).toBe('true');
    // No provider copy for a folded fast id: the line says what the tier is for.
    expect(rows[1]!.textContent).toContain('更快的响应，用量更多');
    fireEvent.click(rows[0]!);
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({
      agentModels: { antigravity: { model: 'gemini-4-argon', reasoning: 'high' } },
    }));
  });

  it('keeps speed out of the model menu and off the model chip', () => {
    show(saved('gemini-4-argon-high-fast'));
    const trigger = screen.getByRole('button', { name: 'Antigravity · Gemini 4 Argon' });
    expect(trigger.querySelector('svg[data-speed]')).toBeNull();
    openMenu();
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByText('速度')).toBeNull();
    expect(within(menu).queryByRole('menuitemcheckbox')).toBeNull();
    expect(within(menu).queryByText(/快速/)).toBeNull();
  });

  it('keeps Grok Fast at every effort, since its ids encode only the speed tier', () => {
    // As foldGrokBuildModels emits it: effort stays a `--effort` flag on the family.
    const grok = [{
      id: 'grok-build', name: 'Grok Build', bin: 'grok', available: true,
      models: [{
        id: 'grok-4.7', label: 'Grok 4.7',
        reasoningOptions: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium', default: true }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'XHigh' }],
        serviceTierOptions: [{ id: 'fast', label: 'Fast' }],
        variants: [{ id: 'grok-4.7' }, { id: 'grok-4.7-build-fast', serviceTier: 'fast' }],
      }],
    }] as AgentInfo[];
    const config = { mode: 'daemon', agentId: 'grok-build', agentModels: { 'grok-build': { model: 'grok-4.7-build-fast', reasoning: 'high' } } } as unknown as AppConfig;
    expect(nativeChannelOptions(config, grok).modelId).toBe('grok-4.7');
    expect(agentRunControls(config, grok, 'grok-4.7')).toMatchObject({
      saved: 'high', tier: 'fast', availableTiers: ['fast'], tierEfforts: { fast: ['low', 'medium', 'high', 'xhigh'] },
    });
    expect(withAgentRunChoice(config, 'grok-build', { reasoning: 'xhigh' }, grok, 'grok-4.7').agentModels?.['grok-build'])
      .toEqual({ model: 'grok-4.7', reasoning: 'xhigh', serviceTier: 'fast' });
  });

  it('keeps the 快速 row in place but off-limits at an effort without a fast id', () => {
    const onConfigChange = show(saved('gemini-4-argon-low'));
    const chip = screen.getByRole('button', { name: '推理强度 · 低 · 速度 · 标准' });
    expect(chipGlyph(chip)).toBeNull();

    const rows = openSpeedMenu(chip, '速度 · 标准');
    expect(rows[0]!.getAttribute('aria-checked')).toBe('true');
    const fast = rows[1]!;
    expect(fast.getAttribute('aria-checked')).toBe('false');
    expect(fast.hasAttribute('data-disabled')).toBe(true);
    expect(fast.textContent).toContain('仅「高」强度可用');
    fireEvent.click(fast);
    expect(onConfigChange).not.toHaveBeenCalled();
  });
});

describe('the run panel beside the model chip', () => {
  // `codex debug models` on 2026-11-09: gpt-6.1-sol lists both flag tiers, gpt-6.1-terra only priority.
  const codex = [{
    id: 'codex', name: 'Codex', bin: 'codex', available: true,
    models: [
      { id: 'default', label: 'Default' },
      {
        id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol',
        reasoningOptions: [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium', default: true }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'XHigh' }],
        serviceTierOptions: [
          { id: 'priority', label: 'Fast', description: '2x speed, increased usage' },
          { id: 'ultrafast', label: 'Ultrafast', description: 'The fastest available responses for latency-sensitive work.' },
        ],
      },
    ],
  }] as AgentInfo[];
  const codexConfig = (choice: Record<string, string>) => ({ mode: 'daemon', agentId: 'codex', agentModels: { codex: { model: 'gpt-6.1-sol', ...choice } } }) as unknown as AppConfig;

  it('lists 标准 / 快速 / 超快 for a Codex model with both tiers, with their localized costs', () => {
    const onConfigChange = show(codexConfig({ reasoning: 'high' }), codex);
    const chip = screen.getByRole('button', { name: '推理强度 · 高 · 速度 · 标准' });
    const rows = openSpeedMenu(chip, '速度 · 标准');
    expect(rows.map(rowName)).toEqual(['标准', '快速', '超快']);
    expect(rows.map(row => row.textContent)).toEqual([
      '标准默认速度', '快速2 倍速度，用量更多', '超快最快的响应，适合对延迟敏感的工作',
    ]);
    expect(rows.map(row => row.querySelector('svg')?.getAttribute('data-speed'))).toEqual(['standard', 'fast', 'ultrafast']);
    fireEvent.click(rows[2]!);
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({
      agentModels: { codex: { model: 'gpt-6.1-sol', reasoning: 'high', serviceTier: 'ultrafast' } },
    }));
  });

  it('leads the chip with two bolts while 超快 is on', () => {
    show(codexConfig({ reasoning: 'xhigh', serviceTier: 'ultrafast' }), codex);
    const chip = screen.getByRole('button', { name: '推理强度 · 极高 · 速度 · 超快' });
    expect(chipGlyph(chip)).toBe('ultrafast');
    fireEvent.click(chip);
    expect(screen.getByRole('button', { name: '速度 · 超快' }).querySelector('svg')?.getAttribute('data-speed')).toBe('ultrafast');
  });

  it('offers only 标准 when the model lists no tier', () => {
    show({ mode: 'daemon', agentId: 'antigravity', agentModels: { antigravity: { model: 'claude-sonnet-5' } } } as unknown as AppConfig, [{
      ...agents[0]!,
      models: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', reasoningOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', default: true }] }],
    }] as AgentInfo[]);
    const rows = openSpeedMenu(screen.getByRole('button', { name: '推理强度 · 高 · 速度 · 标准' }), '速度 · 标准');
    expect(rows.map(rowName)).toEqual(['标准']);
  });

  it('gives a tiers-only model the speed panel without a slider, and no chip to a model with neither', () => {
    const cursor = [{
      id: 'cursor-agent', name: 'Cursor Agent', bin: 'cursor-agent', available: true,
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'composer-2', label: 'Composer 2', serviceTierOptions: [{ id: 'fast', label: 'Fast' }], variants: [{ id: 'composer-2' }, { id: 'composer-2-fast', serviceTier: 'fast' }] },
      ],
    }] as AgentInfo[];
    const config = (model: string, serviceTier?: string) => ({ mode: 'daemon', agentId: 'cursor-agent', agentModels: { 'cursor-agent': { model, ...(serviceTier ? { serviceTier } : {}) } } }) as unknown as AppConfig;
    const onConfigChange = show(config('composer-2', 'fast'), cursor);
    const chip = screen.getByRole('button', { name: '速度设置 · 快速' });
    expect(chip.textContent).toBe('快速');
    expect(chipGlyph(chip)).toBe('fast');
    fireEvent.click(chip);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByText('速度', { selector: 'span' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: '速度 · 快速' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getAllByRole('menuitemradio')[0]!);
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ agentModels: { 'cursor-agent': { model: 'composer-2' } } }));
    cleanup();

    show(config('auto'), cursor);
    expect(screen.queryByRole('button', { name: /推理强度|速度/ })).toBeNull();
  });

  it('opens the model menu from the model name under the title', () => {
    show(saved('gemini-4-argon-high'));
    fireEvent.click(screen.getByRole('button', { name: '推理强度 · 高 · 速度 · 标准' }));
    expect(screen.getByRole('slider', { name: '推理强度' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '切换模型 · Gemini 4 Argon' }));
    expect(screen.queryByRole('slider')).toBeNull();
    expect(within(screen.getByRole('menu', { name: 'Antigravity' })).getByRole('menuitemradio', { name: 'Gemini 4 Argon' })).toBeTruthy();
  });

  it('offers reset only while the saved effort differs from the recommended one', () => {
    const onConfigChange = show(saved('gemini-4-argon-low'));
    fireEvent.click(screen.getByRole('button', { name: '推理强度 · 低 · 速度 · 标准' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复默认强度' }));
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ agentModels: { antigravity: { model: 'gemini-4-argon' } } }));
    cleanup();
    show(saved('gemini-4-argon-high'));
    fireEvent.click(screen.getByRole('button', { name: '推理强度 · 高 · 速度 · 标准' }));
    expect(screen.queryByRole('button', { name: '恢复默认强度' })).toBeNull();
  });
});
