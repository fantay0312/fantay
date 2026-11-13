// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { visibleAgentModels } from '../../src/components/agentModelSelection';
import { ModelVisibilitySelect } from '../../src/components/ModelVisibilitySelect';

const models = [
  { id: 'default', label: 'Default' },
  { id: 'opus', label: 'Opus (latest)' },
  { id: 'sonnet', label: 'Sonnet (latest)' },
  { id: 'off', label: 'Off', enabled: false },
];

afterEach(cleanup);

describe('visibleAgentModels', () => {
  it('shows everything until something is unchecked', () => {
    expect(visibleAgentModels(models, undefined, null)).toHaveLength(4);
    expect(visibleAgentModels(models, [], null)).toHaveLength(4);
  });

  it('hides what was unchecked but never the CLI default or the model in use', () => {
    const ids = (hidden: string[], current: string | null) =>
      visibleAgentModels(models, hidden, current).map((model) => model.id);
    expect(ids(['opus'], 'sonnet')).toEqual(['default', 'sonnet', 'off']);
    expect(ids(['opus', 'default'], 'opus')).toEqual(['default', 'opus', 'sonnet', 'off']);
  });
});

describe('ModelVisibilitySelect', () => {
  const open = () => fireEvent.click(screen.getByTestId('settings-agent-model-visibility-claude'));

  it('counts selectable models only and stays open while toggling', () => {
    const onChange = vi.fn();
    render(<ModelVisibilitySelect agentId="claude" models={models} hiddenIds={undefined} onChange={onChange} />);
    expect(screen.getByTestId('settings-agent-model-visibility-claude').textContent).toContain('2');
    open();
    expect(screen.queryByRole('option', { name: 'Default' })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Opus (latest)' }));
    expect(onChange).toHaveBeenCalledWith(['opus']);
    expect(screen.getByRole('option', { name: 'Sonnet (latest)' })).toBeTruthy();
  });

  it('brings a hidden model back, and clears or restores all at once', () => {
    const onChange = vi.fn();
    render(<ModelVisibilitySelect agentId="claude" models={models} hiddenIds={['opus']} onChange={onChange} />);
    open();
    expect(screen.getByRole('option', { name: 'Opus (latest)' }).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(screen.getByRole('option', { name: 'Opus (latest)' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    const [selectAll, clear] = screen.getAllByRole('button').filter((button) => button.closest('.model-select-searchable__footer'));
    fireEvent.click(clear!);
    expect(onChange).toHaveBeenLastCalledWith(['opus', 'sonnet']);
    fireEvent.click(selectAll!);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
