// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InputGroupClear } from '../../../src/fantay/ui/input';
import { SearchField } from '../../../src/fantay/ui/search-field';

afterEach(cleanup);

describe('SearchField', () => {
  it('wraps a bare text input in a 32px ring label with a leading glyph', () => {
    const ref = createRef<HTMLInputElement>();
    render(<SearchField ref={ref} aria-label="Search projects" placeholder="Search" className="w-64" inputClassName="tracking-wide" />);
    const input = screen.getByRole('textbox', { name: 'Search projects' });
    expect(ref.current).toBe(input);
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('data-variant', 'bare');
    expect(input.className).toContain('tracking-wide');
    const shell = input.closest('label');
    expect(shell).toHaveAttribute('data-slot', 'search-field');
    expect(shell?.className).toContain('h-8');
    expect(shell?.className).toContain('w-64');
    expect(shell?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders the bar variant and a trailing clear button', () => {
    const onClear = vi.fn();
    render(
      <SearchField
        aria-label="Command"
        variant="bar"
        type="search"
        defaultValue="board"
        trailing={<InputGroupClear onClear={onClear} />}
      />,
    );
    const input = screen.getByRole('searchbox', { name: 'Command' });
    expect(input.closest('label')?.className).toContain('h-12');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
