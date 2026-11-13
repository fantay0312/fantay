// SPDX-License-Identifier: AGPL-3.0-only
// The mascot's eyes, and with them its mind. The body is languid and carried by air; everything quick in it is here, so
// it can be alert without ever gaining weight. Eyes do not glide: they jump to a place and rest on it. A blink lands on a
// change of attention more often than not, at no fixed interval. While working it reads: fixations step along a line,
// then one long sweep back. Pure numbers, so it can be stepped without a page.

/** How far the eyes travel in the artwork's units. Up is shorter: there is less sheet above them than below. */
const REACH = { x: 60, up: 42, down: 42 } as const;
/** The small cut's eyes are larger and sit higher, so looking up would take them over the edge. */
const SMALL_UP = 0.5;
const EYE_RATE = 44;
/** Shortest wait between two saccades chasing a pointer. */
const PURSUIT_GAP = 0.11;
/** How far the pointer has to stray from where the eyes rest before they jump after it, in reach. */
const PURSUIT_ERROR = 0.2;
/** Share of the saccades, once a blink is due, that a blink lands on. */
const BLINK_ON_SHIFT = 0.42;
/** Seconds that must pass between blinks: reading and watching something, it blinks far less than at rest. */
const BLINK_LEAST = { rest: 1.6, reading: 3.6, pursuit: 4 } as const;
/** Seconds between the two closes of a double blink. */
const BLINK_APART = 0.1;
/** How much of its height a shut eye keeps, so a blink stays a short dash and never becomes a hairline. */
const SHUT = { master: 0.2, small: 0.3 } as const;
/** How much wider a shut eye grows. Half-shut ovals otherwise read as dots. */
const SHUT_WIDEN = 0.22;

const READ_Y = 0.42;
/** The sweep back is a natural place to blink, but not every line. */
const READ_BLINK = 0.34;

export const BLINK_ONE = 1;
export const BLINK_TWO = 2;
export const BLINK_SLOW = 3;

export interface GazeInput {
  /** Which way the pointer lies from the body, in reach, and whether to look there: 0 not at all. */
  lookX: number;
  lookY: number;
  look: number;
}

interface Eye {
  value: number;
  speed: number;
}

export interface Gaze {
  random: () => number;
  small: boolean;
  /** Where the eyes are resting, in reach, -1 to 1. */
  aimX: number;
  aimY: number;
  x: Eye;
  y: Eye;
  sinceSaccade: number;
  sinceBlink: number;
  /** Seconds into a blink, negative when there is none; which kind; whether a second one follows. */
  blinkAge: number;
  blinkKind: number;
  blinkAgain: boolean;
  wide: number;
  /** Reading: seconds left on this fixation, the step along this line, how many it has, and how many lines to a thought. */
  dwell: number;
  step: number;
  steps: number;
  lineY: number;
  linesLeft: number;
  /** Raised for the body, which takes them down. */
  lineEnded: boolean;
  thought: boolean;
  // What the frame draws.
  drawX: number;
  drawY: number;
  /** Multiply an eye's two radii by these. */
  drawHeight: number;
  drawWidth: number;
}

export function createGaze(random: () => number, small: boolean): Gaze {
  return {
    random,
    small,
    aimX: 0,
    aimY: 0,
    x: { value: 0, speed: 0 },
    y: { value: 0, speed: 0 },
    sinceSaccade: 0,
    sinceBlink: random() * 1.5,
    blinkAge: -1,
    blinkKind: BLINK_ONE,
    blinkAgain: false,
    wide: 1,
    dwell: 0.4,
    step: 0,
    steps: 4,
    lineY: 0,
    linesLeft: 3,
    lineEnded: false,
    thought: false,
    drawX: 0,
    drawY: 0,
    drawHeight: 1,
    drawWidth: 1,
  };
}

function between(g: Gaze, low: number, high: number): number {
  return low + g.random() * (high - low);
}

export function blink(g: Gaze, kind: number): void {
  if (g.blinkAge >= 0) return;
  g.blinkAge = 0;
  g.blinkKind = kind;
  g.blinkAgain = kind === BLINK_TWO;
  g.sinceBlink = 0;
}

/** Jumps the eyes somewhere. A blink lands on the change more often than not, if it has been at least `least` seconds. */
export function saccade(g: Gaze, x: number, y: number, least: number = BLINK_LEAST.rest): void {
  g.aimX = x;
  g.aimY = y;
  g.sinceSaccade = 0;
  if (g.sinceBlink > least && g.random() < BLINK_ON_SHIFT) blink(g, g.random() < 0.2 ? BLINK_TWO : BLINK_ONE);
}

/** Eyes open wider for a moment: something caught it. */
export function widen(g: Gaze, amount: number): void {
  g.wide = amount;
}

/** Eyelid over one blink, 1 open. Quick to shut, slower to open. */
function lidOf(time: number, kind: number): number {
  const slow = kind === BLINK_SLOW;
  const close = slow ? 0.17 : 0.06;
  const hold = slow ? 0.14 : 0.03;
  const open = slow ? 0.36 : 0.13;
  if (time < close) return 1 - time / close;
  if (time < close + hold) return 0;
  const t = (time - close - hold) / open;
  return t >= 1 ? 1 : t * t * (3 - 2 * t);
}

function stepBlink(g: Gaze, dt: number, working: boolean, pace: number): void {
  g.sinceBlink += dt;
  // Between the two closes of a double blink the age counts up to 0. -1 means no blink at all.
  if (g.blinkAge < 0 && g.blinkAge > -1) {
    g.blinkAge = Math.min(0, g.blinkAge + dt);
    if (g.blinkAge < 0) return;
  }
  if (g.blinkAge < 0) {
    const least = working ? 3.6 : 2;
    const rate = (working ? 0.1 : 0.24) * pace;
    if (g.sinceBlink > least && g.random() < rate * dt) blink(g, g.random() < 0.2 ? BLINK_TWO : BLINK_ONE);
    return;
  }
  g.blinkAge += dt;
  const slow = g.blinkKind === BLINK_SLOW;
  if (g.blinkAge >= (slow ? 0.67 : 0.22)) {
    g.blinkAge = -1;
    if (g.blinkAgain) {
      g.blinkAgain = false;
      g.blinkAge = -BLINK_APART;
      g.blinkKind = BLINK_ONE;
    }
  }
}

/** Reading: fixations stepping along a line, then the long sweep back. Every so often it stops to think. */
function read(g: Gaze, dt: number): void {
  g.dwell -= dt;
  if (g.dwell > 0) return;
  g.step += 1;
  if (g.step <= g.steps) {
    saccade(g, -0.78 + (1.6 * g.step) / g.steps + between(g, -0.05, 0.05), READ_Y + g.lineY + between(g, -0.05, 0.05), BLINK_LEAST.reading);
    g.dwell = between(g, 0.3, 0.68);
    return;
  }
  g.step = 0;
  g.steps = 3 + Math.floor(g.random() * 2);
  g.lineY = between(g, -0.12, 0.12);
  g.linesLeft -= 1;
  if (g.linesLeft <= 0) {
    g.linesLeft = 2 + Math.floor(g.random() * 4);
    g.thought = true;
    saccade(g, between(g, -0.45, 0.45), -0.7, BLINK_LEAST.reading);
    g.dwell = between(g, 0.9, 1.5);
    return;
  }
  g.lineEnded = true;
  g.aimX = -0.86;
  g.aimY = READ_Y + g.lineY;
  g.sinceSaccade = 0;
  if (g.sinceBlink > BLINK_LEAST.reading && g.random() < READ_BLINK) blink(g, BLINK_ONE);
  g.dwell = between(g, 0.36, 0.56);
}

/** Left alone in a hang it looks about, briefly, and usually comes back. */
function wander(g: Gaze, dt: number, pace: number): void {
  // About six glances a minute, never two within a couple of seconds: the body is passive, so the eyes stay calm too.
  if (g.sinceSaccade < 2 || g.random() >= 0.17 * pace * dt) return;
  if (Math.abs(g.aimX) + Math.abs(g.aimY) > 0.3 && g.random() < 0.6) saccade(g, 0, 0);
  else saccade(g, between(g, -0.7, 0.7), between(g, -0.5, 0.25));
}

/** Fast and critically damped: an eye arrives, it does not swing. */
function stepEye(eye: Eye, goal: number, dt: number): void {
  const e = Math.exp(-EYE_RATE * dt);
  const d = eye.value - goal;
  const c = eye.speed + EYE_RATE * d;
  const q = d + c * dt;
  eye.value = goal + q * e;
  eye.speed = (c - EYE_RATE * q) * e;
}

/** Advances the eyes. `pace` slows its own glances and blinks as it quietens; `presence` eases the first frames in. */
export function stepGaze(g: Gaze, dt: number, working: boolean, input: GazeInput, pace: number, presence: number): void {
  g.sinceSaccade += dt;
  if (input.look > 0) {
    if (Math.hypot(input.lookX - g.aimX, input.lookY - g.aimY) > PURSUIT_ERROR && g.sinceSaccade > PURSUIT_GAP) {
      saccade(g, input.lookX, input.lookY, BLINK_LEAST.pursuit);
    }
  } else if (working) {
    read(g, dt);
  } else {
    wander(g, dt, pace);
  }
  stepBlink(g, dt, working, pace);

  const up = REACH.up * (g.small ? SMALL_UP : 1);
  stepEye(g.x, g.aimX * REACH.x * presence, dt);
  stepEye(g.y, (g.aimY < 0 ? g.aimY * up : g.aimY * REACH.down) * presence, dt);
  g.wide += (1 - g.wide) * Math.min(1, dt * 3);

  const lid = g.blinkAge >= 0 ? lidOf(g.blinkAge, g.blinkKind) : 1;
  const shut = g.small ? SHUT.small : SHUT.master;
  g.drawX = g.x.value;
  g.drawY = g.y.value;
  g.drawHeight = (shut + (1 - shut) * lid) * g.wide;
  g.drawWidth = 1 + SHUT_WIDEN * (1 - lid);
}
