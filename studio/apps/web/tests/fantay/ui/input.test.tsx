// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Field, Label } from '../../../src/fantay/ui/field';
import { Input, InputGroup, InputGroupClear } from '../../../src/fantay/ui/input';
import { Textarea } from '../../../src/fantay/ui/textarea';

afterEach(cleanup);

describe('Input', () => {
  it('defaults to the 32px default field and forwards its ref', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} aria-label="Name" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(ref.current).toBe(input);
    expect(input).toHaveAttribute('data-variant', 'default');
    expect(input).toHaveAttribute('data-size', 'md');
    expect(input.className).toContain('h-8');
    expect(input.className).toContain('focus-visible:shadow-elevation-1-focus');
  });

  it('maps variants and sizes', () => {
    render(
      <>
        <Input aria-label="small" inputSize="sm" />
        <Input aria-label="large" inputSize="lg" />
        <Input aria-label="mono" variant="mono" />
        <Input aria-label="bare" variant="bare" inputSize="auto" />
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'small' }).className).toContain('h-7');
    expect(screen.getByRole('textbox', { name: 'large' }).className).toContain('h-10');
    expect(screen.getByRole('textbox', { name: 'mono' }).className).toContain('font-mono');
    const bare = screen.getByRole('textbox', { name: 'bare' });
    expect(bare.className).toContain('border-0');
    expect(bare.className).not.toContain('h-8');
  });
});

describe('InputGroup', () => {
  it('wraps a bare input with leading/trailing slots and state attributes', () => {
    const onClear = vi.fn();
    render(
      <InputGroup data-testid="group" size="sm" invalid leading={<span data-testid="lead">⌕</span>} trailing={<InputGroupClear onClear={onClear} />}>
        <Input aria-label="Search" variant="bare" inputSize="auto" />
      </InputGroup>,
    );
    const group = screen.getByTestId('group');
    expect(group.tagName).toBe('LABEL');
    expect(group).toHaveAttribute('data-size', 'sm');
    expect(group).toHaveAttribute('data-invalid', '');
    expect(group.className).toContain('h-7');
    expect(screen.getByTestId('lead')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('Textarea', () => {
  it('renders the default and code variants', () => {
    render(
      <>
        <Textarea aria-label="Prompt" />
        <Textarea aria-label="Code" variant="code" />
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Prompt' }).className).toContain('text-copy');
    const code = screen.getByRole('textbox', { name: 'Code' });
    expect(code).toHaveAttribute('data-variant', 'code');
    expect(code.className).toContain('bg-code');
    expect(code.className).toContain('text-caption');
  });
});

describe('Field', () => {
  it('stacks label, control, hint and an alert error', () => {
    render(
      <Field label="Width" hint="In pixels" error="Must be at least 64" htmlFor="width" labelVariant="form">
        <Input id="width" aria-invalid />
      </Field>,
    );
    const input = screen.getByLabelText('Width');
    expect(input).toHaveAttribute('id', 'width');
    expect(screen.getByText('In pixels')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Must be at least 64');
    expect(screen.getByText('Width').className).toContain('text-label');
  });

  it('exposes Label variants', () => {
    render(<Label variant="plain">Group</Label>);
    expect(screen.getByText('Group').className).toContain('font-semibold');
  });
});
