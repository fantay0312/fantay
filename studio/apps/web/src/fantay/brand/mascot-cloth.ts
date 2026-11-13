// SPDX-License-Identifier: AGPL-3.0-only
// The sheet as cloth. Every vertex is a point with a little mass; the cloth keeps its edges near their length, resists
// a crease softly, and is drawn back to where the body would have it (`target`) by a pull that is firm on the head and
// faint at the hem. Air does the rest: each point is carried along with the air through its own face, so a gust
// billows the skirt and a move of the body leaves the hem and the tail trailing behind it.
//
// The lengths and the roundness the cloth keeps are those of the body's own shape this frame (`shape`), so the body
// can spread its skirt or lift a corner and the cloth goes with it rather than fighting it.
//
// Position-based dynamics in small steps: every step is unconditionally stable, so a pull never has to be tuned against
// a frame rate. Pure numbers.
import type { Sheet } from './mascot-sheet';

/** The longest step the cloth takes, seconds. */
const STEP = 1 / 300;
const MOST_STEPS = 12;

export interface ClothFeel {
  /** How much an edge gives under load: 0 is rigid. */
  stretch: number;
  /** How easily it creases: larger is limper. Long slow bends are always easy; this is about the short sharp ones. */
  crease: number;
  /** How easily it folds up along its fall: larger is limper. */
  crumple: number;
  /** How fast a point takes up the speed of the air through its face, and along it, per second. */
  dragAcross: number;
  dragAlong: number;
  /** Neighbouring points share this much of their difference in speed per step: what makes it move like silk. */
  silk: number;
  /** The pull back to the body's shape, per second squared: on the head, and at the hem. */
  holdFace: number;
  holdFree: number;
  /** The hand is what the body gestures with, so it is held harder than the hem it is part of. */
  holdHand: number;
  /** The tail is a narrow ribbon the body swings: held loosely as the hem is, it lags its own swing and turns over,
   *  and its outside shows where its lining should. It is held hard enough to keep its face to the viewer. */
  holdTail: number;
  /** The skirt stays this share of its own radius clear of the line through the middle of the body, so its far side
   *  never comes through its near side. */
  hollow: number;
}

export const CLOTH_FEEL: ClothFeel = {
  stretch: 9e-5,
  crease: 1.4e-4,
  crumple: 2.5e-3,
  dragAcross: 5,
  dragAlong: 0.35,
  silk: 0.05,
  holdFace: 400,
  holdFree: 8,
  holdHand: 30,
  holdTail: 40,
  hollow: 0.5,
};

export interface Cloth {
  sheet: Sheet;
  feel: ClothFeel;
  /** [x, y, z] triples, in the space the mascot is drawn in. */
  pos: Float32Array;
  prev: Float32Array;
  vel: Float32Array;
  /** Unit normals out of the top side, as of the last step. */
  normal: Float32Array;
  /** The body's own shape this frame, about the middle of its head and before it is put in place. Written by the
   *  flight, and read by `fitCloth`. */
  shape: Float32Array;
  /** What the cloth keeps, read from `shape`: each edge's length, how far each vertex stands out of the middle of its
   *  neighbours along its own normal, and how far each stays from the body's middle line at the least. */
  rest: Float32Array;
  span: Float32Array;
  curve: Float32Array;
  least: Float32Array;
  /** The body's middle line as it is placed now: a point on it, then its direction. Written by the flight. */
  spine: Float64Array;
  /** The body the cloth is worn over, as a ball: its middle, then its radius with the room the cloth keeps from it.
   *  Written by the flight. No point of the skirt comes inside it. */
  body: Float64Array;
  /** Where the body would have each point. Written by the flight before every step. */
  target: Float32Array;
  /** The air's velocity at each point. Written by the flight before every step. */
  wind: Float32Array;
  /** How fast `target` is moving at each point, and where it was a step ago. */
  carry: Float32Array;
  targetWas: Float32Array;
  /** The pull to `target` per point, per second squared, and how fast a point so held gives up whatever speed it has
   *  that the body does not, per second: the head moves with the body and does not ring, the hem is left to swing. */
  pull: Float32Array;
  steady: Float32Array;
  gravity: [number, number, number];
  /** The feel as this sheet needs it: a coarser cut has fewer, heavier points, and the same cloth is softer per point. */
  stretch: number;
  crease: number;
  crumple: number;
  silk: number;
}

/** The vertex spacing the feel is written for, the artwork's units. */
const FEEL_SPACING = 24;

export function createCloth(sheet: Sheet, feel: ClothFeel = CLOTH_FEEL): Cloth {
  const n = sheet.count;
  const coarse = (sheet.spacing / FEEL_SPACING) ** 2;
  const cloth: Cloth = {
    sheet,
    feel,
    pos: new Float32Array(3 * n),
    prev: new Float32Array(3 * n),
    vel: new Float32Array(3 * n),
    normal: new Float32Array(3 * n),
    shape: Float32Array.from(sheet.rest),
    rest: new Float32Array(sheet.edges.length / 2),
    span: new Float32Array(sheet.spans.length / 2),
    curve: new Float32Array(n),
    least: new Float32Array(n),
    spine: Float64Array.from([0, 0, 0, 0, 1, 0]),
    body: new Float64Array(4),
    target: new Float32Array(3 * n),
    wind: new Float32Array(3 * n),
    carry: new Float32Array(3 * n),
    targetWas: new Float32Array(3 * n),
    pull: new Float32Array(n),
    steady: new Float32Array(n),
    gravity: [0, 0, 0],
    stretch: feel.stretch * coarse,
    crease: feel.crease * coarse * coarse,
    crumple: feel.crumple * coarse,
    silk: Math.min(0.2, feel.silk / coarse),
  };
  setHold(cloth, 1);
  fitCloth(cloth);
  return cloth;
}

/** Sets how firmly the body's shape is kept: 1 is the cloth's own feel, more for a body that is turning over. */
export function setHold(cloth: Cloth, firmness: number): void {
  const { hold, hand, tail } = cloth.sheet;
  const { holdFace, holdFree, holdHand, holdTail } = cloth.feel;
  for (let v = 0; v < cloth.sheet.count; v += 1) {
    // Between the head and the hem the pull falls off in proportion, not in steps: a firm core, a long soft skirt.
    const free = (holdFree + (holdHand - holdFree) * hand[v]! + (holdTail - holdFree) * tail[v]!) * firmness;
    const pull = free * Math.pow(holdFace / free, hold[v]! * hold[v]!);
    cloth.pull[v] = pull;
    // Held as firmly as the head is, a point settles without a swing; held as loosely as the hem, it is not slowed.
    cloth.steady[v] = 2 * Math.sqrt(pull) * hold[v]! * hold[v]!;
  }
}

/** Puts every point on its target, at rest. */
export function settleCloth(cloth: Cloth): void {
  cloth.pos.set(cloth.target);
  cloth.prev.set(cloth.target);
  cloth.targetWas.set(cloth.target);
  cloth.vel.fill(0);
  updateNormals(cloth);
}

/** Unit normals out of the outside of the cloth lying at `pos`, written to `normal`. */
function normalsOf(tris: Uint16Array, pos: Float32Array, normal: Float32Array): void {
  normal.fill(0);
  for (let i = 0; i < tris.length; i += 3) {
    const a = 3 * tris[i]!;
    const b = 3 * tris[i + 1]!;
    const c = 3 * tris[i + 2]!;
    const ux = pos[b]! - pos[a]!;
    const uy = pos[b + 1]! - pos[a + 1]!;
    const uz = pos[b + 2]! - pos[a + 2]!;
    const vx = pos[c]! - pos[a]!;
    const vy = pos[c + 1]! - pos[a + 1]!;
    const vz = pos[c + 2]! - pos[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normal[a] = normal[a]! + nx;
    normal[a + 1] = normal[a + 1]! + ny;
    normal[a + 2] = normal[a + 2]! + nz;
    normal[b] = normal[b]! + nx;
    normal[b + 1] = normal[b + 1]! + ny;
    normal[b + 2] = normal[b + 2]! + nz;
    normal[c] = normal[c]! + nx;
    normal[c + 1] = normal[c + 1]! + ny;
    normal[c + 2] = normal[c + 2]! + nz;
  }
  for (let v = 0; v < normal.length; v += 3) {
    const l = Math.hypot(normal[v]!, normal[v + 1]!, normal[v + 2]!) || 1;
    normal[v] = normal[v]! / l;
    normal[v + 1] = normal[v + 1]! / l;
    normal[v + 2] = normal[v + 2]! / l;
  }
}

export function updateNormals(cloth: Cloth): void {
  normalsOf(cloth.sheet.triangles, cloth.pos, cloth.normal);
}

const lie = { normal: new Float32Array(0) };

/** How far apart each pair lies at `pos`, written to `out`. */
function lengths(pos: Float32Array, pairs: Uint16Array, out: Float32Array): void {
  for (let k = 0, e = 0; k < out.length; k += 1, e += 2) {
    const a = 3 * pairs[e]!;
    const b = 3 * pairs[e + 1]!;
    const dx = pos[a]! - pos[b]!;
    const dy = pos[a + 1]! - pos[b + 1]!;
    const dz = pos[a + 2]! - pos[b + 2]!;
    out[k] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}

/** Reads what the cloth is to keep from the body's shape this frame: its lengths, its roundness, its hollow. */
export function fitCloth(cloth: Cloth): void {
  const { shape, curve, least, sheet } = cloth;
  const { ringStart, ring, skirt, tail } = sheet;
  lengths(shape, sheet.edges, cloth.rest);
  lengths(shape, sheet.spans, cloth.span);
  if (lie.normal.length < shape.length) lie.normal = new Float32Array(shape.length);
  const normal = lie.normal;
  normalsOf(sheet.triangles, shape, normal);
  const hollow = cloth.feel.hollow;
  for (let v = 0, i = 0; v < sheet.count; v += 1, i += 3) {
    const from = ringStart[v]!;
    const to = ringStart[v + 1]!;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let r = from; r < to; r += 1) {
      const o = 3 * ring[r]!;
      mx += shape[o]!;
      my += shape[o + 1]!;
      mz += shape[o + 2]!;
    }
    const k = to - from || 1;
    curve[v] = (shape[i]! - mx / k) * normal[i]! + (shape[i + 1]! - my / k) * normal[i + 1]! + (shape[i + 2]! - mz / k) * normal[i + 2]!;
    // The body's middle line runs through its head, straight down: the tail leaves it and is let alone.
    least[v] = skirt[v]! > 0 ? hollow * Math.hypot(shape[i]!, shape[i + 2]!) * (1 - Math.min(1, 2 * tail[v]!)) : 0;
  }
}

function keepApart(pos: Float32Array, pairs: Uint16Array, rests: Float32Array, invMass: Float32Array, give: number): void {
  for (let k = 0, e = 0; k < rests.length; k += 1, e += 2) {
    const ia = pairs[e]!;
    const ib = pairs[e + 1]!;
    const a = 3 * ia;
    const b = 3 * ib;
    const dx = pos[b]! - pos[a]!;
    const dy = pos[b + 1]! - pos[a + 1]!;
    const dz = pos[b + 2]! - pos[a + 2]!;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-9) continue;
    const wa = invMass[ia]!;
    const wb = invMass[ib]!;
    const move = (length - rests[k]!) / ((wa + wb + give) * length);
    pos[a] = pos[a]! + dx * move * wa;
    pos[a + 1] = pos[a + 1]! + dy * move * wa;
    pos[a + 2] = pos[a + 2]! + dz * move * wa;
    pos[b] = pos[b]! - dx * move * wb;
    pos[b + 1] = pos[b + 1]! - dy * move * wb;
    pos[b + 2] = pos[b + 2]! - dz * move * wb;
  }
}

/** Keeps each vertex as far out of the middle of its neighbours as it rests: the cloth's resistance to a crease. */
function keepRound(cloth: Cloth, give: number): void {
  const { pos, normal, sheet } = cloth;
  const { ringStart, ring, invMass, tail, peak, rim } = sheet;
  const curve = cloth.curve;
  for (let v = 0, i = 0; v < sheet.count; v += 1, i += 3) {
    const from = ringStart[v]!;
    const to = ringStart[v + 1]!;
    const k = to - from;
    // The tail is a narrow strip drawn to a point, and this correction, which only ever moves points along their
    // normals, feeds on itself there: the tail keeps its line by its lengths and the body's pull alone. The peak
    // over the crown is drawn to a point too, and so is the tip of every petal of the brim: the peak and the hem
    // itself are let off in the same way.
    const limp = (tail[v]! + peak[v]!) * 1.6 + rim[v]!;
    if (k < 2 || limp >= 1) continue;
    const soft = give / ((1 - limp) * (1 - limp));
    let mx = 0;
    let my = 0;
    let mz = 0;
    let wsum = 0;
    for (let r = from; r < to; r += 1) {
      const o = ring[r]!;
      mx += pos[3 * o]!;
      my += pos[3 * o + 1]!;
      mz += pos[3 * o + 2]!;
      wsum += invMass[o]!;
    }
    const nx = normal[i]!;
    const ny = normal[i + 1]!;
    const nz = normal[i + 2]!;
    const out = (pos[i]! - mx / k) * nx + (pos[i + 1]! - my / k) * ny + (pos[i + 2]! - mz / k) * nz - curve[v]!;
    const w = invMass[v]!;
    const move = -out / (w + wsum / (k * k) + soft);
    const own = move * w;
    pos[i] = pos[i]! + nx * own;
    pos[i + 1] = pos[i + 1]! + ny * own;
    pos[i + 2] = pos[i + 2]! + nz * own;
    const each = -move / k;
    for (let r = from; r < to; r += 1) {
      const o = ring[r]!;
      const share = each * invMass[o]!;
      pos[3 * o] = pos[3 * o]! + nx * share;
      pos[3 * o + 1] = pos[3 * o + 1]! + ny * share;
      pos[3 * o + 2] = pos[3 * o + 2]! + nz * share;
    }
  }
}

/** The skirt is hollow: no point of it comes nearer the body's middle line than `least`, so its far side stays far. */
function keepHollow(cloth: Cloth): void {
  const { pos, least, spine, sheet } = cloth;
  const ox = spine[0]!;
  const oy = spine[1]!;
  const oz = spine[2]!;
  const ax = spine[3]!;
  const ay = spine[4]!;
  const az = spine[5]!;
  for (let v = 0, i = 0; v < sheet.count; v += 1, i += 3) {
    const room = least[v]!;
    if (room <= 0) continue;
    const dx = pos[i]! - ox;
    const dy = pos[i + 1]! - oy;
    const dz = pos[i + 2]! - oz;
    const along = dx * ax + dy * ay + dz * az;
    const rx = dx - ax * along;
    const ry = dy - ay * along;
    const rz = dz - az * along;
    const out = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (out >= room || out < 1e-6) continue;
    const push = (room - out) / out;
    pos[i] = pos[i]! + rx * push;
    pos[i + 1] = pos[i + 1]! + ry * push;
    pos[i + 2] = pos[i + 2]! + rz * push;
  }
}

/** The cloth is worn over a body: no point of the skirt comes inside it. */
function keepOff(cloth: Cloth): void {
  const { pos, body, sheet } = cloth;
  const room = body[3]!;
  if (room <= 0) return;
  const cx = body[0]!;
  const cy = body[1]!;
  const cz = body[2]!;
  const { skirt } = sheet;
  for (let v = 0, i = 0; v < sheet.count; v += 1, i += 3) {
    if (skirt[v]! <= 0) continue;
    const dx = pos[i]! - cx;
    const dy = pos[i + 1]! - cy;
    const dz = pos[i + 2]! - cz;
    const out = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (out >= room || out < 1e-6) continue;
    const push = (room - out) / out;
    pos[i] = pos[i]! + dx * push;
    pos[i + 1] = pos[i + 1]! + dy * push;
    pos[i + 2] = pos[i + 2]! + dz * push;
  }
}

function substep(cloth: Cloth, h: number): void {
  const { pos, prev, vel, normal, target, wind, pull, steady, carry, gravity, feel, sheet } = cloth;
  const n = sheet.count;
  const across = 1 - Math.exp(-feel.dragAcross * h);
  const along = 1 - Math.exp(-feel.dragAlong * h);
  const gx = gravity[0] * h;
  const gy = gravity[1] * h;
  const gz = gravity[2] * h;
  for (let v = 0, i = 0; v < n; v += 1, i += 3) {
    // The air through the face carries the point with it; the air along the face only brushes it.
    const rx = wind[i]! - vel[i]!;
    const ry = wind[i + 1]! - vel[i + 1]!;
    const rz = wind[i + 2]! - vel[i + 2]!;
    const through = rx * normal[i]! + ry * normal[i + 1]! + rz * normal[i + 2]!;
    const lift = through * (across - along);
    const vx = vel[i]! + normal[i]! * lift + rx * along + gx;
    const vy = vel[i + 1]! + normal[i + 1]! * lift + ry * along + gy;
    const vz = vel[i + 2]! + normal[i + 2]! * lift + rz * along + gz;
    prev[i] = pos[i]!;
    prev[i + 1] = pos[i + 1]!;
    prev[i + 2] = pos[i + 2]!;
    pos[i] = pos[i]! + vx * h;
    pos[i + 1] = pos[i + 1]! + vy * h;
    pos[i + 2] = pos[i + 2]! + vz * h;
  }
  const hh = h * h;
  keepApart(pos, sheet.edges, cloth.rest, sheet.invMass, cloth.stretch / hh);
  keepApart(pos, sheet.spans, cloth.span, sheet.invMass, cloth.crumple / hh);
  keepRound(cloth, cloth.crease / hh);
  for (let v = 0, i = 0; v < n; v += 1, i += 3) {
    const k = pull[v]! * hh;
    const s = k / (1 + k);
    pos[i] = pos[i]! + (target[i]! - pos[i]!) * s;
    pos[i + 1] = pos[i + 1]! + (target[i + 1]! - pos[i + 1]!) * s;
    pos[i + 2] = pos[i + 2]! + (target[i + 2]! - pos[i + 2]!) * s;
  }
  keepHollow(cloth);
  keepOff(cloth);
  const rate = 1 / h;
  for (let v = 0, i = 0; v < n; v += 1, i += 3) {
    const keep = Math.exp(-steady[v]! * h);
    vel[i] = carry[i]! + ((pos[i]! - prev[i]!) * rate - carry[i]!) * keep;
    vel[i + 1] = carry[i + 1]! + ((pos[i + 1]! - prev[i + 1]!) * rate - carry[i + 1]!) * keep;
    vel[i + 2] = carry[i + 2]! + ((pos[i + 2]! - prev[i + 2]!) * rate - carry[i + 2]!) * keep;
  }
  // Silk: neighbours even out their speeds, so a ripple is a long soft thing and never a rattle.
  const silk = cloth.silk;
  if (silk > 0) {
    const edges = sheet.edges;
    for (let e = 0; e < edges.length; e += 2) {
      const a = 3 * edges[e]!;
      const b = 3 * edges[e + 1]!;
      const dx = (vel[b]! - vel[a]!) * silk;
      const dy = (vel[b + 1]! - vel[a + 1]!) * silk;
      const dz = (vel[b + 2]! - vel[a + 2]!) * silk;
      vel[a] = vel[a]! + dx;
      vel[a + 1] = vel[a + 1]! + dy;
      vel[a + 2] = vel[a + 2]! + dz;
      vel[b] = vel[b]! - dx;
      vel[b + 1] = vel[b + 1]! - dy;
      vel[b + 2] = vel[b + 2]! - dz;
    }
  }
}

/** Advances the cloth by `dt` towards `target` in the air `wind`. */
export function stepCloth(cloth: Cloth, dt: number): void {
  if (dt <= 0) return;
  const steps = Math.min(MOST_STEPS, Math.ceil(dt / STEP));
  const h = dt / steps;
  const { carry, target, targetWas } = cloth;
  for (let i = 0; i < target.length; i += 1) {
    carry[i] = (target[i]! - targetWas[i]!) / dt;
    targetWas[i] = target[i]!;
  }
  for (let k = 0; k < steps; k += 1) substep(cloth, h);
  updateNormals(cloth);
}
