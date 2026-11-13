// Copyright (c) 2026 Kubai087. Licensed under the Kubai Icons License; see LICENSE.
// The gallery: every icon in ORDER, a palette control and a demo switch.

// Fantay Studio: the sidebar rows, then the settings sections, then the home creation chips,
// then the Personal Agent icons (its sidebar entry and sections; 助手 and 记忆 reuse 聊天 and 笔记本).
const ORDER = [
  '聊天', '主页', '快捷方式', '台灯', '文件夹', '拼图', '闹钟', '地球', '包裹', '设置',
  '芯片', '剪贴板', '笔记本', '用户', '调节', '图表', '烧瓶', '盾牌', '信息',
  '网页', '照片', '视频', '胶片', '手机', '幻灯片', '文档',
  '服务铃', '机器人', '机器人组', '清单', '插头'
];
// Where each icon stands in the product, shown as the tile's tooltip.
const USES = {
  聊天: '侧栏 · 新对话', 主页: '侧栏 · 主页', 快捷方式: '侧栏 · 全部项目', 台灯: '侧栏 · 工作台', 文件夹: '侧栏 · 素材库', 拼图: '侧栏 · 插件',
  闹钟: '侧栏 · 自动化', 地球: '侧栏 · 社区', 包裹: '侧栏 · 已归档', 设置: '侧栏 · 设置',
  芯片: '设置 · 模型与提供商', 剪贴板: '设置 · 指令与规则', 笔记本: '设置 · 记忆', 用户: '设置 · 账户', 调节: '设置 · 通用',
  图表: '设置 · AI 用量', 烧瓶: '设置 · 实验室', 盾牌: '设置 · 隐私', 信息: '设置 · 关于',
  网页: '首页 · 网页/应用设计', 照片: '首页 · 图片', 视频: '首页 · 视频', 胶片: '首页 · 代码动画',
  手机: '首页 · 社媒设计', 幻灯片: '首页 · 演示', 文档: '首页 · 文档',
  服务铃: '侧栏 · 个人助手 PA', 机器人: 'PA · 智能体', 机器人组: 'PA · 群组', 清单: 'PA · 任务', 插头: 'PA · 连接与设置'
};
const BY_NAME = Object.fromEntries(ICONS.map((icon) => [icon.name, icon]));
const LIST = ORDER.map((name) => BY_NAME[name]);
const N = LIST.length;

const COLORFUL = ['#5393FF', '#6366F1', '#EC4899', '#F97316', '#22C55E', '#06B6D4', '#8B5CF6', '#F43F5E', '#14B8A6', '#0284C7', '#0EA5E9', '#EF4444', '#7C3AED', '#F59E0B', '#4F46E5', '#0D9488', '#16A34A', '#D97706', '#64748B', '#DC2626'];
const spread = (list) => Array.from({ length: N }, (_, i) => list[i % list.length]);
// Fantay ink (the product's palette), one line palette per Studio theme; the dark one is drawn
// for a dark page (`page`), so choosing it takes the page dark. The black-and-white solid ink
// and the others stay for comparison.
const PALETTES = [
  inkTone(FANTAY_INK.light, N),
  { ...inkTone(FANTAY_INK.dark, N), page: 'dark' },
  inkTone(FANTAY_SOLID.light, N),
  { ...inkTone(FANTAY_SOLID.dark, N), page: 'dark' },
  { name: '彩色', colors: spread(COLORFUL), swatch: ['#5393FF', '#EC4899', '#F59E0B', '#22C55E'] },
  clearTone('蓝灰', '#6F87B5', N),
  flatTone('黑色', '#2E3036', N)
];
runtime.palette = PALETTES[0];

// ---------- Grid ----------
const grid = document.getElementById('grid');
const insts = LIST.map((icon, i) => {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.tabIndex = 0;
  tile.setAttribute('role', 'img');
  tile.setAttribute('aria-label', icon.name);
  tile.title = USES[icon.name] ? `${icon.name} · ${USES[icon.name]}` : icon.name;
  const host = document.createElement('span');
  host.className = 'ic';
  tile.appendChild(host);
  grid.appendChild(tile);
  const inst = mountIcon(icon, i, host);
  bind(inst, tile);
  return inst;
});

function bind(inst, el) {
  const tap = () => {
    if (inst.icon.tap) inst.s.saved = !inst.s.saved; else inst.pin = !inst.pin;
    go(inst);
  };
  el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { inst.hover++; go(inst); } });
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { inst.hover = Math.max(0, inst.hover - 1); go(inst); } });
  el.addEventListener('click', (e) => { if (inst.icon.tap || (e.pointerType && e.pointerType !== 'mouse')) tap(); });
  el.addEventListener('focus', () => { inst.hover++; go(inst); });
  el.addEventListener('blur', () => { inst.hover = Math.max(0, inst.hover - 1); go(inst); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tap(); } });
}

// ---------- Palette control ----------
let timers = [];
const later = (fn, ms) => timers.push(setTimeout(fn, REDUCED ? 0 : ms));
const wave = (fn, gap) => insts.forEach((inst, i) => later(() => fn(inst), i * gap));

const seg = document.getElementById('palette');
const segButtons = PALETTES.map((pal, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(i === 0));
  b.tabIndex = i === 0 ? 0 : -1;
  const dots = pal.swatch || [pal.colors[0]];
  b.innerHTML = `<span class="dots">${dots.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${pal.name}`;
  b.addEventListener('click', () => choose(i));
  seg.appendChild(b);
  return b;
});
function choose(i) {
  const next = (i + PALETTES.length) % PALETTES.length;
  runtime.palette = PALETTES[next];
  document.documentElement.dataset.page = PALETTES[next].page || 'light';
  segButtons.forEach((b, j) => { b.setAttribute('aria-checked', String(j === next)); b.tabIndex = j === next ? 0 : -1; });
  wave(go, 12);
  return next;
}
seg.addEventListener('keydown', (e) => {
  const cur = segButtons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  segButtons[choose(cur + step)].focus();
});

// ---------- Demo switch ----------
const sw = document.getElementById('demo');
let demoOn = false;
function demoCycle() {
  const gap = 25, span = gap * N + DUR;
  wave((inst) => { inst.demo = true; go(inst); }, gap);
  later(() => {
    wave((inst) => { inst.demo = false; go(inst); }, gap);
    later(demoCycle, span + 700);
  }, span + 1200);
}
function setDemo(on) {
  demoOn = on;
  sw.setAttribute('aria-checked', String(on));
  timers.forEach(clearTimeout);
  timers = [];
  if (on) demoCycle();
  // Clearing the timers can also cut a palette wave short, so every icon heads for its
  // target in the current palette, not only those the demo was holding.
  else insts.forEach((inst) => { inst.demo = false; go(inst); });
}
sw.addEventListener('click', () => setDemo(!demoOn));
