// Startup splash: the Fantay sprite floats in, and the wait is a small
// performance rather than a logo with a bar under it.
//
// The page is the app's own first surface, empty: the same flat ground the
// home page sits on, nothing behind the character but white (or the dark
// ground). The sprite is a ghost in a cloth hat, so nothing about it lands or
// is stiff. The story, in order: it rises out of the page from the lower left,
// small and clear at first, grinning, its tail streaming and its hat laid back,
// the orb on the hat's tip shedding sparks; it hangs at the top of the rise and
// sinks into place while the hat, the brim and the tail swing through and
// settle; it opens its eyes; it flicks the tip of its hat, and a spark leaves
// the orb and writes the name beneath it while it watches. Then it waits —
// riding the air, cloth and tail never still, blinking, looking about, waving,
// darting aside now and then — and for each boot stage that lands it jumps and
// throws a spark down to light the next star in the row under the name.
//
// Constraints that shape this file:
//   • The splash window is up BEFORE the web sidecar, so there is no HTTP
//     origin. Everything is inlined: no fetch, no font, no image URL. The
//     only references are fragment ones (`#id`) into this same document.
//   • It is plain SVG, CSS keyframes and one small frame loop (see
//     `splash-puppet.ts`): no canvas, no WebGL, nothing to load. The markup
//     and every base style ARE the final frame, so a renderer that cannot
//     animate (or `prefers-reduced-motion`) shows the finished lockup: the
//     keyframes only describe the way in, the loop only runs when motion is
//     allowed, and whatever exists only in passing (sparks, the writing
//     spark) rests at opacity 0.
//   • The hand-off to the app is two windows that must read as one (see
//     `splash-handoff.ts`): this page's exit therefore fades in place and
//     moves nothing, and the ground colour never changes.
//   • The artwork lives in `splash-character.ts` (the sprite) and
//     `splash-wordmark.ts` (the name); `splash-puppet.ts` moves the sprite,
//     this file the rest.

import { CHARACTER_MARKUP, CHARACTER_RIG, CHARACTER_VIEW_BOX } from "./splash-character.js";
import { PUPPET_CAST_MS, PUPPET_SCRIPT } from "./splash-puppet.js";
import { WORD_LETTERS, WORD_VIEW_BOX } from "./splash-wordmark.js";

/** Step/label payload for the status line (`window.__odSplashSetStage`). */
export type SplashStageInfo = { step: number; total: number; label: string };

export type SplashHtmlInput = {
  /** Window background; must match the BrowserWindow `backgroundColor`. */
  background: string;
  /** Dark boot theme: flips ink and the unlit steps. */
  dark: boolean;
  /** BCP-47 language of the status line, stamped on `<html lang>`. */
  lang: string;
  /** Stage shown until the first `__odSplashSetStage` call. */
  stage: SplashStageInfo;
};

// ---- Motion ----
//
// One clock, starting when the document loads. The entrance is over by ~1.96s,
// inside the runtime's minimum splash hold, so even the fastest boot shows the
// whole story once.
//
//      0 ─ 700   the ghost rises from the lower left on a curve, growing and
//                clearing as it comes; tail long, hat laid back, eyes shut in a
//                grin, the orb shedding sparks behind it
//    520 ─ 1000  its shadow gathers on the floor
//    700 ─ 1120  it hangs at the top of the rise and sinks into place; hat, brim
//                and tail swing through and settle
//    760 ─ 1080  eyes open
//    860 ─ 1700  a shimmer runs over the hat's stars
//    980 ─ 1500  the tip flicks: the orb flares and throws sparks
//   1000 ─ 1640  one of them dives from the orb and runs along under the lockup
//   1080 ─ 1980  the ghost watches it go
//   1200 ─ 1955  the name arrives behind it, hot, and cools to ink (75ms per letter)
//   1400 ─       the step stars and the status line rise in
//   2000 ─       waiting: drifting, cloth and tail in the air, blink, look, wave, a dart aside, twinkle
//
// While it waits: `__odSplashSetStage` lights a step star for each boot stage.
// For one that moves forward after the entrance the ghost jumps with its eyes
// shut in a smile and throws a spark from the orb to that star, which lights
// when the spark lands. Its eyes follow the pointer.
//
// Exit (`window.__odSplashExit`, called at hand-off): the page fades in place,
// 150ms. Nothing travels: the app window is about to appear in this same
// rectangle, and anything moving here would read as a second layer.
//
// Who moves what: the frame loop in `splash-puppet.ts` owns where the ghost is
// and how its cloth, tail and hands hang; CSS keyframes own everything that
// keeps its own time (eyes, stars, the orb's light, sparks, the name, the
// steps). Easing follows the app grammar: quint ease-out for entrances, a pop
// only where something lights, ease-in-out only for breathing loops.

const IDLE_START_MS = 2000;
const LETTER_START_MS = 1200;
const LETTER_STAGGER_MS = 75;
const LETTER_RISE_MS = 380;
/** The sprite's box on the page, px. */
const HERO_PX = 288;

const px = (point: readonly [number, number]): string => `${point[0]}px ${point[1]}px`;

/** The orb's resting place in the hero box, as shares of its side: where the writing spark leaves from. */
const ORB_AT = {
  x: CHARACTER_RIG.orb[0] / 512,
  y: CHARACTER_RIG.orb[1] / 512,
};

/** A jump for a boot stage: the spark leaves the orb this long after the jump starts, and flies this long. */
const BOLT_LEAD_MS = 150;
const BOLT_FLIGHT_MS = 440;

type Spark = { dx: number; dy: number; rot: number; size: number; delay: number; warm: boolean };

// Sparks the orb throws when it lights: offset (px), spin (deg), size (px),
// delay (ms), warm or cool.
const IGNITE: readonly Spark[] = [
  { dx: 58, dy: -44, rot: 120, size: 13, delay: 0, warm: true },
  { dx: 84, dy: 8, rot: -90, size: 9, delay: 40, warm: false },
  { dx: 30, dy: -78, rot: 160, size: 10, delay: 20, warm: false },
  { dx: -26, dy: -70, rot: -140, size: 8, delay: 70, warm: true },
  { dx: 66, dy: 52, rot: 100, size: 8, delay: 90, warm: true },
  { dx: 104, dy: -34, rot: -110, size: 7, delay: 110, warm: false },
];

// Sparks around the whole sprite when it jumps for a boot stage.
const CHEER: readonly Spark[] = [
  { dx: -150, dy: -40, rot: -120, size: 12, delay: 0, warm: true },
  { dx: -118, dy: -112, rot: 100, size: 9, delay: 50, warm: false },
  { dx: 142, dy: -96, rot: 140, size: 11, delay: 20, warm: false },
  { dx: 166, dy: -8, rot: -100, size: 9, delay: 70, warm: true },
  { dx: -160, dy: 44, rot: 90, size: 8, delay: 90, warm: false },
  { dx: 150, dy: 60, rot: -150, size: 8, delay: 40, warm: true },
];

// Sparks the orb sheds behind it on the way in. The frame loop places each one
// where the orb is and says which way it drifts; these only vary their look.
const TRAIL: readonly Spark[] = [11, 7, 9, 6, 10, 7, 8, 6, 9, 7, 8, 6].map((size, index) => ({
  dx: 0,
  dy: 0,
  rot: index % 2 === 0 ? 150 : -130,
  size,
  delay: 0,
  warm: index % 3 !== 1,
}));

/** A four-point star cut out of a square: slim for sparks in flight, fuller for the steps, which sit still at 14px. */
const STAR_CLIP = "polygon(50% 0, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0 50%, 39% 39%)";
const STEP_CLIP = "polygon(50% 0, 65% 35%, 100% 50%, 65% 65%, 50% 100%, 35% 65%, 0 50%, 35% 35%)";

const SPLASH_STYLE = `
      :root {
        --sp-ink: #1c1c20;
        --sp-muted: #8a8d96;
        --sp-sheen: #2a2a30;
        --sp-step: rgba(28, 28, 32, 0.15);
        --sp-step-done: #494bdc;
        --sp-warm: #fe8b6d;
        --sp-cool: #8f93ff;
        --sp-shadow: rgba(38, 40, 120, 0.2);
        --sp-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
        --sp-ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1);
      }
      :root[data-theme="dark"] {
        --sp-ink: #f4f4f1;
        --sp-muted: #85858c;
        --sp-sheen: #e9e9e6;
        --sp-step: rgba(255, 255, 255, 0.2);
        --sp-step-done: #8f93ff;
        --sp-shadow: rgba(0, 0, 0, 0.6);
      }
      html,
      body {
        height: 100%;
        margin: 0;
        overflow: hidden;
      }
      body {
        align-items: center;
        cursor: default;
        display: flex;
        justify-content: center;
        user-select: none;
        -webkit-user-select: none;
      }
      /* The app's top chrome is where its window is dragged from; so is this one's. */
      .sp-drag {
        -webkit-app-region: drag;
        height: 44px;
        inset: 0 0 auto 0;
        position: fixed;
      }

      .sp-lockup {
        align-items: center;
        display: flex;
        flex-direction: column;
        position: relative;
        /* Optical centre: the sprite is heavier than what hangs under it. */
        transform: translateY(-16px);
      }

      /* Exit. It lives on body because body carries no keyframe animation — an
         element still held by a filled animation would ignore it. Opacity
         only: see the note on the exit above. The html background stays put. */
      .sp-exit body {
        opacity: 0;
        transition: opacity 150ms var(--sp-ease-out);
      }

      /* ---- The sprite ---- */
      .sp-hero {
        height: ${HERO_PX}px;
        position: relative;
        width: ${HERO_PX}px;
      }
      /* The frame loop places, leans and stretches the whole ghost here, about
         the middle of its face. */
      .sp-react {
        height: 100%;
        transform-origin: 52% 66.4%;
        will-change: transform, opacity;
      }
      /* Motion is on (set in <head>): the frame loop owns the ghost and its
         shadow from its first frame, and until then neither shows. */
      .sp-js .sp-react,
      .sp-js .sp-shadow {
        opacity: 0;
      }
      .sp-char {
        display: block;
        height: 100%;
        overflow: visible;
        width: 100%;
      }

      /* The orb is alight from the start; it flares when the tip flicks. */
      #orb {
        animation: sp-orb-cast 520ms ${PUPPET_CAST_MS}ms var(--sp-ease-pop);
        transform-origin: ${px(CHARACTER_RIG.orb)};
      }
      #orb-glow {
        animation:
          sp-glow-cast 600ms ${PUPPET_CAST_MS - 20}ms var(--sp-ease-out),
          sp-glow-breathe 2.6s ${IDLE_START_MS}ms ease-in-out infinite alternate;
        transform-origin: ${px(CHARACTER_RIG.orb)};
      }
      /* The stars are part of the cloth and ride it; a shimmer runs over them
         as the ghost arrives. */
      .star {
        animation:
          sp-star-on 460ms calc(860ms + var(--n) * 36ms) var(--sp-ease-out),
          sp-twinkle 2.4s calc(${IDLE_START_MS + 100}ms + var(--n) * 370ms) ease-in-out infinite alternate;
        transform-box: fill-box;
        transform-origin: 50% 50%;
      }

      #eye-left {
        transform-origin: ${px(CHARACTER_RIG.eyeLeft)};
      }
      #eye-right {
        transform-origin: ${px(CHARACTER_RIG.eyeRight)};
      }
      #eye-left,
      #eye-right {
        animation:
          sp-eye-open 320ms 760ms var(--sp-ease-pop) both,
          sp-blink 5.6s 2600ms linear infinite;
      }
      /* The pointer leads the outer group (script), the scripted look the
         inner: first down at the name being written, then about. */
      #gaze {
        transition:
          transform 260ms var(--sp-ease-out),
          opacity 90ms linear;
      }
      #look {
        animation:
          sp-look-write 900ms 1080ms ease-in-out both,
          sp-look 9.6s 2700ms ease-in-out infinite;
      }
      /* Pleased: the eyes shut into arcs — on the way in, and for as long as a
         jump lasts. */
      #eyes-happy {
        opacity: 0;
        transition: opacity 90ms linear;
      }
      .sp-joy #gaze {
        opacity: 0;
      }
      .sp-joy #eyes-happy {
        opacity: 1;
      }

      /* Sparks. */
      .sp-spark {
        clip-path: ${STAR_CLIP};
        height: var(--s);
        margin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
        opacity: 0;
        pointer-events: none;
        position: absolute;
        width: var(--s);
      }
      .sp-warm { background: var(--sp-warm); }
      .sp-cool { background: var(--sp-cool); }
      /* Shed behind the orb on the way in (placed and started by the frame loop). */
      .sp-shed {
        animation: sp-shed 640ms var(--sp-ease-out) both;
      }
      /* Thrown when the tip flicks; the frame loop moves this to where the orb is. */
      .sp-ignite {
        left: ${(ORB_AT.x * 100).toFixed(2)}%;
        position: absolute;
        top: ${(ORB_AT.y * 100).toFixed(2)}%;
      }
      .sp-ignite .sp-spark {
        left: 0;
        top: 0;
      }
      .sp-ignite-on .sp-spark {
        animation: sp-spark 780ms var(--d) var(--sp-ease-out) both;
      }
      .sp-cheer .sp-spark {
        left: 50%;
        top: 56%;
      }
      .sp-cheer-on .sp-spark {
        animation: sp-spark 820ms calc(120ms + var(--d)) var(--sp-ease-out) both;
      }

      /* Floor under the hover (the frame loop fades and shrinks it with height). */
      .sp-floor {
        height: 13px;
        margin-top: 2px;
        width: 160px;
      }
      .sp-shadow {
        background: radial-gradient(closest-side, var(--sp-shadow), transparent);
        height: 100%;
        width: 100%;
      }

      /* The spark that writes the name: down from the orb, then along the line.
         Two wrappers so the dive and the run can ease separately. */
      .sp-quill-x,
      .sp-quill-y {
        pointer-events: none;
        position: absolute;
        top: 0;
      }
      .sp-quill-x {
        animation: sp-quill-x 640ms 1000ms both;
        left: 50%;
      }
      .sp-quill-y {
        animation: sp-quill-y 640ms 1000ms both;
        left: 0;
      }
      .sp-quill {
        animation: sp-quill 640ms 1000ms linear both;
        background: var(--sp-warm);
        clip-path: ${STAR_CLIP};
        height: 18px;
        margin: -9px 0 0 -9px;
        opacity: 0;
        width: 18px;
      }

      /* The spark the ghost throws to a step star. Two wrappers again, so going
         across and falling can each keep their own pace. Moved by the script. */
      .sp-bolt-x,
      .sp-bolt-y {
        left: 0;
        pointer-events: none;
        position: absolute;
        top: 0;
      }
      .sp-bolt {
        background: var(--sp-warm);
        clip-path: ${STAR_CLIP};
        height: 16px;
        margin: -8px 0 0 -8px;
        opacity: 0;
        width: 16px;
      }

      /* ---- The name ---- */
      .sp-word {
        display: block;
        height: 64px;
        margin-top: 14px;
        overflow: visible;
        width: auto;
      }
      .sp-letter {
        animation: sp-letter ${LETTER_RISE_MS}ms var(--sp-ease-out) both;
        animation-delay: calc(${LETTER_START_MS}ms + var(--i) * ${LETTER_STAGGER_MS}ms);
        fill: var(--sp-ink);
      }

      /* ---- Status: a row of stars, one per boot stage, and what is happening ---- */
      .sp-boot {
        align-items: center;
        animation: sp-rise 560ms 1400ms var(--sp-ease-out) both;
        display: flex;
        flex-direction: column;
        margin-top: 26px;
        white-space: nowrap;
      }
      .sp-steps {
        display: flex;
        gap: 9px;
      }
      .sp-step {
        background: var(--sp-step);
        clip-path: ${STEP_CLIP};
        height: 14px;
        transition: background-color 240ms var(--sp-ease-out);
        width: 14px;
      }
      .sp-step.is-done {
        animation: sp-step-lit 460ms var(--sp-ease-pop);
        background: var(--sp-step-done);
      }
      /* The stage in hand pops as it is lit and then keeps moving, so a long
         one never looks hung. */
      .sp-step.is-now {
        animation:
          sp-step-lit 460ms var(--sp-ease-pop),
          sp-step-now 900ms 460ms ease-in-out infinite alternate;
        background: var(--sp-warm);
      }
      .sp-stage {
        animation: sp-shimmer 1.8s linear infinite;
        background: linear-gradient(
          90deg,
          var(--sp-muted) 0%,
          var(--sp-muted) 40%,
          var(--sp-sheen) 50%,
          var(--sp-muted) 60%,
          var(--sp-muted) 100%
        );
        background-size: 250% 100%;
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei",
          system-ui, sans-serif;
        font-size: 12px;
        letter-spacing: 0.02em;
        line-height: 16px;
        margin-top: 14px;
        transition:
          opacity 200ms var(--sp-ease-out),
          transform 200ms var(--sp-ease-out);
      }
      .sp-stage-swapping {
        opacity: 0;
        transform: translateY(4px);
        transition-duration: 140ms;
      }

      @keyframes sp-orb-cast {
        0% { transform: scale(1); }
        35% { transform: scale(1.3); }
        100% { transform: scale(1); }
      }
      @keyframes sp-glow-cast {
        0% { transform: scale(1); }
        40% { transform: scale(1.5); }
        100% { transform: scale(1); }
      }
      @keyframes sp-glow-breathe {
        from { opacity: 1; transform: scale(1); }
        to { opacity: 0.55; transform: scale(0.84); }
      }
      @keyframes sp-star-on {
        0% { transform: scale(1) rotate(0deg); }
        40% { transform: scale(1.8) rotate(24deg); }
        100% { transform: scale(1) rotate(0deg); }
      }
      @keyframes sp-twinkle {
        from { opacity: 1; transform: scale(1); }
        to { opacity: 0.42; transform: scale(0.76); }
      }
      @keyframes sp-eye-open {
        from { transform: scaleY(0.06); }
        to { transform: scaleY(1); }
      }
      /* One blink, then a double blink later in the loop. */
      @keyframes sp-blink {
        0%, 4% { transform: scaleY(1); }
        6% { transform: scaleY(0.06); }
        8.6%, 58% { transform: scaleY(1); }
        59.8% { transform: scaleY(0.06); }
        61.8% { transform: scaleY(1); }
        63.6% { transform: scaleY(0.06); }
        66%, 100% { transform: scaleY(1); }
      }
      /* Down at the head of the line, along it with the spark, and back up. */
      @keyframes sp-look-write {
        0% { transform: translate(0px, 0px); }
        22% { transform: translate(-6px, 7px); }
        74% { transform: translate(6px, 8px); }
        100% { transform: translate(0px, 0px); }
      }
      /* Across to one side, up at its own orb, across to the other. */
      @keyframes sp-look {
        0%, 12% { transform: translate(0px, 0px); }
        17%, 30% { transform: translate(-7px, 1px); }
        36%, 44% { transform: translate(0px, 0px); }
        49%, 58% { transform: translate(6px, -6px); }
        64%, 84% { transform: translate(0px, 0px); }
        89%, 95% { transform: translate(7px, 2px); }
        100% { transform: translate(0px, 0px); }
      }
      @keyframes sp-shed {
        0% { opacity: 0.95; transform: translate3d(0, 0, 0) rotate(0deg) scale(1); }
        100% { opacity: 0; transform: translate3d(var(--dx), var(--dy), 0) rotate(var(--rot)) scale(0.2); }
      }
      @keyframes sp-spark {
        0% { opacity: 0; transform: translate3d(0, 0, 0) rotate(0deg) scale(0.3); }
        14% { opacity: 1; }
        58% { opacity: 1; }
        100% { opacity: 0; transform: translate3d(var(--dx), var(--dy), 0) rotate(var(--rot)) scale(1); }
      }
      /* From the orb, down and across to the head of the line, then along it. */
      @keyframes sp-quill-x {
        0% { animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1); transform: translateX(${((ORB_AT.x - 0.5) * HERO_PX).toFixed(1)}px); }
        30% { animation-timing-function: cubic-bezier(0.3, 0.2, 0.4, 1); transform: translateX(-92px); }
        100% { transform: translateX(96px); }
      }
      @keyframes sp-quill-y {
        0% { animation-timing-function: cubic-bezier(0.5, 0, 0.7, 0.6); transform: translateY(${(ORB_AT.y * HERO_PX).toFixed(1)}px); }
        30% { transform: translateY(${HERO_PX + 60}px); }
        100% { transform: translateY(${HERO_PX + 60}px); }
      }
      @keyframes sp-quill {
        0% { opacity: 0; transform: rotate(0deg) scale(0.5); }
        10% { opacity: 1; transform: rotate(50deg) scale(1); }
        84% { opacity: 1; transform: rotate(420deg) scale(1); }
        100% { opacity: 0; transform: rotate(500deg) scale(0.3); }
      }
      /* Arrives hot from the spark and cools to ink. */
      @keyframes sp-letter {
        0% { fill: var(--sp-warm); opacity: 0; transform: translateY(70px); }
        40% { fill: var(--sp-warm); opacity: 1; }
        100% { fill: var(--sp-ink); opacity: 1; transform: translateY(0px); }
      }
      @keyframes sp-rise {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0px); }
      }
      @keyframes sp-step-lit {
        0% { transform: scale(0.5) rotate(-45deg); }
        60% { transform: scale(1.5) rotate(8deg); }
        100% { transform: scale(1) rotate(0deg); }
      }
      @keyframes sp-step-now {
        from { opacity: 0.55; transform: scale(0.8); }
        to { opacity: 1; transform: scale(1.18); }
      }
      @keyframes sp-shimmer {
        from { background-position: 100% 0; }
        to { background-position: 0% 0; }
      }

      /* Every base style above is the finished frame, so dropping the
         animations leaves the complete lockup and a still status line. */
      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          animation: none !important;
          transition: none !important;
        }
      }
`;

function sparkMarkup(spark: Spark): string {
  return `<i class="sp-spark ${spark.warm ? "sp-warm" : "sp-cool"}" style="--dx: ${spark.dx}px; --dy: ${spark.dy}px; --rot: ${spark.rot}deg; --s: ${spark.size}px; --d: ${spark.delay}ms"></i>`;
}

/** Numbers the hat's stars so each can come on, and twinkle, at its own moment. */
function indexStars(markup: string): string {
  let index = 0;
  return markup.replace(/class="star"/g, () => `class="star" style="--n: ${index++}"`);
}

function stepsMarkup(step: number, total: number): string {
  let out = "";
  for (let index = 1; index <= total; index += 1) {
    const state = index < step || (index === step && step === total) ? " is-done" : index === step ? " is-now" : "";
    out += `<i class="sp-step${state}"></i>`;
  }
  return out;
}

const WORD_MARKUP = WORD_LETTERS.map(
  (d, index) => `<path class="sp-letter" style="--i: ${index}" d="${d}"/>`,
).join("\n        ");

const SPLASH_MARKUP = `
    <div class="sp-drag" aria-hidden="true"></div>
    <div class="sp-lockup">
      <div class="sp-hero" id="splash-logo" role="img" aria-label="Fantay">
        <div class="sp-react" id="sp-react">
          <svg class="sp-char" id="sp-char" viewBox="${CHARACTER_VIEW_BOX}" aria-hidden="true">${indexStars(CHARACTER_MARKUP)}
          </svg>
        </div>
        <div class="sp-trail" id="sp-trail" aria-hidden="true">${TRAIL.map(sparkMarkup).join("")}</div>
        <div class="sp-ignite" id="sp-ignite" aria-hidden="true">${IGNITE.map(sparkMarkup).join("")}</div>
        <div class="sp-cheer" id="sp-cheer" aria-hidden="true">${CHEER.map(sparkMarkup).join("")}</div>
      </div>
      <div class="sp-floor" aria-hidden="true"><div class="sp-shadow" id="sp-shadow"></div></div>
      <svg class="sp-word" viewBox="${WORD_VIEW_BOX}" aria-hidden="true">
        ${WORD_MARKUP}
      </svg>
      <div class="sp-boot">
        <div class="sp-steps" id="boot-steps" data-step="__STEP__" aria-hidden="true">__STEPS__</div>
        <div class="sp-stage" id="boot-stage" aria-live="polite"><span id="boot-stage-text">__LABEL__</span></div>
      </div>
      <div class="sp-quill-x" aria-hidden="true"><div class="sp-quill-y"><div class="sp-quill"></div></div></div>
      <div class="sp-bolt-x" id="sp-bolt-x" aria-hidden="true"><div class="sp-bolt-y" id="sp-bolt-y"><div class="sp-bolt" id="sp-bolt"></div></div></div>
    </div>
`;

// Set in <head>, before anything is drawn: with motion allowed the ghost starts
// out of sight and the frame loop brings it in; without it the markup shows as
// it is, the finished lockup.
const SPLASH_HEAD_SCRIPT = `
      if (!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
        document.documentElement.classList.add("sp-js");
      }
`;

// Vanilla ES5 on purpose: it runs in a sandboxed `data:` document with no
// bundler. Accepts the structured { step, total, label } payload and tolerates
// a bare label string. The row only ever fills, so a re-asserted earlier stage
// cannot unlight a star — and only a stage that moves it forward, after the
// entrance has played, earns a jump and a thrown spark. The row then waits for
// that spark to land before it changes; `data-step` is always the truth, and
// painting reads it, so a late paint can only ever show the newest stage.
const SPLASH_SCRIPT = `
      var spLoadedAt = Date.now();
      var spCheerAt = 0;
      var spPaintAt = 0;
      function spRestart(node, name) {
        if (!node) return;
        node.classList.remove(name);
        void node.offsetWidth;
        node.classList.add(name);
      }
      // A spark from the orb, wherever the ghost has drifted to, down to a step star.
      function spThrow(target) {
        var orb = document.getElementById("orb");
        var across = document.getElementById("sp-bolt-x");
        var down = document.getElementById("sp-bolt-y");
        var bolt = document.getElementById("sp-bolt");
        if (!orb || !across || !down || !bolt || !target || !bolt.animate) return;
        var o = across.parentNode.getBoundingClientRect();
        var a = orb.getBoundingClientRect();
        var b = target.getBoundingClientRect();
        var x0 = a.left + a.width / 2 - o.left, y0 = a.top + a.height / 2 - o.top;
        var x1 = b.left + b.width / 2 - o.left, y1 = b.top + b.height / 2 - o.top;
        // Out past the ghost's side first, then down and in under it.
        across.animate(
          [
            { transform: "translateX(" + x0 + "px)", easing: "cubic-bezier(0.2, 0.6, 0.4, 1)" },
            { transform: "translateX(" + (x0 + 70) + "px)", offset: 0.4, easing: "cubic-bezier(0.5, 0, 0.8, 0.6)" },
            { transform: "translateX(" + x1 + "px)" }
          ],
          { duration: ${BOLT_FLIGHT_MS} }
        );
        down.animate(
          [{ transform: "translateY(" + y0 + "px)" }, { transform: "translateY(" + y1 + "px)" }],
          { duration: ${BOLT_FLIGHT_MS}, easing: "cubic-bezier(0.55, 0, 0.85, 0.6)" }
        );
        bolt.animate(
          [
            { opacity: 0, transform: "rotate(0deg) scale(0.4)" },
            { opacity: 1, transform: "rotate(60deg) scale(1)", offset: 0.15 },
            { opacity: 1, transform: "rotate(300deg) scale(1)", offset: 0.86 },
            { opacity: 0, transform: "rotate(360deg) scale(1.9)" }
          ],
          { duration: ${BOLT_FLIGHT_MS} }
        );
      }
      // True when the ghost jumped and threw a spark at the target.
      function spCheer(target) {
        var now = Date.now();
        if (now - spLoadedAt < ${IDLE_START_MS} || now - spCheerAt < 900) return false;
        spCheerAt = now;
        var sprite = document.getElementById("sp-char");
        spRestart(document.getElementById("sp-cheer"), "sp-cheer-on");
        if (sprite) {
          sprite.classList.add("sp-joy");
          setTimeout(function () { sprite.classList.remove("sp-joy"); }, 620);
        }
        if (typeof window.__spHop !== "function") return false;
        window.__spHop();
        setTimeout(function () { spThrow(target); }, ${BOLT_LEAD_MS});
        return true;
      }
      function spPaintSteps() {
        var row = document.getElementById("boot-steps");
        if (!row) return;
        var step = parseInt(row.getAttribute("data-step"), 10) || 0;
        var total = row.children.length;
        for (var i = 0; i < total; i += 1) {
          var at = i + 1;
          var state = (at < step || (at === step && step === total)) ? "sp-step is-done"
            : (at === step ? "sp-step is-now" : "sp-step");
          if (row.children[i].className !== state) row.children[i].className = state;
        }
      }
      function spSetSteps(step, total) {
        var row = document.getElementById("boot-steps");
        if (!row) return;
        var prev = parseInt(row.getAttribute("data-step"), 10) || 0;
        if (step < prev) return;
        while (row.children.length < total) row.appendChild(document.createElement("i"));
        row.setAttribute("data-step", String(step));
        if (step > prev && spCheer(row.children[step - 1])) {
          spPaintAt = Date.now() + ${BOLT_LEAD_MS + BOLT_FLIGHT_MS};
          setTimeout(spPaintSteps, ${BOLT_LEAD_MS + BOLT_FLIGHT_MS});
        } else if (Date.now() >= spPaintAt) {
          spPaintSteps();
        }
      }
      window.__odSplashSetStage = function (info) {
        var data = (typeof info === "string") ? { label: info } : (info || {});
        var wrap = document.getElementById("boot-stage");
        var text = document.getElementById("boot-stage-text");
        if (!wrap || !text) return;
        var step = (typeof data.step === "number") ? data.step : null;
        var total = (typeof data.total === "number" && data.total > 0) ? data.total : null;
        if (step != null && total != null) spSetSteps(Math.max(0, Math.min(total, Math.round(step))), total);
        var label = (typeof data.label === "string") ? data.label : null;
        if (label == null || text.textContent === label) return;
        wrap.classList.add("sp-stage-swapping");
        setTimeout(function () {
          text.textContent = label;
          wrap.classList.remove("sp-stage-swapping");
        }, 140);
      };
      window.__odSplashExit = function () {
        document.documentElement.classList.add("sp-exit");
      };
      // The eyes follow the pointer: up to 7 x 5 artwork units, reached 320px out.
      (function () {
        var gaze = document.getElementById("gaze");
        var hero = document.getElementById("splash-logo");
        if (!gaze || !hero || !window.matchMedia) return;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        document.addEventListener("mousemove", function (event) {
          var box = hero.getBoundingClientRect();
          var dx = event.clientX - (box.left + box.width * 0.5);
          var dy = event.clientY - (box.top + box.height * 0.68);
          var far = Math.sqrt(dx * dx + dy * dy) || 1;
          var reach = Math.min(1, far / 320);
          gaze.style.transform =
            "translate(" + ((dx / far) * reach * 7).toFixed(2) + "px, " + ((dy / far) * reach * 5).toFixed(2) + "px)";
        });
        document.documentElement.addEventListener("mouseleave", function () {
          gaze.style.transform = "";
        });
      })();
${PUPPET_SCRIPT}`;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The complete splash document. The caller wraps it in a `data:` URL. */
export function createSplashHtml(input: SplashHtmlInput): string {
  const total = input.stage.total > 0 ? Math.round(input.stage.total) : 1;
  const step = Math.max(0, Math.min(total, Math.round(input.stage.step)));
  const markup = SPLASH_MARKUP.replace("__STEP__", String(step))
    .replace("__STEPS__", stepsMarkup(step, total))
    .replace("__LABEL__", escapeHtml(input.stage.label));
  return `<!doctype html>
<html lang="${escapeHtml(input.lang)}" data-theme="${input.dark ? "dark" : "light"}">
  <head>
    <meta charset="utf-8" />
    <title>Fantay</title>
    <style>
      html,
      body {
        background: ${input.background};
      }
${SPLASH_STYLE}
    </style>
    <script>
${SPLASH_HEAD_SCRIPT}
    </script>
  </head>
  <body>
${markup}
    <script>
${SPLASH_SCRIPT}
    </script>
  </body>
</html>`;
}
