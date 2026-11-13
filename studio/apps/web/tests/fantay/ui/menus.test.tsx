// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from '../../../src/fantay/ui/button';
import { Chip } from '../../../src/fantay/ui/chip';
import { IconButton } from '../../../src/fantay/ui/icon-button';
import { Toolbar, ToolbarControl } from '../../../src/fantay/ui/toolbar';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../../../src/fantay/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../src/fantay/ui/dropdown-menu';
import { menuItemVariants } from '../../../src/fantay/ui/menu';

afterEach(cleanup);

describe('DropdownMenu', () => {
  it('opens from its trigger into an fx surface with icons, shortcuts and descriptions', () => {
    const onRename = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Project</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent width="md">
          <DropdownMenuItem icon={<span data-testid="rename-icon">✎</span>} shortcut="mod+d" onSelect={onRename}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem description="Copies files and the board">Duplicate</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem tone="danger">Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'Project' });
    fireEvent.keyDown(trigger, { key: 'Enter' });

    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('fx');
    expect(menu.className).toContain('w-[min(220px,calc(100vw-24px))]');
    expect(menu.className).toContain('z-(--z-fx-floating)');

    const rename = screen.getByRole('menuitem', { name: /Rename/ });
    expect(screen.getByTestId('rename-icon')).toBeInTheDocument();
    expect(rename.querySelectorAll('kbd')).toHaveLength(2);
    expect(rename.textContent).toContain('Ctrl');

    expect(screen.getByRole('menuitem', { name: /Duplicate/ }).textContent).toContain('Copies files and the board');
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(remove).toHaveAttribute('data-tone', 'danger');
    expect(remove.className).toContain('text-accent-ink');

    fireEvent.click(rename);
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('defaults to the 340px reading width and end alignment', () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger asChild>
          <Button>Open</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCaption>Sort by</DropdownMenuCaption>
          <DropdownMenuRadioGroup value="recent">
            <DropdownMenuRadioItem value="recent">Recent</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuCheckboxItem checked>Show grid</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const menu = screen.getByRole('menu');
    expect(menu.className).toContain('w-[min(340px,calc(100vw-24px))]');
    expect(screen.getByRole('menuitemradio', { name: 'Recent' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show grid' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Sort by').className).toContain('text-caption');
  });

  it('keeps the disabled look of a primitive rendered as its trigger (asChild)', () => {
    // the Radix trigger passes `data-disabled: undefined` through Slot; the primitive's own state wins
    for (const trigger of [
      <Button key="button" disabled>
        Export
      </Button>,
      <Button key="loading" loading>
        Export
      </Button>,
      <IconButton key="icon" aria-label="Export" disabled />,
      <Chip key="chip" disabled>
        Export
      </Chip>,
    ]) {
      render(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>PNG</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );
      expect(screen.getByRole('button', { name: 'Export' }), String(trigger.key)).toHaveAttribute('data-disabled', '');
      cleanup();
    }
    render(
      <Toolbar aria-label="Tools">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ToolbarControl label="Export" disabled />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>PNG</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Toolbar>,
    );
    const control = screen.getByRole('button', { name: 'Export' });
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute('data-disabled', '');
  });
});

describe('ContextMenu', () => {
  it('opens on right-click with checkbox and toned items', () => {
    const onCopy = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="area">Board</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem shortcut="mod+c" onSelect={onCopy}>
            Copy
          </ContextMenuItem>
          <ContextMenuCheckboxItem checked>Locked</ContextMenuCheckboxItem>
          <ContextMenuItem tone="danger">Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId('area'));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('fx');
    expect(menu.className).toContain('min-w-[190px]');
    expect(screen.getByRole('menuitemcheckbox', { name: 'Locked' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute('data-tone', 'danger');
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy/ }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('shares one row recipe across menus', () => {
    expect(menuItemVariants({ tone: 'danger' })).toContain('data-highlighted:bg-accent-ink/10');
    expect(menuItemVariants()).toContain('data-highlighted:bg-sub');
  });
});
