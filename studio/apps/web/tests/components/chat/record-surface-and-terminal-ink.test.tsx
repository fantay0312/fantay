// @vitest-environment jsdom
/**
 * 执行记录里三处「照着稿子量」的偏差:思考灰底、终端块的内距与墨色、改动量那一格。
 *
 * ## 稿子基线:最新稿 `361b78253e`
 *
 * ⚠️ **基线换过一次。** 这个文件原来跟的是交付稿 `8015870095` / 中间稿 `853da24ea5`,
 * 当时四条在两版里逐字相同。设计当天下午又推了 `104fc5c5dc`(现头 `361b78253e`),
 * 那一次**把「任务进度整族退到静音灰」整条掉头**成正文深色 —— 下表最后一行因此换了值,
 * 前三行**一个字没变**。产品认了这个方向,用户原话:
 * 「我看了下字的颜色啥的,没问题,就按他设计稿对齐,是我们之前讨论的结果」。
 *
 * | 这个文件盯的 | 稿子出处(361b78253e) | 原文 | 掉头影响 |
 * |---|---|---|---|
 * | 思考灰底 | `thinking-stream.css:25` | `--stream-surface: #FAFAFA` | 无 |
 * | 终端块相接处 | `components.css:2405,2443-2444` | `--term-section-gap: 8px` + 两块各吃一半 | 无 |
 * | 终端三档墨色 | `components.css:2419,2439,2450` | 三处**都是** `#A3A3A3` | **无** —— 终端块**不跟着翻**,见下 |
 * | 改动量 `+n −m` | `components.css:2236-2240` | `… :is(…, .dst) { color: var(--text-strong) }` | ~~`#A3A3A3`~~ → `#202020` |
 *
 * 「终端块不跟着翻」这件事在产品里有成本:原来终端和任务进度共用一枚
 * `--chat-progress-detail-ink`,掉头之后一枚变量给不出两个值,所以终端块领了自己的
 * `--chat-terminal-ink`。这个文件因此**多一份 token 表**(见下面 `varBlock`),
 * 断言本身没动。整族深色 + 终端仍浅的完整判据在
 * `record-progress-ink-latest-spec.test.tsx`。
 *
 * ## 为什么必须真跑层叠
 *
 * 三类假绿在这个仓库都真实发生过:
 *  1. vitest 的 CSS Module 代理对**任何**键都返回类名 —— `toMatch(/xxx/)` 连拼错都能过;
 *  2. jsdom 不自动加载样式表,`getComputedStyle` 读不到层叠结果;
 *  3. `expect(a).toBe(b)` 在两边都算出 `transparent` / `auto` 时空过。
 *
 * 所以这里用校准过的共享量尺(`tests/helpers/chat-mirror-cascade.ts`):按 `index.css`
 * 的真实导入顺序把整条链读进来、CSS Module 按 vitest 实际发的哈希名改写后接在全局层
 * 之后,用真 DOM 的 `matches()` 挑命中规则,按 (特异性, 源码顺序) 决胜。
 * 断言一律钉**具体值**(`#fafafa` / `4px` / `#a3a3a3`),不写「A 和 B 相等」。
 */
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import type { ExecutionShell as Shell, ShellItem } from '../../../src/runtime/chat/contract';
import recordStyles from '../../../src/components/chat/primitives/record.module.css';
import chatRootStyles from '../../../src/components/chat/ChatRoot.module.css';
import thinkingStyles from '../../../src/components/chat/ThinkingMarkdown.module.css';
import { UNSET, createResolver, hashed, stripComments } from '../../helpers/chat-mirror-cascade';

afterEach(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../../src');
const read = (p: string): string => readFileSync(resolve(SRC, p), 'utf-8');

/* ── 稿子那三个字面值 —— 判据的锚,不从实现里读回来 ─────────────────── */

/** `thinking-stream.css:25` `--stream-surface: #FAFAFA`。**不透明**,不是半透明填充 */
/*
 * OPEND-3177 / OPEND-3178 (P3, correcting K1 #8185): the chat pane paints
 * nothing of its own since OPEND-3090, and the design settled on 2026-09-16
 * (OPEND-3178 recording + `acceptance-3178-0.png`) has the thoughts body sit
 * DIRECTLY on the transparent pane — no draft #fafafa, no K1 white floating
 * card. So the window paints no ground at all now. What this section still
 * guards against is the tinted fill (`--chat-bg-fill-tertiary`) the window
 * once read: "nothing" is a defined paint, a translucent tint is not.
 */
const DESIGN_THINKING_SURFACE = 'transparent';
/**
 * 思考正文的墨色。稿子的 `--stream-ink`(#a3a3a3)是给灰底窗里的字用的;窗子
 * 不再铺底之后那一档在面板底纹上读不清,设计定稿(OPEND-3178 录屏 + 评论
 * 「颜色使用的是 #494949」)把它提到正文那一档 —— 即 `--chat-text` → `--text`。
 *
 * Fantay 2026-11-08:Fantay 的墨系统里 `--text` 就是 `--ink`,和答案正文同色,推理和
 * 结论分不出主次。思考正文改走 `--chat-stream-ink` → `--text-muted`(tokens.css #5c5c5c),
 * 比正文**正好**浅一档 —— 仍然远比 #a3a3a3 深,3178 那条「读不清」的教训照旧成立。
 */
const DESIGN_THOUGHTS_INK = '#5c5c5c';
/** `components.css` `--term-section-gap: 8px`,相接处两块各吃一半 */
const DESIGN_TERM_SEAM = '4px';
/** 终端块外侧留白不变(`.fold .body.mod-stack .term { padding: 7px 9px }`) */
const DESIGN_TERM_OUTER = '7px';
const DESIGN_TERM_INLINE = '9px';
/*
 * 终端块那一档静音灰 —— `DESIGN_TERMINAL_INK`,定义在量尺 `createResolver` 之后(要用它的 token 表)。
 *
 * ⚠️ 这枚常量原名 `DESIGN_MUTED`,当时**终端三档和 `.tool .dst` 共用它**。
 * 2026-09-02 `104fc5c5dc` 把任务进度整族翻深之后,`.dst` 走了另一条路(见下面
 * `DESIGN_PROGRESS_INK`),这一枚现在只管终端块 —— 所以改名叫它真正管的那一档。
 * 配色换成 token 之后不再钉稿子的字面 `#a3a3a3`:终端块的出处是 `--chat-terminal-ink`
 * → `--chat-text-soft`,锚点就是这枚接缝 token 展开后的色值。
 */
/**
 * 任务进度那一族的墨色 —— `--text-strong`,浅色主题 `#202020`。
 *
 * ~~原来这一档是 `#A3A3A3`(和终端块同灰)~~ —— **2026-09-02 被设计裁决翻掉**。
 * 稿子 `104fc5c5dc`(`origin/design/chat-cards-surface`,现头 `361b78253e`)新增:
 *   `.fold.mod-flat .tool:not(.is-fail) :is(.ti, .ti > svg, .pk, .nm code, .ms, .dst)`
 *   `  { color: var(--text-strong) }`(components.css:2236-2240)
 * 同一次还把 `.fold.mod-flat { --progress-detail-ink }` 从 `#a3a3a3` 改成
 * `var(--text-strong)`。产品当天认了这个方向,用户原话:
 * 「我看了下字的颜色啥的,没问题,就按他设计稿对齐,是我们之前讨论的结果」。
 *
 * 所以下面「改动量」那一节钉的**不再是**静音灰。整族的完整判据在
 * `record-progress-ink-latest-spec.test.tsx`,这里只留 `.dst` 这一格,
 * 因为它当初是**唯一漏网**的那一格,值得留一条独立的守卫。
 */
const DESIGN_PROGRESS_INK = '#202020';

/** 修复前落在这几档 —— 反向锚,用来确认「量尺真的看得见这处偏差」 */
const BEFORE = {
  /** `--chat-bg-fill-tertiary` → `--bg-fill-tertiary` */
  translucentFill: 'rgba(0, 0, 0, 0.03)',
  /** `--chat-text-muted` → `--text-muted` */
  textMuted: '#5c5c5c',
  /** `--chat-text-strong` → `--text-strong` */
  textStrong: '#202020',
  /** `--chat-text-soft` → `--text-soft` */
  textSoft: '#848484',
  /** K1 (#8185) 的白色浮动卡 `--chat-floating-card-bg` */
  floatingCard: '#fff',
  /** 稿子的 `--stream-ink`,灰底窗时代的思考正文墨色 */
  streamInk: '#a3a3a3',
} as const;

/* ── CSS Module:哈希改写 + `:global()` 保护 ───────────────────────── */

/**
 * `hashed()` 会把**所有** `.foo` 改写成哈希名,`:global()` 里的全局类也不例外。
 * record.module.css 里有一条 `.fold .thoughts > .body :global(.md-h)` ——
 * 改写之后 `:global(...)` 这个写法 jsdom 的 `matches()` 认不出来,
 * 而量尺对认不出来的选择器是**抛异常**(它拒绝静默丢规则)。
 * 所以先把 `:global(X)` 摘成占位符,哈希之后原样填回。
 */
function scopeModule(css: string, mod: unknown): string {
  const globals: string[] = [];
  const stashed = css.replace(/:global\(([^()]*)\)/g, (_m, inner: string) => {
    globals.push(inner.trim());
    return ` ${globals.length - 1} `;
  });
  return hashed(stashed, mod as Record<string, string>)
    .replace(/ (\d+) /g, (_m, i: string) => globals[Number(i)] ?? '');
}

const RECORD_CSS = read('components/chat/primitives/record.module.css');
const CHAT_ROOT_CSS = read('components/chat/ChatRoot.module.css');

/**
 * 量尺的 `var()` 解析只认 token 表里的 `:root` 块,而 `--chat-*` 住在
 * `ChatRoot.module.css` 的 `.vars, .root` 上、`--chat-progress-detail-ink` 住在
 * `record.module.css` 的一条普通规则上。**从真文件里抠出来**再包成 `:root`
 * ——写死一份副本的话,改了产品定义这里照样绿。
 *
 * 按「块里声明了哪枚变量」定位,不按选择器文本 —— 所有者名单是会加人的
 * (`.term` 就是这一轮加进去的),按选择器锚会因为一次正当的扩写而炸。
 * 亮色块永远排在暗色块前面,取第一处命中即可。
 */
function varBlock(css: string, probe: string): string {
  const m = new RegExp(`\\{([^{}]*${probe}\\s*:[^{}]*)\\}`).exec(stripComments(css));
  if (!m?.[1]) throw new Error(`抠不到声明 \`${probe}\` 的那个块`);
  return `:root {${m[1]}}`;
}

/**
 * 同上,但**抠不到就跳过**。
 *
 * 这一枚是给 `--chat-terminal-ink` 用的:撤销复验时会有人把这次的实现整个退回去,
 * 那时这枚 token 不存在。硬抠会在**加载期**抛异常 —— 整个文件一条 case 都跑不起来,
 * 报出来是 `no tests`,读的人看不出到底哪条判据被违反了。
 * 跳过之后,`.term` 那三条会照旧走它当时引用的变量,断言各自给出自己的结论。
 */
function maybeVarBlock(css: string, probe: string): string[] {
  try {
    return [varBlock(css, probe)];
  } catch {
    return [];
  }
}

/** 产品 `index.css` 的导入顺序**就是**层叠顺序 —— 不能手抄 */
function globalSheets(): string[] {
  const index = read('index.css');
  return [...index.matchAll(/@import\s+'([^']+)'/g)]
    .map((m) => resolve(SRC, m[1] ?? ''))
    .flatMap((file) => {
      try {
        return [readFileSync(file, 'utf-8')];
      } catch {
        return [];
      }
    });
}

const TARGETS = [
  'background-color',
  'color',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
] as const;

const { resolved, declaring } = createResolver(
  [
    ...globalSheets(),
    // 打包器把 module CSS 排在全局层之后
    scopeModule(CHAT_ROOT_CSS, chatRootStyles),
    scopeModule(RECORD_CSS, recordStyles),
    scopeModule(read('components/chat/ThinkingMarkdown.module.css'), thinkingStyles),
  ],
  [
    read('styles/tokens.css'),
    varBlock(CHAT_ROOT_CSS, '--chat-bg-panel'),
    varBlock(RECORD_CSS, '--chat-progress-detail-ink'),
    /*
     * 终端块 2026-09-02 起走**自己**那枚 token(`--chat-terminal-ink`,声明在 `.term` 上)。
     * 它守的事实一个字没变(终端仍是 `#A3A3A3`),换的是出处:同一天
     * `104fc5c5dc` 把 `--chat-progress-detail-ink` 整枚翻成了正文深色,
     * 而终端块**不跟着翻** —— 一枚变量给不出两个值,所以拆成两枚。
     * 这里不补上就不是断言变红,是量尺解不开 `var()`、读回字面的 `var(--chat-terminal-ink)`。
     */
    ...maybeVarBlock(RECORD_CSS, '--chat-terminal-ink'),
  ],
  TARGETS,
);

/** 终端块的静音档:`--chat-text-soft` 按同一份 token 表展开(一条探针规则,不抄值) */
const DESIGN_TERMINAL_INK: string = (() => {
  const probe = createResolver(
    ['.od-ink-probe { color: var(--chat-text-soft); }'],
    [read('styles/tokens.css'), varBlock(CHAT_ROOT_CSS, '--chat-bg-panel')],
    ['color'],
  );
  const el = document.createElement('i');
  el.className = 'od-ink-probe';
  return probe.resolved(el)['color']!.toLowerCase();
})();

/* ── 夹具 ─────────────────────────────────────────────────────────── */

const R = recordStyles as unknown as Record<string, string>;
const cls = (name: string): string => {
  const got = R[name];
  if (!got) throw new Error(`record.module.css 没有 \`${name}\` 这个类`);
  return got;
};

const think = (text: string): ShellItem => ({ kind: 'text', text, thinking: true } as ShellItem);

/** 命令 + 输出的可折叠行(组件 11)。输出里塞一条 `✗` 开头的行,好量到 `.er` 那一档 */
const cmdRow = (id: string): ShellItem => ({
  kind: 'tool', id, tool: 'bash', title: '构建产物,看能不能跑通', name: 'Bash', rawTitle: false,
  file: null, delta: null, hits: null, pattern: null, elapsedMs: 8400,
  failed: false, failReason: null,
  command: 'npm run build',
  terminal: '✓ built in 2.14s (2 pages)\n✗ 1 warning suppressed\nplain output line',
} as unknown as ShellItem);

/** 写文件行:挂改动量而不是耗时(稿子:写文件不挂耗时,挂改动量) */
const writeRow = (id: string): ShellItem => ({
  kind: 'tool', id, tool: 'write', title: `新建 ${id}`, name: 'Write', rawTitle: false,
  file: { path: id, label: id }, delta: { added: 182, removed: 0 },
  hits: null, pattern: null, elapsedMs: 100,
  failed: false, failReason: null, command: null, terminal: null,
} as unknown as ShellItem);

function shellOf(items: ShellItem[], over: Partial<Shell> = {}): Shell {
  return {
    kind: 'shell', seq: 0, status: 'succeeded', items, segments: [],
    thinking: false, stopped: false, elapsedMs: 130_000, quietMs: null, ...over,
  } as Shell;
}

/** 壳挂在真的接缝下面,否则一半规则根本不参赛 */
function mount(shell: Shell): HTMLElement {
  const { container } = render(
    <I18nProvider initial="zh-CN">
      <ExecutionShell shell={shell} deferCollapsedBodies={false} />
    </I18nProvider>,
  );
  const app = document.createElement('div');
  app.className = 'app';
  const seam = document.createElement('div');
  seam.className = (chatRootStyles as unknown as Record<string, string>).root as string;
  seam.setAttribute('data-chat-root', '');
  app.appendChild(seam);
  seam.appendChild(container);
  document.body.appendChild(app);
  return seam;
}

function one(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`夹具里没有 \`${selector}\`;实际 DOM:\n${root.innerHTML.slice(0, 1200)}`);
  return el;
}

/** 拿这枚元素上某个属性的胜出值;`UNSET` 会当场报出来,不许当成「和期望不同」糊过去 */
function value(el: Element, prop: string): string {
  const got = resolved(el)[prop];
  if (got === undefined || got === UNSET) {
    throw new Error(`没有任何规则给 \`${prop}\` 赋值 —— 断言会空过。元素:${el.className}`);
  }
  return got.toLowerCase();
}

/** 字色允许从祖先继承(稿子里「整行同色」有一半是靠继承实现的) */
function ink(el: Element): string {
  let node: Element | null = el;
  while (node) {
    const got = resolved(node)['color'];
    if (got && got !== UNSET && got.toLowerCase() !== 'inherit') return got.toLowerCase();
    node = node.parentElement;
  }
  throw new Error('这一路上没有任何规则上色 —— 断言会空过');
}

/* ── ① 思考那一格不铺底,正文用正文墨色 ──────────────────────────── */

describe('思考那一格的底与墨色', () => {
  /**
   * 稿子给的是一枚不透明底色(`--stream-surface: #FAFAFA`),产品先换成半透明填充、
   * 再被 K1 钉成白色浮动卡;设计 2026-09-16 定稿(OPEND-3178 录屏)是**直接落在
   * 透明面板上**:不铺底、不描边。半透明填充仍然是反向锚 —— 它和「不铺底」
   * 的差别是那 3% 黑会随底纹变色,而透明是一个确定的「什么都不画」。
   */
  it('还在想:滚动窗不铺底,也不是半透明填充', () => {
    const root = mount(shellOf(
      [think('两张图的栅格看着是同一套。')],
      { status: 'running', thinking: true },
    ));
    const body = one(root, `details.${cls('thoughts')} > div.${cls('stream')}`);
    expect(value(body, 'background-color')).toBe(DESIGN_THINKING_SURFACE);
    expect(value(body, 'background-color')).not.toBe(BEFORE.translucentFill);
    expect(value(body, 'background-color')).not.toBe(BEFORE.floatingCard);
  });

  it('想完了:收起来那一格同样不铺底', () => {
    const root = mount(shellOf([think('从截图里的搜索条和商品网格看,是商品列表页。')]));
    const body = one(root, `details.${cls('thoughts')} > div.${cls('stack')}`);
    expect(value(body, 'background-color')).toBe(DESIGN_THINKING_SURFACE);
    expect(value(body, 'background-color')).not.toBe(BEFORE.translucentFill);
    expect(value(body, 'background-color')).not.toBe(BEFORE.floatingCard);
  });

  /** 没了灰底,`#a3a3a3` 在面板底纹上读不清 —— 两态正文都走比正文浅一档的 `--chat-stream-ink` */
  it('两态正文都是比正文浅一档的 #5c5c5c,不再是灰底时代的 #a3a3a3', () => {
    const live = mount(shellOf([think('两张图的栅格看着是同一套。')], { status: 'running', thinking: true }));
    const liveText = one(live, `details.${cls('thoughts')} > div.${cls('stream')} > [data-testid="thinking-markdown"]`);
    expect(ink(liveText)).toBe(DESIGN_THOUGHTS_INK);
    expect(ink(liveText)).not.toBe(BEFORE.streamInk);

    const done = mount(shellOf([think('从截图里的搜索条和商品网格看,是商品列表页。')]));
    const doneText = one(done, `details.${cls('thoughts')} > div.${cls('stack')} > [data-testid="thinking-markdown"]`);
    expect(ink(doneText)).toBe(DESIGN_THOUGHTS_INK);
    expect(ink(doneText)).not.toBe(BEFORE.streamInk);
  });
});

/* ── ② 终端块:相接处 4+4,三档墨色同灰 ──────────────────────────── */

describe('终端块', () => {
  const openTerm = (): HTMLElement => {
    const root = mount(shellOf([cmdRow('c1')]));
    return one(root, `div.${cls('code')}`);
  };

  /**
   * 命令块和输出块之间总共留 8px,两块相接处**各吃一半**;
   * 外侧留白(块顶 / 块底)保持 7px 不变。
   * 修复前两块各写 7px,相接处叠成 14px —— 中间那道气口比外侧还宽。
   */
  /** 命令 + 输出那只盒子同样直接落在面板上:不铺底(OPEND-3178 定稿) */
  it('盒子不铺底', () => {
    const code = openTerm();
    expect(value(code, 'background-color')).toBe(DESIGN_THINKING_SURFACE);
    expect(value(code, 'background-color')).not.toBe(BEFORE.floatingCard);
  });

  it('相接处两块各 4px,外侧仍是 7px', () => {
    const code = openTerm();
    const cmd = one(code, `div.${cls('term')}.${cls('cmd')}`);
    const out = one(code, `div.${cls('term')}:not(.${cls('cmd')})`);

    expect(value(cmd, 'padding-top')).toBe(DESIGN_TERM_OUTER);
    expect(value(cmd, 'padding-bottom')).toBe(DESIGN_TERM_SEAM);
    expect(value(out, 'padding-top')).toBe(DESIGN_TERM_SEAM);
    expect(value(out, 'padding-bottom')).toBe(DESIGN_TERM_OUTER);

    // 左右不动 —— 只收相接处那一道
    for (const el of [cmd, out]) {
      expect(value(el, 'padding-left')).toBe(DESIGN_TERM_INLINE);
      expect(value(el, 'padding-right')).toBe(DESIGN_TERM_INLINE);
    }
  });

  /**
   * 三档墨色在稿子里**是同一个灰**。区分不靠颜色,靠另外两个维度:
   *   · 命令 vs 输出 —— 行首那个 `$`(`.term.cmd div::before`,稿子的原话是
   *     「靠开头的 $ 区分输入和输出 —— 那是终端本身的约定,不用另发明标记」);
   *   · 报错 vs 普通输出 —— 行首那枚 `✗` 是红的且加粗(`.term .er::first-letter`,
   *     稿子原话「不整行红 …… 只有行首的 ✗ 标记是红的」)。
   * 所以下面这三条**不是**退化成一档,是把区分挪到了标记上。
   */
  it('命令 / 普通输出 / 报错行三档同灰', () => {
    // 防真空:锚点展开成了色值,不是原样读回的 var()
    expect(DESIGN_TERMINAL_INK).toMatch(/^#[0-9a-f]{3,8}$/);
    const code = openTerm();
    const cmd = one(code, `div.${cls('term')}.${cls('cmd')}`);
    const out = one(code, `div.${cls('term')}:not(.${cls('cmd')})`);
    const er = one(code, `.${cls('er')}`);

    expect(ink(cmd)).toBe(DESIGN_TERMINAL_INK);
    expect(ink(out)).toBe(DESIGN_TERMINAL_INK);
    expect(ink(er)).toBe(DESIGN_TERMINAL_INK);

    // 2026-09-02 起还多守一件事:任务进度整族翻深了,终端块**没跟着翻**
    expect(ink(cmd)).not.toBe(DESIGN_PROGRESS_INK);
    expect(ink(out)).not.toBe(DESIGN_PROGRESS_INK);
    expect(ink(er)).not.toBe(DESIGN_PROGRESS_INK);

    // 反向锚:修复前命令行和报错行是正文深色、普通输出是次级灰
    expect(ink(cmd)).not.toBe(BEFORE.textStrong);
    expect(ink(er)).not.toBe(BEFORE.textStrong);
    expect(ink(out)).not.toBe(BEFORE.textMuted);
  });

  /** 区分靠的那两枚标记必须还在 —— 三档同色一旦把它们也抹了,才是真退化 */
  it('区分靠的两枚标记还在:行首 $ 与红色 ✗', () => {
    const css = stripComments(RECORD_CSS);
    expect(css).toMatch(/\.term\.cmd div::before\s*\{[^}]*content:\s*'\$ '/);
    expect(css).toMatch(/\.term \.er::first-letter\s*\{[^}]*color:\s*var\(--chat-red\)/);
  });

  /** 成功行仍是品牌绿 —— 证明「三档同灰」没有顺手把语义色也抹平 */
  it('✓ 那一行保住语义绿', () => {
    const code = openTerm();
    const ok = one(code, `.${cls('ok')}`);
    expect(ink(ok)).not.toBe(DESIGN_TERMINAL_INK);
  });
});

/* ── ③ 改动量那一格 ───────────────────────────────────────────────── */

describe('改动量 +n −m', () => {
  /**
   * 这一格钉的一直是**「跟着整行走,不自己另挑一档」**;跟的那个值 2026-09-02 换过一次。
   *
   * ~~稿子 `.tool .dst { … color: #A3A3A3 }` —— 和整行同一档静音灰。~~
   * **2026-09-02 被设计裁决翻掉**(`104fc5c5dc`,现头 `361b78253e`):
   * `.fold.mod-flat .tool:not(.is-fail) :is(…, .dst) { color: var(--text-strong) }`
   * (components.css:2236-2240)把整族拉回正文深色,`.dst` 在那条的名单里。
   * 产品认了这个方向,用户原话「就按他设计稿对齐,是我们之前讨论的结果」。
   *
   * 留着这一格的理由没变:它当初是整族统一时**唯一漏网**的一格
   * (一行里「新建 xxx.html」一个色、紧挨着的「+182 −0」另一个色),
   * 而它又是**写死、不靠继承**的(失败行会换掉整行 `color`,改动量不该跟着换)——
   * 写死的那种格子最容易在下一次整族调整时再漏一次,值得留一条自己的守卫。
   */
  it('跟着整行走那一档正文深色,不是 --chat-text-soft', () => {
    const root = mount(shellOf([writeRow('product-list.html')]));
    const delta = one(root, `span.${cls('delta')}`);
    expect(value(delta, 'color')).toBe(DESIGN_PROGRESS_INK);
    // 两个反向锚:既没留在漏网时那一档,也没停在翻深之前那一档
    expect(value(delta, 'color')).not.toBe(BEFORE.textSoft);
    expect(value(delta, 'color')).not.toBe(DESIGN_TERMINAL_INK);
  });

  /** 这一格必须**自己**声明颜色,不能靠继承 —— 失败行换掉整行 color 时它要站住 */
  it('自己那条规则声明了颜色', () => {
    const root = mount(shellOf([writeRow('product-list.html')]));
    const delta = one(root, `span.${cls('delta')}`);
    expect(declaring(delta, 'color').length).toBeGreaterThan(0);
  });
});
