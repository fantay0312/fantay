import { randomBytes } from 'node:crypto';
import type { TokenToSeaUser } from '@open-design/contracts';
import {
  CALLBACK_CHARACTER_MARKUP,
  CALLBACK_CHARACTER_RIG,
  CALLBACK_CHARACTER_VIEW_BOX,
  CALLBACK_WORD_LETTERS,
  CALLBACK_WORD_VIEW_BOX,
} from './callback-art.js';

export interface CallbackPageDetail {
  user?: Pick<TokenToSeaUser, 'name' | 'email' | 'picture'> | null | undefined;
  error?: string | undefined;
  scriptNonce?: string | undefined;
}

export interface RenderedCallbackPage {
  html: string;
  csp: string;
}

type SparkSpec = {
  dx: number;
  dy: number;
  rot: number;
  size: number;
  delay: number;
  warm: boolean;
};

const STAR_CLIP = 'polygon(50% 0, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 39%)';
const STEP_STAR_CLIP = 'polygon(50% 0, 65% 35%, 100% 50%, 65% 65%, 50% 100%, 35% 65%, 0 50%, 35% 35%)';

const ORB_ORIGIN_PCT = {
  x: ((CALLBACK_CHARACTER_RIG.orb[0] / 512) * 100).toFixed(2),
  y: ((CALLBACK_CHARACTER_RIG.orb[1] / 512) * 100).toFixed(2),
};

const IGNITE_SPARKS: readonly SparkSpec[] = [
  { dx: 42, dy: -34, rot: 120, size: 12, delay: 0, warm: true },
  { dx: 62, dy: 6, rot: -90, size: 9, delay: 35, warm: false },
  { dx: 22, dy: -58, rot: 160, size: 10, delay: 20, warm: false },
  { dx: -22, dy: -50, rot: -140, size: 8, delay: 60, warm: true },
  { dx: 48, dy: 38, rot: 105, size: 8, delay: 80, warm: true },
  { dx: 74, dy: -24, rot: -115, size: 7, delay: 100, warm: false },
];

const CHEER_SPARKS: readonly SparkSpec[] = [
  { dx: -102, dy: -32, rot: -120, size: 12, delay: 0, warm: true },
  { dx: -82, dy: -82, rot: 100, size: 9, delay: 45, warm: false },
  { dx: 96, dy: -72, rot: 140, size: 11, delay: 20, warm: false },
  { dx: 112, dy: -8, rot: -100, size: 9, delay: 65, warm: true },
  { dx: -106, dy: 30, rot: 90, size: 8, delay: 85, warm: false },
  { dx: 102, dy: 42, rot: -150, size: 8, delay: 35, warm: true },
  { dx: -36, dy: -98, rot: 75, size: 8, delay: 55, warm: true },
  { dx: 44, dy: -96, rot: -75, size: 9, delay: 15, warm: false },
];

const px = (point: readonly [number, number]): string => `${point[0]}px ${point[1]}px`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function indexHatStars(markup: string): string {
  let index = 0;
  return markup.replace(/class="cb-star"/g, () => `class="cb-star" style="--n:${index++}"`);
}

function renderSparks(sparks: readonly SparkSpec[]): string {
  return sparks
    .map(
      (s) =>
        `<i class="cb-spark ${s.warm ? 'cb-warm' : 'cb-cool'}" style="--dx:${s.dx}px;--dy:${s.dy}px;--rot:${s.rot}deg;--s:${s.size}px;--d:${s.delay}ms"></i>`,
    )
    .join('');
}

function monogramFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'F';
  const codePoint = trimmed.codePointAt(0);
  if (!codePoint) return 'F';
  return String.fromCodePoint(codePoint).toUpperCase();
}

const CHARACTER_INDEXED = indexHatStars(CALLBACK_CHARACTER_MARKUP);
const WORDMARK_PATHS = CALLBACK_WORD_LETTERS.map(
  (d, index) => `<path class="cb-letter" style="--i:${index}" d="${d}"/>`,
).join('');

const CALLBACK_STYLES = `
:root {
  --paper-light: #f6f5f1;
  --paper-dark: #121317;
  --card-light: #ffffff;
  --card-dark: #1a1b21;
  --tray-light: #f3f2ee;
  --tray-dark: #22242c;
  --ink-light: #18181b;
  --ink-dark: #f4f4f6;
  --ink-soft-light: #52525b;
  --ink-soft-dark: #a1a1aa;
  --meta-light: #71717a;
  --meta-dark: #868692;
  --line-light: rgba(24, 24, 27, 0.085);
  --line-dark: rgba(255, 255, 255, 0.095);
  --line-strong-light: rgba(24, 24, 27, 0.16);
  --line-strong-dark: rgba(255, 255, 255, 0.18);
  --cta-bg-light: #1c1c20;
  --cta-bg-dark: #f4f4f6;
  --cta-fg-light: #fafafa;
  --cta-fg-dark: #16171b;
  --cta-hover-light: #2e2e35;
  --cta-hover-dark: #ffffff;
  --focus-light: #1a74ff;
  --focus-dark: #5ca3ff;
  --ok-bg-light: #eef0ff;
  --ok-bg-dark: rgba(111, 114, 255, 0.16);
  --ok-fg-light: #393bc4;
  --ok-fg-dark: #aeb1ff;
  --warn-bg-light: #fff1ed;
  --warn-bg-dark: rgba(254, 139, 109, 0.15);
  --warn-fg-light: #b9381e;
  --warn-fg-dark: #ffab94;
  --step-idle-light: rgba(24, 24, 27, 0.14);
  --step-idle-dark: rgba(255, 255, 255, 0.18);
  --step-lit-light: #494bdc;
  --step-lit-dark: #9396ff;
  --shadow-card-light: 0 24px 60px -16px rgba(24, 24, 27, 0.08), 0 4px 14px -2px rgba(24, 24, 27, 0.04);
  --shadow-card-dark: 0 28px 68px -16px rgba(0, 0, 0, 0.58), 0 4px 16px -2px rgba(0, 0, 0, 0.36);
  --aura-a-light: rgba(73, 75, 220, 0.075);
  --aura-a-dark: rgba(107, 110, 242, 0.14);
  --aura-b-light: rgba(254, 139, 109, 0.065);
  --aura-b-dark: rgba(254, 139, 109, 0.09);
  --mascot-shadow-light: rgba(38, 40, 120, 0.18);
  --mascot-shadow-dark: rgba(0, 0, 0, 0.52);

  --paper: var(--paper-light);
  --card: var(--card-light);
  --tray: var(--tray-light);
  --ink: var(--ink-light);
  --ink-soft: var(--ink-soft-light);
  --meta: var(--meta-light);
  --line: var(--line-light);
  --line-strong: var(--line-strong-light);
  --cta-bg: var(--cta-bg-light);
  --cta-fg: var(--cta-fg-light);
  --cta-hover: var(--cta-hover-light);
  --focus: var(--focus-light);
  --ok-bg: var(--ok-bg-light);
  --ok-fg: var(--ok-fg-light);
  --warn-bg: var(--warn-bg-light);
  --warn-fg: var(--warn-fg-light);
  --step-idle: var(--step-idle-light);
  --step-lit: var(--step-lit-light);
  --shadow-card: var(--shadow-card-light);
  --aura-a: var(--aura-a-light);
  --aura-b: var(--aura-b-light);
  --mascot-shadow: var(--mascot-shadow-light);

  --sp-warm: #fe8b6d;
  --sp-cool: #8f93ff;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);

  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: var(--paper-dark);
    --card: var(--card-dark);
    --tray: var(--tray-dark);
    --ink: var(--ink-dark);
    --ink-soft: var(--ink-soft-dark);
    --meta: var(--meta-dark);
    --line: var(--line-dark);
    --line-strong: var(--line-strong-dark);
    --cta-bg: var(--cta-bg-dark);
    --cta-fg: var(--cta-fg-dark);
    --cta-hover: var(--cta-hover-dark);
    --focus: var(--focus-dark);
    --ok-bg: var(--ok-bg-dark);
    --ok-fg: var(--ok-fg-dark);
    --warn-bg: var(--warn-bg-dark);
    --warn-fg: var(--warn-fg-dark);
    --step-idle: var(--step-idle-dark);
    --step-lit: var(--step-lit-dark);
    --shadow-card: var(--shadow-card-dark);
    --aura-a: var(--aura-a-dark);
    --aura-b: var(--aura-b-dark);
    --mascot-shadow: var(--mascot-shadow-dark);
  }
}

@supports (color: light-dark(white, black)) {
  :root {
    --paper: light-dark(var(--paper-light), var(--paper-dark));
    --card: light-dark(var(--card-light), var(--card-dark));
    --tray: light-dark(var(--tray-light), var(--tray-dark));
    --ink: light-dark(var(--ink-light), var(--ink-dark));
    --ink-soft: light-dark(var(--ink-soft-light), var(--ink-soft-dark));
    --meta: light-dark(var(--meta-light), var(--meta-dark));
    --line: light-dark(var(--line-light), var(--line-dark));
    --line-strong: light-dark(var(--line-strong-light), var(--line-strong-dark));
    --cta-bg: light-dark(var(--cta-bg-light), var(--cta-bg-dark));
    --cta-fg: light-dark(var(--cta-fg-light), var(--cta-fg-dark));
    --cta-hover: light-dark(var(--cta-hover-light), var(--cta-hover-dark));
    --focus: light-dark(var(--focus-light), var(--focus-dark));
    --ok-bg: light-dark(var(--ok-bg-light), var(--ok-bg-dark));
    --ok-fg: light-dark(var(--ok-fg-light), var(--ok-fg-dark));
    --warn-bg: light-dark(var(--warn-bg-light), var(--warn-bg-dark));
    --warn-fg: light-dark(var(--warn-fg-light), var(--warn-fg-dark));
    --step-idle: light-dark(var(--step-idle-light), var(--step-idle-dark));
    --step-lit: light-dark(var(--step-lit-light), var(--step-lit-dark));
    --aura-a: light-dark(var(--aura-a-light), var(--aura-a-dark));
    --aura-b: light-dark(var(--aura-b-light), var(--aura-b-dark));
    --mascot-shadow: light-dark(var(--mascot-shadow-light), var(--mascot-shadow-dark));
  }
}

*, *::before, *::after {
  box-sizing: border-box;
}

html, body {
  min-height: 100%;
  margin: 0;
}

body {
  display: grid;
  place-items: center;
  padding: 24px 16px;
  background-color: var(--paper);
  background-image:
    radial-gradient(520px 360px at 50% 28%, var(--aura-a), transparent 72%),
    radial-gradient(420px 300px at 56% 42%, var(--aura-b), transparent 70%);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.cb-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.cb-shell {
  width: 100%;
  max-width: 444px;
}

.cb-card {
  position: relative;
  border-radius: 24px;
  background: var(--card);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.cb-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 8%, rgba(73, 75, 220, 0.34) 38%, rgba(254, 139, 109, 0.4) 64%, transparent 92%);
  pointer-events: none;
}

html[data-state="fail"] .cb-card::before {
  background: linear-gradient(90deg, transparent 12%, rgba(254, 139, 109, 0.38) 50%, transparent 88%);
}

.cb-top {
  padding: 22px 26px 22px;
  text-align: center;
}

.cb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.cb-origin {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--meta);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.cb-origin-star {
  display: inline-block;
  width: 9px;
  height: 9px;
  background: var(--step-lit);
  clip-path: ${STEP_STAR_CLIP};
}

.cb-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
}

.cb-pill-ok {
  background: var(--ok-bg);
  color: var(--ok-fg);
}

.cb-pill-fail {
  background: var(--warn-bg);
  color: var(--warn-fg);
}

.cb-pill-icon {
  width: 13px;
  height: 13px;
  display: block;
}

.cb-check {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.1;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 20;
  stroke-dashoffset: 0;
}

/* ---- Mascot Stage ---- */
.cb-stage-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: 10px 0 8px;
}

.cb-bubble {
  position: absolute;
  top: -18px;
  z-index: 4;
  max-width: 296px;
  padding: 6px 13px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--cta-bg);
  color: var(--cta-fg);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.16);
  opacity: 0;
  pointer-events: none;
  transform: translateY(6px) scale(0.92);
  transition: opacity 160ms ease-out, transform 220ms var(--ease-out);
}

.cb-bubble.is-visible {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.cb-mascot-btn {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 14px 4px;
  border: 0;
  border-radius: 20px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  transition: scale 160ms var(--ease-out), background-color 160ms ease-out;
}

.cb-mascot-btn:hover {
  background-color: color-mix(in srgb, var(--ink) 3.5%, transparent);
}

.cb-mascot-btn:active {
  scale: 0.96;
}

.cb-mascot-btn:focus-visible,
.cb-btn:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 3px;
}

.cb-hero {
  position: relative;
  width: 164px;
  height: 164px;
}

.cb-react,
.cb-settle {
  width: 100%;
  height: 100%;
}

.cb-char {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
}

#cb-capes,
#cb-hat {
  transform-origin: ${px(CALLBACK_CHARACTER_RIG.hat)};
}

html[data-state="fail"] #cb-capes,
html[data-state="fail"] #cb-hat {
  transform: rotate(-3deg);
}

html[data-state="fail"] #cb-orb-glow {
  opacity: 0.45;
}

#cb-hat-tip,
#cb-orb-halo {
  transform-origin: ${px(CALLBACK_CHARACTER_RIG.hatTip)};
}

#cb-orb,
#cb-orb-glow {
  transform-origin: ${px(CALLBACK_CHARACTER_RIG.orb)};
}

.cb-star {
  transform-box: fill-box;
  transform-origin: 50% 50%;
}

#cb-under {
  transform-origin: ${px(CALLBACK_CHARACTER_RIG.under)};
}

#cb-hand-left {
  transform-origin: ${px(CALLBACK_CHARACTER_RIG.handLeft)};
}

#cb-hand-right {
  transform-origin: ${px(CALLBACK_CHARACTER_RIG.handRight)};
}

#cb-eye-left {
  transform-origin: ${px(CALLBACK_CHARACTER_RIG.eyeLeft)};
}

#cb-eye-right {
  transform-origin: ${px(CALLBACK_CHARACTER_RIG.eyeRight)};
}

#cb-gaze {
  transition: transform 220ms var(--ease-out), opacity 90ms linear;
}

#cb-eyes-happy {
  opacity: 0;
  transition: opacity 90ms linear;
}

.cb-joy #cb-gaze {
  opacity: 0;
}

.cb-joy #cb-eyes-happy {
  opacity: 1;
}

.cb-spark {
  position: absolute;
  width: var(--s);
  height: var(--s);
  margin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
  clip-path: ${STAR_CLIP};
  opacity: 0;
  pointer-events: none;
}

.cb-warm {
  background: var(--sp-warm);
}

.cb-cool {
  background: var(--sp-cool);
}

.cb-sparks-ignite .cb-spark {
  left: ${ORB_ORIGIN_PCT.x}%;
  top: ${ORB_ORIGIN_PCT.y}%;
}

.cb-sparks-cheer .cb-spark {
  left: 50%;
  top: 54%;
}

.cb-floor {
  width: 96px;
  height: 9px;
  margin-top: 2px;
}

.cb-shadow {
  width: 100%;
  height: 100%;
  background: radial-gradient(closest-side, var(--mascot-shadow), transparent);
}

.cb-poke-hint {
  margin-top: 5px;
  color: var(--meta);
  font-size: 11px;
  letter-spacing: 0.02em;
  opacity: 0.72;
  transition: opacity 160ms ease-out, color 160ms ease-out;
}

.cb-mascot-btn:hover .cb-poke-hint,
.cb-mascot-btn:focus-visible .cb-poke-hint {
  opacity: 1;
  color: var(--ink-soft);
}

/* ---- Headline & Copy ---- */
.cb-copy {
  margin-top: 4px;
}

.cb-title {
  margin: 0;
  display: inline-flex;
  align-items: baseline;
  justify-content: center;
  gap: 0.24em;
  font-size: 27px;
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.cb-title-cjk {
  font-family: "Songti SC", "STSong", "Noto Serif CJK SC", Georgia, serif;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.cb-brand {
  display: inline-flex;
  align-items: baseline;
}

.cb-wordmark {
  display: inline-block;
  height: 1.28em;
  width: auto;
  color: var(--ink);
  transform: translateY(0.28em);
  overflow: visible;
}

.cb-letter {
  fill: currentColor;
}

.cb-desc {
  margin: 10px auto 0;
  max-width: 26em;
  color: var(--ink-soft);
  font-size: 14px;
  line-height: 1.6;
}

.cb-reason {
  margin: 14px auto 0;
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--warn-bg);
  color: var(--warn-fg);
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
}

/* ---- Perforated Studio Pass Divider ---- */
.cb-divider {
  position: relative;
  height: 20px;
  display: flex;
  align-items: center;
}

.cb-divider::before,
.cb-divider::after {
  content: "";
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--paper);
  border: 1px solid var(--line);
  transform: translateY(-50%);
}

.cb-divider::before {
  left: -9px;
}

.cb-divider::after {
  right: -9px;
}

.cb-divider-line {
  width: 100%;
  margin: 0 18px;
  border-top: 1px dashed var(--line-strong);
}

/* ---- Bottom Pass Section ---- */
.cb-bottom {
  padding: 6px 26px 24px;
}

.cb-user {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border-radius: 14px;
  background: var(--tray);
}

.cb-avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: linear-gradient(135deg, #494bdc, #7477f7);
  color: #ffffff;
  font-size: 14px;
  font-weight: 650;
}

.cb-user-meta {
  min-width: 0;
  flex: 1;
  text-align: left;
}

.cb-user-name {
  color: var(--ink);
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cb-user-sub {
  color: var(--meta);
  font-size: 12px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cb-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 18px;
}

.cb-step {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 6px;
  border-radius: 10px;
  background: var(--tray);
  color: var(--ink-soft);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}

.cb-step-star {
  flex: none;
  width: 11px;
  height: 11px;
  background: var(--step-lit);
  clip-path: ${STEP_STAR_CLIP};
}

.cb-step-muted {
  background: var(--warn-fg);
}

.cb-retry-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 12px;
  margin-bottom: 18px;
  border-radius: 12px;
  background: var(--tray);
  color: var(--ink-soft);
  font-size: 12.5px;
}

.cb-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.cb-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  height: 42px;
  padding: 0 20px;
  border: 0;
  border-radius: 999px;
  background: var(--cta-bg);
  color: var(--cta-fg);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 150ms ease-out, box-shadow 150ms ease-out, scale 180ms ease-out;
  transition-timing-function: ease-out, ease-out, linear(0, 0.52 18%, 1.06 44%, 0.99 70%, 1);
}

.cb-btn:hover {
  background: var(--cta-hover);
  box-shadow: 0 6px 18px rgba(24, 24, 27, 0.16);
}

.cb-btn:active {
  scale: 0.975;
}

.cb-kbd {
  padding: 2px 6px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--cta-fg) 14%, transparent);
  color: inherit;
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  opacity: 0.86;
}

.cb-close-note {
  margin: 0;
  max-height: 0;
  overflow: hidden;
  color: var(--meta);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  opacity: 0;
  transition: opacity 180ms ease-out, margin-top 180ms ease-out, max-height 180ms ease-out;
}

.cb-close-note.is-shown {
  margin-top: 10px;
  max-height: 48px;
  opacity: 1;
}

/* ---- Motion: opt-in only under prefers-reduced-motion: no-preference ----
 * Base styles above represent the settled final state, and all automatic
 * entrance animations complete inside ~3.3s (< 5s WCAG 2.2.2 threshold). */
@media (prefers-reduced-motion: no-preference) {
  .cb-card {
    animation: cb-card-in 460ms var(--ease-out) both;
  }

  .cb-pill {
    animation: cb-scale-pop 480ms 420ms ease-out both;
    animation-timing-function: linear(0, 0.45 15%, 1.12 36%, 0.97 58%, 1.01 78%, 1);
  }

  .cb-check {
    animation: cb-check-draw 380ms 540ms var(--ease-out) both;
  }

  .cb-bubble.is-visible {
    transition:
      opacity 150ms ease-out,
      transform 420ms cubic-bezier(0.23, 1, 0.32, 1);
    transition-timing-function:
      ease-out,
      linear(0, 0.48 16%, 1.1 36%, 0.98 58%, 1.01 78%, 1);
  }

  html[data-state="ok"] #cb-capes,
  html[data-state="ok"] #cb-hat {
    animation:
      cb-hat-fall 540ms 60ms both,
      cb-hat-settle 1.5s 1500ms ease-in-out 1;
  }

  html[data-state="ok"] #cb-hat-tip,
  html[data-state="ok"] #cb-orb-halo {
    animation:
      cb-tip-whip 920ms 60ms both,
      cb-tip-settle 1.6s 1560ms ease-in-out 1;
  }

  html[data-state="ok"] #cb-orb {
    animation: cb-orb-on 460ms 580ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  html[data-state="ok"] #cb-orb-glow {
    animation: cb-glow-on 620ms 580ms var(--ease-out) both;
  }

  html[data-state="ok"] .cb-star {
    animation: cb-star-on 420ms calc(620ms + var(--n) * 32ms) cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  html[data-state="ok"] #cb-under {
    animation: cb-under-drop 500ms 260ms var(--ease-out) both;
  }

  html[data-state="ok"] #cb-hand-left {
    animation: cb-hand-pop 420ms 480ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }

  html[data-state="ok"] #cb-hand-right {
    animation:
      cb-hand-pop 420ms 530ms cubic-bezier(0.34, 1.56, 0.64, 1) both,
      cb-wave 980ms 1020ms ease-in-out 1;
  }

  html[data-state="ok"] #cb-eye-left,
  html[data-state="ok"] #cb-eye-right {
    animation:
      cb-eye-open 300ms 520ms cubic-bezier(0.34, 1.56, 0.64, 1) both,
      cb-double-blink 1.4s 2150ms linear 1;
  }

  html[data-state="ok"] .cb-settle {
    animation: cb-arrive-joy 760ms 960ms ease-out both;
    animation-timing-function: linear(0, 0.35 12%, 1.08 34%, 0.97 56%, 1.01 76%, 1);
  }

  html[data-state="ok"] .cb-sparks-ignite .cb-spark {
    animation: cb-spark 760ms calc(620ms + var(--d)) var(--ease-out) both;
  }

  html[data-state="ok"] .cb-sparks-cheer .cb-spark {
    animation: cb-spark 820ms calc(1020ms + var(--d)) var(--ease-out) both;
  }

  html[data-state="fail"] .cb-hero {
    animation: cb-gentle-in 480ms 100ms var(--ease-out) both;
  }

  .cb-hop {
    animation: cb-hop 660ms var(--ease-out);
  }

  .cb-wave-once #cb-hand-right {
    animation: cb-wave 860ms ease-in-out 1 !important;
  }

  .cb-cheer-burst .cb-spark {
    animation: cb-spark 800ms calc(40ms + var(--d)) var(--ease-out) both !important;
  }

  .cb-shadow {
    animation: cb-shadow-in 420ms 240ms var(--ease-out) both;
  }

  .cb-letter {
    animation: cb-letter 380ms calc(680ms + var(--i) * 55ms) var(--ease-out) both;
  }

  .cb-desc,
  .cb-reason {
    animation: cb-rise 420ms 880ms var(--ease-out) both;
  }

  .cb-user {
    animation: cb-rise 420ms 960ms var(--ease-out) both;
  }

  .cb-step {
    animation: cb-rise 380ms calc(1040ms + var(--step) * 130ms) var(--ease-out) both;
  }

  .cb-step-star:not(.cb-step-muted) {
    animation: cb-star-lit 500ms calc(1120ms + var(--step) * 140ms) ease-out both;
    animation-timing-function: linear(0, 0.42 15%, 1.24 38%, 0.94 62%, 1.02 82%, 1);
  }

  .cb-actions {
    animation: cb-rise 420ms 1240ms var(--ease-out) both;
  }
}

@keyframes cb-card-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.975);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes cb-scale-pop {
  from {
    scale: 0.78;
  }
  to {
    scale: 1;
  }
}

@keyframes cb-check-draw {
  from {
    stroke-dashoffset: 20;
  }
  to {
    stroke-dashoffset: 0;
  }
}

@keyframes cb-hat-fall {
  0% {
    animation-timing-function: cubic-bezier(0.5, 0, 0.9, 0.6);
    opacity: 0;
    transform: translate(-26px, -240px) rotate(-20deg) scale(1, 1);
  }
  16% {
    opacity: 1;
  }
  60% {
    animation-timing-function: cubic-bezier(0.2, 0.7, 0.3, 1);
    opacity: 1;
    transform: translate(0, 9px) rotate(3deg) scale(1.07, 0.9);
  }
  80% {
    animation-timing-function: cubic-bezier(0.4, 0, 0.4, 1);
    transform: translate(0, -6px) rotate(-1.4deg) scale(0.98, 1.03);
  }
  100% {
    opacity: 1;
    transform: translate(0, 0) rotate(0deg) scale(1, 1);
  }
}

@keyframes cb-hat-settle {
  0%, 100% { transform: rotate(0deg); }
  45% { transform: rotate(1.6deg); }
  75% { transform: rotate(-1deg); }
}

@keyframes cb-tip-whip {
  0% { transform: rotate(-32deg); }
  32% { transform: rotate(-28deg); }
  46% { transform: rotate(22deg); }
  62% { transform: rotate(-11deg); }
  78% { transform: rotate(5deg); }
  92% { transform: rotate(-2deg); }
  100% { transform: rotate(0deg); }
}

@keyframes cb-tip-settle {
  0%, 100% { transform: rotate(0deg); }
  45% { transform: rotate(5deg); }
  78% { transform: rotate(-3deg); }
}

@keyframes cb-orb-on {
  from { transform: scale(0.68); }
  to { transform: scale(1); }
}

@keyframes cb-glow-on {
  0% { opacity: 0; transform: scale(0.3); }
  45% { opacity: 1; transform: scale(1.45); }
  100% { opacity: 1; transform: scale(1); }
}

@keyframes cb-star-on {
  from { opacity: 0.12; transform: scale(0.3) rotate(-40deg); }
  to { opacity: 1; transform: scale(1) rotate(0deg); }
}

@keyframes cb-under-drop {
  0% { opacity: 0; transform: translate(0, -44px) scale(0.72, 0.4); }
  24% { opacity: 1; }
  62% { transform: translate(0, 8px) scale(0.97, 1.06); }
  100% { opacity: 1; transform: translate(0, 0) scale(1, 1); }
}

@keyframes cb-hand-pop {
  from { opacity: 0; transform: scale(0.4); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes cb-wave {
  0%, 100% { transform: translate(0, 0); }
  22% { transform: translate(14px, -50px); }
  38% { transform: translate(26px, -56px); }
  54% { transform: translate(12px, -52px); }
  70% { transform: translate(26px, -56px); }
  84% { transform: translate(12px, -52px); }
}

@keyframes cb-eye-open {
  from { transform: scaleY(0.06); }
  to { transform: scaleY(1); }
}

@keyframes cb-double-blink {
  0%, 18% { transform: scaleY(1); }
  26% { transform: scaleY(0.06); }
  34%, 52% { transform: scaleY(1); }
  60% { transform: scaleY(0.06); }
  70%, 100% { transform: scaleY(1); }
}

@keyframes cb-arrive-joy {
  0% { transform: translate3d(0, 0, 0) scale(1, 1); }
  18% { transform: translate3d(0, 4px, 0) scale(1.05, 0.93); }
  46% { transform: translate3d(0, -22px, 0) scale(0.96, 1.04); }
  76% { transform: translate3d(0, 2px, 0) scale(1.02, 0.98); }
  100% { transform: translate3d(0, 0, 0) scale(1, 1); }
}

@keyframes cb-hop {
  0% { transform: translate3d(0, 0, 0) scale(1, 1); }
  16% { transform: translate3d(0, 5px, 0) scale(1.06, 0.92); }
  46% { transform: translate3d(0, -24px, 0) scale(0.96, 1.05); }
  74% { transform: translate3d(0, 3px, 0) scale(1.02, 0.98); }
  100% { transform: translate3d(0, 0, 0) scale(1, 1); }
}

@keyframes cb-gentle-in {
  from { opacity: 0; transform: translateY(10px) scale(0.95); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes cb-shadow-in {
  from { opacity: 0; transform: scale(0.4); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes cb-spark {
  0% { opacity: 0; transform: translate3d(0, 0, 0) rotate(0deg) scale(0.3); }
  16% { opacity: 1; }
  60% { opacity: 1; }
  100% { opacity: 0; transform: translate3d(var(--dx), var(--dy), 0) rotate(var(--rot)) scale(1); }
}

@keyframes cb-letter {
  0% { fill: var(--sp-warm); opacity: 0; transform: translateY(52px); }
  42% { fill: var(--sp-warm); opacity: 1; }
  100% { fill: currentColor; opacity: 1; transform: translateY(0); }
}

@keyframes cb-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes cb-star-lit {
  0% { scale: 0.4; rotate: -45deg; }
  100% { scale: 1; rotate: 0deg; }
}

@media (max-width: 480px) {
  .cb-top {
    padding: 18px 18px 18px;
  }
  .cb-bottom {
    padding: 6px 18px 20px;
  }
  .cb-hero {
    width: 146px;
    height: 146px;
  }
  .cb-title {
    font-size: 24px;
  }
  .cb-steps {
    gap: 6px;
  }
  .cb-step {
    font-size: 11px;
    padding: 6px 4px;
  }
}
`;

const CALLBACK_SCRIPT = `
(function () {
  var isOk = document.documentElement.getAttribute('data-state') === 'ok';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var sprite = document.getElementById('cb-char');
  var reactBox = document.getElementById('cb-react');
  var cheerBox = document.getElementById('cb-cheer');
  var mascotBtn = document.getElementById('cb-mascot-btn');
  var bubble = document.getElementById('cb-bubble');
  var pokeHint = document.getElementById('cb-poke-hint');
  var gaze = document.getElementById('cb-gaze');
  var closeBtn = document.getElementById('cb-close-btn');
  var closeNote = document.getElementById('cb-close-note');
  var kbd = document.getElementById('cb-kbd');

  // Strip one-time OAuth query params (?code=&state=&iss=) from the address bar cleanly.
  if (window.history && window.history.replaceState && window.location.search) {
    try {
      window.history.replaceState(null, '', window.location.pathname);
    } catch (_) {}
  }

  var isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
  var shortcut = isMac ? '⌘W' : 'Ctrl+W';
  if (kbd) {
    kbd.textContent = shortcut;
    kbd.hidden = false;
  }

  // Arrival happy eyes sync during the entrance celebration hop.
  if (isOk && !reduced && sprite) {
    setTimeout(function () {
      sprite.classList.add('cb-joy');
      setTimeout(function () {
        sprite.classList.remove('cb-joy');
      }, 640);
    }, 980);
  }

  var linesOk = [
    '✦ 灵感已装进星帽，回工作台开干吧！',
    '✦ 帽子上的 12 颗星星都亮啦',
    '✦ 连接稳稳的，随时开始新创作',
    '✦ 祝你今天做出得意之作！'
  ];
  var linesFail = [
    '✦ 回到 Fantay 重新点一次登录就好啦',
    '✦ 我在工作台等你回来重试'
  ];
  var lineIndex = 0;
  var bubbleTimer = 0;
  var joyTimer = 0;

  function restartAnim(node, cls) {
    if (!node || reduced) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  function showBubble(text) {
    if (!bubble) return;
    bubble.textContent = text;
    bubble.classList.add('is-visible');
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () {
      bubble.classList.remove('is-visible');
    }, 2400);
  }

  function triggerCheer(customMessage) {
    var pool = isOk ? linesOk : linesFail;
    var message = customMessage || pool[lineIndex % pool.length];
    if (!customMessage) lineIndex += 1;
    showBubble(message);
    if (pokeHint) pokeHint.style.opacity = '0';
    if (reduced) return;
    restartAnim(reactBox, 'cb-hop');
    if (isOk) restartAnim(cheerBox, 'cb-cheer-burst');
    if (sprite) {
      restartAnim(sprite, 'cb-wave-once');
      sprite.classList.add('cb-joy');
      if (joyTimer) clearTimeout(joyTimer);
      joyTimer = setTimeout(function () {
        sprite.classList.remove('cb-joy');
      }, 620);
    }
  }

  if (mascotBtn) {
    mascotBtn.addEventListener('click', function () {
      triggerCheer();
    });
  }

  // Pointer eye-tracking across the viewport.
  if (gaze && mascotBtn && !reduced) {
    document.addEventListener('mousemove', function (event) {
      var rect = mascotBtn.getBoundingClientRect();
      var dx = event.clientX - (rect.left + rect.width * 0.5);
      var dy = event.clientY - (rect.top + rect.height * 0.62);
      var dist = Math.sqrt(dx * dx + dy * dy) || 1;
      var reach = Math.min(1, dist / 280);
      var tx = ((dx / dist) * reach * 7.5).toFixed(2);
      var ty = ((dy / dist) * reach * 5.2).toFixed(2);
      gaze.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';
    });
    document.documentElement.addEventListener('mouseleave', function () {
      gaze.style.transform = '';
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', function () {
      try {
        window.close();
      } catch (_) {}
      setTimeout(function () {
        if (!window.closed && closeNote) {
          closeNote.textContent =
            (isOk ? 'Fantay 工作台已自动同步登录状态，按 ' : '按 ') +
            shortcut +
            ' 即可关闭此标签页。';
          closeNote.classList.add('is-shown');
          triggerCheer(isOk ? '✦ 工作台见！按 ' + shortcut + ' 就能关掉这页' : '✦ 回到 Fantay 再试一次吧');
        }
      }, 160);
    });
  }
})();
`;

export function renderCallbackPage(ok: boolean, detail: CallbackPageDetail = {}): RenderedCallbackPage {
  const nonce = detail.scriptNonce || randomBytes(16).toString('base64');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:`;

  const rawName = detail.user?.name?.trim() ?? '';
  const rawEmail = detail.user?.email?.trim() ?? '';
  const rawError = detail.error?.trim() ?? '';

  const badgeMarkup = ok
    ? `<span class="cb-pill cb-pill-ok"><svg class="cb-pill-icon" viewBox="0 0 16 16" aria-hidden="true"><path class="cb-check" d="M3.2 8.4 6.5 11.6 12.8 4.8"/></svg>授权已生效</span>`
    : `<span class="cb-pill cb-pill-fail"><svg class="cb-pill-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="currentColor" opacity="0.22"/><circle cx="8" cy="8" r="2.2" fill="currentColor"/></svg>授权未完成</span>`;

  const headlineMarkup = ok
    ? `<h1 class="cb-title"><span class="cb-title-cjk">已登录</span><span class="cb-brand"><span class="cb-sr"> Fantay</span><svg class="cb-wordmark" viewBox="${CALLBACK_WORD_VIEW_BOX}" aria-hidden="true">${WORDMARK_PATHS}</svg></span></h1>
          <p class="cb-desc">请返回 Fantay 工作台，可以关闭此页面。</p>`
    : `<h1 class="cb-title">登录未完成</h1>
          <p class="cb-desc">请返回 Fantay 查看原因并重新登录。</p>
          ${rawError && rawError !== '登录未完成' ? `<div class="cb-reason" role="alert">${escapeHtml(rawError.slice(0, 200))}</div>` : ''}`;

  const userMarkup =
    ok && rawName
      ? `<div class="cb-user">
            <div class="cb-avatar" aria-hidden="true">${escapeHtml(monogramFor(rawName))}</div>
            <div class="cb-user-meta">
              <div class="cb-user-name">${escapeHtml(rawName.slice(0, 80))}</div>
              <div class="cb-user-sub">${escapeHtml((rawEmail || 'TokenToSea 账号已连接').slice(0, 120))}</div>
            </div>
          </div>`
      : '';

  const passMarkup = ok
    ? `${userMarkup}
          <div class="cb-steps" aria-label="授权完成步骤">
            <div class="cb-step" style="--step:0"><i class="cb-step-star" style="--step:0" aria-hidden="true"></i><span>令牌验签</span></div>
            <div class="cb-step" style="--step:1"><i class="cb-step-star" style="--step:1" aria-hidden="true"></i><span>加密落盘</span></div>
            <div class="cb-step" style="--step:2"><i class="cb-step-star" style="--step:2" aria-hidden="true"></i><span>工作台同步</span></div>
          </div>`
    : `<div class="cb-retry-hint">
            <i class="cb-step-star cb-step-muted" aria-hidden="true"></i>
            <span>回到 Fantay 点击「登录」即可重新发起授权</span>
          </div>`;

  const html = `<!doctype html>
<html lang="zh-CN" data-state="${ok ? 'ok' : 'fail'}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${ok ? '已登录 Fantay · TokenToSea' : '登录未完成 · Fantay'}</title>
    <style>${CALLBACK_STYLES}</style>
  </head>
  <body>
    <main class="cb-shell">
      <article class="cb-card">
        <div class="cb-top">
          <div class="cb-head">
            <span class="cb-origin"><i class="cb-origin-star" aria-hidden="true"></i>TOKENTOSEA · OAUTH</span>
            ${badgeMarkup}
          </div>
          <div class="cb-stage-wrap">
            <div class="cb-bubble" id="cb-bubble" role="status" aria-live="polite"></div>
            <button type="button" class="cb-mascot-btn" id="cb-mascot-btn" aria-label="${ok ? '轻点与 Fantay 精灵互动' : '轻点查看重试提示'}">
              <span class="cb-hero">
                <span class="cb-react" id="cb-react"><span class="cb-settle">
                  <svg class="cb-char" id="cb-char" viewBox="${CALLBACK_CHARACTER_VIEW_BOX}" aria-hidden="true">${CHARACTER_INDEXED}</svg>
                </span></span>
                ${ok ? `<span class="cb-sparks-ignite" aria-hidden="true">${renderSparks(IGNITE_SPARKS)}</span>` : ''}
                ${ok ? `<span class="cb-sparks-cheer" id="cb-cheer" aria-hidden="true">${renderSparks(CHEER_SPARKS)}</span>` : ''}
              </span>
              <span class="cb-floor" aria-hidden="true"><span class="cb-shadow"></span></span>
              <span class="cb-poke-hint" id="cb-poke-hint" aria-hidden="true">${ok ? '轻点星帽试试 ✦' : '轻点精灵'}</span>
            </button>
          </div>
          <div class="cb-copy">
            ${headlineMarkup}
          </div>
        </div>
        <div class="cb-divider" aria-hidden="true"><div class="cb-divider-line"></div></div>
        <div class="cb-bottom">
          ${passMarkup}
          <div class="cb-actions">
            <button type="button" class="cb-btn" id="cb-close-btn">
              <span>${ok ? '关闭此页面' : '关闭并返回 Fantay'}</span>
              <kbd class="cb-kbd" id="cb-kbd" hidden></kbd>
            </button>
            <p class="cb-close-note" id="cb-close-note" role="status" aria-live="polite"></p>
          </div>
        </div>
      </article>
    </main>
    <script nonce="${escapeHtml(nonce)}">${CALLBACK_SCRIPT}</script>
  </body>
</html>`;

  return { html, csp };
}
