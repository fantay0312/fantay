// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Segmented, SegmentedIconItem, SegmentedIcons, SegmentedItem } from '../../../src/fantay/ui/segmented';

afterEach(cleanup);

function Views({ onChange, size }: { onChange?: (value: string) => void; size?: 'sm' | 'md' }) {
  const [value, setValue] = useState('board');
  return (
    <Segmented
      aria-label="View"
      size={size}
      value={value}
      onValueChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    >
      <SegmentedItem value="board">Board</SegmentedItem>
      <SegmentedItem value="files">Files</SegmentedItem>
      <SegmentedItem value="system">System</SegmentedItem>
    </Segmented>
  );
}

describe('Segmented', () => {
  it('is a labelled single-choice group with exactly one checked item', () => {
    render(<Views />);
    const group = screen.getByRole('radiogroup', { name: 'View' });
    expect(group).toHaveAttribute('data-size', 'md');
    expect(screen.getByRole('radio', { name: 'Board' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Files' })).toHaveAttribute('aria-checked', 'false');
  });

  it('switches on click and never deselects the current item', () => {
    const onChange = vi.fn();
    render(<Views onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    expect(onChange).toHaveBeenLastCalledWith('files');
    expect(screen.getByRole('radio', { name: 'Files' })).toHaveAttribute('aria-checked', 'true');

    onChange.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Files' })).toHaveAttribute('aria-checked', 'true');
  });

  it('moves focus with the arrow keys (one tab stop)', async () => {
    render(<Views />);
    const board = screen.getByRole('radio', { name: 'Board' });
    const files = screen.getByRole('radio', { name: 'Files' });
    act(() => board.focus());
    fireEvent.keyDown(board, { key: 'ArrowRight' });
    await waitFor(() => expect(files).toHaveFocus());
    fireEvent.keyDown(files, { key: 'ArrowLeft' });
    await waitFor(() => expect(board).toHaveFocus());
  });

  it('passes the size to the items (26px md, 22px sm)', () => {
    const { unmount } = render(<Views />);
    expect(screen.getByRole('radio', { name: 'Board' }).className).toContain('h-[26px]');
    unmount();
    render(<Views size="sm" />);
    expect(screen.getByRole('radiogroup')).toHaveAttribute('data-size', 'sm');
    expect(screen.getByRole('radio', { name: 'Board' }).className).toContain('h-[22px]');
  });

  it('renders icon-only items with their own labels', () => {
    render(
      <SegmentedIcons aria-label="Layout" value="grid" onValueChange={() => undefined}>
        <SegmentedIconItem value="grid" aria-label="Grid" />
        <SegmentedIconItem value="list" aria-label="List" />
      </SegmentedIcons>,
    );
    expect(screen.getByRole('radio', { name: 'Grid' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'List' }).className).toContain('aria-checked:bg-paper-deep');
  });

  it('keeps the chosen chip when a tooltip trigger wraps the item', () => {
    // Radix Tooltip.Trigger asChild writes its own data-state (closed / delayed-open) onto the item.
    render(
      <SegmentedIcons aria-label="Layout" value="grid" onValueChange={() => undefined}>
        <SegmentedIconItem value="grid" aria-label="Grid" data-state="closed" />
        <SegmentedIconItem value="list" aria-label="List" />
      </SegmentedIcons>,
    );
    const grid = screen.getByRole('radio', { name: 'Grid' });
    expect(grid).toHaveAttribute('aria-checked', 'true');
    expect(grid.className).not.toContain('data-[state=on]');
  });
});
