// @vitest-environment jsdom
/**
 * 壳【内】的文字也走 markdown(用户裁决 2026-09-03:「谁说按纯文本画不是 bug 的??
 * 都要 markdown 啊」)。在此之前 `SayText` 把原文塞进一个 React 文本节点,于是
 * `**加粗**` / `` `代码` `` / `## 小标题` 的语法符号**原样显示在屏幕上**。
 *
 * 这一份钉两件事,缺一不可:
 *
 *  ① **落定之后**:markdown 变成元素,屏幕上不再有裸语法。
 *  ② **流的过程中**:逐字化开(W9)不能因为块树会变形而重放已经看过的字。
 *     只测 ① 的话,化开退化成「每来一帧整段重播一次」也照样全绿 —— 那正是这一版
 *     最容易踩坏的东西:`useCharReveal` **按元素**记状态,而 markdown 的块会
 *     **换元素**(`<p>#</p>` 长成 `<h2>标</h2>`)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render as rtlRender } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { I18nProvider } from '../../../src/i18n';
import { SayText } from '../../../src/components/chat/primitives/SayText';
import { REVEAL_BUDGET_MS } from '../../../src/components/chat/useCharReveal';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

/**
 * 化开按 `performance.now()` 排程(Fantay 2026-11-08 起是连续排程:还在开的字带着原来的
 * 起跑时刻接着开,不再每帧清零)。逐帧断言「这一帧新到的是哪几个字」时,让上一批先开完 ——
 * 每次 rerender 前把时钟拨过 `REVEAL_BUDGET_MS`,于是 `.rv` 里正好是这一帧新到的字。
 */
function frameClock(): () => void {
  let now = 10_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return () => { now += 2_500; };
}

function render(ui: ReactElement) {
  const wrap = (node: ReactElement) => <I18nProvider initial="zh-CN">{node}</I18nProvider>;
  const result = rtlRender(wrap(ui));
  return { ...result, rerender: (next: ReactElement) => result.rerender(wrap(next)) };
}

/** 屏幕上真的读得到的那串字(化开把它拆成 span,但 textContent 仍是同一串) */
const seen = (root: ParentNode): string => root.textContent ?? '';

/** 这一帧新拆出来的化开单位里装的字 */
function revealed(): string {
  return [...document.querySelectorAll('.rv')].map((s) => s.textContent ?? '').join('');
}

describe('壳内文字走 markdown', () => {
  it('落定之后:加粗 / 行内代码 / 小标题都是元素,屏幕上没有裸语法', () => {
    const { container } = render(
      <SayText text={'## 交付说明\n\n先跑 **构建**,再看 `pnpm guard` 的输出。'} />,
    );

    expect(container.querySelector('h2')).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('构建');
    expect(container.querySelector('code')?.textContent).toBe('pnpm guard');
    // 语法符号一个都不许留在可读文本里
    expect(seen(container)).not.toMatch(/\*\*|`|##/);
    expect(seen(container)).toContain('交付说明');
  });

  it('列表也成列表 —— 三条要点不能粘成一行带减号的字', () => {
    const { container } = render(<SayText text={'- 读规格\n- 写红测\n- 再动手'} />);
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(seen(container)).not.toContain('- ');
  });

  it('空行分段照旧(段落数不变,只是换成 markdown 的段落)', () => {
    const { container } = render(<SayText text={'第一段。\n\n第二段。\n\n第三段。'} />);
    const ps = [...container.querySelectorAll('p')];
    expect(ps).toHaveLength(3);
    expect(ps[1]?.textContent).toBe('第二段。');
  });
});

describe('流的过程中:markdown 变形不许重放已经看过的字', () => {
  /*
   * 用中文写这一条是**故意的**:化开在单字单位下把空白裸着放(不进 span),
   * 中文没有空格,`.rv` 里的字才正好等于「这一帧新到的那几个」,断言才立得住。
   */
  it('逐帧:每一帧只化开新到的字,markdown 闭合与块型变化都不重来', () => {
    const tick = frameClock();
    const { container, rerender: rerenderNow } = render(<SayText text="先看一下" live />);
    const rerender = (next: ReactElement) => { tick(); rerenderNow(next); };

    /*
     * 第一帧:**挂载即落定**(用户 2026-09-04「已经输出过的,刷新页面或者从设置页面
     * 返回,还是会有流式的效果」;不变式与两条路径的判据在 `reveal-mount-settled.test.tsx`)。
     * host 挂上来时已经在里头的字一律算历史 —— 这一格是重挂回来的历史,还是这一段
     * 叙述的第一帧,渲染层分不出来,按较晚那条裁决一律落定。
     */
    expect(seen(container)).toBe('先看一下');
    expect(revealed()).toBe('');

    // 语法还没闭合 —— 这一刻用户确实会看到 `**`,这是取舍,不是缺陷(见组件注释)
    rerender(<SayText text="先看一下**规" live />);
    expect(seen(container)).toBe('先看一下**规');
    expect(revealed()).toBe('**规');

    // 闭合:可见文字**变短**了。已经看过的六个字一个都不许再化开一遍
    rerender(<SayText text="先看一下**规格**" live />);
    expect(container.querySelector('strong')?.textContent).toBe('规格');
    expect(seen(container)).toBe('先看一下规格');
    expect(revealed()).toBe('');

    // 接着往下写
    rerender(<SayText text="先看一下**规格**再动手" live />);
    expect(revealed()).toBe('再动手');

    // 新起一块:此刻还只是一个孤零零的 `#`,块型是段落
    rerender(<SayText text={'先看一下**规格**再动手\n\n#'} live />);
    expect(revealed()).toBe('#');

    // 关键一帧:`#` 长成了 `## 结`,那一块从 `<p>` 变成了 `<h2>` —— **元素换了**。
    // 可见文字长度没变,所以一个新单位都不该拆出来。化开若按「最后那只元素」记状态,
    // 这里会把「结」当成没见过的字重放一遍,屏幕上就是一次闪。
    rerender(<SayText text={'先看一下**规格**再动手\n\n## 结'} live />);
    expect(container.querySelector('h2')?.textContent).toBe('结');
    expect(revealed()).toBe('');

    // 换过元素之后仍然接得上:只化开真正新到的那一个字
    rerender(<SayText text={'先看一下**规格**再动手\n\n## 结论'} live />);
    expect(revealed()).toBe('论');
    expect(seen(container)).toBe('先看一下规格再动手结论');
  });

  it('连续排程:新字到达时,还在开的字接着开(负延迟),不从头重放', () => {
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { rerender } = render(<SayText text="先看" live />);
    rerender(<SayText text="先看一下" live />);
    const first = [...document.querySelectorAll<HTMLElement>('.rv')];
    expect(first.map((s) => s.textContent).join('')).toBe('一下');
    expect(first.map((s) => Number.parseFloat(s.style.animationDelay))).toEqual([0, 10]);

    // 100ms 之后新字到了:「一下」还在半路(单字 400ms),必须带着已经走过的进度接着开
    now += 100;
    rerender(<SayText text="先看一下规格" live />);
    const spans = [...document.querySelectorAll<HTMLElement>('.rv')];
    expect(spans.map((s) => s.textContent).join('')).toBe('一下规格');
    const delays = spans.map((s) => Number.parseFloat(s.style.animationDelay));
    expect(delays.slice(0, 2)).toEqual([-100, -90]);
    // 新字排在队尾之后,不早于此刻
    expect(delays[2]).toBeGreaterThanOrEqual(0);
    expect(delays[3]).toBeGreaterThan(delays[2]!);

    // 全部开完之后再来一帧:开完的字是纯文本,只有新字化开
    now += 2_500;
    rerender(<SayText text="先看一下规格。" live />);
    expect(revealed()).toBe('。');
  });

  it('整段到货:宿主挂进一轮已经在直播的消息里,整段从零铺开;没有直播标记的仍然落定', () => {
    // 消息早已在直播(AssistantMessage 在自己的 layout effect 里写 data-live-since),这一段是刚整段到的
    const { unmount } = render(
      <div data-live-since="1"><SayText text="整段一次到货的推理" live /></div>,
    );
    expect(revealed()).toBe('整段一次到货的推理');
    unmount();

    // 刷新 / 切会话:宿主和消息同一次提交挂上,那一刻消息上还没有标记 —— 历史,一个字都不化开
    render(<div><SayText text="已经看过的历史" live /></div>);
    expect(revealed()).toBe('');
  });

  it('同一只宿主 live 先断后续:不是「新挂进来的宿主」,不重放已经显示的字', () => {
    // 和消息同一次提交挂上(那一刻还没有直播标记)→ 落定;随后 live 断开 → 状态整套撒手
    const { rerender } = render(<div><SayText text="先说一句" live /></div>);
    rerender(<div data-live-since="1"><SayText text="先说一句" /></div>);
    // 再次 live:宿主早就见过,不是「刚挂进直播里的新宿主」
    rerender(<div data-live-since="1"><SayText text="先说一句" live /></div>);
    expect(revealed()).toBe('');
  });

  it('流走完就撒手:span 全收掉,留下干净的 markdown 树', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { container, rerender } = render(<SayText text="想好了" live />);
    rerender(<SayText text="想好了,**开始做**" live />);
    rerender(<SayText text="想好了,**开始做**" />);
    // Fantay 2026-11-08:流停的时候最后一批若还在开,让它开完再撒手 —— 把时钟拨过整段预算
    vi.advanceTimersByTime(REVEAL_BUDGET_MS + 50);
    expect(document.querySelectorAll('.rv')).toHaveLength(0);
    expect(container.querySelector('strong')?.textContent).toBe('开始做');
    expect(seen(container)).toBe('想好了,开始做');
  });

  /*
   * 思考流那一格已经在整只 body 上挂了一次化开(`ThoughtsRow` → `ThinkingMarkdown`),
   * 所以不传 `live` 的这一形态**一个化开单位都不许拆** —— 两处都挂就是同一段字被拆两遍。
   */
  it('不传 live 就一个化开单位都不拆(思考流那条路靠这个不被拆两遍)', () => {
    render(<SayText text={'## 小标题\n\n正文一句。'} />);
    expect(document.querySelectorAll('.rv')).toHaveLength(0);
    expect(document.querySelectorAll('[data-reveal]')).toHaveLength(0);
  });
});

/*
 * ⚠️ 上面所有渲染断言在 vitest 的 CSS Module 代理下**都照旧全绿** —— 代理对任何键都
 * 返回一个类名,样式表里有没有那条规则它不管。而 `renderMarkdown` 发的是**全局**类名
 * `.md-*`,写在 CSS Module 里不用 `:global()` 包住就会被改写成哈希名,一条都落不上:
 * 本仓库这个坑已经踩过两次(`record.module.css` 里 `.stream > .think` 和思考正文的字重
 * 两条都是这么空转到今天的)。所以只能直接读源文件。
 */
describe('壳内 markdown 的样式真的落得上', () => {
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/components/chat/primitives/record.module.css'),
    'utf-8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('`.md-*` 一律用 `:global()` 包住,否则会被哈希掉', () => {
    // 段落 / 小标题 / 列表都有各自的一条,少一条那一族就没样式
    expect(css).toMatch(/\.think > :global\(\.md-p\)/);
    expect(css).toMatch(/\.think :global\(\.md-h\)/);
    expect(css).toMatch(/\.think :global\(\.md-ul\)/);
    // 反向:不许出现没包 `:global` 的裸 `.md-`
    expect(css).not.toMatch(/[^(]\.md-[a-z-]+/);
  });

  it('围栏里的长行横向滚,不跟着 `.think` 的 `pre-wrap` 折', () => {
    expect(css).toMatch(/\.think :global\(\.md-code\)\s*\{[^}]*white-space:\s*pre;/);
  });
});
