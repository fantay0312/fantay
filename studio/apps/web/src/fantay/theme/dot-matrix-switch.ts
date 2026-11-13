/* SPDX-License-Identifier: AGPL-3.0-only */
/*
 * Optical & spring-physics renderer for Fantay's two-state (dark / light) luminous dot-matrix
 * appearance switch: recessed squircle track, 4-layer analytical rounded-rect orbiting laser arc,
 * frosted charcoal / warm alabaster thumb with inward subsurface scattering, ghost cavity glyphs,
 * and 113-particle choreographed Moon <-> Sun dot-matrix morph.
 */

export const SCENE_W = 1400;
export const SCENE_H = 900;

export const TRACK = {
  x: 108,
  y: 134,
  w: 1184,
  h: 612,
  r: 191,
} as const;

export const THUMB = {
  w: 544,
  h: 544,
  r: 157,
  y: 168,
  xDark: 143,
  xLight: 713,
} as const;

const ARC_OFFSET = 18.0;
const GRID_STEP = 19.0;
const CELL_SIZE = 15.0;

type RGB = readonly [number, number, number];
type CellSpec = readonly [gx: number, gy: number, alpha: number];

// Moon: 113 squares (76 bright crescent + star core @ 1.0, 37 checkerboard earthshine + star rays @ 0.25)
const MOON_CELLS: readonly CellSpec[] = [
  [3, -8, 0.25], [7, -8, 0.25],
  [6, -7, 0.25], [7, -7, 1.0], [8, -7, 0.25],
  [-2, -6, 1.0], [-1, -6, 1.0], [0, -6, 0.25], [2, -6, 0.25], [7, -6, 0.25],
  [-4, -5, 1.0], [-3, -5, 1.0], [-2, -5, 1.0], [-1, -5, 0.25], [1, -5, 0.25], [3, -5, 0.25],
  [-5, -4, 1.0], [-4, -4, 1.0], [-3, -4, 1.0], [-2, -4, 1.0], [0, -4, 0.25], [2, -4, 0.25], [4, -4, 0.25],
  [-5, -3, 1.0], [-4, -3, 1.0], [-3, -3, 1.0], [-1, -3, 0.25], [1, -3, 0.25], [3, -3, 0.25], [5, -3, 0.25], [8, -3, 0.25],
  [-6, -2, 1.0], [-5, -2, 1.0], [-4, -2, 1.0], [-3, -2, 1.0], [-2, -2, 0.25], [0, -2, 0.25], [2, -2, 0.25], [4, -2, 0.25], [6, -2, 0.25],
  [-6, -1, 1.0], [-5, -1, 1.0], [-4, -1, 1.0], [-3, -1, 1.0], [-2, -1, 1.0], [-1, -1, 0.25], [1, -1, 0.25], [3, -1, 0.25], [5, -1, 0.25],
  [-6, 0, 1.0], [-5, 0, 1.0], [-4, 0, 1.0], [-3, 0, 1.0], [-2, 0, 1.0], [0, 0, 0.25], [2, 0, 0.25], [4, 0, 0.25], [6, 0, 0.25],
  [-6, 1, 1.0], [-5, 1, 1.0], [-4, 1, 1.0], [-3, 1, 1.0], [-2, 1, 1.0], [-1, 1, 1.0], [1, 1, 0.25], [3, 1, 0.25], [5, 1, 0.25],
  [-6, 2, 1.0], [-5, 2, 1.0], [-4, 2, 1.0], [-3, 2, 1.0], [-2, 2, 1.0], [-1, 2, 1.0], [0, 2, 1.0], [2, 2, 0.25], [4, 2, 0.25], [6, 2, 0.25],
  [-5, 3, 1.0], [-4, 3, 1.0], [-3, 3, 1.0], [-2, 3, 1.0], [-1, 3, 1.0], [0, 3, 1.0], [1, 3, 1.0], [2, 3, 1.0], [3, 3, 1.0], [4, 3, 1.0], [5, 3, 1.0],
  [-5, 4, 1.0], [-4, 4, 1.0], [-3, 4, 1.0], [-2, 4, 1.0], [-1, 4, 1.0], [0, 4, 1.0], [1, 4, 1.0], [2, 4, 1.0], [3, 4, 1.0], [4, 4, 1.0], [5, 4, 1.0],
  [-4, 5, 1.0], [-3, 5, 1.0], [-2, 5, 1.0], [-1, 5, 1.0], [0, 5, 1.0], [1, 5, 1.0], [2, 5, 1.0], [3, 5, 1.0], [4, 5, 1.0],
  [-2, 6, 1.0], [-1, 6, 1.0], [0, 6, 1.0], [1, 6, 1.0], [2, 6, 1.0],
];

// Sun: 65 squares (45 core squares @ 0.88..0.94, 20 cardinal & diagonal ray squares @ 0.56..0.64)
const SUN_CELLS: readonly CellSpec[] = [
  [0, -8, 0.56], [0, -7, 0.60], [0, -6, 0.64],
  [-5, -5, 0.56], [5, -5, 0.58],
  [-4, -4, 0.62], [4, -4, 0.64],
  [-2, -3, 0.88], [-1, -3, 0.88], [0, -3, 0.88], [1, -3, 0.88], [2, -3, 0.88],
  [-3, -2, 0.88], [-2, -2, 0.90], [-1, -2, 0.90], [0, -2, 0.90], [1, -2, 0.90], [2, -2, 0.90], [3, -2, 0.88],
  [-3, -1, 0.88], [-2, -1, 0.90], [-1, -1, 0.92], [0, -1, 0.92], [1, -1, 0.92], [2, -1, 0.90], [3, -1, 0.88],
  [-8, 0, 0.56], [-7, 0, 0.60], [-6, 0, 0.64],
  [-3, 0, 0.88], [-2, 0, 0.90], [-1, 0, 0.92], [0, 0, 0.94], [1, 0, 0.92], [2, 0, 0.90], [3, 0, 0.88],
  [6, 0, 0.64], [7, 0, 0.60], [8, 0, 0.56],
  [-3, 1, 0.88], [-2, 1, 0.90], [-1, 1, 0.92], [0, 1, 0.92], [1, 1, 0.92], [2, 1, 0.90], [3, 1, 0.88],
  [-3, 2, 0.88], [-2, 2, 0.90], [-1, 2, 0.90], [0, 2, 0.90], [1, 2, 0.90], [2, 2, 0.90], [3, 2, 0.88],
  [-2, 3, 0.88], [-1, 3, 0.88], [0, 3, 0.88], [1, 3, 0.88], [2, 3, 0.88],
  [-4, 4, 0.62], [4, 4, 0.62],
  [-5, 5, 0.56], [5, 5, 0.56],
  [0, 6, 0.64], [0, 7, 0.60], [0, 8, 0.56],
];

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function lerpRGB(c0: RGB, c1: RGB, t: number): RGB {
  return [
    Math.round(lerp(c0[0], c1[0], t)),
    Math.round(lerp(c0[1], c1[1], t)),
    Math.round(lerp(c0[2], c1[2], t)),
  ];
}

function lerpRGB3(c0: RGB, cMid: RGB, c1: RGB, t: number, midPos = 0.44): RGB {
  if (t <= midPos) {
    return lerpRGB(c0, cMid, clamp(t / midPos, 0, 1));
  }
  return lerpRGB(cMid, c1, clamp((t - midPos) / (1 - midPos), 0, 1));
}

const rgbStr = (rgb: RGB, a = 1): string =>
  a >= 0.999
    ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
    : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a.toFixed(3)})`;

function hash01(seed: number): number {
  const s = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

interface Particle {
  readonly mx: number;
  readonly my: number;
  readonly mAlpha: number;
  readonly sx: number;
  readonly sy: number;
  readonly sAlpha: number;
  readonly isPrimary: boolean;
  readonly delay: number;
  readonly end: number;
  readonly swirlAmp: number;
  readonly radialBurst: number;
  readonly phase: number;
  readonly minScale: number;
  readonly moonTint: RGB;
}

const PARTICLES: readonly Particle[] = (() => {
  const moonIndexed = MOON_CELLS.map((c, idx) => ({
    gx: c[0],
    gy: c[1],
    alpha: c[2],
    angle: Math.atan2(c[1], c[0]),
    dist: Math.hypot(c[0], c[1]),
    idx,
  })).sort((a, b) => {
    if (b.alpha !== a.alpha) return b.alpha - a.alpha;
    return a.angle - b.angle || b.dist - a.dist;
  });

  const sunIndexed = SUN_CELLS.map((c, idx) => ({
    gx: c[0],
    gy: c[1],
    alpha: c[2],
    angle: Math.atan2(c[1], c[0]),
    dist: Math.hypot(c[0], c[1]),
    idx,
  })).sort((a, b) => a.angle - b.angle || b.dist - a.dist);

  const sunCoreCells = SUN_CELLS.filter((c) => Math.abs(c[0]) <= 3 && Math.abs(c[1]) <= 3);

  return moonIndexed.map((m, i) => {
    const isPrimary = i < sunIndexed.length;
    const fallbackCore = sunCoreCells[i % sunCoreCells.length] ?? [0, 0, 0.88];
    const s = isPrimary
      ? sunIndexed[(i + 11) % sunIndexed.length]!
      : { gx: fallbackCore[0], gy: fallbackCore[1], alpha: 0.0 };

    const r1 = hash01(i * 3.17 + 1.1);
    const r2 = hash01(i * 7.31 + 2.3);
    const r3 = hash01(i * 13.7 + 5.9);

    const radialFactor = clamp(m.dist / 9.5, 0, 1);
    const delay = clamp(0.02 + (1 - radialFactor) * 0.16 + r1 * 0.24, 0, 0.38);
    const duration = clamp(0.54 + r2 * 0.22, 0.50, 0.78);
    const end = clamp(delay + duration, 0.62, 0.995);

    const swirlSign = r3 > 0.28 ? 1 : -1;
    const swirlAmp = (1.15 + r2 * 2.35) * swirlSign;
    const radialBurst = (r1 - 0.42) * 2.1;

    const moonTint: RGB =
      r2 < 0.3 ? [255, 246, 243] : r2 < 0.6 ? [246, 249, 255] : [255, 254, 250];

    return {
      mx: m.gx,
      my: m.gy,
      mAlpha: m.alpha,
      sx: s.gx,
      sy: s.gy,
      sAlpha: s.alpha,
      isPrimary,
      delay,
      end,
      swirlAmp,
      radialBurst,
      phase: r3 * Math.PI * 2,
      minScale: isPrimary ? 0.64 + r1 * 0.24 : 0.35 + r1 * 0.25,
      moonTint,
    };
  });
})();

interface PerimeterTable {
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly numSamples: number;
}

function buildRoundedSquareTable(halfSide: number, radius: number, numSamples = 720): PerimeterTable {
  const inner = halfSide - radius;
  const xs = new Float32Array(numSamples);
  const ys = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const theta = (i / numSamples) * Math.PI * 2;
    const dx = Math.cos(theta);
    const dy = Math.sin(theta);
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);

    const tFlatX = ax > 1e-6 ? halfSide / ax : 1e9;
    const tFlatY = ay > 1e-6 ? halfSide / ay : 1e9;

    let px = 0;
    let py = 0;
    if (tFlatX < tFlatY && Math.abs(dy * tFlatX) <= inner) {
      px = Math.sign(dx) * halfSide;
      py = dy * tFlatX;
    } else if (tFlatY <= tFlatX && Math.abs(dx * tFlatY) <= inner) {
      px = dx * tFlatY;
      py = Math.sign(dy) * halfSide;
    } else {
      const cx = Math.sign(dx) * inner;
      const cy = Math.sign(dy) * inner;
      const b = -(dx * cx + dy * cy);
      const c = cx * cx + cy * cy - radius * radius;
      const disc = Math.max(0, b * b - c);
      const t = -b + Math.sqrt(disc);
      px = dx * t;
      py = dy * t;
    }

    xs[i] = px;
    ys[i] = py;
  }

  return { xs, ys, numSamples };
}

const OUTER_ARC_TABLE = buildRoundedSquareTable(THUMB.w * 0.5 + ARC_OFFSET, THUMB.r + ARC_OFFSET, 720);
const THUMB_RIM_TABLE = buildRoundedSquareTable(THUMB.w * 0.5, THUMB.r, 720);

function sampleTable(table: PerimeterTable, theta: number): { x: number; y: number } {
  const twoPi = Math.PI * 2;
  const norm = (((theta % twoPi) + twoPi) % twoPi) / twoPi;
  const fIdx = norm * table.numSamples;
  const i0 = Math.floor(fIdx) % table.numSamples;
  const i1 = (i0 + 1) % table.numSamples;
  const frac = fIdx - Math.floor(fIdx);
  return {
    x: lerp(table.xs[i0] ?? 0, table.xs[i1] ?? 0, frac),
    y: lerp(table.ys[i0] ?? 0, table.ys[i1] ?? 0, frac),
  };
}

function appendRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr);
    return;
  }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  appendRoundRect(ctx, x, y, w, h, r);
}

function strokeRadialLitRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  lightX: number,
  lightY: number,
  reachRadius: number,
  lineWidth: number,
  colorCoreRGB: RGB,
  colorMidRGB: RGB,
  peakAlpha: number,
): void {
  if (peakAlpha <= 0.002) return;
  const grad = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, reachRadius);
  grad.addColorStop(0.0, rgbStr(colorCoreRGB, peakAlpha));
  grad.addColorStop(0.45, rgbStr(colorCoreRGB, peakAlpha * 0.92));
  grad.addColorStop(0.74, rgbStr(colorMidRGB, peakAlpha * 0.58));
  grad.addColorStop(0.90, rgbStr(colorMidRGB, peakAlpha * 0.18));
  grad.addColorStop(1.0, rgbStr(colorMidRGB, 0));

  roundedRectPath(ctx, x, y, w, h, r);
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = grad;
  ctx.stroke();
}

function drawGhostCells(
  ctx: CanvasRenderingContext2D,
  cells: readonly CellSpec[],
  centerX: number,
  centerY: number,
  colorRGB: RGB,
  opacity: number,
): void {
  if (opacity <= 0.008) return;
  const ghostCell = CELL_SIZE * 0.92;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const a = cell[2] * opacity;
    if (a <= 0.008) continue;
    const cx = centerX + cell[0] * GRID_STEP;
    const cy = centerY + 2 + cell[1] * GRID_STEP;
    ctx.fillStyle = rgbStr(colorRGB, a);
    ctx.fillRect(cx - ghostCell * 0.5, cy - ghostCell * 0.5, ghostCell, ghostCell);
  }
}

export interface DotMatrixSwitchPhysics {
  committed: 0 | 1;
  targetP: number;
  p: number;
  vp: number;
  morphP: number;
  vMorphP: number;
  basePoleAngle: number;
  arcAngle: number;
  vArcAngle: number;
  pressAmount: number;
  vPress: number;
  isDragging: boolean;
  pointerX: number;
  pointerY: number;
  pointerInside: boolean;
}

export function createSwitchPhysics(initialLight: boolean): DotMatrixSwitchPhysics {
  const initial: 0 | 1 = initialLight ? 1 : 0;
  const basePole = initial ? -Math.PI * 0.5 : Math.PI * 0.5;
  const restOffset = initial ? -0.10 * Math.PI : 0;
  return {
    committed: initial,
    targetP: initial,
    p: initial,
    vp: 0,
    morphP: initial,
    vMorphP: 0,
    basePoleAngle: basePole,
    arcAngle: basePole + restOffset,
    vArcAngle: 0,
    pressAmount: 0,
    vPress: 0,
    isDragging: false,
    pointerX: initial ? THUMB.xLight + THUMB.w * 0.5 : THUMB.xDark + THUMB.w * 0.5,
    pointerY: THUMB.y + THUMB.h * 0.5,
    pointerInside: false,
  };
}

function computeTargetArcAngle(state: DotMatrixSwitchPhysics): number {
  const restOffset = state.committed === 1 ? -0.10 * Math.PI : 0;
  const dragOffsetAngle =
    state.committed === 0
      ? -clamp(state.p, 0, 1) * Math.PI
      : -clamp(1 - state.p, 0, 1) * Math.PI;

  let targetArcAngle = state.basePoleAngle + restOffset + dragOffsetAngle;

  if (state.pointerInside && !state.isDragging) {
    const thumbCx = lerp(THUMB.xDark, THUMB.xLight, state.p) + THUMB.w * 0.5;
    const thumbCy = THUMB.y + THUMB.h * 0.5;
    const dx = state.pointerX - thumbCx;
    const dy = state.pointerY - thumbCy;
    const dist = Math.hypot(dx, dy);
    if (dist > 20 && dist < 560) {
      const ptrAngle = Math.atan2(dy, dx);
      const diff = Math.atan2(Math.sin(ptrAngle - targetArcAngle), Math.cos(ptrAngle - targetArcAngle));
      targetArcAngle += diff * 0.085;
    }
  }

  return targetArcAngle;
}

export function syncCommittedPhysics(
  state: DotMatrixSwitchPhysics,
  nextLight: boolean,
  reducedMotion: boolean,
): void {
  const next: 0 | 1 = nextLight ? 1 : 0;
  if (next !== state.committed) {
    state.basePoleAngle -= Math.PI;
    state.committed = next;
  }
  state.targetP = next;
  if (reducedMotion) {
    state.p = next;
    state.vp = 0;
    state.morphP = next;
    state.vMorphP = 0;
    state.pressAmount = 0;
    state.vPress = 0;
    state.arcAngle = computeTargetArcAngle(state);
    state.vArcAngle = 0;
  }
}

/** Advances springs by `dt` seconds; returns `true` when still in motion, `false` when settled. */
export function stepSwitchPhysics(
  state: DotMatrixSwitchPhysics,
  dt: number,
  reducedMotion: boolean,
): boolean {
  if (reducedMotion && !state.isDragging) {
    state.p = state.targetP;
    state.vp = 0;
    state.morphP = state.targetP;
    state.vMorphP = 0;
    state.pressAmount = 0;
    state.vPress = 0;
    state.arcAngle = computeTargetArcAngle(state);
    state.vArcAngle = 0;
    return false;
  }

  const scaledDt = Math.min(Math.max(dt, 0), 0.05);

  const pStiff = state.isDragging ? 380 : 215;
  const pDamp = state.isDragging ? 34 : 24;
  const ap = (state.targetP - state.p) * pStiff - state.vp * pDamp;
  state.vp += ap * scaledDt;
  state.p += state.vp * scaledDt;

  const mStiff = state.isDragging ? 320 : 165;
  const mDamp = state.isDragging ? 30 : 21;
  const am = (state.targetP - state.morphP) * mStiff - state.vMorphP * mDamp;
  state.vMorphP += am * scaledDt;
  state.morphP += state.vMorphP * scaledDt;

  const targetPress = state.isDragging ? 1.0 : clamp(Math.abs(state.vp) * 0.22, 0, 1);
  const aPress = (targetPress - state.pressAmount) * 180 - state.vPress * 22;
  state.vPress += aPress * scaledDt;
  state.pressAmount = clamp(state.pressAmount + state.vPress * scaledDt, 0, 1.2);

  const targetArcAngle = computeTargetArcAngle(state);
  const arcStiff = state.isDragging ? 160 : 92;
  const arcDamp = state.isDragging ? 22 : 16.5;
  const aArc = (targetArcAngle - state.arcAngle) * arcStiff - state.vArcAngle * arcDamp;
  state.vArcAngle += aArc * scaledDt;
  state.arcAngle += state.vArcAngle * scaledDt;

  if (state.isDragging) return true;

  const settled =
    Math.abs(state.targetP - state.p) < 0.0008 &&
    Math.abs(state.vp) < 0.002 &&
    Math.abs(state.targetP - state.morphP) < 0.0008 &&
    Math.abs(state.vMorphP) < 0.002 &&
    Math.abs(targetArcAngle - state.arcAngle) < 0.0015 &&
    Math.abs(state.vArcAngle) < 0.003 &&
    state.pressAmount < 0.002;

  if (settled) {
    state.p = state.targetP;
    state.vp = 0;
    state.morphP = state.targetP;
    state.vMorphP = 0;
    state.arcAngle = targetArcAngle;
    state.vArcAngle = 0;
    state.pressAmount = 0;
    state.vPress = 0;
  }

  return !settled;
}

export function renderDotMatrixSwitch(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
  state: DotMatrixSwitchPhysics,
): void {
  if (canvasWidth <= 0 || canvasHeight <= 0) return;

  const p = clamp(state.p, 0, 1);
  const morphP = clamp(state.morphP, 0, 1);
  const sceneScale = canvasWidth / (SCENE_W * dpr);

  const thumbX = lerp(THUMB.xDark, THUMB.xLight, p);
  const thumbY = THUMB.y;
  const thumbCx = thumbX + THUMB.w * 0.5;
  const thumbCy = thumbY + THUMB.h * 0.5;

  const arcCenterPt = sampleTable(OUTER_ARC_TABLE, state.arcAngle);
  const lightWorldX = thumbCx + arcCenterPt.x;
  const lightWorldY = thumbCy + arcCenterPt.y;

  const glowOuterRGB = lerpRGB3([82, 102, 255], [238, 195, 255], [255, 168, 32], p, 0.44);
  const glowMidRGB = lerpRGB3([138, 158, 255], [255, 226, 250], [255, 208, 64], p, 0.44);
  const glowCoreRGB = lerpRGB3([252, 254, 255], [255, 252, 255], [255, 253, 228], p, 0.45);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.scale(sceneScale * dpr, sceneScale * dpr);

  // 1. Track drop shadow & recessed pill cavity
  ctx.save();
  ctx.shadowColor = rgbStr([0, 0, 0], lerp(0.45, 0.12, p));
  ctx.shadowBlur = lerp(34, 24, p) * sceneScale * dpr;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = lerp(14, 10, p) * sceneScale * dpr;

  const trackBaseRGB = lerpRGB3([11, 13, 18], [112, 112, 116], [231, 228, 223], p, 0.45);
  roundedRectPath(ctx, TRACK.x, TRACK.y, TRACK.w, TRACK.h, TRACK.r);
  ctx.fillStyle = rgbStr(trackBaseRGB);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRectPath(ctx, TRACK.x, TRACK.y, TRACK.w, TRACK.h, TRACK.r);
  ctx.clip();

  const trackVertGrad = ctx.createLinearGradient(0, TRACK.y, 0, TRACK.y + TRACK.h);
  const trackTopRGB = lerpRGB3([6, 8, 12], [96, 97, 102], [216, 213, 208], p, 0.45);
  const trackBotRGB = lerpRGB3([15, 18, 25], [122, 123, 128], [239, 237, 233], p, 0.45);
  trackVertGrad.addColorStop(0, rgbStr(trackTopRGB));
  trackVertGrad.addColorStop(0.32, rgbStr(trackBaseRGB));
  trackVertGrad.addColorStop(1, rgbStr(trackBotRGB));
  ctx.fillStyle = trackVertGrad;
  ctx.fillRect(TRACK.x, TRACK.y, TRACK.w, TRACK.h);

  // Bounce light inside track cavity from the Orbiting Laser Arc
  const trackBounceGrad = ctx.createRadialGradient(lightWorldX, lightWorldY, 10, lightWorldX, lightWorldY, 480);
  trackBounceGrad.addColorStop(0, rgbStr(glowOuterRGB, lerp(0.55, 0.44, p)));
  trackBounceGrad.addColorStop(0.5, rgbStr(glowOuterRGB, lerp(0.18, 0.15, p)));
  trackBounceGrad.addColorStop(1, rgbStr(glowOuterRGB, 0));
  ctx.fillStyle = trackBounceGrad;
  ctx.fillRect(TRACK.x, TRACK.y, TRACK.w, TRACK.h);

  // Recessed inactive slot dot-matrix glyph so both Dark and Light buttons read clearly at rest
  const ghostDarkOpacity = smoothstep(0.56, 0.96, p) * 0.28;
  drawGhostCells(
    ctx,
    MOON_CELLS,
    THUMB.xDark + THUMB.w * 0.5,
    THUMB.y + THUMB.h * 0.5,
    [110, 105, 98],
    ghostDarkOpacity,
  );
  const ghostLightOpacity = (1 - smoothstep(0.04, 0.44, p)) * 0.30;
  drawGhostCells(
    ctx,
    SUN_CELLS,
    THUMB.xLight + THUMB.w * 0.5,
    THUMB.y + THUMB.h * 0.5,
    [172, 182, 218],
    ghostLightOpacity,
  );

  // Track inner top shadow (recessed lip via compound evenodd path)
  ctx.save();
  ctx.beginPath();
  appendRoundRect(ctx, TRACK.x - 60, TRACK.y - 60, TRACK.w + 120, TRACK.h + 120, TRACK.r + 60);
  appendRoundRect(ctx, TRACK.x, TRACK.y, TRACK.w, TRACK.h, TRACK.r);
  ctx.shadowColor = rgbStr([0, 0, 0], lerp(0.82, 0.20, p));
  ctx.shadowBlur = 22 * sceneScale * dpr;
  ctx.shadowOffsetY = 9 * sceneScale * dpr;
  ctx.fillStyle = 'rgb(0, 0, 0)';
  ctx.fill('evenodd');
  ctx.restore();

  ctx.restore(); // End Track clip

  // Track outer bevel & crisp hairline definition against both dark and pure-white popover surfaces
  ctx.save();
  roundedRectPath(ctx, TRACK.x, TRACK.y, TRACK.w, TRACK.h, TRACK.r);
  const trackRimGrad = ctx.createLinearGradient(0, TRACK.y, 0, TRACK.y + TRACK.h);
  const rimEdgeRGB: RGB = p > 0.5 ? [24, 24, 28] : [255, 255, 255];
  trackRimGrad.addColorStop(0, rgbStr(rimEdgeRGB, lerp(0.10, 0.13, p)));
  trackRimGrad.addColorStop(0.5, rgbStr(rimEdgeRGB, lerp(0.12, 0.09, p)));
  trackRimGrad.addColorStop(1, rgbStr([255, 255, 255], lerp(0.22, 0.85, p)));
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = trackRimGrad;
  ctx.stroke();
  ctx.restore();

  // 2. Thumb contact & cast shadow inside track
  ctx.save();
  ctx.shadowColor = rgbStr([0, 0, 0], lerp(0.80, 0.22, p));
  ctx.shadowBlur = lerp(34, 28, p) * sceneScale * dpr;
  ctx.shadowOffsetX = lerp(8, -12, p) * sceneScale * dpr;
  ctx.shadowOffsetY = lerp(12, 14, p) * sceneScale * dpr;
  roundedRectPath(ctx, thumbX, thumbY, THUMB.w, THUMB.h, THUMB.r);
  ctx.fillStyle = rgbStr([0, 0, 0], 0.5);
  ctx.fill();
  ctx.restore();

  // 3. Concentric outer laser arc (analytical roundRect + 4-layer volumetric bloom)
  const arcX = thumbX - ARC_OFFSET;
  const arcY = thumbY - ARC_OFFSET;
  const arcW = THUMB.w + ARC_OFFSET * 2;
  const arcH = THUMB.h + ARC_OFFSET * 2;
  const arcR = THUMB.r + ARC_OFFSET;
  const arcReach = 305;

  ctx.save();
  ctx.filter = `blur(${Math.max(0.6, 28 * sceneScale).toFixed(2)}px)`;
  strokeRadialLitRoundedRect(
    ctx, arcX, arcY, arcW, arcH, arcR,
    lightWorldX, lightWorldY, arcReach * 1.22, 38,
    glowOuterRGB, glowOuterRGB, 0.95,
  );
  ctx.restore();

  ctx.save();
  ctx.filter = `blur(${Math.max(0.4, 11 * sceneScale).toFixed(2)}px)`;
  strokeRadialLitRoundedRect(
    ctx, arcX, arcY, arcW, arcH, arcR,
    lightWorldX, lightWorldY, arcReach * 1.06, 15,
    glowOuterRGB, glowOuterRGB, 0.92,
  );
  ctx.restore();

  ctx.save();
  ctx.filter = `blur(${Math.max(0.2, 2.8 * sceneScale).toFixed(2)}px)`;
  strokeRadialLitRoundedRect(
    ctx, arcX, arcY, arcW, arcH, arcR,
    lightWorldX, lightWorldY, arcReach, 7.5,
    glowMidRGB, glowOuterRGB, 0.98,
  );
  ctx.restore();

  const laserCoreRGB = lerpRGB3([250, 253, 255], [255, 252, 255], [255, 246, 175], p, 0.45);
  ctx.save();
  strokeRadialLitRoundedRect(
    ctx, arcX, arcY, arcW, arcH, arcR,
    lightWorldX, lightWorldY, arcReach * 0.96, 5.2,
    laserCoreRGB, glowMidRGB, 1.0,
  );
  ctx.restore();

  // 4. Frosted smoked-charcoal / warm alabaster squircle thumb body & subsurface scattering
  ctx.save();
  roundedRectPath(ctx, thumbX, thumbY, THUMB.w, THUMB.h, THUMB.r);
  ctx.clip();

  const thumbTopRGB = lerpRGB3([39, 40, 44], [146, 146, 150], [249, 247, 244], p, 0.44);
  const thumbBotRGB = lerpRGB3([34, 36, 42], [134, 134, 140], [241, 239, 236], p, 0.44);
  const thumbBaseGrad = ctx.createLinearGradient(thumbX, thumbY, thumbX, thumbY + THUMB.h);
  thumbBaseGrad.addColorStop(0, rgbStr(thumbTopRGB));
  thumbBaseGrad.addColorStop(1, rgbStr(thumbBotRGB));
  ctx.fillStyle = thumbBaseGrad;
  ctx.fillRect(thumbX, thumbY, THUMB.w, THUMB.h);

  const sssOriginX = thumbCx + arcCenterPt.x * 0.95;
  const sssOriginY = thumbCy + arcCenterPt.y * 0.95;
  const sssOuterRGB = lerpRGB3([98, 118, 252], [232, 200, 250], [255, 192, 66], p, 0.44);
  const sssInnerRGB = lerpRGB3([215, 228, 255], [255, 244, 255], [255, 236, 160], p, 0.44);

  const sssGrad = ctx.createRadialGradient(sssOriginX, sssOriginY, 10, sssOriginX, sssOriginY, THUMB.w * 0.88);
  sssGrad.addColorStop(0, rgbStr(sssInnerRGB, lerp(0.96, 0.88, p)));
  sssGrad.addColorStop(0.24, rgbStr(sssOuterRGB, lerp(0.76, 0.66, p)));
  sssGrad.addColorStop(0.58, rgbStr(sssOuterRGB, lerp(0.28, 0.22, p)));
  sssGrad.addColorStop(1, rgbStr(sssOuterRGB, 0));
  ctx.fillStyle = sssGrad;
  ctx.fillRect(thumbX, thumbY, THUMB.w, THUMB.h);

  const wingAngleSpan = 0.22 * Math.PI;
  const leftWingPt = sampleTable(THUMB_RIM_TABLE, state.arcAngle - wingAngleSpan);
  const rightWingPt = sampleTable(THUMB_RIM_TABLE, state.arcAngle + wingAngleSpan);
  for (const wingPt of [leftWingPt, rightWingPt]) {
    const wg = ctx.createRadialGradient(
      thumbCx + wingPt.x,
      thumbCy + wingPt.y,
      4,
      thumbCx + wingPt.x,
      thumbCy + wingPt.y,
      THUMB.w * 0.52,
    );
    wg.addColorStop(0, rgbStr(sssInnerRGB, lerp(0.75, 0.54, p)));
    wg.addColorStop(0.45, rgbStr(sssOuterRGB, lerp(0.34, 0.22, p)));
    wg.addColorStop(1, rgbStr(sssOuterRGB, 0));
    ctx.fillStyle = wg;
    ctx.fillRect(thumbX, thumbY, THUMB.w, THUMB.h);
  }

  ctx.save();
  ctx.filter = `blur(${Math.max(0.4, 14 * sceneScale).toFixed(2)}px)`;
  strokeRadialLitRoundedRect(
    ctx, thumbX + 2, thumbY + 2, THUMB.w - 4, THUMB.h - 4, THUMB.r - 2,
    lightWorldX, lightWorldY, arcReach * 1.05, 24,
    glowCoreRGB, sssOuterRGB, lerp(0.95, 0.75, p),
  );
  ctx.restore();

  if (p < 0.85) {
    const darkPocketGrad = ctx.createRadialGradient(thumbCx, thumbCy - 18, 24, thumbCx, thumbCy, THUMB.w * 0.54);
    const pocketAlpha = (1 - smoothstep(0.15, 0.75, p)) * 0.44;
    darkPocketGrad.addColorStop(0, `rgba(28, 29, 34, ${pocketAlpha.toFixed(3)})`);
    darkPocketGrad.addColorStop(1, 'rgba(28, 29, 34, 0)');
    ctx.fillStyle = darkPocketGrad;
    ctx.fillRect(thumbX, thumbY, THUMB.w, THUMB.h);
  }

  // 5. 113-particle dot-matrix icon morph (Moon <-> Sun)
  const moonGlowStrength = 1 - smoothstep(0.0, 0.48, morphP);
  if (moonGlowStrength > 0.01) {
    ctx.save();
    ctx.filter = `blur(${Math.max(0.3, 7 * sceneScale).toFixed(2)}px)`;
    ctx.fillStyle = `rgba(255, 245, 235, ${(moonGlowStrength * 0.36).toFixed(3)})`;
    for (let i = 0; i < PARTICLES.length; i++) {
      const pt = PARTICLES[i]!;
      if (pt.mAlpha < 0.5) continue;
      const px = thumbCx + pt.mx * GRID_STEP;
      const py = thumbCy + 2 + pt.my * GRID_STEP;
      ctx.fillRect(px - CELL_SIZE * 0.5, py - CELL_SIZE * 0.5, CELL_SIZE, CELL_SIZE);
    }
    ctx.restore();
  }

  const sunColorRGB: RGB = [52, 48, 43];
  const pressJitter = state.pressAmount;

  for (let i = 0; i < PARTICLES.length; i++) {
    const pt = PARTICLES[i]!;

    const rawT = (morphP - pt.delay) / (pt.end - pt.delay);
    const localT = clamp(rawT, 0, 1);
    const u = localT * localT * (3 - 2 * localT);

    const midBell = 4 * u * (1 - u);
    const pressBell = pressJitter * (1 - midBell) * 0.32;
    const totalExcite = midBell + pressBell;

    const baseGx = lerp(pt.mx, pt.sx, u);
    const baseGy = lerp(pt.my, pt.sy, u);

    const distFromCenter = Math.hypot(baseGx, baseGy) + 0.35;
    const tangX = -baseGy / distFromCenter;
    const tangY = baseGx / distFromCenter;
    const radX = baseGx / distFromCenter;
    const radY = baseGy / distFromCenter;

    const swirlOffset = midBell * pt.swirlAmp + pressBell * Math.sin(pt.phase) * 0.85;
    const radialOffset = midBell * pt.radialBurst;

    const gx = baseGx + tangX * swirlOffset + radX * radialOffset;
    const gy = baseGy + tangY * swirlOffset + radY * radialOffset;

    const alpha = pt.isPrimary ? lerp(pt.mAlpha, pt.sAlpha, u) : pt.mAlpha * Math.pow(1 - u, 1.45);
    if (alpha <= 0.01) continue;

    const scale = lerp(1.0, pt.minScale, clamp(totalExcite, 0, 1));
    const size = CELL_SIZE * scale;

    const colorMix = smoothstep(0.35, 0.45, p);
    const tileRGB = lerpRGB(pt.moonTint, sunColorRGB, colorMix);

    const cx = thumbCx + gx * GRID_STEP;
    const cy = thumbCy + 2 + gy * GRID_STEP;

    ctx.fillStyle = rgbStr(tileRGB, alpha);
    ctx.fillRect(cx - size * 0.5, cy - size * 0.5, size, size);
  }

  ctx.restore(); // End Thumb clip

  // 6. Thumb concentric specular border rim
  ctx.save();
  roundedRectPath(ctx, thumbX + 1.5, thumbY + 1.5, THUMB.w - 3, THUMB.h - 3, THUMB.r - 1.5);
  const baseRimGrad = ctx.createLinearGradient(thumbX, thumbY, thumbX, thumbY + THUMB.h);
  baseRimGrad.addColorStop(0, rgbStr([255, 255, 255], lerp(0.38, 0.96, p)));
  baseRimGrad.addColorStop(0.5, rgbStr([255, 255, 255], lerp(0.22, 0.66, p)));
  baseRimGrad.addColorStop(1, rgbStr([255, 255, 255], lerp(0.46, 0.86, p)));
  ctx.lineWidth = 4.0;
  ctx.strokeStyle = baseRimGrad;
  ctx.stroke();
  ctx.restore();

  ctx.save();
  strokeRadialLitRoundedRect(
    ctx, thumbX + 2, thumbY + 2, THUMB.w - 4, THUMB.h - 4, THUMB.r - 2,
    lightWorldX, lightWorldY, arcReach * 1.02, 6.2,
    glowCoreRGB, glowMidRGB, lerp(0.98, 0.95, p),
  );
  ctx.restore();

  ctx.restore();
}
