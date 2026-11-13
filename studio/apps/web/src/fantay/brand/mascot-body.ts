// SPDX-License-Identifier: AGPL-3.0-only
// The spirit under the cloth. The cloth is its hood and cape; this is what wears them: a small round body, pale, with
// its face on the front and its underside drawn down into a wisp, as a ghost's is. It is not cloth and is not
// simulated: it is one shape, cut once, and it turns, stretches and is put in its place with the head
// (mascot-stage.ts). Its measures are in mascot-sheet.ts, beside the cloth's, because the cloth is cut to fit it.
// Pure numbers.
import { BODY, HANDS, handAt } from './mascot-sheet';

export interface Body {
  /** Vertices: [x, y, z] triples about the middle of the head, x right, y up, z towards the viewer. */
  count: number;
  positions: Float32Array;
  normals: Float32Array;
  /** Per vertex: how much of the wisp it is, 0 on the body's round to 1 at the wisp's tip. */
  wisp: Float32Array;
  /** Per vertex: 1 on the right hand, -1 on the left, 0 on the body. The hands are cut where they rest, and the
   *  stage moves each as one piece. */
  limb: Float32Array;
  /** Triangles, counter-clockwise seen from outside. */
  triangles: Uint16Array;
}

/** Cuts the body with `rings` rings between its poles and half as many again round it, and its two hands, each a
 *  small ball a third as fine. */
export function buildBody(rings: number): Body {
  const round = Math.round(rings * 1.5);
  const handRings = Math.max(6, Math.round(rings / 3));
  const handRound = Math.round(handRings * 1.5);
  const bodyCount = 2 + (rings - 1) * round;
  const handCount = 2 + (handRings - 1) * handRound;
  const count = bodyCount + 2 * handCount;
  const positions = new Float32Array(3 * count);
  const wisp = new Float32Array(count);
  const limb = new Float32Array(count);
  const at = (ring: number, c: number) => 1 + (ring - 1) * round + (((c % round) + round) % round);
  const place = (v: number, down: number, turn: number) => {
    // `down` is 0 at the top of the body and 1 at the tip of the wisp.
    const angle = Math.PI * down;
    const t = down <= BODY.from ? 0 : (down - BODY.from) / (1 - BODY.from);
    const ring = BODY.radius * Math.sin(angle) * (1 - BODY.slim * t);
    positions[3 * v] = ring * Math.sin(turn);
    positions[3 * v + 1] = -BODY.low + BODY.radius * Math.cos(angle) - BODY.wisp * t * t;
    positions[3 * v + 2] = ring * Math.cos(turn) - BODY.back * t * t;
    wisp[v] = t;
  };
  place(0, 0, 0);
  for (let ring = 1; ring < rings; ring += 1) {
    for (let c = 0; c < round; c += 1) place(at(ring, c), ring / rings, (2 * Math.PI * c) / round);
  }
  const tip = bodyCount - 1;
  place(tip, 1, 0);

  const tris: number[] = [];
  for (let c = 0; c < round; c += 1) {
    tris.push(0, at(1, c), at(1, c + 1));
    for (let ring = 1; ring < rings - 1; ring += 1) {
      const a = at(ring, c);
      const b = at(ring, c + 1);
      const d = at(ring + 1, c);
      const e = at(ring + 1, c + 1);
      tris.push(a, d, b, b, d, e);
    }
    tris.push(tip, at(rings - 1, c + 1), at(rings - 1, c));
  }

  // The hands: a ball each, where they rest.
  const [restX, restY] = handAt(0);
  for (const side of [1, -1]) {
    const first = side === 1 ? bodyCount : bodyCount + handCount;
    const on = (ring: number, c: number) => first + 1 + (ring - 1) * handRound + (((c % handRound) + handRound) % handRound);
    const put = (v: number, down: number, turn: number) => {
      const angle = Math.PI * down;
      const ring = HANDS.radius * Math.sin(angle);
      positions[3 * v] = side * restX + ring * Math.sin(turn);
      positions[3 * v + 1] = restY + HANDS.radius * Math.cos(angle);
      positions[3 * v + 2] = HANDS.forward + ring * Math.cos(turn);
      limb[v] = side;
    };
    put(first, 0, 0);
    for (let ring = 1; ring < handRings; ring += 1) {
      for (let c = 0; c < handRound; c += 1) put(on(ring, c), ring / handRings, (2 * Math.PI * c) / handRound);
    }
    const last = first + handCount - 1;
    put(last, 1, 0);
    for (let c = 0; c < handRound; c += 1) {
      tris.push(first, on(1, c), on(1, c + 1));
      for (let ring = 1; ring < handRings - 1; ring += 1) {
        const a = on(ring, c);
        const b = on(ring, c + 1);
        const d = on(ring + 1, c);
        const e = on(ring + 1, c + 1);
        tris.push(a, d, b, b, d, e);
      }
      tris.push(last, on(handRings - 1, c + 1), on(handRings - 1, c));
    }
  }

  const normals = new Float32Array(3 * count);
  for (let i = 0; i < tris.length; i += 3) {
    const a = 3 * tris[i]!;
    const b = 3 * tris[i + 1]!;
    const c = 3 * tris[i + 2]!;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const p of [a, b, c]) {
      normals[p] = normals[p]! + nx;
      normals[p + 1] = normals[p + 1]! + ny;
      normals[p + 2] = normals[p + 2]! + nz;
    }
  }
  for (let v = 0; v < normals.length; v += 3) {
    const l = Math.hypot(normals[v]!, normals[v + 1]!, normals[v + 2]!) || 1;
    normals[v] = normals[v]! / l;
    normals[v + 1] = normals[v + 1]! / l;
    normals[v + 2] = normals[v + 2]! / l;
  }
  return { count, positions, normals, wisp, limb, triangles: Uint16Array.from(tris) };
}

const bodies = new Map<number, Body>();

/** The body at a given fineness, cut once and shared: it is never written to. */
export function bodyFor(rings: number): Body {
  let body = bodies.get(rings);
  if (!body) {
    body = buildBody(rings);
    bodies.set(rings, body);
  }
  return body;
}
