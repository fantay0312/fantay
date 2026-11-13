// @vitest-environment jsdom

/**
 * The per-message gray "error" status pill is suppressed ONLY for the failed
 * run that ChatPane renders its top-level error card for (errorCardOwnerId).
 * Other failed turns — older history, or once a follow-up makes this no longer
 * the last assistant message — must keep their pill so the error detail still
 * survives reload / history review (regression: #3083 review).
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage } from '../../src/types';

beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      removeItem: (k: string) => store.delete(k),
      setItem: (k: string, v: string) => store.set(k, v),
    },
  });
});

afterEach(cleanup);

function failedMessage(): ChatMessage {
  return {
    id: 'msg-failed',
    role: 'assistant',
    content: '',
    runStatus: 'failed',
    startedAt: 1700000000,
    endedAt: 1700000005,
    events: [
      { kind: 'status', label: 'error', detail: 'boom-401' },
    ] as ChatMessage['events'],
    producedFiles: [],
  } as ChatMessage;
}

describe('AssistantMessage error-pill suppression', () => {
  /*
   * 这一族原来守的是「**只有**拥有报错卡的那条消息才藏 error 行」—— 也就是说
   * 其余任何一条失败消息都还把上游原文戳在对话里。用户 2026-08-27 指认了两次
   * (「为什么还会有这种错误样式?? 你的错误卡片呢??」「设计稿里哪有这种状态行」),
   * 裁决是**一律不出**:当前那一轮由报错卡说,历史轮次由壳头那句「运行失败」说,
   * 上游原文归卡上的「查看详情」。所以三条断言全部翻面。
   *
   * ── Fantay 2026-11-08:壳头带一句原因 ────────────────────────────────────
   *
   * owner 简报:失败的壳头**不许只是一个红词**,要「运行失败 · 原因」—— 分类器认得的用
   * 报错卡那一份标题,认不得的退回 daemon 原文的第一行(静音色、单行省略、全文在
   * `title` 上)。那枚红框 error 行**仍然一律不出**:这条测试守的是「没有第二块
   * 报错样式戳在回答中间」,现在原文唯一允许出现的位置是壳头那一截原因。
   *
   * 拥有报错卡的那一轮壳头**不写**原因:卡紧贴在下面,标题就是同一句话,写两遍是
   * 同屏复读(和页脚不再重复「已完成」是同一条)。
   */
  it.each([
    ['nobody owns the card', null],
    ['another message owns it', 'some-other-message'],
  ])('never renders an error status row — the shell head carries the reason — %s', (_name, owner) => {
    render(
      <AssistantMessage
        message={failedMessage()}
        streaming={false}
        projectId="p1"
        errorCardOwnerId={owner}
        onFeedback={vi.fn()}
      />,
    );
    // 壳头:红色状态词 + 原因(分类器不认得这条,所以是原文)
    expect(screen.getByTestId('chat-shell-status').textContent).toBe('Run failed');
    const reason = screen.getByTestId('chat-shell-head-note');
    expect(reason.textContent).toBe('boom-401');
    expect(reason.getAttribute('title')).toBe('boom-401');
    // 原文**只**在那一截里出现 —— 没有第二块 error 行
    for (const hit of screen.queryAllByText('boom-401')) {
      expect(hit.closest('[data-testid="chat-shell-head-note"]'), '原文以 error 行的形式漏到了回答里').not.toBeNull();
    }
  });

  it('never renders the raw error detail — this message owns the card (the card states the reason)', () => {
    render(
      <AssistantMessage
        message={failedMessage()}
        streaming={false}
        projectId="p1"
        errorCardOwnerId="msg-failed"
        onFeedback={vi.fn()}
      />,
    );
    expect(screen.getByTestId('chat-shell-status').textContent).toBe('Run failed');
    expect(screen.queryByTestId('chat-shell-head-note'), '卡就在下面,壳头又说了一遍原因').toBeNull();
    expect(screen.queryByText('boom-401')).toBeNull();
  });

  it('a JSON transport envelope never becomes the head reason — the generic title stands in', () => {
    const message = failedMessage();
    message.events = [{
      kind: 'status',
      label: 'error',
      detail: '{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"Internal error"}}',
    }] as ChatMessage['events'];
    render(
      <AssistantMessage message={message} streaming={false} projectId="p1" onFeedback={vi.fn()} />,
    );
    expect(screen.getByTestId('chat-shell-head-note').textContent).toBe('The task could not be completed');
  });

  it.each([
    ['a prefixed protocol envelope', 'json-rpc id 4: opencode event stream: {"id":"evt_9f2","properties":{"sessionID":"ses_1"}}'],
    ['a stderr line with a local path', "Error: ENOENT: no such file, open '/Users/someone/.config/opencode/x.json'"],
  ])('%s never reaches the head or its title — the generic title stands in', (_name, detail) => {
    const message = failedMessage();
    message.events = [{ kind: 'status', label: 'error', detail }] as ChatMessage['events'];
    render(
      <AssistantMessage message={message} streaming={false} projectId="p1" onFeedback={vi.fn()} />,
    );
    const note = screen.getByTestId('chat-shell-head-note');
    expect(note.textContent).toBe('The task could not be completed');
    expect(note.getAttribute('title') ?? '').not.toContain(detail.slice(0, 12));
  });
});
