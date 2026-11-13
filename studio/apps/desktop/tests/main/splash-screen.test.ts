// The splash is the first thing a launch shows, and it has to do it with
// everything inlined: the window is up BEFORE the web sidecar, so there is no
// origin to fetch a script, font or image from. These specs pin the properties
// that break silently — a stray external reference, artwork that drifted from
// the brand file, a sprite that is turned as rigid pieces again (it is a ghost
// in a cloth hat: the drawing itself bends), an entrance that outlasts the
// minimum hold, a document that only looks right while its motion runs, or an
// exit that moves (the app window appears in the same rectangle, so anything
// travelling reads as a second layer).

import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { CHARACTER_MARKUP, CHARACTER_VIEW_BOX } from '../../src/main/splash-character.js';
import { PUPPET_CAST_MS, PUPPET_FLY_MS, PUPPET_SETTLE_MS } from '../../src/main/splash-puppet.js';
import { createSplashHtml } from '../../src/main/splash-screen.js';

const stage = { step: 2, total: 7, label: 'Starting the local engine' };
const light = createSplashHtml({ background: '#ffffff', dark: false, lang: 'en', stage });
const dark = createSplashHtml({ background: '#181818', dark: true, lang: 'zh-CN', stage });
const publicSprite = readFileSync(new URL('../../../web/public/fantay-sprite.svg', import.meta.url), 'utf8');

/** Every drawn shape, in order: path data and the geometry of circles and ellipses. */
function shapes(source: string): string[] {
  return [...source.matchAll(/<(path|circle|ellipse)\b[^>]*>/g)].map((match) => {
    const tag = match[0];
    const pick = (name: string) => tag.match(new RegExp(`\\s${name}="([^"]+)"`))?.[1] ?? '';
    return match[1] === 'path' ? `path ${pick('d')}` : `${match[1]} ${pick('cx')} ${pick('cy')} ${pick('r')}${pick('rx')} ${pick('ry')}`;
  });
}

/** The splash adds one thing the still drawing does not have: the arcs its eyes become when it is pleased. */
function withoutHappyEyes(markup: string): string {
  return markup.replace(/<g id="eyes-happy"[\s\S]*?<\/g>/, '');
}

/** The markup of one `<g id>` (or `<clipPath id>`), nested groups included. */
function group(markup: string, id: string): string {
  const open = markup.search(new RegExp(`<(?:g|clipPath) id="${id}"`));
  if (open < 0) return '';
  let depth = 0;
  for (const tag of markup.slice(open).matchAll(/<(\/?)(?:g|clipPath)\b[^>]*>/g)) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return markup.slice(open, open + (tag.index ?? 0) + tag[0].length);
  }
  return '';
}

describe('startup splash', () => {
  test('inlines everything (no origin exists yet at splash time)', () => {
    expect(light).not.toMatch(/fetch\(|import\(|<link|<img|<video|<canvas/);
    // Fragment references into this same document are the only ones allowed.
    expect(light).not.toMatch(/url\((?!#)/);
    expect(light).not.toMatch(/(?:src|href)\s*=\s*"(?!#)/);
    expect(light).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  test('draws the Fantay sprite exactly as the brand file does', () => {
    expect(publicSprite).toContain(`viewBox="${CHARACTER_VIEW_BOX}"`);
    expect(shapes(withoutHappyEyes(CHARACTER_MARKUP))).toEqual(shapes(publicSprite));
    expect(light).toContain('role="img" aria-label="Fantay"');
  });

  test('keeps the grouping the motion is written against', () => {
    for (const id of ['capes', 'under', 'body', 'hand-left', 'hand-right', 'face', 'gaze', 'look', 'eye-left', 'eye-right', 'eyes-happy', 'hat', 'hat-body', 'hat-light', 'hat-glint', 'stars', 'hat-tip', 'orb-halo', 'orb-glow', 'orb', 'fs-clip-hat', 'fs-clip-body']) {
      expect(light).toContain(`id="${id}"`);
    }
    // Each star on the hat is numbered so it can come on at its own moment.
    const stars = light.match(/class="star" style="--n: \d+"/g) ?? [];
    expect(stars.length).toBeGreaterThanOrEqual(3);
    expect(light).not.toMatch(/class="star"(?! style="--n:)/);
    // The name: six letters, one path each.
    expect(light.match(/class="sp-letter"/g)).toHaveLength(6);
  });

  test('follows the boot theme', () => {
    expect(light).toContain('<html lang="en" data-theme="light">');
    expect(light).toContain('background: #ffffff;');
    expect(dark).toContain('<html lang="zh-CN" data-theme="dark">');
    expect(dark).toContain('background: #181818;');
  });

  test('moves the sprite as a soft body, not as rigid pieces', () => {
    // The frame loop bends the drawing: every path of the cloth and the body
    // is rewritten point by point, so those paths must stay absolute M/C/Z.
    expect(light).toContain('load("#fs-clip-hat path, #hat-body path, #hat-light path, #stars path, #capes path")');
    expect(light).toContain('load("#fs-clip-body path, #body path")');
    const bent = ['fs-clip-hat', 'fs-clip-body', 'capes', 'body', 'hat-body', 'hat-light', 'stars'].flatMap((id) =>
      [...group(CHARACTER_MARKUP, id).matchAll(/\sd="([^"]+)"/g)].map((path) => path[1] ?? ''),
    );
    expect(bent.length).toBeGreaterThanOrEqual(22);
    for (const d of bent) expect(d).toMatch(/^[MCZ0-9.\s-]+$/);
    // No CSS turns the hat, its tip, the body or the hands any more.
    for (const rigid of ['sp-hat-fall', 'sp-hat-sway', 'sp-tip-whip', 'sp-under-drop', 'sp-hand-pop', 'sp-bob', 'sp-hop']) {
      expect(light).not.toContain(rigid);
    }
    expect(light).not.toMatch(/#(?:hat|capes|under|hat-tip|hand-left|hand-right)[\s,{][^}]*\{?[^}]*(?:animation|transform-origin)/);
  });

  test('keeps living after the entrance instead of freezing on a frame', () => {
    // A boot runs from ~2s to a cold minute. The frame loop never ends, and
    // these keep their own time beside it.
    expect(light).toContain('window.requestAnimationFrame(frame);');
    for (const loop of ['sp-glow-breathe', 'sp-twinkle', 'sp-blink', 'sp-look', 'sp-step-now', 'sp-shimmer']) {
      expect(light).toMatch(new RegExp(`${loop} [^;]*infinite`));
    }
  });

  test('finishes the entrance inside the 2000ms minimum hold', () => {
    // Last letter: 1200ms + 5 × 75ms delay + 380ms rise = 1955ms.
    expect(light).toContain('animation: sp-letter 380ms');
    expect(light).toContain('animation-delay: calc(1200ms + var(--i) * 75ms);');
    // The ghost is in place before the spark leaves its orb to write the name.
    expect(PUPPET_FLY_MS + PUPPET_SETTLE_MS).toBeLessThan(1200);
    expect(PUPPET_CAST_MS).toBeGreaterThan(PUPPET_FLY_MS);
    expect(PUPPET_CAST_MS).toBeLessThanOrEqual(1000);
    expect(light).toContain('animation: sp-quill 640ms 1000ms');
  });

  test('shows boot progress as one star per stage and reacts to it', () => {
    // Stage 2 of 7: one lit, one in hand, five to come.
    expect(light).toContain(
      '<div class="sp-steps" id="boot-steps" data-step="2" aria-hidden="true">' +
        '<i class="sp-step is-done"></i><i class="sp-step is-now"></i>' +
        '<i class="sp-step"></i>'.repeat(5) +
        '</div>',
    );
    const last = createSplashHtml({ background: '#ffffff', dark: false, lang: 'en', stage: { step: 7, total: 7, label: 'x' } });
    expect(last.match(/class="sp-step is-done"/g)).toHaveLength(7);
    // Only a stage that moves the row forward, after the entrance, earns a
    // jump and a thrown spark; the row then waits for the spark to land.
    expect(light).toContain('if (step < prev) return;');
    expect(light).toContain('if (step > prev && spCheer(row.children[step - 1])) {');
    expect(light).toContain('now - spLoadedAt < 2000');
    expect(light).toContain('setTimeout(spPaintSteps, 590);');
    // And the eyes follow the pointer.
    expect(light).toContain('document.addEventListener("mousemove"');
  });

  test('shows the finished lockup when motion is off', () => {
    // The markup and base styles are the final frame; keyframes only describe
    // the way in, and the frame loop only takes the ghost when motion is on.
    expect(light).toContain('@media (prefers-reduced-motion: reduce)');
    expect(light).toContain('animation: none !important;');
    expect(light).toMatch(/prefers-reduced-motion: reduce\)"\)\.matches\)\) \{\s*document\.documentElement\.classList\.add\("sp-js"\);/);
    expect(light).toContain('if (!root.classList.contains("sp-js")) return;');
    expect(light).toMatch(/\.sp-js \.sp-react,\s*\.sp-js \.sp-shadow \{\s*opacity: 0;/);
    expect(light).not.toMatch(/<html[^>]*class=/);
    // What exists only in passing must rest invisible, or the still frame
    // would keep the sparks — and a smile over the open eyes — on screen.
    expect(light).toMatch(/\.sp-spark \{[^}]*opacity: 0;/);
    expect(light).toMatch(/\.sp-quill \{[^}]*opacity: 0;/);
    expect(light).toMatch(/\.sp-bolt \{[^}]*opacity: 0;/);
    expect(light).toMatch(/#eyes-happy \{[^}]*opacity: 0;/);
  });

  test('exits by fading in place', () => {
    // A filled animation outranks a class rule, so the exit sits on body, which
    // may never gain an `animation` of its own.
    expect(light).toContain('window.__odSplashExit = function ()');
    expect(light).toMatch(/\.sp-exit body \{\s*opacity: 0;/);
    expect(light).not.toMatch(/\n {6}body \{[^}]*animation/);
    // Nothing travels on the way out.
    expect(light).not.toMatch(/\.sp-exit [^{]*\{[^}]*transform/);
  });

  test('can be dragged by its top edge, like the app window it stands in for', () => {
    expect(light).toMatch(/\.sp-drag \{\s*-webkit-app-region: drag;/);
  });

  test('seeds the status line and keeps the stage setter contract', () => {
    expect(light).toContain('<span id="boot-stage-text">Starting the local engine</span>');
    expect(light).toContain('window.__odSplashSetStage = function (info)');
    const escaped = createSplashHtml({
      background: '#ffffff',
      dark: false,
      lang: 'en',
      stage: { step: 1, total: 7, label: '<b>&"' },
    });
    expect(escaped).toContain('<span id="boot-stage-text">&lt;b&gt;&amp;&quot;</span>');
  });
});
