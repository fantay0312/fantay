// @vitest-environment jsdom
/**
 * 执行记录壳头那一行(Fantay 2026-11-08 交互打磨,owner:动画「垃圾和不协调」、
 * 失败只有一个红词、页脚和壳头各说一遍「已完成」)。
 *
 * 四件事,各钉各的:
 *  1. **落定之后的小结** —— 「已完成 · 已思考 2s · 3 个操作」。每一截按 §3 降级:
 *     拿不到就不写,不写 0。进行中 / 已取消不写。
 *  2. **失败带原因** —— 「运行失败 · 原因」,全文在 `title` 上。原因由消息层递进来。
 *  3. **换词** —— 档变了才演:旧词作为 `aria-hidden` 的残影退场,一个周期后卸掉;
 *     挂载不演;减少动态效果时直接换。
 *  4. **页脚不再重复「已完成」** —— 壳头已经落定为完成时页脚不挂那枚勾;没有壳的那一轮、
 *     带着额外信息的那几档(未完成等)照旧。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ChatMessage, PersistedAgentEvent } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { AssistantMessage } from '../../../src/components/AssistantMessage';
import { ExecutionShell, type ShellFailureReason } from '../../../src/components/chat/ExecutionShell';
import { SWAP_SETTLE_MS } from '../../../src/components/chat/SwapLabel';
import type { ExecutionShell as Shell, ShellItem } from '../../../src/runtime/chat/contract';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const tool = (id: string): ShellItem => ({
  kind: 'tool', id, tool: 'read', title: `读取 ${id}`, name: 'Read', rawTitle: false,
  file: null, delta: null, hits: null, pattern: null, elapsedMs: 400,
  failed: false, failReason: null, command: null, terminal: null, pending: false,
} as ShellItem);
const think = (text: string, elapsedMs?: number): ShellItem => ({
  kind: 'text', text, thinking: true, ...(elapsedMs != null ? { elapsedMs } : {}),
});
const step = (items: ShellItem[]): ShellItem => ({
  kind: 'todo',
  segment: {
    content: '复刻列表页', status: 'completed', recalled: false, abandoned: false, implicit: false,
    items, elapsedMs: 3_000,
  },
});

function shellOf(over: Partial<Shell>): Shell {
  return {
    kind: 'shell', id: 's1', status: 'done', stopped: false, thinking: false,
    elapsedMs: 62_000, quietMs: null, segments: [],
    items: [think('先看两张图。', 2_100), tool('a.png'), step([tool('b.png'), tool('c.png')])],
    ...over,
  } as Shell;
}

const show = (shell: Shell, failureReason?: ShellFailureReason | null): ReactElement => (
  <I18nProvider initial="zh-CN">
    <ExecutionShell shell={shell} deferCollapsedBodies={false} failureReason={failureReason} />
  </I18nProvider>
);

const status = (): string => screen.getByTestId('chat-shell-status').textContent ?? '';
const note = (): HTMLElement | null => screen.queryByTestId('chat-shell-head-note');

/** 让 `SwapLabel` 认为「可以动」:jsdom 没有 `matchMedia`,缺席时它按「不动」处理 */
function allowMotion(reduce = false): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe('落定之后的小结', () => {
  it('已完成 · 已思考 2.1s · 3 个操作 —— 抽屉里的工具行也算', () => {
    render(show(shellOf({})));
    expect(status()).toBe('已完成');
    expect(note()?.textContent).toBe('已思考 2.1s · 3 个操作');
  });

  it('想了多久拿不到 → 只写操作数,不写「已思考 0s」', () => {
    render(show(shellOf({ items: [think('没有时刻的推理'), tool('a.png')] })));
    expect(note()?.textContent).toBe('1 个操作');
  });

  it('一次工具都没动、也没有思考 → 整句不出,只剩状态词', () => {
    render(show(shellOf({ items: [{ kind: 'text', text: '只有一句叙述。' }] })));
    expect(status()).toBe('已完成');
    expect(note()).toBeNull();
  });

  it('英文单复数:1 action / 2 actions', () => {
    const { unmount } = render(
      <I18nProvider initial="en"><ExecutionShell shell={shellOf({ items: [tool('a')] })} /></I18nProvider>,
    );
    expect(note()?.textContent).toBe('1 action');
    unmount();
    render(
      <I18nProvider initial="en"><ExecutionShell shell={shellOf({ items: [tool('a'), tool('b')] })} /></I18nProvider>,
    );
    expect(note()?.textContent).toBe('2 actions');
  });

  it('进行中不写小结 —— 过程在壳里一行行长出来', () => {
    render(show(shellOf({ status: 'running' })));
    expect(status()).toBe('进行中');
    expect(note()).toBeNull();
  });

  it('已取消不写小结', () => {
    render(show(shellOf({ status: 'running', stopped: true })));
    expect(status()).toBe('已取消');
    expect(note()).toBeNull();
  });

  it('小结在状态词**后面**,而且不是读屏/文本里多出来的一个词', () => {
    const { container } = render(show(shellOf({})));
    const summary = container.querySelector('details[class*="flat"] > summary');
    expect(summary?.textContent).toMatch(/^已完成·已思考 2\.1s · 3 个操作/);
  });
});

describe('失败带原因,不再是一个光秃秃的红词', () => {
  it('运行失败 · 原因,全文挂在 title 上', () => {
    render(show(
      shellOf({ status: 'failed' }),
      { label: '当前网络中断', full: 'ECONNRESET: socket hang up\n    at TLSSocket' },
    ));
    expect(status()).toBe('运行失败');
    // 看得见的只有分类标题;全文在 title 上,同时给键盘 / 读屏一份视觉隐藏的副本
    expect(note()?.firstChild?.textContent).toBe('当前网络中断');
    expect(note()?.getAttribute('title')).toBe('ECONNRESET: socket hang up\n    at TLSSocket');
    expect(note()?.textContent).toContain('ECONNRESET: socket hang up');
  });

  it('消息层没给原因(老消息、手搭夹具)→ 退回只写「运行失败」,不编原因', () => {
    render(show(shellOf({ status: 'failed' })));
    expect(status()).toBe('运行失败');
    expect(note()).toBeNull();
  });

  it('失败那一档不写「已思考 / N 个操作」—— 那一截归原因', () => {
    render(show(shellOf({ status: 'failed' }), { label: '任务意外中断', full: '任务意外中断' }));
    expect(note()?.textContent).toBe('任务意外中断');
  });
});

describe('换词', () => {
  it('档变了:旧词作为 aria-hidden 的残影退场,一个周期后卸掉', () => {
    allowMotion();
    vi.useFakeTimers();
    const { rerender } = render(show(shellOf({ status: 'running' })));
    expect(screen.queryByTestId('chat-swap-outgoing'), '挂载不许演换词').toBeNull();

    rerender(show(shellOf({ status: 'done' })));
    const outgoing = screen.getByTestId('chat-swap-outgoing');
    expect(outgoing.getAttribute('aria-hidden')).toBe('true');
    expect(outgoing.textContent).toBe('进行中');
    // 新词已经就位,而且不止一份(残影里那份不算)
    expect(screen.getByText('已完成')).toBeTruthy();

    act(() => { vi.advanceTimersByTime(SWAP_SETTLE_MS); });
    expect(screen.queryByTestId('chat-swap-outgoing'), '残影没卸掉').toBeNull();
    expect(status()).toBe('已完成');
  });

  it('同一档里的原地更新不演换词(失败原因晚一帧才到)', () => {
    allowMotion();
    const { rerender } = render(show(shellOf({ status: 'failed' })));
    rerender(show(shellOf({ status: 'failed' }), { label: '当前网络中断', full: '当前网络中断' }));
    expect(screen.queryByTestId('chat-swap-outgoing')).toBeNull();
    expect(note()?.textContent).toBe('当前网络中断');
  });

  it('减少动态效果:直接换字,不留残影', () => {
    allowMotion(true);
    const { rerender } = render(show(shellOf({ status: 'running' })));
    rerender(show(shellOf({ status: 'done' })));
    expect(screen.queryByTestId('chat-swap-outgoing')).toBeNull();
    expect(status()).toBe('已完成');
  });
});

/* ── 页脚 ───────────────────────────────────────────────────────────── */

const T0 = 1_800_000_000_000;
const settled = (events: PersistedAgentEvent[], over: Partial<ChatMessage> = {}): ReactElement => (
  <I18nProvider initial="zh-CN">
    <AssistantMessage
      message={{
        id: 'm1', role: 'assistant', content: '', createdAt: T0, startedAt: T0, endedAt: T0 + 5_000,
        runStatus: 'succeeded', events, ...over,
      } as ChatMessage}
      streaming={false}
      isLast
    />
  </I18nProvider>
);

describe('页脚不再重复「已完成」', () => {
  it('壳头已经落定为「已完成」→ 页脚不挂那枚勾,时间照旧', () => {
    render(settled([
      { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' }, startedAt: T0 + 1_000 },
      { kind: 'tool_result', toolUseId: 't1', content: 'ok', isError: false, completedAt: T0 + 2_000 },
      { kind: 'text', text: '看完了。' },
    ], { content: '看完了。' }));
    expect(status()).toBe('已完成');
    expect(screen.queryByTestId('assistant-label'), '页脚又把「已完成」说了一遍').toBeNull();
    expect(screen.getByTestId('assistant-footer').querySelector('time')).not.toBeNull();
  });

  it('没有壳的那一轮(纯问答)→ 页脚的「已完成」仍是唯一那句,照旧出', () => {
    render(settled([{ kind: 'text', text: '直接回答你。' }], { content: '直接回答你。' }));
    expect(screen.queryByTestId('chat-shell-status')).toBeNull();
    expect(screen.getByTestId('assistant-label').textContent).toContain('已完成');
  });
});
