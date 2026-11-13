import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const toolsCss = readFileSync(new URL('../../src/styles/viewer/tools.css', import.meta.url), 'utf8');
const composioCss = readFileSync(new URL('../../src/styles/viewer/composio.css', import.meta.url), 'utf8');
const routinesCss = readFileSync(new URL('../../src/styles/viewer/routines.css', import.meta.url), 'utf8');
const theaterCss = readFileSync(new URL('../../src/styles/viewer/theater.css', import.meta.url), 'utf8');

function declarations(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS block for ${selector}`);
  return match[1] ?? '';
}

describe('chat disclosure accessibility styles', () => {
  it('lets a running category badge retain the running state color', () => {
    expect(declarations(toolsCss, '.op-status-running')).toContain('color: var(--purple)');
    expect(declarations(toolsCss, '.op-status-category')).not.toMatch(/(?:^|\n)\s*color\s*:/);
  });

  it('keeps the thinking accordion expandable in the compact current activity row', () => {
    // The compact running row strips tool-card disclosures, but the thinking
    // block's accordion must stay displayable so streamed reasoning can be
    // expanded mid-run (incident recvqgLmAkUM6G). Hiding every
    // .accordion-collapsible under the row regresses that.
    expect(routinesCss).not.toMatch(/task-activity-current-row \.accordion-collapsible/);
    expect(routinesCss).toContain('.app .task-activity-current-row .op-card .accordion-collapsible');
  });

  it('keeps the final controls visible and hides only the historical action cluster', () => {
    /*
     * Fantay 2026-11-08: the gate moved from the whole row to the action
     * cluster. Status word and time stay readable on every turn, so a past
     * answer never ends in an empty band and no visible text drops below
     * contrast minimums (a 0.55 row put the #888 time at ~1.9:1). Copy /
     * feedback / fork rest hidden on historical turns and come up on message
     * hover or keyboard focus; the latest row and touch devices keep them.
     * Opacity keeps geometry stable, so revealing them moves nothing.
     */
    const base = declarations(composioCss, '.assistant-footer');
    expect(base).not.toMatch(/opacity:/);
    expect(composioCss).toMatch(
      /\.assistant-footer:not\(\[data-last="true"\]\) \.assistant-footer-controls\s*\{\s*opacity:\s*0;/,
    );
    expect(composioCss).toMatch(
      /\.msg\.assistant:hover \.assistant-footer \.assistant-footer-controls,\s*\.msg\.assistant:focus-within \.assistant-footer \.assistant-footer-controls\s*\{[^}]*opacity:\s*1/,
    );
    expect(composioCss).toMatch(
      /@media \(hover: none\)\s*\{\s*\.assistant-footer:not\(\[data-last="true"\]\) \.assistant-footer-controls\s*\{\s*opacity:\s*1;\s*\}\s*\}/,
    );

    // Keep one ownership point; a late `.app` duplicate previously overrode
    // this behavior through specificity and import order.
    expect(declarations(routinesCss, '.app .assistant-footer')).not.toContain('opacity:');
  });
});

describe('〔继续剩余任务〕是一颗有字的按钮,不能套图标按钮的尺寸', () => {
  /**
   * 真机复现(2026-08-27,codex 跑到一半按停):那一行渲染成
   * 「已取消　继续剩[余任务]」—— 六个字**压在**旁边的状态词上。
   *
   * 成因:T7 接线时复用了 `.assistant-copy-button`,而那是给图标用的
   * **固定 26×26** 方格(`width: 26px; height: 26px; padding: 0`),
   * 还带 `overflow: visible` —— 于是文字整个溢出到盒子外面,既压别人,
   * 又只有 26px 的地方点得到。
   *
   * 判据落在「这颗按钮用的那个类,不许把宽高钉死」上:jsdom 不做布局,
   * 量不出重叠,但类和规则的这层对应关系是能钉住的。
   */
  const CONTINUE_CLASS = 'assistant-continue-remaining';

  function ruleFor(css: string, selector: string): string | null {
    const m = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`));
    return m ? (m[1] ?? '') : null;
  }

  it('has a rule of its own', () => {
    expect(ruleFor(theaterCss, CONTINUE_CLASS), '没有自己的规则 = 还在蹭图标按钮那一套').not.toBeNull();
  });

  it('never pins its width or height the way the icon buttons do', () => {
    const body = ruleFor(theaterCss, CONTINUE_CLASS) ?? '';
    expect(body).not.toMatch(/(?:^|;)\s*width\s*:\s*\d+px/);
    expect(body).not.toMatch(/(?:^|;)\s*height\s*:\s*\d+px/);
    // 文字按钮要有左右内边距,否则贴着相邻元素
    expect(body, '有字的按钮得留左右内边距').toMatch(/padding\s*:/);
  });

  it('leaves the icon buttons on their fixed square', () => {
    // 反向:别顺手把图标按钮也放开了 —— 一排小图标各自变宽会散架。
    // 2026-11-08 方格从稿子的 26 放到 28(触达档),仍然是定死的正方形。
    const icon = ruleFor(theaterCss, 'assistant-copy-button') ?? '';
    expect(icon).toMatch(/width\s*:\s*28px/);
    expect(icon).toMatch(/height\s*:\s*28px/);
  });
});
