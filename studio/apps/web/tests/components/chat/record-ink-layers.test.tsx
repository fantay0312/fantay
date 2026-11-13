// @vitest-environment jsdom
/**
 * 执行记录的**墨色分层**:哪几层跟着任务进度走正文深色,哪几层留在静音灰。
 *
 * ## ⚠️ 这个文件 2026-09-02 换过一次前提,不是改了几个期望值
 *
 * 它原名 `record-muted-ink.test.tsx`,整篇的前提是「执行记录整族**退到静音灰**
 * `#a3a3a3`」—— 那是照当时的稿子写的。设计当天下午推的 `104fc5c5dc`
 * (`origin/design/chat-cards-surface`,现头 `361b78253e`)**把那条整个掉头**:
 *   `.fold.mod-flat { --progress-detail-ink: var(--text-strong) }`      (1066)
 *   `.fold.mod-flat .fold > summary:has(> .ti) > :is(.nm, .ms) { … }`   (1107)
 *   `.fold.mod-flat .tool:not(.is-fail), … :is(.ti, .ti > svg, .pk, .nm code, .ms, .dst)
 *      { color: var(--text-strong) }`                                    (2236-2240)
 * 产品认了这个方向,用户原话:「我看了下字的颜色啥的,没问题,就按他设计稿对齐,
 * 是我们之前讨论的结果」。
 *
 * 所以**不能把 `#a3a3a3` 全局替换成 `#202020` 了事** —— 那样得到的是一篇名字说 A、
 * 内容做 B 的测试。这一篇改名重写成「分层」,因为掉头之后真正值得守的事变了两件:
 *
 * | 层 | 现在 | 判据在哪 |
 * |---|---|---|
 * | 工具行整行 / 图标 / 耗时 / 标题 / 文件名 | 深 `#202020` | 下面「整行同色」那一节 |
 * | 步骤标题 · 步骤耗时 | 深 `#202020` | 下面「层次」那一节 |
 * | 步骤间小结 | 深 `#202020` + **400 字重** + 22px | 下面「小结」那一节 |
 * | **终端块** `.term` | **仍浅 `#a3a3a3`** | 下面「层次」那一节 |
 * | **思考流正文** | ~~仍浅 `#a3a3a3`~~ → **正文 `#494949`(`--chat-text`)**,2026-09-16 定稿 | 下面「思考正文」那一节 |
 *
 * **后两行是这次最要紧的**:整族翻深时它们**没跟着翻**,而产品里终端块原来和任务进度
 * 共用一枚 `--chat-progress-detail-ink` —— 一翻就会顺手把终端一起染深。所以这一篇现在
 * 的重心从「谁是灰的」变成了「**谁不该跟着翻**」。
 *
 * ## 掉头之后,好几条断言失去了区分力 —— 全部重挂了判据
 *
 * 掉头前「失败行 vs 成功行」「小结 vs 叙述」都能靠**颜色**分开;现在它们同色,
 * 原来那些 `expect(x).not.toBe(MUTED)` 变成了两边都真的空过。逐条改挂了新判据:
 *   · 失败 vs 成功  —— 靠**行首图标**(红 vs 深)和「失败」二字,不再靠整行色
 *   · 小结 vs 叙述  —— 靠**字重**(400 vs 500)和 22px 缩进,不再靠色和字号
 * 整族深色 + 终端仍浅的正面判据在 `record-progress-ink-latest-spec.test.tsx`,
 * 这一篇是它的**分层**视角:同一屏里几档并排比,防「一翻全翻」。
 *
 * ## 缺口最初从哪来(留档)
 *
 * 用户把产品和当时的交付稿并排比,发现同一行里几格各挑一档灰。逐条对回稿子后,
 * 修复前的偏差是:工具行整行 `#494949`、行首图标 `#848484`、可折叠命令行 summary
 * 整条没搬、步骤间小结被 `:not(.hasTodo)` 掐死、流窗推理正文选择器失配空转。
 * **「一行里几格各挑一档」这个事故形态和墨色是深是浅无关**,所以那几条守卫留下来了,
 * 只是跟的值换了。
 *
 * ## 为什么必须真跑层叠,不能 diff CSS 文本
 *
 * 这一族翻过五次车,每次都是「规则文本写对了、却没命中 / 被别的规则盖掉」:
 *  · `.stream > .think` 里的 `.think` 是 record 自己那份,而流窗里住的是
 *    `ThinkingMarkdown` 的 `.think` —— 两个 CSS Module、两个哈希类名,规则空转至今;
 *  · `styles.thoughts` 在 `record.module.css` 里**从来没有对应的规则**,CSS Module
 *    因此不发这个类名,`.fold.thoughts` 在产线上一次都没存在过(vitest 的
 *    CSS Module 代理对任何键都返回类名,单靠代理照不出这件事);
 *  · `:not(.hasTodo)` 让整条夹心正文规则在**有清单的壳**上失配 —— 而用户截图里
 *    正好有「执行计划 · 4 步」。
 *
 * 所以这个文件自己走一遍层叠:规则按 `index.css` 的真实 `@import` 顺序读进来,
 * 三份 CSS Module 按 **vitest 实际发的哈希名**改写后接在后面(打包器把 module CSS
 * 放在全局层之后),再用真 DOM 的 `matches()` 挑命中规则、按 (特异性, 源码顺序) 决胜,
 * 最后用 jsdom 算出来的自定义属性把 `var()` 链展开成具体色值。
 *
 * ⚠️ 断言一律钉**字面值**(`rgb(32, 32, 32)` / `rgb(163, 163, 163)`),不写「A 和 B 同色」——
 * 两边都算出同一个继承值时那种断言永远通过。
 */
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { ExecutionShell } from '../../../src/components/chat/ExecutionShell';
import type { ExecutionShell as Shell, ShellItem } from '../../../src/runtime/chat/contract';
import recordStyles from '../../../src/components/chat/primitives/record.module.css';
import chatRootStyles from '../../../src/components/chat/ChatRoot.module.css';
import thinkingStyles from '../../../src/components/chat/ThinkingMarkdown.module.css';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../../src');

/**
 * 那一档静音灰。2026-09-02 掉头之后它剩两个住户:终端块
 * (`--chat-terminal-ink`)和思考流正文(`--chat-stream-ink`);2026-09-16 思考正文也
 * 搬走了(见下面「思考正文」那一节),现在只剩终端块。
 *
 * 配色换成 token 之后不再钉字面值:静音档就是接缝的 `--chat-text-soft`
 * (`.term` 的 `--chat-terminal-ink` 直接取它),在 `beforeAll` 里按 token 展开读出来。
 * 所有 `not.toBe(MUTED)` 反向锚仍然有区分力,因为它们比的是真正的静音档。
 */
let MUTED = '';
/** 正文那一档(`--chat-text` → `--text`,#494949)。2026-09-16 起思考正文落在这里 */
const BODY = 'rgb(73, 73, 73)';
/** 正文深色(`--text-strong`)。掉头之后**任务进度整族**都在这一档 */
const STRONG = 'rgb(32, 32, 32)';
/**
 * 思考正文那一档(`--chat-stream-ink` → `--text-muted`,tokens.css 里 #5c5c5c)。
 * Fantay 2026-11-08 起思考正文落在这里:比正文浅**正好**一档 —— 不是正文本身
 * (推理和结论分不出主次),也不是下面那档 `--chat-text-soft`(浅两档,透明面板上读不清)。
 */
const STREAM = 'rgb(92, 92, 92)';
/** 失败那一格的红 —— 掉头之后「失败 vs 成功」就靠它分,不再靠整行色 */
const RED = 'rgb(240, 65, 66)';
/** 修复前那两格各自挑的灰 —— 反向锚,证明「一行里几格各挑一档」没有回来 */
const STRAY = { soft: 'rgb(132, 132, 132)', text: 'rgb(73, 73, 73)' } as const;

/* ── CSS Module:拿 vitest 实际发的哈希名 ─────────────────────────── */

/**
 * vitest 的 CSS Module 代理对**任何**键都返回 `_<键>_<该文件的哈希>`,
 * 所以随便问一个键就能把这份文件的哈希取出来。
 * 哈希**按文件**不同,三份 module 各取各的,不能共用一个。
 */
function hashOf(mod: unknown): string {
  const probe = (mod as Record<string, string>).odHashProbe;
  const m = /^_odHashProbe_(.+)$/.exec(probe ?? '');
  if (!m?.[1]) throw new Error(`拿不到 CSS Module 哈希:${String(probe)}`);
  return m[1];
}

/**
 * 把 module CSS 的选择器改写成 vitest 实际发的哈希名。
 * `:global(...)` 里的类名**不改写** —— `ThinkingMarkdown.module.css` 的
 * `.think :global(.md-h)` 里那个 `md-h` 是 markdown 渲染器发的全局类。
 */
function scopeSelector(prelude: string, hash: string): string {
  const globals: string[] = [];
  let out = prelude.replace(/:global\(([^()]*)\)/g, (_m, inner: string) => {
    globals.push(inner);
    return ` ${globals.length - 1} `;
  });
  out = out.replace(/\.(-?[A-Za-z_][\w-]*)/g, (_m, name: string) => `._${name}_${hash}`);
  return out.replace(/ (\d+) /g, (_m, i: string) => globals[Number(i)] ?? '');
}

/* ── 层叠:按 index.css 的真实导入顺序 ───────────────────────────── */

/** `:is(.a, .b)` 里的逗号不是选择器分隔符 —— 按括号深度切 */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** (b, c) 两档 —— 这一族里没有 id。b = 类 / 属性 / 伪类,c = 元素名。 */
function specificity(selector: string): [number, number] {
  let b = 0;
  let c = 0;
  let rest = selector;
  for (const m of selector.matchAll(/:(?:not|is|has)\(([^()]*)\)/g)) {
    const inner = splitSelectorList(m[1] ?? '').map(specificity);
    const worst = inner.reduce<[number, number]>(
      (acc, one) => (one[0] !== acc[0] ? (one[0] > acc[0] ? one : acc) : one[1] > acc[1] ? one : acc),
      [0, 0],
    );
    b += worst[0];
    c += worst[1];
    rest = rest.replace(m[0], ' ');
  }
  b += (rest.match(/\.[A-Za-z0-9_-]+|\[[^\]]+\]|:{1}[a-z-]+(?![a-z-]*\()/g) ?? []).length;
  c += (rest.match(/(?:^|[\s>+~(])([a-zA-Z][a-zA-Z0-9-]*)/g) ?? []).length;
  return [b, c];
}

const heavier = (a: [number, number], b: [number, number]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];

type Rule = { file: string; order: number; selector: string; body: string };

/** 顶层规则 + at-rule 里的规则;暗色 / 打印 / 降级动画那几档跳过 —— 只判浅色默认态 */
function rulesOf(css: string, file: string, from: number, hash: string | null): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  let order = from;
  const walk = (chunk: string, skip: boolean): void => {
    let i = 0;
    while (i < chunk.length) {
      const open = chunk.indexOf('{', i);
      if (open === -1) break;
      const prelude = chunk.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < chunk.length && depth > 0) {
        if (chunk[j] === '{') depth += 1;
        else if (chunk[j] === '}') depth -= 1;
        j += 1;
      }
      const inner = chunk.slice(open + 1, j - 1);
      if (prelude.startsWith('@')) {
        const dark = /dark|print|prefers-reduced-motion/.test(prelude);
        if (/^@(media|supports|layer|container)/.test(prelude)) walk(inner, skip || dark);
      } else if (!skip && prelude) {
        for (const one of splitSelectorList(prelude)) {
          order += 1;
          const selector = hash == null ? one : scopeSelector(one, hash);
          out.push({ file, order, selector: selector.replace(/\s+/g, ' ').trim(), body: inner });
        }
      }
      i = j;
    }
  };
  walk(text, false);
  return out;
}

/** `index.css` 的导入顺序**就是**层叠顺序 —— 不能手抄 */
function globalFiles(): string[] {
  const index = readFileSync(resolve(SRC, 'index.css'), 'utf-8');
  return [...index.matchAll(/@import\s+'([^']+)'/g)]
    .map((m) => resolve(SRC, m[1] ?? ''))
    .filter((file) => {
      try {
        readFileSync(file, 'utf-8');
        return true;
      } catch {
        return false;
      }
    });
}

/** 三份 CSS Module 接在全局层之后 —— 打包器就是这么排的 */
const MODULES: Array<{ file: string; mod: unknown }> = [
  { file: 'components/chat/ChatRoot.module.css', mod: chatRootStyles },
  { file: 'components/chat/primitives/record.module.css', mod: recordStyles },
  { file: 'components/chat/ThinkingMarkdown.module.css', mod: thinkingStyles },
];

let CASCADE: Rule[] = [];

function buildCascade(): Rule[] {
  const out: Rule[] = [];
  for (const file of globalFiles()) {
    out.push(...rulesOf(readFileSync(file, 'utf-8'), file, out.length, null));
  }
  for (const { file, mod } of MODULES) {
    out.push(...rulesOf(readFileSync(resolve(SRC, file), 'utf-8'), file, out.length, hashOf(mod)));
  }
  return out;
}

const declaration = (body: string, prop: string): string | null => {
  let hit: string | null = null;
  for (const m of body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;}]*)`, 'g'))) {
    hit = (m[1] ?? '').trim();
  }
  return hit;
};

/** 挑出真的命中 `el` 的规则,按 (特异性, 源码顺序) 决出赢的那一条 */
function winner(el: Element, prop: string): { rule: Rule; value: string } | null {
  let best: { rule: Rule; value: string; spec: [number, number] } | null = null;
  for (const rule of CASCADE) {
    const value = declaration(rule.body, prop);
    if (value == null) continue;
    if (/:hover\b|::/.test(rule.selector)) continue;
    let hit = false;
    try {
      hit = el.matches(rule.selector);
    } catch {
      continue; // nwsapi 认不出来的写法,让它过
    }
    if (!hit) continue;
    const spec = specificity(rule.selector);
    if (!best || heavier(spec, best.spec) || (!heavier(best.spec, spec) && rule.order > best.rule.order)) {
      best = { rule, value, spec };
    }
  }
  return best ? { rule: best.rule, value: best.value } : null;
}

/** `var(--a, var(--b))` 的顶层拆分 */
function splitVar(inside: string): { name: string; fallback: string | null } {
  let depth = 0;
  for (let i = 0; i < inside.length; i += 1) {
    const ch = inside[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      return { name: inside.slice(0, i).trim(), fallback: inside.slice(i + 1).trim() };
    }
  }
  return { name: inside.trim(), fallback: null };
}

/** 用 jsdom 算出来的自定义属性把 `var()` 链展开;展不开就原样返回 */
function expandVars(el: Element, value: string, depth = 0): string {
  const raw = value.trim();
  if (depth > 8 || !raw.startsWith('var(')) return raw;
  let d = 0;
  let end = -1;
  for (let i = 3; i < raw.length; i += 1) {
    if (raw[i] === '(') d += 1;
    else if (raw[i] === ')') {
      d -= 1;
      if (d === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return raw;
  const { name, fallback } = splitVar(raw.slice(4, end));
  const got = getComputedStyle(el).getPropertyValue(name).trim();
  if (got) return expandVars(el, got, depth + 1);
  return fallback == null ? raw : expandVars(el, fallback, depth + 1);
}

/** `#a3a3a3` → `rgb(163, 163, 163)`,断言里钉的就是后者 */
function toRgb(value: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!hex) return value.trim().toLowerCase();
  let h = hex[1] as string;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/**
 * 这枚元素**最终的字色**。
 *
 * 没有任何规则给它上色时往上走一层找继承来源 —— 「整行同色」这件事在稿子里
 * 有一半是靠继承实现的(`.ti / .ms { color: inherit }`),不追继承就量不到。
 */
function ink(el: Element): string {
  let node: Element | null = el;
  while (node) {
    const win = winner(node, 'color');
    if (win) {
      const value = expandVars(node, win.value).toLowerCase();
      if (value !== 'inherit') return toRgb(value);
    }
    node = node.parentElement;
  }
  throw new Error('这一路上没有任何规则上色 —— 断言会空过');
}

/** 这枚元素最终的字号(px) */
function size(el: Element): string {
  let node: Element | null = el;
  while (node) {
    const win = winner(node, 'font-size');
    if (win) return expandVars(node, win.value).trim();
    node = node.parentElement;
  }
  throw new Error('这一路上没有任何规则定字号');
}

/** 这枚元素最终的字重 */
function weight(el: Element): string {
  let node: Element | null = el;
  while (node) {
    const win = winner(node, 'font-weight');
    if (win) return expandVars(node, win.value).trim();
    node = node.parentElement;
  }
  throw new Error('这一路上没有任何规则定字重');
}

/** 这枚元素自己那条 `background`(不追继承 —— 底色不继承) */
function ground(el: Element): string {
  const win = winner(el, 'background');
  return win ? expandVars(el, win.value).trim().toLowerCase() : '';
}

/* ── 夹具:壳的四种形态 ──────────────────────────────────────────── */

const say = (text: string): ShellItem => ({ kind: 'text', text, thinking: false } as ShellItem);
const think = (text: string): ShellItem => ({ kind: 'text', text, thinking: true } as ShellItem);
const readRow = (id: string): ShellItem => ({
  kind: 'tool', id, tool: 'read', title: `读取 ${id}`, name: 'Read', rawTitle: false,
  file: { path: id, label: id }, delta: null, hits: null, pattern: null, elapsedMs: 400,
  failed: false, failReason: null, command: null, terminal: null,
} as unknown as ShellItem);
const writeRow = (id: string): ShellItem => ({
  kind: 'tool', id, tool: 'write', title: `新建 ${id}`, name: 'Write', rawTitle: false,
  file: { path: id, label: id }, delta: null, hits: null, pattern: null, elapsedMs: 100,
  failed: false, failReason: null, command: null, terminal: null,
} as unknown as ShellItem);
const cmdRow = (id: string, title: string, failed = false): ShellItem => ({
  kind: 'tool', id, tool: 'bash', title, name: 'Bash', rawTitle: false,
  file: null, delta: null, hits: null, pattern: null, elapsedMs: 8400,
  failed, failReason: null, command: 'npm run build', terminal: 'built in 8.4s',
} as unknown as ShellItem);
const plan = (steps: string[]): ShellItem => ({ kind: 'plan', steps } as ShellItem);
const todoSeg = (content: string, items: ShellItem[]): ShellItem => ({
  kind: 'todo',
  segment: {
    content, status: 'completed', recalled: false, abandoned: false,
    implicit: false, items, elapsedMs: 18_200,
  },
} as unknown as ShellItem);

function shellOf(items: ShellItem[], over: Partial<Shell> = {}): Shell {
  return {
    kind: 'shell', seq: 0, status: 'succeeded', items, segments: [],
    thinking: false, stopped: false, elapsedMs: 130_000, quietMs: null, ...over,
  } as Shell;
}

/** 没有清单的壳:正文和工具行交替往下走 */
const FLAT_SHELL = shellOf([
  say('开场白:这一屏先摸清工作区结构。'),
  writeRow('brand-spec.md'),
  say('夹在两条步骤中间的第一句小结。'),
  cmdRow('c1', '构建产物,看能不能跑通'),
  say('夹在两条步骤中间的第二句小结。'),
  readRow('设置页.png'),
  say('收尾那一句,后面没有步骤了。'),
]);

/** 有「执行计划 · 4 步」的壳 —— 用户截图里正是这一种 */
const PLAN_SHELL = shellOf([
  say('开场白:这一屏先摸清工作区结构。'),
  // 计划里的步骤名和下面几条 todo 抽屉**必须不同字**:`child()` 按文字找格,
  // 同名会先命中计划卡(那几步就写在它的 body 里),量到的就不是抽屉那一格了。
  plan(['计划一', '计划二', '计划三', '计划四']),
  todoSeg('复刻商品列表页', [writeRow('list.html')]),
  say('截图是 4 列、24px 沟槽,和 tokens.css 里现成的栅格对得上。'),
  todoSeg('抽出商品卡', [cmdRow('c2', '构建产物,看能不能跑通')]),
  say('价格和标签抽成参数,两页各留一处引用。'),
  todoSeg('接跳转', [readRow('router.ts')]),
  say('收尾那一句,后面没有步骤了。'),
]);

/** 失败的命令行 —— 反向守卫用 */
const FAIL_SHELL = shellOf([
  cmdRow('cf', '构建产物,看能不能跑通', true),
  readRow('设置页.png'),
]);

/** 想完了的思考那一格 */
const THOUGHTS_DONE = shellOf([
  think('## 先判断页面类型\n\n从截图里的搜索条和商品网格看,是商品列表页。'),
  readRow('设置页.png'),
]);

/** 还在想的那一格 */
const THOUGHTS_LIVE = shellOf(
  [readRow('设置页.png'), think('## 正在琢磨\n\n两张图的栅格看着是同一套。')],
  { status: 'running', thinking: true },
);

/* ── 渲染:壳挂在真的接缝下面,否则 `--chat-*` 一个都算不出来 ────── */

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

const bodyOf = (root: HTMLElement): HTMLElement => {
  const flat = (recordStyles as unknown as Record<string, string>).flat as string;
  const stack = (recordStyles as unknown as Record<string, string>).stack as string;
  const el = root.querySelector<HTMLElement>(`details.${flat} > div.${stack}`);
  if (!el) throw new Error('壳的 body 没渲染出来');
  return el;
};

/** 壳 body 的直接子代里,文字含 `needle` 的那一格 */
function child(root: HTMLElement, needle: string): HTMLElement {
  const hit = [...bodyOf(root).children].find((c) => (c.textContent ?? '').includes(needle));
  if (!hit) {
    throw new Error(`壳里找不到「${needle}」;实际是 ${
      [...bodyOf(root).children].map((c) => c.tagName + ':' + (c.textContent ?? '').slice(0, 12)).join(' | ')
    }`);
  }
  return hit as HTMLElement;
}

/** 可折叠命令行那一格的 `<summary>` */
const summaryOf = (el: HTMLElement): HTMLElement => {
  const s = el.querySelector<HTMLElement>(':scope > summary');
  if (!s) throw new Error('这一格不是可折叠行');
  return s;
};

beforeAll(() => {
  document.documentElement.setAttribute('data-theme', 'light');
  // jsdom 只用来算**自定义属性**;层叠胜负靠上面 `CASCADE` 那份按 index.css 顺序读出来的快照。
  for (const file of globalFiles()) {
    const style = document.createElement('style');
    style.textContent = readFileSync(file, 'utf-8');
    document.head.appendChild(style);
  }
  for (const { file, mod } of MODULES) {
    const style = document.createElement('style');
    style.textContent = readFileSync(resolve(SRC, file), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/([^{}]+)\{/g, (m, prelude: string) => (
        prelude.trim().startsWith('@') ? m : `${scopeSelector(prelude, hashOf(mod))}{`
      ));
    document.head.appendChild(style);
  }
  CASCADE = buildCascade();
  // 静音档:挂一个真接缝,把 `--chat-text-soft` 展开成具体色值
  const probe = document.createElement('div');
  probe.className = (chatRootStyles as unknown as Record<string, string>).root as string;
  document.body.appendChild(probe);
  MUTED = toRgb(expandVars(probe, 'var(--chat-text-soft)').toLowerCase());
  probe.remove();
  if (!/^rgb\(/.test(MUTED)) throw new Error(`静音档没展开成色值:${MUTED}`);
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('.app').forEach((n) => n.remove());
});

/* ── 1 · 普通命令行:一行里几格同色 ──────────────────────────────── */

/*
 * ~~原节名「普通命令行:整行退到静音灰」~~ —— **2026-09-02 `104fc5c5dc` 翻掉**(见文件头)。
 *
 * 这一节最初要拦的事故**不是**「整行是不是灰的」,而是「**一行里几格各挑一档**」:
 * 修复前同一行的行文字 `#494949`、行首图标 `#848484`、耗时又是第三档,眼睛扫下来
 * 一行像三段。那个事故形态和墨色是深是浅无关,所以这几条留下来了,只是跟的值
 * 从静音灰换成了正文深色,并且补上了两个 `STRAY` 反向锚 —— 它们才是这一节真正的判据。
 */
describe('普通命令行:一行里每一格都同色,没有哪一格自己另挑一档', () => {
  it('不可折叠的工具行(读 / 写 / 搜索)整行是 rgb(32, 32, 32)', () => {
    const root = mount(FLAT_SHELL);
    // 用户截图里那一行:`Wrote brand-spec.md 0.1s`
    const row = child(root, 'brand-spec.md');
    expect(ink(row)).toBe(STRONG);
    // 反面:既没停在掉头前那一档,也没退回修复前那两格野色
    expect(ink(row)).not.toBe(MUTED);
    expect(ink(row)).not.toBe(STRAY.text);
  });

  it('工具行的耗时 / 图标 / 文件名跟着整行同色,不各挑一档', () => {
    const root = mount(FLAT_SHELL);
    const row = child(root, 'brand-spec.md');
    const meta = row.querySelector(`.${(recordStyles as unknown as Record<string, string>).meta}`);
    const svg = row.querySelector('svg');
    const fileCode = row.querySelector(`.${(recordStyles as unknown as Record<string, string>).file} code`);
    expect(meta, '耗时槽没渲染出来').toBeTruthy();
    expect(svg, '行首图标没渲染出来').toBeTruthy();
    expect(fileCode, '文件名没渲染出来').toBeTruthy();
    expect(ink(meta!)).toBe(STRONG);
    expect(ink(svg!)).toBe(STRONG);
    // 文件名 2026-09-02 起走 `color: inherit`(稿子 2196)—— 它没有自己的一档
    expect(ink(fileCode!)).toBe(STRONG);
    // 反向锚:修复前图标是 soft、文件名比整行深一档,两个野色都不许回来
    expect(ink(svg!)).not.toBe(STRAY.soft);
    expect(ink(meta!)).not.toBe(MUTED);
  });

  it('可折叠的命令行(有输出那一种)summary 整行同色', () => {
    const root = mount(FLAT_SHELL);
    const summary = summaryOf(child(root, '构建产物'));
    expect(ink(summary)).toBe(STRONG);
    expect(ink(summary)).not.toBe(MUTED);
  });

  it('可折叠命令行的标题、耗时、图标都跟着 summary 走', () => {
    const root = mount(FLAT_SHELL);
    const summary = summaryOf(child(root, '构建产物'));
    const name = summary.querySelector(`.${(recordStyles as unknown as Record<string, string>).name}`);
    const meta = summary.querySelector(`.${(recordStyles as unknown as Record<string, string>).meta}`);
    const svg = summary.querySelector('svg');
    expect(name && meta && svg, 'summary 三个槽没齐').toBeTruthy();
    expect(ink(name!)).toBe(STRONG);
    expect(ink(meta!)).toBe(STRONG);
    expect(ink(svg!)).toBe(STRONG);
    // 耗时这一格掉头前是 soft(折叠头那一档),必须没有掉回去
    expect(ink(meta!)).not.toBe(STRAY.soft);
    expect(ink(meta!)).not.toBe(MUTED);
  });
});

/*
 * ~~原节名「反向守卫:失败行保留状态色」,原判据是「失败行**不吃**静音灰」~~ ——
 * **2026-09-02 翻掉**。掉头前失败行靠 `:not(.is-fail)` 从整族静音灰里豁免出来,
 * 于是「整行色」本身就能把失败和成功分开;稿子 1107 这一版**去掉了那个排除**,
 * 两种状态的整行文字现在**同色**。
 *
 * ⚠️ 所以原来那三条 `expect(x).not.toBe(MUTED)` 现在两边都真,**是空过**。
 * 这一节整个重挂判据:失败与成功的区别只剩**行首图标**和「失败」二字,
 * 而「状态色不外溢」要问的也不再是「隔壁那行还灰不灰」,而是
 * 「隔壁那行的**图标**有没有跟着红」。
 */
describe('失败 vs 成功:红只落在图标和「失败」二字,不染整行', () => {
  it('失败命令行的整行文字和成功行**同色** —— 稿子去掉了 `:not(.is-fail)`', () => {
    const failRoot = mount(FAIL_SHELL);
    /*
     * ⚠️ 必须**在拆掉这张壳之前**把值读出来。`ink()` 靠 `getComputedStyle` 展开
     * `var()`,节点一旦离开文档树,`--chat-*` 就查不到了,读回来的是字面的
     * `var(--chat-text-strong)` —— 那会变成一个看起来像失配、其实是量法失效的红。
     */
    const failInk = ink(summaryOf(child(failRoot, '构建产物')));
    expect(failInk).toBe(STRONG);
    cleanup();
    document.querySelectorAll('.app').forEach((n) => n.remove());

    const okRoot = mount(FLAT_SHELL);
    const okInk = ink(summaryOf(child(okRoot, '构建产物')));
    // 钉的是「两种状态同色」这件事本身 —— 而且先证明这个色不是某个默认值
    expect(okInk).toBe(STRONG);
    expect(failInk).toBe(okInk);
  });

  it('失败行的「失败」二字和行首图标仍然是红的 —— 区分全靠这两枚', () => {
    const root = mount(FAIL_SHELL);
    const summary = summaryOf(child(root, '构建产物'));
    const why = summary.querySelector(`.${(recordStyles as unknown as Record<string, string>).why}`);
    const svg = summary.querySelector('svg');
    expect(why, '「失败」那枚标记没渲染出来').toBeTruthy();
    expect(svg, '行首图标没渲染出来').toBeTruthy();
    expect(ink(why!)).toBe(RED);
    expect(ink(svg!)).toBe(RED);
    // 整行同色之后,这两枚就是**唯一**的区分手段 —— 它们不红,失败就看不出来了
    expect(ink(summary)).not.toBe(RED);
  });

  it('同一张壳里没失败的那一行,图标不跟着红 —— 状态色不外溢', () => {
    const root = mount(FAIL_SHELL);
    const okRow = child(root, '设置页.png');
    const svg = okRow.querySelector('svg');
    expect(svg, '行首图标没渲染出来').toBeTruthy();
    expect(ink(svg!)).toBe(STRONG);
    expect(ink(svg!)).not.toBe(RED);
    expect(ink(okRow)).toBe(STRONG);
  });
});

/* ── 2 · 步骤间小结 ──────────────────────────────────────────────── */

describe('步骤间小结:13px / 400 + 22px,开场白不动', () => {
  /*
   * ~~原节名「步骤间小结:12px 静音灰,开场白不动」~~ —— **2026-09-02 翻掉**。
   * 稿子 1071-1076 现在的原话:「步骤间的小结**与正文同为 13px**,但降到常规字重,
   * 避免盖过步骤标题」。小结和开场白因此**同色同字号**,分档只剩两样:
   * **字重**(小结 400 / 开场白继承 500)和 **22px 缩进**。
   * 下面每一条的反向锚都换成了字重 —— 原来那些 `not.toBe(MUTED)` 现在是空过。
   */
  /*
   * ⚠️ **2026-09-02 翻向。** 这一条原来钉的是「没有清单的壳里,夹在两条**工具行**
   * 中间的正文也算步骤间小结」(§F-11 ① 的口径:工具行有两种 DOM,都算步骤)。
   *
   * 用户当天的裁决把「步骤」这个词收窄了:「如果是在 todo 外的 toolrow 或者普通文本,
   * 或者 thinking,不要有任何的缩进了,也不要这个竖着的灰线」。工具行不再算一步,
   * 于是一张没有清单的壳里**一步都没有** —— 没有链,也就没有「步骤间」可言,
   * 中间那几句只是流水叙述,留在正文那一档。
   *
   * 有清单的壳里那几句仍然是小结(下面那条钉着),两条一起看才是完整口径。
   */
  it('没有清单的壳:一步都没有,中间那几句就只是叙述,不吃小结那一档', () => {
    const root = mount(FLAT_SHELL);
    const mid = child(root, '第一句小结');
    expect(ink(mid)).toBe(STRONG);
    expect(size(mid)).toBe('13px');
    /*
     * 反面判据 2026-09-02 换过:原来是 `not.toBe(MUTED)`(小结当时是静音灰),
     * 现在小结和叙述**同色同字号**,那句已经空过了。真正的区别是字重和缩进。
     */
    expect(weight(mid)).toBe('500');
    expect(winner(mid, 'padding-inline-start')?.value.trim()).not.toBe('22px');
  });

  it('**有「执行计划」的壳同样命中** —— 用户截图里正是这一种', () => {
    const root = mount(PLAN_SHELL);
    const mid = child(root, '24px 沟槽');
    // 色和字号跟开场白一样(掉头之后不再是 12px 静音灰),命中与否看下面两条
    expect(ink(mid)).toBe(STRONG);
    expect(size(mid)).toBe('13px');
    expect(weight(mid)).toBe('400');
    expect(winner(mid, 'padding-inline-start')?.value.trim()).toBe('22px');
    // 反向锚:掉回 12px / 静音灰就是把 `104fc5c5dc` 那次掉头撤了
    expect(size(mid)).not.toBe('12px');
    expect(ink(mid)).not.toBe(MUTED);
  });

  it('两种壳的开场白都保持 13px / 500 正文深色 —— 层次不能被一起抹平', () => {
    for (const shell of [FLAT_SHELL, PLAN_SHELL]) {
      const root = mount(shell);
      const opening = child(root, '开场白');
      expect(ink(opening)).toBe(STRONG);
      expect(size(opening)).toBe('13px');
      // 开场白**不吃**小结那一档的 400 —— 掉头之后这是两者仅剩的区别之一
      expect(weight(opening)).toBe('500');
      cleanup();
      document.querySelectorAll('.app').forEach((n) => n.remove());
    }
  });

  it('收尾那一句后面没有步骤了,不算小结,保持开场白那一档', () => {
    const root = mount(PLAN_SHELL);
    const tail = child(root, '收尾那一句');
    expect(ink(tail)).toBe(STRONG);
    expect(size(tail)).toBe('13px');
    expect(weight(tail)).toBe('500');
  });

  /** 掉头之后缩进从「顺带对齐」升成了**主要区分手段之一**,所以这一条比从前更要紧 */
  it('小结右移 22px,让首字和步骤名对齐', () => {
    const root = mount(PLAN_SHELL);
    const mid = child(root, '24px 沟槽');
    const pad = winner(mid, 'padding-inline-start');
    expect(pad?.value.trim()).toBe('22px');
  });
});

/* ── 3 · 思考那一格 ──────────────────────────────────────────────── */

describe('思考:两态同一只灰底容器', () => {
  it('还在想那一态有灰底(稿子本来就有)', () => {
    const root = mount(THOUGHTS_LIVE);
    const stream = root.querySelector<HTMLElement>(
      `.${(recordStyles as unknown as Record<string, string>).stream}`,
    );
    expect(stream, '流窗没渲染出来').toBeTruthy();
    expect(ground(stream!)).not.toBe('');
  });

  it('想完了那一态**也有**灰底(产品裁决 2026-09-02,明确偏离稿子)', () => {
    const live = mount(THOUGHTS_LIVE);
    const streamGround = ground(live.querySelector<HTMLElement>(
      `.${(recordStyles as unknown as Record<string, string>).stream}`,
    )!);
    expect(streamGround, '流窗自己都没底色,后面的对照没意义').not.toBe('');
    cleanup();
    document.querySelectorAll('.app').forEach((n) => n.remove());

    const root = mount(THOUGHTS_DONE);
    const thoughts = root.querySelector<HTMLElement>(
      `details.${(recordStyles as unknown as Record<string, string>).thoughts}`,
    );
    expect(thoughts, '思考那一格没渲染出来').toBeTruthy();
    const body = thoughts!.querySelector<HTMLElement>(':scope > div');
    expect(body, '想完了那一格的 body 没渲染出来').toBeTruthy();
    // 钉的是**同一份职责**:两态吃到的是同一个底色值,不是各抄一份
    expect(ground(body!)).toBe(streamGround);
  });

  /*
   * ⚠️ 这一条钉的是 CSS Module 的一个**静默失效**:类名只有在样式表里真的出现过,
   * 打包器才会把它发出来;`ExecutionShell` 一直在传 `className={styles.thoughts}`,
   * 而 `record.module.css` 里从来没有 `.thoughts` 这条选择器 —— 于是产线上
   * `styles.thoughts` 是 `undefined`,那个类一次都没上过 DOM。
   * vitest 的 CSS Module 代理对**任何**键都返回类名,上面几条渲染断言照不出这件事,
   * 只有直接读源文件才照得出。同一个坑 `.hasTodo` 的注释里已经写过一次。
   */
  it('`.thoughts` 在样式表里真的有规则 —— 否则这个类根本不会被发出来', () => {
    const css = readFileSync(
      resolve(SRC, 'components/chat/primitives/record.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.thoughts[\s,.:[>+~{]/);
  });
});

/*
 * ~~这一节原是「没跟着翻」的那一半:思考流正文走自己那枚 `--chat-stream-ink`(#a3a3a3),
 * 稿子写明了「不联动任务进度」。~~
 *
 * **2026-09-16 设计定稿(OPEND-3178 录屏 + 评论「颜色使用的是 #494949」,OPEND-3177)**:
 * 思考窗不再铺灰底、正文直接落在透明面板上,静音灰在面板底纹上读不清,于是思考正文
 * 提到正文那一档 `--chat-text`(亮色 #494949)。它**仍然不是**任务进度那一档
 * `--text-strong`(#202020):比正文深色浅一格,也不再是终端块那档静音灰。
 *
 * **Fantay 2026-11-08**:Fantay 的墨系统里 `--text` 就是 `--ink`,和答案正文同色 ——
 * 推理和结论读起来分不出主次。思考正文改走 `--chat-stream-ink`(→ `--text-muted`),
 * 比正文**正好**浅一档;3178 那条「静音灰在面板上读不清」的教训仍然成立,所以不回到
 * `--chat-text-soft` 那一档。下面第一条把三条边界一起守住:不是深色、不是正文、不是浅两档。
 */
describe('思考正文:比正文浅正好一档(既不是正文 / 任务进度的深色,也不是浅两档的静音灰)', () => {
  it('流窗里的推理是 rgb(92, 92, 92) —— `--chat-stream-ink`,不是正文、不是 --text-strong、也不是 --chat-text-soft', () => {
    const root = mount(THOUGHTS_LIVE);
    const md = root.querySelector<HTMLElement>('[data-testid="thinking-markdown"]');
    expect(md, '思考正文没渲染出来').toBeTruthy();
    expect(ink(md!)).toBe(STREAM);
    expect(ink(md!)).not.toBe(BODY);
    expect(ink(md!)).not.toBe(STRONG);
    expect(ink(md!)).not.toBe(MUTED);
  });

  it('流窗里的推理是常规字重(W8 把面板基线换成 500 之后要顶住)', () => {
    const root = mount(THOUGHTS_LIVE);
    const md = root.querySelector<HTMLElement>('[data-testid="thinking-markdown"]')!;
    expect(weight(md)).toBe('400');
  });

  it('想完了那一格的小标题不再是 600 深色', () => {
    const root = mount(THOUGHTS_DONE);
    const h = root.querySelector<HTMLElement>('[data-testid="thinking-markdown"] .md-h');
    expect(h, 'markdown 小标题没渲染出来').toBeTruthy();
    expect(weight(h!)).not.toBe('600');
    expect(ink(h!)).not.toBe(STRONG);
  });
});

/* ── 4 · 层次没有被一起抹平 ──────────────────────────────────────── */

describe('墨色分层:同一屏里深的深、浅的浅', () => {
  it('壳头(已完成)是正文深色', () => {
    const root = mount(FLAT_SHELL);
    const head = root.querySelector<HTMLElement>(
      `details.${(recordStyles as unknown as Record<string, string>).flat} > summary`,
    );
    expect(ink(head!)).toBe(STRONG);
  });

  /**
   * ~~原名「步骤标题仍是 13px / 500 的深色,**只有它右边的耗时是静音灰**」~~ ——
   * 后半句 2026-09-02 被翻掉:稿子 1064 把步骤耗时也改成了 `var(--text-strong)`。
   * 标题和耗时现在同色,退的那一档换成了**字号**(13px vs 12px)。
   */
  it('步骤标题 13px / 500,右边的耗时同色但小一号', () => {
    const root = mount(PLAN_SHELL);
    const step = child(root, '复刻商品列表页');
    const summary = summaryOf(step);
    expect(ink(summary)).toBe(STRONG);
    expect(size(summary)).toBe('13px');
    expect(weight(summary)).toBe('500');
    const meta = summary.querySelector<HTMLElement>(`.${(recordStyles as unknown as Record<string, string>).meta}`);
    expect(meta, '耗时槽没渲染出来').toBeTruthy();
    expect(ink(meta!)).toBe(STRONG);
    expect(size(meta!)).toBe('12px');
    // 反向锚:耗时掉回静音灰就是把那次掉头撤了
    expect(ink(meta!)).not.toBe(MUTED);
  });

  /**
   * ⚠️ **这一条是这一篇现在的重心。**
   *
   * 产品里终端块原来和任务进度**共用**一枚 `--chat-progress-detail-ink`;
   * `104fc5c5dc` 只把任务进度翻深、终端块三行(`components.css:2419 / 2439 / 2450`)
   * 原地未动。共用一枚变量给不出两个值,所以终端块 2026-09-02 领了自己的
   * `--chat-terminal-ink`。少了这一条,「把那枚共用变量整个翻深」也能让这一篇全绿,
   * 而屏幕上终端块会跟着一起变深 —— 那正是稿子没画过的样子。
   */
  it('终端块**没有**跟着翻深,仍在静音灰那一档', () => {
    const root = mount(FLAT_SHELL);
    const fold = child(root, '构建产物');
    const term = fold.querySelector<HTMLElement>(`.${(recordStyles as unknown as Record<string, string>).term}`);
    const summary = summaryOf(fold);
    expect(term, '终端块没渲染出来').toBeTruthy();
    expect(ink(term!)).toBe(MUTED);
    // 终端块自己领的 token 直接取静音档 —— 不是 `--chat-text-strong` / `--chat-progress-detail-ink`
    expect(ink(term!)).not.toBe(STRONG);
    // 同一格里:它头顶那行命令行已经是深的,两档并排比才照得出「没一起翻」
    expect(ink(summary)).toBe(STRONG);
    expect(ink(term!)).not.toBe(ink(summary));
  });

  it('工具行的字号跟稿子一致:13px(`.tool { font-size: var(--t-body) }`)', () => {
    const root = mount(FLAT_SHELL);
    expect(size(child(root, 'brand-spec.md'))).toBe('13px');
  });
});
