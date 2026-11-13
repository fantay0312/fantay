// @vitest-environment jsdom
/**
 * 化开引擎的排程(Fantay 2026-11-08):连续排程、直播窗口、回放认领、代理对、流停时收尾。
 *
 * 这几条都来自对新引擎的对抗式审查,每一条对应一个真实会出现的画面:
 *  · 流速超过 100 字/秒时队尾一路顶到 2s 预算,收到的字晚 1.6–2s 才露面,底下空着几行;
 *  · 同一条消息、同一次提交里有两只宿主一起落地重放的历史,第二只把历史重播一遍;
 *  · emoji 被切点劈在代理对中间,屏幕上是两个替换框;
 *  · 流停的那一帧又带来几个新字,还在排队的字「啪」一下全部出现。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useRef, type ReactElement } from 'react';
import {
  CHAR_MS,
  REVEAL_BUDGET_MS,
  markHistoryReplayLanded,
  useCharReveal,
} from '../../../src/components/chat/useCharReveal';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function Prose({ text, streaming, id = 'prose' }: { text: string; streaming: boolean; id?: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useCharReveal(ref, streaming);
  return <div ref={ref} data-testid={id}><p>{text}</p></div>;
}

const spans = (root: ParentNode = document): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.rv')];
const delays = (root: ParentNode = document): number[] =>
  spans(root).map((s) => Number.parseFloat(s.style.animationDelay || '0'));

describe('直播窗口:流得再快,还没起跑的字也只领先几百毫秒', () => {
  it('300 字/秒灌 3 秒,最晚的起跑点始终不超过 now + 直播窗口', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let text = '起';
    const { rerender } = render(<Prose text={text} streaming />);
    let worstLead = 0;
    for (let frame = 0; frame < 180; frame += 1) {      // 60fps × 3s
      text += '流'.repeat(5);                            // 5 字 / 帧 = 300 字/秒
      vi.advanceTimersByTime(16);
      rerender(<Prose text={text} streaming />);
      worstLead = Math.max(worstLead, ...delays());
    }
    // 旧的「接在队尾、错开 10ms」会把它顶到 ~1600ms
    expect(worstLead).toBeLessThanOrEqual(260);
    expect(document.querySelector('[data-testid="prose"]')?.textContent).toBe(text);
  });

  it('整段一次到货仍是打字机:按逐字预算铺开,而不是挤进直播窗口一闪而过', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { rerender } = render(<Prose text="起" streaming />);
    vi.advanceTimersByTime(CHAR_MS + 50);
    rerender(<Prose text={`起${'整'.repeat(300)}`} streaming />);
    const last = Math.max(...delays());
    expect(last).toBeGreaterThan(1_000);
    expect(last).toBeLessThanOrEqual(REVEAL_BUDGET_MS - CHAR_MS);
  });
});

describe('重放的历史:同一条消息、同一次提交里的宿主一并落定', () => {
  it('两只宿主一起落地重放,第二只也不化开;之后真正的新字照旧化开', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const Turn = ({ a, b }: { a: string; b: string }): ReactElement => (
      <div data-assistant-message-id="m1">
        <Prose id="a" text={a} streaming />
        <Prose id="b" text={b} streaming />
      </div>
    );
    const { rerender } = render(<Turn a="" b="" />);
    vi.advanceTimersByTime(1_000);                      // 伪造时钟从 0 起,而 0 在模块里表示「没有标记」
    markHistoryReplayLanded();
    rerender(<Turn a="上一个 run 的结论" b="这一个 run 已经写过的叙述" />);
    expect(spans()).toHaveLength(0);

    vi.advanceTimersByTime(500);
    rerender(<Turn a="上一个 run 的结论" b="这一个 run 已经写过的叙述,接着写" />);
    expect(spans().map((s) => s.textContent).join('')).toBe(',接着写');
  });
});

describe('代理对', () => {
  it('切点不会落在 emoji 中间', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { rerender } = render(<Prose text="a" streaming />);
    rerender(<Prose text="a😀" streaming />);
    vi.advanceTimersByTime(CHAR_MS + 20);               // 「a」那一格开完,「😀」还在
    rerender(<Prose text="a😀b" streaming />);
    const host = document.querySelector('[data-testid="prose"]')!;
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      expect(lone.test(node.nodeValue ?? ''), `被劈开的代理对:${JSON.stringify(node.nodeValue)}`).toBe(false);
    }
    expect(host.textContent).toBe('a😀b');
  });
});

describe('流停的那一帧又来了新字', () => {
  it('不当场全部露出:这一帧照常排完,收尾定时器到点再撒手', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { rerender } = render(<Prose text="想" streaming />);
    rerender(<Prose text={`想${'了'.repeat(40)}`} streaming />);
    vi.advanceTimersByTime(30);
    rerender(<Prose text={`想${'了'.repeat(40)}好`} streaming={false} />);
    expect(spans().length).toBeGreaterThan(0);
    expect(spans().map((s) => s.textContent).join('')).toContain('好');
    vi.advanceTimersByTime(REVEAL_BUDGET_MS + 50);
    expect(spans()).toHaveLength(0);
    expect(document.querySelector('[data-testid="prose"]')?.textContent).toBe(`想${'了'.repeat(40)}好`);
  });
});
