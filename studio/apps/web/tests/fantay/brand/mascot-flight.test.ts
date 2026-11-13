// SPDX-License-Identifier: AGPL-3.0-only
// The living mascot's numbers, stepped without a page: the cloth it wears, and how it carries it.
import { describe, expect, it } from 'vitest';

import {
  MOTE_HEART,
  MOTE_ZED,
  arriveFlight,
  clickFlight,
  createFlight,
  flipFlight,
  pulseFlight,
  stepFlight,
  whimFlight,
  type Flight,
  type FlightInput,
} from '../../../src/fantay/brand/mascot-flight';
import { HEAD, ORB, POSE_AT_EASE, buildSheet, poseSheet, type Sheet } from '../../../src/fantay/brand/mascot-sheet';

/** Frames a second at the longest frame the mascot is ever stepped by: the stage clamps a late frame to 0.05 s. */
const SLOW = 1 / 20;
const FRAME = 1 / 60;

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sheet = buildSheet(48);
const rows = sheet.domeRows + sheet.skirtRows;

function run(flight: Flight, seconds: number, dt = FRAME, mood: 'idle' | 'working' = 'idle'): void {
  for (let t = 0; t < seconds; t += dt) stepFlight(flight, dt, mood);
}

/** Steps it with nothing of its own accord, so that only what was asked of it shows; `input` is the pointer. */
function hold(flight: Flight, seconds: number, mood: 'idle' | 'working' = 'idle', input?: (t: number) => FlightInput): void {
  for (let t = 0; t < seconds; t += FRAME) {
    flight.sinceWhim = 0;
    stepFlight(flight, FRAME, mood, input?.(t));
  }
}

const NO_POINTER: FlightInput = { lookX: 0, lookY: 0, look: 0, gustX: 0, gustY: 0, near: 0, atX: 0, atY: 0 };

/** The farthest any point of the cloth is from the middle of the box, in half box widths. */
function reach(flight: Flight): number {
  let most = 0;
  const p = flight.cloth.pos;
  for (let i = 0; i < p.length; i += 3) most = Math.max(most, Math.hypot(p[i]!, p[i + 1]!, p[i + 2]!));
  return most;
}

/** How far the cloth is from where the body would have it: on average, and at its worst. */
function astray(flight: Flight): { mean: number; worst: number } {
  let sum = 0;
  let worst = 0;
  const { pos, target } = flight.cloth;
  for (let i = 0; i < pos.length; i += 3) {
    const d = Math.hypot(pos[i]! - target[i]!, pos[i + 1]! - target[i + 1]!, pos[i + 2]! - target[i + 2]!);
    sum += d;
    worst = Math.max(worst, d);
  }
  return { mean: sum / flight.sheet.count, worst };
}

/** The most any edge of the cloth is longer or shorter than the body's shape has it, as a share. */
function strain(flight: Flight): number {
  const { pos, rest } = flight.cloth;
  const { edges } = flight.sheet;
  let worst = 0;
  for (let k = 0; k < rest.length; k += 1) {
    const a = 3 * edges[2 * k]!;
    const b = 3 * edges[2 * k + 1]!;
    const length = Math.hypot(pos[a]! - pos[b]!, pos[a + 1]! - pos[b + 1]!, pos[a + 2]! - pos[b + 2]!);
    worst = Math.max(worst, Math.abs(length / rest[k]! - 1));
  }
  return worst;
}

/** The vertex of column `c` on row `r`, the crown being apart from every column. */
function vertex(of: Sheet, c: number, r: number): number {
  return 1 + c * (of.domeRows + of.skirtRows) + (r - 1);
}

/** The column nearest an angle round the body, in degrees from the front towards the mascot's right. The columns are
 *  not evenly spaced: they crowd towards the middle of the back. */
function columnAt(degrees: number): number {
  const want = ((((degrees % 360) + 360) % 360) * Math.PI) / 180;
  let nearest = 0;
  let least = Infinity;
  for (let c = 0; c < sheet.cols; c += 1) {
    const off = Math.abs(sheet.around[vertex(sheet, c, 1)]! - want);
    const apart = Math.min(off, 2 * Math.PI - off);
    if (apart < least) {
      least = apart;
      nearest = c;
    }
  }
  return nearest;
}

/** Which way triangle `i` of the cloth turns as the viewer sees it in a pose: above nothing it shows its outside. */
function facing(pose: Float32Array, i: number): number {
  const a = 3 * sheet.triangles[i]!;
  const b = 3 * sheet.triangles[i + 1]!;
  const c = 3 * sheet.triangles[i + 2]!;
  return (pose[b]! - pose[a]!) * (pose[c + 1]! - pose[a + 1]!) - (pose[b + 1]! - pose[a + 1]!) * (pose[c]! - pose[a]!);
}

/** How long a column of the skirt is in a pose, from the dome's rim to the hem. */
function fall(pose: Float32Array, c: number): number {
  let length = 0;
  for (let r = sheet.domeRows; r < rows; r += 1) {
    const a = 3 * vertex(sheet, c, r);
    const b = 3 * vertex(sheet, c, r + 1);
    length += Math.hypot(pose[a]! - pose[b]!, pose[a + 1]! - pose[b + 1]!, pose[a + 2]! - pose[b + 2]!);
  }
  return length;
}

describe('the cloth it wears', () => {
  it('is one piece: a dome over the head and a skirt below it, about the size of its box', () => {
    expect(sheet.count).toBe(1 + sheet.cols * rows);
    expect(sheet.triangles.length % 3).toBe(0);
    expect(Math.max(...sheet.triangles)).toBeLessThan(sheet.count);
    // Every vertex is part of the cloth: none was left without a neighbour.
    for (let v = 0; v < sheet.count; v += 1) expect(sheet.ringStart[v + 1]! - sheet.ringStart[v]!).toBeGreaterThanOrEqual(3);
    // At ease it fills its box and stays about inside it: the canvas it is drawn on is twice the box.
    let left = Infinity;
    let right = -Infinity;
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < sheet.rest.length; i += 3) {
      left = Math.min(left, HEAD.x + sheet.rest[i]!);
      right = Math.max(right, HEAD.x + sheet.rest[i]!);
      low = Math.min(low, HEAD.y + sheet.rest[i + 1]!);
      high = Math.max(high, HEAD.y + sheet.rest[i + 1]!);
    }
    expect(right - left).toBeGreaterThan(1.1);
    expect(high - low).toBeGreaterThan(1.4);
    for (const edge of [left, right, low, high]) expect(Math.abs(edge)).toBeLessThan(1.2);
    // It stands in the middle of its box, facing the viewer: as much of it to one side as to the other.
    expect(HEAD.x).toBe(0);
    expect(Math.abs(left + right) / 2).toBeLessThan(0.1);
  });

  it('shows its outside to the viewer, and its lining under a front hem cut shorter than the back', () => {
    // Seen from the front, the front of the head is all outside: every triangle there turns counter-clockwise.
    const { rest, triangles } = sheet;
    let fronts = 0;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = 3 * triangles[i]!;
      const b = 3 * triangles[i + 1]!;
      const c = 3 * triangles[i + 2]!;
      if (sheet.skirt[triangles[i]!]! > 0 || sheet.skirt[triangles[i + 1]!]! > 0 || sheet.skirt[triangles[i + 2]!]! > 0) continue;
      // The tip over the crown is a tube that curls over: its far side is towards the viewer too, and faces away.
      if (sheet.peak[triangles[i]!]! > 0 || sheet.peak[triangles[i + 1]!]! > 0 || sheet.peak[triangles[i + 2]!]! > 0) continue;
      if ((rest[a + 2]! + rest[b + 2]! + rest[c + 2]!) / 3 < 0.15) continue;
      fronts += 1;
      expect(facing(rest, i)).toBeGreaterThan(0);
    }
    expect(fronts).toBeGreaterThan(10);
    // The back hangs well below the front, so the inside of it is what shows beneath the front hem.
    const front = rest[3 * vertex(sheet, columnAt(0), rows) + 1]!;
    const back = rest[3 * vertex(sheet, columnAt(180), rows) + 1]!;
    expect(front - back).toBeGreaterThan(0.15);
    // And the tail hangs from the middle of its back, lower than anything else: seen from the front it is behind the
    // body and shows below it, to neither side.
    let lowest = 0;
    for (let v = 0; v < sheet.count; v += 1) if (rest[3 * v + 1]! < rest[3 * lowest + 1]!) lowest = v;
    expect(sheet.tail[lowest]).toBeGreaterThan(0.5);
    expect(Math.abs(rest[3 * lowest]!)).toBeLessThan(0.02);
    expect(rest[3 * lowest + 2]!).toBeLessThan(-0.3);
    expect(front - rest[3 * lowest + 1]!).toBeGreaterThan(0.2);
  });

  it('sways its tail to either side as one ribbon, its lining kept towards the viewer', () => {
    const { rest, triangles } = sheet;
    const tip = 3 * vertex(sheet, columnAt(180), rows);
    /** The share of the tail's lining that a pose turns over, so that its outside shows where the lining did. */
    const turned = (pose: Float32Array): number => {
      let lining = 0;
      let over = 0;
      for (let i = 0; i < triangles.length; i += 3) {
        if (Math.max(sheet.tail[triangles[i]!]!, sheet.tail[triangles[i + 1]!]!, sheet.tail[triangles[i + 2]!]!) < 0.05) continue;
        const was = facing(rest, i);
        if (was >= 0) continue;
        lining -= was;
        over += Math.max(0, facing(pose, i));
      }
      expect(lining).toBeGreaterThan(0.05);
      return over / lining;
    };
    const swung = new Float32Array(rest.length);
    for (const side of [1, -1]) {
      // An easy sway, as it idles: its tip goes to one side, across the view, and none of it is turned over. Moved
      // column by column instead of as one, the ribbon crosses itself and shows its outside even here.
      // (The swing and the wave are given opposite signs so that they carry the tip the same way.)
      poseSheet(sheet, { ...POSE_AT_EASE, swish: 0.15 * side, wagB: -0.15 * side }, swung);
      expect(Math.abs(swung[tip]! - rest[tip]!)).toBeGreaterThan(0.12);
      expect(turned(swung)).toBe(0);
      // A hard flick carries it out past the hem beside it, and the cloth between the two folds: even then all but
      // a sliver of it keeps its face.
      poseSheet(sheet, { ...POSE_AT_EASE, swish: 0.64 * side, wagB: -0.3 * side }, swung);
      expect(Math.abs(swung[tip]! - rest[tip]!)).toBeGreaterThan(0.4);
      expect(turned(swung)).toBeLessThan(0.06);
    }
  });

  it('raises its hand by bending the cloth, never by stretching it along its fall', () => {
    const down = new Float32Array(sheet.rest.length);
    const up = new Float32Array(sheet.rest.length);
    poseSheet(sheet, { ...POSE_AT_EASE, wave: 0 }, down);
    poseSheet(sheet, { ...POSE_AT_EASE, wave: 1 }, up);
    const hand = columnAt(86);
    // Raised, the cloth over the hand stands out and up from where it hung.
    const from = 3 * vertex(sheet, hand, sheet.domeRows + Math.round(sheet.skirtRows * 0.8));
    expect(up[from + 1]! - down[from + 1]!).toBeGreaterThan(0.15);
    expect(up[from]! - down[from]!).toBeGreaterThan(0.1);
    // Every column is as long as it was: the hand's own, and one the hand has nothing to do with.
    expect(fall(up, hand) / fall(down, hand)).toBeCloseTo(1, 1);
    expect(fall(up, columnAt(200)) / fall(down, columnAt(200))).toBeCloseTo(1, 3);
    // Spread wide, the skirt is wider at the hem and no longer. Only a little wider: it is a hood, and a hood that
    // opened like an umbrella at every breath would show what is under it.
    const wide = new Float32Array(sheet.rest.length);
    poseSheet(sheet, { ...POSE_AT_EASE, open: 0.6 }, wide);
    const hem = 3 * vertex(sheet, columnAt(0), rows);
    expect(wide[hem + 2]!).toBeGreaterThan(down[hem + 2]! + 0.01);
    expect(fall(wide, columnAt(0)) / fall(down, columnAt(0))).toBeCloseTo(1, 1);
  });

  it('is held firmly on the head, stirs at its hem over the face, and is left free where it falls behind', () => {
    for (let c = 0; c < sheet.cols; c += 1) {
      // On the head the cloth is the head's own shape.
      expect(sheet.hold[vertex(sheet, c, sheet.domeRows)]).toBe(1);
      expect(sheet.rim[vertex(sheet, c, rows)]).toBe(1);
    }
    // The petals over the face are short and stay over the face, but they are cloth, not a shell's rim: their tips
    // are held well short of as firmly as the head. The cape behind flows.
    const hem = sheet.hold[vertex(sheet, columnAt(0), rows)]!;
    expect(hem).toBeGreaterThan(0.4);
    expect(hem).toBeLessThan(0.7);
    expect(sheet.hold[vertex(sheet, columnAt(180), rows)]!).toBeLessThan(0.25);
  });

  it('is drawn up over the crown into a soft cap whose end has fallen over to one side', () => {
    const { rest } = sheet;
    // The cap rises above the round of the head and its end comes down again beside it, on the mascot's right and a
    // little towards the viewer: the end, where the orb hangs, is below the top of the cap and out at its side.
    let top = -Infinity;
    for (let v = 0; v < sheet.count; v += 1) top = Math.max(top, rest[3 * v + 1]!);
    expect(top).toBeGreaterThan(HEAD.radius + 0.15);
    expect(rest[1]!).toBeLessThan(top - 0.08);
    expect(rest[0]!).toBeGreaterThan(0.3);
    expect(rest[2]!).toBeGreaterThan(0.05);
    // It is one hat from the head up: it narrows at every row from its foot to its end.
    let wider = Infinity;
    for (let r = sheet.domeRows; r >= 1; r -= 1) {
      if (sheet.peak[vertex(sheet, 0, r)]! <= 0) continue;
      const a = 3 * vertex(sheet, columnAt(0), r);
      const b = 3 * vertex(sheet, columnAt(180), r);
      const across = Math.hypot(rest[a]! - rest[b]!, rest[a + 1]! - rest[b + 1]!, rest[a + 2]! - rest[b + 2]!);
      expect(across).toBeLessThan(wider);
      wider = across;
    }
    expect(wider).toBeLessThan(0.3);
    // Below the hat's foot the cloth is the round of the head.
    const half = 3 * vertex(sheet, columnAt(90), Math.ceil(sheet.domeRows * 0.75));
    expect(Math.hypot(rest[half]!, rest[half + 1]!)).toBeCloseTo(HEAD.radius, 1);
    // Its top is round and not a point: the point is what fell over. The highest of it is well in from its end, over
    // the head, and the end is lower than that.
    let highest = 0;
    for (let v = 0; v < sheet.count; v += 1) if (rest[3 * v + 1]! > rest[3 * highest + 1]!) highest = v;
    expect(Math.abs(rest[3 * highest]!)).toBeLessThan(0.25);
    expect(rest[0]! - rest[3 * highest]!).toBeGreaterThan(0.3);
    // Its end is held a little less firmly than the head, and no looser: its swing is the body's own doing (the
    // pose), and left to the air a tube of cloth this wide twists and shows its lining.
    expect(sheet.hold[0]!).toBeLessThan(0.95);
    expect(sheet.hold[0]!).toBeGreaterThan(0.7);
    expect(sheet.hold[vertex(sheet, 0, 1)]!).toBeLessThan(sheet.hold[vertex(sheet, 0, sheet.domeRows)]!);
  });

  it('swings the tail of its hat about the fold, and nothing below the fold with it', () => {
    const { rest } = sheet;
    const moved = (pose: Float32Array, v: number) => Math.hypot(pose[3 * v]! - rest[3 * v]!, pose[3 * v + 1]! - rest[3 * v + 1]!, pose[3 * v + 2]! - rest[3 * v + 2]!);
    const back = new Float32Array(rest.length);
    poseSheet(sheet, { ...POSE_AT_EASE, tip: -0.5 }, back);
    // The tail hangs down beside the hat. Knocked back up, its end rises and goes out from the hat, about where it
    // hangs from: it is hinged at the fold, not at the head.
    expect(back[1]! - rest[1]!).toBeGreaterThan(0.1);
    expect(back[0]! - rest[0]!).toBeGreaterThan(0.05);
    // Swung further over, its end comes down and in towards the hat.
    const over = new Float32Array(rest.length);
    poseSheet(sheet, { ...POSE_AT_EASE, tip: 0.28 }, over);
    expect(rest[1]! - over[1]!).toBeGreaterThan(0.05);
    expect(rest[0]! - over[0]!).toBeGreaterThan(0.05);
    // The hat below the fold, the round of the head, the skirt and the tail are where they were.
    let still = 0;
    for (let v = 1; v < sheet.count; v += 1) {
      if (sheet.peak[v]! > 0.4) continue;
      if (sheet.peak[v]! > 0) still += 1;
      expect(moved(back, v)).toBe(0);
      expect(moved(over, v)).toBe(0);
    }
    expect(still).toBeGreaterThan(0);
  });

  it('bends the tail of its hat as cloth bends, and curls the end of it on its own', () => {
    const { rest } = sheet;
    // The rows of the tail: those past the fold.
    const tail: number[] = [];
    for (let r = 1; r <= sheet.domeRows; r += 1) if (sheet.peak[vertex(sheet, 0, r)]! > 0.4) tail.push(r);
    expect(tail.length).toBeGreaterThanOrEqual(3);
    const inside = columnAt(90);
    const outside = columnAt(270);
    /** How long the tail's underside is in a pose, and how wide the tail is at each of its rows. */
    const measure = (pose: Float32Array) => {
      let along = 0;
      const across: number[] = [];
      for (let k = 0; k < tail.length; k += 1) {
        const a = 3 * vertex(sheet, inside, tail[k]!);
        const o = 3 * vertex(sheet, outside, tail[k]!);
        across.push(Math.hypot(pose[a]! - pose[o]!, pose[a + 1]! - pose[o + 1]!));
        if (k === 0) continue;
        const b = 3 * vertex(sheet, inside, tail[k - 1]!);
        along += Math.hypot(pose[a]! - pose[b]!, pose[a + 1]! - pose[b + 1]!);
      }
      return { along, across };
    };
    const atEase = measure(rest);
    // Swung right back with its end curled the other way, and swung over with its end flung out: it is neither
    // longer nor shorter along its underside, and no wider or narrower anywhere. Turned about one point by shares
    // instead, a tail this long shears: it stretches and thins.
    for (const [tip, curl] of [[-0.75, 0.35], [0.28, -0.7], [-0.4, -0.5]] as const) {
      const bent = new Float32Array(rest.length);
      poseSheet(sheet, { ...POSE_AT_EASE, tip, curl }, bent);
      const now = measure(bent);
      expect(Math.abs(now.along / atEase.along - 1)).toBeLessThan(0.04);
      for (let k = 0; k < tail.length; k += 1) expect(now.across[k]).toBeCloseTo(atEase.across[k]!, 5);
    }
    // The curl is the end's alone: most of the tail does not know of it.
    const curled = new Float32Array(rest.length);
    poseSheet(sheet, { ...POSE_AT_EASE, curl: -0.6 }, curled);
    expect(Math.hypot(curled[0]! - rest[0]!, curled[1]! - rest[1]!)).toBeGreaterThan(0.03);
    let still = 0;
    for (let v = 1; v < sheet.count; v += 1) {
      if (sheet.peak[v]! > 0.6) continue;
      if (sheet.peak[v]! > 0.4) still += 1;
      expect(Math.hypot(curled[3 * v]! - rest[3 * v]!, curled[3 * v + 1]! - rest[3 * v + 1]!, curled[3 * v + 2]! - rest[3 * v + 2]!)).toBe(0);
    }
    expect(still).toBeGreaterThan(0);
  });

  it('sinks on the head and fills out, and lifts off it and thins, without leaving the head', () => {
    const { rest } = sheet;
    const sunk = new Float32Array(rest.length);
    const lifted = new Float32Array(rest.length);
    poseSheet(sheet, { ...POSE_AT_EASE, sag: 0.1 }, sunk);
    poseSheet(sheet, { ...POSE_AT_EASE, sag: -0.1 }, lifted);
    let top = 0;
    for (let v = 0; v < sheet.count; v += 1) if (rest[3 * v + 1]! > rest[3 * top + 1]!) top = v;
    expect(rest[3 * top + 1]! - sunk[3 * top + 1]!).toBeGreaterThan(0.03);
    expect(lifted[3 * top + 1]! - rest[3 * top + 1]!).toBeGreaterThan(0.03);
    // Half way up, it is wider from front to back when it has sunk and narrower when it has lifted.
    const row = Math.round(sheet.domeRows * 0.36);
    const across = (pose: Float32Array) => Math.abs(pose[3 * vertex(sheet, columnAt(0), row) + 2]! - pose[3 * vertex(sheet, columnAt(180), row) + 2]!);
    expect(sheet.peak[vertex(sheet, 0, row)]!).toBeGreaterThan(0.3);
    expect(across(sunk)).toBeGreaterThan(across(rest));
    expect(across(lifted)).toBeLessThan(across(rest));
    // Below its foot nothing has moved.
    for (let v = 1; v < sheet.count; v += 1) {
      if (sheet.peak[v]! > 0) continue;
      expect(Math.hypot(sunk[3 * v]! - rest[3 * v]!, sunk[3 * v + 1]! - rest[3 * v + 1]!, sunk[3 * v + 2]! - rest[3 * v + 2]!)).toBe(0);
    }
  });
});

describe('the flight', () => {
  it('hangs in its pose when nothing moves it, on every cut of the cloth', () => {
    // No air and no wander: whatever the cloth does now it does to itself. It may sag a little; it must not creep,
    // swing or fold up, however long it is left.
    for (const fineness of [24, 32, 48]) {
      const flight = createFlight(buildSheet(fineness), 1, false, seeded(7));
      expect(astray(flight).worst).toBe(0);
      for (let k = 0; k < 600; k += 1) {
        flight.wake = 0;
        flight.sinceWhim = 0;
        stepFlight(flight, FRAME, 'idle');
      }
      expect(astray(flight).worst).toBeLessThan(0.09);
      expect(strain(flight)).toBeLessThan(0.15);
    }
  });

  it('stays whole through a long float, and is cloth all the while', () => {
    const flight = createFlight(sheet, 1, false, seeded(3));
    run(flight, 90);
    expect(Number.isFinite(reach(flight))).toBe(true);
    expect(reach(flight)).toBeLessThan(2);
    // It is cloth, not a shell: where it falls free the air has it somewhere other than where the body would hold it.
    // Most of it is the head and the brim, which keep their shape, so on average it is not far off.
    expect(astray(flight).worst).toBeGreaterThan(0.01);
    expect(astray(flight).mean).toBeLessThan(0.2);
    expect(strain(flight)).toBeLessThan(0.5);
  });

  it('stays whole at work and at the slowest frame rate', () => {
    const flight = createFlight(sheet, 1.36, true, seeded(11));
    run(flight, 60, SLOW, 'working');
    expect(Number.isFinite(reach(flight))).toBe(true);
    expect(reach(flight)).toBeLessThan(2.2);
    expect(strain(flight)).toBeLessThan(0.5);
  });

  it('crouches on a pulse, springs up smiling with its hand raised, and settles back', () => {
    const flight = createFlight(sheet, 1, false, seeded(5));
    run(flight, 2);
    const before = flight.drawY;
    pulseFlight(flight);
    run(flight, 0.1);
    expect(flight.pose.stretch).toBeLessThan(-0.02);
    run(flight, 0.5);
    expect(flight.drawY - before).toBeGreaterThan(0.1);
    expect(flight.joy).toBeGreaterThan(0.8);
    expect(flight.pose.wave).toBeGreaterThan(0.5);
    run(flight, 8);
    // Back in its float, which itself rises and sinks with every breath.
    expect(Math.abs(flight.drawY - before)).toBeLessThan(0.14);
    expect(flight.joy).toBeLessThan(0.05);
  });

  it('sheds motes of light when it is pleased, and none where they would be specks', () => {
    const alight = (flight: Flight) => flight.motes.filter((mote) => mote.age < mote.life).length;
    const flight = createFlight(sheet, 1, false, seeded(9));
    run(flight, 0.5);
    pulseFlight(flight);
    expect(alight(flight)).toBeGreaterThanOrEqual(6);
    // They burn out, and at ease only a few are ever alight.
    run(flight, 6);
    expect(alight(flight)).toBeLessThan(6);
    const small = createFlight(sheet, 1.36, true, seeded(9));
    pulseFlight(small);
    run(small, 20, FRAME, 'working');
    expect(alight(small)).toBe(0);
  });

  it('floats in from below and waves', () => {
    const flight = createFlight(sheet, 1, false, seeded(13));
    arriveFlight(flight);
    stepFlight(flight, 0, 'idle');
    expect(flight.origin[1]).toBeLessThan(HEAD.y - 0.4);
    run(flight, 1.5);
    expect(flight.pose.wave).toBeGreaterThan(0.5);
    run(flight, 4);
    expect(Math.abs(flight.origin[1]! - HEAD.y)).toBeLessThan(0.12);
    expect(flight.enter).toBe(0);
  });

  it('goes head over heels and comes back as it was', () => {
    const flight = createFlight(sheet, 1, false, seeded(7));
    run(flight, 1);
    flipFlight(flight);
    run(flight, 1);
    // Half way round it is upside down, and facing away.
    expect(flight.turn[4]).toBeLessThan(0);
    expect(flight.turn[8]).toBeLessThan(0);
    run(flight, 6);
    expect(flight.roll).toBe(0);
    expect(flight.turn[4]).toBeGreaterThan(0.5);
    expect(flight.turn[8]).toBeGreaterThan(0.5);
    expect(Number.isFinite(reach(flight))).toBe(true);
    expect(astray(flight).mean).toBeLessThan(0.2);
    expect(strain(flight)).toBeLessThan(0.5);
  });

  it('turns right round where it stands and comes back as it was', () => {
    const flight = createFlight(sheet, 1, false, seeded(15));
    hold(flight, 1);
    whimFlight(flight, 'twirl');
    hold(flight, 0.62);
    // Half way round it has its back to the viewer, and is still upright.
    expect(flight.turn[8]).toBeLessThan(0);
    expect(flight.turn[4]).toBeGreaterThan(0.5);
    hold(flight, 5);
    expect(flight.spin).toBe(0);
    expect(flight.turn[8]).toBeGreaterThan(0.5);
    expect(astray(flight).mean).toBeLessThan(0.2);
    expect(strain(flight)).toBeLessThan(0.5);
  });

  it('gives each of its performances, and is itself again after', () => {
    const face = (flight: Flight) => Math.max(flight.lid, flight.gape, flight.flush, flight.left);
    // A yawn: mouth wide, eyes shut, both hands up.
    const yawning = createFlight(sheet, 1, false, seeded(17));
    hold(yawning, 0.5);
    whimFlight(yawning, 'yawn');
    hold(yawning, 1);
    expect(yawning.gape).toBeGreaterThan(0.8);
    expect(yawning.lid).toBeGreaterThan(0.7);
    expect(yawning.left).toBeGreaterThan(0.5);
    expect(yawning.pose.wave).toBeGreaterThan(0.5);
    // A sneeze: drawn back first, then thrown forward with its eyes shut.
    const sneezing = createFlight(sheet, 1, false, seeded(17));
    hold(sneezing, 0.5);
    whimFlight(sneezing, 'sneeze');
    hold(sneezing, 0.7);
    expect(sneezing.quick[0]).toBeLessThan(-0.1);
    hold(sneezing, 0.3);
    expect(sneezing.quick[0]).toBeGreaterThan(0.1);
    expect(sneezing.lid).toBeGreaterThan(0.8);
    // Batting at its light: the tip of its hat is knocked back up and the light flares.
    const batting = createFlight(sheet, 1, false, seeded(17));
    hold(batting, 0.5);
    whimFlight(batting, 'bat');
    hold(batting, 0.8);
    expect(batting.pose.tip).toBeLessThan(-0.2);
    expect(batting.flare).toBeGreaterThan(0.3);
    expect(batting.gaze.aimY).toBeLessThan(-0.5);
    // A dance: tilted to one side with its eyes shut in a smile and a hand in the air.
    const dancing = createFlight(sheet, 1, false, seeded(17));
    hold(dancing, 0.5);
    whimFlight(dancing, 'dance');
    hold(dancing, 0.6);
    expect(Math.abs(dancing.quick[2]!)).toBeGreaterThan(0.1);
    expect(dancing.joy).toBeGreaterThan(0.8);
    expect(Math.max(dancing.left, dancing.pose.wave)).toBeGreaterThan(0.4);
    for (const flight of [yawning, sneezing, batting, dancing]) {
      hold(flight, 5);
      expect(flight.act).toBe('');
      expect(face(flight)).toBeLessThan(0.05);
      // The hat's end has stopped ringing: all that is left of its swing is the little it trails each breath by.
      expect(Math.abs(flight.pose.tip)).toBeLessThan(0.2);
      for (const quick of flight.quick) expect(quick).toBe(0);
      expect(strain(flight)).toBeLessThan(0.5);
    }
  });

  it('carries its light on the end of its hat as a weight on a short thread', () => {
    const flight = createFlight(sheet, 1, false, seeded(23));
    const thread = ORB.radius * ORB.hang;
    const end = flight.cloth.pos;
    const strung = () => Math.hypot(flight.orb[0]! - end[0]!, flight.orb[1]! - end[1]!, flight.orb[2]! - end[2]!);
    // From the start it is on its thread, below the end of the tail, and outside the hat.
    expect(strung()).toBeCloseTo(thread, 6);
    hold(flight, 2);
    expect(strung()).toBeCloseTo(thread, 6);
    expect(flight.orb[1]!).toBeLessThan(end[1]!);
    // Its hat's tail is knocked. The end of the tail is left behind by the swing, curled the other way; the orb swings
    // out of the line it hung on; and at every frame it is still on its thread and has not sunk into the hat.
    whimFlight(flight, 'bat');
    let curled = 0;
    let swung = 0;
    for (let k = 0; k < 150; k += 1) {
      const before = Math.atan2(flight.orb[0]! - end[0]!, end[1]! - flight.orb[1]!);
      flight.sinceWhim = 0;
      stepFlight(flight, FRAME, 'idle');
      expect(strung()).toBeCloseTo(thread, 6);
      expect(Math.hypot(flight.orb[0]! - flight.origin[0]!, flight.orb[1]! - flight.origin[1]!, flight.orb[2]! - flight.origin[2]!)).toBeGreaterThan(HEAD.radius);
      if (flight.tipSpeed < -1) curled = Math.max(curled, flight.pose.curl);
      swung = Math.max(swung, Math.abs(Math.atan2(flight.orb[0]! - end[0]!, end[1]! - flight.orb[1]!) - before));
    }
    expect(curled).toBeGreaterThan(0.15);
    expect(swung).toBeGreaterThan(0.02);
    // Left alone, all of it comes to rest again.
    hold(flight, 6);
    expect(Math.abs(flight.pose.curl)).toBeLessThan(0.1);
    expect(Math.hypot(flight.orbSpeed[0]!, flight.orbSpeed[1]!, flight.orbSpeed[2]!)).toBeLessThan(0.3);
    expect(strung()).toBeCloseTo(thread, 6);
  });

  it('nods off when it is left alone for long, and wakes with a start when someone comes', () => {
    const flight = createFlight(sheet, 1, false, seeded(21));
    run(flight, 2);
    // It has been alone a long while already.
    flight.awake = 100;
    let waited = 0;
    for (; waited < 60 && flight.nap <= 0; waited += FRAME) stepFlight(flight, FRAME, 'idle');
    expect(flight.nap).toBeGreaterThan(0);
    run(flight, 5);
    expect(flight.doze).toBeGreaterThan(0.9);
    expect(flight.lid).toBeGreaterThan(0.9);
    expect(flight.motes.some((mote) => mote.age < mote.life && mote.kind === MOTE_ZED)).toBe(true);
    // A pointer comes close.
    stepFlight(flight, FRAME, 'idle', { ...NO_POINTER, near: 0.9 });
    expect(flight.nap).toBe(0);
    expect(flight.gasp).toBeGreaterThan(0);
    hold(flight, 1.5);
    expect(flight.doze).toBe(0);
    expect(flight.lid).toBeLessThan(0.05);
    // A mascot of a few pixels never sleeps: its shut eyes would be no eyes at all.
    const small = createFlight(sheet, 1.36, true, seeded(21));
    small.awake = 100;
    for (let t = 0; t < 60; t += SLOW) {
      stepFlight(small, SLOW, 'idle');
      expect(small.nap).toBe(0);
    }
  });

  it('gives itself up to a pointer that strokes it', () => {
    const flight = createFlight(sheet, 1, false, seeded(23));
    hold(flight, 1);
    // To and fro across its head.
    hold(flight, 1.6, 'idle', (t) => ({ ...NO_POINTER, near: 0.9, atX: 0.4 * Math.sin(5 * t), atY: 0.4, gustX: Math.cos(5 * t), gustY: 0 }));
    expect(flight.joy).toBeGreaterThan(0.8);
    expect(flight.flush).toBeGreaterThan(0.5);
    expect(flight.motes.some((mote) => mote.age < mote.life && mote.kind === MOTE_HEART)).toBe(true);
    // Its left hand stays down: this is not the pleasure of a lift.
    expect(flight.left).toBeLessThan(0.1);
    hold(flight, 4);
    expect(flight.petted).toBe(0);
    expect(flight.joy).toBeLessThan(0.05);
    expect(flight.flush).toBeLessThan(0.05);
  });

  it('turns right round on two quick clicks, and goes head over heels after it on a third', () => {
    const flight = createFlight(sheet, 1, false, seeded(25));
    hold(flight, 1);
    clickFlight(flight);
    expect(flight.spin).toBe(0);
    hold(flight, 0.2);
    clickFlight(flight);
    expect(flight.spin).toBeGreaterThan(0);
    hold(flight, 0.2);
    clickFlight(flight);
    // The roll waits for the turn to be done.
    expect(flight.roll).toBe(0);
    expect(flight.rollWaiting).toBeGreaterThan(0.5);
    hold(flight, 0.75);
    expect(flight.spin).toBeGreaterThan(0);
    expect(flight.roll).toBe(0);
    hold(flight, 1.2);
    expect(flight.spin).toBe(0);
    expect(flight.roll).toBeGreaterThan(0);
    hold(flight, 6);
    expect(flight.roll).toBe(0);
    expect(flight.turn[4]).toBeGreaterThan(0.5);
    expect(flight.turn[8]).toBeGreaterThan(0.5);
    expect(strain(flight)).toBeLessThan(0.5);
  });

  it('stops to think at work, and the idea lights its lamp', () => {
    const flight = createFlight(sheet, 1, false, seeded(27));
    hold(flight, 2, 'working');
    flight.gaze.thought = true;
    stepFlight(flight, FRAME, 'working');
    expect(flight.act).toBe('muse');
    hold(flight, 0.6, 'working');
    expect(flight.pose.wave).toBeGreaterThan(0.3);
    expect(flight.flare).toBeLessThan(0.05);
    hold(flight, 0.8, 'working');
    expect(flight.act).toBe('');
    expect(flight.flare).toBeGreaterThan(0.3);
    expect(flight.shimmer).toBeGreaterThanOrEqual(0);
    // Setting its work down, its light flares again.
    hold(flight, 3, 'working');
    expect(flight.flare).toBeLessThan(0.05);
    hold(flight, 0.2, 'idle');
    expect(flight.flare).toBeGreaterThan(0.3);
  });
});
