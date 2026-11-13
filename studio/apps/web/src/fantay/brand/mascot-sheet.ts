// SPDX-License-Identifier: AGPL-3.0-only
// The cloth the mascot wears: a square of magic cloth over a small spirit (mascot-body.ts), blue outside and coral
// inside. It is the spirit's hood and cape. Over the round of its head it is a dome, drawn up above the crown into a
// soft cap whose end has fallen over to one side. Below that it is a brim of petals: short over the face, one petal hanging between the eyes and the
// hem drawn up over each of them, so the spirit looks out from under it; longer at the sides, where the spirit has a
// hand under the cloth on its right, which it can raise so the cloth is held out like a sleeve; and longest behind,
// where it falls as a cape whose coral lining shows to either side of the body.
//
// The cloth is a grid: columns run from the crown down to the hem, rows run round. `poseSheet` lays the grid out for
// any pose of the body, and each column of the skirt is paid out at a fixed length, so spreading the skirt or lifting
// a corner bends the cloth and never stretches it along its fall. Nothing here knows about colour or about time.
// Pure numbers: it builds without a page.

const DEG = Math.PI / 180;

/** The middle of the head in the mascot's box, which spans -1..1 with x right, y up and z towards the viewer, and the
 *  head's radius. The body is laid out around this point and turns about it. It stands in the middle of its box. */
export const HEAD = { x: 0, y: 0.02, radius: 0.66 } as const;

/** The spirit itself, under the cloth: a small round body. Its radius; how far below the middle of the head its own
 *  middle is, so that its face shows beneath the cloth's brim; and the wisp its underside is drawn down into: how
 *  long, how far it trails back, from what share of the way down the body it begins, and how much it is drawn in. */
export const BODY = { radius: 0.55, low: 0.21, wisp: 0.12, back: 0.08, from: 0.88, slim: 0.15 } as const;

/** The spirit's two hands, small and round, at its sides below the cloth's brim. Their radius; where the right one
 *  rests, about the middle of the head (the left is its mirror); and how it is raised: about a shoulder at `pivot`,
 *  on an arm `reach` long that hangs `rest` out of plumb and swings up through `sweep` when the hand is right up. */
export const HANDS = {
  radius: 0.1,
  forward: 0.16,
  pivot: [0.42, -0.27],
  reach: 0.25,
  rest: 33 * DEG,
  sweep: 108 * DEG,
} as const;

/** Where the right hand is, about the middle of the head, [x, y], when it is raised by `lift`: 0 at rest, 1 right up. */
export function handAt(lift: number): [number, number] {
  const angle = HANDS.rest + HANDS.sweep * lift;
  return [HANDS.pivot[0] + HANDS.reach * Math.sin(angle), HANDS.pivot[1] - HANDS.reach * Math.cos(angle)];
}

/** The eyes, on the front of the body: how far apart their centres are, how far below the middle of the head, and
 *  their two radii. `small` is how much larger they are drawn at the smallest sizes. */
export const FACE = { apart: 0.55, low: 0.285, rx: 0.138, ry: 0.176, small: 1.1 } as const;

/** Where the dome ends and the skirt begins, as an angle down from the crown: a little above the head's widest part,
 *  so the cloth is still going outwards as it leaves and the body under the head is rounded, not a cone. */
const DOME_END = 84 * DEG;

/** The hat the cloth is drawn up into above the head: one soft cap, as a nightcap is. It is cloth and cannot stand as
 *  a cone does. It leaves the round of the head without a corner, roomy over the crown and fullest on the side away
 *  from its fall; its top is round, not a point, because the point has given and fallen over to the mascot's right;
 *  where it folds its inside is gathered into a crease; and what is left of it is a long slim tail that goes over in
 *  one curve and hangs down beside the hat, with the spirit's light at its end (`ORB`).
 *
 *  How far down from the crown its foot is; how far towards the viewer its end is carried, so that the orb hangs in
 *  front of the hat and not behind it; how much more loosely than the head its end is held, which is only a little:
 *  it nods and swings because the body swings it (the pose), and a tube of cloth left to the air twists and shows
 *  its lining; the share of the dome's rows it is given; how a swing of the part that hangs (`SheetPose.tip`) is
 *  shared out along it: it turns at the fold and goes on turning, less and less, to its end, and the higher this is
 *  the more of the turning is at the fold; the share of the way up the hat from which its end curls on its own
 *  (`SheetPose.curl`), and the power that curl follows from there to the end; and how much fuller it grows for
 *  what it sinks on the head (`SheetPose.sag`), most half way up it. */
export const PEAK = { span: 65 * DEG, forward: 0.12, loose: 0.15, rows: 0.75, whip: 2.2, curl: 0.66, curve: 1.5, swell: 0.5 } as const;

/** The hat as it is seen from the front, about the middle of the head. From just above its foot to its fold it is
 *  given by its two outlines and how deep it is from front to back at each step: `outside` is the side away from its
 *  fall, up and over the top; `inside` is the side it falls to, up to the crease. Each ring of the cloth lies
 *  between the two at the same step, so the rings fan out round the crease and none crosses another. Past the fold
 *  it is the tail that hangs, `fall`: the middle of it at each step and half its width there. It is round, as deep
 *  as it is wide, and it only narrows. */
const HAT = {
  outside: [
    [-0.46, 0.58],
    [-0.37, 0.8],
    [-0.21, 0.955],
    [0.04, 1.01],
  ],
  inside: [
    [0.49, 0.5],
    [0.43, 0.6],
    [0.35, 0.685],
    [0.3, 0.72],
  ],
  depth: [0.46, 0.38, 0.29, 0.2],
  fall: [
    [0.33, 0.842, 0.124],
    [0.47, 0.77, 0.093],
    [0.578, 0.678, 0.073],
    [0.645, 0.562, 0.059],
    [0.68, 0.446, 0.048],
    [0.694, 0.335, 0.038],
  ],
} as const;

/** The share of the way up the hat at which it folds: below it the hat stays on the head, past it the tail hangs. */
const FOLD = HAT.inside.length / (HAT.inside.length + HAT.fall.length);

/** The spirit's light, a small orb hung from the end of the hat's tail: its radius, and how far from the tail's end
 *  its middle hangs, in its own radii. */
export const ORB = { radius: 0.105, hang: 0.9 } as const;

/** How far down from the crown row `r` of the dome's `rows` is, as an angle. A good share of the rows (`PEAK.rows`)
 *  is spent on the tip, where the cloth curves most. */
function domeAngle(r: number, rows: number): number {
  const t = r / rows;
  return t <= PEAK.rows ? PEAK.span * (t / PEAK.rows) : PEAK.span + (DOME_END - PEAK.span) * ((t - PEAK.rows) / (1 - PEAK.rows));
}

/** A smooth line through evenly spaced values, read at `at` steps along them: it passes through each and leaves it
 *  as the line between its two neighbours runs (Catmull-Rom). `before` is the value a step before the first. */
function through(values: readonly number[], before: number, at: number): number {
  const last = values.length - 1;
  const i = Math.min(last - 1, Math.max(0, Math.floor(at)));
  const u = at - i;
  const a = i > 0 ? values[i - 1]! : before;
  const b = values[i]!;
  const c = values[i + 1]!;
  const d = i + 2 <= last ? values[i + 2]! : 2 * c - b;
  return 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u);
}

/** The hat's two outlines and its depth, walked once from its foot to its end in even steps, about the middle of its
 *  foot. Both outlines start on the round of the head at the hat's foot and leave it the way the head's round is
 *  going there: the step before the first is taken from the head itself. The tail's outlines stand off its middle
 *  line squarely, half its width to either side. */
const TIP_STEPS = 60;
const TIP_PATH = (() => {
  const outX = new Float32Array(TIP_STEPS + 1);
  const outY = new Float32Array(TIP_STEPS + 1);
  const inX = new Float32Array(TIP_STEPS + 1);
  const inY = new Float32Array(TIP_STEPS + 1);
  const deep = new Float32Array(TIP_STEPS + 1);
  const footOut = HEAD.radius * Math.sin(PEAK.span);
  const footUp = HEAD.radius * Math.cos(PEAK.span);
  // The head's round a step below the foot: as far below it as the first step is above.
  const below = PEAK.span + (HAT.outside[0][1] - footUp) / HEAD.radius;
  const lowOut = HEAD.radius * Math.sin(below);
  const lowUp = HEAD.radius * Math.cos(below);
  const outsideX = [-footOut, ...HAT.outside.map((p) => p[0])];
  const outsideY = [footUp, ...HAT.outside.map((p) => p[1])];
  const insideX = [footOut, ...HAT.inside.map((p) => p[0])];
  const insideY = [footUp, ...HAT.inside.map((p) => p[1])];
  const depth = [footOut, ...HAT.depth];
  // The tail: at each step it runs the way the line from the step before to the step after does, and the first of it
  // follows on from the middle of the ring at the fold.
  const fold = HAT.inside.length - 1;
  const middle: [number, number][] = [
    [(HAT.outside[fold]![0] + HAT.inside[fold]![0]) / 2, (HAT.outside[fold]![1] + HAT.inside[fold]![1]) / 2],
    ...HAT.fall.map((p): [number, number] => [p[0], p[1]]),
  ];
  for (let k = 1; k < middle.length; k += 1) {
    const before = middle[k - 1]!;
    const after = middle[Math.min(middle.length - 1, k + 1)]!;
    const run = Math.hypot(after[0] - before[0], after[1] - before[1]);
    const half = HAT.fall[k - 1]![2];
    const acrossX = (-(after[1] - before[1]) / run) * half;
    const acrossY = ((after[0] - before[0]) / run) * half;
    outsideX.push(middle[k]![0] + acrossX);
    outsideY.push(middle[k]![1] + acrossY);
    insideX.push(middle[k]![0] - acrossX);
    insideY.push(middle[k]![1] - acrossY);
    depth.push(half);
  }
  const steps = depth.length - 1;
  for (let i = 0; i <= TIP_STEPS; i += 1) {
    const at = (i / TIP_STEPS) * steps;
    outX[i] = through(outsideX, -lowOut, at);
    outY[i] = through(outsideY, lowUp, at) - footUp;
    inX[i] = through(insideX, lowOut, at);
    inY[i] = through(insideY, lowUp, at) - footUp;
    deep[i] = through(depth, lowOut, at);
  }
  return { outX, outY, inX, inY, deep };
})();

/** How much of a swing of the hat's tail a ring has turned by, at a share `peak` of the way up the hat: nothing at
 *  the fold and below, all of it at the end, and most of it soon after the fold. */
function swingOf(peak: number): number {
  return peak <= FOLD ? 0 : 1 - Math.pow((1 - peak) / (1 - FOLD), PEAK.whip);
}

/** How much of the curl of the tail's end a ring has turned by: nothing over most of the tail, all of it at the end. */
function curlOf(peak: number): number {
  return peak <= PEAK.curl ? 0 : Math.pow((peak - PEAK.curl) / (1 - PEAK.curl), PEAK.curve);
}

/** The hat's two outlines as they are in a pose, walked as `TIP_PATH` is, about the middle of its foot: sunk or
 *  lifted, and from the fold on bent. Written afresh for every pose. */
const BENT = {
  outX: new Float32Array(TIP_STEPS + 1),
  outY: new Float32Array(TIP_STEPS + 1),
  inX: new Float32Array(TIP_STEPS + 1),
  inY: new Float32Array(TIP_STEPS + 1),
};

/** Lays the hat's outlines out for `pose`. Sunk on the head it is lower all the way up and fuller about its middle;
 *  lifted off it, the other way. Swung or curled, the tail bends as cloth does and is not sheared: its underside is
 *  walked on from the crease step by step, each step turned by what the tail has turned by there, and each ring
 *  stands off the underside turned the same, so the tail keeps its length and its width however it is bent. */
function bendHat(pose: SheetPose): void {
  const low = 1 - pose.sag;
  let turned = 0;
  let lastX = 0;
  let lastY = 0;
  for (let i = 0; i <= TIP_STEPS; i += 1) {
    const peak = i / TIP_STEPS;
    const fuller = 1 + PEAK.swell * pose.sag * Math.sin(Math.PI * peak);
    const ox = TIP_PATH.outX[i]! * fuller;
    const oy = TIP_PATH.outY[i]! * low;
    const ix = TIP_PATH.inX[i]! * fuller;
    const iy = TIP_PATH.inY[i]! * low;
    const turn = pose.tip * swingOf(peak) + pose.curl * curlOf(peak);
    if (turn === 0 && turned === 0) {
      BENT.outX[i] = ox;
      BENT.outY[i] = oy;
      BENT.inX[i] = ix;
      BENT.inY[i] = iy;
    } else {
      const half = (turn + turned) / 2;
      const ch = Math.cos(half);
      const sh = Math.sin(half);
      const bx = BENT.inX[i - 1]! + (ix - lastX) * ch + (iy - lastY) * sh;
      const by = BENT.inY[i - 1]! + (iy - lastY) * ch - (ix - lastX) * sh;
      const ct = Math.cos(turn);
      const st = Math.sin(turn);
      BENT.inX[i] = bx;
      BENT.inY[i] = by;
      BENT.outX[i] = bx + (ox - ix) * ct + (oy - iy) * st;
      BENT.outY[i] = by + (oy - iy) * ct - (ox - ix) * st;
    }
    turned = turn;
    lastX = ix;
    lastY = iy;
  }
}

/** Reads `of` the hat's walk at a share `peak` of the way up it. */
function alongTip(of: Float32Array, peak: number): number {
  const at = peak * TIP_STEPS;
  const i = Math.min(TIP_STEPS - 1, Math.floor(at));
  return of[i]! + (of[i + 1]! - of[i]!) * (at - i);
}

/** How much of the peak the dome is at `angle` from the crown: 1 at its tip, nothing at its foot and below. */
function peakOf(angle: number): number {
  return angle >= PEAK.span ? 0 : 1 - angle / PEAK.span;
}

const SKIRT = {
  /** How long the skirt is at the front and at the back. */
  front: 0.22,
  back: 0.68,
  /** How far out of plumb the hem hangs at ease over the face, where it stands a little clear as a brim does; how far
   *  inside plumb it hangs at the sides and behind, where the cloth is long and limp and falls in against the body
   *  (held out there it is a bell, and a bell is a shell); and how much further out everywhere when the skirt is
   *  spread wide. */
  flare: 10 * DEG,
  drape: 7 * DEG,
  spread: 18 * DEG,
  /** The power the fall's bend follows down the skirt: at 1 it turns evenly from the dome's slope to the hem's, above
   *  it the skirt falls first and flares late. */
  bend: 1.3,
  /** How much the skirt is drawn in half way down, so that it falls almost straight before it flares. */
  waist: 0,
} as const;

/** How the cloth is held below the head, by how far from the head it has come: as firmly as the head itself to here,
 *  and not at all from here on. The petals over the face are short and stay over the face, but they are cloth and
 *  their tips stir; the fall behind is a cape and flows. */
const BRIM = { firm: 0.05, free: 0.6 } as const;

const FOLDS = {
  /** This many folds run round the skirt, evenly, and the same to its left as to its right. Each is a petal of the
   *  brim: one hangs at the middle of the front, between the eyes, and the hem is drawn up to either side of it,
   *  over each eye, so the face looks out from under the cloth. */
  count: 8,
  start: 0,
  /** How deep a fold is at the hem, as a share of the skirt's radius there, and how fast it deepens down the skirt. */
  depth: 0.045,
  swell: 2,
  /** A fold that stands out hangs lower and flares more: over the face, where the hem is what the viewer sees. Round
   *  at the sides it does neither: a petal seen edge on is a spike. */
  scallop: 0.45,
  flare: 6 * DEG,
} as const;

const TAIL = {
  /** The tail leaves the body at the middle of its back. How wide round the body the cloth is that is longer for it,
   *  and how much wider than that the cloth is that is gathered in towards it: gathered from further round than it is
   *  long, the hem runs level from the body's sides, then turns down into the tail in one curve with no corner. */
  width: 27 * DEG,
  gather: 95 * DEG,
  /** How much longer than the skirt it is, how far out of plumb it trails behind, and how its tip curls up. */
  more: 0.11,
  out: 16 * DEG,
  curl: 26 * DEG,
  /** It falls before it trails: the power its bend follows, against the skirt's. */
  bend: 1.7,
  /** How far its sides are drawn in to a point. */
  taper: 0.72,
  /** Waves along it, in turns from root to tip, and how far a wave of one radian carries its tip to the side. */
  waves: 0.5,
  sway: 0.4,
  /** The columns that are this much tail or more are wholly tail: they share its line and move as one. And it moves
   *  only below this share of its length, where the skirt to either side of it has ended and it hangs free. */
  core: 0.4,
  root: 0.5,
  /** The power its swing follows down its length: above 1 its tip goes further than its root in proportion, so it
   *  curves as it swings and does not hang straight like a rod. */
  whip: 1.5,
} as const;

/** How long the tail is down its middle, from the dome's rim to its tip. */
const TAIL_LENGTH = SKIRT.back + TAIL.more;

const HAND = {
  /** Where round the body the hand is, and how wide the cloth it lifts: at its side, so a raised hand is seen
   *  against the air, not against its own front. */
  at: 86 * DEG,
  width: 22 * DEG,
  /** How much longer the skirt is over it, so the cloth still reaches down when it is raised. */
  more: 0.03,
  /** The stretch of the skirt's fall that lies along the arm, from the shoulder to the hand; past the hand the cloth
   *  hangs from it. */
  shoulder: 0.42,
  reach: 0.8,
  /** How far out of plumb the arm points when it is right up, and how the cloth hangs from it. */
  up: 126 * DEG,
  hang: 4 * DEG,
} as const;

/** The body's pose: everything about its shape that changes while it lives. */
export interface SheetPose {
  /** How far the skirt is spread: 0 at ease, 1 wide open, below 0 drawn in. */
  open: number;
  /** How far the hand is raised: 0 down at its side, 1 right up. */
  wave: number;
  /** The tail: a wave running along it from side to side, as its two quarters, and a swing round the body to one
   *  side, all in radians. Both are across the view, where a tail behind the body can be seen to move. */
  wagA: number;
  wagB: number;
  swish: number;
  /** Taller and narrower above 0, squatter below: the body keeps its volume. */
  stretch: number;
  /** How far the hat's tail has swung about the fold, radians at its end: above 0 further over and down on the side
   *  it falls to, below 0 back up. */
  tip: number;
  /** How far the end of the hat's tail is curled beyond that, radians at its end, the same way round. */
  curl: number;
  /** How far the hat has sunk on the head, as a share of its height: above 0 lower and fuller, below 0 lifted off it,
   *  taller and slimmer. */
  sag: number;
}

export const POSE_AT_EASE: SheetPose = { open: 0, wave: 0, wagA: 0, wagB: 0, swish: 0, stretch: 0, tip: 0, curl: 0, sag: 0 };

/** What is kept for each column: the sine and cosine of where it is round the body, how much of the tail and of the
 *  hand it is, how far it stands out as a fold (1) or in (-1), its length, and how far it is gathered in to the tail. */
const COLUMN = 7;

export interface Sheet {
  /** Vertices: the crown, then each column from the top down. */
  count: number;
  /** How coarse the grid is, as the vertex spacing of an equally fine flat sheet: the cloth's feel is scaled by it. */
  spacing: number;
  cols: number;
  domeRows: number;
  skirtRows: number;
  column: Float32Array;
  /** Per vertex: where round the body it is, radians from the front; how far down the skirt, 0 on the dome to 1 at
   *  the hem; and how much it is tail and hand, which grow down the skirt from nothing. */
  around: Float32Array;
  skirt: Float32Array;
  tail: Float32Array;
  hand: Float32Array;
  /** Per vertex: how much of the peak over the crown it is, 1 at the tip and nothing below the peak's foot. */
  peak: Float32Array;
  /** The body at ease, about the middle of the head, [x, y, z] triples. */
  rest: Float32Array;
  /** Triangles, counter-clockwise seen from outside. */
  triangles: Uint16Array;
  /** Pairs the cloth keeps at their distance. */
  edges: Uint16Array;
  /** Pairs two rows apart down each column of the skirt. Kept near their distance, they let the cloth wave along its
   *  fall and stop it crumpling there. */
  spans: Uint16Array;
  /** Each vertex's neighbours: those of vertex v are `ring[ringStart[v] .. ringStart[v + 1]]`. */
  ringStart: Uint16Array;
  ring: Uint16Array;
  /** 1 on the dome, falling to 0 at the hem: how firmly the cloth is held to the body's shape. */
  hold: Float32Array;
  /** 1 on the hem, 0 elsewhere. */
  rim: Float32Array;
  /** One over each vertex's share of the cloth, mean 1. */
  invMass: Float32Array;
}

function smoothstep(low: number, high: number, v: number): number {
  const t = v <= low ? 0 : v >= high ? 1 : (v - low) / (high - low);
  return t * t * (3 - 2 * t);
}

/** 1 at `at`, falling smoothly to nothing at `width` to either side and nothing beyond, round the body. */
function bump(u: number, at: number, width: number): number {
  let d = u - at;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const t = 1 - (d * d) / (width * width);
  return t <= 0 ? 0 : t * t * t;
}

/** 1 at `at`, falling away to either side over about `width`, round the body. */
function bell(u: number, at: number, width: number): number {
  let d = u - at;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.exp(-(d * d) / (width * width));
}

/** Lays the body out in `pose`, about the middle of its head, and writes it to `out` as [x, y, z] triples. */
export function poseSheet(sheet: Sheet, pose: SheetPose, out: Float32Array): void {
  const { cols, domeRows, skirtRows, column } = sheet;
  const R = HEAD.radius;
  const tall = 1 + pose.stretch;
  const wide = 1 / Math.sqrt(tall);
  const foot = R * Math.cos(PEAK.span);
  bendHat(pose);
  // The crown of the cloth is the very end of the hat's tail.
  out[0] = ((BENT.outX[TIP_STEPS]! + BENT.inX[TIP_STEPS]!) / 2) * wide;
  out[1] = (foot + (BENT.outY[TIP_STEPS]! + BENT.inY[TIP_STEPS]!) / 2) * tall;
  out[2] = PEAK.forward * wide;
  const startOut = R * Math.sin(DOME_END);
  const startDown = R * Math.cos(DOME_END);
  // The skirt leaves the dome along the dome's own slope, a little inwards.
  const leave = Math.PI / 2 - DOME_END;
  // Spread wide, the folds are pulled out of the skirt: that is where the extra cloth round the hem comes from.
  const depth = FOLDS.depth * Math.max(0.25, 1 - 0.55 * pose.open);
  const waves = TAIL.waves * 2 * Math.PI;
  let i = 3;
  for (let c = 0, k = 0; c < cols; c += 1, k += COLUMN) {
    const su = column[k]!;
    const cu = column[k + 1]!;
    const tail = column[k + 2]!;
    const hand = column[k + 3]!;
    for (let r = 1; r <= domeRows; r += 1) {
      const angle = domeAngle(r, domeRows);
      const peak = peakOf(angle);
      if (peak > 0) {
        // The hat: a ring of cloth between its two outlines, as deep from front to back as the hat is there.
        const ox = alongTip(BENT.outX, peak);
        const oy = alongTip(BENT.outY, peak);
        const ix = alongTip(BENT.inX, peak);
        const iy = alongTip(BENT.inY, peak);
        const ring = alongTip(TIP_PATH.deep, peak) * (1 + PEAK.swell * pose.sag * Math.sin(Math.PI * peak));
        out[i] = ((ox + ix) / 2 + ((ix - ox) / 2) * su) * wide;
        out[i + 1] = (foot + (oy + iy) / 2 + ((iy - oy) / 2) * su) * tall;
        out[i + 2] = (ring * cu + PEAK.forward * peak * peak) * wide;
      } else {
        const ring = R * Math.sin(angle) * wide;
        out[i] = ring * su;
        out[i + 1] = R * Math.cos(angle) * tall;
        out[i + 2] = ring * cu;
      }
      i += 3;
    }
    const fold = column[k + 4]!;
    const length = column[k + 5]!;
    const gather = column[k + 6]!;
    const facing = (1 + cu) / 2;
    const hem = (SKIRT.flare + FOLDS.flare * fold) * facing - SKIRT.drape * (1 - facing) + SKIRT.spread * pose.open;
    const raised = pose.wave * HAND.up;
    const step = length / skirtRows;
    let ring = startOut;
    let y = startDown;
    for (let j = 1; j <= skirtRows; j += 1) {
      const s = j / skirtRows;
      const mid = (j - 0.5) / skirtRows;
      let slope = leave + (hem - leave) * Math.pow(mid, SKIRT.bend) - SKIRT.waist * Math.sin(Math.PI * mid);
      if (tail > 0.004) {
        // The tail has its own line: it falls, trails back a little, and its tip curls up. Every column that is tail
        // follows that one line by how far down it is, not by its own share of its length, so across its width the
        // tail lies flat, as a ribbon does, with its lining to the viewer.
        const far = (mid * length) / TAIL_LENGTH;
        const trail = leave + (TAIL.out - leave) * Math.pow(far, TAIL.bend);
        slope += smoothstep(0, TAIL.core, tail) * (trail - slope + TAIL.curl * far * far * far);
      }
      if (hand > 0.004) {
        // Over the arm the cloth goes where the arm points; past the hand it hangs straight down from it.
        const past = smoothstep(HAND.reach - 0.14, HAND.reach + 0.14, mid);
        const arm = smoothstep(HAND.shoulder - 0.12, HAND.shoulder + 0.12, mid) * (1 - past);
        const point = hand * Math.sqrt(hand);
        slope += point * arm * (Math.max(slope, raised) - slope) + hand * past * Math.min(1, pose.wave * 1.4) * (HAND.hang - slope);
      }
      ring += step * Math.sin(slope);
      y -= step * Math.cos(slope);
      const round = ring * (1 + depth * fold * Math.pow(s, FOLDS.swell));
      let px = round * su;
      let pz = round * cu;
      if (gather > 0) {
        // The back of the skirt is drawn in towards the tail's middle line, more the lower down it is, so the tail
        // ends in a point.
        const narrow = TAIL.taper * gather * smoothstep(0.1, 1, s);
        const drawn = px * (1 - narrow);
        // Drawn in, it also lies flat across the view, as a ribbon does: its lining faces the viewer all the way down.
        const behind = pz - (round + pz) * narrow;
        // It swings round the body, further the lower down it is, and a wave runs along it from side to side. Every
        // column of it goes the same way by the same amount at the same height, however long the column is: moved
        // by its own share instead, the ribbon folds over on itself and shows its outside.
        const down = (s * length) / TAIL_LENGTH;
        // And it goes further the further below its root it is, as a thing hung from there swings. Swung far enough
        // to pass the hem beside it, the cloth between the two does fold, and a sliver of its outside shows.
        const low = smoothstep(0, TAIL.core, tail) * Math.pow(Math.max(0, (down - TAIL.root) / (1 - TAIL.root)), TAIL.whip);
        const swing = pose.swish * low;
        const cs = Math.cos(swing);
        const sn = Math.sin(swing);
        px = drawn * cs - behind * sn + TAIL.sway * low * (pose.wagA * Math.sin(waves * down) + pose.wagB * Math.cos(waves * down));
        pz = behind * cs + drawn * sn;
      }
      out[i] = px * wide;
      out[i + 1] = y * tall;
      out[i + 2] = pz * wide;
      i += 3;
    }
  }
}

/** How much closer together the columns are at the middle of the back than they are round the front. */
const CROWD = 0.3;

/** Where round the body column `c` of `cols` is, radians from the front. Round the front half they are evenly spaced.
 *  Round the back half they crowd towards the middle, where the tail is: seen from the front the tail's outline is
 *  drawn by where its columns end, so it takes many of them to be a curve, and the cloth to either side of it, which
 *  the body hides, can spare them. The spacing changes smoothly and is the same at the sides as round the front. */
function aroundOf(c: number, cols: number): number {
  const turn = (2 * Math.PI * c) / cols;
  const back = turn - Math.PI;
  if (Math.abs(back) >= Math.PI / 2) return turn;
  return Math.PI + back - CROWD * (Math.sin(2 * back) / 2 + Math.sin(4 * back) / 4);
}

/** Columns round the body, rows on the dome and rows down the skirt, for each fineness. Round the front the columns
 *  fall evenly on the folds, six, five and three to a fold, so every fold is drawn the same and the hem is the same
 *  to the left as to the right. */
const GRID: Record<number, readonly [number, number, number]> = {
  24: [48, 16, 11],
  32: [40, 12, 8],
  48: [24, 8, 6],
};

/** Cuts the cloth with vertices about as far apart as a flat sheet's at `spacing`. */
export function buildSheet(fineness: number): Sheet {
  const spacing = GRID[fineness] ? fineness : 24;
  const [cols, domeRows, skirtRows] = GRID[spacing]!;
  const rows = domeRows + skirtRows;
  const count = 1 + cols * rows;
  const at = (c: number, r: number) => 1 + (((c % cols) + cols) % cols) * rows + (r - 1);

  const column = new Float32Array(cols * COLUMN);
  const around = new Float32Array(count);
  const skirt = new Float32Array(count);
  const tailOf = new Float32Array(count);
  const handOf = new Float32Array(count);
  const peakOfVertex = new Float32Array(count);
  peakOfVertex[0] = 1;
  const hold = new Float32Array(count);
  const rim = new Float32Array(count);
  hold[0] = 1 - PEAK.loose;
  for (let c = 0, k = 0; c < cols; c += 1, k += COLUMN) {
    const u = aroundOf(c, cols);
    const tail = bell(u, Math.PI, TAIL.width);
    const hand = bell(u, HAND.at, HAND.width);
    column[k] = Math.sin(u);
    column[k + 1] = Math.cos(u);
    column[k + 2] = tail;
    column[k + 3] = hand;
    const gather = bump(u, Math.PI, TAIL.gather);
    column[k + 6] = gather;
    // The tail and the hand are not part of the folds: they have their own line.
    const fold = Math.cos(FOLDS.count * u + FOLDS.start) * (1 - gather) * (1 - hand);
    column[k + 4] = fold;
    // Short at the front and long at the back, where the tail is longer still.
    const fall = SKIRT.front + (SKIRT.back - SKIRT.front) * Math.pow((1 - Math.cos(u)) / 2, 1.2);
    // A fold that stands out hangs lower, at the front, where the hem is what the viewer sees.
    const scallop = 1 + FOLDS.scallop * fold * Math.pow((1 + Math.cos(u)) * 0.5, 1.5);
    column[k + 5] = (fall + (SKIRT.back - fall) * Math.min(1, 1.6 * tail)) * scallop + TAIL.more * tail + HAND.more * hand;
    for (let r = 1; r <= rows; r += 1) {
      const v = at(c, r);
      const s = r > domeRows ? (r - domeRows) / skirtRows : 0;
      around[v] = u;
      skirt[v] = s;
      tailOf[v] = tail * s;
      handOf[v] = hand * s;
      // A firm head under a looser peak, and a skirt that is held by how far from the head it has come, not by how far
      // down its own length: the short brim over the face keeps its shape as a cap's does, the long fall behind is
      // left to flow, and the tail is freer still.
      const peak = r <= domeRows ? peakOf(domeAngle(r, domeRows)) : 0;
      peakOfVertex[v] = peak;
      hold[v] = (1 - smoothstep(BRIM.firm, BRIM.free, s * column[k + 5]!)) * (1 - 0.4 * tail * s) * (1 - PEAK.loose * peak * peak);
      rim[v] = r === rows ? 1 : 0;
    }
  }

  // The grid as triangles: a fan round the crown, then quads cut on alternate diagonals so no direction is favoured.
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

  const sheet: Sheet = {
    count,
    spacing,
    cols,
    domeRows,
    skirtRows,
    column,
    around,
    skirt,
    tail: tailOf,
    hand: handOf,
    peak: peakOfVertex,
    rest: new Float32Array(3 * count),
    triangles: Uint16Array.from(tris),
    edges: new Uint16Array(0),
    spans: new Uint16Array(0),
    ringStart: new Uint16Array(count + 1),
    ring: new Uint16Array(0),
    hold,
    rim,
    invMass: new Float32Array(count),
  };
  const rest = sheet.rest;
  poseSheet(sheet, POSE_AT_EASE, rest);

  // Who is joined to whom, and how much cloth each vertex stands for.
  const seen = new Set<number>();
  const area = new Float64Array(count);
  const edges: number[] = [];
  const linked: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i]!;
    const b = tris[i + 1]!;
    const c = tris[i + 2]!;
    const ux = rest[3 * b]! - rest[3 * a]!;
    const uy = rest[3 * b + 1]! - rest[3 * a + 1]!;
    const uz = rest[3 * b + 2]! - rest[3 * a + 2]!;
    const vx = rest[3 * c]! - rest[3 * a]!;
    const vy = rest[3 * c + 1]! - rest[3 * a + 1]!;
    const vz = rest[3 * c + 2]! - rest[3 * a + 2]!;
    const third = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 6;
    area[a] = area[a]! + third;
    area[b] = area[b]! + third;
    area[c] = area[c]! + third;
    for (let e = 0; e < 3; e += 1) {
      const p = tris[i + e]!;
      const q = tris[i + ((e + 1) % 3)]!;
      const key = p < q ? p * 65536 + q : q * 65536 + p;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(p, q);
      linked[p]!.push(q);
      linked[q]!.push(p);
    }
  }
  const rings: number[] = [];
  for (let v = 0; v < count; v += 1) {
    sheet.ringStart[v] = rings.length;
    for (const o of linked[v]!) rings.push(o);
  }
  sheet.ringStart[count] = rings.length;
  sheet.edges = Uint16Array.from(edges);
  sheet.ring = Uint16Array.from(rings);
  const spans: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    for (let r = domeRows; r + 2 <= rows; r += 1) spans.push(at(c, r), at(c, r + 2));
  }
  sheet.spans = Uint16Array.from(spans);

  let mean = 0;
  for (let v = 0; v < count; v += 1) mean += area[v]!;
  mean /= count;
  for (let v = 0; v < count; v += 1) sheet.invMass[v] = Math.min(2.5, mean / (area[v]! || mean));
  return sheet;
}

const sheets = new Map<number, Sheet>();

/** The cloth at a given fineness, cut once and shared: it is never written to. */
export function sheetFor(spacing: number): Sheet {
  let sheet = sheets.get(spacing);
  if (!sheet) {
    sheet = buildSheet(spacing);
    sheets.set(spacing, sheet);
  }
  return sheet;
}

/** Fineness for a mascot drawn `px` wide: fine where the cloth can be seen, coarse where it is a few pixels. */
export function spacingFor(px: number): number {
  return px >= 120 ? 24 : px >= 56 ? 32 : 48;
}
