// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Toolbar,
  ToolbarButton,
  ToolbarControl,
  ToolbarDot,
  ToolbarHighlight,
  ToolbarSeparator,
} from '../../../src/fantay/ui/toolbar';

afterEach(cleanup);

describe('Toolbar', () => {
  it('is a labelled toolbar with an orientation', () => {
    render(
      <Toolbar aria-label="Tools" orientation="vertical">
        <ToolbarButton aria-label="Select" />
      </Toolbar>,
    );
    const toolbar = screen.getByRole('toolbar', { name: 'Tools' });
    expect(toolbar).toHaveAttribute('aria-orientation', 'vertical');
    expect(toolbar.className).toContain('flex-col');
  });

  it('sizes ToolbarButton sm (28px, default) and md (32px)', () => {
    render(
      <Toolbar aria-label="Tools">
        <ToolbarButton aria-label="Small" />
        <ToolbarButton aria-label="Medium" size="md" />
      </Toolbar>,
    );
    const small = screen.getByRole('button', { name: 'Small' });
    const medium = screen.getByRole('button', { name: 'Medium' });
    expect(small).toHaveAttribute('type', 'button');
    expect(small).toHaveAttribute('data-size', 'sm');
    expect(small.className).toContain('size-7');
    expect(medium).toHaveAttribute('data-size', 'md');
    expect(medium.className).toContain('size-8');
    expect(medium.className).not.toContain('size-7');
  });

  it('reflects pressed through aria-pressed and disabled through data-disabled', () => {
    render(
      <Toolbar aria-label="Tools">
        <ToolbarButton aria-label="Hand" pressed />
        <ToolbarButton aria-label="Text" pressed={false} />
        <ToolbarButton aria-label="Export" disabled />
      </Toolbar>,
    );
    expect(screen.getByRole('button', { name: 'Hand' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'false');
    const exportButton = screen.getByRole('button', { name: 'Export' });
    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAttribute('data-disabled', '');
  });

  it('names a ToolbarControl by its label, forwards its ref and shows label + key caps on focus', async () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(
      <Toolbar aria-label="Tools">
        <ToolbarControl ref={ref} label="Frame" shortcut="f" size="md" onClick={onClick} />
      </Toolbar>,
    );
    const button = screen.getByRole('button', { name: 'Frame' });
    expect(ref.current).toBe(button);
    expect(button).toHaveAttribute('data-size', 'md');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => button.focus());
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Frame');
    expect(tooltip.textContent).toContain('F');
  });

  it('draws toned dots and separators', () => {
    const { container } = render(
      <Toolbar aria-label="Tools">
        <ToolbarButton aria-label="Images">
          <ToolbarDot tone="danger" />
        </ToolbarButton>
        <ToolbarSeparator />
      </Toolbar>,
    );
    const dot = container.querySelector('[data-slot="toolbar-dot"]');
    expect(dot).toHaveAttribute('data-tone', 'danger');
    expect(dot?.className).toContain('bg-accent-ink');
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('shows the highlight only while a button is pressed', () => {
    const { container, rerender } = render(
      <Toolbar aria-label="Tools">
        <ToolbarHighlight activeKey="select" />
        <ToolbarButton aria-label="Select" pressed />
        <ToolbarButton aria-label="Hand" />
      </Toolbar>,
    );
    const pill = container.querySelector<HTMLElement>('[data-slot="toolbar-highlight"]');
    expect(pill?.style.opacity).toBe('1');
    rerender(
      <Toolbar aria-label="Tools">
        <ToolbarHighlight activeKey="none" />
        <ToolbarButton aria-label="Select" />
        <ToolbarButton aria-label="Hand" />
      </Toolbar>,
    );
    expect(pill?.style.opacity).toBe('0');
  });
});
