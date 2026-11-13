// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Tabs, TabsContent, TabsIconTrigger, TabsList, TabsTrigger } from '../../../src/fantay/ui/tabs';

afterEach(cleanup);

function Workspace({ variant, size }: { variant?: 'pill' | 'line'; size?: 'sm' | 'md' }) {
  return (
    <Tabs defaultValue="board">
      <TabsList aria-label="Workspace" variant={variant} size={size}>
        <TabsTrigger value="board">Board</TabsTrigger>
        <TabsTrigger value="files">Files</TabsTrigger>
        <TabsIconTrigger value="system" icon={<span>◆</span>} badge={<span data-testid="badge">2</span>}>
          System
        </TabsIconTrigger>
      </TabsList>
      <TabsContent value="board">Board panel</TabsContent>
      <TabsContent value="files">Files panel</TabsContent>
      <TabsContent value="system">System panel</TabsContent>
    </Tabs>
  );
}

describe('Tabs', () => {
  it('defaults the list to pill / sm and marks the active trigger', () => {
    render(<Workspace />);
    const list = screen.getByRole('tablist', { name: 'Workspace' });
    expect(list).toHaveAttribute('data-variant', 'pill');
    expect(list).toHaveAttribute('data-size', 'sm');
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('data-state', 'inactive');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Board panel');
  });

  it('switches tabs and panels', () => {
    render(<Workspace variant="line" size="md" />);
    expect(screen.getByRole('tablist')).toHaveAttribute('data-variant', 'line');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('data-state', 'inactive');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Files panel');
  });

  it('keeps the folded label of an icon tab in its accessible name', () => {
    render(<Workspace />);
    const system = screen.getByRole('tab', { name: /System/ });
    expect(system).toHaveAttribute('data-state', 'inactive');
    expect(screen.getByTestId('badge')).toBeInTheDocument();
    fireEvent.mouseDown(system);
    expect(system).toHaveAttribute('data-state', 'active');
  });
});
