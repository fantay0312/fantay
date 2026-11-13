// @vitest-environment jsdom
import '../fantay/helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '../../src/components/ChatComposer';
import { ExecutionPermissionPicker } from '../../src/components/ExecutionPermissionPicker';
import { ChatEmptyMascot } from '../../src/components/chat/ChatMascot';
import { I18nProvider } from '../../src/i18n';

afterEach(() => {
  cleanup();
});

describe('ExecutionPermissionPicker', () => {
  it('renders a quiet toolbar trigger with Fantay tooltip in default unset state', () => {
    render(
      <I18nProvider initial="zh-CN">
        <ExecutionPermissionPicker value={null} supported saving={false} onChange={vi.fn()} />
      </I18nProvider>,
    );

    const trigger = screen.getByRole('button', { name: '执行权限' });
    expect(trigger.getAttribute('data-permission')).toBe('default');
    expect(trigger.getAttribute('data-tooltip')).toBe('执行权限');
    expect(trigger.getAttribute('title')).toBeNull();
    expect(trigger.className).toContain('od-tooltip');
  });

  it('exposes semantic active state, aligned icon slots, and reset action when an override is set', () => {
    const onChange = vi.fn();

    render(
      <I18nProvider initial="zh-CN">
        <ExecutionPermissionPicker
          value="danger-full-access"
          supported
          saving={false}
          onChange={onChange}
        />
      </I18nProvider>,
    );

    const trigger = screen.getByRole('button', { name: '执行权限 · 完全权限' });
    expect(trigger.getAttribute('data-permission')).toBe('danger-full-access');
    expect(trigger.getAttribute('data-tooltip')).toBe('执行权限 · 完全权限');
    expect(trigger.querySelectorAll('svg')).toHaveLength(1);

    fireEvent.keyDown(trigger, { key: 'Enter' });

    const fullAccessItem = screen.getByRole('menuitemradio', { name: '完全权限' });
    expect(fullAccessItem.getAttribute('aria-checked')).toBe('true');
    expect(fullAccessItem.querySelector('svg')).not.toBeNull();

    const resetItem = screen.getByRole('menuitem', { name: '使用 Agent 默认权限' });
    expect(resetItem.querySelector('svg')).not.toBeNull();

    fireEvent.click(resetItem);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('switches permissions via radio items and respects unsupported agents while keeping reset available', () => {
    const onChange = vi.fn();

    const { rerender } = render(
      <I18nProvider initial="zh-CN">
        <ExecutionPermissionPicker value={null} supported saving={false} onChange={onChange} />
      </I18nProvider>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: '执行权限' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: '工作区内修改' }));
    expect(onChange).toHaveBeenCalledWith('workspace-write');

    rerender(
      <I18nProvider initial="zh-CN">
        <ExecutionPermissionPicker
          value="read-only"
          supported={false}
          saving={false}
          onChange={onChange}
        />
      </I18nProvider>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: '执行权限 · 仅可查看' }), { key: 'Enter' });
    const disabledRadio = screen.getByRole('menuitemradio', { name: '完全权限' });
    expect(disabledRadio.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: '使用 Agent 默认权限' })).toBeTruthy();
  });
});

describe('Empty chat composer & toolbar layout contracts', () => {
  it('omits actionable send tooltip while the composer is empty and disabled', () => {
    render(
      <I18nProvider initial="zh-CN">
        <ChatComposer
          projectId="project-1"
          projectFiles={[]}
          streaming={false}
          onEnsureProject={async () => 'project-1'}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
      </I18nProvider>,
    );

    const sendButton = screen.getByTestId('chat-send');
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    expect(sendButton.className).not.toContain('od-tooltip');
    expect(sendButton.getAttribute('data-tooltip')).toBeNull();
    expect(sendButton.getAttribute('title')).toBeNull();
  });

  it('mounts interactive mascot to the left of the greeting in ChatEmptyMascot', async () => {
    render(
      <I18nProvider initial="zh-CN">
        <ChatEmptyMascot />
      </I18nProvider>,
    );

    const empty = screen.getByTestId('chat-empty-mascot');
    const mascot = empty.querySelector('[data-testid="fantay-mascot"]');
    const greeting = empty.querySelector('p');
    expect(mascot).not.toBeNull();
    expect(greeting).not.toBeNull();
    expect(mascot?.hasAttribute('data-interactive')).toBe(true);
    expect(mascot?.hasAttribute('data-appear')).toBe(true);
    expect(mascot!.compareDocumentPosition(greeting!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(mascot!);
    await waitFor(() => expect(empty.textContent).toContain('今天想做点什么？'));
  });
});
