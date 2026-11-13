// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Collapsible, CollapsibleContent, CollapsibleTrigger, Disclosure } from '../../../src/fantay/ui/collapsible';

afterEach(cleanup);

describe('Collapsible', () => {
  it('wires the trigger to its content', () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Advanced options</CollapsibleTrigger>
        <CollapsibleContent>Seed and steps</CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole('button', { name: 'Advanced options' });
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Seed and steps')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('Seed and steps')).toBeVisible();
    expect(trigger.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Disclosure', () => {
  it('keeps its body mounted while folded', () => {
    render(
      <Disclosure label="What changed">
        <a href="#log">Changelog</a>
      </Disclosure>,
    );
    const trigger = screen.getByRole('button', { name: 'What changed' });
    const link = screen.getByText('Changelog');
    // mounted while folded; the closed state hides it with CSS (`data-[state=closed]:hidden`)
    const content = link.parentElement;
    expect(link).toBeInTheDocument();
    expect(content).toHaveAttribute('data-state', 'closed');
    expect(content?.className).toContain('data-[state=closed]:hidden');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(content).toHaveAttribute('data-state', 'open');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});
