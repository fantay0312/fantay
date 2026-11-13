// SPDX-License-Identifier: AGPL-3.0-only
// What the living mascot is drawn as: the smooth skin over its cloth, and the body under it.
import { describe, expect, it } from 'vitest';

import { buildBody } from '../../../src/fantay/brand/mascot-body';
import { BODY, HANDS, buildSheet, handAt } from '../../../src/fantay/brand/mascot-sheet';
import { buildSkin, drapeSkin, skinNormals } from '../../../src/fantay/brand/mascot-skin';

describe('the skin over the cloth', () => {
  for (const fineness of [24, 32, 48]) {
    it(`passes through every vertex of the cloth cut at ${fineness}, and is a curve between them`, () => {
      const sheet = buildSheet(fineness);
      const skin = buildSkin(sheet);
      const rows = sheet.domeRows + sheet.skirtRows;
      expect(skin.count).toBe(1 + sheet.cols * skin.up * rows * skin.up);
      expect(Math.max(...skin.triangles)).toBeLessThan(skin.count);
      const fine = new Float32Array(3 * skin.count);
      drapeSkin(skin, sheet.rest, fine);
      // The crown, and each of the cloth's vertices where the skin has its own on the same column and row.
      for (let a = 0; a < 3; a += 1) expect(fine[a]).toBe(sheet.rest[a]);
      let worst = 0;
      for (let c = 0; c < sheet.cols; c += 1) {
        for (let r = 1; r <= rows; r += 1) {
          const from = 3 * (1 + c * rows + (r - 1));
          const to = 3 * (1 + c * skin.up * skin.rows + (r * skin.up - 1));
          for (let a = 0; a < 3; a += 1) worst = Math.max(worst, Math.abs(fine[to + a]! - sheet.rest[from + a]!));
        }
      }
      expect(worst).toBeLessThan(1e-6);
      // Between two of the cloth's vertices on the round of the head the skin bulges out past the straight edge.
      const row = sheet.domeRows;
      const a = 3 * (1 + (row * skin.up - 1));
      const b = 3 * (1 + skin.up * skin.rows + (row * skin.up - 1));
      const mid = 3 * (1 + Math.round(skin.up / 2) * skin.rows + (row * skin.up - 1));
      const chord = Math.hypot((fine[a]! + fine[b]!) / 2, (fine[a + 2]! + fine[b + 2]!) / 2);
      expect(Math.hypot(fine[mid]!, fine[mid + 2]!)).toBeGreaterThan(chord);
      // Its outside faces out: on the front of the head the normals point at the viewer.
      const normal = new Float32Array(3 * skin.count);
      skinNormals(skin, fine, normal);
      expect(normal[a + 2]!).toBeGreaterThan(0.5);
    });
  }
});

describe('the body under the cloth', () => {
  it('is a closed round body whose underside is drawn down into a wisp', () => {
    const body = buildBody(20);
    expect(Math.max(...body.triangles)).toBeLessThan(body.count);
    // Every normal of the body itself points out of it.
    let tip = 0;
    for (let v = 0; v < body.count; v += 1) {
      if (body.limb[v] !== 0) continue;
      const out = body.positions[3 * v]! * body.normals[3 * v]! + (body.positions[3 * v + 1]! + BODY.low) * body.normals[3 * v + 1]! + body.positions[3 * v + 2]! * body.normals[3 * v + 2]!;
      expect(out).toBeGreaterThan(0);
      if (body.wisp[v]! > body.wisp[tip]!) tip = v;
    }
    // The tip of the wisp is its lowest point, below the round of the body.
    expect(body.wisp[tip]).toBe(1);
    let lowest = Infinity;
    for (let v = 0; v < body.count; v += 1) lowest = Math.min(lowest, body.positions[3 * v + 1]!);
    expect(body.positions[3 * tip + 1]).toBe(lowest);
    expect(lowest).toBeLessThan(-BODY.low - BODY.radius - 0.05);
    // Above the wisp it is a ball: its front is one radius in front of its middle.
    let front = -Infinity;
    for (let v = 0; v < body.count; v += 1) if (body.limb[v] === 0) front = Math.max(front, body.positions[3 * v + 2]!);
    expect(front).toBeCloseTo(BODY.radius, 2);
  });

  it('has a hand at either side, each a small ball that is raised about its shoulder', () => {
    const body = buildBody(20);
    const [restX, restY] = handAt(0);
    for (const side of [1, -1]) {
      let n = 0;
      let x = 0;
      let y = 0;
      for (let v = 0; v < body.count; v += 1) {
        if (body.limb[v] !== side) continue;
        n += 1;
        x += body.positions[3 * v]!;
        y += body.positions[3 * v + 1]!;
        // Every point of a hand is one radius from its middle.
        expect(Math.hypot(body.positions[3 * v]! - side * restX, body.positions[3 * v + 1]! - restY, body.positions[3 * v + 2]! - HANDS.forward)).toBeCloseTo(HANDS.radius, 5);
      }
      expect(n).toBeGreaterThan(20);
      expect(x / n).toBeCloseTo(side * restX, 2);
      expect(y / n).toBeCloseTo(restY, 2);
    }
    // Raised, the hand is higher and further out, and as far from its shoulder as it was.
    const [upX, upY] = handAt(1);
    expect(upY).toBeGreaterThan(restY + 0.2);
    expect(upX).toBeGreaterThan(restX);
    expect(Math.hypot(upX - HANDS.pivot[0], upY - HANDS.pivot[1])).toBeCloseTo(HANDS.reach, 6);
  });
});
