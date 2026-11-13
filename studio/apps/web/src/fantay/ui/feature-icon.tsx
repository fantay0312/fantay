'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay feature icons: the layered icons that mark navigation targets (sidebar rows, settings
 * sections, home creation chips) and change shape while their row is hovered or keyboard-focused.
 * Drawn by the vendored Kubai Icons engine (src/vendor/kubai-icons, Kubai Icons License) in the
 * Fantay ink, one line palette per theme: a minimal line drawing in --ink #181818 (dark #EDEDED)
 * whose fills blend into whatever surface is behind it, so hover and active rows show through.
 * Glyphs inside menus and controls stay Lucide (`./icons`); this is only for feature entries.
 */
import * as React from 'react';
import { FANTAY_INK, ICONS, go, mountIcon, recolor, runtime } from '../../vendor/kubai-icons/runtime';
import { cn } from './cn';

/** Feature → icon in the vendored set. Edit the set in fantay-design/tools/feature-icons. */
export const FEATURE_ICONS = {
  newChat: '聊天',
  home: '主页',
  allProjects: '快捷方式',
  workbench: '台灯',
  materials: '文件夹',
  plugins: '拼图',
  automations: '闹钟',
  community: '地球',
  archived: '包裹',
  settings: '设置',
  modelProviders: '芯片',
  instructions: '剪贴板',
  memory: '笔记本',
  account: '用户',
  general: '调节',
  usage: '图表',
  labs: '烧瓶',
  privacy: '盾牌',
  about: '信息',
  webApp: '网页',
  image: '照片',
  video: '视频',
  motion: '胶片',
  social: '手机',
  deck: '幻灯片',
  document: '文档',
  personalAgent: '服务铃',
  paAssistant: '聊天',
  paAgents: '机器人',
  paGroups: '机器人组',
  paTasks: '清单',
  paMemories: '笔记本',
  paConnections: '插头',
} as const;

export type FeatureIconName = keyof typeof FEATURE_ICONS;

/* The engine paints every icon from one global palette. The tokens key the theme on <html data-theme>,
   so the ink follows that attribute; each FANTAY_INK palette gives one colour to every icon. */
const engine = runtime as { palette: unknown };
const themeInk = () => (document.documentElement.dataset.theme === 'dark' ? FANTAY_INK.dark : FANTAY_INK.light);
engine.palette = FANTAY_INK.light;
const BY_NAME = new Map(ICONS.map((icon) => [icon.name, icon]));
let nextKey = 0;

/* While any icon is mounted, one observer repaints them all when the theme flips, at once like the
   rest of the page (theme switches suspend transitions). */
type Instance = ReturnType<typeof mountIcon>;
const live = new Set<Instance>();
let themeWatch: MutationObserver | null = null;

function follow(inst: Instance) {
  live.add(inst);
  if (themeWatch || typeof MutationObserver === 'undefined') return;
  themeWatch = new MutationObserver(() => {
    engine.palette = themeInk();
    live.forEach(recolor);
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

function unfollow(inst: Instance) {
  live.delete(inst);
  if (live.size || !themeWatch) return;
  themeWatch.disconnect();
  themeWatch = null;
}

/* The interactive element whose hover and keyboard focus drive the icon. */
const TRIGGER = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"]';

/* The gallery's stylesheet gives these classes their stroke weights; here they become presentation
   attributes, so the engine's inline styles (a line palette's widths, the SVG's blend) still win. */
function styleSvg(host: HTMLElement) {
  const svg = host.querySelector('svg');
  if (svg) Object.assign(svg.style, { display: 'block', width: '100%', height: '100%', overflow: 'visible', opacity: '1' });
  host.querySelectorAll('.ol').forEach((el) => {
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-width', '2');
  });
  host.querySelectorAll('.ln').forEach((el) => {
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-width', '1.6');
    el.setAttribute('stroke-linecap', 'round');
  });
}

export interface FeatureIconProps {
  name: FeatureIconName;
  /** Width in px; the 31×29 canvas keeps its aspect. Default 22 (the content reads about 17px). */
  size?: number;
  /** Layout width in px when the surrounding row was built for a smaller glyph: the icon still
   *  draws at `size` but negative inline margins make it take `slot`, so labels keep their column. */
  slot?: number;
  className?: string;
  /** Present → role="img" + aria-label; absent → aria-hidden (the row's label names it). */
  label?: string;
}

export function FeatureIcon({ name, size = 22, slot, className, label }: FeatureIconProps) {
  const ref = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    const host = ref.current;
    const icon = BY_NAME.get(FEATURE_ICONS[name]);
    if (!host || !icon) return undefined;
    engine.palette = themeInk();
    const inst = mountIcon(icon, nextKey++, host);
    styleSvg(host);
    follow(inst);

    const trigger = host.closest<HTMLElement>(TRIGGER) ?? host;
    let pointer = false;
    let focus = false;
    const sync = () => {
      const on = pointer || focus ? 1 : 0;
      if (inst.hover === on) return;
      inst.hover = on;
      go(inst);
    };
    const enter = (event: PointerEvent) => { if (event.pointerType === 'mouse') { pointer = true; sync(); } };
    const leave = (event: PointerEvent) => { if (event.pointerType === 'mouse') { pointer = false; sync(); } };
    /* Keyboard focus only: a click also focuses the row, and the icon should settle after it. */
    const focusIn = () => { focus = trigger.matches(':focus-visible'); sync(); };
    const focusOut = () => { focus = false; sync(); };
    trigger.addEventListener('pointerenter', enter);
    trigger.addEventListener('pointerleave', leave);
    trigger.addEventListener('focusin', focusIn);
    trigger.addEventListener('focusout', focusOut);

    return () => {
      cancelAnimationFrame(inst.raf);
      unfollow(inst);
      trigger.removeEventListener('pointerenter', enter);
      trigger.removeEventListener('pointerleave', leave);
      trigger.removeEventListener('focusin', focusIn);
      trigger.removeEventListener('focusout', focusOut);
      host.replaceChildren();
    };
  }, [name]);

  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <span
      ref={ref}
      data-feature-icon={name}
      className={cn('inline-block flex-none', className)}
      style={{ width: size, height: (size * 29) / 31, marginInline: slot === undefined ? undefined : (slot - size) / 2 }}
      {...a11y}
    />
  );
}
