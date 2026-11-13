// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CustomSelect } from '../../src/components/CustomSelect';

afterEach(() => cleanup());

describe('CustomSelect', () => {
  it('anchors short upward menus by their bottom and respects the available viewport', () => {
    render(<CustomSelect ariaLabel="Size" value="a" options={[{value:'a',label:'A'}]} onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({top:700,bottom:728,left:950,right:1250,width:300,height:28,x:950,y:700,toJSON:()=>({})});
    fireEvent.click(trigger);
    const menu = screen.getByRole('listbox');
    expect(menu.style.bottom).toBe(`${window.innerHeight - 700 + 4}px`);
    expect(menu.style.top).toBe('');
    expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.minWidth)).toBeLessThanOrEqual(window.innerWidth - 12);
  });

  it('supports Home, End and Tab without trapping focus', () => {
    render(<CustomSelect ariaLabel="Size" value="a" options={[{value:'a',label:'A'},{value:'b',label:'B'}]} onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, {key:'ArrowDown'});
    fireEvent.keyDown(trigger, {key:'End'});
    expect(trigger.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option',{name:'B'}).id);
    fireEvent.keyDown(trigger, {key:'Home'});
    expect(trigger.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option',{name:'A'}).id);
    fireEvent.keyDown(trigger, {key:'Tab'});
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('renders the selected label and chooses an option from the portal menu', () => {
    const onChange = vi.fn();
    render(
      <CustomSelect
        ariaLabel="Model"
        value="gpt-image-2"
        options={[
          { value: 'gpt-image-2', label: 'GPT Image 2' },
          { value: 'seedance', label: 'Seedance' },
        ]}
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Model: GPT Image 2' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('option', { name: /Seedance/ }));
    expect(onChange).toHaveBeenCalledWith('seedance');
  });

  it('skips disabled options and supports keyboard selection', () => {
    const onChange = vi.fn();
    render(
      <CustomSelect
        ariaLabel="Provider"
        value="openai"
        options={[
          { value: 'openai', label: 'OpenAI' },
          { value: 'disabled', label: 'Disabled', disabled: true },
          { value: 'custom', label: 'Custom' },
        ]}
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Provider: OpenAI' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: /Custom/ }).id,
    );
    expect(trigger.getAttribute('aria-activedescendant')).not.toBe(
      screen.getByRole('option', { name: /Disabled/ }).id,
    );

    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('custom');
    expect(onChange).not.toHaveBeenCalledWith('disabled');
  });

  it('keeps keyboard navigation active state across parent rerenders with fresh options', () => {
    const onChange = vi.fn();
    const options = () => [
      { value: 'first', label: 'First' },
      { value: 'second', label: 'Second' },
      { value: 'third', label: 'Third' },
    ];
    const { rerender } = render(
      <CustomSelect
        ariaLabel="Template"
        value="first"
        options={options()}
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Template: First' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: /Second/ }).id,
    );

    rerender(
      <CustomSelect
        ariaLabel="Template"
        value="first"
        options={options()}
        onChange={onChange}
      />,
    );

    const rerenderedTrigger = screen.getByRole('combobox', { name: 'Template: First' });
    expect(rerenderedTrigger.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: /Second/ }).id,
    );
  });
});
