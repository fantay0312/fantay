// SPDX-License-Identifier: AGPL-3.0-only
// The surface that is drawn. The cloth (mascot-sheet.ts, mascot-cloth.ts) is a grid coarse enough to be stepped as
// cloth many times a frame, and drawn as it is its outline is a run of straight edges: the round of the head has
// corners and the folds of the hem are zigzags. The skin is the same surface several times finer, laid through the
// cloth's own vertices as a smooth curve in both directions, so the outline is a curve at any size. It is worked out
// once a frame from wherever the cloth is, and nothing of the cloth's motion is changed by it. Pure numbers.
import type { Sheet } from './mascot-sheet';

export interface Skin {
  sheet: Sheet;
  /** How many of its vertices there are to one of the cloth's, across and down. */
  up: number;
  cols: number;
  rows: number;
  /** Vertices: the crown, then each column from the top down, as the cloth's are. */
  count: number;
  /** Triangles, counter-clockwise seen from outside. */
  triangles: Uint16Array;
  /** Per vertex, how far down the skirt it is. */
  fall: Float32Array;
  /** Per vertex, where it lies about the middle of the head at ease: its place on the cloth, that the stars in the
   *  cloth are set by. */
  home: Float32Array;
  /** The share each of four neighbours has in a vertex that lies `m` steps of `up` past the second of them. */
  weights: Float32Array;
  /** Scratch: one column of the cloth with two vertices added past each end, and the cloth made finer down its
   *  columns only. */
  line: Float32Array;
  ladder: Float32Array;
}

/** How many times finer than the cloth the skin is: the cloth that is seen large is cut finest and smoothed most. */
function upFor(sheet: Sheet): number {
  return sheet.spacing >= 48 ? 2 : 3;
}

/** Lays the skin through the cloth lying at `src`, [x, y, z] triples in the cloth's order, and writes it to `dst` in
 *  the skin's. Each curve passes through the cloth's own vertices and leaves each as the line between its two
 *  neighbours runs (Catmull-Rom). Over the crown a column carries on down the column opposite, and round the body
 *  the columns close on themselves, so the surface has no seam and no point but the crown. */
export function drapeSkin(skin: Skin, src: Float32Array, dst: Float32Array): void {
  const { sheet, up, weights, line, ladder } = skin;
  const cols = sheet.cols;
  const rows = sheet.domeRows + sheet.skirtRows;
  const fineRows = rows * up;
  dst[0] = src[0]!;
  dst[1] = src[1]!;
  dst[2] = src[2]!;

  // Down each column. `line` holds it as: the first row of the column opposite, the crown, its own rows, and two
  // more carried straight on past the hem.
  const hem = 3 * (rows + 1);
  for (let c = 0; c < cols; c += 1) {
    const own = 3 * (1 + c * rows);
    const opposite = 3 * (1 + ((c + cols / 2) % cols) * rows);
    for (let a = 0; a < 3; a += 1) {
      line[a] = src[opposite + a]!;
      line[3 + a] = src[a]!;
    }
    for (let i = 0; i < 3 * rows; i += 1) line[6 + i] = src[own + i]!;
    for (let a = 0; a < 3; a += 1) {
      line[hem + 3 + a] = 2 * line[hem + a]! - line[hem - 3 + a]!;
      line[hem + 6 + a] = 2 * line[hem + a]! - line[hem - 6 + a]!;
    }
    let out = 3 * c * fineRows;
    for (let k = 1; k <= fineRows; k += 1) {
      // Between the cloth's rows `at` and `at + 1`, the crown being row 0: `line` has row `at - 1` at 3 * at.
      const at = Math.floor(k / up);
      const w = 4 * (k - at * up);
      const p = 3 * at;
      const w0 = weights[w]!;
      const w1 = weights[w + 1]!;
      const w2 = weights[w + 2]!;
      const w3 = weights[w + 3]!;
      ladder[out] = w0 * line[p]! + w1 * line[p + 3]! + w2 * line[p + 6]! + w3 * line[p + 9]!;
      ladder[out + 1] = w0 * line[p + 1]! + w1 * line[p + 4]! + w2 * line[p + 7]! + w3 * line[p + 10]!;
      ladder[out + 2] = w0 * line[p + 2]! + w1 * line[p + 5]! + w2 * line[p + 8]! + w3 * line[p + 11]!;
      out += 3;
    }
  }

  // Round the body, row by row.
  const stride = 3 * fineRows;
  for (let j = 0; j < cols; j += 1) {
    const a = ((j + cols - 1) % cols) * stride;
    const b = j * stride;
    const c = ((j + 1) % cols) * stride;
    const d = ((j + 2) % cols) * stride;
    for (let m = 0; m < up; m += 1) {
      const w0 = weights[4 * m]!;
      const w1 = weights[4 * m + 1]!;
      const w2 = weights[4 * m + 2]!;
      const w3 = weights[4 * m + 3]!;
      let out = 3 + (j * up + m) * stride;
      for (let i = 0; i < stride; i += 1) {
        dst[out] = w0 * ladder[a + i]! + w1 * ladder[b + i]! + w2 * ladder[c + i]! + w3 * ladder[d + i]!;
        out += 1;
      }
    }
  }
}

/** Unit normals out of the outside of the skin lying at `pos`, written to `normal`. */
export function skinNormals(skin: Skin, pos: Float32Array, normal: Float32Array): void {
  const tris = skin.triangles;
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

/** Cuts the skin for a sheet of cloth. */
export function buildSkin(sheet: Sheet): Skin {
  const up = upFor(sheet);
  const coarseRows = sheet.domeRows + sheet.skirtRows;
  const cols = sheet.cols * up;
  const rows = coarseRows * up;
  const count = 1 + cols * rows;
  const at = (c: number, r: number) => 1 + (((c % cols) + cols) % cols) * rows + (r - 1);

  const weights = new Float32Array(4 * (up + 1));
  for (let m = 0; m <= up; m += 1) {
    const t = m / up;
    const t2 = t * t;
    const t3 = t2 * t;
    weights[4 * m] = -0.5 * t3 + t2 - 0.5 * t;
    weights[4 * m + 1] = 1.5 * t3 - 2.5 * t2 + 1;
    weights[4 * m + 2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
    weights[4 * m + 3] = 0.5 * t3 - 0.5 * t2;
  }

  // A fan round the crown, then quads cut on alternate diagonals, as the cloth's are.
  const tris: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    tris.push(0, at(c, 1), at(c + 1, 1));
    for (let r = 1; r < rows; r += 1) {
      const a = at(c, r);
      const b = at(c + 1, r);
      const d = at(c, r + 1);
      const e = at(c + 1, r + 1);
      if ((c + r) % 2 === 0) tris.push(a, d, b, b, d, e);
      else tris.push(a, d, e, a, e, b);
    }
  }

  const skin: Skin = {
    sheet,
    up,
    cols,
    rows,
    count,
    triangles: Uint16Array.from(tris),
    fall: new Float32Array(count),
    home: new Float32Array(3 * count),
    weights,
    line: new Float32Array(3 * (coarseRows + 4)),
    ladder: new Float32Array(3 * sheet.cols * rows),
  };
  drapeSkin(skin, sheet.rest, skin.home);
  for (let c = 0; c < cols; c += 1) {
    for (let r = 1; r <= rows; r += 1) {
      const down = r / up - sheet.domeRows;
      skin.fall[at(c, r)] = down <= 0 ? 0 : down / sheet.skirtRows;
    }
  }
  return skin;
}

const skins = new WeakMap<Sheet, Skin>();

/** The skin for a sheet of cloth, cut once and shared: its scratch is only good within one call. */
export function skinFor(sheet: Sheet): Skin {
  let skin = skins.get(sheet);
  if (!skin) {
    skin = buildSkin(sheet);
    skins.set(sheet, skin);
  }
  return skin;
}
