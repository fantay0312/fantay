// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../../../src/fantay/ui/sheet';

afterEach(cleanup);

describe('Sheet', () => {
  it('opens from its trigger as a right-side fx dialog with a localized close button', () => {
    render(
      <Sheet>
        <SheetTrigger>Materials</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>素材库</SheetTitle>
            <SheetDescription>Browse and insert.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Materials' }));
    const sheet = screen.getByRole('dialog', { name: '素材库' });
    expect(sheet).toHaveClass('fx');
    expect(sheet).toHaveAttribute('data-side', 'right');
    expect(sheet.className).toContain('right-0');
    expect(sheet.className).toContain('starting:translate-x-10');
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes a pixel width and a side, and reports Escape through onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(
      <I18nProvider initial="zh-CN">
        <Sheet open onOpenChange={onOpenChange}>
          <SheetContent side="left" width={280}>
            <SheetTitle>侧栏</SheetTitle>
            <SheetDescription>Sidebar</SheetDescription>
          </SheetContent>
        </Sheet>
      </I18nProvider>,
    );
    const sheet = screen.getByRole('dialog', { name: '侧栏' });
    expect(sheet).toHaveAttribute('data-side', 'left');
    expect(sheet.style.getPropertyValue('--fx-sheet-width')).toBe('280px');
    expect(sheet.className).toContain('w-[min(var(--fx-sheet-width,384px),calc(100vw-24px))]');
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('drops the overlay when non-modal', () => {
    render(
      <Sheet open modal={false}>
        <SheetContent showCloseButton={false}>
          <SheetTitle>Drawer</SheetTitle>
          <SheetDescription>Non-modal</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Drawer' })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
