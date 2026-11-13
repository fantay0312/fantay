// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { ConfirmDialog, Modal, ModalLede, ModalTitle } from '../../../src/fantay/ui/dialog';

afterEach(cleanup);

function renderModal(props: Partial<ComponentProps<typeof Modal>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <Modal open onClose={onClose} {...props}>
      <ModalTitle>New design</ModalTitle>
      <ModalLede>Pick a size.</ModalLede>
    </Modal>,
  );
  return { onClose, ...utils };
}

describe('Modal', () => {
  it('renders a labelled dialog in an fx surface with an i18n close button', () => {
    renderModal();
    const dialog = screen.getByRole('dialog', { name: 'New design' });
    expect(dialog).toHaveClass('fx');
    expect(dialog).toHaveAttribute('data-size', 'md');
    expect(dialog.className).toContain('max-w-[min(520px,calc(100vw-24px))]');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('calls onClose on Escape and on the close button', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('offers a 960px 2xl size capped at the viewport', () => {
    renderModal({ size: '2xl' });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-size', '2xl');
    expect(dialog.className).toContain('max-w-[min(960px,calc(100vw-24px))]');
  });

  it('can hide the close button and renders nothing while closed', () => {
    const { rerender } = renderModal({ showClose: false });
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    rerender(
      <Modal open={false} onClose={() => undefined}>
        <ModalTitle>New design</ModalTitle>
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('localizes the close label (zh-CN → 关闭)', () => {
    render(
      <I18nProvider initial="zh-CN">
        <Modal open onClose={() => undefined}>
          <ModalTitle>新建设计</ModalTitle>
          <ModalLede>选择尺寸</ModalLede>
        </Modal>
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('uses the filled danger button for destructive confirms and default i18n labels', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} title="Delete this board?" destructive onConfirm={onConfirm} />,
    );
    expect(screen.getByRole('alertdialog', { name: 'Delete this board?' })).toHaveClass('fx');
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toHaveAttribute('data-variant', 'danger');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('data-variant', 'ghost');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses primary otherwise, honours custom labels and shows busy', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={() => undefined}
        title="Publish?"
        description="Everyone with the link can see it."
        confirmLabel="Publish"
        cancelLabel="Not now"
        busy
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Publish' });
    expect(confirm).toHaveAttribute('data-variant', 'primary');
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(screen.getByText('Everyone with the link can see it.')).toBeInTheDocument();
  });

  it('cancels on Escape', () => {
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} title="Leave?" onConfirm={() => undefined} />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
