// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../src/fantay/ui/select';

afterEach(cleanup);

function ModelSelect({ onValueChange, size }: { onValueChange?: (value: string) => void; size?: 'sm' | 'md' }) {
  return (
    <Select onValueChange={onValueChange}>
      <SelectTrigger aria-label="Model" size={size}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="gpt-image">GPT Image</SelectItem>
        <SelectItem value="veo">Veo</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe('Select', () => {
  it('renders a 32px trigger with the localized placeholder', () => {
    render(<ModelSelect />);
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger).toHaveAttribute('data-size', 'md');
    expect(trigger.className).toContain('h-8');
    expect(trigger).toHaveAttribute('data-placeholder');
    expect(trigger).toHaveTextContent('Select…');
  });

  it('uses the zh-CN placeholder under the provider and the 28px size', () => {
    render(
      <I18nProvider initial="zh-CN">
        <ModelSelect size="sm" />
      </I18nProvider>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger).toHaveTextContent('请选择…');
    expect(trigger.className).toContain('h-7');
  });

  it('opens from the keyboard into an fx listbox and selects an option', () => {
    const onValueChange = vi.fn();
    render(<ModelSelect onValueChange={onValueChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const listbox = screen.getByRole('listbox');
    expect(listbox.closest('[data-slot="select-content"]')).toHaveClass('fx');
    fireEvent.click(screen.getByRole('option', { name: 'Veo' }));
    expect(onValueChange).toHaveBeenCalledWith('veo');
    expect(trigger).toHaveTextContent('Veo');
    expect(trigger).not.toHaveAttribute('data-placeholder');
  });
});
