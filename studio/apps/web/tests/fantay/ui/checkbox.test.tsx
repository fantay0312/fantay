// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { createRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Checkbox, CheckboxCard, CheckboxField } from '../../../src/fantay/ui/checkbox';

afterEach(cleanup);

describe('Checkbox', () => {
  it('keeps a native checkbox (uncontrolled) and forwards its ref', () => {
    const ref = createRef<HTMLInputElement>();
    render(<CheckboxField ref={ref} label="Include assets" />);
    const box = screen.getByRole('checkbox', { name: 'Include assets' });
    expect(ref.current).toBe(box);
    expect(box).not.toBeChecked();
    fireEvent.click(screen.getByText('Include assets'));
    expect(box).toBeChecked();
  });

  it('sets the indeterminate property and shows a dash', () => {
    const { container, rerender } = render(<Checkbox aria-label="Some" indeterminate />);
    const box = screen.getByRole('checkbox', { name: 'Some' }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(container.querySelector('[data-slot="checkbox-box"] svg')).not.toBeNull();
    rerender(<Checkbox aria-label="Some" />);
    expect(box.indeterminate).toBe(false);
  });

  it('disables the field and keeps the description', () => {
    render(<CheckboxField label="Locked" description="Needs an account" disabled />);
    expect(screen.getByRole('checkbox', { name: /Locked/ })).toBeDisabled();
    expect(screen.getByText('Needs an account')).toBeInTheDocument();
  });

  it('reports CheckboxCard changes', () => {
    const onChange = vi.fn();
    function Card() {
      const [checked, setChecked] = useState(false);
      return (
        <CheckboxCard
          checked={checked}
          onChange={(next) => {
            onChange(next);
            setChecked(next);
          }}
          title="Keep the original"
          description="A copy is made next to it."
        />
      );
    }
    render(<Card />);
    fireEvent.click(screen.getByText('Keep the original'));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});
