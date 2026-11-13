// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerProjectChatSender,
  resetProjectChatBridgeForTests,
  revealProjectChat,
  sendToProjectChat,
  useProjectChatBridge,
  type ProjectChatSendOptions,
  type ProjectChatSender,
} from '../../../src/fantay/chat/project-chat-bridge';

const MOTION: ProjectChatSendOptions = { skillIds: ['fantay-movie'], source: 'motion-editor' };

function hooks(overrides: Partial<{ busy: () => boolean; reveal: () => void }> = {}) {
  return { busy: () => false, reveal: vi.fn(), ...overrides };
}

describe('project chat bridge', () => {
  afterEach(() => {
    cleanup();
    resetProjectChatBridgeForTests();
  });

  it("reports 'no-chat' without a registered ProjectView", async () => {
    await expect(sendToProjectChat('p1', 'Make a storyboard', MOTION)).resolves.toEqual({ accepted: false, reason: 'no-chat' });
    expect(revealProjectChat('p1')).toBe(false);
  });

  it("reports 'busy' while a run is in flight without calling the sender", async () => {
    const sender = vi.fn<ProjectChatSender>(async () => true);
    registerProjectChatSender('p1', sender, hooks({ busy: () => true }));
    await expect(sendToProjectChat('p1', 'Make a storyboard', MOTION)).resolves.toEqual({ accepted: false, reason: 'busy' });
    expect(sender).not.toHaveBeenCalled();
  });

  it('accepts when the sender resolves true and passes the prompt and skills', async () => {
    const sender = vi.fn<ProjectChatSender>(async () => true);
    registerProjectChatSender('p1', sender, hooks());
    await expect(sendToProjectChat('p1', 'Make a storyboard', MOTION)).resolves.toEqual({ accepted: true });
    expect(sender).toHaveBeenCalledWith('Make a storyboard', { skillIds: ['fantay-movie'] });
  });

  it("reports 'rejected' when the sender resolves false or throws", async () => {
    registerProjectChatSender('p1', async () => false, hooks());
    await expect(sendToProjectChat('p1', 'x', MOTION)).resolves.toEqual({ accepted: false, reason: 'rejected' });

    resetProjectChatBridgeForTests();
    registerProjectChatSender('p1', async () => {
      throw new Error('send failed');
    }, hooks());
    await expect(sendToProjectChat('p1', 'x', MOTION)).resolves.toEqual({ accepted: false, reason: 'rejected' });
  });

  it('defaults skillIds to an empty list', async () => {
    const sender = vi.fn<ProjectChatSender>(async () => true);
    registerProjectChatSender('p1', sender, hooks());
    await sendToProjectChat('p1', 'x', { source: 'motion-create' });
    expect(sender).toHaveBeenCalledWith('x', { skillIds: [] });
  });

  it('ignores senders of other projects', async () => {
    const sender = vi.fn<ProjectChatSender>(async () => true);
    const reveal = vi.fn();
    registerProjectChatSender('p1', sender, hooks({ reveal }));
    await expect(sendToProjectChat('p2', 'x', MOTION)).resolves.toEqual({ accepted: false, reason: 'no-chat' });
    expect(revealProjectChat('p2')).toBe(false);
    expect(sender).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it('unregisters, restoring an earlier sender of the same project', async () => {
    const first = vi.fn<ProjectChatSender>(async () => true);
    const second = vi.fn<ProjectChatSender>(async () => true);
    registerProjectChatSender('p1', first, hooks());
    const unregisterSecond = registerProjectChatSender('p1', second, hooks());

    await sendToProjectChat('p1', 'a', MOTION);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    unregisterSecond();
    unregisterSecond();
    await sendToProjectChat('p1', 'b', MOTION);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('reveals the chat column of a mounted project', () => {
    const reveal = vi.fn();
    registerProjectChatSender('p1', async () => true, hooks({ reveal }));
    expect(revealProjectChat('p1')).toBe(true);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('registers from React with the latest busy/send/reveal and unregisters on unmount', async () => {
    const firstSend = vi.fn<ProjectChatSender>(async () => true);
    const latestSend = vi.fn<ProjectChatSender>(async () => true);
    const reveal = vi.fn();
    const view = renderHook((props: { busy: boolean; send: ProjectChatSender }) => useProjectChatBridge({
      projectId: 'p1', busy: props.busy, send: props.send, reveal,
    }), { initialProps: { busy: true, send: firstSend } });

    await expect(sendToProjectChat('p1', 'x', MOTION)).resolves.toEqual({ accepted: false, reason: 'busy' });

    view.rerender({ busy: false, send: latestSend });
    await expect(sendToProjectChat('p1', 'x', MOTION)).resolves.toEqual({ accepted: true });
    expect(latestSend).toHaveBeenCalledWith('x', { skillIds: ['fantay-movie'] });
    expect(firstSend).not.toHaveBeenCalled();
    expect(revealProjectChat('p1')).toBe(true);
    expect(reveal).toHaveBeenCalledTimes(1);

    view.unmount();
    await expect(sendToProjectChat('p1', 'x', MOTION)).resolves.toEqual({ accepted: false, reason: 'no-chat' });
  });
});
