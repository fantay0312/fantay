// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from '../../../src/fantay/ui/button';

afterEach(cleanup);

describe('Button', () => {
  it('defaults to type="button" with variant and size data attributes', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-slot', 'button');
    expect(button).toHaveAttribute('data-variant', 'default');
    expect(button).toHaveAttribute('data-size', 'md');
    expect(button).not.toHaveAttribute('data-disabled');
  });

  it('keeps an explicit submit type and reflects variant/size', () => {
    render(
      <Button type="submit" variant="primary" size="lg">
        Send
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button).toHaveAttribute('type', 'submit');
    expect(button).toHaveAttribute('data-variant', 'primary');
    expect(button).toHaveAttribute('data-size', 'lg');
    expect(button.className).toContain('h-10');
  });

  it('renders no type on asChild and passes the classes to the child', () => {
    render(
      <Button asChild variant="link">
        <a href="#docs">Docs</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link).not.toHaveAttribute('type');
    expect(link).toHaveAttribute('data-variant', 'link');
    expect(link.className).toContain('underline-offset-4');
  });

  it('natively disables without a reason', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Delete
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('data-disabled', '');
    expect(button).not.toHaveAttribute('aria-disabled');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('stays focusable with a disabledReason, blocks activation and shows the reason on focus', async () => {
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <Button disabled disabledReason="Connect a model first" onClick={onClick} onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
        Generate
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Generate' });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('data-disabled', '');

    fireEvent.click(button);
    fireEvent.pointerDown(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: ' ' });
    expect(onClick).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();

    // other keys still reach the caller (e.g. Escape handling around it)
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);

    act(() => button.focus());
    expect(button).toHaveFocus();
    expect((await screen.findByRole('tooltip')).textContent).toContain('Connect a model first');
  });

  it('prevents the default of a guarded click', () => {
    render(
      <Button disabled disabledReason="Not yet">
        Go
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Go' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows a spinner over the invisible label while loading and blocks activation', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('data-disabled', '');
    expect(button).not.toBeDisabled();
    const label = button.querySelector('[data-slot="button-label"]');
    expect(label?.className).toContain('invisible');
    const spinner = button.querySelector('[data-slot="spinner"]');
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('merges caller classes over the recipe', () => {
    render(<Button className="w-full rounded-pill">Wide</Button>);
    const button = screen.getByRole('button', { name: 'Wide' });
    expect(button.className).toContain('w-full');
    expect(button.className).toContain('rounded-pill');
    expect(button.className).not.toContain('rounded-row');
  });

  it('retains rounded-pill through cn() for primary, secondary, and brand across all sizes', () => {
    const { rerender } = render(<Button variant="primary" size="sm">Primary</Button>);
    let button = screen.getByRole('button', { name: 'Primary' });
    expect(button.className).toContain('rounded-pill');
    expect(button.className).not.toContain('rounded-sm');

    rerender(<Button variant="secondary" size="md">Secondary</Button>);
    button = screen.getByRole('button', { name: 'Secondary' });
    expect(button.className).toContain('rounded-pill');
    expect(button.className).not.toContain('rounded-sm');

    rerender(<Button variant="brand" size="lg">Brand</Button>);
    button = screen.getByRole('button', { name: 'Brand' });
    expect(button.className).toContain('rounded-pill');
    expect(button.className).not.toContain('rounded-sm');
  });

  it('retains rounded-sm through cn() for utility buttons across all sizes', () => {
    const { rerender } = render(<Button variant="default" size="sm">Default</Button>);
    let button = screen.getByRole('button', { name: 'Default' });
    expect(button.className).toContain('rounded-sm');
    expect(button.className).not.toContain('rounded-pill');

    rerender(<Button variant="ghost" size="md">Ghost</Button>);
    button = screen.getByRole('button', { name: 'Ghost' });
    expect(button.className).toContain('rounded-sm');
    expect(button.className).not.toContain('rounded-pill');

    rerender(<Button variant="danger" size="lg">Danger</Button>);
    button = screen.getByRole('button', { name: 'Danger' });
    expect(button.className).toContain('rounded-sm');
    expect(button.className).not.toContain('rounded-pill');

    rerender(<Button variant="bare" size="icon">Bare</Button>);
    button = screen.getByRole('button', { name: 'Bare' });
    expect(button.className).toContain('rounded-sm');
    expect(button.className).not.toContain('rounded-pill');
  });
});
