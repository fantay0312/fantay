// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CUSTOM_MODEL_SENTINEL,
  groupModelsByCompany,
  isCustomModel,
  modelVersionLabel,
  orderModelOptionsByAvailability,
  renderModelOptions,
  SearchableModelSelect,
} from '../../src/components/modelOptions';
import type { AgentModelOption } from '../../src/types';

function renderOptions(models: AgentModelOption[]): string {
  return renderToStaticMarkup(<select>{renderModelOptions(models)}</select>);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('modelVersionLabel', () => {
  it('drops the company token a brand mark already carries', () => {
    expect(modelVersionLabel('claude-fable-5', 'claude-fable-5')).toBe('fable-5');
    expect(modelVersionLabel('deepseek-v4-pro', 'deepseek-v4-pro')).toBe('v4-pro');
    expect(modelVersionLabel('claude-opus-4.6')).toBe('opus-4.6');
  });

  it('keeps ids whose leading token IS the model family', () => {
    // Stripping here would leave `5` / nothing — a name that identifies no
    // model at all, which is worse than repeating the company.
    expect(modelVersionLabel('gpt-5-mini', 'gpt-5-mini')).toBe('gpt-5-mini');
    expect(modelVersionLabel('grok-4.5', 'grok-4.5')).toBe('grok-4.5');
    expect(modelVersionLabel('o3', 'o3')).toBe('o3');
  });

  it('leaves BYOK provider/model ids and unknown vendors alone', () => {
    expect(modelVersionLabel('anthropic/claude-sonnet-4-5')).toBe(
      'anthropic/claude-sonnet-4-5',
    );
    expect(modelVersionLabel('acme-turbo-1', 'acme-turbo-1')).toBe('acme-turbo-1');
  });

  it('leaves a prose label that does not lead with the company token', () => {
    expect(modelVersionLabel('deepseek-v4-flash', 'DeepSeek V4 Flash')).toBe(
      'DeepSeek V4 Flash',
    );
  });
});

describe('renderModelOptions', () => {
  it('renders an empty model list without options', () => {
    expect(renderOptions([])).toBe('<select></select>');
  });

  it('renders flat model lists as ungrouped options in input order', () => {
    expect(
      renderOptions([
        { id: 'default', label: 'Default' },
        { id: 'sonnet', label: 'Claude Sonnet' },
        { id: 'opus', label: 'Claude Opus' },
      ]),
    ).toBe(
      '<select><option value="default">Default</option><option value="sonnet">Claude Sonnet</option><option value="opus">Claude Opus</option></select>',
    );
  });

  it('pins default and other flat options before provider optgroups', () => {
    expect(
      renderOptions([
        { id: 'openai/gpt-5.1', label: 'openai/gpt-5.1' },
        { id: 'custom-local', label: 'Custom local' },
        { id: 'default', label: 'Default' },
        { id: 'anthropic/claude-sonnet-4.5', label: 'anthropic/claude-sonnet-4.5' },
        { id: 'openai/o3', label: 'openai/o3' },
      ]),
    ).toBe(
      '<select><option value="default">Default</option><option value="custom-local">Custom local</option><optgroup label="openai"><option value="openai/gpt-5.1">gpt-5.1</option><option value="openai/o3">o3</option></optgroup><optgroup label="anthropic"><option value="anthropic/claude-sonnet-4.5">claude-sonnet-4.5</option></optgroup></select>',
    );
  });

  it('treats leading-slash ids as flat and only strips matching provider label prefixes', () => {
    expect(
      renderOptions([
        { id: '/missing-provider', label: '/missing-provider' },
        { id: 'openai/gpt-5.1', label: 'GPT 5.1' },
        { id: 'openai/o3', label: 'openai/o3' },
      ]),
    ).toBe(
      '<select><option value="/missing-provider">/missing-provider</option><optgroup label="openai"><option value="openai/gpt-5.1">GPT 5.1</option><option value="openai/o3">o3</option></optgroup></select>',
    );
  });
});

describe('isCustomModel', () => {
  const models: AgentModelOption[] = [
    { id: 'default', label: 'Default' },
    { id: 'openai/gpt-5.1', label: 'openai/gpt-5.1' },
  ];

  it('returns false for empty selections and listed model ids', () => {
    expect(isCustomModel(null, models)).toBe(false);
    expect(isCustomModel(undefined, models)).toBe(false);
    expect(isCustomModel('', models)).toBe(false);
    expect(isCustomModel('default', models)).toBe(false);
    expect(isCustomModel('openai/gpt-5.1', models)).toBe(false);
  });

  it('returns true for unlisted custom ids and the custom sentinel', () => {
    expect(isCustomModel('local/my-model', models)).toBe(true);
    expect(isCustomModel(CUSTOM_MODEL_SENTINEL, models)).toBe(true);
  });
});

describe('orderModelOptionsByAvailability', () => {
  it('keeps available models before unavailable models without reordering within each group', () => {
    expect(
      orderModelOptionsByAvailability([
        { id: 'locked-a', label: 'Locked A', enabled: false },
        { id: 'ready-a', label: 'Ready A' },
        { id: 'locked-b', label: 'Locked B', enabled: false },
        { id: 'ready-b', label: 'Ready B', enabled: true },
      ]).map((model) => model.id),
    ).toEqual(['ready-a', 'ready-b', 'locked-a', 'locked-b']);
  });
});

describe('SearchableModelSelect', () => {
  const catalog: AgentModelOption[] = [
    { id: 'official:deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
    { id: 'supplier:lingzhigongfang/global/claude-fable-5', label: '灵智工坊 · Claude Fable 5' },
    { id: 'supplier:lingzhigongfang/global/claude-fable-5.1', label: '灵智工坊 · Claude Fable 5.1' },
    { id: 'supplier:suanlizhixuan/global/claude-fable-5.1', label: '算力智选 · Claude Fable 5.1' },
    { id: 'official:qwen3.8-max', label: 'Qwen3.8 Max' },
    { id: 'official:qwen3.7-max', label: 'Qwen3.7 Max' },
  ];

  function CatalogPicker() {
    const [value, setValue] = useState(catalog[0]!.id);
    return <>
      <output data-testid="chosen-model">{value}</output>
      <SearchableModelSelect models={catalog} value={value} onChange={setValue}
        searchPlaceholder="Search models" groupByCompany minSearchableOptions={2} />
    </>;
  }

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 120,
      y: 200,
      top: 200,
      right: 360,
      bottom: 236,
      left: 120,
      width: 240,
      height: 36,
      toJSON: () => ({}),
    });
  });

  it('uses catalog source names and keeps versioned official models in one group', () => {
    const groups = groupModelsByCompany(catalog);
    expect(groups.map(group => group.name)).toEqual(['DeepSeek', '灵智工坊', '算力智选', 'Qwen']);
    expect(groups.at(-1)?.options).toHaveLength(2);
  });

  it('searches across sources without retaining an unrelated selection, and selects the exact route', () => {
    render(<CatalogPicker />);
    fireEvent.click(screen.getByRole('combobox'));
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'Claude Fable 5.1' } });
    const results = screen.getAllByRole('option');
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveAccessibleName('Claude Fable 5.1');
    expect(results[0]).toHaveAccessibleDescription('灵智工坊');
    expect(results[1]).toHaveAccessibleDescription('算力智选');
    fireEvent.click(results[1]!);
    expect(screen.getByTestId('chosen-model')).toHaveTextContent(catalog[3]!.id);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('does not replace the model rows when the pointer crosses another source', () => {
    render(<CatalogPicker />);
    fireEvent.click(screen.getByRole('combobox'));
    const source = screen.getByRole('button', { name: '灵智工坊' });
    fireEvent.mouseEnter(source);
    expect(screen.getByRole('option', { name: 'DeepSeek V4.1 Flash' })).toBeTruthy();
    fireEvent.click(source);
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('option', { name: 'Claude Fable 5.1' })).toBeTruthy();
  });

  it('supports keyboard search and selection and reports a genuinely empty result', () => {
    render(<CatalogPicker />);
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const search = screen.getByRole('searchbox');
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: 'not-a-model' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching models')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'Claude Fable 5.1' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(screen.getByTestId('chosen-model')).toHaveTextContent(catalog[3]!.id);
    expect(trigger).toHaveFocus();
  });

  it('caps a wide trigger at 560px unless the popover is asked to match it', async () => {
    const wideTrigger = {
      x: 100,
      y: 200,
      top: 200,
      right: 726,
      bottom: 232,
      left: 100,
      width: 626,
      height: 32,
      toJSON: () => ({}),
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(wideTrigger);
    const select = (extra: { popoverMatchTrigger?: boolean }) => (
      <SearchableModelSelect
        models={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]}
        value="a"
        onChange={vi.fn()}
        searchPlaceholder="Search models"
        popoverTestId="model-popover"
        {...extra}
      />
    );

    const capped = render(select({}));
    fireEvent.click(screen.getByRole('combobox'));
    expect((await screen.findByTestId('model-popover')).style.width).toBe('560px');
    capped.unmount();

    render(select({ popoverMatchTrigger: true }));
    fireEvent.click(screen.getByRole('combobox'));
    expect((await screen.findByTestId('model-popover')).style.width).toBe('626px');
  });

  it('clamps an upward popover and keeps that placement while it still fits', async () => {
    let triggerRect = {
      x: 120,
      y: 300,
      top: 300,
      right: 360,
      bottom: 336,
      left: 120,
      width: 240,
      height: 36,
      toJSON: () => ({}),
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => triggerRect,
    );

    render(
      <SearchableModelSelect
        models={Array.from({ length: 9 }, (_, index) => ({
          id: `model-${index}`,
          label: `Model ${index}`,
        }))}
        value="model-0"
        onChange={vi.fn()}
        searchPlaceholder="Search models"
        popoverTestId="model-popover"
        getPopoverBoundary={() => ({
          top: 80,
          right: 500,
          bottom: 400,
          left: 8,
        })}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    const popover = await screen.findByTestId('model-popover');
    expect(popover.style.bottom).toBe(`${window.innerHeight - 300 + 6}px`);
    expect(popover.style.maxHeight).toBe('214px');

    triggerRect = {
      ...triggerRect,
      y: 200,
      top: 200,
      bottom: 236,
    };
    fireEvent.scroll(window);

    await waitFor(() => {
      expect(popover.style.bottom).toBe(`${window.innerHeight - 200 + 6}px`);
      expect(popover.style.maxHeight).toBe('114px');
    });
  });

  it('renders capability tag and cost metadata as option text', async () => {
    render(
      <SearchableModelSelect
        models={[
          {
            id: 'deepseek-v4-flash',
            label: 'deepseek-v4-flash',
            metadata: { cost: 'low', capability: 'standard' },
          },
        ]}
        value="deepseek-v4-flash"
        onChange={vi.fn()}
        searchPlaceholder="Search models"
        minSearchableOptions={1}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    // Flat list = a provider's own catalog (BYOK), where the label IS the id
    // the request will carry, so it is shown verbatim. The company-grouped
    // catalog is the surface that shortens it (see the compact-switcher test).
    const option = await screen.findByRole('option', { name: /^deepseek-v4-flash$/ });
    expect(option.textContent).toContain('Low cost');
    expect(option.textContent).toContain('Standard');
    expect(option.getAttribute('aria-labelledby')).toBeTruthy();
    expect(option.getAttribute('aria-describedby')).toBeTruthy();
    expect(option).toHaveAccessibleName('deepseek-v4-flash');
    expect(option).toHaveAccessibleDescription('Low cost Standard');
    expect(option.querySelector('[data-description]')).toBeNull();
    expect(option.querySelector('[data-label]')).toBeNull();
  });

  it('hides unavailable options', async () => {
    const onChange = vi.fn();
    render(
      <SearchableModelSelect
        models={[
          { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', default: true },
          { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', enabled: false },
        ]}
        value="deepseek-v4-flash"
        onChange={onChange}
        searchPlaceholder="Search models"
        disabledOptionHint={(option) =>
          option.enabled === false ? '请升级后使用高级模型' : null
        }
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    expect(await screen.findByRole('option', {name: /^deepseek-v4-flash$/})).toBeTruthy();
    expect(screen.queryByRole('option', { name: /^deepseek-v4-pro$/ })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not restore a disabled model through additional options or upgrade affordances', async () => {
    const onChange = vi.fn();
    const onDisabledOptionUpgrade = vi.fn();
    render(
      <SearchableModelSelect
        models={[
          { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', default: true },
          { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', enabled: false },
        ]}
        value="deepseek-v4-flash"
        onChange={onChange}
        searchPlaceholder="Search models"
        disabledOptionHint={(option) =>
          option.enabled === false ? 'Upgrade to use' : null
        }
        onDisabledOptionUpgrade={onDisabledOptionUpgrade}
        additionalOptions={[{value:'deepseek-v4-pro',label:'deepseek-v4-pro'}]}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    expect(await screen.findByRole('option', {name: /^deepseek-v4-flash$/})).toBeTruthy();
    expect(screen.queryByRole('option', {name: /^deepseek-v4-pro$/})).toBeNull();
    expect(screen.queryByTestId('model-option-upgrade-lock')).toBeNull();
    expect(onDisabledOptionUpgrade).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps capability badges outside the truncating model label', async () => {
    const longModelLabel = 'gemini-3-flash-preview-with-an-extra-long-provider-suffix';

    render(
      <SearchableModelSelect
        models={[
          { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', default: true },
          {
            id: 'google/gemini-3-flash-preview',
            label: longModelLabel,
            enabled: true,
            metadata: { capability: 'standard' },
          },
        ]}
        value="deepseek-v4-flash"
        onChange={vi.fn()}
        searchPlaceholder="Search models"
        disabledOptionHint={(option) =>
          option.enabled === false ? 'Upgrade to use' : null
        }
        onDisabledOptionUpgrade={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    const disabledOption = await screen.findByRole('option', {
      name: longModelLabel,
    });
    const label = disabledOption.querySelector('.model-select-searchable__option-label');
    const affordances = disabledOption.querySelector(
      '.model-select-searchable__option-affordances',
    );
    const badge = disabledOption.querySelector('.model-select-searchable__option-badge');

    expect(label?.textContent).toBe(longModelLabel);
    expect(affordances?.contains(badge)).toBe(true);
    expect(disabledOption).toHaveAccessibleName(longModelLabel);
  });

  it('exposes the full model name on hover for same-prefix long ids', async () => {
    // The report: two OpenRouter variants share a prefix, the row label is
    // ellipsised, and no title leaves the two indistinguishable. Hovering any
    // row must reveal the complete name it stands for.
    const models: AgentModelOption[] = [
      {
        id: 'openrouter/google/gemini-2.5-pro-preview-06-05',
        label: 'openrouter/google/gemini-2.5-pro-preview-06-05',
      },
      {
        id: 'openrouter/google/gemini-2.5-pro-preview-05-06',
        label: 'openrouter/google/gemini-2.5-pro-preview-05-06',
      },
    ];
    render(
      <SearchableModelSelect
        models={models}
        value={models[0]!.id}
        onChange={vi.fn()}
        searchPlaceholder="Search models"
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    for (const model of models) {
      const option = await screen.findByRole('option', { name: model.label });
      expect(option.getAttribute('title')).toBe(model.label);
    }
    // The trigger readout truncates the same way, so once it is cut off it
    // carries the full name on hover too.
    const trigger = screen.getByRole('combobox');
    const readout = trigger.querySelector<HTMLElement>('.model-select-searchable__value-label')!;
    Object.defineProperty(readout, 'scrollWidth', { configurable: true, value: 320 });
    Object.defineProperty(readout, 'clientWidth', { configurable: true, value: 180 });
    fireEvent.mouseEnter(trigger);
    expect(trigger.getAttribute('title')).toBe(models[0]!.label);
  });

  it('leaves a fully visible trigger readout without a native title', () => {
    // The report: hovering `grok-4.7-build-fast` stacked a browser tooltip with
    // the very same text over the field. A readout that shows the whole name
    // has nothing to add on hover.
    render(
      <SearchableModelSelect
        models={[{ id: 'grok-4.7-build-fast', label: 'grok-4.7-build-fast' }]}
        value="grok-4.7-build-fast"
        onChange={vi.fn()}
        searchPlaceholder="Search models"
      />,
    );
    const trigger = screen.getByRole('combobox');
    fireEvent.mouseEnter(trigger);
    expect(trigger.hasAttribute('title')).toBe(false);
  });

  it('keeps the full name in the hover title when the row shortens it', async () => {
    render(
      <SearchableModelSelect
        models={[
          { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
          { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
          { id: 'claude-opus-4.6', label: 'claude-opus-4.6' },
        ]}
        value="deepseek-v4-flash"
        onChange={vi.fn()}
        searchPlaceholder="Search models"
        groupByCompany
        minSearchableOptions={2}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));

    // The company-grouped row drops the company token (`v4-pro`) because the
    // brand mark already carries it; the title restores the full identity.
    const option = await screen.findByRole('option', { name: 'v4-pro' });
    expect(option.textContent).toContain('v4-pro');
    expect(option.getAttribute('title')).toBe('deepseek-v4-pro');
  });
});
